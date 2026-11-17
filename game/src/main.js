// main.js — Ember Quay's match brain.
//
// Everything that turns a map and ten combatants into a match lives
// here: the round state machine (buy, live, planted, over), the money,
// the Igniter objective and its channels, the player's gunplay, the
// damage ledger for bot fire, the Sunburst grenade, and the staged
// scenes the screenshots are taken from (?shot=start|play|end).
//
// The other modules are instruments: world.js owns the map, player.js
// the body, bots.js the nine other fighters (they act through the ctx
// callbacks built below), weapons.js the armoury tables, hud.js every
// readout, audio.js every sound. This file conducts.

import * as THREE from 'three';
import { buildWorld, SITES, SPAWNS, lineClear } from './world.js';
import { Player } from './player.js';
import { Bot } from './bots.js';
import { Input } from './input.js';
import { Hud, fmtClock } from './hud.js';
import { Sfx } from './audio.js';
import { WEAPONS, GRENADE, BUY_MENU, buildViewmodel, buildMuzzleFlash } from './weapons.js';
import { COLORS } from './palette.js';

// ------------------------------------------------------------------ tuning

const ROUND = {
  buySeconds: 12,
  liveSeconds: 105,
  detonateSeconds: 40,
  overSeconds: 5,
  matchOverSeconds: 9,
  roundsToWin: 6,
  plantSeconds: 3.2,
  defuseSeconds: 5,
  winPay: 2700,
  lossPay: 1900,
  killPay: 300,
  startMoney: 800,
};

const SHOT = new URLSearchParams(location.search).get('shot');
const STAGED = SHOT === 'start' || SHOT === 'play' || SHOT === 'end';

// ------------------------------------------------------------------ stage

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.sky);
scene.fog = new THREE.Fog(COLORS.fog, 34, 125);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, 320);
scene.add(camera);

scene.add(new THREE.HemisphereLight(0x93a7c4, 0x14161a, 1.1));
const moon = new THREE.DirectionalLight(0xbdd0ee, 0.9);
moon.position.set(-30, 60, -20);
scene.add(moon);

const world = buildWorld(scene);
const mats = world.mats;

const input = new Input(renderer.domElement);
const hud = new Hud();
const sfx = new Sfx();
const player = new Player(world.colliders);

// ------------------------------------------------------------------ cast

// The player's combatant record. It shares its position vector with
// the body in player.js, so anything that can see or hit a bot can see
// or hit this, through exactly the same fields.
const me = {
  isPlayer: true,
  name: 'YOU',
  team: 'cinder',
  pos: player.pos,
  hp: 100,
  armor: 0,
  alive: true,
  money: ROUND.startMoney,
  kills: 0,
  deaths: 0,
  weaponId: 'v9',
  primary: null,
  grenades: 0,
  hasIgniter: false,
  channel: null,
  mag: WEAPONS.v9.mag,
  reserve: WEAPONS.v9.reserve,
  bloom: 0,
  nextShotAt: 0,
  reloadEndsAt: 0,
  eye() { return player.eye(); },
  chestPos() { const e = player.eye(); e.y -= 0.42; return e; },
  blinded() { return false; },
};

const bots = [];
for (let i = 0; i < 4; i++) bots.push(new Bot('cinder', i, scene));
for (let i = 0; i < 5; i++) bots.push(new Bot('tidewatch', i, scene));
const fighters = [me, ...bots];
const cinders = fighters.filter((f) => f.team === 'cinder');
const tidewatch = fighters.filter((f) => f.team === 'tidewatch');

// ------------------------------------------------------------------ match

const match = {
  phase: 'title',        // title | buy | live | planted | over | matchover
  phaseEndsAt: 0,
  round: 0,
  score: { cinder: 0, tidewatch: 0 },
  targetSite: 'A',
  now: 0,
};

const igniter = {
  carrier: null,         // fighter holding it, or null
  planted: false,
  site: null,            // 'A' | 'B' once planted
  pos: new THREE.Vector3(),
  channel: null,         // {actor, kind, endsAt, total}
  detonateAt: 0,
  mesh: null,
};

function makeIgniterMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.16), mats.igniterBody);
  body.position.y = 0.15;
  g.add(body);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.05), mats.igniterLight);
  lamp.position.set(0, 0.32, 0);
  g.add(lamp);
  g.visible = false;
  scene.add(g);
  return g;
}
igniter.mesh = makeIgniterMesh();

// ------------------------------------------------------------------ fx

const tracers = [];   // {line, diesAt}
const bursts = [];    // {points, vel[], diesAt}
const flashMat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85 });

function tracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, flashMat);
  scene.add(line);
  tracers.push({ line, diesAt: match.now + 0.07 });
}

