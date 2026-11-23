// The player character (on foot) and sidewalk pedestrians.
import * as THREE from "three";
import { clampToLand } from "./vehicles.js";

// Character: the rig used by "Ragphys" by GentVR (three.js Xbot, Mixamo skeleton), reshaped with
// the pack's masculinize() field, and animated live by the pack's ProceduralHumanoidAnimator.
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { masculinize } from "./ragphys/masculinize.js";
import xbotURL from "../assets/character/Xbot.glb";

let template = null;
export async function loadCharacter() {
  const b64 = xbotURL.slice(xbotURL.indexOf(",") + 1);
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(bin.buffer, "", ok, fail));
  template = gltf.scene;
  masculinize(template);
}

import { ProceduralHumanoidAnimator } from "./ragphys/ProceduralHumanoidAnimator.js";

const matCache = new Map();
const mat = (hex, rough, metal = 0) => {
  const k = hex + ":" + rough;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }));
  return matCache.get(k);
};

// body = main surface color, joints = the rig's joint/limb pieces
export function makePerson({ body = 0xd9d3ca, joints = 0x2c3038 } = {}) {
  const root = new THREE.Group();
  const model = SkeletonUtils.clone(template);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false;
    o.material = /joint/i.test(o.material?.name || "") ? mat(joints, 0.45, 0.2) : mat(body, 0.55);
  });
  root.add(model);
  root.userData = { model, anim: null };
  return root;
}

// (Re)build the ragphys procedural animator for a person standing at its root. The animator
// generates every step itself (foot planting, arm swing, turning, jumps) and moves the root.
export function rigAnimator(person, heading, ground, opts = {}) {
  const u = person.userData;
  u.anim?.restoreRestPose();
  person.rotation.set(0, heading, 0);
  person.updateMatrixWorld(true);
  u.anim = new ProceduralHumanoidAnimator(u.model, { root: person, sex: "male", ground, agility: opts.agility ?? 1, seed: opts.seed ?? 1337 });
  u.anim.setMode("idle");
  u.mode = "idle";
  return u.anim;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Steer the animator toward a world direction at a locomotion mode ('idle' | 'walk' | 'run' | 'sprint').
function steer(person, wantHeading, mode) {
  const u = person.userData, an = u.anim;
  if (mode !== u.mode) { an.setMode(mode); u.mode = mode; }
  if (mode === "idle" || wantHeading == null) { an.setTurn(0, 0); return; }
  const err = wrapAngle(wantHeading - an.heading);
  an.setTurn(Math.max(-1, Math.min(1, err * 3)), err);
}

// Keep x/z inside the playable land without touching the animator's height.
function clampXZ(pos, bounds) {
  const y = pos.y;
  clampToLand(pos, null, bounds);
  pos.y = y;
}

// ---------------- player on foot ----------------
export class Walker {
  constructor(model, bounds) {
    this.model = model;
    this.pos = model.position; // the animator moves this
    this.bounds = bounds;
    this.ground = (x, z) => (x > bounds.x1 ? Math.max(0.03, bounds.beachY(x, z)) : 0.04);
    this.jumpY = 0;
    this.speed = 0;
    this.teleport(model.position, 0);
  }
  get facing() { return this.model.userData.anim.heading; }
  teleport(p, heading) {
    this.model.position.set(p.x, this.ground(p.x, p.z), p.z);
    rigAnimator(this.model, heading, this.ground, { agility: 1.8 });
  }
  update(dt, input, camYaw, grid, bounds) {
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    // camera right vector is (-fz, fx)
    const mx = fx * input.y - fz * input.x;
    const mz = fz * input.y + fx * input.x;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const mode = mag < 0.12 ? "idle" : input.sprint ? "sprint" : mag > 0.6 ? "run" : "walk";
    steer(this.model, mag < 0.12 ? null : Math.atan2(mx, mz), mode);
    const an = this.model.userData.anim;
    if (input.jump) an.jump();
    an.update(dt);
    this.speed = an.speed.x;
    grid.resolveCircle(this.pos, 0.38, 0.5);
    clampXZ(this.pos, bounds);
  }
}

// ---------------- pedestrians ----------------
const BODIES = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xd9d3ca, 0x6b4226, 0xb9c4d0];
const JOINTS = [0xff6f91, 0x4cc9f0, 0xf7b801, 0xffffff, 0x80ed99, 0xb5179e, 0xff8c42, 0x3a86ff, 0x2c3038, 0xf72585];
const ANIM_RANGE = 75; // pedestrians farther than this from the camera pause (saves CPU)
const flat = () => 0.08;

