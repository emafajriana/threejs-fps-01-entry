// main.js — Ember Quay's match brain, second authoring.
//
// This file is the orchestrator. The world module builds the harbour
// and answers geometry questions; the Bot class owns each bot's body,
// senses and burst discipline; the Player class owns the local body;
// the Hud owns every DOM readout. What lives here is everything those
// pieces deliberately do not know about: the round state machine, the
// money, hit resolution, the Igniter plant and defuse channels,
// grenades, the buy phase, and the staging hooks the screenshot
// pipeline drives.
//
// A match is a sequence of rounds. Each round opens with a 12-second
// buy phase, runs live for up to 105 seconds, and can stretch into a
// 40-second planted phase once the Igniter is down. Elimination, the
// clock, a detonation or a defuse ends it. First team to 6 rounds.

import * as THREE from 'three';
import { buildWorld, SITES, SPAWNS, lineClear } from './world.js';
import { COLORS } from './palette.js';
import { WEAPONS, GRENADE, BUY_MENU, buildViewmodel, buildMuzzleFlash } from './weapons.js';
import { Bot } from './bots.js';
import { Player } from './player.js';
import { Hud, fmtClock } from './hud.js';
import { Sfx } from './audio.js';
import { Input } from './input.js';

// ?shot=start|play|end freezes staged scenes for the screenshots.
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const STAGED = SHOT !== null && SHOT !== '';

// ------------------------------------------------------------- tuning

const BUY_SECONDS = 12;
const LIVE_SECONDS = 105;
const FUSE_SECONDS = 40;
const OVER_SECONDS = 5;
const WIN_SCORE = 6;
const PLANT_SECONDS = 3.2;
const DEFUSE_SECONDS = 5;
const SITE_REACH = 4.2;   // how close a channel must be to the pad centre
const KILL_PAY = 300;
const WIN_PAY = 2700;
const LOSS_PAY = 1400;

// ------------------------------------------------------------- renderer

// index.html gives the game an empty #app mount and no canvas of its
// own: the renderer creates the canvas and this file wires it up.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
const canvas = renderer.domElement;
document.getElementById('app').appendChild(canvas);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.sky);
scene.fog = new THREE.Fog(COLORS.sky, 55, 130);
const camera = new THREE.PerspectiveCamera(74, 1, 0.05, 300);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0x93a7c4, 0x14161a, 1.1));
const moon = new THREE.DirectionalLight(0xbdd0ee, 0.9);
moon.position.set(30, 60, -20);
scene.add(moon);

function fitRenderer() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fitRenderer);
fitRenderer();

// ------------------------------------------------------------- pieces

const world = buildWorld(scene);
const input = new Input(canvas);
const hud = new Hud();
const sfx = new Sfx();
const player = new Player(world.colliders);

// The player-facing record. pos is the Player's own vector, so anything
// reading me.pos sees live movement; the rest is match state this file
// maintains (the Player class knows nothing about money or rounds).
const me = {
  team: 'cinder', name: 'You', isPlayer: true,
  pos: player.pos, hp: 100, armor: 0, money: 800, alive: true,
  weaponId: 'v9', owned: new Set(['v9']), grenades: 0,
  kills: 0, deaths: 0, hasIgniter: true,
  ammo: WEAPONS.v9.mag, reserve: WEAPONS.v9.reserve,
  reloadingUntil: 0, nextShotAt: 0, channelT: 0,
};

// Nine bots: four Cinders beside the player, five Tidewatch defenders.
// A Bot is its own record — hp, money, weaponId and the rest live on
// the instance next to its mesh and state machine.
const bots = [];
for (let i = 0; i < 4; i++) bots.push(new Bot('cinder', i + 1, scene));
for (let i = 0; i < 5; i++) bots.push(new Bot('tidewatch', i, scene));
const cinders = bots.filter(b => b.team === 'cinder');
const tidewatch = bots.filter(b => b.team === 'tidewatch');