function burst(at, n = 8, color = 0xffc46b) {
  const pos = new Float32Array(n * 3);
  const vel = [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
    vel.push(new THREE.Vector3((Math.random() - 0.5) * 2.6, Math.random() * 2.2, (Math.random() - 0.5) * 2.6));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.09, transparent: true, opacity: 0.95 }));
  scene.add(points);
  bursts.push({ points, vel, diesAt: match.now + 0.34 });
}

function stepFx(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    if (match.now >= tracers[i].diesAt) {
      scene.remove(tracers[i].line);
      tracers[i].line.geometry.dispose();
      tracers.splice(i, 1);
    }
  }
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    if (match.now >= b.diesAt) {
      scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      bursts.splice(i, 1);
      continue;
    }
    const p = b.points.geometry.attributes.position;
    for (let j = 0; j < b.vel.length; j++) {
      b.vel[j].y -= 6.5 * dt;
      p.array[j * 3] += b.vel[j].x * dt;
      p.array[j * 3 + 1] += b.vel[j].y * dt;
      p.array[j * 3 + 2] += b.vel[j].z * dt;
    }
    p.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ viewmodel

let viewmodel = null;
let muzzle = null;
let recoil = 0;

function fitViewmodel() {
  if (viewmodel) camera.remove(viewmodel);
  viewmodel = buildViewmodel(me.weaponId, COLORS.cinder);
  muzzle = buildMuzzleFlash();
  muzzle.position.set(0.02, 0.06, -0.62);
  viewmodel.add(muzzle);
  camera.add(viewmodel);
}
fitViewmodel();

// ------------------------------------------------------------------ damage

function hurt(victim, rawDmg, attacker, head) {
  if (!victim.alive || match.phase === 'over' || match.phase === 'matchover') return;
  let dmg = rawDmg;
  if (victim.armor > 0) {
    const soaked = Math.min(victim.armor, dmg * 0.55);
    victim.armor = Math.max(0, Math.round(victim.armor - soaked));
    dmg -= soaked;
  }
  victim.hp -= dmg;
  if (victim.isPlayer) {
    hud.damageFlash();
    sfx.hurt();
  }
  if (attacker && attacker.isPlayer) hud.hitmark(victim.hp <= 0);
  if (victim.hp > 0) return;

  victim.hp = 0;
  victim.alive = false;
  victim.deaths += 1;
  if (victim.channel) {
    if (igniter.channel && igniter.channel.actor === victim) igniter.channel = null;
    victim.channel = null;
  }
  if (victim.hasIgniter) dropIgniter(victim);
  if (victim.isPlayer) {
    // the body stays where it fell; the camera keeps its last frame
  } else {
    victim.die();
  }
  if (attacker && attacker !== victim) {
    attacker.kills += 1;
    attacker.money = Math.min(16000, attacker.money + ROUND.killPay);
    hud.feed(`<b>${attacker.name}</b> ▸ ${victim.name} <span>${WEAPONS[attacker.weaponId].name}</span>`);
    if (attacker.isPlayer) sfx.kill();
  }
  checkElimination();
}

function dropIgniter(from) {
  from.hasIgniter = false;
  igniter.carrier = null;
  igniter.pos.set(from.pos.x, 0, from.pos.z);
  igniter.mesh.position.set(from.pos.x, 0, from.pos.z);
  igniter.mesh.visible = true;
}

function checkElimination() {
  if (match.phase !== 'live' && match.phase !== 'planted') return;
  const cAlive = cinders.some((f) => f.alive);
  const tAlive = tidewatch.some((f) => f.alive);
  if (!tAlive) return endRound('cinder', 'Tidewatch eliminated');
  if (!cAlive && !igniter.planted) return endRound('tidewatch', 'Cinders eliminated');
  // attackers all down after the plant: the defuse race still runs
}

// ------------------------------------------------------------------ bot fire

// bots.js decides when a bot shoots; this resolves the shot. Accuracy
// is a probability shaped by distance and the target's state — a
// target mid-channel is a gift, a crouched one is not.
function botShoot(bot, target) {
  const w = WEAPONS[bot.weaponId];
  const from = bot.eye();
  const aim = target.chestPos();
  const dist = from.distanceTo(aim);
  tracer(from, aim);
  burst(aim, 3, 0xffe2b0);
  if (dist < 20) sfx.shot(w.kind); else sfx.distantShot();
  for (const f of fighters) {
    if (f.alive && !f.isPlayer && f.team !== bot.team) f.hear(bot.pos.x, bot.pos.z, match.now);
  }
  let chance = 0.62 - dist * 0.008;
  if (target.channel) chance += 0.14;
  if (target.isPlayer && player.crouched) chance -= 0.09;
  if (target.isPlayer && player.speed2d > 3) chance -= 0.1;
  chance = Math.max(0.08, Math.min(0.85, chance));
  if (Math.random() > chance) return;
  const head = Math.random() < 0.16;
  let dmg = w.damage * (head ? w.headMult : 1);
  if (dist > w.range) dmg *= w.falloff;
  hurt(target, dmg, bot, head);
}

