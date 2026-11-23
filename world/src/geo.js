// Small helpers for building merged, non-indexed geometry with world-scale UVs and vertex colors.
import * as THREE from "three";

export class Bag {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; }

  tri(a, b, c, ua, ub, uc, col) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2], nz = ab[0] * ac[1] - ab[1] * ac[0];
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(...a, ...b, ...c);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.u.push(...ua, ...ub, ...uc);
    this.c.push(...col, ...col, ...col);
  }

  // Quad from 4 points in counter-clockwise order (as seen from the front).
  quad(a, b, c, d, ua, ub, uc, ud, col) {
    this.tri(a, b, c, ua, ub, uc, col);
    this.tri(a, c, d, ua, uc, ud, col);
  }

  // Vertical wall from (ax,az) to (bx,bz); its outward normal is on the right when walking a->b... see box().
  wall(ax, az, bx, bz, y0, y1, tw, th, uo, vo, col) {
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = uo, u1 = uo + len / tw, v0 = vo + 0, v1 = vo + (y1 - y0) / th;
    this.quad([bx, y0, bz], [ax, y0, az], [ax, y1, az], [bx, y1, bz], [u0, v0], [u1, v0], [u1, v1], [u0, v1], col);
  }

  // Axis-aligned box walls (no top/bottom). Walls get world-scale UVs.
  boxWalls(x0, z0, x1, z1, y0, y1, tw, th, uo, vo, col) {
    this.wall(x1, z1, x0, z1, y0, y1, tw, th, uo, vo, col);
    this.wall(x0, z1, x0, z0, y0, y1, tw, th, uo + 0.37, vo, col);
    this.wall(x0, z0, x1, z0, y0, y1, tw, th, uo + 0.61, vo, col);
    this.wall(x1, z0, x1, z1, y0, y1, tw, th, uo + 0.13, vo, col);
  }

  top(x0, z0, x1, z1, y, ts, col) {
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
      [x0 / ts, z0 / ts], [x0 / ts, z1 / ts], [x1 / ts, z1 / ts], [x1 / ts, z0 / ts], col);
  }

  // Solid box with top (and walls), UVs in meters / ts.
  box(x0, z0, x1, z1, y0, y1, col, ts = 4) {
    this.boxWalls(x0, z0, x1, z1, y0, y1, ts, ts, 0, 0, col);
    this.top(x0, z0, x1, z1, y1, ts, col);
  }

  get empty() { return this.p.length === 0; }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

export function hexColor(h) {
  const c = new THREE.Color(h).convertSRGBToLinear();
  return [c.r, c.g, c.b];
}