// The viewmodel: the gun group from weapons.js, plus its muzzle flash
// parked at the barrel tip. The group arrives already offset into the
// lower-right of the frame; the frame loop only adds bob and recoil
// deltas on top of that base position, never replaces it.
let viewmodel = null;
let flash = null;
const VM_BASE = new THREE.Vector3(0.24, -0.17, -0.45);
function fitViewmodel() {
  if (viewmodel) camera.remove(viewmodel);
  viewmodel = buildViewmodel(me.weaponId, COLORS.cinder);
  flash = buildMuzzleFlash();
  flash.position.set(0, 0.02, -0.66);
  viewmodel.add(flash);
  viewmodel.position.copy(VM_BASE);
  camera.add(viewmodel);
}
fitViewmodel();

// ------------------------------------------------------------- match state

const match = {
  phase: 'buy', now: 0, phaseEndsAt: BUY_SECONDS,
  round: 1, score: { cinder: 0, tidewatch: 0 },
  plant: null, started: false,
};

function setPhase(name, seconds) {
  match.phase = name;
  match.phaseEndsAt = match.now + seconds;
}

function teamAlive(team) {
  let n = team === me.team && me.alive ? 1 : 0;
  for (const b of bots) if (b.team === team && b.alive) n++;
  return n;
}

function foesOf(team) {
  const out = [];
  if (me.team !== team && me.alive) out.push(me);
  for (const b of bots) if (b.team !== team && b.alive) out.push(b);
  return out;
}

// ------------------------------------------------------------- damage

function hurt(victim, amount, attacker) {
  if (!victim.alive) return;
  let rest = amount;
  if (victim.armor > 0) {
    const soaked = Math.min(victim.armor, Math.round(amount * 0.55));
    victim.armor -= soaked;
    rest = amount - soaked;
  }
  victim.hp -= rest;
  if (victim === me && rest > 0) { hud.damageFlash(); sfx.hurt(); }
  if (victim.hp > 0) return;
  victim.hp = 0;
  if (attacker) {
    attacker.kills++;
    attacker.money += KILL_PAY;
    if (attacker === me) { hud.hitmark(true); sfx.kill(); }
    hud.feed(`<b>${attacker.name}</b> dropped <b>${victim.name}</b>`);
  }
  if (victim === me) {
    me.alive = false;
    me.deaths++;
    if (viewmodel) viewmodel.visible = false;
    hud.banner('YOU ARE DOWN', 'Spectating — your Cinders fight on');
    // the Igniter drops where the carrier fell: the nearest living
    // Cinder picks it up and the attack still has a planter
    if (me.hasIgniter) {
      me.hasIgniter = false;
      let best = null, bestD = Infinity;
      for (const b of bots) {
        if (b.team !== 'cinder' || !b.alive) continue;
        const d = b.pos.distanceTo(me.pos);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best) best.hasIgniter = true;
    }
  } else {
    victim.die();
  }
}

// Distance falloff shared by both directions of fire: full damage
// inside the weapon's range, then a slide toward its falloff floor.
function falloff(weapon, dist) {
  if (dist <= weapon.range) return 1;
  const over = Math.min(1, (dist - weapon.range) / 30);
  return 1 - over * (1 - weapon.falloff);
}

// A bot's trigger pull, resolved here so all damage flows through one
// door. The Bot class decided the burst and the target; this decides
// whether the rounds connect — a probability shaped by the weapon,
// the range, and whether the target is standing still in the open.
function botShoot(bot, target) {
  const weapon = WEAPONS[bot.weaponId];
  const dist = Math.hypot(bot.pos.x - target.pos.x, bot.pos.z - target.pos.z);
  let chance = 0.6 - dist * 0.007;
  if (target === me && player.speed2d > 2) chance -= 0.09;
  if (target !== me && target.target && target.target !== bot) chance -= 0.03;
  chance = Math.max(0.05, Math.min(0.62, chance));
  sfx.distantShot();
  for (const b of bots) {
    if (b.alive && b.team !== bot.team && b.pos.distanceTo(bot.pos) < 34) b.hear(bot.pos.x, bot.pos.z, match.now);
  }
  if (Math.random() >= chance) return;
  const head = Math.random() < 0.13;
  const dmg = Math.round(weapon.damage * (head ? weapon.headMult : 1) * falloff(weapon, dist));
  hurt(target, dmg, bot);
  if (target === me) hud.hitmark(false);
}