function botCtx(bot) {
  return {
    dt: 0,
    now: match.now,
    colliders: world.colliders,
    waypoints: world.waypoints,
    foes: fighters.filter((f) => f.alive && f.team !== bot.team),
    phase: match.phase,
    shoot: botShoot,
    tryPlant,
    tryDefuse,
    jobFor,
  };
}

// ------------------------------------------------------------------ jobs

function siteOf(key) { return SITES[key]; }

function jobFor(bot) {
  const home = { kind: 'hold', point: { x: bot.pos.x, z: bot.pos.z }, face: bot.team === 'cinder' ? 0 : Math.PI };
  if (match.phase !== 'live' && match.phase !== 'planted') return home;

  if (match.phase === 'planted') {
    const s = siteOf(igniter.site);
    if (bot.team === 'tidewatch') {
      const defenders = tidewatch.filter((f) => f.alive);
      const closest = defenders.reduce((a, b) => (
        Math.hypot(a.pos.x - igniter.pos.x, a.pos.z - igniter.pos.z) <
        Math.hypot(b.pos.x - igniter.pos.x, b.pos.z - igniter.pos.z) ? a : b
      ), defenders[0]);
      if (bot === closest) {
        return {
          kind: 'defuse',
          point: { x: igniter.pos.x, z: igniter.pos.z },
          atSite: Math.hypot(bot.pos.x - igniter.pos.x, bot.pos.z - igniter.pos.z) < 2.6,
        };
      }
      return { kind: 'hold', point: { x: s.x + (bot.index - 2) * 5, z: s.z + 9 }, face: Math.PI };
    }
    return { kind: 'hold', point: { x: s.x + (bot.index - 1.5) * 7, z: s.z + 8 }, face: 0 };
  }

  // live, not yet planted
  const s = siteOf(match.targetSite);
  if (bot.team === 'cinder') {
    if (bot.hasIgniter) {
      return {
        kind: 'plant',
        point: { x: s.x, z: s.z },
        atSite: Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z) < s.r - 1.2,
      };
    }
    if (!igniter.carrier && !igniter.planted) {
      // the device is on the ground: go and pick it up
      return { kind: 'move', point: { x: igniter.pos.x, z: igniter.pos.z } };
    }
    const ring = [
      { x: s.x - 10, z: s.z + 10 }, { x: s.x + 10, z: s.z + 10 },
      { x: s.x, z: s.z + 16 }, { x: s.x - 14, z: s.z - 2 },
    ];
    return { kind: 'move', point: ring[bot.index % ring.length] };
  }
  // tidewatch: split the defence across both sites, leaning to target
  const posts = {
    A: [{ x: -31, z: -8 }, { x: -20, z: -22 }, { x: -38, z: -30 }],
    B: [{ x: 31, z: -6 }, { x: 21, z: -20 }, { x: 40, z: -31 }],
  };
  const lean = match.targetSite === 'A'
    ? ['A', 'A', 'B', 'A', 'B'] : ['B', 'B', 'A', 'B', 'A'];
  const siteKey = lean[bot.index % lean.length];
  const post = posts[siteKey][bot.index % posts[siteKey].length];
  return { kind: 'hold', point: post, face: Math.PI };
}

// ------------------------------------------------------------------ channels

function startChannel(actor, kind, seconds) {
  const ch = { actor, kind, endsAt: match.now + seconds, total: seconds };
  igniter.channel = ch;
  actor.channel = ch;
  return true;
}

function tryPlant(bot) {
  if (match.phase !== 'live' || !bot.hasIgniter) return false;
  if (igniter.channel) return igniter.channel.actor === bot;
  const s = siteOf(match.targetSite);
  if (Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z) > s.r) return false;
  sfx.plantBeep();
  return startChannel(bot, 'plant', ROUND.plantSeconds);
}

function tryDefuse(bot) {
  if (match.phase !== 'planted') return false;
  if (igniter.channel) return igniter.channel.actor === bot;
  if (Math.hypot(bot.pos.x - igniter.pos.x, bot.pos.z - igniter.pos.z) > 2.6) return false;
  return startChannel(bot, 'defuse', ROUND.defuseSeconds);
}

function plantAt(siteKey, planter) {
  const s = siteOf(siteKey);
  igniter.planted = true;
  igniter.site = siteKey;
  igniter.pos.set(planter.pos.x, 0, planter.pos.z);
  igniter.mesh.position.set(planter.pos.x, 0, planter.pos.z);
  igniter.mesh.visible = true;
  igniter.detonateAt = match.now + ROUND.detonateSeconds;
  planter.hasIgniter = false;
  igniter.carrier = null;
  setPhase('planted', ROUND.detonateSeconds);
  sfx.planted();
  hud.banner('IGNITER PLANTED', `Site ${siteKey} — ${s.label.toLowerCase()}`, 'bad');
  hud.objective(`Igniter planted at ${siteKey} — hold the site`);
}

