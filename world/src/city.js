// The world generator: lays out a street grid with the Modular Roads Pack, picks districts,
// fills blocks with towers / art-deco hotels / brick low-rises / houses / parks, adds a beach,
// palms and street furniture, and returns everything the game needs (colliders, road graph, ...).
import * as THREE from "three";
import { Bag, hexColor } from "./geo.js";
import { makeRng, makeNoise } from "./rng.js";
import { neonSignTex } from "./textures.js";

export const ROAD_W = 16;          // road width incl. sidewalks (the pack's road scaled to 16 m)
export const LANE = 2.9;           // lane center offset from the road center line
const FLOOR = 3.6;

const PASTELS = ["#ffd1dc", "#b8f2e6", "#aed9e0", "#ffe5b4", "#e0c3fc", "#c1f0c1", "#fbe7a1", "#ffc8a2", "#f7f7f7", "#9ee6e6"];
const GLASS_TINTS = ["#8fb6d9", "#9cc9c6", "#b7c4d1", "#7fa3c4", "#a7d0e8", "#c9b99a", "#9fb7a8"];
const OFFICE_TINTS = ["#ffffff", "#efe6d6", "#e2e2e2", "#f3dcc4", "#d9e4ec"];
const NEON = ["#ff3fa4", "#2ef2ff", "#b44bff", "#ffe23f", "#3fff9a", "#ff6b3f"];
const HOTEL_NAMES = ["Flamingo", "Coral", "Starlite", "Azure", "Neon Palms", "Riviera", "Sunset", "Breeze", "Pelican", "Tropic", "Marlin", "Lagoon", "Seabird", "Paradise"];

const SYL_A = ["Port", "Coral", "Palm", "Vista", "Sol", "Bay", "Isla", "Costa", "Sun", "Mar"];
const SYL_B = ["Solana", "Verde", "Haven", "Lucia", "Grande", "Dorado", "Marina", "Del Rey", "Azul", "Shores"];
export function cityName(seed) {
  const r = makeRng(seed ^ 0x5eed);
  return `${r.pick(SYL_A)} ${r.pick(SYL_B)}`;
}

