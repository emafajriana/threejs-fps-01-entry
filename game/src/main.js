// main.js — Ember Quay's match brain. It owns the round state machine
// (buy -> live -> planted -> over), the economy, the Igniter objective,
// the Sunburst grenade, all shooting resolution, and the staging hooks the
// screenshots are taken with (?shot=start|play|end). The other modules are
// specialists: world builds the map, bots walk and fight, player moves the
// camera's body, hud draws the DOM, weapons tabulate the guns, audio
// synthesizes the noise.
//
// Simulation runs on a fixed step (1/60 s) kept apart from rendering:
// the frame loop accumulates real time and steps the sim in fixed slices,
// so a round plays the same on any machine. Hot paths reuse scratch
// vectors instead of allocating every frame.

import * as THREE from 'three';
import { buildWorld, SITES, SPAWNS, lineClear } from './world.js';
import { Player } from './player.js';
import { Bot } from './bots.js';
import { Input } from './input.js';
import { Hud, fmtClock } from './hud.js';
import { Sfx } from './audio.js';
import { WEAPONS, GRENADE, BUY_MENU, buildViewmodel, buildMuzzleFlash } from './weapons.js';
import { COLORS } from './palette.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // null in a real game
const STEP = 1 / 60;
const EMPTY_FRAME = { dx: 0, dy: 0, pressed: new Set() };

// scratch vectors reused by the hot paths — no allocation per frame
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

// ---------------------------------------------------------------- setup
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.sky);
scene.fog = new THREE.Fog(COLORS.fog, 55, 130);

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.08, 300);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const world = buildWorld(scene);
const input = new Input(renderer.domElement);
const hud = new Hud();
const sfx = new Sfx();
if (SHOT) input.disabled = true;

// ---------------------------------------------------------------- cast
const player = new Player(world.colliders);
const me = {
  isPlayer: true, team: 'cinder', name: 'You', pos: player.pos,
  hp: 100, armor: 0, alive: true, money: 800, kills: 0, deaths: 0,
  weaponId: 'v9', hasIgniter: false, grenades: 0,
};
const bots = [];
for (let i = 1; i < 5; i++) bots.push(new Bot('cinder', i, scene));
for (let i = 0; i < 5; i++) bots.push(new Bot('tidewatch', i, scene));
const all = [me, ...bots];
const foesOf = (c) => all.filter((o) => o.team !== c.team);

// player weapon state: owned guns with their own magazines
const myGuns = { v9: { mag: WEAPONS.v9.mag, reserve: WEAPONS.v9.reserve } };
let myPrimary = null; // weapon id in the primary slot, if bought

// ---------------------------------------------------------------- match state
const MATCH = {
  phase: 'title', // title | buy | live | over | matchover
  round: 0,
  score: { cinder: 0, tidewatch: 0 },
  phaseEndsAt: 0,
  roundEndsAt: 0,
  plantedAtSite: null,
  plantEndsAt: 0,
  winner: null,
  winReason: '',
  targetScore: 6,
};
let now = 0; // seconds, match clock

const igniter = {
  state: 'carried', // carried | dropped | planted
  carrier: me,
  site: null,
  pos: new THREE.Vector3(),
  mesh: null,
  channel: null, // {actor, kind, endsAt, total}
  lastBeepSec: -1,
};
{
  const g = new THREE.Group();
  const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.24),
    new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.5, metalness: 0.6 }));
  const lampM = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3b26, emissiveIntensity: 2.4 }));
  lampM.position.y = 0.14;
  g.add(bodyM, lampM);
  g.visible = false;
  igniter.mesh = g;
  scene.add(g);
}

// tracers and impact sparks: tiny pooled effects
const tracers = [];
function tracer(from, to, color = 0xffd98a) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, until: now + 0.06 });
}
const sparks = [];
const sparkGeo = new THREE.TetrahedronGeometry(0.035);
function burst(pos, n = 6, color = 0xffc46e) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(sparkGeo, new THREE.MeshBasicMaterial({ color }));
    m.position.copy(pos);
    m.userData.v = new THREE.Vector3((Math.random() - 0.5) * 2.4, Math.random() * 2.2, (Math.random() - 0.5) * 2.4);
    scene.add(m);
    sparks.push({ m, until: now + 0.32 });
  }
}

// dropped rifles (a fallen fighter's primary can be picked up)
const droppedGuns = [];
function dropGun(weaponId, pos) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.66),
    new THREE.MeshStandardMaterial({ color: 0x2c3034, roughness: 0.5, metalness: 0.5 }));
  m.position.set(pos.x, 0.12, pos.z);
  m.rotation.y = Math.random() * 3;
  scene.add(m);
  droppedGuns.push({ weaponId, pos: m.position, mesh: m });
}

// ---------------------------------------------------------------- viewmodel
let viewmodel = null, muzzle = null, recoil = 0, adsAmt = 0;
function setViewmodel() {
  if (viewmodel) { camera.remove(viewmodel); }
  viewmodel = buildViewmodel(me.weaponId, COLORS.cinder);
  muzzle = buildMuzzleFlash();
  muzzle.position.set(0, 0.03, me.weaponId === 'albatross' ? -1.0 : -0.62);
  viewmodel.add(muzzle);
  camera.add(viewmodel);
  scene.add(camera);
}
setViewmodel();

// ---------------------------------------------------------------- combat
const raycaster = new THREE.Raycaster();
raycaster.far = 160;
const hitMeshes = [];
for (const b of bots) hitMeshes.push(b.headMesh, ...b.bodyMeshes);