// ------------------------------------------------------------- player fire

const raycaster = new THREE.Raycaster();
const hitBox = new THREE.Box3();
const hitPoint = new THREE.Vector3();
let recoil = 0;
let bloom = 0;

function playerShoot() {
  const weapon = WEAPONS[me.weaponId];
  if (match.now < me.nextShotAt || match.now < me.reloadingUntil) return;
  if (me.ammo <= 0) { sfx.dryFire(); me.nextShotAt = match.now + 0.3; return; }
  me.nextShotAt = match.now + 60 / weapon.rpm;
  me.ammo--;
  recoil = Math.min(1, recoil + 0.4);
  bloom = Math.min(weapon.spreadMax, bloom + weapon.bloomPerShot);
  sfx.shot(weapon.kind);
  for (const b of bots) {
    if (b.alive && b.team !== me.team && b.pos.distanceTo(me.pos) < 34) b.hear(me.pos.x, me.pos.z, match.now);
  }
  // direction from the camera, jittered by the current spread
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.x += (Math.random() - 0.5) * 2 * (weapon.spreadBase + bloom);
  dir.y += (Math.random() - 0.5) * 2 * (weapon.spreadBase + bloom);
  dir.normalize();
  raycaster.set(player.eye(), dir);
  raycaster.far = 160;
  // cover caps the range first
  let range = 160;
  for (const c of world.colliders) {
    hitBox.min.set(c.x0, 0, c.z0);
    hitBox.max.set(c.x1, 6, c.z1);
    const p = raycaster.ray.intersectBox(hitBox, hitPoint);
    if (p) range = Math.min(range, player.eye().distanceTo(p));
  }
  // then the closest bot body inside that range takes the hit
  let victim = null;
  let victimPoint = null;
  for (const b of bots) {
    if (!b.alive || b.team === me.team) continue;
    hitBox.min.set(b.pos.x - 0.45, 0, b.pos.z - 0.45);
    hitBox.max.set(b.pos.x + 0.45, 1.8, b.pos.z + 0.45);
    const p = raycaster.ray.intersectBox(hitBox, hitPoint);
    if (!p) continue;
    const d = player.eye().distanceTo(p);
    if (d < range) { range = d; victim = b; victimPoint = p.clone(); }
  }
  if (flash) { flash.visible = true; flashOffAt = match.now + 0.045; }
  if (victim) {
    const head = victimPoint.y > 1.42;
    const dmg = Math.round(weapon.damage * (head ? weapon.headMult : 1) * falloff(weapon, range));
    hurt(victim, dmg, me);
    if (victim.alive) hud.hitmark(false);
    sfx.hit();
  }
}
let flashOffAt = 0;

function startReload() {
  const weapon = WEAPONS[me.weaponId];
  if (me.ammo >= weapon.mag || me.reserve <= 0 || match.now < me.reloadingUntil) return;
  me.reloadingUntil = match.now + weapon.reloadMs / 1000;
  sfx.reload();
}

function finishReload() {
  const weapon = WEAPONS[me.weaponId];
  const take = Math.min(weapon.mag - me.ammo, me.reserve);
  me.ammo += take;
  me.reserve -= take;
}

// The Sunburst: thrown on G, pops a moment later where it lands. Bots
// it can see (clear line from the pop) lose their eyes for a while;
// anyone close enough to touch it takes a little hurt instead.
const pendingPops = [];
function throwGrenade() {
  if (me.grenades <= 0 || !me.alive) return;
  me.grenades--;
  sfx.throwPin();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const at = player.eye().add(dir.multiplyScalar(8));
  pendingPops.push({ x: at.x, z: at.z, at: match.now + GRENADE.fuseSeconds });
}