function stepChannel() {
  const ch = igniter.channel;
  if (!ch) return;
  if (!ch.actor.alive) { igniter.channel = null; return; }
  if (ch.actor.isPlayer) {
    hud.interact(ch.kind === 'plant' ? 'PLANTING' : 'DEFUSING', 1 - (ch.endsAt - match.now) / ch.total);
  }
  if (match.now < ch.endsAt) return;
  const actor = ch.actor;
  actor.channel = null;
  igniter.channel = null;
  if (ch.kind === 'plant') plantAt(match.targetSite, actor);
  else {
    sfx.defused();
    endRound('tidewatch', 'Igniter defused');
  }
}

// ------------------------------------------------------------------ player gunplay

const rayDir = new THREE.Vector3();
const tmpV = new THREE.Vector3();

function rayHitsWall(origin, dir, maxT) {
  // colliders are XZ boxes; a shot is stopped when it crosses one
  // below eave height (3.2 m covers every crate, container and tank
  // shoulder in the yard)
  let best = maxT;
  for (const c of world.colliders) {
    let t0 = 0, t1 = best;
    if (Math.abs(dir.x) < 1e-9) {
      if (origin.x < c.x0 || origin.x > c.x1) continue;
    } else {
      let ta = (c.x0 - origin.x) / dir.x, tb = (c.x1 - origin.x) / dir.x;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    if (Math.abs(dir.z) < 1e-9) {
      if (origin.z < c.z0 || origin.z > c.z1) continue;
    } else {
      let ta = (c.z0 - origin.z) / dir.z, tb = (c.z1 - origin.z) / dir.z;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    const y = origin.y + dir.y * t0;
    if (t0 > 0.05 && y < 3.2) best = t0;
  }
  return best;
}

function raySphere(origin, dir, centre, r) {
  tmpV.copy(centre).sub(origin);
  const tca = tmpV.dot(dir);
  if (tca < 0) return -1;
  const d2 = tmpV.lengthSq() - tca * tca;
  if (d2 > r * r) return -1;
  return tca - Math.sqrt(r * r - d2);
}

function playerShoot() {
  const w = WEAPONS[me.weaponId];
  me.mag -= 1;
  me.bloom = Math.min(w.spreadMax, me.bloom + w.bloomPerShot);
  me.nextShotAt = match.now + 60 / w.rpm;
  recoil = Math.min(1, recoil + 0.55);
  if (muzzle) { muzzle.visible = true; muzzleOffAt = match.now + 0.045; }
  sfx.shot(w.kind);
  for (const f of fighters) {
    if (f.alive && !f.isPlayer && f.team !== me.team) f.hear(me.pos.x, me.pos.z, match.now);
  }

  camera.getWorldDirection(rayDir);
  const spread = w.spreadBase + me.bloom + player.speed2d * 0.004 + (player.crouched ? -0.002 : 0);
  rayDir.x += (Math.random() - 0.5) * 2 * spread;
  rayDir.y += (Math.random() - 0.5) * 2 * spread;
  rayDir.z += (Math.random() - 0.5) * 2 * spread;
  rayDir.normalize();

  const origin = player.eye();
  const wallT = rayHitsWall(origin, rayDir, 160);
  let bestT = wallT, bestBot = null, bestHead = false;
  for (const b of bots) {
    if (!b.alive || b.team === me.team) continue;
    const zones = [
      { c: new THREE.Vector3(b.pos.x, 1.52, b.pos.z), r: 0.27, head: true },
      { c: new THREE.Vector3(b.pos.x, 1.02, b.pos.z), r: 0.52, head: false },
      { c: new THREE.Vector3(b.pos.x, 0.42, b.pos.z), r: 0.46, head: false },
    ];
    for (const z of zones) {
      const t = raySphere(origin, rayDir, z.c, z.r);
      if (t > 0 && t < bestT) { bestT = t; bestBot = b; bestHead = z.head; }
    }
  }

  const hitPoint = origin.clone().addScaledVector(rayDir, bestT);
  tracer(origin.clone().addScaledVector(rayDir, 0.4), hitPoint);
  if (bestBot) {
    let dmg = w.damage * (bestHead ? w.headMult : 1);
    if (bestT > w.range) dmg *= w.falloff;
    burst(hitPoint, 6, 0xff9a5c);
    hurt(bestBot, dmg, me, bestHead);
  } else if (wallT < 160) {
    burst(hitPoint, 5, 0xcfd6dd);
  }
}

function startReload() {
  const w = WEAPONS[me.weaponId];
  if (me.reloadEndsAt > match.now || me.mag >= w.mag || me.reserve <= 0) return;
  me.reloadEndsAt = match.now + w.reloadMs / 1000;
  sfx.reload();
}

function finishReload() {
  const w = WEAPONS[me.weaponId];
  const take = Math.min(w.mag - me.mag, me.reserve);
  me.mag += take;
  me.reserve -= take;
  me.reloadEndsAt = 0;
}

// ------------------------------------------------------------------ grenade

const grenades = [];   // {mesh, vel, popAt}

function throwGrenade() {
  if (me.grenades <= 0 || !me.alive) return;
  me.grenades -= 1;
  sfx.throwPin();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), mats.steelDark);
  const from = player.eye();
  mesh.position.copy(from);
  scene.add(mesh);
  camera.getWorldDirection(rayDir);
  const vel = rayDir.clone().multiplyScalar(13);
  vel.y += 3.2;
  grenades.push({ mesh, vel, popAt: match.now + GRENADE.fuseSeconds });
}

function stepGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    if (match.now >= g.popAt) {
      popGrenade(g.mesh.position);
      scene.remove(g.mesh);
      grenades.splice(i, 1);
      continue;
    }
    g.vel.y -= 12.5 * dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    if (g.mesh.position.y < 0.12) {
      g.mesh.position.y = 0.12;
      g.vel.y *= -0.35;
      g.vel.x *= 0.7; g.vel.z *= 0.7;
    }
  }
}

function popGrenade(at) {
  sfx.flash();
  burst(at, 14, 0xfff3c4);
  for (const b of bots) {
    if (!b.alive) continue;
    const d = Math.hypot(b.pos.x - at.x, b.pos.z - at.z);
    if (d < GRENADE.hurtRadius) hurt(b, GRENADE.hurtDamage, me, false);
    if (d < GRENADE.blindRadius && lineClear(at.x, at.z, b.pos.x, b.pos.z, world.colliders)) {
      b.blindUntil = match.now + GRENADE.blindSeconds;
      b.target = null;
    }
  }
  const dp = Math.hypot(me.pos.x - at.x, me.pos.z - at.z);
  if (dp < GRENADE.blindRadius && lineClear(at.x, at.z, me.pos.x, me.pos.z, world.colliders)) {
    hud.flashWhite();
  }
}

// ------------------------------------------------------------------ rounds

function setPhase(name, seconds) {
  match.phase = name;
  match.phaseEndsAt = match.now + seconds;
}

function aliveCount(team) {
  return fighters.filter((f) => f.alive && f.team === team).length;
}

function botBuy(bot) {
  if (bot.money >= 2700 && bot.index % 2 === 0) {
    bot.weaponId = 'harrier';
    bot.money -= WEAPONS.harrier.price;
  } else if (bot.money >= 3200) {
    bot.weaponId = 'albatross';
    bot.money -= WEAPONS.albatross.price;
  } else if (bot.money >= 1500) {
    bot.weaponId = 'hornet';
    bot.money -= WEAPONS.hornet.price;
  }
  if (bot.money >= 650 && bot.armor < 50) {
    bot.armor = 100;
    bot.money -= 650;
  }
}

function startRound() {
  match.round += 1;
  match.targetSite = match.round % 2 === 1 ? 'A' : 'B';
  igniter.planted = false;
  igniter.site = null;
  igniter.channel = null;
  igniter.mesh.visible = false;

  for (const f of fighters) {
    f.hp = 100;
    f.alive = true;
    f.channel = null;
    if (!f.isPlayer) f.armor = 0;
  }
  player.spawnAt(SPAWNS.cinder[0].x, SPAWNS.cinder[0].z, SPAWNS.cinder[0].yaw);
  bots.forEach((b, i) => {
    if (b.team === 'cinder') {
      const s = SPAWNS.cinder[i + 1];
      b.spawnAt(s.x, s.z, s.yaw);
    } else {
      const s = SPAWNS.tidewatch[i - 4];
      b.spawnAt(s.x, s.z, s.yaw);
    }
  });
  for (const b of bots) botBuy(b);

  me.mag = WEAPONS[me.weaponId].mag;
  me.reserve = WEAPONS[me.weaponId].reserve;
  me.reloadEndsAt = 0;
  me.bloom = 0;

  // the Igniter starts with a random attacker
  const pool = cinders.filter((f) => f.alive);
  const carrier = pool[Math.floor(Math.random() * pool.length)];
  carrier.hasIgniter = true;
  igniter.carrier = carrier;

  hud.scores(match.score.cinder, match.score.tidewatch);
  hud.objective('Plant the Igniter at A or B');
  hud.banner(`ROUND ${match.round}`, carrier.isPlayer ? 'You carry the Igniter' : `${carrier.name} carries the Igniter`, '');
  setPhase('buy', ROUND.buySeconds);
}

