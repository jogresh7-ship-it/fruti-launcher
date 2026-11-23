// Physics world (Rapier 3D, WASM): loaded once in the background, then shared by every ragdoll.
// The world is stepped at a fixed 240 Hz; static colliders mirror the floor and the terrain.

// Bundled (WASM embedded), so the ragdoll works offline.
import RAPIER from '@dimforge/rapier3d-compat';
export const STEP = 1 / 240;

let rapierPromise = null;
/** Rapier, initialised (cached). Pass a module to use instead of the CDN (tests). */
export function loadRapier(mod) {
  return (rapierPromise ||= (async () => {
    const R = mod || RAPIER;
    await R.init();
    return R;
  })());
}

export class Physics {
  constructor(R, terrain) {
    this.R = R;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.world.numSolverIterations = 16; // more stable contact resolution across the articulated body
    this.acc = 0;
    // Excluded collider pairs (self-collision filter). Handles are float-encoded indices, so each gets
    // a small integer id for the pair key.
    this.pairs = new Set();
    this.ids = new Map();
    this.nextId = 0;
    const id = (h) => { let i = this.ids.get(h); if (i === undefined) this.ids.set(h, (i = this.nextId++)); return i; };
    this._key = (a, b) => { const i = id(a), j = id(b); return i < j ? i * 100003 + j : j * 100003 + i; };
    this.hooks = {
      filterContactPair: (c1, c2) => (this.pairs.has(this._key(c1, c2)) ? null : R.SolverFlags.COMPUTE_IMPULSE),
      filterIntersectionPair: () => true,
    };
    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    // Floor: a thick slab whose top is y = 0.
    // (As wide as the map's ground: the desert and the runway run out to ≈ 2 km.)
    this.world.createCollider(R.ColliderDesc.cuboid(2500, 1, 2500).setTranslation(0, -1, 0).setFriction(0.9), fixed);
    if (terrain) {
      for (const b of terrain.boxes) {
        const y0 = b.y0 ?? 0;
        // per-surface feel: b.friction (ice < 0.1) and b.bounce (a trampoline > 1) use the Min / Max combine rules so they
        // override the body's own friction and restitution
        const cd = R.ColliderDesc.cuboid((b.x1 - b.x0) / 2, (b.h - y0) / 2, (b.z1 - b.z0) / 2)
          .setTranslation((b.x0 + b.x1) / 2, (b.h + y0) / 2, (b.z0 + b.z1) / 2).setFriction(b.friction ?? 0.9);
        if (b.friction !== undefined && b.friction < 0.5) cd.setFrictionCombineRule(R.CoefficientCombineRule.Min);
        if (b.bounce) cd.setRestitution(b.bounce).setRestitutionCombineRule(R.CoefficientCombineRule.Max);
        this.world.createCollider(cd, fixed);
      }
      for (const c of terrain.cyls ?? []) {
        this.world.createCollider(R.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.x, c.h / 2, c.z).setFriction(0.9), fixed);
      }
      for (const r of terrain.ramps) {
        const p = [
          r.x0, 0, r.z0, r.x1, 0, r.z0, r.x1, r.h0, r.z0, r.x0, r.h0, r.z0,
          r.x0, 0, r.z1, r.x1, 0, r.z1, r.x1, r.h1, r.z1, r.x0, r.h1, r.z1,
        ];
        const d = R.ColliderDesc.convexHull(new Float32Array(p));
        if (d) this.world.createCollider(d.setFriction(0.9), fixed);
      }
    }
    this.onStep = []; // callbacks run before every fixed step (muscles, pins)
    // Rapier only consults the hooks (our self-collision filter) when stepping with an event queue.
    this.events = new R.EventQueue(true);
  }

  /** Never let these two colliders touch (bodies of one ragdoll that overlap at rest). */
  exclude(h1, h2) {
    this.pairs.add(this._key(h1, h2));
  }

  /** Forget removed colliders' exclusions (a rebuilt ragdoll gets new handles). */
  release(handles) {
    const gone = new Set();
    for (const h of handles) { const i = this.ids.get(h); if (i !== undefined) { gone.add(i); this.ids.delete(h); } }
    if (!gone.size) return;
    for (const k of this.pairs) if (gone.has(Math.floor(k / 100003)) || gone.has(k % 100003)) this.pairs.delete(k);
  }

  /**
   * Advance by dt (seconds of game time) in fixed steps; returns the number of steps taken.
   * (Up to the longest frame, 0.1 s: below 30 fps the physics keeps real time instead of slowing.)
   * The callbacks get how far through this frame each step is (0..1], to spread motion over it.
   */
  update(dt) {
    // Time nearly frozen (the speed force): a fixed step would come only every few frames and the
    // bodies would stutter, so each frame takes one short step of its own length instead.
    if (dt > 0 && dt < STEP * 0.5) {
      this.acc = 0;
      this.world.timestep = dt;
      for (const f of this.onStep) f(dt, 1);
      this.world.step(this.events, this.hooks);
      this.events.clear();
      this.world.timestep = STEP;
      return 1;
    }
    this.acc = Math.min(this.acc + dt, 24 * STEP);
    const total = Math.floor(this.acc / STEP + 1e-9);
    let n = 0;
    while (this.acc >= STEP) {
      const frac = (n + 1) / Math.max(total, n + 1);
      for (const f of this.onStep) f(STEP, frac);
      this.world.step(this.events, this.hooks);
      this.events.clear();
      this.acc -= STEP;
      n++;
    }
    return n;
  }
}