function eyeOf(c) { return c.isPlayer ? player.eye() : c.eye(); }
function chestOf(c) {
  if (c.isPlayer) return _v1.set(c.pos.x, 1.25, c.pos.z);
  return _v1.set(c.pos.x, 1.15, c.pos.z);
}

// a gunshot is heard: bots nearby walk over to look
function hearNoise(x, z, radius) {
  for (const b of bots) {
    if (!b.alive) continue;
    const d = Math.hypot(b.pos.x - x, b.pos.z - z);
    if (d < radius) b.hear(x, z, now);
  }
}

function damage(target, amount, attacker, part) {
  if (!target.alive || MATCH.phase === 'over' || MATCH.phase === 'matchover') return;
  let eff = amount;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, amount * 0.55);
    target.armor -= absorbed;
    eff = amount - absorbed;
  }
  target.hp -= eff;
  if (target.isPlayer) { hud.damageFlash(); sfx.hurt(); }
  if (target.hp <= 0) kill(target, attacker, part);
}

function kill(victim, attacker, part) {
  victim.hp = 0;
  victim.alive = false;
  victim.deaths++;
  if (attacker && attacker !== victim) {
    attacker.kills++;
    attacker.money += 300;
  }
  const wname = attacker ? WEAPONS[attacker.weaponId].name.split(' ')[0] : '—';
  const us = (c) => c.team === 'cinder';
  hud.feed(`<b class="${us(attacker || victim) ? 'us' : 'them'}">${attacker ? attacker.name : '?'}</b><span class="wpn">${wname}${part === 'head' ? ' ⌖' : ''}</span><b class="${us(victim) ? 'us' : 'them'}">${victim.name}</b>`);
  if (victim.isPlayer) { sfx.hurt(); }
  else if (attacker && attacker.isPlayer) { hud.hitmark(true); sfx.kill(); }
  // the Igniter and a primary weapon fall where the fighter fell
  if (igniter.carrier === victim && igniter.state === 'carried') {
    igniter.state = 'dropped';
    igniter.carrier = null;
    igniter.pos.set(victim.pos.x, 0, victim.pos.z);
    igniter.mesh.visible = true;
    igniter.mesh.position.set(victim.pos.x, 0.14, victim.pos.z);
    hud.objective(victim.team === 'cinder' ? 'The Igniter is down — recover it' : 'The Igniter is down');
  }
  if (!victim.isPlayer && victim.weaponId !== 'v9') dropGun(victim.weaponId, victim.pos);
  if (victim.isPlayer && myPrimary) {
    const mp = myPrimary; // capture before clearing: deleting key "null" was a bug
    dropGun(mp, victim.pos);
    delete myGuns[mp];
    myPrimary = null;
    me.weaponId = 'v9';
    me.grenades = 0;
  }
  checkElimination();
}

function checkElimination() {
  if (MATCH.phase !== 'live') return;
  const j = all.filter((c) => c.team === 'cinder' && c.alive).length;
  const w = all.filter((c) => c.team === 'tidewatch' && c.alive).length;
  if (j === 0) endRound('tidewatch', 'Cinders eliminated');
  else if (w === 0) endRound('cinder', 'Tidewatch eliminated');
}

// the player's own trigger: real raycasts against bot hitboxes and the world
let lastShotAt = -9, bloom = 0, triggerHeld = false, reloadingUntil = 0;
function playerShoot() {
  const w = WEAPONS[me.weaponId];
  const gun = myGuns[me.weaponId];
  if (now < reloadingUntil) return;
  if (gun.mag <= 0) { sfx.dryFire(); lastShotAt = now; startReload(); return; }
  gun.mag--;
  lastShotAt = now;
  bloom = Math.min(w.spreadMax, bloom + w.bloomPerShot);
  recoil = Math.min(1, recoil + (w.kind === 'sniper' ? 1 : 0.45));
  sfx.shot(w.kind);
  hearNoise(me.pos.x, me.pos.z, 30);
  muzzle.visible = true;
  setTimeout(() => { muzzle.visible = false; }, 45);

  const movePenalty = (player.speed2d / 4.7) * 0.02 + (player.onGround ? 0 : 0.03);
  const crouchBonus = player.crouched ? 0.6 : 1; // crouching steadies the aim
  const spread = (w.spreadBase + bloom + movePenalty) * crouchBonus;
  const origin = player.eye();
  _v2.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _v2.x += (Math.random() - 0.5) * 2 * spread;
  _v2.y += (Math.random() - 0.5) * 2 * spread;
  _v2.z += (Math.random() - 0.5) * 2 * spread;
  _v2.normalize();
  raycaster.set(origin, _v2);
  const botHits = raycaster.intersectObjects(hitMeshes.filter((m) => m.userData.bot.alive), false);
  const worldHits = raycaster.intersectObject(world.group, true).filter((h) => h.object.isMesh && !h.object.isSprite);
  const bh = botHits[0], wh = worldHits[0];
  _v3.copy(origin).addScaledVector(_v2, 0.7).add(_v1.set(0, -0.08, 0));
  const muzzleWorld = _v3.clone();
  if (bh && (!wh || bh.distance < wh.distance)) {
    const bot = bh.object.userData.bot;
    const part = bh.object.userData.part;
    let dmg = w.damage * (part === 'head' ? w.headMult : 1);
    if (bh.distance > w.range) dmg *= w.falloff;
    tracer(muzzleWorld, bh.point);
    burst(bh.point, 5, 0xd84a3a);
    hud.hitmark(false); sfx.hit();
    damage(bot, dmg, me, part);
  } else if (wh) {
    tracer(muzzleWorld, wh.point);
    burst(wh.point, 4);
  } else {
    tracer(muzzleWorld, origin.clone().addScaledVector(_v2, 60));
  }
  hud.gun(w.name, gun.mag, gun.reserve, me.money, false, me.grenades, player.crouched);
}