function endRound(winner, reason) {
  if (match.phase === 'over' || match.phase === 'matchover') return;
  match.score[winner] += 1;
  for (const f of fighters) {
    f.money = Math.min(16000, f.money + (f.team === winner ? ROUND.winPay : ROUND.lossPay));
    if (igniter.planted && f.team === 'cinder') f.money = Math.min(16000, f.money + 300);
    if (f.channel) f.channel = null;
  }
  igniter.channel = null;
  hud.scores(match.score.cinder, match.score.tidewatch);
  const mine = winner === 'cinder';
  if (match.score[winner] >= ROUND.roundsToWin) {
    hud.banner(mine ? 'MATCH WON' : 'MATCH LOST', `${reason} — final ${match.score.cinder} · ${match.score.tidewatch}`, mine ? 'good' : 'bad', 6);
    if (mine) sfx.roundWin(); else sfx.roundLose();
    setPhase('matchover', ROUND.matchOverSeconds);
  } else {
    hud.banner(mine ? 'ROUND WON' : 'ROUND LOST', reason, mine ? 'good' : 'bad');
    if (mine) sfx.roundWin(); else sfx.roundLose();
    setPhase('over', ROUND.overSeconds);
  }
}

function resetMatch() {
  match.score.cinder = 0;
  match.score.tidewatch = 0;
  match.round = 0;
  for (const f of fighters) {
    f.money = ROUND.startMoney;
    f.kills = 0;
    f.deaths = 0;
    f.armor = 0;
    f.weaponId = 'v9';
    if (f.isPlayer) { f.primary = null; f.grenades = 0; }
  }
  fitViewmodel();
}

function startMatch() {
  resetMatch();
  startRound();
}

function stepMatch() {
  if (match.now < match.phaseEndsAt) {
    if (match.phase === 'planted' && igniter.channel === null) {
      // beep the countdown through the objective line
      hud.objective(`Igniter detonates in ${Math.max(0, Math.ceil(igniter.detonateAt - match.now))}s — ${igniter.site} site`);
    }
    return;
  }
  if (match.phase === 'buy') {
    setPhase('live', ROUND.liveSeconds);
    hud.banner('ROUND LIVE', `Target site ${match.targetSite}`, '', 1.4);
    hud.objective('Plant the Igniter at A or B');
  } else if (match.phase === 'live') {
    endRound('tidewatch', 'Time expired — site held');
  } else if (match.phase === 'planted') {
    sfx.explosion();
    burst(igniter.pos.clone().setY(1.2), 26, 0xff8a3c);
    endRound('cinder', 'Igniter detonated');
  } else if (match.phase === 'over') {
    startRound();
  } else if (match.phase === 'matchover') {
    startMatch();
  }
}

// ------------------------------------------------------------------ buy

function buyItemsForPlayer() {
  return BUY_MENU.map((entry) => {
    const price = entry.weapon ? WEAPONS[entry.weapon].price : entry.price;
    let owned = false;
    if (entry.slot === 'primary') owned = me.primary === entry.weapon;
    if (entry.slot === 'armor') owned = me.armor > 0;
    if (entry.slot === 'grenade') owned = me.grenades >= GRENADE.maxCarry;
    return { key: entry.key.replace('Digit', ''), label: entry.label, desc: entry.desc, price, owned, entry };
  });
}

function playerBuy(entry) {
  const price = entry.weapon ? WEAPONS[entry.weapon].price : entry.price;
  if (me.money < price) { sfx.denied(); return; }
  if (entry.slot === 'primary') {
    if (me.primary === entry.weapon) { sfx.denied(); return; }
    me.primary = entry.weapon;
    me.money -= price;
    equip(entry.weapon);
  } else if (entry.slot === 'armor') {
    if (me.armor > 0) { sfx.denied(); return; }
    me.armor = 100;
    me.money -= price;
  } else if (entry.slot === 'grenade') {
    if (me.grenades >= GRENADE.maxCarry) { sfx.denied(); return; }
    me.grenades += 1;
    me.money -= price;
  } else {
    return;
  }
  sfx.buy();
}

const ammoStore = {};
function equip(id) {
  ammoStore[me.weaponId] = { mag: me.mag, reserve: me.reserve };
  me.weaponId = id;
  const saved = ammoStore[id];
  me.mag = saved ? saved.mag : WEAPONS[id].mag;
  me.reserve = saved ? saved.reserve : WEAPONS[id].reserve;
  me.reloadEndsAt = 0;
  me.bloom = 0;
  fitViewmodel();
}

// ------------------------------------------------------------------ per-frame steps

let muzzleOffAt = 0;
let interactShown = false;

