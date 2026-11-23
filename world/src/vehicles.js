// Cars: procedural models, arcade driving physics (with handbrake drifts) and lane-following traffic.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { ROAD_W, LANE } from "./city.js";
import silveradoURL from "../assets/cars/silverado.glb";
import sealURL from "../assets/cars/seal.glb";
import urusURL from "../assets/cars/urus.glb";
import f1URL from "../assets/cars/f1.glb";

// Real car models (Sketchfab, CC-BY-NC — see assets/cars/LICENSE-*.txt), compressed with meshopt.
const REAL = {
  silverado: { url: silveradoURL, len: 5.9, max: 46, acc: 12 },
  seal: { url: sealURL, len: 4.8, max: 62, acc: 17 },
  urus: { url: urusURL, len: 5.1, max: 72, acc: 21 },
  f1: { url: f1URL, len: 4.3, max: 90, acc: 26 },
};
const realTemplates = {};
export async function loadRealCars() {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  for (const [name, r] of Object.entries(REAL)) {
    const bin = Uint8Array.from(atob(r.url.slice(r.url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const gltf = await loader.parseAsync(bin.buffer, "");
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const k = r.len / size.z;
    const toCar = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    // bake transforms and merge everything that shares a material (fewer draw calls)
    const groups = new Map();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      for (const a of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(a)) g.deleteAttribute(a);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      for (const a of ["position", "normal", "uv"]) if (g.attributes[a] && (g.attributes[a].isInterleavedBufferAttribute || g.attributes[a].normalized || !(g.attributes[a].array instanceof Float32Array))) {
        const src = g.attributes[a], arr = new Float32Array(src.count * src.itemSize);
        for (let i = 0; i < src.count; i++) for (let j = 0; j < src.itemSize; j++) arr[i * src.itemSize + j] = src.getComponent(i, j);
        g.setAttribute(a, new THREE.BufferAttribute(arr, src.itemSize));
      }
      // (only now, in plain floats: quantized int16 positions would clip when transformed)
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toCar, o.matrixWorld));
      const m = o.material;
      m.flatShading = false; m.needsUpdate = true;
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(g);
    });
    const root = new THREE.Group();
    for (const [m, list] of groups) {
      const mesh = new THREE.Mesh(mergeGeometries(list), m);
      mesh.castShadow = true;
      root.add(mesh);
    }
    realTemplates[name] = root;
    TYPES[name] = { w: size.x * k, l: r.len, wr: 0.36, max: r.max, acc: r.acc, real: true };
  }
}

const PAINTS = ["#f4f4f4", "#101418", "#c0c6cc", "#e63946", "#ff7eb6", "#2ec4b6", "#3a86ff", "#ffbe0b", "#8338ec", "#fb5607", "#0b3d91", "#2b9348", "#d4af37", "#ff4d6d"];

const shared = {};
function sharedMats() {
  if (shared.glass) return shared;
  shared.glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1218, roughness: 0.05, metalness: 0.2, clearcoat: 1, envMapIntensity: 2 });
  shared.dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
  shared.chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
  shared.head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 0.3 });
  shared.tail = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.5 });
  shared.paint = {};
  return shared;
}
function paintMat(hex) {
  const m = sharedMats();
  return (m.paint[hex] ||= new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.35, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 }));
}

const TYPES = {
  sedan: { w: 1.85, l: 4.6, h: 0.62, cab: [1.6, 0.56, 2.3, -0.15], clr: 0.3, wr: 0.36, max: 46, acc: 13 },
  sports: { w: 1.95, l: 4.4, h: 0.5, cab: [1.55, 0.45, 1.8, -0.35], clr: 0.22, wr: 0.36, max: 64, acc: 20 },
  suv: { w: 2.0, l: 4.9, h: 0.85, cab: [1.8, 0.7, 2.9, -0.35], clr: 0.42, wr: 0.43, max: 40, acc: 11 },
  taxi: { w: 1.85, l: 4.7, h: 0.62, cab: [1.6, 0.56, 2.3, -0.15], clr: 0.3, wr: 0.36, max: 44, acc: 12, color: "#ffc300", sign: true },
  van: { w: 2.0, l: 5.2, h: 1.0, cab: [1.9, 0.95, 3.6, -0.5], clr: 0.38, wr: 0.4, max: 36, acc: 9 },
};
const geoCache = {};

