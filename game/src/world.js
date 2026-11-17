// world.js — Ember Quay's map: a harbour oil terminal after hours.
//
// The whole port is one flat yard ringed by a perimeter wall. Two plant
// sites anchor the north half — the crane yard in the west (A) and the
// tank farm in the east (B) — with a warehouse splitting the middle and
// container lanes feeding both. Every solid is an axis-aligned box in
// the XZ plane: the same box list drives the meshes you see, the
// circle collision that moves bodies, and the sight-line test that
// decides who can see whom, so cover never lies.
//
// Waypoints sit on the lanes between the boxes. Two waypoints link
// when the straight walk between them is unobstructed, and bot routes
// are breadth-first searches over those links.

import * as THREE from 'three';
import { COLORS, materials, siteTexture } from './palette.js';

// ------------------------------------------------------------------ sites

export const SITES = {
  A: { key: 'A', x: -31, z: -20, r: 6.5, label: 'CRANE YARD' },
  B: { key: 'B', x: 31, z: -20, r: 6.5, label: 'TANK FARM' },
};

// Spawn rows: five slots per team, attackers along the south fence,
// defenders up by the north fence, each with the yaw they start facing
// (attackers look north, -z; defenders look south, +z).
export const SPAWNS = {
  cinder: [
    { x: -6, z: 36, yaw: 0 }, { x: -3, z: 37.5, yaw: 0 },
    { x: 0, z: 36, yaw: 0 }, { x: 3, z: 37.5, yaw: 0 },
    { x: 6, z: 36, yaw: 0 },
  ],
  tidewatch: [
    { x: -6, z: -37, yaw: Math.PI }, { x: -3, z: -38.5, yaw: Math.PI },
    { x: 0, z: -37, yaw: Math.PI }, { x: 3, z: -38.5, yaw: Math.PI },
    { x: 6, z: -37, yaw: Math.PI },
  ],
};

// ------------------------------------------------------------------ boxes
// One entry per solid: centre, footprint, height, material key. Round
// tanks get a cylinder mesh over a square collider.

const BOXES = [
  // perimeter: the yard is 96 x 88, walls just outside the play area
  { x: 0, z: -45.5, w: 99, d: 3, h: 6, m: 'concrete' },
  { x: 0, z: 45.5, w: 99, d: 3, h: 6, m: 'concrete' },
  { x: -49.5, z: 0, w: 3, d: 94, h: 6, m: 'concrete' },
  { x: 49.5, z: 0, w: 3, d: 94, h: 6, m: 'concrete' },

  // warehouse across the middle, two door gaps in each long wall
  { x: -14.5, z: -6, w: 17, d: 1.2, h: 5.5, m: 'concreteDark' },
  { x: 14.5, z: -6, w: 17, d: 1.2, h: 5.5, m: 'concreteDark' },
  { x: -14.5, z: 10, w: 17, d: 1.2, h: 5.5, m: 'concreteDark' },
  { x: 14.5, z: 10, w: 17, d: 1.2, h: 5.5, m: 'concreteDark' },
  { x: -23.6, z: 2, w: 1.2, d: 17.2, h: 5.5, m: 'concreteDark' },
  { x: 23.6, z: 2, w: 1.2, d: 17.2, h: 5.5, m: 'concreteDark' },
  // crates stacked inside the warehouse
  { x: -12, z: 2, w: 2.6, d: 2.6, h: 2.6, m: 'crate' },
  { x: 9, z: 0, w: 2.6, d: 2.6, h: 1.3, m: 'crate' },
  { x: 14, z: 5, w: 2.6, d: 2.6, h: 2.6, m: 'crate' },

  // site A — crane yard: legs, a container wall, crate cover
  { x: -38, z: -30, w: 1.6, d: 1.6, h: 11, m: 'rust' },
  { x: -24, z: -30, w: 1.6, d: 1.6, h: 11, m: 'rust' },
  { x: -38, z: -12, w: 1.6, d: 1.6, h: 11, m: 'rust' },
  { x: -24, z: -12, w: 1.6, d: 1.6, h: 11, m: 'rust' },
  { x: -31, z: -26, w: 12, d: 2.6, h: 2.6, m: 'containerA' },
  { x: -40, z: -18, w: 2.6, d: 10, h: 2.6, m: 'containerB' },
  { x: -27, z: -15, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },
  { x: -35, z: -22, w: 2.4, d: 2.4, h: 1.2, m: 'crate' },

  // site B — tank farm: three storage tanks and a pipe run
  { x: 24, z: -27, w: 8.4, d: 8.4, h: 7, m: 'tank', round: true },
  { x: 38, z: -27, w: 8.4, d: 8.4, h: 7, m: 'tank', round: true },
  { x: 31, z: -13, w: 8.4, d: 8.4, h: 7, m: 'tank', round: true },
  { x: 31, z: -33, w: 16, d: 1, h: 1.1, m: 'pipe' },
  { x: 22, z: -18, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },
  { x: 41, z: -14, w: 2.4, d: 2.4, h: 1.2, m: 'crate' },

  // west lane containers, staggered so the lane bends
  { x: -31, z: 8, w: 12, d: 2.6, h: 2.6, m: 'containerB' },
  { x: -38, z: 20, w: 2.6, d: 11, h: 2.6, m: 'containerC' },
  { x: -24, z: 22, w: 10, d: 2.6, h: 2.6, m: 'containerA' },
  { x: -33, z: 33, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },

  // east lane containers, mirrored idea, different rhythm
  { x: 33, z: 6, w: 11, d: 2.6, h: 2.6, m: 'containerC' },
  { x: 25, z: 18, w: 2.6, d: 10, h: 2.6, m: 'containerA' },
  { x: 38, z: 24, w: 10, d: 2.6, h: 2.6, m: 'containerB' },
  { x: 30, z: 34, w: 2.4, d: 2.4, h: 1.2, m: 'crate' },

  // south yard clutter between the spawns and the warehouse doors
  { x: -10, z: 26, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },
  { x: 11, z: 27, w: 2.4, d: 2.4, h: 1.2, m: 'crate' },
  { x: 0, z: 20, w: 9, d: 2.6, h: 2.6, m: 'containerC' },
  { x: -16, z: 36, w: 9, d: 2.6, h: 2.6, m: 'containerA' },
  { x: 17, z: 37, w: 9, d: 2.6, h: 2.6, m: 'containerB' },

  // north apron clutter between the sites and the defender spawns
  { x: 0, z: -20, w: 11, d: 2.6, h: 2.6, m: 'containerA' },
  { x: -12, z: -30, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },
  { x: 12, z: -31, w: 2.4, d: 2.4, h: 1.2, m: 'crate' },
  { x: 0, z: -33, w: 2.4, d: 2.4, h: 2.4, m: 'crate' },
];