function startReload() {
  const w = WEAPONS[me.weaponId];
  const gun = myGuns[me.weaponId];
  if (gun.mag >= w.mag || gun.reserve <= 0 || now < reloadingUntil) return;
  reloadingUntil = now + w.reloadMs / 1000;
  sfx.reload();
  hud.gun(w.name, gun.mag, gun.reserve, me.money, true, me.grenades, player.crouched);
}
function finishReload() {
  const w = WEAPONS[me.weaponId];
  const gun = myGuns[me.weaponId];
  const take = Math.min(w.mag - gun.mag, gun.reserve);
  gun.mag += take; gun.reserve -= take;
  hud.gun(w.name, gun.mag, gun.reserve, me.money, false, me.grenades, player.crouched);
}

// a bot's bullet: probability shaped by weapon, distance and target motion
function botShoot(bot, target) {
  const w = WEAPONS[bot.weaponId];
  const from = bot.eye().add(_v1.set(0, -0.15, 0));
  const dist = bot.pos.distanceTo(target.pos);
  const aim = chestOf(target);
  aim.x += (Math.random() - 0.5) * 1.4;
  aim.y += (Math.random() - 0.5) * 0.5;
  aim.z += (Math.random() - 0.5) * 1.4;
  tracer(from, aim, 0xffe2a8);
  burst(aim, 2);
  hearNoise(bot.pos.x, bot.pos.z, 18);
  if (target.isPlayer) sfx.distantShot();
  else if (bot.pos.distanceTo(me.pos) < 26) sfx.distantShot();

  let p = w.kind === 'sniper' ? 0.5 : w.kind === 'rifle' ? 0.34 : w.kind === 'smg' ? 0.31 : 0.27;
  p -= Math.max(0, dist - 12) * 0.004;
  const tSpeed = target.isPlayer ? player.speed2d : 2.0;
  if (tSpeed > 3.4) p -= 0.11;
  if (target.channel) p += 0.12;
  if (Math.random() > Math.max(0.05, p)) return;
  const head = Math.random() < 0.12;
  let dmg = w.damage * (head ? w.headMult : 1);
  if (dist > w.range) dmg *= w.falloff;
  damage(target, dmg, bot, head ? 'head' : 'body');
}

// ---------------------------------------------------------------- grenades
const grenadesLive = [];
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 10);
const grenadeMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.4, metalness: 0.7 });
function throwGrenade() {
  if (me.grenades <= 0 || MATCH.phase !== 'live' || !me.alive) return;
  me.grenades--;
  sfx.throwPin();
  const m = new THREE.Mesh(grenadeGeo, grenadeMat);
  const eye = player.eye();
  m.position.copy(eye);
  scene.add(m);
  const dir = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion);
  grenadesLive.push({
    mesh: m,
    vx: dir.x * 14, vy: dir.y * 14 + 4.2, vz: dir.z * 14,
    detonateAt: now + GRENADE.fuseSeconds,
  });
  hud.gun(WEAPONS[me.weaponId].name, myGuns[me.weaponId].mag, myGuns[me.weaponId].reserve, me.money, false, me.grenades, player.crouched);
}
function tickGrenades(dt) {
  for (let i = grenadesLive.length - 1; i >= 0; i--) {
    const g = grenadesLive[i];
    g.vy -= 12 * dt;
    g.mesh.position.x += g.vx * dt;
    g.mesh.position.y += g.vy * dt;
    g.mesh.position.z += g.vz * dt;
    if (g.mesh.position.y < 0.09) { g.mesh.position.y = 0.09; g.vy = 0; g.vx *= 0.6; g.vz *= 0.6; }
    if (now >= g.detonateAt) {
      const p = g.mesh.position;
      burst(p, 24, 0xfff6c8);
      sfx.flash();
      hearNoise(p.x, p.z, 40);
      // the player is flashed too if they are looking at the pop
      if (me.alive) {
        const toPop = _v1.copy(p).sub(player.eye()).normalize();
        const fwd = _v2.set(0, 0, -1).applyQuaternion(camera.quaternion);
        const d = Math.hypot(p.x - me.pos.x, p.z - me.pos.z);
        if (d < 25 && toPop.dot(fwd) > 0.25) hud.flashWhite();
      }
      // bots that can see the pop are blinded; anyone very close is hurt
      for (const b of bots) {
        if (!b.alive) continue;
        const d = Math.hypot(b.pos.x - p.x, b.pos.z - p.z);
        if (d < GRENADE.hurtRadius) damage(b, GRENADE.hurtDamage, me, 'body');
        if (d < GRENADE.blindRadius) {
          // line of sight from the pop to the bot: walls shield the flash
          if (lineClear(p.x, p.z, b.pos.x, b.pos.z, world.colliders)) {
            b.blindUntil = now + GRENADE.blindSeconds;
            b.target = null;
          }
        }
      }
      scene.remove(g.mesh);
      grenadesLive.splice(i, 1);
    }
  }
}
// ---------------------------------------------------------------- bot jobs
const GUARD = {
  A: [[-19, -21], [-31, -18]],
  B: [[17, -22], [24, -14]],
  mid: [[4, -9]],
};
const roleOf = new Map(); // bot -> 'A' | 'B' | 'mid'
function assignRoles() {
  const j = bots.filter((b) => b.team === 'cinder');
  const w = bots.filter((b) => b.team === 'tidewatch');
  ['A', 'A', 'B', 'B'].forEach((r, i) => roleOf.set(j[i], r));
  ['A', 'A', 'B', 'B', 'mid'].forEach((r, i) => roleOf.set(w[i], r));
}
function insideSite(pos) {
  for (const [key, s] of Object.entries(SITES)) {
    if (Math.hypot(pos.x - s.x, pos.z - s.z) <= s.r) return key;
  }
  return null;
}
function jobFor(bot) {
  const stand = { kind: 'stand', point: { x: bot.pos.x, z: bot.pos.z } };
  if (MATCH.phase !== 'live') return stand;
  const role = roleOf.get(bot) || 'mid';

  if (igniter.state === 'planted') {
    const s = SITES[MATCH.plantedAtSite];
    if (bot.team === 'tidewatch') {
      const d = Math.hypot(bot.pos.x - igniter.pos.x, bot.pos.z - igniter.pos.z);
      const nearest = bots.filter((b) => b.team === 'tidewatch' && b.alive)
        .sort((a, b) => a.pos.distanceTo(igniter.pos) - b.pos.distanceTo(igniter.pos))[0];
      if (bot === nearest) return { kind: 'defuse', point: { x: igniter.pos.x, z: igniter.pos.z }, atSite: d < 1.7 };
      return { kind: 'cover', point: { x: s.x + (bot.index - 2) * 4, z: s.z + 6 } };
    }
    return { kind: 'cover', point: { x: s.x + (bot.index - 2) * 3.5, z: s.z + 4.5 } };
  }
  if (bot.team === 'cinder') {
    if (igniter.state === 'dropped') {
      const nearest = bots.filter((b) => b.team === 'cinder' && b.alive)
        .sort((a, b) => a.pos.distanceTo(igniter.pos) - b.pos.distanceTo(igniter.pos))[0];
      if (bot === nearest || igniter.carrier === bot) return { kind: 'recover', point: { x: igniter.pos.x, z: igniter.pos.z } };
    }
    if (igniter.carrier === bot) {
      const s = SITES[bot.carrySite || 'A'];
      const inside = insideSite(bot.pos) === (bot.carrySite || 'A');
      return { kind: 'plant', point: { x: s.x, z: s.z }, atSite: inside };
    }
    const s = SITES[role === 'mid' ? 'A' : role];
    return { kind: 'push', point: { x: s.x + (bot.index - 2) * 3, z: s.z + s.r + 3 } };
  }
  // tidewatch hold their ground
  const g = GUARD[role][bot.index % GUARD[role].length];
  return { kind: 'hold', point: { x: g[0], z: g[1] }, face: Math.PI };
}