export function generateCity(params, T, roadParts, mats) {
  const rng = makeRng(params.seed);
  const noise = makeNoise(params.seed + 1);
  const N = params.size;                       // blocks per side
  const L = roadParts.straightLen;             // block length between road edges
  const P = ROAD_W + L;                        // grid pitch
  const half = (N * P) / 2;
  const nodeX = (i) => i * P - half;
  const group = new THREE.Group();
  const colliders = [];                        // {x0,z0,x1,z1,h}
  const blocks = [];                           // for the minimap & peds
  const neonLights = [];                       // sign meshes to brighten at night

  // ---------- roads (instanced pack meshes) ----------
  const roadInst = (part, transforms) => {
    for (const { geometry, material } of part) {
      const im = new THREE.InstancedMesh(geometry, material, transforms.length);
      transforms.forEach((m, k) => im.setMatrixAt(k, m));
      im.receiveShadow = true;
      group.add(im);
    }
  };
  const mtx = (x, z, rot) => new THREE.Matrix4().makeRotationY(rot).setPosition(x, 0, z);
  const straights = [], xs = [], ts = [], ls = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i < N; i++) straights.push(mtx(nodeX(i) + P / 2, nodeX(j), 0));
  for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) straights.push(mtx(nodeX(i), nodeX(j) + P / 2, Math.PI / 2));
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = nodeX(i), z = nodeX(j), ei = i === 0 || i === N, ej = j === 0 || j === N;
    if (ei && ej) {
      const rot = i === 0 && j === 0 ? Math.PI / 2 : i === N && j === 0 ? 0 : i === N ? -Math.PI / 2 : Math.PI;
      ls.push(mtx(x, z, rot));
    } else if (ej) ts.push(mtx(x, z, j === 0 ? 0 : Math.PI));
    else if (ei) ts.push(mtx(x, z, i === 0 ? Math.PI / 2 : -Math.PI / 2));
    else xs.push(mtx(x, z, 0));
  }
  roadInst(roadParts.straight, straights);
  roadInst(roadParts.x, xs);
  if (ts.length) roadInst(roadParts.t, ts);
  roadInst(roadParts.l, ls);

  // ---------- districts ----------
  const dc = { i: rng.range(N * 0.25, N * 0.55), j: rng.range(N * 0.3, N * 0.7) };
  const district = (i, j) => {
    if (i === N - 1) return "beach";
    const d = Math.hypot(i + 0.5 - dc.i, j + 0.5 - dc.j) + (noise(i * 0.7, j * 0.7) - 0.5) * 1.2;
    const s = N / 10;
    if (d < 1.9 * s) return "downtown";
    if (d < 3.6 * s) return "midtown";
    return "residential";
  };

  // ---------- geometry bags ----------
  const bags = {};
  const bag = (k) => (bags[k] ||= new Bag());
  const palms = [];       // {x,z,h,lean,rot}
  const lamps = [];       // {x,z,rot}
  const signs = [];

  const fac = (kind) => T.facades[kind];
  const ground = (kind, x0, z0, x1, z1, y = 0.086) => bag("g_" + kind).top(x0, z0, x1, z1, y, { plaza: 3.5, grass: 4, pebbles: 2.5 }[kind] || 8, [1, 1, 1]);

  // A building made of stacked boxes (setbacks), with roof clutter and optional crown/spire.
  function building(kind, x0, z0, x1, z1, height, tint, opts = {}) {
    const f = fac(kind);
    const [tw, th] = f.tile;
    const col = hexColor(tint);
    const uo = rng.int(0, 7) * 0.25, vo = rng.int(0, 7) * 0.25;
    let y = 0, bx0 = x0, bz0 = z0, bx1 = x1, bz1 = z1;
    const floors = Math.max(1, Math.round(height / FLOOR));
    const tiers = opts.setbacks ? rng.int(1, 3) : 1;
    let remaining = floors;
    colliders.push({ x0, z0, x1, z1, h: floors * FLOOR });
    for (let t = 0; t < tiers; t++) {
      const fl = t === tiers - 1 ? remaining : Math.max(2, Math.round(remaining * rng.range(0.45, 0.7)));
      remaining -= fl;
      const y1 = y + fl * FLOOR;
      bag("f_" + kind).boxWalls(bx0, bz0, bx1, bz1, y, y1, tw, th, uo, vo + y / th, col);
      // ledge between tiers / roof parapet
      const lc = hexColor(kind === "glass" || kind === "glass2" ? "#d9dee3" : "#f2efe8");
      bag("trim").box(bx0 - 0.25, bz0 - 0.25, bx1 + 0.25, bz1 + 0.25, y1, y1 + 0.6, lc, 2);
      bag("roof").top(bx0, bz0, bx1, bz1, y1 + 0.05, 6, [1, 1, 1]);
      y = y1;
      if (t < tiers - 1) {
        const ix = (bx1 - bx0) * rng.range(0.1, 0.2), iz = (bz1 - bz0) * rng.range(0.1, 0.2);
        bx0 += ix; bx1 -= ix; bz0 += iz; bz1 -= iz;
      }
    }
    // roof clutter: AC units, a water tank or a stair house
    const cw = bx1 - bx0, cd = bz1 - bz0;
    const n = Math.floor(cw * cd / 120);
    for (let k = 0; k < Math.min(n, 5); k++) {
      const w = rng.range(1.5, 4), d = rng.range(1.5, 4);
      const cx = rng.range(bx0 + 1 + w / 2, bx1 - 1 - w / 2), cz = rng.range(bz0 + 1 + d / 2, bz1 - 1 - d / 2);
      if (cx !== cx || cz !== cz) continue;
      bag("trim").box(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, y, y + rng.range(1, 3), hexColor("#b9bcc0"), 2);
    }
    if (opts.spire) {
      const sw = Math.min(cw, cd) * 0.3, cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
      bag("f_" + kind).boxWalls(cx - sw, cz - sw, cx + sw, cz + sw, y, y + FLOOR * 3, tw, th, uo, vo, col);
      bag("roof").top(cx - sw, cz - sw, cx + sw, cz + sw, y + FLOOR * 3, 6, [1, 1, 1]);
      const sh = rng.range(12, 30);
      bag("trim").box(cx - 0.4, cz - 0.4, cx + 0.4, cz + 0.4, y + FLOOR * 3, y + FLOOR * 3 + sh, hexColor("#dfe3e6"), 2);
      bag("neon").box(cx - 0.6, cz - 0.6, cx + 0.6, cz + 0.6, y + FLOOR * 3 + sh, y + FLOOR * 3 + sh + 1, hexColor("#ff2020"), 2);
    }
    if (opts.neon) {
      const nc = hexColor(rng.pick(NEON));
      // neon outline along the roof edge and one vertical stripe
      const e = 0.18, yy = y + 0.6;
      bag("neon").box(x0 - 0.3, z1 + 0.25, x1 + 0.3, z1 + 0.25 + e, yy, yy + e, nc, 2);
      bag("neon").box(x0 - 0.3, z0 - 0.25 - e, x1 + 0.3, z0 - 0.25, yy, yy + e, nc, 2);
      bag("neon").box(x1 + 0.25, z0 - 0.3, x1 + 0.25 + e, z1 + 0.3, yy, yy + e, nc, 2);
      bag("neon").box(x0 - 0.25 - e, z0 - 0.3, x0 - 0.25, z1 + 0.3, yy, yy + e, nc, 2);
      bag("neon").box(x1 + 0.1, (z0 + z1) / 2 - 0.1, x1 + 0.3, (z0 + z1) / 2 + 0.1, 3, y, nc, 2);
    }
    return y;
  }

  function house(x0, z0, x1, z1, tint) {
    const f = fac("house");
    const col = hexColor(tint);
    const h = rng.chance(0.3) ? FLOOR * 2 : FLOOR;
    bag("f_house").boxWalls(x0, z0, x1, z1, 0, h, f.tile[0], f.tile[1], rng.int(0, 3) * 0.5, 0, col);
    colliders.push({ x0, z0, x1, z1, h: h + 3 });
    // gable roof along the longer side
    const rh = 2.6, o = 0.5, tc = [1, 1, 1];
    const b = bag("tile");
    if (x1 - x0 >= z1 - z0) {
      const zm = (z0 + z1) / 2;
      b.quad([x0 - o, h, z1 + o], [x1 + o, h, z1 + o], [x1 + o, h + rh, zm], [x0 - o, h + rh, zm], [0, 0], [(x1 - x0) / 4, 0], [(x1 - x0) / 4, 1.2], [0, 1.2], tc);
      b.quad([x1 + o, h, z0 - o], [x0 - o, h, z0 - o], [x0 - o, h + rh, zm], [x1 + o, h + rh, zm], [0, 0], [(x1 - x0) / 4, 0], [(x1 - x0) / 4, 1.2], [0, 1.2], tc);
      bag("f_house").tri([x0, h, z0], [x0, h, z1], [x0, h + rh, zm], [0, 0], [1, 0], [0.5, 0.6], col);
      bag("f_house").tri([x1, h, z1], [x1, h, z0], [x1, h + rh, zm], [0, 0], [1, 0], [0.5, 0.6], col);
    } else {
      const xm = (x0 + x1) / 2;
      b.quad([x1 + o, h, z1 + o], [x1 + o, h, z0 - o], [xm, h + rh, z0 - o], [xm, h + rh, z1 + o], [0, 0], [(z1 - z0) / 4, 0], [(z1 - z0) / 4, 1.2], [0, 1.2], tc);
      b.quad([x0 - o, h, z0 - o], [x0 - o, h, z1 + o], [xm, h + rh, z1 + o], [xm, h + rh, z0 - o], [0, 0], [(z1 - z0) / 4, 0], [(z1 - z0) / 4, 1.2], [0, 1.2], tc);
      bag("f_house").tri([x1, h, z0], [x0, h, z0], [xm, h + rh, z0], [0, 0], [1, 0], [0.5, 0.6], col);
      bag("f_house").tri([x0, h, z1], [x1, h, z1], [xm, h + rh, z1], [0, 0], [1, 0], [0.5, 0.6], col);
    }
  }

  const H = params.height;          // skyline multiplier
  const D = params.density;         // 0..1

  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const bx0 = nodeX(i) + ROAD_W / 2, bz0 = nodeX(j) + ROAD_W / 2, bx1 = bx0 + L, bz1 = bz0 + L;
    let kind = district(i, j);
    if (kind !== "beach" && rng.chance(0.07 + (1 - D) * 0.2)) kind = "park";
    blocks.push({ i, j, x0: bx0, z0: bz0, x1: bx1, z1: bz1, kind });
    const m = 3; // plaza margin

    if (kind === "park") {
      ground("grass", bx0, bz0, bx1, bz1);
      // paths crossing the park
      ground("pebbles", bx0, (bz0 + bz1) / 2 - 2, bx1, (bz0 + bz1) / 2 + 2, 0.1);
      ground("pebbles", (bx0 + bx1) / 2 - 2, bz0, (bx0 + bx1) / 2 + 2, bz1, 0.1);
      const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
      bag("trim").box(cx - 4, cz - 4, cx + 4, cz + 4, 0, 0.7, hexColor("#e8e2d4"), 2);
      bag("pool").top(cx - 3.4, cz - 3.4, cx + 3.4, cz + 3.4, 0.6, 4, [1, 1, 1]);
      colliders.push({ x0: cx - 4, z0: cz - 4, x1: cx + 4, z1: cz + 4, h: 0.7 });
      const np = Math.round(rng.int(8, 16) * params.palms);
      for (let k = 0; k < np; k++) palms.push({ x: rng.range(bx0 + 3, bx1 - 3), z: rng.range(bz0 + 3, bz1 - 3) });
      continue;
    }

    if (kind === "residential") {
      ground("grass", bx0, bz0, bx1, bz1);
      // houses in a ring facing the streets
      const per = rng.chance(0.5) ? 3 : 4, cell = L / per;
      for (let a = 0; a < per; a++) for (let b = 0; b < per; b++) {
        if (a > 0 && a < per - 1 && b > 0 && b < per - 1) {
          if (rng.chance(0.6)) { // backyard pool
            const cx = bx0 + (a + 0.5) * cell, cz = bz0 + (b + 0.5) * cell;
            bag("trim").box(cx - 4, cz - 2.5, cx + 4, cz + 2.5, 0, 0.15, hexColor("#f0ede6"), 2);
            bag("pool").top(cx - 3.3, cz - 1.9, cx + 3.3, cz + 1.9, 0.16, 4, [1, 1, 1]);
          }
          continue;
        }
        if (rng.chance(0.15 * (1 - D))) continue;
        const cx = bx0 + (a + 0.5) * cell, cz = bz0 + (b + 0.5) * cell;
        if (rng.chance(0.12 + D * 0.15)) {
          const s = cell * 0.4;
          building("brick", cx - s, cz - s, cx + s, cz + s, FLOOR * rng.int(2, 4), "#ffffff");
        } else {
          const w = rng.range(cell * 0.5, cell * 0.7), d = rng.range(cell * 0.5, cell * 0.7);
          house(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, rng.pick(PASTELS));
        }
        if (rng.chance(0.7 * params.palms)) palms.push({ x: cx + rng.range(-cell / 2 + 1.5, cell / 2 - 1.5), z: cz + (rng.chance(0.5) ? -1 : 1) * (cell / 2 - 1.5) });
      }
      continue;
    }

    ground("plaza", bx0, bz0, bx1, bz1);

    if (kind === "beach") {
      // art-deco hotels along the beach avenue, with neon at night
      const n = rng.int(2, 3), seg = L / n;
      for (let k = 0; k < n; k++) {
        const z0 = bz0 + k * seg + 1.5, z1 = bz0 + (k + 1) * seg - 1.5;
        const depth = rng.range(L * 0.45, L * 0.75);
        const x1 = bx1 - 4, x0 = x1 - depth;
        const h = FLOOR * Math.round(rng.range(3, 9) * Math.max(0.6, H));
        const top = building("deco", x0, z0, x1, z1, h, rng.pick(PASTELS), { neon: true });
        // name sign on the beach-facing facade
        const name = rng.pick(HOTEL_NAMES), color = rng.pick(NEON);
        signs.push({ x: x1 + 0.4, y: Math.min(top - 2, 10), z: (z0 + z1) / 2, name, color, w: Math.min(z1 - z0 - 2, 12) });
        if (rng.chance(0.8 * params.palms)) palms.push({ x: bx1 - 1.5, z: z0 + rng.range(0, z1 - z0) });
      }
      continue;
    }

    if (kind === "downtown") {
      const split = rng.chance(0.55) ? 2 : 1, cell = (L - m * 2) / split;
      for (let a = 0; a < split; a++) for (let b = 0; b < split; b++) {
        if (split === 2 && rng.chance(0.15 * (1 - D))) continue;
        const x0 = bx0 + m + a * cell + 1.5, z0 = bz0 + m + b * cell + 1.5;
        const x1 = x0 + cell - 3, z1 = z0 + cell - 3;
        const tall = rng.range(18, 60) * H * (split === 1 ? 1.4 : 1) * (0.6 + D * 0.6);
        const kindB = rng.chance(0.7) ? rng.pick(["glass", "glass2"]) : "office";
        building(kindB, x0, z0, x1, z1, tall * FLOOR, kindB === "office" ? rng.pick(OFFICE_TINTS) : rng.pick(GLASS_TINTS), { setbacks: rng.chance(0.6), spire: tall > 45 * H && rng.chance(0.6) });
      }
      if (rng.chance(0.4 * params.palms)) for (let k = 0; k < 4; k++) palms.push({ x: bx0 + 1.6 + (k % 2) * (L - 3.2), z: bz0 + 1.6 + (k >> 1) * (L - 3.2) });
      continue;
    }

    // midtown: mixed mid-rises
    const lots = rng.chance(0.5) ? 2 : 3, cell = (L - 2) / lots;
    for (let a = 0; a < lots; a++) for (let b = 0; b < 2; b++) {
      if (rng.chance(0.12 * (1 - D))) continue;
      const x0 = bx0 + 1 + a * cell + 1, x1 = x0 + cell - 2;
      const z0 = b === 0 ? bz0 + 2 : bz0 + L / 2 + 1, z1 = b === 0 ? bz0 + L / 2 - 1 : bz1 - 2;
      const r = rng.next();
      const kindB = r < 0.35 ? "brick" : r < 0.65 ? "office" : r < 0.85 ? "deco" : "glass2";
      const fl = rng.int(3, 14) * Math.max(0.5, H) * (0.6 + D * 0.6);
      const tint = kindB === "brick" ? "#ffffff" : kindB === "deco" ? rng.pick(PASTELS) : kindB === "office" ? rng.pick(OFFICE_TINTS) : rng.pick(GLASS_TINTS);
      building(kindB, x0, z0, x1, z1, fl * FLOOR, tint, { setbacks: fl > 9 && rng.chance(0.4), neon: kindB === "deco" && rng.chance(0.5) });
    }
  }

  // ---------- street lamps & traffic signals ----------
  for (let j = 0; j <= N; j++) for (let i = 0; i < N; i++) {
    const x = nodeX(i) + P / 2, z = nodeX(j);
    for (const s of [-1, 1]) for (const o of [-0.25, 0.25]) lamps.push({ x: x + o * L, z: z + s * (ROAD_W / 2 - 0.6), rot: s > 0 ? 0 : Math.PI });
  }
  for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) {
    const z = nodeX(j) + P / 2, x = nodeX(i);
    for (const s of [-1, 1]) for (const o of [-0.25, 0.25]) lamps.push({ x: x + s * (ROAD_W / 2 - 0.6), z: z + o * L, rot: s > 0 ? Math.PI / 2 : -Math.PI / 2 });
  }

  // ---------- land, seawall, beach ----------
  const landX0 = -half - 40, landX1 = half + ROAD_W / 2, landZ0 = -half - 40, landZ1 = half + 40;
  ground("grass", landX0, landZ0, landX1, -half - ROAD_W / 2, 0.02);
  ground("grass", landX0, half + ROAD_W / 2, landX1, landZ1, 0.02);
  ground("grass", landX0, -half - ROAD_W / 2, -half - ROAD_W / 2, half + ROAD_W / 2, 0.02);
  bag("wall").boxWalls(landX0, landZ0, landX1, landZ1, -8, 0.02, 6, 6, 0, 0, hexColor("#cfc6b4"));
  for (let k = 0; k < 40 * params.palms; k++) {
    const side = rng.int(0, 2);
    if (side === 0) palms.push({ x: rng.range(landX0 + 4, landX1), z: rng.range(landZ0 + 4, -half - ROAD_W / 2 - 3) });
    else if (side === 1) palms.push({ x: rng.range(landX0 + 4, landX1), z: rng.range(half + ROAD_W / 2 + 3, landZ1 - 4) });
    else palms.push({ x: rng.range(landX0 + 4, -half - ROAD_W / 2 - 3), z: rng.range(landZ0 + 4, landZ1 - 4) });
  }

  // beach: a sloped strip with a wavy shoreline east of the beach avenue
  const beachW = 160, segX = 40, segZ = 120;
  const beachGeo = new THREE.PlaneGeometry(beachW, landZ1 - landZ0 + 400, segX, segZ);
  beachGeo.rotateX(-Math.PI / 2);
  const bp = beachGeo.attributes.position;
  const shore = (z) => (noise(z * 0.008, 3.3) - 0.5) * 50 + (noise(z * 0.03, 7.7) - 0.5) * 10;
  for (let k = 0; k < bp.count; k++) {
    const lx = bp.getX(k) + beachW / 2, z = bp.getZ(k) + (landZ0 + landZ1) / 2;
    const t = lx / beachW;
    let y = 0.03 - Math.max(0, (lx - 55 - shore(z) * 0.6)) * 0.035;
    if (t > 0.98) y -= 4;
    const zEdge = Math.max(0, Math.abs(z - (landZ0 + landZ1) / 2) - (landZ1 - landZ0) / 2);
    y -= zEdge * 0.05;
    bp.setXYZ(k, landX1 + lx, Math.max(y, -6), z);
  }
  beachGeo.computeVertexNormals();
  const uvA = beachGeo.attributes.uv;
  for (let k = 0; k < uvA.count; k++) uvA.setXY(k, bp.getX(k) / 10, bp.getZ(k) / 10);
  const beach = new THREE.Mesh(beachGeo, mats.sand);
  beach.receiveShadow = true;
  group.add(beach);
  const beachY = (x, z) => {
    const lx = x - landX1;
    return 0.03 - Math.max(0, lx - 55 - shore(z) * 0.6) * 0.035;
  };
  const shoreX = (z) => landX1 + 55 + shore(z) * 0.6 + 1.2 / 0.035; // where sand meets the water (y=-1.2)

  // beach palms + promenade lamps
  for (let k = 0; k < 70 * params.palms; k++) {
    const z = rng.range(landZ0, landZ1), x = landX1 + rng.range(3, 45);
    palms.push({ x, z, y: beachY(x, z) });
  }
  // lifeguard towers (pastel little huts on stilts)
  for (let z = -half; z < half; z += rng.range(90, 160)) {
    const x = landX1 + 62 + shore(z) * 0.3, y = beachY(x, z);
    const c = hexColor(rng.pick(["#ff8fab", "#7bdff2", "#f7d046", "#b2f7ef"]));
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bag("trim").box(x + dx * 1.3 - 0.1, z + dz * 1.3 - 0.1, x + dx * 1.3 + 0.1, z + dz * 1.3 + 0.1, y - 1, y + 2.2, hexColor("#e8e2d4"), 2);
    bag("trim").box(x - 1.6, z - 1.6, x + 1.6, z + 1.6, y + 2.2, y + 2.4, hexColor("#e8e2d4"), 2);
    bag("trim").box(x - 1.3, z - 1.3, x + 1.3, z + 1.3, y + 2.4, y + 4.4, c, 2);
    bag("tile").box(x - 1.7, z - 1.7, x + 1.7, z + 1.7, y + 4.4, y + 4.7, [1, 1, 1], 2);
    colliders.push({ x0: x - 1.6, z0: z - 1.6, x1: x + 1.6, z1: z + 1.6, h: 5 });
  }

  // little offshore islands
  const islands = [];
  for (let k = 0; k < 3; k++) {
    const x = landX1 + beachW + rng.range(80, 300), z = rng.range(-half, half), r = rng.range(18, 40);
    const g = new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, 0.09, rng.range(0.7, 1.3));
    const isl = new THREE.Mesh(g, mats.sand);
    isl.position.set(x, -1.5, z);
    isl.receiveShadow = true;
    group.add(isl);
    islands.push({ x, z, r });
    for (let p = 0; p < 6 * params.palms; p++) {
      const a = rng.next() * Math.PI * 2, d = rng.next() * r * 0.5;
      palms.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, y: 0.2 });
    }
  }

  // ---------- materialize bags ----------
  for (const [key, b] of Object.entries(bags)) {
    if (b.empty) continue;
    const mesh = new THREE.Mesh(b.geometry(), mats.forKey(key));
    mesh.castShadow = key.startsWith("f_") || key === "trim" || key === "tile";
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // hotel signs
  for (const s of signs) {
    const m = new THREE.MeshBasicMaterial({ map: neonSignTex(s.name, s.color), color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.w / 4), m);
    sign.position.set(s.x, s.y, s.z);
    sign.rotation.y = Math.PI / 2;
    group.add(sign);
    neonLights.push(m);
  }

  // ---------- palms & lamps (instanced) ----------
  // lamp posts and palm trunks are solid too
  for (const l of lamps) colliders.push({ x0: l.x - 0.18, z0: l.z - 0.18, x1: l.x + 0.18, z1: l.z + 0.18, h: 7, thin: true });
  for (const p of palms) colliders.push({ x0: p.x - 0.3, z0: p.z - 0.3, x1: p.x + 0.3, z1: p.z + 0.3, h: 8, thin: true });
  const palmMeshes = mats.palms(palms.map((p) => ({ ...p, y: p.y ?? 0.08 })), rng);
  palmMeshes.forEach((m) => group.add(m));
  const lampMeshes = mats.lamps(lamps);
  lampMeshes.forEach((m) => group.add(m));

  // ---------- road graph for traffic ----------
  const nodes = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) nodes.push({ i, j, x: nodeX(i), z: nodeX(j), nb: [] });
  const nid = (i, j) => j * (N + 1) + i;
  for (const n of nodes) {
    if (n.i > 0) n.nb.push(nid(n.i - 1, n.j));
    if (n.i < N) n.nb.push(nid(n.i + 1, n.j));
    if (n.j > 0) n.nb.push(nid(n.i, n.j - 1));
    if (n.j < N) n.nb.push(nid(n.i, n.j + 1));
  }

  // spawn on the beach avenue sidewalk near the middle
  const spawn = new THREE.Vector3(half + ROAD_W / 2 - 1.2, 0.1, nodeX(Math.floor(N / 2)) + P / 2);

  return {
    group, colliders, blocks, nodes, nodeX, N, P, L, half,
    spawn, neonLights, islands,
    bounds: { x0: landX0, z0: landZ0, x1: landX1, z1: landZ1 },
    beachY, shoreX, landX1,
    downtown: { x: nodeX(0) + dc.i * P, z: nodeX(0) + dc.j * P },
  };
}

