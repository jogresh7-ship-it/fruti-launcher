// 3D models for Earth Flight, drawn with three.js inside the MapLibre map.
//
// Models (all CC BY 4.0, see CREDITS.md):
//   plane.glb  "plane a340" by mamont nikita
//   eiffel.glb "Eiffel Tower 3D" by moustafatarek27
//   trees.glb  "Low Poly Forest Tree Pack" by 99.Miles
//
// fly.js calls EarthFlight3D.addTo(map, game) after every style load. Everything
// is placed in meters around the plane (x east, y north, z up), re-anchored each
// frame, so it stays precise anywhere on Earth.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const RAD = Math.PI / 180;
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const load = (url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

// ---------- shared scene (survives style changes) ----------
const scene = new THREE.Scene();
const sky = new THREE.HemisphereLight(0xdcecff, 0x55663f, 1.6);
sky.position.set(0, 0, 1); // our world is Z-up
scene.add(sky);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(-0.5, -0.8, 1.4); // from the south-west, high up
scene.add(sun);

const planeYaw = new THREE.Group();
const planePitch = new THREE.Group();
const planeRoll = new THREE.Group();
planeYaw.add(planePitch); planePitch.add(planeRoll);
planeYaw.visible = false;
scene.add(planeYaw);

const treeGroup = new THREE.Group();
scene.add(treeGroup);

let game = null;
let planeLoaded = false;

// ---------- the plane ----------
const PLANE_LENGTH = 60; // meters, about an A340
load("models/plane.glb").then((gltf) => {
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center); // center it
  const fix = new THREE.Group(); // glTF is Y-up with the nose on +X; our world is Z-up
  fix.add(model);
  fix.rotation.x = Math.PI / 2;
  fix.scale.setScalar(PLANE_LENGTH / size.x);
  planeRoll.add(fix);
  planeLoaded = true;
  game?.onPlaneReady?.();
}).catch((e) => console.warn("plane model:", e));

// ---------- landmarks ----------
const landmarks = [
  {
    name: "Eiffel Tower", url: "models/eiffel.glb", lon: 2.294481, lat: 48.858258, height: 330,
    bearing: 46.5, // faces line up with the Champ de Mars
    group: new THREE.Group(), ground: null,
    // Collision: four legs joined by open arches up to 57 m, then a tapering square tower.
    hit(u, v, h) {
      if (h < 0 || h > this.height) return false;
      const half = 62.5 * Math.pow(1 - h / this.height, 1.7) + 2;
      if (Math.abs(u) > half || Math.abs(v) > half) return false;
      if (h > 57) return true;
      const arch = 37 * (1 - h / 75); // half-width of the open arch at this height
      return Math.abs(u) > arch && Math.abs(v) > arch; // only the corner legs are solid
    },
  },
];
for (const lm of landmarks) {
  lm.group.visible = false;
  scene.add(lm.group);
  load(lm.url).then((gltf) => {
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z); // stand on its base
    model.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.75, metalness: 0.35, side: THREE.DoubleSide });
      }
    });
    const fix = new THREE.Group();
    fix.add(model);
    fix.rotation.x = Math.PI / 2;
    fix.scale.setScalar(lm.height / size.y);
    const turn = new THREE.Group();
    turn.rotation.z = -lm.bearing * RAD;
    turn.add(fix);
    lm.group.add(turn);
    lm.loaded = true;
  }).catch((e) => console.warn(lm.name + " model:", e));
}

// ---------- trees ----------
const MAX_PER_VARIANT = 2500;
const variants = []; // [{ meshes: [InstancedMesh], count }]
load("models/trees.glb").then((gltf) => {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  // Group meshes into whole trees by where they stand in the pack.
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh || /Rocks/i.test(o.name)) return;
    const box = new THREE.Box3().setFromObject(o);
    parts.push({ mesh: o, box, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 });
  });
  const clusters = [];
  for (const p of parts) {
    const c = clusters.find((k) => Math.hypot(k.cx - p.cx, k.cz - p.cz) < 3);
    if (c) { c.parts.push(p); c.box.union(p.box); } else clusters.push({ cx: p.cx, cz: p.cz, parts: [p], box: p.box.clone() });
  }
  for (const c of clusters) {
    const h = c.box.max.y - c.box.min.y;
    if (h < 8) continue; // skip bushes
    const meshes = c.parts.map(({ mesh }) => {
      const geo = toFloat(mesh.geometry.clone());
      geo.applyMatrix4(mesh.matrixWorld);
      geo.translate(-c.cx, -c.box.min.y, -c.cz);
      geo.rotateX(Math.PI / 2); // Y-up to Z-up
      const mat = mesh.material.clone();
      mat.side = THREE.DoubleSide;
      if (mat.map) { mat.alphaTest = Math.max(mat.alphaTest || 0, 0.4); mat.transparent = false; }
      const inst = new THREE.InstancedMesh(geo, mat, MAX_PER_VARIANT);
      inst.count = 0;
      inst.frustumCulled = false;
      treeGroup.add(inst);
      return inst;
    });
    variants.push({ meshes, height: h, count: 0 });
  }
  game?.onTreesReady?.(variants.length);
}).catch((e) => console.warn("trees model:", e));