function carGeometry(typeName) {
  if (geoCache[typeName]) return geoCache[typeName];
  const t = TYPES[typeName];
  const nonIdx = (g) => (g.index ? g.toNonIndexed() : g);
  const body = [], glass = [], dark = [], chrome = [], head = [], tail = [];
  const y0 = t.clr + t.h / 2;
  body.push(new RoundedBoxGeometry(t.w, t.h, t.l, 3, 0.16).translate(0, y0, 0));
  const [cw, ch, cl, cz] = t.cab;
  glass.push(new RoundedBoxGeometry(cw, ch, cl, 3, 0.16).translate(0, t.clr + t.h + ch / 2 - 0.05, cz));
  body.push(new RoundedBoxGeometry(cw * 0.96, 0.08, cl * 0.82, 2, 0.03).translate(0, t.clr + t.h + ch - 0.06, cz)); // roof
  // bumpers, grill, mirrors
  dark.push(new THREE.BoxGeometry(t.w * 0.98, 0.22, 0.2).translate(0, t.clr + 0.1, t.l / 2 - 0.05));
  dark.push(new THREE.BoxGeometry(t.w * 0.98, 0.22, 0.2).translate(0, t.clr + 0.1, -t.l / 2 + 0.05));
  dark.push(new THREE.BoxGeometry(t.w * 0.5, 0.18, 0.06).translate(0, y0 + 0.02, t.l / 2 + 0.01));
  for (const s of [-1, 1]) {
    head.push(new THREE.BoxGeometry(0.42, 0.13, 0.06).translate(s * (t.w / 2 - 0.32), y0 + 0.1, t.l / 2 + 0.01));
    tail.push(new THREE.BoxGeometry(0.45, 0.14, 0.06).translate(s * (t.w / 2 - 0.3), y0 + 0.1, -t.l / 2 - 0.01));
    dark.push(new THREE.BoxGeometry(0.22, 0.12, 0.1).translate(s * (cw / 2 + 0.1), t.clr + t.h + 0.08, cz + cl / 2 - 0.25));
  }
  if (t.sign) chrome.push(new THREE.BoxGeometry(0.7, 0.22, 0.25).translate(0, t.clr + t.h + ch + 0.08, cz));
  const m = (arr) => (arr.length ? mergeGeometries(arr.map(nonIdx)) : null);
  const wheel = new THREE.CylinderGeometry(t.wr, t.wr, 0.26, 16).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(t.wr * 0.62, t.wr * 0.62, 0.28, 10).rotateZ(Math.PI / 2);
  return (geoCache[typeName] = { body: m(body), glass: m(glass), dark: m(dark), chrome: m(chrome), head: m(head), tail: m(tail), wheel, rim });
}

export function makeCarModel(typeName, color) {
  const t = TYPES[typeName];
  if (t.real) {
    const root = new THREE.Group();
    root.add(realTemplates[typeName].clone());
    root.userData = { type: typeName, spec: t, wheels: [], wheelBase: t.l * 0.58 };
    return root;
  }
  const g = carGeometry(typeName), M = sharedMats();
  const root = new THREE.Group();
  const add = (geo, mat) => { if (!geo) return; const me = new THREE.Mesh(geo, mat); me.castShadow = true; root.add(me); return me; };
  add(g.body, paintMat(t.color || color));
  add(g.glass, M.glass);
  add(g.dark, M.dark);
  add(g.chrome, M.chrome);
  add(g.head, M.head);
  add(g.tail, M.tail);
  const wheels = [];
  const wb = t.l / 2 - 0.85;
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const w = new THREE.Group();
    w.position.set(sx * (t.w / 2 - 0.12), t.wr, sz * wb);
    const tire = new THREE.Mesh(g.wheel, M.dark); tire.castShadow = true;
    const rim = new THREE.Mesh(g.rim, M.chrome);
    w.add(tire, rim);
    root.add(w);
    wheels.push(w);
  }
  root.userData = { type: typeName, spec: t, wheels, wheelBase: wb * 2 };
  return root;
}