function popGrenade(pop) {
  sfx.flash();
  sfx.explosion();
  for (const b of bots) {
    if (!b.alive || b.team === me.team) continue;
    const d = Math.hypot(b.pos.x - pop.x, b.pos.z - pop.z);
    if (d < GRENADE.hurtRadius) { hurt(b, GRENADE.hurtDamage, me); continue; }
    if (d < GRENADE.blindRadius && lineClear(pop.x, pop.z, b.pos.x, b.pos.z, world.colliders)) {
      b.blindUntil = match.now + GRENADE.blindSeconds;
      b.target = null;
    }
  }
  const dp = Math.hypot(me.pos.x - pop.x, me.pos.z - pop.z);
  if (dp < GRENADE.blindRadius) hud.flashWhite();
}

// ------------------------------------------------------------- round flow

function equip(weaponId) {
  if (!me.owned.has(weaponId)) return;
  me.weaponId = weaponId;
  const weapon = WEAPONS[weaponId];
  me.ammo = weapon.mag;
  me.reserve = weapon.reserve;
  me.reloadingUntil = 0;
  fitViewmodel();
}

function startRound() {
  match.plant = null;
  // the player resets onto the middle Cinder spawn slot
  me.hp = 100; me.armor = 0; me.alive = true; me.hasIgniter = true;
  me.channelT = 0; me.grenades = 0;
  me.weaponId = me.owned.has('harrier') ? 'harrier' : me.owned.has('hornet') ? 'hornet' : 'v9';
  me.ammo = WEAPONS[me.weaponId].mag;
  me.reserve = WEAPONS[me.weaponId].reserve;
  const slot = SPAWNS.cinder[2];
  player.spawnAt(slot.x, slot.z, slot.yaw);
  // bots reset through their own spawnAt; loadouts and purses persist
  const slots = { cinder: [0, 1, 3, 4], tidewatch: [0, 1, 2, 3, 4] };
  const seen = { cinder: 0, tidewatch: 0 };
  for (const b of bots) {
    const row = SPAWNS[b.team];
    const s = row[slots[b.team][seen[b.team]++]];
    if (!b.alive) b.armor = 0;
    b.spawnAt(s.x, s.z, s.yaw);
    b.hasIgniter = false;
  }
  fitViewmodel();
  if (viewmodel) viewmodel.visible = true;
  pendingPops.length = 0;
  setPhase('buy', BUY_SECONDS);
  hud.banner('ROUND ' + match.round, 'Plant the Igniter at A or B');
  hud.objective('Plant the Igniter at A or B');
}

function endRound(winnerTeam, why) {
  if (match.phase === 'over' || match.phase === 'matchover') return;
  match.score[winnerTeam]++;
  const pay = (rec, amount) => { rec.money += amount; };
  if (winnerTeam === 'cinder') {
    pay(me, WIN_PAY);
    for (const b of bots) pay(b, b.team === 'cinder' ? WIN_PAY : LOSS_PAY);
  } else {
    pay(me, LOSS_PAY);
    for (const b of bots) pay(b, b.team === 'tidewatch' ? WIN_PAY : LOSS_PAY);
  }
  for (const b of bots) b.channel = null;
  const done = match.score[winnerTeam] >= WIN_SCORE;
  setPhase(done ? 'matchover' : 'over', done ? 9999 : OVER_SECONDS);
  const line = (winnerTeam === 'cinder' ? 'CINDERS' : 'TIDEWATCH') + (done ? ' WIN THE MATCH' : ' TAKE THE ROUND');
  const point = !done && match.score[winnerTeam] === WIN_SCORE - 1 ? ' — MATCH POINT' : '';
  hud.banner(line, why + ' — Cinders ' + match.score.cinder + ' · Tidewatch ' + match.score.tidewatch + point, '', 3.4);
  if (winnerTeam === me.team) sfx.roundWin(); else sfx.roundLose();
}

function checkRoundEnd() {
  if (match.phase !== 'live' && match.phase !== 'planted') return;
  const c = teamAlive('cinder'), t = teamAlive('tidewatch');
  if (match.phase === 'planted') {
    if (c === 0) endRound('tidewatch', 'Cinders eliminated');
  } else if (t === 0) {
    endRound('cinder', 'Tidewatch eliminated');
  } else if (c === 0) {
    endRound('tidewatch', 'Cinders eliminated');
  }
}