// Compressed models store positions as small normalized integers; turn them back into
// plain floats before moving the geometry, or the new values get clipped to -1..1.
function toFloat(geo) {
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.attributes[name];
    if (attr.isInterleavedBufferAttribute || attr.normalized || !(attr.array instanceof Float32Array)) {
      const out = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) out[i * attr.itemSize + k] = attr.getComponent(i, k);
      geo.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
    }
  }
  return geo;
}

// Deterministic pseudo-random numbers from a grid cell, so each spot always gets the same tree.
function hash(x, y, k) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const trees = new Map(); // cell key -> { lon, lat, z, variant, rot, scale }
let treeOrigin = null;   // mercator origin the instance matrices are relative to
const CELL_DEG = 0.00027; // ~30 m north-south
const TREE_RADIUS_M = 1800;

function plantTrees(map) {
  if (!variants.length || !game || !map.getSource("openmaptiles")) return;
  const p = game.plane();
  const agl = p.alt - game.ground(p.lon, p.lat);
  if (agl > 2500) return;
  let feats = [];
  try {
    feats = map.querySourceFeatures("openmaptiles", { sourceLayer: "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass"]]] })
      .concat(map.querySourceFeatures("openmaptiles", { sourceLayer: "park", filter: ["==", ["get", "class"], "park"] }));
  } catch { return; }
  const cosLat = Math.cos(p.lat * RAD);
  const rLat = TREE_RADIUS_M / 111320, rLon = rLat / cosLat;
  const cellLon = CELL_DEG / cosLat;
  let added = 0;
  for (const f of feats) {
    const cls = f.properties.class, sub = f.properties.subclass;
    // Grass is only treed when it is a park or garden; woods and forests are dense.
    if (cls === "grass" && !["park", "garden", "recreation_ground", "village_green"].includes(sub)) continue;
    const density = cls === "wood" ? 0.8 : 0.35;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [];
    for (const rings of polys) {
      const outer = rings[0];
      if (!outer || outer.length < 4) continue;
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const [x, y] of outer) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      minX = Math.max(minX, p.lon - rLon); maxX = Math.min(maxX, p.lon + rLon);
      minY = Math.max(minY, p.lat - rLat); maxY = Math.min(maxY, p.lat + rLat);
      if (minX > maxX || minY > maxY) continue;
      for (let gy = Math.floor(minY / CELL_DEG); gy <= Math.floor(maxY / CELL_DEG); gy++) {
        for (let gx = Math.floor(minX / cellLon); gx <= Math.floor(maxX / cellLon); gx++) {
          const key = gx + ":" + gy;
          if (trees.has(key) || hash(gx, gy, 1) > density) continue;
          const lon = (gx + hash(gx, gy, 2)) * cellLon, lat = (gy + hash(gx, gy, 3)) * CELL_DEG;
          if (!inRing(lon, lat, outer) || rings.slice(1).some((hole) => inRing(lon, lat, hole))) continue;
          trees.set(key, {
            lon, lat, z: game.ground(lon, lat),
            variant: Math.floor(hash(gx, gy, 4) * variants.length),
            rot: hash(gx, gy, 5) * Math.PI * 2, scale: 0.75 + hash(gx, gy, 6) * 0.6,
            height: 0, // filled in below
          });
          if (++added > 3000) break;
        }
        if (added > 3000) break;
      }
    }
  }
  for (const t of trees.values()) if (!t.height) t.height = variants[t.variant].height * t.scale;
  // Forget trees that are far behind.
  for (const [k, t] of trees) {
    if (Math.abs(t.lat - p.lat) > rLat * 1.6 || Math.abs(t.lon - p.lon) > rLon * 1.6) trees.delete(k);
  }
  rebuildTrees(p);
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1);
function rebuildTrees(p) {
  treeOrigin = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], 0);
  const s = treeOrigin.meterInMercatorCoordinateUnits();
  for (const v of variants) v.count = 0;
  for (const t of trees.values()) {
    const v = variants[t.variant];
    if (v.count >= MAX_PER_VARIANT) continue;
    const m = maplibregl.MercatorCoordinate.fromLngLat([t.lon, t.lat], 0);
    tmpP.set((m.x - treeOrigin.x) / s, -(m.y - treeOrigin.y) / s, t.z);
    tmpQ.setFromAxisAngle(zAxis, t.rot);
    tmpS.setScalar(t.scale);
    tmpM.compose(tmpP, tmpQ, tmpS);
    for (const inst of v.meshes) inst.setMatrixAt(v.count, tmpM);
    v.count++;
  }
  for (const v of variants) {
    for (const inst of v.meshes) { inst.count = v.count; inst.instanceMatrix.needsUpdate = true; }
  }
}