function startChannel(actor, kind, seconds) {
  igniter.channel = { actor, kind, endsAt: now + seconds, total: seconds };
  actor.channel = igniter.channel;
  igniter.lastBeepSec = -1;
  return true;
}
function tryPlant(bot) {
  if (igniter.state !== 'carried' || igniter.carrier !== bot) return false;
  if (igniter.channel) return igniter.channel.actor === bot;
  if (!insideSite(bot.pos)) return false;
  return startChannel(bot, 'plant', 3.2);
}
function tryDefuse(bot) {
  if (igniter.state !== 'planted') return false;
  if (igniter.channel) return igniter.channel.actor === bot;
  if (bot.pos.distanceTo(igniter.pos) > 1.7) return false;
  return startChannel(bot, 'defuse', 5);
}
function doPlant(actor) {
  const site = insideSite(actor.pos) || 'A';
  igniter.state = 'planted';
  igniter.site = site;
  igniter.planter = actor;
  igniter.carrier = null;
  actor.hasIgniter = false;
  igniter.pos.set(actor.pos.x, 0, actor.pos.z);
  igniter.mesh.visible = true;
  igniter.mesh.position.set(actor.pos.x, 0.14, actor.pos.z);
  MATCH.plantedAtSite = site;
  MATCH.plantEndsAt = now + 35;
  sfx.planted();
  hud.banner('IGNITER PLANTED', `Site ${site} — ${SITES[site].name}`, '', 1.6);
  hud.objective(actor.team === 'cinder' ? 'Defend the Igniter' : 'Defuse the Igniter');
}
function tickChannel() {
  const ch = igniter.channel;
  if (!ch) return;
  if (!ch.actor.alive) { ch.actor.channel = null; igniter.channel = null; return; }
  const secLeft = Math.ceil(ch.endsAt - now);
  if (secLeft !== igniter.lastBeepSec) { igniter.lastBeepSec = secLeft; sfx.plantBeep(); }
  if (now >= ch.endsAt) {
    const actor = ch.actor;
    actor.channel = null;
    igniter.channel = null;
    if (ch.kind === 'plant') doPlant(actor);
    else { sfx.defused(); endRound('tidewatch', 'Igniter defused'); }
  }
}

// ---------------------------------------------------------------- economy & rounds
function botBuy(bot) {
  if (bot.money >= 650 && bot.armor <= 0 && Math.random() < 0.75) { bot.armor = 100; bot.money -= 650; }
  if (bot.weaponId === 'v9') {
    const roll = Math.random();
    if (bot.money >= 3200 && roll < 0.14) { bot.weaponId = 'albatross'; bot.money -= 3200; }
    else if (bot.money >= 2700) { bot.weaponId = 'harrier'; bot.money -= 2700; }
    else if (bot.money >= 1500) { bot.weaponId = 'hornet'; bot.money -= 1500; }
    bot.ammoInMag = WEAPONS[bot.weaponId].mag;
  }
}