// ------------------------------------------------------------- bot jobs
//
// jobFor is the Bot class's window into the match plan. Attackers push
// their assigned site — the carrier to the pad itself, the others to
// cover points near it. Defenders hold their site until the plant,
// then converge on the pad to defuse. Which site a bot owns is dealt
// out round by round so attacks do not always land the same way.

const botPlans = new Map();
function assignPlans() {
  botPlans.clear();
  let n = 0;
  for (const b of bots) {
    botPlans.set(b, {
      site: n % 3 === 2 ? 'B' : 'A',
      offX: (n % 5) - 2,
      offZ: ((n * 2) % 5) - 2,
    });
    n++;
  }
}
assignPlans();

function jobFor(bot) {
  const plan = botPlans.get(bot);
  const site = SITES[plan.site];
  if (match.phase === 'planted' && match.plant) {
    const pad = SITES[match.plant.site];
    if (bot.team === 'tidewatch') {
      const d = Math.hypot(bot.pos.x - pad.x, bot.pos.z - pad.z);
      return { kind: 'defuse', point: { x: pad.x, z: pad.z }, atSite: d < SITE_REACH };
    }
    // attackers fall back to a loose ring around their own plant
    return { kind: 'hold', point: { x: pad.x + plan.offX * 3, z: pad.z + plan.offZ * 3 }, atSite: false };
  }
  if (bot.team === 'cinder') {
    if (bot.hasIgniter) {
      const d = Math.hypot(bot.pos.x - site.x, bot.pos.z - site.z);
      return { kind: 'plant', point: { x: site.x, z: site.z }, atSite: d < SITE_REACH };
    }
    return { kind: 'goto', point: { x: site.x + plan.offX * 2.4, z: site.z + plan.offZ * 2.4 }, atSite: false };
  }
  return { kind: 'hold', point: { x: site.x + plan.offX * 2.4, z: site.z + plan.offZ * 2.4 }, atSite: false };
}

// ------------------------------------------------------------- channels
//
// A channel is a promise: the bot stands still (its update returns
// early while channel is set) and this file watches the clock. Death
// cancels automatically — Bot.die clears the channel.

function tryPlant(bot) {
  if (match.phase !== 'live' || !bot.hasIgniter || match.plant) return false;
  bot.channel = { kind: 'plant', until: match.now + PLANT_SECONDS };
  return true;
}

function tryDefuse(bot) {
  if (match.phase !== 'planted' || !match.plant) return false;
  bot.channel = { kind: 'defuse', until: match.now + DEFUSE_SECONDS };
  return true;
}

function completePlant(siteKey, x, z) {
  match.plant = { site: siteKey, x, z, fuse: FUSE_SECONDS };
  setPhase('planted', FUSE_SECONDS);
  hud.banner('IGNITER PLANTED', 'Site ' + siteKey + ' — hold it or lose it');
  hud.objective('Defend the Igniter');
  sfx.planted();
}

function stepChannels() {
  // bot channels first
  for (const b of bots) {
    if (!b.channel) continue;
    if (b.channel.kind === 'defuse') {
      hud.interact(b.name + ' IS DEFUSING', 1 - (b.channel.until - match.now) / DEFUSE_SECONDS);
    }
    if (match.now < b.channel.until) continue;
    const kind = b.channel.kind;
    b.channel = null;
    if (!b.alive) continue;
    if (kind === 'plant') {
      b.hasIgniter = false;
      completePlant(botPlans.get(b).site, b.pos.x, b.pos.z);
    } else if (kind === 'defuse' && match.plant) {
      match.plant = null;
      hud.interact(null);
      endRound('tidewatch', 'Igniter defused');
    }
  }
  // the player's own plant channel: hold E while standing on a pad
  if (match.phase === 'live' && me.hasIgniter && me.alive && input.down('KeyE')) {
    for (const key of ['A', 'B']) {
      const s = SITES[key];
      if (Math.hypot(me.pos.x - s.x, me.pos.z - s.z) < s.r) {
        me.channelT += frameDt;
        hud.interact('PLANTING THE IGNITER', me.channelT / PLANT_SECONDS);
        if (me.channelT >= PLANT_SECONDS) {
          me.channelT = 0;
          me.hasIgniter = false;
          hud.interact(null);
          completePlant(key, s.x, s.z);
        }
        return;
      }
    }
  }
  if (me.channelT > 0 && !input.down('KeyE')) { me.channelT = 0; hud.interact(null); }
}

