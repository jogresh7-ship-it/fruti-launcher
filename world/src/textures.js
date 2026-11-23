// Canvas-painted textures: building facades (with night-time window glow), ground, palm leaves, water normals.
import * as THREE from "three";
import { makeRng } from "./rng.js";

function canvas(w, h = w) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")];
}

function tex(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

function grain(ctx, w, h, amount, rng, alpha = 0.08) {
  for (let i = 0; i < amount; i++) {
    const v = rng.next() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rng.next()})`;
    ctx.fillRect(rng.next() * w, rng.next() * h, 1 + rng.next() * 2, 1 + rng.next() * 2);
  }
}

// Emissive window colors at night: mostly warm, some cool office light, many dark.
function litColor(rng) {
  const r = rng.next();
  if (r < 0.55) return null;
  if (r < 0.75) return `hsl(${35 + rng.next() * 12},${70 + rng.next() * 20}%,${55 + rng.next() * 20}%)`;
  if (r < 0.92) return `hsl(${190 + rng.next() * 30},40%,${70 + rng.next() * 15}%)`;
  return `hsl(${300 + rng.next() * 40},80%,65%)`;
}

// A facade tile = cols x rows windows. Returns { map, rough (G=roughness,B=metalness), emissive, normal? , tile:[w,h] meters }
function facade(kind, seed, pbr) {
  const rng = makeRng(seed);
  const S = 512;
  const [cm, m] = canvas(S), [cr, r] = canvas(S), [ce, e] = canvas(S);
  const holes = []; // window rects: flattened in the normal map
  // Tile a scanned PBR set (diffuse + ARM: G=roughness, B=metalness) n x n under the windows.
  const base = (n) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      m.drawImage(pbr.diff, x * S / n, y * S / n, S / n + 1, S / n + 1);
      r.drawImage(pbr.arm, x * S / n, y * S / n, S / n + 1, S / n + 1);
    }
    out.n = n;
  };
  const out = {};
  e.fillStyle = "#000"; e.fillRect(0, 0, S, S);
  let cols, rows, tile;

  if (kind === "glass") {
    cols = 4; rows = 4; tile = [12, 14.4];
    const cw = S / cols, rh = S / rows;
    m.fillStyle = "#c9d3dc"; m.fillRect(0, 0, S, S);
    r.fillStyle = "rgb(0,150,40)"; r.fillRect(0, 0, S, S);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const px = x * cw, py = y * rh;
      const g = m.createLinearGradient(px, py, px + cw, py + rh);
      const base = 90 + rng.next() * 40;
      g.addColorStop(0, `rgb(${base * 0.55},${base * 0.75},${base})`);
      g.addColorStop(1, `rgb(${base * 0.35},${base * 0.5},${base * 0.75})`);
      m.fillStyle = g; m.fillRect(px + 4, py + 6, cw - 8, rh - 14);
      r.fillStyle = "rgb(0,18,230)"; r.fillRect(px + 4, py + 6, cw - 8, rh - 14);
      const lc = litColor(rng);
      if (lc) { e.fillStyle = lc; e.globalAlpha = 0.6 + rng.next() * 0.4; e.fillRect(px + 6, py + 8, cw - 12, rh - 18); e.globalAlpha = 1; }
      // mullion in the middle of each bay
      m.fillStyle = "#aeb8c2"; m.fillRect(px + cw / 2 - 1.5, py, 3, rh);
      r.fillStyle = "rgb(0,120,60)"; r.fillRect(px + cw / 2 - 1.5, py, 3, rh);
    }
  } else if (kind === "office") {
    cols = 4; rows = 4; tile = [12, 14.4];
    const cw = S / cols, rh = S / rows;
    m.fillStyle = "#e6e1d6"; m.fillRect(0, 0, S, S);
    grain(m, S, S, 9000, rng, 0.12);
    r.fillStyle = "rgb(0,220,0)"; r.fillRect(0, 0, S, S);
    for (let y = 0; y < rows; y++) {
      const py = y * rh;
      // ribbon window along the whole floor
      m.fillStyle = "#3d4a57"; m.fillRect(0, py + rh * 0.28, S, rh * 0.5);
      r.fillStyle = "rgb(0,30,200)"; r.fillRect(0, py + rh * 0.28, S, rh * 0.5);
      for (let x = 0; x < cols; x++) {
        const lc = litColor(rng);
        if (lc) { e.fillStyle = lc; e.fillRect(x * cw + 2, py + rh * 0.3, cw - 4, rh * 0.46); }
        m.fillStyle = "#cfc8bb"; m.fillRect(x * cw - 3, py + rh * 0.28, 6, rh * 0.5);
      }
      m.fillStyle = "rgba(0,0,0,0.18)"; m.fillRect(0, py + rh * 0.78, S, 4);
    }
  } else if (kind === "deco") {
    // Pastel art-deco stucco: tinted by vertex color, so the base stays near white.
    cols = 3; rows = 4; tile = [10.5, 14.4];
    const cw = S / cols, rh = S / rows;
    base(2);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const px = x * cw, py = y * rh, ww = cw * 0.56, wh = rh * 0.52;
      const wx = px + (cw - ww) / 2, wy = py + rh * 0.24;
      // eyebrow ledge shadow + ledge
      m.fillStyle = "rgba(0,0,0,0.22)"; m.fillRect(wx - 10, wy - 4, ww + 20, 10);
      m.fillStyle = "#ffffff"; m.fillRect(wx - 12, wy - 12, ww + 24, 8);
      m.fillStyle = "#33505e"; m.fillRect(wx, wy, ww, wh); holes.push([wx - 12, wy - 12, ww + 24, wh + 12]);
      m.fillStyle = "#e9f3f5"; m.fillRect(wx + ww / 2 - 2, wy, 4, wh); m.fillRect(wx, wy + wh / 2 - 2, ww, 4);
      r.fillStyle = "rgb(0,40,160)"; r.fillRect(wx, wy, ww, wh);
      const lc = litColor(rng);
      if (lc) { e.fillStyle = lc; e.fillRect(wx + 2, wy + 2, ww - 4, wh - 4); }
    }
    for (let y = 0; y < rows; y++) { m.fillStyle = "rgba(0,0,0,0.08)"; m.fillRect(0, y * rh + rh - 6, S, 6); }
  } else if (kind === "brick") {
    cols = 2; rows = 2; tile = [7, 7.2];
    const cw = S / cols, rh = S / rows;
    base(3);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const ww = cw * 0.42, wh = rh * 0.55, wx = x * cw + (cw - ww) / 2, wy = y * rh + rh * 0.2;
      m.fillStyle = "#d8d2c4"; m.fillRect(wx - 6, wy - 6, ww + 12, wh + 16); // stone surround
      holes.push([wx - 6, wy - 6, ww + 12, wh + 16]);
      m.fillStyle = "#1f2a30"; m.fillRect(wx, wy, ww, wh);
      m.fillStyle = "#efeae0"; m.fillRect(wx + ww / 2 - 2, wy, 4, wh); m.fillRect(wx, wy + wh * 0.45, ww, 4);
      r.fillStyle = "rgb(255,40,180)"; r.fillRect(wx, wy, ww, wh);
      r.fillStyle = "rgb(255,200,0)"; r.fillRect(wx - 6, wy + wh, ww + 12, 10);
      const lc = litColor(rng);
      if (lc) { e.fillStyle = lc; e.fillRect(wx + 2, wy + 2, ww - 4, wh - 4); }
    }
  } else if (kind === "house") {
    cols = 2; rows = 1; tile = [8, 3.6];
    const cw = S / cols;
    base(2);
    for (let x = 0; x < cols; x++) {
      const ww = cw * 0.45, wh = S * 0.45, wx = x * cw + (cw - ww) / 2, wy = S * 0.25;
      m.fillStyle = "#ffffff"; m.fillRect(wx - 10, wy - 10, ww + 20, wh + 20);
      holes.push([wx - 34, wy - 10, ww + 68, wh + 20]);
      m.fillStyle = "#2c4652"; m.fillRect(wx, wy, ww, wh);
      m.fillStyle = "#3f7c6e"; m.fillRect(wx - 34, wy - 4, 22, wh + 8); m.fillRect(wx + ww + 12, wy - 4, 22, wh + 8); // shutters
      r.fillStyle = "rgb(0,40,120)"; r.fillRect(wx, wy, ww, wh);
      const lc = litColor(rng);
      if (lc) { e.fillStyle = lc; e.fillRect(wx, wy, ww, wh); }
    }
  }

  Object.assign(out, { map: tex(cm), rough: tex(cr, { srgb: false }), emissive: tex(ce), tile });
  if (out.n) {
    const [cn, n] = canvas(S), k = out.n;
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) n.drawImage(pbr.nor, x * S / k, y * S / k, S / k + 1, S / k + 1);
    n.fillStyle = "rgb(128,128,255)";
    for (const [x, y, w, h] of holes) n.fillRect(x, y, w, h);
    out.normal = tex(cn, { srgb: false });
  }
  return out;
}

function groundTex(kind, seed) {
  const rng = makeRng(seed);
  const S = 512;
  const [c, x] = canvas(S);
  if (kind === "grass") {
    x.fillStyle = "#5f8f3a"; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 26000; i++) {
      const h = 80 + rng.next() * 30, l = 26 + rng.next() * 22;
      x.fillStyle = `hsla(${h},45%,${l}%,0.5)`;
      x.fillRect(rng.next() * S, rng.next() * S, 1.5, 2 + rng.next() * 4);
    }
  } else if (kind === "sand") {
    x.fillStyle = "#cdb487"; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 40000; i++) {
      const l = 58 + rng.next() * 22;
      x.fillStyle = `hsla(${38 + rng.next() * 8},45%,${l}%,0.55)`;
      x.fillRect(rng.next() * S, rng.next() * S, 1.2, 1.2);
    }
  } else if (kind === "plaza") {
    x.fillStyle = "#cfc9be"; x.fillRect(0, 0, S, S);
    grain(x, S, S, 20000, rng, 0.1);
    x.strokeStyle = "rgba(90,80,70,0.35)"; x.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      x.beginPath(); x.moveTo(i * S / 8, 0); x.lineTo(i * S / 8, S); x.stroke();
      x.beginPath(); x.moveTo(0, i * S / 8); x.lineTo(S, i * S / 8); x.stroke();
    }
  } else if (kind === "roof") {
    x.fillStyle = "#8d8b86"; x.fillRect(0, 0, S, S);
    grain(x, S, S, 30000, rng, 0.18);
    x.strokeStyle = "rgba(40,40,40,0.25)"; x.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4, S); x.stroke(); }
  } else if (kind === "tile") {
    // terracotta roof tiles
    x.fillStyle = "#b8573a"; x.fillRect(0, 0, S, S);
    for (let y = 0; y < 16; y++) for (let i = 0; i < 16; i++) {
      const l = 38 + rng.next() * 12;
      x.fillStyle = `hsl(${14 + rng.next() * 8},55%,${l}%)`;
      x.fillRect(i * 32 + (y % 2) * 16, y * 32, 30, 28);
      x.fillStyle = "rgba(0,0,0,0.25)"; x.fillRect(i * 32 + (y % 2) * 16, y * 32 + 26, 30, 6);
    }
  }
  return tex(c);
}

function palmLeafTex() {
  const [c, x] = canvas(256, 512);
  x.clearRect(0, 0, 256, 512);
  // central rib along the length (v), leaflets going out both sides
  for (let i = 0; i < 60; i++) {
    const t = i / 60, y = 20 + t * 480, len = 120 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
    const hue = 85 + Math.random() * 25, l = 22 + Math.random() * 16;
    x.strokeStyle = `hsl(${hue},55%,${l}%)`; x.lineWidth = 5;
    for (const s of [-1, 1]) {
      x.beginPath(); x.moveTo(128, y);
      x.quadraticCurveTo(128 + s * len * 0.6, y + 6, 128 + s * len, y + 30 + t * 20);
      x.stroke();
    }
  }
  x.strokeStyle = "#7a6a3a"; x.lineWidth = 6;
  x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 512); x.stroke();
  const t = tex(c, { repeat: false });
  return t;
}

function waterNormals() {
  // Tileable normal map from summed sine waves with integer frequencies.
  const S = 256;
  const [c, x] = canvas(S);
  const img = x.createImageData(S, S);
  const rng = makeRng(77);
  const waves = Array.from({ length: 14 }, () => ({
    fx: rng.int(-9, 9), fy: rng.int(-9, 9), ph: rng.next() * 6.28, a: 0.3 + rng.next(),
  })).filter((w) => w.fx || w.fy);
  const h = (u, v) => waves.reduce((s, w) => s + w.a * Math.sin(2 * Math.PI * (w.fx * u + w.fy * v) + w.ph) / Math.hypot(w.fx, w.fy), 0);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = i / S, v = j / S, e = 1 / S;
    const dx = (h(u + e, v) - h(u - e, v)) * 1.2, dy = (h(u, v + e) - h(u, v - e)) * 1.2;
    const n = new THREE.Vector3(-dx, -dy, 1).normalize();
    const k = (j * S + i) * 4;
    img.data[k] = (n.x * 0.5 + 0.5) * 255; img.data[k + 1] = (n.y * 0.5 + 0.5) * 255; img.data[k + 2] = (n.z * 0.5 + 0.5) * 255; img.data[k + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return tex(c, { srgb: false });
}

export function neonSignTex(text, color) {
  const [c, x] = canvas(512, 128);
  x.fillStyle = "#000"; x.fillRect(0, 0, 512, 128);
  x.font = "italic 700 78px Georgia, serif";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.shadowColor = color; x.shadowBlur = 18;
  x.fillStyle = color; x.fillText(text, 256, 68);
  x.shadowBlur = 0; x.fillStyle = "#fff"; x.globalAlpha = 0.65; x.fillText(text, 256, 68);
  return tex(c, { repeat: false });
}

async function loadImg(src) {
  const i = new Image();
  i.src = src;
  await i.decode();
  return i;
}

// A scanned PBR set as three textures (diffuse sRGB, normal + ARM linear).
function pbrSet(imgs) {
  const t = (img, srgb) => {
    const x = new THREE.Texture(img);
    if (srgb) x.colorSpace = THREE.SRGBColorSpace;
    x.wrapS = x.wrapT = THREE.RepeatWrapping;
    x.anisotropy = 8;
    x.needsUpdate = true;
    return x;
  };
  return { map: t(imgs.diff, true), normal: t(imgs.nor, false), arm: t(imgs.arm, false) };
}

export async function buildTextures(sets) {
  const load = async (s) => ({ diff: await loadImg(s.diff), nor: await loadImg(s.nor), arm: await loadImg(s.arm) });
  const img = {};
  for (const [k, v] of Object.entries(sets)) img[k] = await load(v);
  const brick = img.brick;
  return {
    facades: {
      glass: facade("glass", 11),
      glass2: facade("glass", 12),
      office: facade("office", 21),
      deco: facade("deco", 31, img.stucco),
      brick: facade("brick", 41, brick),
      house: facade("house", 51, img.stucco2),
    },
    ground: {
      grassPbr: pbrSet(img.grass),
      pavers: pbrSet(img.pavers),
      pebbles: pbrSet(img.pebbles),
      grass: groundTex("grass", 1),
      sand: groundTex("sand", 2),
      plaza: groundTex("plaza", 3),
      roof: groundTex("roof", 4),
      tile: groundTex("tile", 5),
    },
    palmLeaf: palmLeafTex(),
    waterNormals: waterNormals(),
  };
}