function stepPlayer(dt) {
  const inPlay = match.phase === 'buy' || match.phase === 'live' || match.phase === 'planted';
  const frozen = !inPlay || !me.alive;
  player.update(dt, input, { dx: input.mouseDX, dy: input.mouseDY }, frozen);
  if (player.footstep) {
    player.footstep = false;
    if (inPlay && me.alive) sfx.step();
  }
  if (!inPlay || !me.alive) return;

  const w = WEAPONS[me.weaponId];
  me.bloom = Math.max(0, me.bloom - w.settlePerSec * dt);
  if (me.reloadEndsAt && match.now >= me.reloadEndsAt) finishReload();

  if (match.phase === 'buy') return; // purchases are event-driven, below

  // live fire controls
  if (input.pressed.has('Digit1') && me.weaponId !== 'v9') equip('v9');
  if (input.pressed.has('Digit2') && me.primary && me.weaponId !== me.primary) equip(me.primary);
  if (input.pressed.has('KeyR')) startReload();
  if (input.pressed.has('KeyG')) throwGrenade();

  if (input.firing && match.now >= me.nextShotAt && !me.reloadEndsAt) {
    if (me.mag > 0) {
      if (w.auto || !autoLatch) playerShoot();
      autoLatch = true;
    } else {
      startReload();
      autoLatch = true;
    }
  }
  if (!input.firing) autoLatch = false;

  // planting by hand: hold E on the site while carrying
  let showing = false;
  if (me.hasIgniter && match.phase === 'live' && !igniter.channel) {
    const s = siteOf(match.targetSite);
    if (Math.hypot(me.pos.x - s.x, me.pos.z - s.z) < s.r) {
      if (input.down('KeyE')) {
        startChannel(me, 'plant', ROUND.plantSeconds);
      } else {
        hud.interact('HOLD E — PLANT THE IGNITER', 0);
        showing = true;
      }
    }
  }
  if (!showing && interactShown && !igniter.channel) hud.interact('', 0);
  interactShown = showing || !!igniter.channel;
}

let autoLatch = false;

// Purchases happen on the keydown event itself, not in the frame
// loop: a buy key is a discrete action, and on a slow machine a frame
// can land a second after the keypress — the shop must not feel laggy.
window.addEventListener('keydown', (e) => {
  if (STAGED || match.phase !== 'buy' || !me.alive) return;
  const entry = BUY_MENU.find((en) => en.key === e.code);
  if (entry) playerBuy(entry);
});

