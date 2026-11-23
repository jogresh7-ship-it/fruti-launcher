// Shared materials, instanced palms and street lamps, and the day/night glow controls.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export function makeMaterials(T) {
  const time = { value: 0 };
  const glow = []; // [material, kind] pairs updated by setNight()

  const facadeMat = (f, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({
      map: f.map, roughnessMap: f.rough, metalnessMap: f.rough, normalMap: f.normal || null,
      emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0,
      vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: opts.env ?? 1,
    });
    glow.push([m, "window"]);
    return m;
  };
  const F = T.facades, G = T.ground;
  const pbrMat = (p, color = 0xffffff) => new THREE.MeshStandardMaterial({ color, map: p.map, normalMap: p.normal, roughnessMap: p.arm, aoMap: p.arm, roughness: 1, metalness: 0 });
  const cache = {
    f_glass: facadeMat(F.glass, { env: 1.6 }),
    f_glass2: facadeMat(F.glass2, { env: 1.6 }),
    f_office: facadeMat(F.office),
    f_deco: facadeMat(F.deco),
    f_brick: facadeMat(F.brick),
    f_house: facadeMat(F.house),
    roof: new THREE.MeshStandardMaterial({ map: G.roof, roughness: 0.95 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
    tile: new THREE.MeshStandardMaterial({ map: G.tile, roughness: 0.8, vertexColors: true }),
    wall: new THREE.MeshStandardMaterial({ map: G.plaza, vertexColors: true, roughness: 0.9 }),
    pool: new THREE.MeshStandardMaterial({ color: 0x29c4dc, roughness: 0.05, metalness: 0.2, emissive: 0x0a6f86, emissiveIntensity: 0.3 }),
    neon: new THREE.MeshBasicMaterial({ vertexColors: true }),
    g_grass: pbrMat(G.grassPbr, 0xb5e38c),
    g_plaza: pbrMat(G.pavers),
    g_pebbles: pbrMat(G.pebbles),
    g_sand: new THREE.MeshStandardMaterial({ map: G.sand, roughness: 1 }),
  };
  glow.push([cache.neon, "neon"]);
  glow.push([cache.pool, "pool"]);

  // ----- palms -----
  const trunkGeo = (() => {
    const segs = 14, radial = 8, H = 9, pos = [], idx = [], uv = [];
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 3, 0), new THREE.Vector3(0.9, 6, 0), new THREE.Vector3(1.8, H, 0)]);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, p = curve.getPoint(t);
      const r = (0.34 - 0.14 * t) * (1 + 0.07 * Math.sin(t * 70));
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        pos.push(p.x + Math.cos(a) * r, p.y, p.z + Math.sin(a) * r);
        uv.push(k / radial, t * 6);
      }
    }
    for (let i = 0; i < segs; i++) for (let k = 0; k < radial; k++) {
      const a = i * (radial + 1) + k, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  })();
  const crownGeo = (() => {
    const parts = [];
    const top = new THREE.Vector3(1.8, 9, 0);
    const fronds = 11;
    for (let f = 0; f < fronds; f++) {
      const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.2, len = 4.2 + (f % 3) * 0.5, segs = 8;
      const droop = 1.6 + (f % 4) * 0.5;
      const pos = [], uv = [], idx = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs, d = t * len;
        const y = 0.9 * t * len * 0.35 - droop * t * t;
        const w = 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.08));
        const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
        const px = -Math.sin(a), pz = Math.cos(a);
        for (const side of [-1, 1]) {
          pos.push(top.x + cx + px * w * side, top.y + y - Math.abs(side) * 0.12 * w, top.z + cz + pz * w * side);
          uv.push(side < 0 ? 0 : 1, t);
        }
        // middle rib vertex for a slight V fold
        pos.push(top.x + cx, top.y + y + 0.08, top.z + cz);
        uv.push(0.5, t);
      }
      for (let s = 0; s < segs; s++) {
        const b = s * 3, n = b + 3;
        idx.push(b, n, b + 2, n, n + 2, b + 2, b + 2, n + 2, b + 1, n + 2, n + 1, b + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      parts.push(g);
    }
    return mergeGeometries(parts);
  })();
  const bark = new THREE.MeshStandardMaterial({ color: 0x8a7356, roughness: 1 });
  const leaf = new THREE.MeshStandardMaterial({ map: T.palmLeaf, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 });
  leaf.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = "uniform float uTime;\n" + sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      #ifdef USE_INSTANCING
      float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
      #else
      float ph = 0.0;
      #endif
      float k = max(0.0, length(position.xz - vec2(1.8, 0.0)));
      transformed.y += sin(uTime * 1.7 + ph + k) * 0.06 * k;
      transformed.x += sin(uTime * 1.1 + ph) * 0.08 * k;`);
  };

  function palms(list, rng) {
    const trunk = new THREE.InstancedMesh(trunkGeo, bark, list.length);
    const crown = new THREE.InstancedMesh(crownGeo, leaf, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
    list.forEach((pl, k) => {
      const sc = rng.range(0.75, 1.35);
      e.set(0, rng.next() * Math.PI * 2, 0);
      q.setFromEuler(e);
      s.set(sc, sc * rng.range(0.9, 1.2), sc);
      p.set(pl.x, pl.y, pl.z);
      m.compose(p, q, s);
      trunk.setMatrixAt(k, m); crown.setMatrixAt(k, m);
    });
    for (const im of [trunk, crown]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); }
    return [trunk, crown];
  }

  // ----- street lamps -----
  const poleGeo = (() => {
    const pole = new THREE.CylinderGeometry(0.08, 0.13, 7, 6).translate(0, 3.5, 0);
    const arm = new THREE.BoxGeometry(0.1, 0.1, 2.2).translate(0, 6.9, -1.05);
    return mergeGeometries([pole.toNonIndexed(), arm.toNonIndexed()]);
  })();
  const headGeo = new THREE.BoxGeometry(0.45, 0.14, 0.8).translate(0, 6.82, -2.0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.5, metalness: 0.6 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  glow.push([headMat, "lamp"]);
  function lamps(list) {
    const pole = new THREE.InstancedMesh(poleGeo, poleMat, list.length);
    const head = new THREE.InstancedMesh(headGeo, headMat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((l, k) => {
      m.makeRotationY(l.rot).setPosition(l.x, 0.08, l.z);
      pole.setMatrixAt(k, m); head.setMatrixAt(k, m);
    });
    pole.castShadow = true;
    pole.computeBoundingSphere(); head.computeBoundingSphere();
    return [pole, head];
  }

  return {
    time,
    forKey: (k) => cache[k] || cache.trim,
    sand: cache.g_sand,
    palms, lamps,
    extraGlow: (m, kind) => glow.push([m, kind]),
    // night: 0 = full day, 1 = full night
    setNight(night) {
      for (const [m, kind] of glow) {
        if (kind === "window") m.emissiveIntensity = night * 1.05;
        else if (kind === "neon") m.color.setScalar(0.6 + night * 3.5);
        else if (kind === "lamp") m.color.setRGB(1, 0.85, 0.6).multiplyScalar(0.7 + night * 4);
        else if (kind === "pool") m.emissiveIntensity = 0.25 + night * 1.2;
        else if (kind === "sign") m.color.setScalar(0.7 + night * 2.5);
        else if (kind === "head") m.emissiveIntensity = 0.3 + night * 4;
      }
    },
  };
}