// Spatial hash over building footprints for fast collision queries.
export class ColliderGrid {
  constructor(colliders, cell = 32) {
    this.cell = cell; this.map = new Map(); this.list = colliders;
    colliders.forEach((c, k) => {
      for (let x = Math.floor(c.x0 / cell); x <= Math.floor(c.x1 / cell); x++)
        for (let z = Math.floor(c.z0 / cell); z <= Math.floor(c.z1 / cell); z++) {
          const key = x * 73856093 ^ z * 19349663;
          let a = this.map.get(key);
          if (!a) this.map.set(key, (a = []));
          a.push(k);
        }
    });
  }
  near(x, z, r) {
    const out = new Set(), c = this.cell;
    for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++)
      for (let gz = Math.floor((z - r) / c); gz <= Math.floor((z + r) / c); gz++) {
        const a = this.map.get(gx * 73856093 ^ gz * 19349663);
        if (a) for (const k of a) out.add(this.list[k]);
      }
    return out;
  }
  // Push a circle out of any box it overlaps. Returns the collision normal or null.
  resolveCircle(pos, r, y = 0) {
    let hit = null;
    for (const b of this.near(pos.x, pos.z, r + 1)) {
      if (y > b.h) continue;
      const cx = Math.max(b.x0, Math.min(pos.x, b.x1)), cz = Math.max(b.z0, Math.min(pos.z, b.z1));
      let dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 < 1e-8) {
        // center inside the box: push out the shortest way
        const opts = [[pos.x - b.x0, -1, 0], [b.x1 - pos.x, 1, 0], [pos.z - b.z0, 0, -1], [b.z1 - pos.z, 0, 1]].sort((a, c) => a[0] - c[0]);
        const [dist, nx, nz] = opts[0];
        pos.x += nx * (dist + r); pos.z += nz * (dist + r);
        hit = { x: nx, z: nz };
      } else {
        const d = Math.sqrt(d2);
        dx /= d; dz /= d;
        pos.x += dx * (r - d); pos.z += dz * (r - d);
        hit = { x: dx, z: dz };
      }
    }
    return hit;
  }
  // Is the point inside a building (used to keep the camera out of walls)?
  inside(x, y, z) {
    for (const b of this.near(x, z, 0.5)) if (!b.thin && x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y < b.h) return true;
    return false;
  }
}