// ------------------------------------------------------------- buying

function buyItems() {
  return BUY_MENU.map((it) => {
    const price = it.weapon ? WEAPONS[it.weapon].price : it.price;
    let owned = false;
    if (it.slot === 'primary') owned = me.owned.has(it.weapon);
    else if (it.slot === 'armor') owned = me.armor >= 100;
    else if (it.slot === 'grenade') owned = me.grenades >= GRENADE.maxCarry;
    // the HUD badge shows the bare digit ('2'), the purchase lookup
    // keeps the full event code ('Digit2') alongside it
    return { ...it, price, owned, key: it.key.replace('Digit', ''), code: it.key };
  });
}

function tryBuy(item) {
  if (match.phase !== 'buy' || me.money < item.price) { sfx.denied(); return false; }
  if (item.slot === 'primary') {
    if (me.owned.has(item.weapon)) { equip(item.weapon); return true; }
    me.money -= item.price;
    me.owned.add(item.weapon);
    equip(item.weapon);
  } else if (item.slot === 'armor') {
    if (me.armor >= 100) return false;
    me.money -= item.price;
    me.armor = 100;
  } else if (item.slot === 'grenade') {
    if (me.grenades >= GRENADE.maxCarry) return false;
    me.money -= item.price;
    me.grenades++;
  } else {
    return false;
  }
  sfx.buy();
  return true;
}

// Purchases fire on the key event itself, not through the frame loop:
// on a slow machine a tapped key can rise and fall between frames, and
// a buy that silently does not happen reads as a broken game.
addEventListener('keydown', (e) => {
  if (STAGED || match.phase !== 'buy' || !match.started) return;
  const item = buyItems().find(i => i.code === e.code);
  if (item) tryBuy(item);
});

// Bots shop at the end of the buy phase, one simple priority list:
// a rifle if they can, then a vest, then keep the change.
function buyFor(bot) {
  if (bot.money >= WEAPONS.harrier.price && bot.weaponId !== 'harrier') {
    bot.money -= WEAPONS.harrier.price;
    bot.weaponId = 'harrier';
  } else if (bot.money >= WEAPONS.hornet.price && bot.weaponId === 'v9') {
    bot.money -= WEAPONS.hornet.price;
    bot.weaponId = 'hornet';
  }
  if (bot.money >= 650 && bot.armor <= 0) { bot.money -= 650; bot.armor = 100; }
  bot.ammoInMag = WEAPONS[bot.weaponId].mag;
}

// ------------------------------------------------------------- per-frame

let frameDt = 0;

function stepMatch() {
  if (match.phase === 'buy') {
    if (match.now >= match.phaseEndsAt) {
      for (const b of bots) buyFor(b);
      assignPlans();
      setPhase('live', LIVE_SECONDS);
      hud.objective(me.hasIgniter ? 'Plant the Igniter at A or B' : 'Back up the carrier');
    }
    return;
  }
  if (match.phase === 'live') {
    if (match.now >= match.phaseEndsAt) endRound('tidewatch', 'Time — the Igniter never landed');
    return;
  }
  if (match.phase === 'planted' && match.plant) {
    match.plant.fuse -= frameDt;
    if (match.plant.fuse <= 0) {
      match.plant = null;
      endRound('cinder', 'Detonation on the quay');
      sfx.explosion();
    }
    return;
  }
  if (match.phase === 'over' && match.now >= match.phaseEndsAt) {
    match.round++;
    startRound();
  }
}