function startRound() {
  MATCH.round++;
  MATCH.phase = 'buy';
  MATCH.phaseEndsAt = now + 12;
  MATCH.plantedAtSite = null;
  igniter.state = 'carried';
  igniter.carrier = me;
  igniter.channel = null;
  igniter.mesh.visible = false;
  me.hasIgniter = true;
  assignRoles();

  const playerDied = !me.alive && MATCH.round > 1;
  me.hp = 100; me.alive = true;
  if (playerDied) { me.armor = 0; me.grenades = 0; }
  if (playerDied) {
    myPrimary = null;
    for (const k of Object.keys(myGuns)) if (k !== 'v9') delete myGuns[k];
    me.weaponId = 'v9';
    myGuns.v9 = { mag: WEAPONS.v9.mag, reserve: WEAPONS.v9.reserve };
    setViewmodel();
  }
  myGuns[me.weaponId].mag = WEAPONS[me.weaponId].mag;
  player.spawnAt(SPAWNS.cinder[0][0], SPAWNS.cinder[0][1], 0);

  for (const b of bots) {
    const died = !b.alive && MATCH.round > 1;
    b.hp = 100; b.alive = true;
    if (died) { b.armor = 0; b.weaponId = 'v9'; }
    b.hasIgniter = false;
    b.carrySite = Math.random() < 0.5 ? 'A' : 'B';
    const sp = SPAWNS[b.team][b.team === 'cinder' ? b.index : b.index];
    b.spawnAt(sp[0], sp[1], b.team === 'cinder' ? 0 : Math.PI);
    botBuy(b);
  }
  for (const d of droppedGuns) scene.remove(d.mesh);
  droppedGuns.length = 0;

  hud.scores(MATCH.score.cinder, MATCH.score.tidewatch);
  hud.objective('Plant the Igniter at A or B');
  hud.banner(`ROUND ${MATCH.round}`, 'Buy phase — press B', '', 1.6);
  buyOpen = !SHOT;
  refreshBuy();
}

function endRound(winner, reason) {
  if (MATCH.phase === 'over' || MATCH.phase === 'matchover') return;
  MATCH.score[winner]++;
  for (const c of all) c.money += c.team === winner ? 2500 : 1400;
  if (igniter.planter && reason.includes('detonated')) igniter.planter.money += 300;
  igniter.planter = null;
  if (igniter.channel) { igniter.channel.actor.channel = null; igniter.channel = null; }
  for (const b of bots) b.target = null;
  hud.scores(MATCH.score.cinder, MATCH.score.tidewatch);
  const won = winner === 'cinder';
  if (MATCH.score[winner] >= MATCH.targetScore) {
    MATCH.phase = 'matchover';
    MATCH.phaseEndsAt = now + 9;
    hud.banner(won ? 'MATCH WON' : 'MATCH LOST', `${MATCH.score.cinder} — ${MATCH.score.tidewatch} · ${reason}`, won ? 'win' : 'lose', 6);
    showBoard(true);
  } else {
    MATCH.phase = 'over';
    MATCH.phaseEndsAt = now + 4.5;
    hud.banner(won ? 'ROUND WON' : 'ROUND LOST', reason, won ? 'win' : 'lose', 2.8);
  }
  if (won) sfx.roundWin(); else sfx.roundLose();
}

function startMatch() {
  MATCH.score.cinder = 0; MATCH.score.tidewatch = 0; MATCH.round = 0;
  for (const c of all) { c.money = 800; c.kills = 0; c.deaths = 0; c.armor = 0; }
  for (const b of bots) b.weaponId = 'v9';
  myPrimary = null;
  for (const k of Object.keys(myGuns)) if (k !== 'v9') delete myGuns[k];
  me.weaponId = 'v9';
  me.grenades = 0;
  myGuns.v9 = { mag: WEAPONS.v9.mag, reserve: WEAPONS.v9.reserve };
  setViewmodel();
  startRound();
}

// ---------------------------------------------------------------- buy menu (player)
let buyOpen = false;
function refreshBuy() {
  const items = BUY_MENU.map((it) => {
    let owned = false;
    if (it.slot === 'armor') owned = me.armor > 0;
    if (it.slot === 'primary') owned = myPrimary === it.weapon;
    if (it.slot === 'grenade') owned = me.grenades >= GRENADE.maxCarry;
    return { key: it.key.replace('Digit', ''), label: it.label, desc: it.desc, price: it.price ?? WEAPONS[it.weapon].price, owned };
  });
  hud.buyMenu(items, me.money, fmtClock(MATCH.phaseEndsAt - now));
  hud.toggleBuy(buyOpen && MATCH.phase === 'buy');
}
function tryBuy(code) {
  const it = BUY_MENU.find((b) => b.key === code);
  if (!it) return;
  if (it.slot === 'armor') {
    if (me.armor > 0 || me.money < it.price) { sfx.denied(); return; }
    me.armor = 100; me.money -= it.price; sfx.buy();
  } else if (it.slot === 'primary') {
    const price = WEAPONS[it.weapon].price;
    if (myPrimary === it.weapon || me.money < price) { sfx.denied(); return; }
    myPrimary = it.weapon;
    myGuns[it.weapon] = { mag: WEAPONS[it.weapon].mag, reserve: WEAPONS[it.weapon].reserve };
    me.weaponId = it.weapon;
    me.money -= price;
    setViewmodel();
    sfx.buy();
  } else if (it.slot === 'grenade') {
    if (me.grenades >= GRENADE.maxCarry || me.money < it.price) { sfx.denied(); return; }
    me.grenades++;
    me.money -= it.price;
    sfx.buy();
  }
  refreshBuy();
  hud.gun(WEAPONS[me.weaponId].name, myGuns[me.weaponId].mag, myGuns[me.weaponId].reserve, me.money, false, me.grenades, player.crouched);
}

