// The player character (on foot) and sidewalk pedestrians.
import * as THREE from "three";
import { clampToLand } from "./vehicles.js";

// Character: the rig used by "Ragphys" by GentVR (three.js Xbot, Mixamo skeleton), reshaped with
// the pack's masculinize() field and animated with the rig's own idle / walk / run clips.
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { masculinize } from "./ragphys/masculinize.js";
import xbotURL from "../assets/character/Xbot.glb";

let template = null, clips = {};
export async function loadCharacter() {
  const b64 = xbotURL.slice(xbotURL.indexOf(",") + 1);
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(bin.buffer, "", ok, fail));
  template = gltf.scene;
  masculinize(template);
  for (const a of gltf.animations) clips[a.name] = a;
}

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
    o.material = /joint/i.test(o.material?.name || "") ? mat(joints, 0.45, 0.2) : mat(body, 0.55);
  });
  root.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const act = {};
  for (const n of ["idle", "walk", "run"]) { act[n] = mixer.clipAction(clips[n]); act[n].play(); act[n].setEffectiveWeight(n === "idle" ? 1 : 0); }
  root.userData = { mixer, act, model };
  return root;
}

// Blend idle -> walk -> run by ground speed (m/s), keeping feet roughly in sync.
export function animatePerson(p, speed, dt, airborne = false) {
  const { mixer, act } = p.userData;
  const w = THREE.MathUtils.smoothstep(speed, 0.15, 1.2);
  const r = THREE.MathUtils.smoothstep(speed, 2.2, 4.0);
  act.idle.setEffectiveWeight(1 - w);
  act.walk.setEffectiveWeight(w * (1 - r));
  act.run.setEffectiveWeight(w * r);
  act.walk.timeScale = Math.max(0.6, speed / 1.5);
  act.run.timeScale = Math.max(0.7, speed / 5.2);
  mixer.update(airborne ? dt * 0.25 : dt);
}

// ---------------- player on foot ----------------
export class Walker {
  constructor(model) {
    this.model = model;
    this.pos = model.position.clone();
    this.vy = 0; this.onGround = true;
    this.facing = 0;
    this.speed = 0;
  }
  update(dt, input, camYaw, grid, bounds) {
    // movement relative to the camera
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    // camera right vector is (-fz, fx)
    const mx = fx * input.y - fz * input.x;
    const mz = fz * input.y + fx * input.x;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const target = mag * (input.sprint ? 8.5 : 4.2);
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    if (mag > 0.05) {
      const want = Math.atan2(mx, mz);
      let d = want - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 12);
      this.pos.x += (mx / (mag || 1)) * this.speed * dt;
      this.pos.z += (mz / (mag || 1)) * this.speed * dt;
    }
    if (input.jump && this.onGround) { this.vy = 6.2; this.onGround = false; }
    const groundY = this.pos.y;
    this.vy -= 18 * dt;
    let y = this.jumpY ?? 0;
    y += this.vy * dt;
    if (y <= 0) { y = 0; this.vy = 0; this.onGround = true; }
    this.jumpY = y;
    grid.resolveCircle(this.pos, 0.38, y + 0.5);
    clampToLand(this.pos, null, bounds);
    this.model.position.set(this.pos.x, this.pos.y + y, this.pos.z);
    this.model.rotation.y = this.facing;
    animatePerson(this.model, this.speed, dt, !this.onGround);
    return groundY;
  }
}

// ---------------- pedestrians ----------------
const BODIES = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xd9d3ca, 0x6b4226, 0xb9c4d0];
const JOINTS = [0xff6f91, 0x4cc9f0, 0xf7b801, 0xffffff, 0x80ed99, 0xb5179e, 0xff8c42, 0x3a86ff, 0x2c3038, 0xf72585];
export class Pedestrians {
  constructor(city, scene, rng, count) {
    this.scene = scene; this.rng = rng; this.city = city;
    this.list = [];
    const blocks = city.blocks;
    for (let k = 0; k < count; k++) {
      const b = rng.pick(blocks);
      const m = makePerson({ body: rng.pick(BODIES), joints: rng.pick(JOINTS) });
      const s = rng.range(0.92, 1.08);
      m.scale.setScalar(s);
      const off = 1.3 + rng.range(-0.4, 0.6);
      const ped = { model: m, b, off, u: rng.next(), dir: rng.chance(0.5) ? 1 : -1, speed: rng.range(1.1, 1.7), dead: null, pos: m.position };
      this.place(ped, 0);
      scene.add(m);
      this.list.push(ped);
    }
  }
  // walk around the block perimeter on the sidewalk
  place(ped, dt) {
    const { b, off } = ped;
    const x0 = b.x0 - off, z0 = b.z0 - off, x1 = b.x1 + off, z1 = b.z1 + off;
    const w = x1 - x0, d = z1 - z0, per = 2 * (w + d);
    ped.u = (ped.u + (ped.dir * ped.speed * dt) / per + 1) % 1;
    let s = ped.u * per, x, z, hx, hz;
    if (s < w) { x = x0 + s; z = z0; hx = 1; hz = 0; }
    else if ((s -= w) < d) { x = x1; z = z0 + s; hx = 0; hz = 1; }
    else if ((s -= d) < w) { x = x1 - s; z = z1; hx = -1; hz = 0; }
    else { s -= w; x = x0; z = z1 - s; hx = 0; hz = -1; }
    ped.model.position.set(x, 0.08, z);
    ped.model.rotation.y = Math.atan2(hx * ped.dir, hz * ped.dir);
  }
  update(dt, car, carVel, onHit, camPos) {
    for (const p of this.list) {
      if (p.dead) {
        const k = p.dead;
        k.t += dt;
        if (k.t < 3) {
          p.model.position.addScaledVector(k.vel, dt);
          k.vel.y -= 18 * dt;
          if (p.model.position.y < 0.1) { p.model.position.y = 0.1; k.vel.multiplyScalar(0.6); k.vel.y = Math.abs(k.vel.y) * 0.3; }
          if (p.model.position.y > 0.2 || k.t < 0.3) p.model.rotation.x += k.spin * dt;
          else p.model.rotation.x += (-Math.PI / 2 - p.model.rotation.x) * Math.min(1, dt * 8); // settle on its back
        }
        if (k.t > 15) { p.dead = null; p.model.rotation.set(0, 0, 0); p.model.position.y = 0.08; p.b = this.rng.pick(this.city.blocks); }
        continue;
      }
      this.place(p, dt);
      // only animate pedestrians near the camera
      if (!camPos || p.model.position.distanceToSquared(camPos) < 110 * 110) animatePerson(p.model, p.speed, dt);
      if (car) {
        const dx = p.model.position.x - car.x, dz = p.model.position.z - car.z;
        const sp = carVel.length();
        if (dx * dx + dz * dz < 4.2 && sp > 4) {
          p.model.rotation.x = 0;
          p.dead = { t: 0, vel: carVel.clone().multiplyScalar(0.7).add(new THREE.Vector3(0, 4 + sp * 0.15, 0)), spin: -4 - sp * 0.15 };
          p.model.rotation.order = "YXZ";
          onHit && onHit(p);
        }
      }
    }
  }
  positions() { return this.list.filter((p) => !p.dead).map((p) => p.model.position); }
  dispose() { for (const p of this.list) this.scene.remove(p.model); this.list = []; }
}