let wasFiring = false;
function stepPlayer() {
  if (!me.alive) return;
  if (match.now >= me.reloadingUntil && me.reloadingUntil > 0 && WEAPONS[me.weaponId].mag !== me.ammo) {
    // reload completes quietly when its timer lapses
    if (me.ammo < WEAPONS[me.weaponId].mag && me.reserve > 0) finishReload();
    me.reloadingUntil = 0;
  }
  if (input.pressed.has('KeyR')) startReload();
  if (input.pressed.has('KeyG')) throwGrenade();
  if (input.pressed.has('Digit1')) equip('v9');
  if (input.pressed.has('Digit2') && me.owned.has('hornet')) equip('hornet');
  if (input.pressed.has('Digit3') && me.owned.has('harrier')) equip('harrier');
  if (input.pressed.has('Digit4') && me.owned.has('albatross')) equip('albatross');
  const weapon = WEAPONS[me.weaponId];
  if (input.firing && (weapon.auto || !wasFiring)) playerShoot();
  wasFiring = input.firing;
}

// ------------------------------------------------------------- staging
//
// The screenshot pipeline loads the game three times with ?shot= set.
// Each mode poses a scene on top of a real match state — nothing here
// fakes a HUD or a score, it just arranges the pieces and freezes the
// simulation so the frame the camera sees is stable.

function stageShot() {
  match.started = true;
  startRound();
  if (SHOT === 'start') return;
  if (SHOT === 'play') {
    for (const b of bots) buyFor(b);
    me.owned.add('harrier');
    equip('harrier');
    me.money = 800;
    setPhase('live', 83);
    player.spawnAt(-6, 10, 0);
    const spots = [
      { team: 'tidewatch', x: -2, z: -2 }, { team: 'tidewatch', x: 15, z: -7 },
      { team: 'cinder', x: 8, z: 4 }, { team: 'tidewatch', x: -27, z: -17 },
    ];
    let ci = 0, ti = 0;
    for (const b of bots) {
      const s = b.team === 'cinder' ? spots[2 + (ci++ % 1)] : spots[ti++];
      if (!s) continue;
      b.pos.set(s.x, 0, s.z);
      b.yaw = b.team === 'cinder' ? 0.4 : 2.6;
      b.syncMesh(0);
    }
    if (flash) flash.visible = true;
  } else if (SHOT === 'end') {
    match.score.cinder = 5;
    match.score.tidewatch = 3;
    me.hp = 72;
    me.armor = 40;
    let down = 0;
    for (const b of bots) {
      if (b.team === 'tidewatch' && down < 2) { b.die(); down++; }
    }
    setPhase('over', 5);
    hud.banner('CINDERS TAKE THE ROUND', 'Cinders 5 · Tidewatch 3 — MATCH POINT', '', 999);
  }
}

// ------------------------------------------------------------- boot

const titleEl = document.getElementById('title');
document.getElementById('playBtn').addEventListener('click', () => {
  sfx.ensure();
  hud.showGame();
  match.started = true;
  if (!STAGED) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  input.locked = document.pointerLockElement === canvas;
  if (!input.locked && !STAGED && match.started && match.phase !== 'matchover') {
    titleEl.classList.remove('hidden');
  }
});

if (STAGED) { hud.showGame(); stageShot(); window.__shotReady = true; }
else startRound();

// ------------------------------------------------------------- HUD refresh
//
// Text readouts are cheap and update every frame. The two innerHTML
// surfaces — the buy menu and the scoreboard — rebuild only when the
// data behind them actually changes, because on a slow machine a
// per-frame rebuild starves the renderer it shares a thread with.

let buySig = '';
function refreshBuyMenu() {
  const items = buyItems();
  const sig = items.map(i => i.key + i.price + (i.owned ? 1 : 0)).join('|') + '#' + me.money;
  if (sig !== buySig) { buySig = sig; hud.buyMenu(items, me.money, fmtClock(match.phaseEndsAt - match.now)); }
  else hud.el.buyClock.textContent = fmtClock(match.phaseEndsAt - match.now);
}