export function randomCarType(rng) {
  if (TYPES.urus && rng.chance(0.4)) return rng.pick(["silverado", "seal", "seal", "urus", "silverado", "f1"]);
  const r = rng.next();
  return r < 0.42 ? "sedan" : r < 0.58 ? "suv" : r < 0.72 ? "taxi" : r < 0.86 ? "sports" : "van";
}
export const randomPaint = (rng) => rng.pick(PAINTS);

// ---------------- player driving ----------------
const _f = new THREE.Vector3(), _r = new THREE.Vector3();
export class DrivenCar {
  constructor(model) {
    this.model = model;
    this.spec = model.userData.spec;
    this.heading = model.rotation.y;
    this.pos = model.position.clone();
    this.vel = new THREE.Vector3();
    this.steer = 0;
    this.wheelSpin = 0;
    this.speed = 0;
  }
  update(dt, input, grid, bounds) {
    const s = this.spec;
    _f.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _r.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
    let vf = this.vel.dot(_f), vl = this.vel.dot(_r);
    const thr = input.y, hb = input.handbrake;
    // engine & brakes
    if (thr > 0) vf += thr * s.acc * (1 - Math.max(0, vf) / s.max) * dt;
    else if (thr < 0) vf += (vf > 0.5 ? thr * 30 : thr * s.acc * 0.6 * (1 + vf / 14)) * dt;
    vf -= vf * 0.12 * dt + Math.sign(vf) * Math.min(Math.abs(vf), 1.2 * dt);
    if (hb) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 9 * dt);
    // steering
    const target = -input.x * 0.6 / (1 + Math.abs(vf) * 0.035);
    this.steer += (target - this.steer) * Math.min(1, dt * 8);
    const yaw = (vf / this.model.userData.wheelBase) * Math.tan(this.steer) * (hb ? 1.45 : 1);
    this.heading += yaw * dt;
    // grip: kill sideways velocity (less with the handbrake = drift)
    const grip = hb ? 1.6 : 9;
    vl *= Math.exp(-grip * dt);
    _f.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _r.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
    this.vel.copy(_f).multiplyScalar(vf).addScaledVector(_r, vl);
    this.pos.addScaledVector(this.vel, dt);
    // collide using 3 circles along the body
    let hitSpeed = 0;
    for (const o of [-1.4, 0, 1.4]) {
      const c = this.pos.clone().addScaledVector(_f, o);
      const before = c.clone();
      const n = grid.resolveCircle(c, 1.05, 0.5);
      if (n) {
        this.pos.add(c.sub(before));
        const into = this.vel.x * n.x + this.vel.z * n.z;
        if (into < 0) {
          hitSpeed = Math.max(hitSpeed, -into);
          this.vel.x -= n.x * into * 1.35; this.vel.z -= n.z * into * 1.35;
          this.vel.multiplyScalar(0.8);
        }
      }
    }
    clampToLand(this.pos, this.vel, bounds);
    this.speed = this.vel.dot(_f);
    this.wheelSpin += (this.speed / this.spec.wr) * dt;
    this.apply();
    return hitSpeed;
  }
  apply() {
    const m = this.model;
    m.position.copy(this.pos);
    m.rotation.y = this.heading;
    const w = m.userData.wheels;
    w.forEach((wh, k) => {
      wh.rotation.x = this.wheelSpin;
      wh.rotation.y = k < 2 ? this.steer : 0;
      wh.rotation.order = "YXZ";
    });
    // body roll / pitch for weight
    const lat = this.vel.dot(_r);
    m.rotation.z = THREE.MathUtils.clamp(-lat * 0.012 + this.steer * this.speed * 0.004, -0.08, 0.08);
  }
}