function showBoard(open) {
  const rows = (team) => all.filter((c) => c.team === team)
    .sort((a, b) => b.kills - a.kills)
    .map((c) => ({ name: c.name, k: c.kills, d: c.deaths, money: c.money, alive: c.alive, me: c.isPlayer }));
  hud.board(rows('cinder'), rows('tidewatch'), open);
}

// ---------------------------------------------------------------- player objective & pickups
let playerPlantT = 0;
function tickPlayerObjective(dt, frame) {
  hud.interact(null);
  if (!me.alive || MATCH.phase !== 'live') { playerPlantT = 0; return; }
  // plant: hold E inside a site while carrying the Igniter
  if (igniter.state === 'carried' && igniter.carrier === me && insideSite(me.pos) && !igniter.channel) {
    if (input.down('KeyE')) {
      playerPlantT += dt;
      const secLeft = Math.ceil(3.2 - playerPlantT);
      if (secLeft !== igniter.lastBeepSec) { igniter.lastBeepSec = secLeft; sfx.plantBeep(); }
      hud.interact('PLANTING THE IGNITER', playerPlantT / 3.2);
      if (playerPlantT >= 3.2) { playerPlantT = 0; startChannel(me, 'plant', 0.01); }
    } else playerPlantT = 0;
  }
  // pickups: the dropped Igniter and dropped primaries
  if (igniter.state === 'dropped' && me.pos.distanceTo(igniter.pos) < 1.4) {
    igniter.state = 'carried'; igniter.carrier = me; me.hasIgniter = true;
    igniter.mesh.visible = false;
    hud.objective('Plant the Igniter at A or B');
  }
  for (let i = droppedGuns.length - 1; i >= 0; i--) {
    const d = droppedGuns[i];
    if (!myPrimary && me.pos.distanceTo(d.pos) < 1.3) {
      myPrimary = d.weaponId;
      myGuns[d.weaponId] = { mag: WEAPONS[d.weaponId].mag, reserve: WEAPONS[d.weaponId].mag };
      scene.remove(d.mesh);
      droppedGuns.splice(i, 1);
      hud.feed(`You picked up a <b class="us">${WEAPONS[myPrimary].name}</b>`);
    }
  }
  // bots pick up the Igniter in their own tick
  for (const b of bots) {
    if (!b.alive) continue;
    if (igniter.state === 'dropped' && b.team === 'cinder' && b.pos.distanceTo(igniter.pos) < 1.3) {
      igniter.state = 'carried'; igniter.carrier = b; b.hasIgniter = true;
      igniter.mesh.visible = false;
    }
  }
}

// ---------------------------------------------------------------- per-step simulation
function phaseTick() {
  if (MATCH.phase === 'buy') {
    hud.clock(fmtClock(MATCH.phaseEndsAt - now), `Round ${MATCH.round} · Buy`, false);
    if (buyOpen) refreshBuy();
    if (now >= MATCH.phaseEndsAt) {
      MATCH.phase = 'live';
      MATCH.roundEndsAt = now + 100;
      buyOpen = false;
      hud.toggleBuy(false);
      hud.banner(`ROUND ${MATCH.round}`, 'Sites are live', '', 1.4);
    }
  } else if (MATCH.phase === 'live') {
    if (igniter.state === 'planted') {
      hud.clock(fmtClock(MATCH.plantEndsAt - now), 'Igniter planted', true);
      if (now >= MATCH.plantEndsAt) {
        sfx.explosion();
        burst(igniter.pos.clone().setY(1), 42, 0xff8a2a);
        burst(igniter.pos.clone().setY(1), 26, 0xffd98a);
        igniter.mesh.visible = false;
        endRound('cinder', 'Igniter detonated');
      }
    } else {
      hud.clock(fmtClock(MATCH.roundEndsAt - now), `Round ${MATCH.round}`, MATCH.roundEndsAt - now < 15);
      if (now >= MATCH.roundEndsAt) endRound('tidewatch', 'Time — the sites held');
    }
  } else if (MATCH.phase === 'over' || MATCH.phase === 'matchover') {
    hud.clock('—', MATCH.phase === 'over' ? 'Round over' : 'Match over', false);
    if (now >= MATCH.phaseEndsAt) {
      showBoard(false);
      if (MATCH.phase === 'matchover') startMatch();
      else startRound();
    }
  }
}