let boardSig = '';
let boardOpen = false;
function refreshBoard(open) {
  if (!open) {
    if (boardOpen) { hud.board([], [], false); boardOpen = false; boardSig = ''; }
    return;
  }
  boardOpen = true;
  const rows = (list, mine) => list.map(r => ({
    name: r.name, k: r.kills, d: r.deaths, money: r.money, alive: r.alive, me: mine === r,
  }));
  const us = rows([me, ...cinders], me);
  const them = rows(tidewatch, null);
  const sig = JSON.stringify([us, them]);
  if (sig !== boardSig) { boardSig = sig; hud.board(us, them, true); }
}

const PHASE_LABEL = {
  buy: 'BUY PHASE', live: 'ROUND LIVE', planted: 'IGNITER PLANTED',
  over: 'ROUND OVER', matchover: 'MATCH OVER',
};

function refreshHud() {
  const remain = Math.max(0, match.phaseEndsAt - match.now);
  hud.clock(fmtClock(remain), PHASE_LABEL[match.phase], match.phase === 'planted' || (match.phase === 'live' && remain < 10));
  hud.scores(match.score.cinder, match.score.tidewatch);
  hud.vitals(me.hp, me.armor, teamAlive('cinder'), teamAlive('tidewatch'));
  const weapon = WEAPONS[me.weaponId];
  hud.gun(weapon.name, me.ammo, me.reserve, me.money, match.now < me.reloadingUntil, me.grenades, player.crouched);
  hud.toggleBuy(match.phase === 'buy' && match.started);
  if (match.phase === 'buy') refreshBuyMenu();
  refreshBoard(input.down('Tab'));
}

// ------------------------------------------------------------- main loop

let last = performance.now();
function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (nowMs - last) / 1000);
  last = nowMs;
  frameDt = dt;
  match.now += dt;
  recoil = Math.max(0, recoil - dt * 5);
  bloom = Math.max(0, bloom - dt * WEAPONS[me.weaponId].settlePerSec * 0.1);

  if (!STAGED && match.started) {
    stepMatch();
    const frozen = match.phase === 'over' || match.phase === 'matchover';
    if (!frozen) {
      const frameInput = { dx: input.mouseDX, dy: input.mouseDY };
      // the buy phase freezes the bots (their own speed gate), never
      // the player: you walk your spawn row while you shop
      player.update(dt, input, frameInput, false);
      stepPlayer();
      for (const b of bots) {
        if (!b.alive) continue;
        b.update(dt, {
          dt, now: match.now, colliders: world.colliders, waypoints: world.waypoints,
          foes: foesOf(b.team), phase: match.phase === 'planted' ? 'live' : match.phase,
          shoot: botShoot, tryPlant, tryDefuse, jobFor,
        });
      }
      stepChannels();
      for (let i = pendingPops.length - 1; i >= 0; i--) {
        if (match.now >= pendingPops[i].at) { popGrenade(pendingPops[i]); pendingPops.splice(i, 1); }
      }
      checkRoundEnd();
      if (player.footstep) { player.footstep = false; sfx.step(); }
    }
  }

  if (flash && match.now >= flashOffAt && !STAGED) flash.visible = false;
  player.applyCamera(camera);
  if (viewmodel) {
    viewmodel.visible = me.alive;
    const bob = player.speed2d > 0.5 ? Math.sin(nowMs * 0.012) * 0.008 : 0;
    viewmodel.position.set(VM_BASE.x, VM_BASE.y + bob - recoil * 0.03, VM_BASE.z + recoil * 0.09);
    viewmodel.rotation.x = recoil * 0.14;
  }
  refreshHud();
  input.consume();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// hooks for the test harness and the dossier screenshots
window.__game = {
  match, me, bots,
  phase: () => match.phase,
  alive: () => teamAlive('cinder') + teamAlive('tidewatch'),
  yaw: () => player.yaw,
  pitch: () => player.pitch,
  locked: () => input.locked,
  keys: (code, on) => { if (on) input.keys.add(code); else input.keys.delete(code); },
};