// ---------- the MapLibre custom layer ----------
function makeLayer() {
  let renderer = null;
  const camera = new THREE.Camera();
  let lastPlant = 0, lastGround = 0;
  return {
    id: "earthflight-3d",
    type: "custom",
    renderingMode: "3d",
    onAdd(map, gl) {
      this.map = map;
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, options) {
      if (!game) return;
      const map = this.map;
      const p = game.plane();
      const origin = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], 0);
      const s = origin.meterInMercatorCoordinateUnits();
      const toLocal = (lon, lat) => {
        const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
        return [(m.x - origin.x) / s, -(m.y - origin.y) / s];
      };
      const now = performance.now();

      // plane
      planeYaw.visible = planeLoaded && game.showPlane();
      planeYaw.position.set(0, 0, p.alt);
      planeYaw.rotation.z = (90 - p.heading) * RAD;
      planePitch.rotation.y = -p.pitch * RAD;
      planeRoll.rotation.x = p.roll * RAD;

      // landmarks
      if (now - lastGround > 2000) {
        lastGround = now;
        for (const lm of landmarks) {
          const g = game.ground(lm.lon, lm.lat);
          if (g > 0 || lm.ground === null) lm.ground = g;
        }
      }
      for (const lm of landmarks) {
        const [x, y] = toLocal(lm.lon, lm.lat);
        lm.group.visible = !!lm.loaded && Math.hypot(x, y) < 40000;
        lm.group.position.set(x, y, lm.ground || 0);
      }

      // trees
      if (now - lastPlant > 1500 && game.flying()) { lastPlant = now; plantTrees(map); }
      if (treeOrigin) {
        treeGroup.position.set((treeOrigin.x - origin.x) / s, -(treeOrigin.y - origin.y) / s, 0);
        treeGroup.visible = true;
      } else treeGroup.visible = false;

      // MapLibre's matrix works in mercator units; scale our meters into it around the plane.
      const local = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(s, -s, s));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(options.defaultProjectionData?.mainMatrix || options.modelViewProjectionMatrix).multiply(local);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };
}

window.EarthFlight3D = {
  addTo(map, g) {
    game = g;
    if (planeLoaded) g.onPlaneReady?.();
    if (variants.length) g.onTreesReady?.(variants.length);
    if (!map.getLayer("earthflight-3d")) map.addLayer(makeLayer());
  },
  debug() {
    const t = trees.values().next().value;
    return { trees: trees.size, firstTree: t && { lon: t.lon, lat: t.lat, z: t.z, height: t.height }, variants: variants.map((v) => ({ h: +v.height.toFixed(1), count: v.count,
      meshes: v.meshes.map((m) => ({ tris: (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, map: !!m.material.map, alphaTest: m.material.alphaTest, size: new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position).getSize(new THREE.Vector3()).toArray().map((x) => +x.toFixed(1)) })) })) };
  },
  resetTrees() { trees.clear(); treeOrigin = null; for (const v of variants) { v.count = 0; for (const i of v.meshes) i.count = 0; } },
  // True when the plane is inside a tree's crown (about 4 m around its trunk).
  hitTree(lon, lat, alt) {
    const kLon = 111320 * Math.cos(lat * RAD);
    for (const t of trees.values()) {
      const dy = (t.lat - lat) * 111320;
      if (dy > 5 || dy < -5) continue;
      const dx = (t.lon - lon) * kLon;
      if (dx > 5 || dx < -5) continue;
      if (dx * dx + dy * dy < 16 && alt < t.z + t.height * 0.95) return true;
    }
    return false;
  },
  // Returns the landmark the plane is inside, or null.
  hitLandmark(lon, lat, alt) {
    for (const lm of landmarks) {
      if (!lm.loaded) continue;
      const dx = (lon - lm.lon) * 111320 * Math.cos(lat * RAD), dy = (lat - lm.lat) * 111320;
      if (Math.abs(dx) > 200 || Math.abs(dy) > 200) continue;
      const b = lm.bearing * RAD; // rotate into the tower's own axes
      const u = dx * Math.cos(b) - dy * Math.sin(b), v = dx * Math.sin(b) + dy * Math.cos(b);
      if (lm.hit(u, v, alt - (lm.ground || 0))) return lm.name;
    }
    return null;
  },
};
window.dispatchEvent(new Event("earthflight3d-ready"));