function playerTick(dt, frame) {
  const frozen = MATCH.phase !== 'live' && MATCH.phase !== 'buy' || !me.alive;
  player.update(dt, input, frame, frozen || SHOT !== null);
  if (player.footstep) { player.footstep = false; sfx.step(); }

  if (!me.alive) {
    // death cam: slumped at the fall point, watching the round play out
    camera.position.set(player.pos.x, 0.5, player.pos.z);
    camera.rotation.set(-0.4, player.yaw, 0.35);
    if (viewmodel) viewmodel.visible = false;
    return;
  }
  if (viewmodel) viewmodel.visible = true;
  player.applyCamera(camera);

  // viewmodel life: recoil spring, walk bob, ADS blend for the Albatross
  recoil = Math.max(0, recoil - dt * 6.5);
  const w = WEAPONS[me.weaponId];
  const wantAds = rmbDown && w.zoom > 1 ? 1 : 0;
  adsAmt += (wantAds - adsAmt) * Math.min(1, dt * 9);
  const targetFov = 74 / (1 + (w.zoom - 1) * adsAmt);
  if (Math.abs(camera.fov - targetFov) > 0.1) { camera.fov = targetFov; camera.updateProjectionMatrix(); }
  if (viewmodel) {
    const bob = Math.sin(now * 9) * 0.006 * Math.min(1, player.speed2d / 4);
    viewmodel.position.set(
      0.24 - adsAmt * 0.24,
      -0.22 + bob - adsAmt * 0.055,
      -0.45 + recoil * 0.085,
    );
    viewmodel.rotation.x = recoil * 0.14;
  }

  if (SHOT) return;
  // shooting
  const gun = myGuns[me.weaponId];
  if (now >= reloadingUntil && reloadingUntil > 0 && lastShotAt < reloadingUntil) finishReload();
  if (MATCH.phase === 'live' && input.locked) {
    if (w.auto) {
      if (input.firing && now - lastShotAt >= 60 / w.rpm) playerShoot();
    } else {
      if (input.firing && !triggerHeld && now - lastShotAt >= 60 / w.rpm) playerShoot();
    }
  }
  triggerHeld = input.firing;
  bloom = Math.max(0, bloom - WEAPONS[me.weaponId].settlePerSec * dt * (player.speed2d > 0.5 ? 0.4 : 1));

  // keys that act on press
  if (frame.pressed.has('KeyR')) startReload();
  if (frame.pressed.has('KeyG')) throwGrenade();
  if (frame.pressed.has('Digit1') && me.weaponId !== 'v9') { me.weaponId = 'v9'; setViewmodel(); }
  if (frame.pressed.has('Digit2') && MATCH.phase !== 'buy' && myPrimary && me.weaponId !== myPrimary) { me.weaponId = myPrimary; setViewmodel(); }
  if (MATCH.phase === 'buy') {
    for (const code of frame.pressed) if (code.startsWith('Digit')) tryBuy(code);
  }
  showBoard(input.down('Tab'));
}

let gunCache = '';
function hudTick() {
  const usAlive = all.filter((c) => c.team === 'cinder' && c.alive).length;
  const themAlive = all.filter((c) => c.team === 'tidewatch' && c.alive).length;
  hud.vitals(me.hp, me.armor, usAlive, themAlive);
  const w = WEAPONS[me.weaponId];
  const gun = myGuns[me.weaponId] || myGuns.v9;
  const key = `${w.name}|${gun.mag}|${gun.reserve}|${me.money}|${now < reloadingUntil}|${me.grenades}|${player.crouched}`;
  if (key !== gunCache) {
    gunCache = key;
    hud.gun(w.name, gun.mag, gun.reserve, me.money, now < reloadingUntil, me.grenades, player.crouched);
  }
  // the Igniter's lamp pulses while it sits planted or dropped
  if (igniter.mesh.visible) {
    const lamp = igniter.mesh.children[1];
    lamp.material.emissiveIntensity = igniter.state === 'planted' ? (Math.sin(now * 9) > 0 ? 3.4 : 0.4) : 1.6;
  }
}

function botTick(dt) {
  for (const b of bots) {
    b.update(dt, {
      dt, now, colliders: world.colliders, waypoints: world.waypoints,
      foes: MATCH.phase === 'live' ? foesOf(b) : [],
      phase: MATCH.phase,
      shoot: botShoot, jobFor, tryPlant, tryDefuse,
    });
  }
}

function fxTick(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    if (now > tracers[i].until) {
      scene.remove(tracers[i].line);
      tracers[i].line.geometry.dispose();
      tracers.splice(i, 1);
    }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    if (now > s.until) { scene.remove(s.m); sparks.splice(i, 1); continue; }
    s.m.position.addScaledVector(s.m.userData.v, dt);
    s.m.userData.v.y -= 7 * dt;
  }
}

// one fixed simulation step; `frame` carries this frame's input on the
// first substep only, later substeps get an empty frame
function stepSim(dt, frame) {
  if (MATCH.phase !== 'title') {
    phaseTick();
    playerTick(dt, frame);
    botTick(dt);
    tickChannel();
    tickPlayerObjective(dt, frame);
    tickGrenades(dt);
    hudTick();
  }
}