export class Pedestrians {
  constructor(city, scene, rng, count) {
    this.scene = scene; this.rng = rng; this.city = city;
    this.list = [];
    for (let k = 0; k < count; k++) {
      const m = makePerson({ body: rng.pick(BODIES), joints: rng.pick(JOINTS) });
      const ped = { model: m, b: rng.pick(city.blocks), off: 1.3 + rng.range(-0.4, 0.6), u: rng.next(), dir: rng.chance(0.5) ? 1 : -1, mode: rng.chance(0.85) ? "walk" : "run", dead: null, seed: k + 1 };
      this.spawnOnLoop(ped);
      scene.add(m);
      this.list.push(ped);
    }
  }
  // Point on the block's sidewalk loop at parameter u (0..1), plus the walking direction there.
  loopPoint(ped, u) {
    const { b, off } = ped;
    const x0 = b.x0 - off, z0 = b.z0 - off, x1 = b.x1 + off, z1 = b.z1 + off;
    const w = x1 - x0, d = z1 - z0, per = 2 * (w + d);
    let s = (((u % 1) + 1) % 1) * per;
    if (s < w) return [x0 + s, z0, per];
    if ((s -= w) < d) return [x1, z0 + s, per];
    if ((s -= d) < w) return [x1 - s, z1, per];
    s -= w;
    return [x0, z1 - s, per];
  }
  spawnOnLoop(ped) {
    const [x, z] = this.loopPoint(ped, ped.u), [nx, nz] = this.loopPoint(ped, ped.u + ped.dir * 0.01);
    ped.model.position.set(x, 0.08, z);
    rigAnimator(ped.model, Math.atan2(nx - x, nz - z), flat, { seed: ped.seed });
  }
  update(dt, car, carVel, onHit, camPos) {
    for (const p of this.list) {
      const pos = p.model.position;
      if (p.dead) {
        const k = p.dead;
        k.t += dt;
        if (k.t < 3) {
          pos.addScaledVector(k.vel, dt);
          k.vel.y -= 18 * dt;
          if (pos.y < 0.1) { pos.y = 0.1; k.vel.multiplyScalar(0.6); k.vel.y = Math.abs(k.vel.y) * 0.3; }
          if (pos.y > 0.2 || k.t < 0.3) p.model.rotation.x += k.spin * dt;
          else p.model.rotation.x += (-Math.PI / 2 - p.model.rotation.x) * Math.min(1, dt * 8); // settle on its back
        }
        if (k.t > 15) {
          p.dead = null;
          p.model.rotation.set(0, 0, 0);
          p.b = this.rng.pick(this.city.blocks);
          this.spawnOnLoop(p);
        }
        continue;
      }
      if (camPos && pos.distanceToSquared(camPos) > ANIM_RANGE * ANIM_RANGE) continue;
      // walk toward a point a few meters ahead on the loop
      let [tx, tz, per] = this.loopPoint(p, p.u);
      if (Math.hypot(tx - pos.x, tz - pos.z) < 2.2) { p.u += (p.dir * 2.5) / per; [tx, tz] = this.loopPoint(p, p.u); }
      steer(p.model, Math.atan2(tx - pos.x, tz - pos.z), p.mode);
      p.model.userData.anim.update(dt);
      if (car) {
        const dx = pos.x - car.x, dz = pos.z - car.z;
        const sp = carVel.length();
        if (dx * dx + dz * dz < 4.2 && sp > 4) {
          p.model.rotation.order = "YXZ";
          p.dead = { t: 0, vel: carVel.clone().multiplyScalar(0.7).add(new THREE.Vector3(0, 4 + sp * 0.15, 0)), spin: -4 - sp * 0.15 };
          onHit && onHit(p);
        }
      }
    }
  }
  positions() { return this.list.filter((p) => !p.dead).map((p) => p.model.position); }
  dispose() { for (const p of this.list) this.scene.remove(p.model); this.list = []; }
}