// Lamp posts: pole positions; the emissive head and the real light are
// added by buildWorld. Kept sparse — three live point lights plus the
// emissive material reads as a lit yard at night without costing frames.
const LAMPS = [
  { x: -31, z: -20 }, { x: 31, z: -20 }, { x: 0, z: 2 },
  { x: -20, z: 30 }, { x: 20, z: 30 }, { x: 0, z: -38 },
];

// Waypoint nodes on the lanes. Links are derived, not listed: any pair
// close enough with a clear straight walk becomes neighbours.
const NODES = [
  [0, 40], [-14, 30], [14, 30], [-24, 30], [24, 30],
  [-8, 18], [8, 18], [0, 14], [-20, 14], [20, 14],
  [-33, 14], [33, 13], [-8, 2], [8, 2], [0, 2],
  [-18, -1], [18, -1], [-29, 1], [30, -2], [-8, -12],
  [8, -12], [0, -14], [-20, -14], [20, -15], [-31, -8],
  [31, -6], [-40, -26], [-22, -24], [-31, -33], [22, -33],
  [40, -33], [31, -38], [0, -26], [-14, -38], [14, -38],
  [-42, -6], [42, -8], [-42, 22], [42, 18],
];

// ------------------------------------------------------------------ build

export function buildWorld(scene) {
  const mats = materials();
  const colliders = [];
  const group = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(130, 115), mats.ground);
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  for (const b of BOXES) {
    colliders.push({ x0: b.x - b.w / 2, z0: b.z - b.d / 2, x1: b.x + b.w / 2, z1: b.z + b.d / 2 });
    if (b.round) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(b.w / 2, b.w / 2, b.h, 20), mats.tank);
      tank.position.set(b.x, b.h / 2, b.z);
      group.add(tank);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(b.w / 2 + 0.25, b.w / 2 + 0.25, 0.35, 20), mats.tankTop);
      cap.position.set(b.x, b.h + 0.17, b.z);
      group.add(cap);
    } else {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mats[b.m]);
      mesh.position.set(b.x, b.h / 2, b.z);
      group.add(mesh);
    }
  }

  // crane beams across the top of site A, high above collider height —
  // pure scenery, deliberately not colliders
  const beam = new THREE.Mesh(new THREE.BoxGeometry(17, 1.4, 2), mats.rust);
  beam.position.set(-31, 11.4, -30);
  group.add(beam);
  const beam2 = new THREE.Mesh(new THREE.BoxGeometry(17, 1.4, 2), mats.rust);
  beam2.position.set(-31, 11.4, -12);
  group.add(beam2);

  // site pads: a hazard-ring disc and the letter card lying on it
  for (const key of Object.keys(SITES)) {
    const s = SITES[key];
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(s.r, s.r, 0.12, 28), mats.hazard);
    pad.position.set(s.x, 0.06, s.z);
    group.add(pad);
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: siteTexture(key, key === 'A' ? '#ffa63d' : '#2ec4b6'), transparent: true }),
    );
    card.rotation.x = -Math.PI / 2;
    card.position.set(s.x, 0.14, s.z);
    group.add(card);
  }

  // lamps: thin pole, emissive head; three of them carry real lights
  LAMPS.forEach((l, i) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 5.6, 8), mats.steelDark);
    pole.position.set(l.x, 2.8, l.z);
    group.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.5), mats.lampLight);
    head.position.set(l.x, 5.7, l.z);
    group.add(head);
    if (i % 2 === 0) {
      const light = new THREE.PointLight(COLORS.amber, 55, 34, 1.9);
      light.position.set(l.x, 5.5, l.z);
      group.add(light);
    }
  });

  scene.add(group);

  // waypoint graph: link every pair within 30 m whose walk is clear
  const waypoints = NODES.map(([x, z]) => ({ x, z, links: [] }));
  for (let i = 0; i < waypoints.length; i++) {
    for (let j = i + 1; j < waypoints.length; j++) {
      const a = waypoints[i], b = waypoints[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 30 && lineClear(a.x, a.z, b.x, b.z, colliders)) {
        a.links.push(j);
        b.links.push(i);
      }
    }
  }

  return { colliders, waypoints, group, mats };
}