// ---------------------------------------------------------------- frame loop
let lastT = performance.now();
let rmbDown = false;
addEventListener('mousedown', (e) => { if (e.button === 2) rmbDown = true; });
addEventListener('mouseup', (e) => { if (e.button === 2) rmbDown = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('keydown', (e) => { if (e.code === 'KeyB' && MATCH.phase === 'buy' && me.alive) { buyOpen = !buyOpen; refreshBuy(); } });

let acc = 0;
let framesRendered = 0;
let stageFeedDone = false;
// Staged shots render at ~1 fps under SwiftShader, so the sim runs for
// seconds of wall time before the capture: re-assert the staged state
// every frame (a bot would otherwise wander off, shoot the player, and
// the killfeed would fade before frame 30 is captured).
function stageHold() {
  if (SHOT !== 'play') return;
  me.hp = 72; me.armor = 40;
  for (const b of bots) { b.burstLeft = 0; b.burstAt = now + 999; b.target = null; }
  const tide = bots.filter((b) => b.team === 'tidewatch');
  tide[0].pos.set(-2, 0, -2); tide[0].yaw = Math.PI; tide[0].syncMesh(0);
  tide[1].pos.set(15, 0, -7); tide[1].yaw = Math.PI; tide[1].syncMesh(0);
  const cind = bots.filter((b) => b.team === 'cinder');
  cind[0].pos.set(8, 0, 4); cind[0].yaw = -0.4; cind[0].syncMesh(0);
  cind[1].pos.set(12, 0, 2); cind[1].yaw = -0.3; cind[1].syncMesh(0);
  recoil = 0.35;
  // keep the impact sparking until the capture (sparks live 0.32 s of sim)
  burst(_v1.set(-2, 1.25, -2), 3, 0xffc46b);
  if (framesRendered >= 28 && !stageFeedDone) {
    stageFeedDone = true;
    hud.feed('<b class="us">Ash</b><span class="wpn">HARRIER</span><b class="them">Brine</b>');
    hud.feed('<b class="them">Gull</b><span class="wpn">HORNET</span><b class="us">Soot</b>');
  }
}
function loop() {
  requestAnimationFrame(loop);
  const t = performance.now();
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  stageHold();
  acc += dt;
  let first = true;
  let steps = 0;
  while (acc >= STEP && steps < 4) {
    now += STEP;
    stepSim(STEP, first ? input.consume() : EMPTY_FRAME);
    first = false;
    acc -= STEP;
    steps++;
  }
  if (steps === 0) input.consume(); // keep input drained on idle frames
  fxTick(dt);
  world.update(now);
  renderer.render(scene, camera);
  framesRendered++;
  window.__frames = framesRendered;
  if (SHOT && framesRendered === 30) window.__shotReady = true;
}

// ---------------------------------------------------------------- staging for screenshots
function stageShot(mode) {
  hud.showGame();
  startMatch(); // round 1, buy phase, everyone at spawn
  if (mode === 'start') {
    buyOpen = true;
    MATCH.phaseEndsAt = now + 8;
    refreshBuy();
  } else if (mode === 'play') {
    MATCH.phase = 'live';
    MATCH.roundEndsAt = now + 47;
    buyOpen = false; hud.toggleBuy(false);
    me.weaponId = 'harrier';
    myPrimary = 'harrier';
    myGuns.harrier = { mag: 17, reserve: 50 };
    setViewmodel();
    me.hp = 72; me.armor = 40;
    player.spawnAt(2, 12, -0.15);
    const tide = bots.filter((b) => b.team === 'tidewatch');
    tide[0].spawnAt(-2, -2, Math.PI); tide[0].weaponId = 'v9';
    tide[1].spawnAt(15, -7, Math.PI); tide[1].weaponId = 'v9';
    const cind = bots.filter((b) => b.team === 'cinder');
    cind[0].spawnAt(8, 4, -0.4);
    cind[1].spawnAt(12, 2, -0.3);
    // a staged shot mid-flight: tracer + impact sparks on the lead Tidewatch
    const from = new THREE.Vector3(2.6, 1.35, 11.2);
    const to = new THREE.Vector3(-2, 1.25, -2);
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9 }));
    scene.add(line);
    tracers.push({ line, until: now + 9999 });
    burst(to, 7, 0xffc46b);
    recoil = 0.85;
    hud.feed('<b class="us">Ash</b><span class="wpn">HARRIER</span><b class="them">Brine</b>');
    hud.feed('<b class="them">Gull</b><span class="wpn">HORNET</span><b class="us">Soot</b>');
    hud.objective('Plant the Igniter at A or B — mid is contested');
  } else if (mode === 'end') {
    MATCH.score.cinder = 4; MATCH.score.tidewatch = 2;
    MATCH.phase = 'over';
    MATCH.phaseEndsAt = now + 999;
    buyOpen = false; hud.toggleBuy(false);
    player.spawnAt(-19, -23, 1.05);
    me.hp = 38; me.armor = 15;
    igniter.state = 'planted';
    igniter.mesh.visible = true;
    igniter.mesh.position.set(-23, 0.14, -24);
    igniter.pos.set(-23, 0, -24);
    MATCH.plantedAtSite = 'A';
    const tide = bots.filter((b) => b.team === 'tidewatch');
    tide[0].hp = 0; tide[0].die(); tide[0].pos.set(-21, 0, -21); tide[0].syncMesh(0);
    tide[1].hp = 0; tide[1].die(); tide[1].pos.set(-29, 0, -29); tide[1].syncMesh(0);
    hud.scores(4, 2);
    hud.banner('ROUND WON', 'Igniter detonated at the Crane Yard', 'win', 999);
    hud.objective('Site A taken');
  }
}

// ---------------------------------------------------------------- boot
document.getElementById('playBtn').addEventListener('click', () => {
  sfx.ensure();
  hud.showGame();
  startMatch();
});
addEventListener('pointerdown', () => sfx.ensure(), { once: true });
if (SHOT) stageShot(SHOT);
else { camera.position.set(30, 14, 38); camera.lookAt(0, 1, -20); }
loop();

// test hook: the soak script reads match state through this, nothing else
window.__game = {
  MATCH, me, bots,
  phase: () => MATCH.phase,
  alive: () => all.filter((c) => c.alive).length,
  yaw: () => player.yaw,
  pitch: () => player.pitch,
  locked: () => input.locked,
  keys: () => [...input.keys],
};