export function clampToLand(pos, vel, b) {
  const sx = b.shoreX(pos.z) - 2;
  if (pos.x < b.x0 + 1) { pos.x = b.x0 + 1; if (vel) vel.x = Math.max(0, vel.x); }
  if (pos.x > sx) { pos.x = sx; if (vel) vel.x = Math.min(0, vel.x) * 0.5; }
  const zMin = pos.x > b.x1 ? b.z0 - 150 : b.z0 + 1, zMax = pos.x > b.x1 ? b.z1 + 150 : b.z1 - 1;
  if (pos.z < zMin) { pos.z = zMin; if (vel) vel.z = Math.max(0, vel.z); }
  if (pos.z > zMax) { pos.z = zMax; if (vel) vel.z = Math.min(0, vel.z); }
  pos.y = pos.x > b.x1 ? Math.max(0.03, b.beachY(pos.x, pos.z)) - 0.0 : 0.03;
}

// ---------------- traffic ----------------
export class Traffic {
  constructor(city, scene, rng, count) {
    this.city = city; this.scene = scene; this.rng = rng;
    this.cars = [];
    this.phase = 0; this.phaseT = 0;
    for (let k = 0; k < count; k++) this.spawn();
  }
  randomEdge() {
    const nodes = this.city.nodes;
    const a = this.rng.int(0, nodes.length - 1);
    const b = this.rng.pick(nodes[a].nb);
    return [a, b];
  }
  spawn(avoid, type) {
    const model = makeCarModel(type || randomCarType(this.rng), randomPaint(this.rng));
    const car = { model, a: 0, b: 0, t: 0, speed: 0, cruise: this.rng.range(9, 15), turn: null, knocked: null };
    for (let tries = 0; tries < 10; tries++) {
      [car.a, car.b] = this.randomEdge();
      car.t = this.rng.range(0, this.edgeLen());
      this.place(car);
      if (!avoid || model.position.distanceTo(avoid) > 60) break;
    }
    this.scene.add(model);
    this.cars.push(car);
    return car;
  }
  edgeLen() { return this.city.P - ROAD_W; }
  dir(a, b) {
    const A = this.city.nodes[a], B = this.city.nodes[b];
    return new THREE.Vector2(Math.sign(B.x - A.x), Math.sign(B.z - A.z));
  }
  lanePoint(a, b, t, out) {
    const A = this.city.nodes[a], d = this.dir(a, b);
    // right-hand side of travel direction
    const rx = -d.y, rz = d.x;
    const s = ROAD_W / 2 + t;
    out.set(A.x + d.x * s + rx * LANE, 0.03, A.z + d.y * s + rz * LANE);
    return out;
  }
  place(car) {
    const p = this.lanePoint(car.a, car.b, car.t, car.model.position);
    const d = this.dir(car.a, car.b);
    car.model.rotation.y = Math.atan2(d.x, d.y);
    return p;
  }
  green(a, b) {
    // phase 0: x-axis traffic goes, 1: all red, 2: z-axis goes, 3: all red
    const d = this.dir(a, b);
    return d.x !== 0 ? this.phase === 0 : this.phase === 2;
  }
  update(dt, player, playerCar, peds) {
    this.phaseT += dt;
    const dur = [11, 2, 11, 2][this.phase];
    if (this.phaseT > dur) { this.phaseT = 0; this.phase = (this.phase + 1) % 4; }
    const len = this.edgeLen();
    for (const car of this.cars) {
      const m = car.model;
      if (car.knocked) { this.updateKnocked(car, dt, player); continue; }
      // look ahead for obstacles
      const fwd = new THREE.Vector3(Math.sin(m.rotation.y), 0, Math.cos(m.rotation.y));
      let limit = car.cruise;
      const check = (p, r) => {
        const dx = p.x - m.position.x, dz = p.z - m.position.z;
        const along = dx * fwd.x + dz * fwd.z, side = Math.abs(dx * fwd.z - dz * fwd.x);
        if (along > 0 && along < 18 && side < r) limit = Math.min(limit, Math.max(0, (along - 6.5) * 1.4));
      };
      for (const o of this.cars) if (o !== car) check(o.model.position, 2.2);
      if (player) check(player, 1.8);
      if (playerCar) check(playerCar, 2.4);
      for (const p of peds) check(p, 1.4);
      // red light: stop at the end of the edge
      if (!car.turn && !this.green(car.a, car.b) && car.t < len - 1 && car.t > len - 14) limit = Math.min(limit, Math.max(0, (len - 2 - car.t) * 1.2));
      car.speed += THREE.MathUtils.clamp(limit - car.speed, -14 * dt, 5 * dt);
      const step = car.speed * dt;
      if (car.turn) {
        const tr = car.turn;
        tr.u += step / tr.len;
        if (tr.u >= 1) {
          car.turn = null; car.a = tr.b; car.b = tr.c; car.t = (tr.u - 1) * tr.len;
          this.place(car);
        } else {
          const u = tr.u, iu = 1 - u;
          const x = iu * iu * tr.p0.x + 2 * iu * u * tr.p1.x + u * u * tr.p2.x;
          const z = iu * iu * tr.p0.z + 2 * iu * u * tr.p1.z + u * u * tr.p2.z;
          const tx = 2 * iu * (tr.p1.x - tr.p0.x) + 2 * u * (tr.p2.x - tr.p1.x);
          const tz = 2 * iu * (tr.p1.z - tr.p0.z) + 2 * u * (tr.p2.z - tr.p1.z);
          m.position.set(x, 0.03, z);
          m.rotation.y = Math.atan2(tx, tz);
        }
      } else {
        car.t += step;
        if (car.t >= len) this.startTurn(car);
        else this.place(car);
      }
      for (const w of m.userData.wheels) w.rotation.x += step / m.userData.spec.wr;
    }
  }
  startTurn(car) {
    const nodes = this.city.nodes;
    const opts = nodes[car.b].nb.filter((n) => n !== car.a);
    const c = this.rng.pick(opts);
    const p0 = this.lanePoint(car.a, car.b, this.edgeLen(), new THREE.Vector3());
    const p2 = this.lanePoint(car.b, c, 0, new THREE.Vector3());
    const d1 = this.dir(car.a, car.b), d2 = this.dir(car.b, c);
    let p1;
    if (d1.x === d2.x && d1.y === d2.y) p1 = p0.clone().lerp(p2, 0.5);
    else {
      // control point: where the two lane lines cross
      p1 = new THREE.Vector3(d1.x !== 0 ? p2.x : p0.x, 0, d1.y !== 0 ? p2.z : p0.z);
    }
    const len = p0.distanceTo(p1) + p1.distanceTo(p2);
    car.turn = { b: car.b, c, p0, p1, p2, u: 0, len: Math.max(1, len * 0.92) };
  }
  // A car that was hit slides to a stop, then respawns once out of view.
  knock(car, vel) {
    car.knocked = { vel: vel.clone(), spin: (Math.random() - 0.5) * 4, t: 0 };
    car.turn = null;
  }
  updateKnocked(car, dt, player) {
    const k = car.knocked;
    k.t += dt;
    car.model.position.addScaledVector(k.vel, dt);
    car.model.rotation.y += k.spin * dt;
    const damp = Math.exp(-1.8 * dt);
    k.vel.multiplyScalar(damp); k.spin *= damp;
    this.city.grid.resolveCircle(car.model.position, 1.6, 0.5);
    if (k.t > 12 && player && car.model.position.distanceTo(player) > 120) {
      car.knocked = null;
      [car.a, car.b] = this.randomEdge();
      car.t = 0; car.speed = 0;
      this.place(car);
    }
  }
  remove(car) {
    this.cars.splice(this.cars.indexOf(car), 1);
  }
  dispose() {
    for (const c of this.cars) this.scene.remove(c.model);
    this.cars = [];
  }
}

// Headlights / taillights glow more at night.
export function setCarNight(n) {
  const m = sharedMats();
  m.head.emissiveIntensity = 0.3 + n * 6;
  m.tail.emissiveIntensity = 0.5 + n * 3;
}