function stepBots(dt) {
  for (const b of bots) {
    if (!b.alive) continue;
    const ctx = botCtx(b);
    ctx.dt = dt;
    b.update(dt, ctx);
  }
  // Igniter pickup: any living attacker who walks over the device
  if (!igniter.carrier && !igniter.planted && match.phase === 'live') {
    for (const f of cinders) {
      if (f.alive && Math.hypot(f.pos.x - igniter.pos.x, f.pos.z - igniter.pos.z) < 1.4) {
        f.hasIgniter = true;
        igniter.carrier = f;
        igniter.mesh.visible = false;
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ hud

function boardRows(team) {
  return fighters
    .filter((f) => f.team === team)
    .map((f) => ({ name: f.name, k: f.kills, d: f.deaths, money: f.money, alive: f.alive, me: !!f.isPlayer }));
}

function stepHud() {
  if (match.phase === 'title') return;
  hud.vitals(Math.max(0, Math.round(me.hp)), Math.round(me.armor), aliveCount('cinder'), aliveCount('tidewatch'));
  const w = WEAPONS[me.weaponId];
  hud.gun(w.name, me.mag, me.reserve, me.money, me.reloadEndsAt > match.now, me.grenades, player.crouched);
  const left = Math.max(0, match.phaseEndsAt - match.now);
  const labels = { buy: 'Buy phase', live: 'Round live', planted: 'IGNITER PLANTED', over: 'Round over', matchover: 'Match over' };
  hud.clock(fmtClock(left), labels[match.phase] || '', match.phase === 'planted' || left <= 10);
  if (match.phase === 'buy') {
    hud.toggleBuy(true);
    refreshBuyMenu(left);
  } else {
    hud.toggleBuy(false);
    buySignature = '';
  }
  updateBoard();
}

// The scoreboard and buy menu rebuild DOM when they render, so they
// are only re-rendered when what they show has actually changed —
// rebuilding them every frame starves the renderer on slow machines.
let boardOpen = false;
let boardRefreshAt = 0;
function updateBoard() {
  const tab = input.down('Tab');
  if (tab !== boardOpen || (tab && match.now >= boardRefreshAt)) {
    hud.board(boardRows('cinder'), boardRows('tidewatch'), tab);
    boardOpen = tab;
    boardRefreshAt = match.now + 0.5;
  }
}

let buySignature = '';
function refreshBuyMenu(left) {
  const items = buyItemsForPlayer();
  const sig = items.map((i) => (i.owned ? '1' : '0')).join('') + '|' + me.money + '|' + Math.ceil(left);
  if (sig === buySignature) return;
  buySignature = sig;
  hud.buyMenu(items, me.money, fmtClock(left));
}

// ------------------------------------------------------------------ staging

function stageShot() {
  input.disabled = true;
  hud.showGame();
  startMatch();
  if (SHOT === 'start') {
    // buy phase, menu open, camera on the spawn row — the loop leaves
    // the world frozen in this mode
  } else if (SHOT === 'play') {
    setPhase('live', 83);
    player.spawnAt(-6, 10, 0);
    me.primary = 'harrier';
    equip('harrier');
    const t0 = bots[4], t1 = bots[5], mate = bots[0];
    t0.spawnAt(-2, -2, Math.PI); t0.hp = 45;
    t1.spawnAt(15, -7, Math.PI);
    mate.spawnAt(8, 4, 0);
    for (const b of bots) b.syncMesh(0);
  } else if (SHOT === 'end') {
    match.score.cinder = 5;
    match.score.tidewatch = 3;
    hud.scores(5, 3);
    player.spawnAt(4, 6, 0);
    me.hp = 72;
    me.armor = 40;
    bots[4].spawnAt(-3, -6, Math.PI); bots[4].die();
    bots[5].spawnAt(12, -9, Math.PI); bots[5].die();
    bots[6].spawnAt(18, 2, Math.PI);
    for (const b of bots) b.syncMesh(0);
    setPhase('over', 5);
    hud.banner('CINDERS TAKE THE ROUND', 'Cinders 5 · Tidewatch 3 — match point', 'good', 999);
  }
}

// ------------------------------------------------------------------ boot + loop

window.__errors = [];
window.addEventListener('error', (e) => { window.__errors.push(String(e.message || e.type)); });

window.__game = {
  match, me, bots,
  phase: () => match.phase,
  alive: () => fighters.filter((f) => f.alive).length,
  yaw: () => player.yaw,
  pitch: () => player.pitch,
  locked: () => input.locked,
  keys: () => [...input.keys],
};

let aiming = false;
window.addEventListener('mousedown', (e) => { if (e.button === 2) aiming = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 2) aiming = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function tryLock() {
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  } catch { /* headless or denied: keys still work */ }
}
renderer.domElement.addEventListener('click', () => {
  if (match.phase !== 'title' && !input.locked && !STAGED) tryLock();
});
document.getElementById('playBtn').addEventListener('click', () => {
  sfx.ensure();
  hud.showGame();
  startMatch();
  tryLock();
});

if (STAGED) stageShot();

let lastT = performance.now();
let frames = 0;

function loop() {
  requestAnimationFrame(loop);
  const t = performance.now();
  const dt = Math.min(0.1, Math.max(0.0005, (t - lastT) / 1000));
  lastT = t;
  match.now += dt;

  if (!STAGED) {
    if (match.phase !== 'title') {
      stepMatch();
      stepPlayer(dt);
      if (match.phase === 'live' || match.phase === 'planted' || match.phase === 'buy') stepBots(dt);
      stepChannel();
      stepGrenades(dt);
    }
  } else if (SHOT === 'play' && frames % 6 === 0) {
    burst(new THREE.Vector3(-2, 1.25, -2), 3, 0xffc46b);
  }
  stepFx(dt);

  // viewmodel life: recoil spring and a gentle bob while moving
  recoil = Math.max(0, recoil - dt * 5.5);
  if (viewmodel) {
    const bob = Math.sin(match.now * 9) * 0.008 * Math.min(1, player.speed2d / 4);
    viewmodel.position.set(0.24, -0.22 + bob - recoil * 0.03, -0.45 + recoil * 0.09);
    if (muzzle && !STAGED) muzzle.visible = match.now < muzzleOffAt;
  }

  // zoom: right mouse eases the fov toward the weapon's optic
  const targetFov = aiming && me.alive && match.phase !== 'title' ? 74 / WEAPONS[me.weaponId].zoom : 74;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 11);
    camera.updateProjectionMatrix();
  }

  if (match.phase === 'title') {
    const a = t * 0.00004;
    camera.position.set(Math.sin(a) * 34, 13, Math.cos(a) * 34 - 6);
    camera.lookAt(0, 1, -8);
    if (viewmodel) viewmodel.visible = false;
  } else {
    if (viewmodel) viewmodel.visible = me.alive;
    player.applyCamera(camera);
  }

  stepHud();
  renderer.render(scene, camera);
  frames += 1;
  if (frames === 30) window.__shotReady = true;
  input.consume();
}
loop();
