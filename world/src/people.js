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
import { Ragdoll } from "./ragphys/ragdoll.js";

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
const _d = new THREE.Vector3(), _h = new THREE.Vector3(), _v = new THREE.Vector3();

// Steer the animator toward a world direction at a locomotion mode
// ('idle' | 'walk' | 'run' | 'sprint' | 'crouch' | 'guard'). Crouching still = crouch at speed 0.
function steer(person, wantHeading, mode) {
  const u = person.userData, an = u.anim;
  if (mode !== u.mode) { an.setMode(mode); u.mode = mode; }
  if (mode === "crouch") an.setSpeed(wantHeading == null ? 0 : an.modeSpeed("crouch"));
  if (wantHeading == null) { an.setTurn(0, 0); return; }
  const err = wrapAngle(wantHeading - an.heading);
  an.setTurn(Math.max(-1, Math.min(1, err * 3)), err);
}

// Keep x/z inside the playable land without touching the animator's height.
function clampXZ(pos, bounds) {
  const y = pos.y;
  clampToLand(pos, null, bounds);
  pos.y = y;
}

// ---------------- ragdoll (Ragphys / Rapier) ----------------
// Hands the character to physics: every body part keeps the velocity it had, plus `vel`.
// tone: muscle stiffness (0.4 = dead weight, ~3 = dazed but conscious).
function startRagdoll(physics, person, vel, tone, hit) {
  const an = person.userData.anim;
  const rd = new Ragdoll(physics, an);
  rd.sync(1 / 60);
  rd.setDynamic(true);
  for (const p of rd.parts) { p.k = tone; p.z = 1; p.grav = 0; p.pin = 0; p.pinRot = 0; }
  for (const p of rd.parts) {
    const v = p.rb.linvel();
    p.rb.setLinvel({ x: v.x + vel.x, y: v.y + vel.y, z: v.z + vel.z }, true);
  }
  if (hit) rd.impulse(hit.part, hit.J, hit.point);
  return rd;
}
// Muscle tone over time after a hit: from `from` (still fighting it, knees buckling) down to
// `to` (unconscious or dead) over `dur` seconds — a body crumples instead of dropping like a board.
function rampTone(rd, t, from, to, dur) {
  const u = THREE.MathUtils.smoothstep(t, 0, dur);
  const k = from + (to - from) * u;
  for (const p of rd.parts) p.k = /neck|head/.test(p.kind) ? k * 0.6 : k;
}

