// Rotating minimap (bottom-left) and the full-screen map (M / Tab).
import { ROAD_W } from "./city.js";

export class Minimap {
  constructor(city, mini, big, name) {
    this.city = city; this.mini = mini; this.big = big; this.name = name;
    const b = city.bounds;
    this.ox = b.x0 - 80; this.oz = b.z0 - 80;
    const w = city.landX1 + 330 - this.ox, h = b.z1 + 80 - this.oz;
    const k = (this.k = 1); // px per meter
    const c = (this.map = document.createElement("canvas"));
    c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
    const x = c.getContext("2d");
    const X = (v) => (v - this.ox) * k, Z = (v) => (v - this.oz) * k;
    x.fillStyle = "#1f6a86"; x.fillRect(0, 0, c.width, c.height);
    // beach with its wavy shoreline
    x.fillStyle = "#d9c08a";
    x.beginPath(); x.moveTo(X(city.landX1), Z(b.z0 - 80));
    for (let z = b.z0 - 80; z <= b.z1 + 80; z += 8) x.lineTo(X(city.shoreX(z)), Z(z));
    x.lineTo(X(city.landX1), Z(b.z1 + 80)); x.fill();
    for (const isl of city.islands) { x.beginPath(); x.arc(X(isl.x), Z(isl.z), isl.r * 0.8 * k, 0, 7); x.fill(); }
    x.fillStyle = "#2d343b"; x.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    const fill = { park: "#2f6b3f", residential: "#36513c", downtown: "#3a4048", midtown: "#383e45", beach: "#3e3a44", lot: "#3b4047", showroom: "#5a3a52" };
    for (const bl of city.blocks) { x.fillStyle = fill[bl.kind]; x.fillRect(X(bl.x0), Z(bl.z0), (bl.x1 - bl.x0) * k, (bl.z1 - bl.z0) * k); }
    x.fillStyle = "#1c2126";
    for (const cl of city.colliders) if (cl.h > 2 && !cl.thin) x.fillRect(X(cl.x0), Z(cl.z0), (cl.x1 - cl.x0) * k, (cl.z1 - cl.z0) * k);
    // roads
    x.fillStyle = "#8a96a3";
    const n = city.N, lo = city.nodeX(0), hi = city.nodeX(n);
    for (let i = 0; i <= n; i++) {
      const v = city.nodeX(i);
      x.fillRect(X(v - ROAD_W * 0.35), Z(lo - ROAD_W * 0.35), ROAD_W * 0.7 * k, (hi - lo + ROAD_W * 0.7) * k);
      x.fillRect(X(lo - ROAD_W * 0.35), Z(v - ROAD_W * 0.35), (hi - lo + ROAD_W * 0.7) * k, ROAD_W * 0.7 * k);
    }
  }

  draw(pos, camYaw, heading, cars, hours) {
    const c = this.mini, x = c.getContext("2d");
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    const s = 1.1;
    x.save();
    x.translate(W / 2, H * 0.62);
    x.rotate(camYaw);
    x.scale(s, s);
    x.drawImage(this.map, -(pos.x - this.ox) * this.k, -(pos.z - this.oz) * this.k);
    x.restore();
    // player arrow (map is rotated so the camera looks "up")
    x.save();
    x.translate(W / 2, H * 0.62);
    x.rotate(camYaw + Math.PI - heading);
    x.fillStyle = "#fff"; x.strokeStyle = "rgba(0,0,0,.6)"; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, -9); x.lineTo(6.5, 7); x.lineTo(0, 3.5); x.lineTo(-6.5, 7); x.closePath(); x.stroke(); x.fill();
    x.restore();
    // north marker on the rim
    const a = camYaw - Math.PI / 2; // world -z (north) direction after rotation
    const r = Math.min(W, H) * 0.44;
    const nx = W / 2 + Math.cos(a) * r, ny = H * 0.62 + Math.sin(a) * r;
    x.fillStyle = "rgba(0,0,0,.65)"; x.beginPath(); x.arc(Math.max(10, Math.min(W - 10, nx)), Math.max(10, Math.min(H - 10, ny)), 8, 0, 7); x.fill();
    x.fillStyle = "#fff"; x.font = "bold 10px Inter, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("N", Math.max(10, Math.min(W - 10, nx)), Math.max(10, Math.min(H - 10, ny)) + 0.5);
    if (this.big.offsetParent) this.drawBig(pos, heading);
  }

  drawBig(pos, heading, canvas = this.big) {
    const c = canvas, x = c.getContext("2d");
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = Math.min(W / this.map.width, H / this.map.height) * 0.96;
    const ox = (W - this.map.width * s) / 2, oy = (H - this.map.height * s) / 2;
    x.fillStyle = "#1f6a86"; x.fillRect(0, 0, W, H);
    x.drawImage(this.map, ox, oy, this.map.width * s, this.map.height * s);
    const P = (wx, wz) => [ox + (wx - this.ox) * s, oy + (wz - this.oz) * s];
    x.font = "600 13px Inter, sans-serif"; x.textAlign = "center"; x.fillStyle = "rgba(255,255,255,.85)";
    const d = P(this.city.downtown.x, this.city.downtown.z); x.fillText("DOWNTOWN", d[0], d[1]);
    const bch = P(this.city.landX1 + 50, 0); x.save(); x.translate(bch[0], bch[1]); x.rotate(Math.PI / 2); x.fillStyle = "#5a4a20"; x.fillText("B E A C H", 0, 0); x.restore();
    x.font = "italic 700 30px Georgia, serif"; x.fillStyle = "#fff"; x.textAlign = "left";
    x.fillText(this.name, 24, 44);
    const [px, pz] = P(pos.x, pos.z);
    x.save(); x.translate(px, pz); x.rotate(Math.PI - heading);
    x.fillStyle = "#ff4f8b"; x.strokeStyle = "#fff"; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, -11); x.lineTo(8, 9); x.lineTo(0, 4); x.lineTo(-8, 9); x.closePath(); x.fill(); x.stroke();
    x.restore();
  }
}