// ------------------------------------------------------------------ tests

// Push a circle (pos is a Vector3 feet position, r its radius) out of
// every box it overlaps, resolving along the smaller penetration axis.
export function collide(pos, r, colliders) {
  for (const c of colliders) {
    const nearX = Math.max(c.x0, Math.min(pos.x, c.x1));
    const nearZ = Math.max(c.z0, Math.min(pos.z, c.z1));
    const dx = pos.x - nearX;
    const dz = pos.z - nearZ;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      pos.x = nearX + (dx / d) * r;
      pos.z = nearZ + (dz / d) * r;
    } else {
      // centre inside the box: leave by the nearest face
      const left = pos.x - c.x0, right = c.x1 - pos.x;
      const near = pos.z - c.z0, far = c.z1 - pos.z;
      const m = Math.min(left, right, near, far);
      if (m === left) pos.x = c.x0 - r;
      else if (m === right) pos.x = c.x1 + r;
      else if (m === near) pos.z = c.z0 - r;
      else pos.z = c.z1 + r;
    }
  }
}

// Is the straight XZ segment between two points free of boxes? Slab
// test per box; touching a face counts as clear, crossing does not.
export function lineClear(ax, az, bx, bz, colliders) {
  const dx = bx - ax, dz = bz - az;
  for (const c of colliders) {
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-9) {
      if (ax < c.x0 || ax > c.x1) continue;
    } else {
      let ta = (c.x0 - ax) / dx, tb = (c.x1 - ax) / dx;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (az < c.z0 || az > c.z1) continue;
    } else {
      let ta = (c.z0 - az) / dz, tb = (c.z1 - az) / dz;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) continue;
    }
    if (t1 > 0.001 && t0 < 0.999) return false;
  }
  return true;
}

// Breadth-first route over the waypoint links; returns node indices
// from `from` to `to` inclusive, or just [from] when unreachable.
export function findPath(waypoints, from, to) {
  if (from === to) return [from];
  const prev = new Array(waypoints.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const cur = queue.shift();
    for (const n of waypoints[cur].links) {
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      if (n === to) {
        const path = [to];
        let c = to;
        while (c !== from) { c = prev[c]; path.unshift(c); }
        return path;
      }
      queue.push(n);
    }
  }
  return [from];
}

// Index of the waypoint nearest to a point (straight-line distance;
// callers path from there, so a node across a wall still works out).
export function nearestNode(waypoints, x, z) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < waypoints.length; i++) {
    const d = (waypoints[i].x - x) ** 2 + (waypoints[i].z - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