// Blood pool decal: an irregular dark-red stain that spreads slowly under a body.
let bloodTex = null;
function makeBloodTex() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * 6.28, d = i ? 30 + Math.random() * 45 : 0, r = i ? 30 + Math.random() * 40 : 75;
    const cx = 128 + Math.cos(a) * d, cy = 128 + Math.sin(a) * d;
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(70,0,4,0.95)"); g.addColorStop(0.7, "rgba(90,4,8,0.85)"); g.addColorStop(1, "rgba(90,4,8,0)");
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const bloodGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
export function makeBloodPool() {
  bloodTex ||= makeBloodTex();
  const m = new THREE.Mesh(bloodGeo, new THREE.MeshStandardMaterial({ map: bloodTex, transparent: true, depthWrite: false, roughness: 0.15, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.rotation.y = Math.random() * 6.28;
  m.scale.setScalar(0.01);
  m.renderOrder = 1;
  return m;
}

// Keep the character's root under its pelvis (so the camera, minimap and AI follow the body),
// then pose the bones from the physics bodies.
function followRagdoll(person, rd) {
  const t = rd.byName.pelvis.rb.translation();
  person.position.x = t.x; person.position.z = t.z;
  person.updateMatrixWorld(true);
  rd.writeBack(1);
}

// ---------------- player on foot ----------------
export class Walker {
  constructor(model, bounds) {
    this.model = model;
    this.pos = model.position; // the animator moves this
    this.bounds = bounds;
    this.ground = (x, z) => (x > bounds.x1 ? Math.max(0.03, bounds.beachY(x, z)) : 0.04);
    this.speed = 0;
    this.crouch = false;
    this.punchT = 0;
    this.physics = null;
    this.health = 100;
    this.hurtT = 99;
    this.teleport(model.position, 0);
  }
  get anim() { return this.model.userData.anim; }
  get facing() { return this.anim.heading; }
  get down() { return !!this.fall; }
  teleport(p, heading) {
    this.model.position.set(p.x, this.ground(p.x, p.z), p.z);
    rigAnimator(this.model, heading, this.ground, { agility: 1.8 });
    this.crouch = false;
  }
  // Start a punch (the animator's rear-hand straight). Returns true when a new punch began.
  attack() {
    if (this.fall || this.punchT > 0) return false;
    this.punchT = 0.62;
    this.punchHit = false;
    steer(this.model, null, "guard");
    this.anim.strike();
    return true;
  }
  get dead() { return this.health <= 0; }
  // Hit by a car: a real ragdoll fall, then get back up where the body landed (unless it killed you).
  knock(vel, damage = 0) {
    if (this.fall || !this.physics) return;
    this.health = Math.max(0, this.health - damage);
    this.hurtT = 0;
    this.fall = { t: 0, heading: this.facing, rd: startRagdoll(this.physics, this.model, vel, 6, { part: "chest", J: _v.copy(vel).setY(0).multiplyScalar(4) }) };
  }
  // Back on your feet somewhere (respawn after being wasted).
  respawn(p, heading) {
    this.fall?.rd.dispose();
    this.fall = null;
    this.model.rotation.set(0, 0, 0);
    this.health = 100;
    this.teleport(p, heading);
  }
  afterPhysics() { if (this.fall) followRagdoll(this.model, this.fall.rd); }
  // Scripted movement (walking to a car door, ducking into the seat): steer toward a heading
  // with a mode, or stand and turn to face `face`.
  auto(dt, wantHeading, mode, grid, bounds) {
    steer(this.model, wantHeading, mode);
    this.anim.update(dt);
    this.speed = this.anim.speed.x;
    if (grid) grid.resolveCircle(this.pos, 0.38, 0.5);
    if (bounds) clampXZ(this.pos, bounds);
  }
  update(dt, input, camYaw, grid, bounds) {
    this.hurtT += dt;
    if (this.hurtT > 6 && this.health > 0) this.health = Math.min(100, this.health + dt * 4); // slow regen
    if (this.fall) {
      const f = this.fall;
      f.t += dt;
      rampTone(f.rd, f.t, 6, this.dead ? 0.25 : 1.6, this.dead ? 1.4 : 0.8);
      if (!this.dead && f.t > 3.2 && f.rd.motion() < 0.6) {
        const t = f.rd.byName.pelvis.rb.translation(), h = f.rd.byName.head.rb.translation();
        f.rd.dispose();
        this.fall = null;
        this.teleport(_v.set(t.x, 0, t.z), Math.atan2(t.x - h.x, t.z - h.z)); // stand up facing away from where the head lay
      }
      return;
    }
    if (input.crouch) this.crouch = !this.crouch;
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    // camera right vector is (-fz, fx)
    const mx = fx * input.y - fz * input.x;
    const mz = fz * input.y + fx * input.x;
    const mag = Math.min(1, Math.hypot(mx, mz));
    const want = mag < 0.12 ? null : Math.atan2(mx, mz);
    if (this.punchT > 0) {
      this.punchT -= dt;
      steer(this.model, want, "guard");
    } else {
      if (input.sprint && mag > 0.12) this.crouch = false;
      const mode = this.crouch ? "crouch" : mag < 0.12 ? "idle" : input.sprint ? "sprint" : mag > 0.6 ? "run" : "walk";
      steer(this.model, want, mode);
    }
    const an = this.anim;
    if (input.jump && !this.crouch) an.jump();
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
    this.physics = null;
    this.list = [];
    for (let k = 0; k < count; k++) {
      const m = makePerson({ body: rng.pick(BODIES), joints: rng.pick(JOINTS) });
      const ped = { model: m, b: rng.pick(city.blocks), off: 1.3 + rng.range(-0.4, 0.6), u: rng.next(), dir: rng.chance(0.5) ? 1 : -1, mode: rng.chance(0.85) ? "walk" : "run", dead: null, flee: null, health: 100, seed: k + 1 };
      this.spawnOnLoop(ped);
      scene.add(m);
      this.list.push(ped);
    }
  }
  rect(ped) {
    const { b, off } = ped;
    return [b.x0 - off, b.z0 - off, b.x1 + off, b.z1 + off];
  }
  // Point on the block's sidewalk loop at parameter u (0..1), plus the loop's perimeter.
  loopPoint(ped, u) {
    const [x0, z0, x1, z1] = this.rect(ped);
    const w = x1 - x0, d = z1 - z0, per = 2 * (w + d);
    let s = (((u % 1) + 1) % 1) * per;
    if (s < w) return [x0 + s, z0, per];
    if ((s -= w) < d) return [x1, z0 + s, per];
    if ((s -= d) < w) return [x1 - s, z1, per];
    s -= w;
    return [x0, z1 - s, per];
  }
  // After fleeing: join the sidewalk loop of the nearest block, at the closest point.
  rehome(ped) {
    const pos = ped.model.position;
    let best = null, bd = Infinity;
    for (const b of this.city.blocks) {
      const cx = Math.max(b.x0, Math.min(pos.x, b.x1)), cz = Math.max(b.z0, Math.min(pos.z, b.z1));
      const d = Math.hypot(pos.x - cx, pos.z - cz);
      if (d < bd) { bd = d; best = b; }
    }
    ped.b = best;
    const [x0, z0, x1, z1] = this.rect(ped), w = x1 - x0, d = z1 - z0, per = 2 * (w + d);
    const px = Math.max(x0, Math.min(pos.x, x1)), pz = Math.max(z0, Math.min(pos.z, z1));
    const e = [Math.abs(pz - z0), Math.abs(px - x1), Math.abs(pz - z1), Math.abs(px - x0)];
    const side = e.indexOf(Math.min(...e));
    const s = side === 0 ? px - x0 : side === 1 ? w + (pz - z0) : side === 2 ? w + d + (x1 - px) : 2 * w + d + (z1 - pz);
    ped.u = s / per;
  }
  spawnOnLoop(ped) {
    const [x, z] = this.loopPoint(ped, ped.u), [nx, nz] = this.loopPoint(ped, ped.u + ped.dir * 0.01);
    ped.model.position.set(x, 0.08, z);
    rigAnimator(ped.model, Math.atan2(nx - x, nz - z), flat, { seed: ped.seed });
  }
  // Everyone near a scary event runs away from it.
  panic(at, radius = 22) {
    for (const p of this.list) {
      if (p.dead) continue;
      if (p.model.position.distanceTo(at) < radius) p.flee = { t: this.rng.range(6, 10), from: at.clone() };
    }
  }
  // Ragdoll death. vel: body velocity (m/s); hit: optional {part, J (impulse vector), point}.
  // tone0: how much fight is left at first (a punch knockout crumples, a car hit flails).
  kill(p, vel, hit, tone0 = 5) {
    if (p.dead) return;
    p.health = 0;
    p.flee = null;
    if (this.physics) p.dead = { t: 0, tone0, rd: startRagdoll(this.physics, p.model, vel, tone0, hit) };
    else p.dead = { t: 0, rd: null };
    this.panic(p.model.position);
    this.onDeath?.(p);
  }
  // A punch from the player. dir: unit vector from player to the pedestrian.
  punch(p, dir, damage = 34) {
    if (p.dead) return;
    p.health -= damage;
    const head = p.model.userData.anim.bones.Head.getWorldPosition(new THREE.Vector3());
    if (p.health <= 0) this.kill(p, _v.copy(dir).multiplyScalar(2.5).setY(0.6), { part: "head", J: dir.clone().multiplyScalar(45).setY(8), point: head });
    else {
      p.model.userData.anim.applyImpulse(dir, 150, "head");
      this.panic(p.model.position, 18);
      p.flee = { t: 9, from: p.model.position.clone().sub(dir) };
    }
  }
  // Someone (the player) shoved this pedestrian: a stagger from the animator.
  bump(p, dirX, dirZ, speed) {
    if (p.dead) return;
    if (performance.now() < (p.bumpCD || 0)) return;
    p.bumpCD = performance.now() + 500;
    p.model.userData.anim.applyImpulse(_d.set(dirX, 0, dirZ), 40 + speed * 28, "chest");
    if (speed > 6) p.flee = { t: 5, from: p.model.position.clone().addScaledVector(_d, -1) };
  }
  // Keep pedestrians from walking through each other.
  separate() {
    const L = this.list;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      if (L[i].dead || L[j].dead) continue;
      const a = L[i].model.position, b = L[j].model.position;
      const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.49 && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (0.7 - d) / 2;
        a.x -= (dx / d) * push; a.z -= (dz / d) * push; b.x += (dx / d) * push; b.z += (dz / d) * push;
      }
    }
  }
  afterPhysics() { for (const p of this.list) if (p.dead?.rd) followRagdoll(p.model, p.dead.rd); }
  update(dt, car, carVel, onHit, camPos, player) {
    this.separate();
    for (const p of this.list) {
      const pos = p.model.position;
      if (p.dead) {
        const D = p.dead;
        D.t += dt;
        if (D.rd) {
          rampTone(D.rd, D.t, D.tone0, 0.25, 1.3);
          // once the body has come to rest, a pool of blood spreads under it
          if (!D.blood && D.t > 1.2 && D.rd.motion() < 0.5) {
            const t = D.rd.byName.chest.rb.translation();
            D.blood = makeBloodPool();
            D.blood.position.set(t.x, 0.06, t.z);
            this.scene.add(D.blood);
          }
          if (D.blood) D.blood.scale.setScalar(Math.min(1.9, 0.3 + (D.t - 1.2) * 0.22));
        }
        // bodies stay a while, then quietly get replaced once nobody is looking closely
        if (p.dead.t > 25 && (!camPos || pos.distanceTo(camPos) > 45) || p.dead.t > 90) {
          p.dead.rd?.dispose();
          if (p.dead.blood) { this.scene.remove(p.dead.blood); p.dead.blood.material.dispose(); }
          p.dead = null; p.health = 100;
          p.b = this.rng.pick(this.city.blocks);
          this.spawnOnLoop(p);
        }
        continue;
      }
      if (camPos && pos.distanceToSquared(camPos) > ANIM_RANGE * ANIM_RANGE) continue;
      const an = p.model.userData.anim;
      if (p.flee) {
        // sprint away from the threat, sliding along walls
        p.flee.t -= dt;
        let h = Math.atan2(pos.x - p.flee.from.x, pos.z - p.flee.from.z);
        if (p.wallHit) h += 1.2 * (p.seed % 2 ? 1 : -1);
        steer(p.model, h, "sprint");
        if (p.flee.t <= 0) { p.flee = null; this.rehome(p); }
      } else {
        // walk toward a point a few meters ahead on the loop
        let [tx, tz, per] = this.loopPoint(p, p.u);
        if (Math.hypot(tx - pos.x, tz - pos.z) < 2.2) { p.u += (p.dir * 2.5) / per; [tx, tz] = this.loopPoint(p, p.u); }
        steer(p.model, Math.atan2(tx - pos.x, tz - pos.z), p.mode);
      }
      // look at the player when close; flinch from a car speeding at them
      if (player && pos.distanceToSquared(player) < 49) an.setLookTarget(_h.set(player.x, player.y + 1.6, player.z));
      else an.setLookTarget(null);
      p.flinchCD = Math.max(0, (p.flinchCD || 0) - dt);
      if (car && carVel && !p.flinchCD) {
        _d.subVectors(pos, car);
        const dist = Math.hypot(_d.x, _d.z), sp = Math.hypot(carVel.x, carVel.z);
        if (dist < 12 && sp > 6 && (_d.x * carVel.x + _d.z * carVel.z) / (dist * sp) > 0.7) { an.flinch(_h.set(car.x, car.y + 1, car.z)); p.flinchCD = 2; }
      }
      an.update(dt);
      p.wallHit = !!this.city.grid.resolveCircle(pos, 0.35, 0.5);
      // hit by the player's car: ragdoll
      if (car) {
        const dx = pos.x - car.x, dz = pos.z - car.z;
        const sp = carVel.length();
        if (dx * dx + dz * dz < 4.2 && sp > 4) {
          this.kill(p, _v.copy(carVel).multiplyScalar(0.75).setY(2 + sp * 0.12), { part: "pelvis", J: carVel.clone().multiplyScalar(6), point: null }, 2.5);
          onHit && onHit(p);
        }
      }
    }
  }
  positions() { return this.list.filter((p) => !p.dead).map((p) => p.model.position); }
  dispose() {
    for (const p of this.list) { p.dead?.rd?.dispose(); if (p.dead?.blood) this.scene.remove(p.dead.blood); this.scene.remove(p.model); }
    this.list = [];
  }
}
