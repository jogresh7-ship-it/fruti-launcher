/**
 * ProceduralHumanoidAnimator.js
 * ---------------------------------------------------------------------------
 * Physics-driven procedural animation for a Mixamo/GLTF-style humanoid.
 *
 * Layer stack (evaluated every frame, in this order):
 *   1. Locomotion controller   speed/heading springs, root motion, Froude-scaled gait params
 *   2. Foot planner            phase-locked gait steps (Raibert placement) + event-driven
 *                              balance steps (capture point / base-of-support test)
 *   3. Weight model            vertical GRF curves (walk M-shape, run half-sine) -> L/R load
 *   4. Pelvis solver           inverted-pendulum vault (leg-reach soft-min), spring-mass
 *                              compression, ballistic flight, obliquity, transverse rotation
 *   5. Trunk / head            counter-rotation, lean from a/g, gaze stabilisation, breathing
 *   6. Postural sway layer     fBm gradient noise (not sine) on COM, spine and neck
 *   7. Impulse modifier        transient linear/angular velocity injected into springs
 *   8. Limb solvers            analytic two-bone IK (hinge-frame aligned, twist-free)
 *                              for legs and guard arms; pendulum-spring FK arm swing
 *
 * All motion that evolves over time goes through damped springs integrated with the
 * exact closed-form solution of  x'' = -k (x - x*) - d x'  (k = ω², d = 2ζω), so the
 * integration is unconditionally stable and frame-rate independent.
 *
 * Every bone rotation is expressed as a delta in CHARACTER space (root frame:
 * +X = character's left, +Y = up, +Z = forward) and converted into the bone's local
 * frame through its stored rest pose:  q_local = P⁻¹ · R · P · q₀
 * (P = parent's rest orientation in character space, q₀ = rest local quaternion).
 * This makes the animator independent of each rig's bone-axis conventions.
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three';
import { Crawl } from './crawl.js';

// ===========================================================================
// Constants
// ===========================================================================
const G = 9.81;
const SPEEDSTER = 30; // m/s: a speed force faster than this is a speedster's (the Flash), with her own run; below it (Spider-Man's sprint) it only lifts the limits
const F_CAP = 6.5; // strides/s: the fastest run cycle the eye can read (a 0.888 m leg; scaled by leg length)
const DEG = Math.PI / 180;
const EPS = 1e-6;
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ===========================================================================
// Scalar math helpers
// ===========================================================================
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => clamp(x, 0, 1);
/** Parameter blend between two configurations. Never used to animate over time. */
export const mix = (a, b, t) => a + (b - a) * t;
/** C1 Hermite step. */
export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** C2 quintic step (Perlin). */
export const smootherstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Minimum-jerk position profile (Flash & Hogan 1985): s = 10τ³ − 15τ⁴ + 6τ⁵. */
export const minimumJerk = (t) => smootherstep(0, 1, t);
/**
 * Quintic transport 0 → 1 that starts at rest (zero velocity and acceleration) and arrives with
 * velocity r (in units of the average) and zero acceleration; r = 0 is minimum jerk. A walking heel
 * strikes the ground still moving forward and is braked late, rather than eased into place.
 */
export const strikeTransport = (t, r) => {
  const u = clamp(t, 0, 1);
  return u * u * u * ((10 - 4 * r) + u * ((-15 + 7 * r) + u * (6 - 3 * r)));
};
/** Cubic Hermite curve between p0 and p1 with tangents m0, m1 (t in [0,1]). */
export const cubicHermite = (p0, m0, p1, m1, t) => {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
};
/** Accelerating ease-in (concentric push-off profile). */
export const easeInPow = (t, p) => Math.pow(saturate(t), p);
/** Quintic through position, velocity and acceleration at both ends (duration T, time t). */
export const quinticHermite = (p0, v0, a0, p1, v1, a1, T, t) => {
  const u = clamp(t / T, 0, 1), u2 = u * u, u3 = u2 * u, u4 = u3 * u, u5 = u4 * u;
  const h0 = 1 - 10 * u3 + 15 * u4 - 6 * u5, h1 = u - 6 * u3 + 8 * u4 - 3 * u5, h2 = 0.5 * (u2 - 3 * u3 + 3 * u4 - u5);
  const h3 = 10 * u3 - 15 * u4 + 6 * u5, h4 = -4 * u3 + 7 * u4 - 3 * u5, h5 = 0.5 * (u3 - 2 * u4 + u5);
  return h0 * p0 + h1 * v0 * T + h2 * a0 * T * T + h3 * p1 + h4 * v1 * T + h5 * a1 * T * T;
};
/** Exponential decay ease-out normalised to [0,1] (passive elastic recoil). */
export const easeOutExp = (t, k) => (1 - Math.exp(-k * saturate(t))) / (1 - Math.exp(-k));
/** Unnormalised gaussian bell. */
export const bell = (x, mu, sigma) => Math.exp(-((x - mu) * (x - mu)) / (sigma * sigma));
/**
 * Asymmetric bump on [0,1], zero at both ends with zero slope, peak = 1 at `peak`.
 * f(t) = tᵃ(1−t)ᵇ / (pᵃ(1−p)ᵇ),  a = s·p, b = s·(1−p).
 */
export const asymmetricBump = (t, peak, sharpness = 4) => {
  if (t <= 0 || t >= 1) return 0;
  const a = sharpness * peak, b = sharpness - a;
  return (Math.pow(t, a) * Math.pow(1 - t, b)) / (Math.pow(peak, a) * Math.pow(1 - peak, b));
};
/** Smooth minimum (log-sum-exp), C∞, bounded below min(a,b) by k·ln2. */
export const softMin = (a, b, k) => {
  const m = Math.min(a, b);
  return m - k * Math.log(Math.exp((m - a) / k) + Math.exp((m - b) / k));
};
/** softMin without its bias where a ≈ b (equals min(a, b) there; still never above it). */
export const softMinU = (a, b, k) => softMin(a, b, k) + k * Math.LN2 * Math.exp(-Math.abs(a - b) / k);
export const wrap01 = (x) => x - Math.floor(x);
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// Spring-damper (exact closed-form integration)
// ===========================================================================
/**
 * Advances  ÿ = −ω²y − 2ζω ẏ  (y = x − target) by dt using the analytic solution
 * for the under-, critically- and over-damped cases. Constant over the step.
 */
export function springStep(x, v, target, omega, zeta, dt, out) {
  const y0 = x - target;
  let y, vy;
  if (zeta < 0.9999) {
    const a = zeta * omega;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-a * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
    const B = (v + a * y0) / wd;
    y = e * (y0 * c + B * s);
    vy = e * (v * c - (a * B + y0 * wd) * s);
  } else if (zeta > 1.0001) {
    const sq = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega * (zeta - sq), r2 = -omega * (zeta + sq);
    const c1 = (v - r2 * y0) / (r1 - r2), c2 = y0 - c1;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    y = c1 * e1 + c2 * e2;
    vy = c1 * r1 * e1 + c2 * r2 * e2;
  } else {
    const e = Math.exp(-omega * dt), k = v + omega * y0;
    y = (y0 + k * dt) * e;
    vy = (v - omega * k * dt) * e;
  }
  out.x = target + y;
  out.v = vy;
  return out;
}

/**
 * Scalar spring:  f = −k·(x − x*) − d·v + a_ext,  with k = ω², d = 2ζω (unit mass).
 * A constant external acceleration a_ext shifts the equilibrium by a_ext/k, which is
 * folded into the analytic step exactly.
 */
export class Spring {
  constructor(omega, zeta = 1, x = 0) {
    this.omega = omega;
    this.zeta = zeta;
    this.x = x;
    this.v = 0;
    this._o = { x: 0, v: 0 };
  }
  get stiffness() { return this.omega * this.omega; }
  get damping() { return 2 * this.zeta * this.omega; }
  step(target, dt, accel = 0) {
    const eq = target + accel / (this.omega * this.omega);
    springStep(this.x, this.v, eq, this.omega, this.zeta, dt, this._o);
    this.x = this._o.x;
    this.v = this._o.v;
    return this.x;
  }
  /**
   * step() with velocity feed-forward (weight ff ∈ [0, 1]): a moving target is tracked with
   * almost no phase lag, so coupled segments stay in their proper timing. The target's rate is
   * clamped so a jump in the target cannot kick the spring.
   */
  follow(target, dt, ff = 1, accel = 0, maxRate = 4) {
    const rate = this._pt === undefined || dt <= 0 ? 0 : clamp((target - this._pt) / dt, -maxRate, maxRate);
    this._pt = target;
    return this.step(target, dt, accel + ff * 2 * this.zeta * this.omega * rate);
  }
  impulse(dv) { this.v += dv; }
  reset(x = 0) { this.x = x; this.v = 0; }
}

/** Three independent springs sharing ω, ζ (used for rotation vectors and COM offsets). */
export class Spring3 {
  constructor(omega, zeta = 1) {
    this.omega = omega;
    this.zeta = zeta;
    this.x = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this._o = { x: 0, v: 0 };
  }
  step(target, dt) {
    for (const c of ['x', 'y', 'z']) {
      springStep(this.x[c], this.v[c], target ? target[c] : 0, this.omega, this.zeta, dt, this._o);
      this.x[c] = this._o.x;
      this.v[c] = this._o.v;
    }
    return this.x;
  }
  impulse(dv) { this.v.add(dv); }
}

// ===========================================================================
// Procedural noise: 1-D gradient (Perlin) noise + fractal Brownian motion
// ===========================================================================
export class GradientNoise1D {
  constructor(seed = 1) {
    const rnd = mulberry32(seed * 7919 + 13);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.grad = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.grad[i] = rnd() * 2 - 1;
  }
  /** Band-limited noise in [−1, 1]; quintic fade gives C2 continuity. */
  noise(x) {
    const xi = Math.floor(x);
    const xf = x - xi;
    const g0 = this.grad[this.perm[xi & 255]];
    const g1 = this.grad[this.perm[(xi + 1) & 255]];
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const n0 = g0 * xf, n1 = g1 * (xf - 1);
    return 2 * (n0 + (n1 - n0) * u);
  }
  /** Fractal sum, normalised so the output stays in [−1, 1]. */
  fbm(x, octaves = 3, lacunarity = 2.07, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq + o * 31.7);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/** Standard normal deviate (Box–Muller) from a uniform PRNG. */
export function gauss(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/**
 * Per-step noise with memory. A sum of AR(1) processes with geometrically spaced time constants
 * (in steps) approximates fractional Gaussian noise: weights σᵢ² ∝ τᵢ^(2H−2) give a 1/f^(2H−1)
 * spectrum, so H ≈ 0.85 reproduces the persistent stride-interval dynamics of human gait
 * (DFA α ≈ 0.84, Hausdorff 2001). A single term with τ = 6 gives the AR(1) speed process
 * (Collins & Kuo 2013); a negative φ gives the anti-correlated step-width process.
 * Output has unit variance.
 */
export class StepNoise {
  constructor(rng, { taus = [2, 8, 30, 120, 500], H = 0.85, phi = null } = {}) {
    this.rng = rng;
    const terms = phi !== null ? [{ phi, w: 1 }] : taus.map((tau) => ({ phi: Math.exp(-1 / tau), w: Math.pow(tau, 2 * H - 2) }));
    const norm = terms.reduce((s, t) => s + t.w, 0);
    // Start each term from its stationary distribution so there is no warm-up drift.
    this.terms = terms.map((t) => ({ phi: t.phi, sd: Math.sqrt(t.w / norm), x: gauss(rng) * Math.sqrt(t.w / norm) }));
    this.value = this.terms.reduce((s, t) => s + t.x, 0);
  }
  step() {
    let sum = 0;
    for (const t of this.terms) {
      t.x = t.phi * t.x + Math.sqrt(1 - t.phi * t.phi) * t.sd * gauss(this.rng);
      sum += t.x;
    }
    return (this.value = sum);
  }
}

// ===========================================================================
// Rotation helpers
// ===========================================================================
const _euler = new THREE.Euler();
const _basis = new THREE.Matrix4();
const _fx = new THREE.Vector3(), _fy = new THREE.Vector3(), _fz = new THREE.Vector3();

/** R = R_y(yaw) · R_z(roll) · R_x(pitch). +pitch = flexion (+Y→+Z), +roll lifts the left (+X) side. */
export function quatYawRollPitch(yaw, roll, pitch, out) {
  return out.setFromEuler(_euler.set(pitch, yaw, roll, 'YZX'));
}
/** Mirror a left-side rotation to the right side (reflection across the sagittal YZ plane). */
export function mirrorQuat(q) {
  return q.set(q.x, -q.y, -q.z, q.w);
}
/** Orthonormal frame quaternion: x = axis, z = hinge (Gram-Schmidt), y = z × x. */
export function frameQuat(axis, hinge, out) {
  _fx.copy(axis).normalize();
  _fz.copy(hinge).addScaledVector(_fx, -hinge.dot(_fx)).normalize();
  _fy.crossVectors(_fz, _fx);
  _basis.makeBasis(_fx, _fy, _fz);
  return out.setFromRotationMatrix(_basis);
}

// ===========================================================================
// Ground-reaction-force models (body-weight units, s = stance progress 0..1)
// ===========================================================================
/**
 * Stiff-leg stance (vertical, relative to touchdown height): the landing speed V is taken out by a
 * short force peak right after contact (first 28 % of stance), the body rides level on the leg, and
 * a second peak launches it at V again before toe-off. Kinematic (gravity included in the net
 * acceleration); u = stance fraction, Tc = contact time. Returns { y, v, a }.
 */
const STIFF_W = 0.28;
const bumpC = (u, w) => (u <= 0 ? 0 : u >= w ? 1 : u / w - Math.sin((2 * Math.PI * u) / w) / (2 * Math.PI));
const bumpR = (u, w) => (u <= 0 ? 0 : u >= w ? w / 2 + (u - w) : (u * u) / (2 * w) + (w / (4 * Math.PI * Math.PI)) * (Math.cos((2 * Math.PI * u) / w) - 1));
const bumpRho = (u, w) => (u <= 0 || u >= w ? 0 : (2 / w) * Math.sin((Math.PI * u) / w) ** 2);
const _imp = { y: 0, v: 0, a: 0 };
export function stanceImpulse(u, V, Tc) {
  const w = STIFF_W, u2 = u - (1 - w);
  const C = 0.5 * (bumpC(u, w) + bumpC(u2, w));
  const R = 0.5 * (bumpR(u, w) + bumpR(u2, w));
  const rho = 0.5 * (bumpRho(u, w) + bumpRho(u2, w));
  _imp.y = V * Tc * (2 * R - u);
  _imp.v = V * (2 * C - 1);
  _imp.a = ((2 * V) / Math.max(Tc, EPS)) * rho;
  return _imp;
}

/** Walking vertical GRF: M-shaped double hump (~1.2 BW peaks at 23% / 77%, ~0.75 BW valley). */
export function grfWalk(s) {
  const taper = smoothstep(0, 0.06, s) * smoothstep(1, 0.94, s);
  return taper * (1.18 * bell(s, 0.23, 0.12) + 1.1 * bell(s, 0.77, 0.12) + 0.72 * bell(s, 0.5, 0.17));
}
/** Running vertical GRF: spring-mass half-sine (~2.5 BW) plus a heel-strike impact transient. */
export function grfRun(s, impact = 0.35) {
  if (s <= 0 || s >= 1) return 0;
  return 2.5 * Math.pow(Math.sin(Math.PI * s), 1.15) + impact * 0.9 * bell(s, 0.06, 0.035);
}

// ===========================================================================
// Bone naming
// ===========================================================================
const REQUIRED_BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
];
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const OPTIONAL_BONES = ['LeftShoulder', 'RightShoulder', 'LeftToeBase', 'RightToeBase'];
for (const side of ['Left', 'Right']) {
  for (const f of FINGERS) for (let j = 1; j <= 3; j++) OPTIONAL_BONES.push(`${side}Hand${f}${j}`);
  for (let j = 1; j <= 3; j++) OPTIONAL_BONES.push(`${side}HandThumb${j}`);
}
/** Strip Mixamo prefixes ("mixamorig:", "mixamorig", "mixamorig_") and namespaces. */
const canonicalBoneName = (name) => name.replace(/^mixamorig\d*[:_]?/i, '').replace(/^.*[:|]/, '');

// Finger curl distribution: relaxed resting cascade (index → pinky) and fist.
const FINGER_RELAXED = { Index: [10, 14, 8], Middle: [15, 20, 10], Ring: [19, 24, 12], Pinky: [24, 28, 14] };
const FINGER_FIST = [88, 102, 68];
// Lateral clearance (× leg length) between the ankles when the feet overlap fore-aft: at landing
// (foot width + margin) and while the swing foot passes the other leg (shin width + margin).
const FOOT_CLEAR = 0.14;
const PASS_CLEAR = 0.085;
/** C1 ramp: 0 below 0, quadratic over [0, k], then x − k/2. */
const softRamp = (x, k) => (x <= 0 ? 0 : x < k ? (x * x) / (2 * k) : x - k / 2);

const _cp1 = new THREE.Vector3(), _cp2 = new THREE.Vector3(), _cd1 = new THREE.Vector3(), _cd2 = new THREE.Vector3(), _cr = new THREE.Vector3();
/** Closest points between segments p1q1 and p2q2 (written to c1, c2); returns their distance. */
export function closestSegments(p1, q1, p2, q2, c1, c2) {
  const d1 = _cd1.subVectors(q1, p1), d2 = _cd2.subVectors(q2, p2), r = _cr.subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
  let t = e > 1e-12 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = a > 1e-12 ? clamp(-c / a, 0, 1) : 0; }
  else if (t > 1) { t = 1; s = a > 1e-12 ? clamp((b - c) / a, 0, 1) : 0; }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceTo(c2);
}

const FLOOR_MODES = new Set(['crawl', 'army', 'back', 'sit', 'lie']);
const MODE_SPEED = (t) => ({ walk: t.walkSpeed, run: t.jogSpeed, sprint: t.sprintSpeed, crouch: 0.75, crawl: 0.5, army: 0.3 });

// Running swing key times: heel recovery, knee drive, reach (then pawback to contact).
const RUN_SWING_T = [0, 0.3, 0.56, 0.8, 1];

// ===========================================================================
// ProceduralHumanoidAnimator
// ===========================================================================
/**
 * Sex-typical movement (Bruening et al. 2015 Gait & Posture, 2020 PLoS ONE; Ferber et al. 2003; runner
 * meta-analysis, Front. Physiol. 2022; Johnson et al. 2007; men's gait-dominance study, Sci. Rep. 2025).
 * Differences come from body build (pelvis width to femur
 * length, shoulder width, upper-body mass) and are differences of degree, not kind:
 *  - Women: much more pelvic obliquity, more pelvic AND torso rotation and more arm swing (the
 *    narrower, lighter upper body has to rotate further to cancel the legs' angular momentum;
 *    torso rotation is up to ~2× the men's when running), more hip adduction (narrower step),
 *    more ankle plantarflexion; yet a steadier torso and head side to side. Pronounced contrapposto.
 *  - Men: a quiet, level pelvis; the heavier upper body counter-rotates less; arms held off the
 *    trunk (≈ 11° abduction) with slightly bent elbows and swinging less; the torso sways over the
 *    stance leg relative to the pelvis ("shoulder swagger", ≈ 1.5 cm at T10); a wider step and
 *    stance; more knee flexion when running. Normalised step length and cadence do not differ
 *    (they follow leg length). Standing weight shifts are smaller and rarer.
 */
export const STYLES = {
  female: {
    mass: 75,
    walkSpeed: 1.33, jogSpeed: 2.55, sprintSpeed: 6.2, runUpFr: 0.4,
    pelvisYawGain: 0.21, pelvisYawRun: 1, rollIdle: 3.5, rollWalk: 4.5, rollRun: 5, swayWalk: 0.32, swayRun: 0.18,
    stepWidth: 0.62, stepWidthRun: 0.5, stanceWidth: 1.08, toeOut: 6.5,
    thoraxWalk: 0.55, thoraxRun: 1.2, swagger: 0, contrapposto: 1.5, shiftAmp: 0.6, shiftEvery: 1,
    armSwing: 18, armAbd: 6, armAbdRun: 9, carryAngle: 8, armCross: 14, armInRot: 8, elbowWalk: 10,
    toeOff: 55, toeOffRun: 56, maxRoll: 62, runStiff: 0.45,
    jumpVz: 2.2, // vertical take-off speed of a standing jump (≈ 25 cm; untrained women 20–30 cm)
    pelvicTilt: 1, breathRate: 14.5,
  },
  male: {
    mass: 85,
    walkSpeed: 1.4, jogSpeed: 2.75, sprintSpeed: 7, runUpFr: 0.43,
    pelvisYawGain: 0.16, pelvisYawRun: 0.8, rollIdle: 2.2, rollWalk: 2.8, rollRun: 3.4, swayWalk: 0.21, swayRun: 0.14,
    stepWidth: 0.72, stepWidthRun: 0.56, stanceWidth: 1.4, toeOut: 8.5,
    thoraxWalk: 0.5, thoraxRun: 0.95, swagger: 2.6, contrapposto: 1.2, shiftAmp: 0.3, shiftEvery: 1.4,
    armSwing: 15, armAbd: 9, armAbdRun: 4, carryAngle: 4, armCross: 6, armInRot: 11, elbowWalk: 15,
    toeOff: 51, toeOffRun: 52, maxRoll: 57, runStiff: 0.38,
    jumpVz: 2.6, // ≈ 35 cm (untrained men 30–40 cm)
    pelvicTilt: 0, breathRate: 12.5,
  },
  // The Hulk: ≈ 2.3 m and hugely heavy. A wide, rolling gait on bent knees with a big shoulder
  // swagger, the trunk hunched forward and the shoulders rolled in, the head thrust forward, arms
  // carried just clear of the lats (not flared) with the elbows bent, little hip rotation, slow heaving
  // breaths; a standing jump of ≈ 4 m.
  hulk: {
    mass: 640,
    // (Speeds dynamically similar to the male's — his size already makes him faster — so his strides
    // stay within reach of his legs.)
    walkSpeed: 1.35, jogSpeed: 2.7, sprintSpeed: 6.4, runUpFr: 0.42,
    pelvisYawGain: 0.1, pelvisYawRun: 0.7, rollIdle: 1.6, rollWalk: 2.2, rollRun: 3, swayWalk: 0.3, swayRun: 0.2,
    stepWidth: 0.95, stepWidthRun: 0.72, stanceWidth: 1.75, toeOut: 12,
    thoraxWalk: 0.35, thoraxRun: 0.7, swagger: 9, contrapposto: 0.6, shiftAmp: 0.35, shiftEvery: 1.8,
    armSwing: 24, armAbd: 24, armAbdRun: 6, carryAngle: 4, armCross: 4, armInRot: 12, elbowWalk: 30,
    toeOff: 45, toeOffRun: 48, maxRoll: 52, runStiff: 0.3,
    // Jumps: ≈ 1.8 m standing; moving, the lift is capped and the run-up carried further (forward,
    // not straight up). The double-tap leap is the flight's ballistic arc.
    jumpVz: 6, jumpMoveCap: 1.7, jumpCarry: 1.7,
    pelvicTilt: 3, breathRate: 9, breathAmp: 2.2,
    hunch: 24, roundShoulders: 14, forwardHead: 15, sink: 0.045,
    legCapsule: [0.095, 0.072], // leg-vs-leg capsule radii (× leg length), see _fitCapsules
    tireless: true, // no fatigue: he keeps the speed he is given
  },
};

export class ProceduralHumanoidAnimator {
  /**
   * @param {THREE.Object3D} model   object containing the skeleton (e.g. gltf.scene)
   * @param {object} [opts]
   * @param {THREE.Object3D} [opts.root]  character frame (ground position + heading). Defaults to model.
   * @param {boolean} [opts.driveRoot=true]  integrate root motion from the locomotion controller
   * @param {number} [opts.mass]  body mass in kg (impulse → velocity); 75 female, 85 male
   * @param {number} [opts.seed=1337]
   * @param {'female'|'male'} [opts.sex='female']  movement style (see STYLES)
   * @param {(x: number, z: number) => number} [opts.ground]  floor height (world) at a point; without
   *   it the floor is flat at the root's height
   * @param {number} [opts.agility=1]  responsiveness for game control: scales turn rate and how
   *   quickly speed builds (1 = an ordinary pedestrian)
   */
  constructor(model, opts = {}) {
    this.model = model;
    this.root = opts.root || model;
    this.driveRoot = opts.driveRoot !== false;
    this.sex = opts.sex === 'male' || opts.sex === 'hulk' ? opts.sex : 'female';
    this.style = STYLES[this.sex];
    this.mass = opts.mass ?? this.style.mass;
    this.ground = opts.ground || null;
    this.agility = opts.agility ?? 1;
    const seed = opts.seed ?? 1337;
    this.rng = mulberry32(seed);
    this.noise = new GradientNoise1D(seed);

    this._allocTemps();
    this._findBones();
    this._captureRest();
    this._measure();
    this._fitCapsules();
    this._initState();
    this.crawl = new Crawl(this);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * 'idle' | 'walk' | 'run' | 'sprint' | 'guard' | 'crouch' (crouch walk) | 'crawl' (hands and knees) |
   * 'army' (army crawl) | 'back' (rolled onto the back from the army crawl) | 'sit' (on the floor) | 'lie' (lying back)
   */
  setMode(mode) {
    this.mode = mode;
    // Leaving guard cancels a punch still waiting for it (it would otherwise wait for ever).
    if (mode !== 'guard') this.strikeQueued = false;
    const L = this.dims.L / 0.888; // speeds are dynamically similar to a 0.888 m leg
    const sq = Math.sqrt(L);
    // An ordinary adult, not an athlete: ~1.33 / 1.4 m/s comfortable walk, ~2.6 / 2.8 m/s jog and an
    // all-out sprint of ~6.2 / 7 m/s (women / men; recreational athletes reach 7.5–8.5).
    // Crawling on hands and knees ≈ 0.5 m/s, army crawling ≈ 0.3 m/s, a crouch walk ≈ 0.75 m/s.
    this.targetSpeed = (MODE_SPEED(this.traits)[mode] ?? 0) * sq;
    this.guardTarget = mode === 'guard' ? 1 : 0;
    this.crouchTarget = mode === 'crouch' ? 1 : 0;
    this.crawl.setGoal(FLOOR_MODES.has(mode) ? mode : 'stand');
  }

  /** Nominal speed (m/s) of a mode for this body. */
  modeSpeed(mode) {
    // (Charged with the speed force, the sprint is hers to set: speedForce is its top speed.)
    if (mode === 'sprint' && this.speedForce > 0) return this.speedForce;
    return (MODE_SPEED(this.traits)[mode] ?? 0) * Math.sqrt(this.dims.L / 0.888);
  }

  /** Override the locomotion speed directly (m/s). */
  setSpeed(metersPerSecond) {
    this.targetSpeed = Math.max(0, metersPerSecond);
  }

  /**
   * Steering input in [−1, 1]; positive turns toward the character's left.
   * @param {number} [headingError=0]  angle (rad) to the intended direction; the eyes and head
   *   turn toward it first and the body follows (top-down turn sequencing).
   */
  setTurn(input, headingError = 0) {
    this.turnInput = clamp(input, -1, 1);
    this.lookAhead = headingError;
  }

  /**
   * Aim lock (third-person shooter style): face `yaw` (world heading, rad) with no turning lag, or
   * null to steer normally. The feet re-plant under her as she turns.
   */
  setFacing(yaw) { this.facing = yaw; }

  /**
   * Strafing: travel at `offset` (rad) from the facing — sideways steps, backpedalling — with the
   * feet and body still facing the heading.
   */
  setTravel(offset) { this.travelTarget = offset; }

  /**
   * Something to look at (world point), or null. The head and eyes follow it (the chest helps for
   * wide angles); behind her it is let go of.
   */
  setLookTarget(p) {
    this.lookOn = !!p;
    if (p) this.lookTarget.copy(p);
  }

  /**
   * Someone holds one of her hands ('L' | 'R') at a world point (null to let go): the arm reaches
   * to it (as far as it goes); what the rest of her does about it is up to the caller.
   */
  setLead(side, point) {
    this.leadSide = side || this.leadSide;
    this.leadOn = !!side;
    if (point) this.leadPoint.copy(point);
  }

  /**
   * Something is about to hit her (world point it comes from): a reflex flinch — the face turns
   * away, the chin tucks, the shoulders rise and the hands come up in front of the face.
   */
  flinch(fromWorld) {
    if (this.crawl.owns) return;
    const p = this._t.v0.copy(fromWorld).sub(this.root.position).applyQuaternion(this._rootQInv);
    this.flinchSide = p.x >= 0 ? 1 : -1; // it comes from her left (+) or right (−)
    this.flinchT = 0.42;
  }

  /**
   * Jump. What kind depends on what she is doing: standing (or in guard) → a two-footed
   * countermovement jump; walking → a small hop off one foot; running → a running leap; sprinting →
   * a long jump that carries the speed on. Asked for mid-air or while landing, it is queued briefly.
   */
  jump() {
    if (this.crawl.goal !== 'stand' || this.crawl.state !== 'stand') return;
    this.jumpQueued = this.time;
  }

  /** Rear-hand straight (cross). Enters guard first if needed. */
  strike() {
    if (this.mode !== 'guard') this.setMode('guard');
    if (this.crawl.state !== 'stand') return; // getting up first; strike again once standing
    this.strikeQueued = true;
  }

  /**
   * Inject an external impulse (e.g. a hit or shove).
   * @param {THREE.Vector3} directionWorld  push direction (horizontal component is used)
   * @param {number} impulse   magnitude in N·s
   * @param {'head'|'chest'|'pelvis'} [region='chest']
   */
  applyImpulse(directionWorld, impulse, region = 'chest', fromPhysics = false) {
    // While the physics layer (nm.js) has her, a hit goes to the body itself.
    if (this.nmOwned && !fromPhysics && this.onPhysicalHit) { this.onPhysicalHit(directionWorld, impulse, region); if (this.crawl.owns) return; }
    if (this.crawl.owns || this.crawl.state === 'waitStop') return;
    const d = this._t.v0.copy(directionWorld).applyQuaternion(this._rootQInv);
    d.y = 0;
    if (d.lengthSq() < EPS) d.set(0, 0, -1);
    d.normalize();
    // (toughness: a superhero takes a shove as one this many times softer)
    const dv = impulse / (this.mass * this.toughness);
    const lever = region === 'head' ? 1.25 : region === 'pelvis' ? 0.25 : 1.0;
    // Balance has a budget: one shove is recovered with a step, but a heavy one (or another before
    // she has recovered) knocks her down, backward into a sit or forward onto hands and knees.
    this.balanceDebt += dv * (0.75 + 0.25 * lever) * (this.jumpState ? 1.4 : 1);
    // The shove still acts first: she staggers a step's worth before going down.
    if (this.balanceDebt > 1.05 && !this.fallPending && !this.nmOwned) {
      this.balanceDebt = 0;
      // With physics, the body goes over for real; without it, a keyframed fall.
      if (this.onKnockdown) this.onKnockdown(directionWorld.clone(), impulse, region);
      else this.fallPending = { t: 0.22, kind: d.z < 0 ? 'back' : 'fwd' };
    }

    // Linear: COM perturbation (ankle/hip strategy spring). The capture-point test decides on a step.
    this.comPert.impulse(this._t.v1.set(d.x, 0, d.z).multiplyScalar(dv * (1.15 - 0.3 * lever)));
    // Angular: torso tips about axis = up × d.
    const axis = this._t.v2.crossVectors(UP, d);
    const w = dv * 4.2 * lever;
    this.spineImp.impulse(this._t.v1.copy(axis).multiplyScalar(w));
    // Head inertia: relative to the trunk it first rotates the opposite way (whiplash), then overshoots.
    this.headImp.impulse(this._t.v1.copy(axis).multiplyScalar(-w * (region === 'head' ? -0.9 : 0.75)));
    this.pelvisImp.impulse(this._t.v1.copy(axis).multiplyScalar(w * 0.25));
    // Off-centre hit → yaw torque.
    const yawKick = (this.rng() - 0.5) * 2 * dv * 2.4;
    this.spineImp.impulse(this._t.v1.set(0, yawKick, 0));
    // Knees buckle slightly.
    this.pelvisY.impulse(-dv * 0.35);
    // Arms lag the trunk (relative swing forward when pushed backward).
    const back = -d.z, dvA = Math.min(dv, 0.75); // arms flail only so fast
    for (const s of [this.arm.L, this.arm.R]) {
      s.swing.impulse(back * dvA * 6 + (this.rng() - 0.5) * dvA * 3);
      s.elbow.impulse(dvA * 5 * (0.5 + this.rng()));
    }
    this.exertion = Math.min(1, this.exertion + 0.12 * Math.min(dv, 0.7));
  }

  /**
   * Re-plant the standing figure with the balls of its feet at `balls` ({L, R}, world), standing
   * still at the current heading (used when getting up from a crawl).
   */
  _resetStance(balls) {
    const d = this.dims, R = this.rest;
    const fwd = this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const mx = (balls.L.x + balls.R.x) / 2 - fwd.x * d.ballFwd, mz = (balls.L.z + balls.R.z) / 2 - fwd.z * d.ballFwd;
    const restZ = (R.LeftFoot.charPos.z + R.RightFoot.charPos.z) / 2;
    this.root.position.set(mx - fwd.x * restZ, this.root.position.y, mz - fwd.z * restZ);
    this.root.quaternion.setFromAxisAngle(UP, this.heading);
    this._updateRootFrame();
    for (const s of ['L', 'R']) {
      const f = this.feet[s];
      f.ball.copy(balls[s]); f.ball.y = this._floor(f.ball.x, f.ball.z) + d.groundY;
      f.slope = this._slopeAt(f.ball, this.heading);
      f.yaw = this.heading;
      f.planted = true; f.swing = null; f.pending = null; f.needWrap = false; f.gaitStance = false;
      f.sinceLand = 1; f.pitch.x = f.pitch.v = 0; f.pivotYaw.x = f.pivotYaw.v = 0; f.toe.x = f.toe.v = 0;
      f.colTarget = 0; f.colPush.x = f.colPush.v = 0; f.swingW = 0; f.rollTo = 0;
      this._ankleFromPlant(f.ball, f.yaw, f.slope, f.ankle, f.slope);
      f.prevAnkle.copy(f.ankle); f.ankleVel.set(0, 0, 0);
    }
    this.rootY.x = this.root.position.y; this.rootY.v = 0;
    this.gaitActive = false; this.initT = -1; this.apaW = 0;
    this.speed.x = this.speed.v = 0; this.yawRate.x = this.yawRate.v = 0; this.velocity.set(0, 0, 0);
    this.jumpState = null; this.jumpQueued = -1; this.landOff.x = this.landOff.v = 0; this.jumpBlend.x = this.jumpBlend.v = 0;
    for (const sp of [this.pelvisX, this.pelvisZ, this.pelvisYaw, this.pelvisRoll]) sp.x = sp.v = 0;
    for (const sp of [this.pelvisY, this.pelvisRise, this.runTouch]) { sp.x = d.hipsH; sp.v = 0; }
    this.pelvisFinalY = d.hipsH; this.pelvisVelY = 0;
    this.weightL.x = 0.5; this.weightL.v = 0;
    this.standT = 0;
    for (const sp of [this.comPert, this.spineImp, this.headImp, this.pelvisImp]) { sp.x.set(0, 0, 0); sp.v.set(0, 0, 0); }
    this.pelvisY.v = 0; this.balanceDebt = 0;
    this.strikeQueued = false; this.strikeT = -1;
  }

  /** Restore the stored rest pose (non-destructive reset). */
  restoreRestPose() {
    for (const key in this.bones) {
      const b = this.bones[key], r = this.rest[key];
      b.quaternion.copy(r.q0);
      b.position.copy(r.p0);
      b.scale.copy(r.s0);
    }
  }

  /** Main loop. Call once per frame with seconds elapsed. */
  update(deltaTime) {
    let dt = Math.min(Math.max(deltaTime, 0), 0.1);
    // Logic is integrated in ≤ 1/60 s sub-steps; the pose is solved once at the end.
    // (Finer at a fast cadence — the speed force, or anyone driven past a sprint: every stride still
    // gets ≥ 20 steps of its swing.)
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)), Math.min(30, Math.ceil(dt * this.gait.f * 20)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._updateLook(h);
      this.crawl.simulate(h);
      if (this.crawl.freezesStand) this.time += h;
      else this._simulate(h);
    }
    this._poseDt = dt;
    this._solvePose(dt);
    this.crawl.apply();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  _allocTemps() {
    const V = () => new THREE.Vector3();
    const Q = () => new THREE.Quaternion();
    this._t = {
      v0: V(), v1: V(), v2: V(), v3: V(), v4: V(), v5: V(), v6: V(), v7: V(), v8: V(), v9: V(),
      q0: Q(), q1: Q(), q2: Q(), q3: Q(), q4: Q(), q5: Q(), q7: Q(),
    };
    this._rootQ = Q();
    this._rootQInv = Q();
    this._rootPos = V();
    this._rootInvM = new THREE.Matrix4();
    this._fwd = V();
  }

  _findBones() {
    this.bones = {};
    this.model.traverse((o) => {
      if (!o.isBone && o.type !== 'Bone') return;
      const key = canonicalBoneName(o.name);
      if (!this.bones[key]) this.bones[key] = o;
    });
    const missing = REQUIRED_BONES.filter((k) => !this.bones[k]);
    if (missing.length) throw new Error(`ProceduralHumanoidAnimator: missing bones: ${missing.join(', ')}`);
    for (const key of Object.keys(this.bones)) {
      if (!REQUIRED_BONES.includes(key) && !OPTIONAL_BONES.includes(key)) delete this.bones[key];
    }
  }

  _updateRootFrame() {
    this.root.updateMatrixWorld(true);
    this.root.matrixWorld.decompose(this._rootPos, this._rootQ, this._t.v8);
    this._rootQInv.copy(this._rootQ).invert();
    this._rootInvM.copy(this.root.matrixWorld).invert();
  }

  _captureRest() {
    this._updateRootFrame();
    this.model.updateMatrixWorld(true);
    this.rest = {};
    const wq = new THREE.Quaternion(), wp = new THREE.Vector3();
    for (const key in this.bones) {
      const b = this.bones[key];
      b.getWorldQuaternion(wq);
      b.getWorldPosition(wp);
      const charQ = this._rootQInv.clone().multiply(wq);
      const parentCharQ = new THREE.Quaternion();
      if (b.parent) {
        b.parent.getWorldQuaternion(wq);
        parentCharQ.copy(this._rootQInv).multiply(wq);
      }
      this.rest[key] = {
        q0: b.quaternion.clone(),
        p0: b.position.clone(),
        s0: b.scale.clone(),
        charQ,
        charPos: wp.clone().applyMatrix4(this._rootInvM),
        parentCharQ,
        parentCharQInv: parentCharQ.clone().invert(),
      };
    }
  }

  _measure() {
    const P = (k) => this.rest[k].charPos;
    const d = {};
    d.thigh = P('LeftLeg').distanceTo(P('LeftUpLeg'));
    d.shin = P('LeftFoot').distanceTo(P('LeftLeg'));
    d.L = d.thigh + d.shin;
    d.hipHalf = Math.abs(P('LeftUpLeg').x - P('RightUpLeg').x) / 2;
    d.groundY = this.bones.LeftToeBase ? Math.min(P('LeftToeBase').y, P('LeftFoot').y) : 0;
    d.ankleH = Math.max(P('LeftFoot').y - d.groundY, 0.02 * d.L);
    d.ballFwd = this.bones.LeftToeBase
      ? Math.hypot(P('LeftToeBase').x - P('LeftFoot').x, P('LeftToeBase').z - P('LeftFoot').z)
      : 0.16 * d.L;
    d.heelBack = 0.42 * d.ballFwd;
    d.footHalfWidth = 0.05 * d.L;
    d.hipsH = P('Hips').y - d.groundY;
    d.hipJoint = {
      L: P('LeftUpLeg').clone().sub(P('Hips')),
      R: P('RightUpLeg').clone().sub(P('Hips')),
    };
    d.upperArm = P('LeftForeArm').distanceTo(P('LeftArm'));
    d.foreArm = P('LeftHand').distanceTo(P('LeftForeArm'));
    d.armLen = d.upperArm + d.foreArm;
    d.reach = d.L * 0.997;
    this.dims = d;

    // Two-bone chains: rest axes and hinge frames in character space.
    const chain = (up, mid, end, bendDir) => {
      const u0 = P(mid).clone().sub(P(up)).normalize();
      const l0 = P(end).clone().sub(P(mid)).normalize();
      const n0 = bendDir.clone().addScaledVector(u0, -bendDir.dot(u0)).normalize();
      const h0 = new THREE.Vector3().crossVectors(u0, n0).normalize();
      const restUpper = frameQuat(u0, h0, new THREE.Quaternion());
      const restLower = frameQuat(l0, h0, new THREE.Quaternion());
      return {
        up, mid, end, u0, l0, h0,
        a: P(mid).distanceTo(P(up)),
        b: P(end).distanceTo(P(mid)),
        restUpperInv: restUpper.invert(),
        restLowerInv: restLower.invert(),
      };
    };
    // Knees displace forward (+Z) when flexing; elbows displace backward (−Z).
    this.chains = {
      legL: chain('LeftUpLeg', 'LeftLeg', 'LeftFoot', new THREE.Vector3(0, 0, 1)),
      legR: chain('RightUpLeg', 'RightLeg', 'RightFoot', new THREE.Vector3(0, 0, 1)),
      armL: chain('LeftArm', 'LeftForeArm', 'LeftHand', new THREE.Vector3(0, 0, -1)),
      armR: chain('RightArm', 'RightForeArm', 'RightHand', new THREE.Vector3(0, 0, -1)),
    };
    // Hand frames: x along the forearm, z = palm normal (rest palm faces −Y in a T-pose).
    for (const s of ['L', 'R']) {
      const c = this.chains['arm' + s];
      c.palm0 = new THREE.Vector3(0, -1, 0);
      c.restHandInv = frameQuat(c.l0, c.palm0, new THREE.Quaternion()).invert();
    }
  }

  _initState() {
    const d = this.dims, L = d.L;
    this._updateRootFrame();
    this._fwd.set(0, 0, 1).applyQuaternion(this._rootQ);
    this.heading = Math.atan2(this._fwd.x, this._fwd.z);
    this.time = 0;

    // Locomotion
    this.mode = 'idle';
    this.targetSpeed = 0;
    this.turnInput = 0;
    this.guardTarget = 0;
    this.speed = new Spring(2.6, 1);
    this.brakeOmega = 5; this.stopping = true;
    this.brakeFrom = 0; this.brakeNod = new Spring(6, 0.45); this.leanAccel = 0;
    this.yawRate = new Spring(6, 1);
    this.velocity = new THREE.Vector3();
    this.accelFwd = 0;
    this.gait = { f: 1, duty: 0.62, rb: 0, locoW: 0, strideLen: 0, swingH: 0.15 * L };
    this.phase = 0;
    this.gaitActive = false;
    this.flightTimer = 0;
    this.lastLiftoff = 0;
    this.running = false; // walk/run state with hysteresis
    this.initT = -1; // gait initiation (anticipatory postural adjustment) timer
    this.initStance = 'L';
    this.apaW = 0;
    this.lookAhead = 0;
    this.facing = null; // aim lock heading (setFacing)
    this.travel = 0; this.travelTarget = 0; // strafe direction relative to the heading (setTravel)
    this._travelDir = new THREE.Vector3(0, 0, 1);
    this.lookYaw = new Spring(6, 1);
    this.wander = 0; // heading wander (rad), OU process

    // Traits: drawn once, they make this body a particular person rather than an average.
    const r = this.rng, gs = () => gauss(r);
    const leftArm = r() < 2 / 3; // ~2 in 3 people swing the left arm more, regardless of handedness
    const armAsym = 0.1 + 0.15 * r();
    const longSide = r() < 0.5 ? 'L' : 'R';
    const st = this.style;
    const toeOut = st.toeOut + 3 * r();
    this.traits = {
      walkSpeed: st.walkSpeed + 0.05 * clamp(gs(), -2, 2),
      jogSpeed: st.jogSpeed + 0.1 * clamp(gs(), -2, 2),
      get sprintSpeed() { return st.sprintSpeed * this.jogSpeed / st.jogSpeed; }, // a faster jogger sprints faster
      runUpFr: st.runUpFr + 0.03 * clamp(gs(), -1.5, 1.5), // walk→run near 1.85 m/s (women) / 2 m/s (men)
      arm: { L: leftArm ? 1 : 1 - armAsym, R: leftArm ? 1 - armAsym : 1 },
      elbow: { L: 3 * gs() * DEG, R: 3 * gs() * DEG },
      toeOut: { L: (toeOut + 1.5 * clamp(gs(), -1.5, 1.5)) * DEG, R: (toeOut + 1.5 * clamp(gs(), -1.5, 1.5)) * DEG },
      // Small persistent limb bias (not tied to dominance): one side steps a little longer and stays down a little longer.
      stepBias: { L: longSide === 'L' ? 0.01 + 0.02 * r() : 0, R: longSide === 'R' ? 0.01 + 0.02 * r() : 0 },
      dutyBias: { L: longSide === 'L' ? 0.004 + 0.008 * r() : 0, R: longSide === 'R' ? 0.004 + 0.008 * r() : 0 },
      forwardHead: (3 + 4 * r() + (st.forwardHead ?? 0)) * DEG, // craniovertebral angle ~50°: neck forward, head tipped back
      pelvicTilt: (st.pelvicTilt + 2 * r()) * DEG,
      roundShoulders: (2 + 3 * r() + (st.roundShoulders ?? 0)) * DEG,
      breathRate: st.breathRate + 2.5 * r(), // breaths/min at rest
    };

    // Structured gait noise, advanced once per step (rhythm, speed and balance are controlled differently).
    this.noiseCad = new StepNoise(r, { H: 0.85 }); // stride timing: long memory, CV ≈ 1.8 %
    this.noiseSpeed = new StepNoise(r, { phi: Math.exp(-1 / 6) }); // speed: τ ≈ 6 steps, CV ≈ 2.5 %
    this.noiseWidth = new StepNoise(r, { phi: -0.3 }); // step width: anti-correlated, SD ≈ 2.4 cm
    this.jit = { roll: 1, yaw: 1, arm: { L: 1, R: 1 } };

    // Idle: time spent standing, fidgets and stance re-plants.
    this.standT = 0;
    this.fidget = null;
    this.fidgetTimer = 6 + 6 * r();
    this.stanceJit = { L: { x: 0, z: 0, yaw: 0 }, R: { x: 0, z: 0, yaw: 0 } };

    // Mode blends
    this.guardW = new Spring(12, 1);
    this.crouchTarget = 0;
    this.crouchW = new Spring(4, 1);
    // Braced (firing a weapon standing): feet set wide, the left a little forward, knees soft.
    this.braceTarget = 0;
    this.braceW = new Spring(5, 1);

    // Looking at a point (the cursor): direction relative to the body, and how much it is followed.
    this.lookTarget = new THREE.Vector3();
    this.lookOn = false;
    this.lookRel = { yaw: 0, pitch: 0 };
    this.lookW = new Spring(5, 1);

    // Fatigue (0..1): builds while running hard, slows the sprint and, when she stops after a hard
    // run, bends her over with her hands on her knees to get her breath back.
    this.fatigue = 0;
    this.toughness = 1; // (hits are taken as this many times softer: set for superheroes)
    this.speedForce = 0; // > 0: charged (the Flash), the top speed of her sprint (m/s)
    this.onWallHit = null; // (speed, forward) => void: ran into a wall too fast to stop
    this.edgeStop = true; // walking, she stops at a drop (false: walks straight off it, onFallOff)
    this.recoverW = new Spring(3.2, 1);
    this.recoverT = 0;
    this.balanceDebt = 0;
    this.flinchT = 0; this.flinchSide = 1;
    this.leadOn = false; this.leadSide = 'R'; this.leadPoint = new THREE.Vector3();
    this.leadW = new Spring(10, 1);
    this.flinchW = new Spring(16, 1);

    // Feet
    const mkFoot = (side) => {
      const sign = side === 'L' ? 1 : -1;
      const key = side === 'L' ? 'Left' : 'Right';
      const ankle = this.rest[key + 'Foot'].charPos;
      const toe = this.rest[key + 'ToeBase'];
      const flatQ = new THREE.Quaternion();
      if (toe) {
        const toeDir = toe.charPos.clone().sub(ankle), levelDir = toeDir.clone();
        levelDir.y = 0;
        if (toeDir.lengthSq() > 1e-8 && levelDir.lengthSq() > 1e-8) flatQ.setFromUnitVectors(toeDir.normalize(), levelDir.normalize());
      }
      const A = new THREE.Vector3(ankle.x, d.groundY, ankle.z).applyMatrix4(this.root.matrixWorld);
      const ball = A.clone().addScaledVector(this._fwd, d.ballFwd);
      return {
        side, sign, key, flatQ,
        planted: true,
        ball,
        yaw: this.heading,
        pitch: new Spring(42, 1),
        swing: null,
        pending: null,
        needWrap: false,
        sinceLand: 1,
        ankle: new THREE.Vector3(),
        prevAnkle: new THREE.Vector3(),
        ankleVel: new THREE.Vector3(), // ankle velocity (world), carried into the next swing
        prevPitch: 0,
        pitchVel: 0,
        rollTo: 0, // furthest toe-off roll the pelvis limit allowed for this frame
        pivotYaw: new Spring(28, 0.95),
        gaitStance: false,
        toe: new Spring(30, 1),
        swingAnkle: 0,
        swingW: 0,
        colTarget: 0,
        colPush: new Spring(24, 1),
      };
    };
    this.feet = { L: mkFoot('L'), R: mkFoot('R') };
    for (const f of Object.values(this.feet)) { f.slope = 0; f.crossSlope = 0; }
    this.rootY = new Spring(7, 1, this.root.position.y); // the body rides on its support (terrain)
    this.stairW = new Spring(4, 1);
    for (const f of Object.values(this.feet)) this._ankleFromPlant(f.ball, f.yaw, 0, f.ankle);

    // Weight distribution (fraction on left foot)
    this.weightL = new Spring(7, 1, 0.5);

    // Pelvis
    this.pelvisX = new Spring(7, 1);
    this.pelvisZ = new Spring(7, 1);
    this.pelvisY = new Spring(20, 0.85, d.hipsH);
    this.pelvisYaw = new Spring(18, 1);
    this.pelvisRoll = new Spring(14, 1);
    this.pelvisPitch = new Spring(10, 1);
    this.pelvisFinalY = d.hipsH;
    this.walkY = { peak: -Infinity, on: 0, w: 0, eased: false, L: { P: NaN, T: NaN, Ps: new Spring(6, 1), Ts: new Spring(6, 1) }, R: { P: NaN, T: NaN, Ps: new Spring(6, 1), Ts: new Spring(6, 1) } };
    this.hipY = { y: d.hipsH, v: 0, prev: d.hipsH, mode: 0, o: { x: 0, v: 0 } };
    this.surgeZ = 0; this.surgeApplied = 0; this.surgeYm = d.hipsH; // within-step speed rhythm
    this.runTouch = new Spring(6, 1, d.hipsH); // running: touchdown reach of the landing leg (smoothed)
    this.pelvisRise = new Spring(18, 1, d.hipsH); // walking: smooths the pelvis rising after toe-off
    this.guardReady = new Spring(9, 1);
    this.pelvisVelY = 0;
    this.pelvisAccY = new Spring(30, 1);
    this.pelvisAccLat = new Spring(20, 1);
    this.pelvisVelLat = 0;
    this.pelvisPrevLat = 0;

    // Trunk / head
    this.spineYaw = new Spring(13, 0.9);
    this.spinePitch = new Spring(10, 1);
    this.spineRoll = new Spring(10, 1);
    this.headYaw = new Spring(11, 1);
    this.spineRollTot = this.spineCounterRoll = this.swagger = 0; // spine lateral bend, and its counter-tilt against the pelvis
    this.headYawTot = this.headPitchTot = this.headRollTot = 0; // head incl. gaze stabilisation
    this.headPitch = new Spring(11, 1);
    this.headRoll = new Spring(11, 1);
    this.nod = new Spring(20, 0.45);
    this.trunkBounce = new Spring(18, 0.55);
    this.clavElev = { L: 0, R: 0 };
    this.shoulderSag = new Spring(14, 0.5); // vertical lag of the shoulder girdle (m, inertial)
    this.headSway = new Spring(9, 0.5);

    // Impulse modifiers
    this.comPert = new Spring3(3.4, 0.62);
    this.spineImp = new Spring3(9, 0.42);
    this.headImp = new Spring3(7.5, 0.34);
    this.pelvisImp = new Spring3(10, 0.6);

    // Arms (FK pendulum drives)
    const mkArm = () => ({
      swing: new Spring(6, 0.5),
      elbow: new Spring(16, 0.7, 12 * DEG),
      wrist: new Spring(14, 0.45),
      flop: new Spring(13, 0.35), fa: 0, faV: 0, // the hand hanging from the wrist (fore-aft, passive)
      prevElbowV: 0,
    });
    this.arm = { L: mkArm(), R: mkArm() };
    this.fingerCurl = new Spring(9, 1, 0);
    this.armAbd = { L: new Spring(10, 1), R: new Spring(10, 1) }; // collision abduction (rad)

    // Idle behaviour
    this.shift = new Spring(2.4, 1);
    this.shiftTarget = 0;
    this.shiftTimer = 3 + this.rng() * 4;
    this.gazeYaw = new Spring(9, 1);
    this.gazePitch = new Spring(9, 1);
    this.gazeTarget = { yaw: 0, pitch: 0 };
    this.gazeTimer = 2 + this.rng() * 3;

    // Breathing
    this.exertion = 0;
    this.breathPhase = 0;
    this.breathCycle = 0;
    this.breathDepth = 1;
    this.breath = 0;

    // Jumping
    this.jumpState = null;
    this.jumpQueued = -1;
    this.jumpBlend = new Spring(10, 1); // weight of the jump's arm / trunk poses over the gait's
    this.landOff = new Spring(10, 0.9); // landing absorption: pelvis offset over the normal height (m)
    this.jumpPose = { arm: { L: 0, R: 0 }, elbow: { L: 0, R: 0 }, trunk: 0, pelvis: 0, abd: 0 };

    // Strike (rear cross). Each kinetic-chain segment is a spring drive with staggered onset.
    this.strikeQueued = false;
    this.strikeT = -1;
    this.drives = {
      foot: { s: new Spring(28, 0.95), on: 0.0, off: 0.33 },
      hip: { s: new Spring(26, 0.9), on: 0.0, off: 0.3 },
      spine: { s: new Spring(32, 0.78), on: 0.035, off: 0.31 },
      shoulder: { s: new Spring(40, 0.72), on: 0.07, off: 0.29 },
      arm: { s: new Spring(52, 0.6), on: 0.09, off: 0.25 },
    };
    this.impactFired = false;
  }

  // -------------------------------------------------------------------------
  // Simulation (logic layer, sub-stepped)
  // -------------------------------------------------------------------------
  /** Direction to the look target relative to the body (runs standing and on the floor). */
  _updateLook(dt) {
    let w = 0;
    if (this.lookOn) {
      // Measured from the base of the neck (not the head, which moves as it turns), so the
      // direction doesn't feed back on itself.
      const head = (this.bones.Neck ?? this.bones.Head).getWorldPosition(this._t.v0), p = this.lookTarget;
      const dx = p.x - head.x, dy = p.y - head.y, dz = p.z - head.z;
      const yaw = wrapAngle(Math.atan2(dx, dz) - this.heading);
      // Behind her it is let go of (well before the left / right flip at 180°).
      w = 1 - smoothstep(95 * DEG, 125 * DEG, Math.abs(yaw));
      const ty = clamp(yaw, -70 * DEG, 70 * DEG), tp = clamp(Math.atan2(-dy, Math.hypot(dx, dz)), -30 * DEG, 40 * DEG);
      // Followed smoothly and no faster than a head turns (≈ 3 rad/s), so the look leads and
      // settles instead of snapping with every twitch of the mouse.
      const L = this.lookRel, k = 1 - Math.exp(-7 * dt), vmax = 3 * dt;
      L.yaw += clamp((ty - L.yaw) * k, -vmax, vmax);
      L.pitch += clamp((tp - L.pitch) * k, -vmax, vmax);
    }
    this.lookW.step(w, dt);
  }

  _simulate(dt) {
    this.time += dt;
    if (this.fallPending && (this.fallPending.t -= dt) <= 0) {
      const kind = this.fallPending.kind;
      this.fallPending = null;
      this.crawl.fall(kind);
    }
    this._updateLocomotion(dt);
    this._updateRootFrame();
    this._updateStrike(dt);
    this._updateJump(dt);
    this._updateFeet(dt);
    this._updateWeights(dt);
    this._updateBehaviours(dt);
    this._updatePelvis(dt);
    this._updateTrunk(dt);
    this._updateArms(dt);
    this.comPert.step(null, dt);
    this.spineImp.step(null, dt);
    this.headImp.step(null, dt);
    this.pelvisImp.step(null, dt);
  }

  _updateLocomotion(dt) {
    const L = this.dims.L;
    const guardW = this.guardW.step(this.guardTarget, dt);
    const cw = this.crouchW.step(this.crouchTarget, dt);
    this.braceW.step(this.braceTarget, dt);
    // Getting down to crawl (or back up) starts from a standstill.
    const crawlHold = this.crawl.goal !== 'stand' || this.crawl.state !== 'stand';
    let wantSpeed = this.guardTarget > 0.5 || crawlHold ? 0 : this.targetSpeed;
    // Tired legs give less: the sprint fades toward a jog.
    const jogV = this.traits.jogSpeed * Math.sqrt(L / 0.888);
    if (wantSpeed > jogV && !this.speedForce) wantSpeed = jogV + (wantSpeed - jogV) * (1 - 0.55 * this.fatigue);
    // Stairs ahead: slow to a stair pace (one tread per step, quicker steps).
    const stairs = this.stairW.step(this._stairsAhead() ? 1 : 0, dt);
    wantSpeed = mix(wantSpeed, Math.min(wantSpeed, 0.55 * Math.sqrt(L / 0.888)), stairs);
    // Gait initiation: weight goes onto the stance foot and the body tips forward before the first
    // step (anticipatory postural adjustment, ~0.3 s), so the speed only builds once it is done.
    const fL0 = this.feet.L, fR0 = this.feet.R;
    // Something is asked for (setting off, a strike, a jump, getting down): idle stance steps not
    // yet begun give way, and one under way hurries to finish, so the action starts at once.
    this._hurry = (wantSpeed > 0.01 && !this.gaitActive) || this.strikeQueued || this.jumpQueued >= 0 || this.crawl.state === 'waitStop';
    if (this._hurry) for (const f of [fL0, fR0]) if (f.pending && !f.pending.urgent) f.pending = null;
    if (wantSpeed > 0.01 && !this.gaitActive && this.speed.x < 0.25) {
      if (this.initT < 0) {
        const zl = this._t.v0.copy(fL0.ball).sub(fR0.ball).dot(this._fwd);
        this.initT = 0;
        this.initStance = zl < 0 ? 'R' : 'L'; // the trailing foot steps first
      }
      if (!fL0.swing && !fR0.swing) this.initT += dt;
    } else if (!this.gaitActive) this.initT = -1;
    // (≈ 0.3 s in a person; game control (agility) compresses it so the first step comes at once,
    // the weight shift still leading it.)
    const APA = 0.3 / (this.agility * this.agility);
    this.apaW = this.initT >= 0 ? smoothstep(0, APA, this.initT) : Math.max(0, this.apaW - dt / 0.25);
    const moving = this.gaitActive && wantSpeed > 0.01;
    // Speed is held around the target by a slow AR(1) process (people never walk at a constant speed).
    // (Not at superhuman speed, where a few percent is metres a second of surging back and forth.)
    const speedNoise = moving ? 0.025 * this.noiseSpeed.value * (1 - smoothstep(8, 20, this.speed.x)) : 0;
    let tgt = this.initT >= 0 && this.initT < APA ? wantSpeed * 0.4 * this.apaW : wantSpeed * (1 + speedNoise);
    // Braking is quicker than accelerating: a walker stops within about two steps (≈ 1 s) instead of
    // creeping to a halt; from a run, it takes longer.
    if (this.speed.v >= -0.05) this.brakeFrom = this.speed.x; // speed when the braking began
    this.brakeOmega = mix(5, 3.4, smoothstep(1.8, 3, this.brakeFrom)) * (crawlHold ? 1.8 : 1);
    this.speed.omega = (tgt > this.speed.x ? 2.6 * this.agility : this.brakeOmega * Math.sqrt(this.agility));
    this.stopping = tgt <= 0.01;
    const x0 = this.speed.x;
    // In the air, and while pushing off, momentum is what it is: no speeding up, braking or steering.
    const airborne = this.jumpState && (this.jumpState.phase === 'push' || this.jumpState.phase === 'air');
    if (airborne) { if (this.jumpState.speedTo != null && this.jumpState.phase === 'push') this.speed.x = mix(this.jumpState.speed0, this.jumpState.speedTo, smoothstep(0, 1, this.jumpState.t / this.jumpState.tPush)); this.speed.v = 0; }
    else this.speed.step(tgt, dt);
    // Sprinting is force-limited: the push-off accelerates hard from a standstill (≈ 7 m/s²) and
    // less and less near top speed (force–velocity), and nobody can stop from a sprint in a step.
    if (!airborne && Math.max(tgt, x0) > 1.25 * this.traits.jogSpeed * Math.sqrt(L / 0.888)) {
      // (The speed force: far harder, easing off toward its top speed, and it stops as hard.)
      const sf = this.speedForce;
      // (Scaled with the top speed, so a faster speed force still gets there in a few seconds.)
      const sk = Math.max(1, sf / 30);
      const aMax = sf > 0 ? mix(11, 4, clamp(x0 / sf, 0, 1)) * sk : Math.max(1.2, 7 * (1 - x0 / (1.15 * this.traits.sprintSpeed * Math.sqrt(L / 0.888))));
      // (Carried past a sprint by something else — a leap's momentum — it brakes harder from up there.)
      const dx = clamp(this.speed.x - x0, (sf > 0 ? -32 * sk : -(6 + 24 * this._fastW(x0))) * dt, aMax * dt);
      if (dx !== this.speed.x - x0) { this.speed.x = x0 + dx; this.speed.v = dx / dt; }
    }
    // The speed she travels at, and the one her legs run at. Past a sprint the speed force's legs
    // run at a fast sprint's speed at most (≈ 6.5 strides/s of ≈ 3 L: the fastest run the eye can
    // read, see F_CAP) whatever her real speed: the world goes by under her as if on a moving
    // walkway (the slip, below), and with contacts of a frame or less nobody sees the feet slide.
    const vTrue = Math.max(0, this.speed.x);
    const vCap = F_CAP * 4.4 * L * Math.sqrt(0.888 / L), qv = vTrue / vCap;
    const v = this.speedForce > SPEEDSTER ? vCap * qv / Math.pow(1 + qv ** 8, 1 / 8) : vTrue;
    this.accelFwd = this.speed.x > 0.01 ? this.speed.v : 0;
    // Lean from acceleration. Speeding up leans into it. Braking from a run leans back against it;
    // a walker stopping is carried forward a little instead (the feet stop, the trunk's inertia
    // does not: ≈ 2–4°), then rocks back past upright and settles (underdamped).
    const runBrake = smoothstep(1.8, 3, this.brakeFrom);
    this.brakeNod.step(Math.min(0, this.accelFwd) * mix(-0.3, 1, runBrake), dt);
    this.leanAccel = Math.max(0, this.accelFwd) + this.brakeNod.x;

    // Turning: max yaw rate falls with speed (centripetal limit), turn-in-place in idle.
    let maxTurn = mix(1.7, 1.05, smoothstep(0, 4, v)) * (1 - 0.6 * guardW) * this.agility;
    // (The speed force: no centripetal limit she obeys, and she answers the stick at once.)
    if (this.speedForce > 0) maxTurn = Math.max(maxTurn, 3.2 * this.agility);
    this.yawRate.omega = (this.speedForce > 0 ? 13 : 6) * Math.sqrt(this.agility);
    if (airborne) { this.yawRate.x = 0; this.yawRate.v = 0; } // no turning in the air
    else if (this.facing != null && !crawlHold) {
      // Aim lock: the heading is the aim (all but instantly); the yaw rate is what that takes,
      // so the leans, the head and the re-planting steps still answer to the turn.
      const err = wrapAngle(this.facing - this.heading), step = err * (1 - Math.exp(-30 * dt));
      // The rate the gait sees is smoothed: mouse jitter must not swing the predicted footholds
      // or the leans (the heading itself still follows the aim at once).
      const raw = clamp(step / Math.max(dt, 1e-4), -6, 6);
      this.yawRate.x += (raw - this.yawRate.x) * (1 - Math.exp(-8 * dt)); this.yawRate.v = 0;
      this.heading += step;
    } else this.yawRate.step(crawlHold ? 0 : this.turnInput * maxTurn, dt);
    if (this.facing == null || airborne) this.heading += this.yawRate.x * dt;
    // Turning at speed-force speeds bleeds speed: the harder the turn, the more it costs.
    if (this.speedForce > 0 && !airborne && this.speed.x > 4) this.speed.x *= Math.exp(-0.3 * Math.abs(this.yawRate.x) * dt);
    // Wander: walking direction drifts by a couple of degrees (accumulated sensorimotor noise),
    // a mean-reverting offset the steering corrects rather than a fixed curve.
    // (Faded out at superhuman speed: there a degree of drift is metres a second sideways, and the
    // steering correcting it reads as a weave.)
    if (this.gaitActive && v > 0.3 && this.facing == null) {
      const tau = 3, sd = 2.5 * DEG * (1 - 0.95 * smoothstep(8, 20, vTrue));
      const dw = -this.wander / tau * dt + sd * Math.sqrt(2 * dt / tau) * gauss(this.rng);
      this.wander += dw;
      this.heading += dw;
    }
    this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    // Travel direction: the heading, or off it while strafing (eased, so a change of direction
    // swings the steps round rather than snapping them).
    const tt = this.facing != null ? this.travelTarget : 0;
    const tErr = wrapAngle(tt - this.travel);
    this.travel += clamp(tErr * (1 - Math.exp(-10 * dt)), -5 * dt, 5 * dt);
    // A sharp change of strafe direction brakes first (a reversal plants and pushes off).
    if (Math.abs(tErr) > 0.7 && this.speed.x > 0.25) this.speed.x = Math.max(0.25, this.speed.x - 3.5 * (Math.abs(tErr) - 0.5) * dt);
    this._travelDir.set(Math.sin(this.heading + this.travel), 0, Math.cos(this.heading + this.travel));
    this.velocity.copy(this._travelDir).multiplyScalar(vTrue);
    if (this.driveRoot) {
      this.root.position.addScaledVector(this.velocity, dt);
      this.root.quaternion.setFromAxisAngle(UP, this.heading);
      // A speedster leans into a turn with her whole body, about her feet (a skater's or a rider's
      // lean): the root rolls about the way she is going, so the hips go in along the lean line and
      // the legs keep their length along it. (Leaned through the hips shifting over planted feet, the
      // legs splayed out to the side.)
      const roll = this.speedForce > SPEEDSTER ? this.turnLeanS ?? 0 : 0;
      if (Math.abs(roll) > 1e-4) this.root.quaternion.multiply(this._t.q7.setFromAxisAngle(this._t.v9.set(0, 0, 1), -roll));
      if (this.ground) this._rideTerrain(dt);
      // The walkway: everything the feet hold in the world goes along with her by the speed her
      // legs don't account for.
      const slip = (vTrue - v) * dt;
      if (slip > 1e-6) {
        const o = this._t.v0.copy(this._travelDir).multiplyScalar(slip);
        for (const f of [this.feet.L, this.feet.R]) {
          f.ball.add(o); f.ankle.add(o); f.prevAnkle.add(o);
          const sw = f.swing;
          if (sw) { sw.start.add(o); sw.startRoll.add(o); sw.targetBall.add(o); sw.end.add(o); sw.aim?.add(o); }
        }
      }
    }

    // Gait parameters (dynamic similarity: Froude number Fr = v²/gL). Walk→run at Fr ≈ 0.4
    // (~1.85 m/s), run→walk ~0.2 m/s lower (hysteresis); the switch completes within a step.
    const vs = v * Math.sqrt(0.888 / L); // speed of a dynamically similar 0.888 m leg
    const Fr = (v * v) / (G * L);
    const g = this.gait;
    // Setting off into a jog, people break into a run almost at once rather than speed-walking
    // up to the transition speed first.
    const wantFr = (wantSpeed * wantSpeed) / (G * L);
    const upFr = wantFr > this.traits.runUpFr ? 0.35 * this.traits.runUpFr : this.traits.runUpFr;
    if (!this.running && Fr > upFr) this.running = true;
    else if (this.running && Fr < upFr * 0.78) this.running = false;
    const rb = clamp((g.rb ?? 0) + (this.running ? 1 : -1) * Math.max(g.f, 1) * 2.2 * dt, 0, 1);
    const fWalk = 0.55 + 0.32 * vs + 0.22 * cw + 0.35 * this.stairW.x; // crouching and stair steps are shorter
    // Sprint intensity: past a jog, speed comes from much longer strides and a little more cadence
    // (≈ 3.5 steps/s, strides ≈ 3.6 m at 6.5 m/s for an untrained adult), shorter ground contact.
    const sprint = smoothstep(3.6, 6.0, vs);
    const fRun = 1.15 + 0.07 * vs + 0.22 * sprint; // recreational jog ≈ 160 steps/min at 2.6 m/s
    const fScale = Math.sqrt(0.888 / L);
    g.rb = rb;
    // Turning raises cadence so no step has to absorb more than ~45° of turn.
    const fGait = Math.max(mix(fWalk, fRun, rb), 0.8, 0.5 * Math.abs(this.yawRate.x) / (45 * DEG)) * fScale;
    // Braking keeps a quick cadence and shortens the steps instead of stretching into long strides.
    g.fHold = Math.max(fGait, (g.fHold ?? fGait) - 0.3 * fScale * dt);
    const fBase = this.speed.v < 0 ? g.fHold : (g.fHold = fGait);
    // Stride-time noise (CV ≈ 1.8 %, more when dawdling). At a given speed it trades cadence
    // against step length, which is how real stride variability is organised.
    const slow = mix(1.6, 1, smoothstep(0.5, 1.2, vs));
    g.f = fBase * (1 + 0.016 * slow * this.noiseCad.value);
    // Superhuman speed (the speed force, or any body driven past its own sprint): the cadence
    // climbs with the speed (strides capped near 3 L), the legs a blur, instead of stretching into
    // giant bounds. Eased in past the sprint so an ordinary run never changes.
    g.fast = this._fastW(v);
    // (The speed force runs a sprinter's long stride, ≈ 4.4 L: a step of 2.2 L, as elite sprinters'.)
    const SL = (this.speedForce > SPEEDSTER ? 4.4 : 3) * L;
    if (g.fast > 0) g.f = Math.max(g.f, v / mix(Math.max(v / Math.max(g.f, 1e-3), SL), SL, g.fast));
    // ...but never faster than the eye can read. A stride takes at least three frames to read as a
    // cycle (Williams: "two won't do it, it just flickers"); flat out, v / 3L would be ≈ 56 strides a
    // second, a whole cycle a frame, and the legs would creep backwards like a wagon wheel. So the
    // cycle eases into a cap of ≈ 6.5 strides/s (13 steps/s, the fastest readable run) and the
    // strides lengthen instead: long, flat bounds with contacts of a frame or less (the comics'
    // speedster, and Weyand's finding that faster runners press harder rather than swing faster).
    if (g.fast > 0) { const cap = F_CAP * fScale, q = g.f / cap; g.f = cap * q / Math.pow(1 + q ** 4, 0.25); }
    // The blur run (0..1): past ≈ 14 m/s the speed force's own carriage takes over (a deeper lean,
    // knife hands, a smaller arm swing).
    g.blur = this.speedForce > SPEEDSTER ? smoothstep(14, 40, vTrue) : 0;
    g.vTrue = vTrue;
    // Strafing (aim lock): side-steps can't cross over, so they are short and quick (≈ 0.5 L a
    // stride); backpedalling shortens the stride too.
    g.lat = Math.abs(Math.sin(this.travel)); g.back = Math.max(0, -Math.cos(this.travel));
    g.latK = smoothstep(0.12, 0.65, g.lat); // a diagonal already steps like a strafe
    if (g.lat > 0.01 || g.back > 0.01) g.f = Math.max(g.f, v / mix(mix(4 * L, 0.85 * L, g.back), 0.5 * L, g.latK));
    g.duty = mix(clamp(0.66 - 0.03 * vs, 0.58, 0.66) + 0.05 * cw, clamp(0.54 - 0.055 * vs - 0.02 * sprint, 0.2, 0.46), rb);
    // Any speed, human or not: the stance foot can only sweep so far under the hips (≈ 1.05 L
    // before the leg is out of reach), so past that the ground contact shortens and the stride
    // grows through flight instead — bounding strides with brief, hard contacts, as the spring-mass
    // pelvis below turns into long ballistic arcs. Below that it changes nothing.
    // (Nothing changes up to a human sprint; past it the allowed sweep tightens to ≈ 0.7 L, where
    // the flights carry the stride and a long sweep would only drag the hips down.)
    g.dutyReach = (L * mix(3, 0.7, smoothstep(6.5, 11, vs)) * g.f) / Math.max(v, 0.1);
    // (Running only: a walking stance sweeps a full step under a vaulting hip, heel to toe.)
    g.duty = Math.max(mix(0.07, 0.02, g.fast), mix(g.duty, Math.min(g.duty, g.dutyReach), rb));
    // (The blur run: short contacts, about two frames, so each leg still visibly plants and drives
    // out behind; shorter, the legs never reached the ground and read as tucked up under her.)
    g.duty = mix(g.duty, Math.min(g.duty, 0.17), g.blur);
    g.sprint = sprint * rb; // contact ≈ 0.15 s at a sprint (elite ≈ 0.1 s), long flights
    g.strideLen = v / g.f;
    g.locoW = smoothstep(0.05, 0.7, v) * (1 - guardW);
    g.drive = smoothstep(2.0, 5.5, vs); // running intensity: heel recovery, knee drive, arm drive
    g.swingH = L * 0.15 * (0.55 + 0.45 * smoothstep(0, 1.2, vs)) * (1 - 0.3 * cw);
    g.recH = L * (mix(0.4, 0.62, g.drive) + 0.12 * g.sprint); // heel recovery; sprinting folds the heel to the buttock
    // Turning widens the track a little so the thighs stay clear as the body leans.
    g.halfWidth = this.dims.hipHalf * (mix(this.style.stepWidth, this.style.stepWidthRun, rb) * (1 - 0.2 * g.sprint) + 0.3 * smoothstep(0.3, 1.2, Math.abs(this.yawRate.x)));
    g.v = v;
    g.slow = slow;

    // Gait activation and phase.
    const wantMove = (tgt > 0.01 && this.initT < 0) || v > 0.25 || this.initT >= APA;
    if (wantMove && !this.gaitActive && !this.jumpState && !this.feet.L.swing && !this.feet.R.swing) { this._startGait(); this.initT = -1; }
    if (!wantMove && this.gaitActive && !this.jumpState) {
      const gaitSwing = (f) => f.swing && f.swing.kind === 'gait';
      if (!gaitSwing(this.feet.L) && !gaitSwing(this.feet.R)) this.gaitActive = false;
    }
    if (this.gaitActive && !this.jumpState?.frozen) this.phase = wrap01(this.phase + g.f * dt);
  }

  /**
   * On terrain: anything taller than a big step (≈ 0.55 L) ahead is a wall that stops her; the body
   * rides at the height of its support (the planted feet, weighted by load), so it climbs a stair
   * as the weight goes onto the upper foot.
   */
  _rideTerrain(dt) {
    const d = this.dims, fL = this.feet.L, fR = this.feet.R, p = this.root.position;
    const support = (f) => f.ball.y - d.groundY;
    // (The ground where she was before this frame's move: the walls ahead are measured from it. From
    // where she is now, a stride in the air that carried her across a wall's face put her inside the
    // block, its top was the ground, there was no wall, and she rose up through it.)
    const px = p.x - this.velocity.x * dt, pz = p.z - this.velocity.z * dt, was = this.ground(px, pz);
    const base = fL.planted && fR.planted ? mix(support(fR), support(fL), this.weightL.x)
      : fL.planted ? support(fL) : fR.planted ? support(fR) : Math.max(this.rootY.x, was); // in flight, rising ground lifts her
    // Swept: faster than a big step a frame (the speed force), every stretch of the way is tested,
    // or she would pass through a wall between two frames.
    const moved = this.speed.x * dt;
    if (moved > 0.12 && this.speed.x > 0) {
      const n = Math.ceil(moved / 0.1), dx = this.velocity.x * dt / n, dz = this.velocity.z * dt / n;
      const x0 = px, z0 = pz, here = Math.max(base, was);
      for (let i = 1; i <= n; i++) {
        const x = x0 + dx * i, z = z0 + dz * i;
        if (this.ground(x + this._fwd.x * 0.3 * d.L, z + this._fwd.z * 0.3 * d.L) - here > 0.55 * d.L) {
          p.x = x - dx; p.z = z - dz;
          const sp = this.speed.x;
          this.speed.x = 0; this.speed.v = 0;
          this.onWallHit?.(sp, this._fwd.clone());
          break;
        }
      }
    }
    const ahead = this.ground(p.x + this._fwd.x * 0.3 * d.L, p.z + this._fwd.z * 0.3 * d.L);
    // (Measured from the ground under her too: in a running flight the body's height lags a slope.)
    if (ahead - Math.max(base, was) > 0.55 * d.L && this.speed.x > 0) {
      p.addScaledVector(this.velocity, -dt);
      // (Too fast to have stopped in a step: that is a hit, whichever test found the wall.)
      if (this.speed.x > 9) { const sp = this.speed.x; this.speed.x = 0; this.speed.v = 0; this.onWallHit?.(sp, this._fwd.clone()); }
      else { this.speed.x *= 0.5; this.speed.v = 0; }
    }
    // A drop ahead: walking, she stops at the edge (and teeters if she came at it briskly); running,
    // she goes over. (Unless edgeStop is off: a superhero walks straight off.) With no support left under her at all, she falls.
    const dropAhead = base - this.ground(p.x + this._fwd.x * 0.32 * d.L, p.z + this._fwd.z * 0.32 * d.L);
    if (dropAhead > 0.65 * d.L && this.speed.x > 0 && this.edgeStop) {
      const walking = this.speed.x < 1.25 * this.traits.walkSpeed;
      if (walking) {
        if (!this.nmOwned && this.speed.x > 0.6 && this.time - (this._teeterT ?? -9) > 2.5) { this._teeterT = this.time; this.onTeeter?.(this._fwd.clone()); }
        p.addScaledVector(this.velocity, -dt);
        this.speed.x *= 0.3; this.speed.v = 0;
      }
    }
    if (base - this.ground(p.x, p.z) > 0.65 * d.L) this.onFallOff?.();
    this.rootY.step(base, dt);
    p.y = this.rootY.x;
  }

  /**
   * A landing spot (ankle ground point, world) is moved along the foot so the foot is not left
   * straddling a step edge: the whole foot goes onto one level, whichever way is the shorter
   * move (heel to toe tip). Sets y to that level.
   */
  _settleOnStep(A, yaw) {
    const d = this.dims;
    if (!this.ground) { A.y = this._rootPos.y + d.groundY; return A; }
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hAt = (u) => this.ground(A.x + fx * u, A.z + fz * u);
    const toe = d.ballFwd + 0.09 * d.L; // the toes reach this far past the ankle
    const hh = hAt(-d.heelBack);
    let edge = null;
    for (let u = -d.heelBack + 0.02; u <= toe; u += 0.02) {
      if (Math.abs(hAt(u) - hh) > 0.02 && Math.abs(Math.atan2(hAt(u) - hh, u + d.heelBack)) > 25 * DEG) {
        let lo = u - 0.02, hi = u;
        for (let i = 0; i < 6; i++) { const m = 0.5 * (lo + hi); if (Math.abs(hAt(m) - hh) < 0.005) lo = m; else hi = m; }
        edge = 0.5 * (lo + hi);
        break;
      }
    }
    if (edge !== null) {
      const m = 0.012 * d.L, fwd = edge + d.heelBack + m, back = edge - toe - m;
      const shift = Math.abs(fwd) < Math.abs(back) ? fwd : back;
      A.x += fx * shift; A.z += fz * shift;
    }
    A.y = Math.max(hAt(-d.heelBack), hAt(d.ballFwd)) + d.groundY;
    // Too high to step up onto (a wall, as in _rideTerrain): the foot comes down short of it, not
    // on top. (Not in a jump: that may land on a box.)
    const top = this.root.position.y + 0.55 * d.L;
    if (!this.jumpState && A.y - d.groundY > top) {
      const x0 = A.x, z0 = A.z;
      for (let u = 0.02; u < 1.5 * d.L; u += 0.02) {
        A.x = x0 - fx * u; A.z = z0 - fz * u;
        const hb = hAt(-d.heelBack), ht = hAt(toe);
        if (hb <= top && ht <= top) { A.y = Math.max(hb, hAt(d.ballFwd)) + d.groundY; return A; }
      }
      A.x = x0; A.z = z0;
    }
    // Too far down to step down to (a ledge): the foot comes down on the top, at its edge, never
    // reaching down to the floor below (the leg reaching for it dragged the hips down off the top,
    // and the fall then started from there with a jolt). Walking on, the body passes over the drop
    // with no support under it, which is what starts the fall (_rideTerrain), from the top's height.
    // (0.65 L: the same drop at which _rideTerrain lets go. A step between can be stepped down.)
    const floor = this.root.position.y - 0.65 * d.L;
    if (!this.jumpState && A.y - d.groundY < floor) {
      const x0 = A.x, z0 = A.z;
      for (let u = 0.02; u < 1.5 * d.L; u += 0.02) {
        A.x = x0 - fx * u; A.z = z0 - fz * u;
        const hb = hAt(-d.heelBack), ht = hAt(toe);
        if (hb >= floor && ht >= floor) { A.y = Math.max(hb, hAt(d.ballFwd)) + d.groundY; return A; }
      }
      // (Nothing in reach: keep the foot level with the body, over the drop; the fall takes over.)
      A.x = x0; A.z = z0; A.y = this.root.position.y + d.groundY;
    }
    return A;
  }

  /**
   * How far into superhuman running a speed is, 0..1: always 1 with the speed force; otherwise
   * eased in from just past this body's own top sprint.
   */
  _fastW(v) {
    if (this.speedForce > 0) return 1;
    const top = this.traits.sprintSpeed * Math.sqrt(this.dims.L / 0.888);
    return smoothstep(1.1 * top, 1.7 * top, v);
  }

  /** The speed lean: at superhuman speed the body runs low over it, whatever the acceleration (rad). */
  _speedLean(g) {
    if (this.jumpState) return 0;
    // The speed force: on a log curve (felt at every speed, not spent by a sprint) up to ≈ 32°, the
    // comics' and the CW's run (a sprinter goes upright by 30 m; she never does).
    if (this.speedForce > SPEEDSTER) { const k = clamp(Math.log(Math.max(g.vTrue ?? g.v, 1) / 5) / Math.log(8), 0, 1); return k * k * (3 - 2 * k) * g.locoW * 32 * DEG; }
    return this._fastW(g.v) * smoothstep(6, 18, g.v) * g.locoW * 20 * DEG;
  }

  /**
   * The lean into a turn (rad, + to the left): tan θ = v·ω/g. A person's is held to ≈ 18°; the speed
   * force's is a skater's, 40°·tanh(θ / 40°), from her true speed, not her legs'. It is a lean of the
   * whole body (the hips and trunk roll with it, the hips shift in only a little): leaned through a
   * sideways shift of the hips over planted feet, the legs splayed out to the side.
   */
  _turnLean(g) {
    if (this.speedForce > SPEEDSTER) {
      // (Past a hard turn the cap opens toward 58°: the skater's touch-down lean, the inside hand on the ground.)
      const th = Math.atan(((g.vTrue ?? g.v) * this.yawRate.x) / G), M = (40 + 18 * (this.hardTurnW ?? 0)) * DEG;
      // (Scaled by how hard she is turning too: flat out, physics alone makes a 2°/s correction a
      // 28° lean, and every touch of the mouse would rock her side to side.)
      // (Only at speed: walking or jogging round a tight turn, physics alone leaned her 30° and every
      // turn of the view tipped her over; the lean comes in from a run to past a sprint.)
      return M * Math.tanh(th / M) * smoothstep(0.05, 0.9, Math.abs(this.yawRate.x)) * smoothstep(4, 12, g.vTrue ?? g.v) * g.locoW;
    }
    return clamp(Math.atan((g.v * this.yawRate.x) / G), -0.32, 0.32);
  }

  /** The lean into acceleration (rad): atan(a/g); the speed force's eases out as she gets going (a start, not a held crouch). */
  _accLean(g, a) {
    const lean = Math.atan(clamp(a, -6, 6) / G);
    return this.speedForce > SPEEDSTER && a > 0 ? lean * mix(1, 0.3, smoothstep(8, 45, g.vTrue ?? g.v)) : lean;
  }

  /** Step edges (a sharp height change) within ~1.2 m ahead along the heading. */
  _stairsAhead() {
    if (!this.ground) return false;
    const p = this._rootPos, fx = this._fwd.x, fz = this._fwd.z, L = this.dims.L;
    let prev = this.ground(p.x, p.z);
    for (let u = 0.05; u <= 1.35 * L; u += 0.05) {
      const h = this.ground(p.x + fx * u, p.z + fz * u);
      // (Without edgeStop a drop deeper than a step is not a stair to slow down for: she goes over.)
      if (Math.abs(h - prev) > 0.03 && (this.edgeStop || prev - h < 0.65 * L)) return true;
      prev = h;
    }
    return false;
  }

  /** Foot progression angle: a habitual toe-out per foot, narrowing when running. */
  _toeOut(foot) {
    return mix(this.traits.toeOut[foot.side], 3 * DEG, this.gait.rb);
  }

  /** Duty factor for one foot, including the persistent stance-time bias of the longer side. */
  _duty(foot) {
    return this.gait.duty + this.traits.dutyBias[foot.side];
  }

  /** How far a trailing foot may roll onto its toes at toe-off (foot pitch, rad). */
  _maxRoll() {
    return -(mix(this.style.maxRoll, 68, this.gait.rb) + 7 * (this.gait.sprint ?? 0)) * DEG;
  }

  /** Whether a planted foot, rolled fully onto its toes, is out of reach of its hip (last frame's height). */
  _trailsOutOfReach(foot) {
    const d = this.dims, hj = d.hipJoint[foot.side];
    const hip = this._t.v5.set(
      this.pelvisX.x + this.rest.Hips.charPos.x + hj.x,
      this.pelvisFinalY + d.groundY + hj.y,
      this.pelvisZ.x + this.rest.Hips.charPos.z + hj.z,
    ).applyMatrix4(this.root.matrixWorld);
    const A = this._ankleFromPlant(foot.ball, foot.yaw + foot.pivotYaw.x, this._maxRoll(), this._t.v6);
    return A.distanceToSquared(hip) > (d.reach * 0.995) ** 2;
  }

  /**
   * Where a gait step lands, as a fraction of half the stance sweep ahead of the hips at touchdown.
   * Running lands closer under the body than walking does (a long reach out in front is the
   * overstride that makes a runner look pushed along from behind, and sinks the hips onto a
   * slanted leg).
   */
  _placeK() {
    return mix(0.9, 0.72, this.gait.rb);
  }

  /**
   * Gait stance progress 0..1. A foot that lands a moment before its phase wraps is at the
   * start of its stance, not the end.
   */
  _stanceS(foot) {
    if (foot.needWrap) return 0;
    return clamp(wrap01(this.phase + (foot.side === 'R' ? 0.5 : 0)) / this._duty(foot), 0, 1);
  }

  _startGait() {
    // Lift the trailing foot first (the one further behind along the direction of travel).
    const fL = this.feet.L, fR = this.feet.R;
    const zl = this._t.v0.copy(fL.ball).sub(fR.ball).dot(this._fwd);
    const d = this.gait.duty;
    this.phase = zl < 0 ? d - 0.015 : wrap01(d - 0.515);
    fL.pending = fR.pending = null;
    fL.needWrap = fR.needWrap = false;
    this.gaitActive = true;
  }

  // ----- Strike (kinetic chain) -------------------------------------------
  _updateStrike(dt) {
    if (this.strikeQueued && this.strikeT < 0) {
      // (Not waiting for the guard stance to be stepped into exactly: the strike's own foot drive
      // sets it; only a gait step still in the air is waited for.)
      const gaitSwing = (f) => f.swing && f.swing.kind !== 'event';
      const settled = !gaitSwing(this.feet.L) && !gaitSwing(this.feet.R) && this.speed.x < 0.9;
      if (this.guardW.x > 0.5 && settled) {
        this.strikeQueued = false;
        this.strikeT = 0;
        this.impactFired = false;
      }
    }
    const t = this.strikeT;
    // (The speed force throws its punches about twice as fast: mashed, a flurry.)
    const ks = this.speedForce > 0 ? 1.9 : 1;
    for (const k in this.drives) {
      const dr = this.drives[k];
      const on = t >= dr.on && t < dr.off ? 1 : 0;
      dr.s.step(on, dt * ks);
    }
    if (t >= 0) {
      this.strikeT += dt * ks;
      // Impact: antagonist braking + reaction torque on the trunk (follow-through deceleration).
      if (!this.impactFired && this.drives.arm.s.x > 0.97) {
        this.impactFired = true;
        this.spineImp.impulse(this._t.v0.set(-0.9, 0.6, 0));
        this.pelvisY.impulse(-0.12);
        this.exertion = Math.min(1, this.exertion + 0.05);
      }
      if (this.strikeT > 0.62) this.strikeT = -1;
    }
  }


  // ----- Jumping --------------------------------------------------------------
  //
  // Phases: prep → push → air → land. Each hands over with continuous position and speed:
  //  · prep  standing: a countermovement (hips sink ≈ 0.2 L, arms swing back, trunk flexes);
  //          moving: wait for the take-off foot to land; leaps and long jumps lower the hips a
  //          little on the step before (penultimate-step lowering, 3–4 cm).
  //  · push  the support leg(s) extend and the heels rise; the hips follow a Hermite curve from
  //          where they are to the take-off height (full reach on the toes) at take-off speed vz.
  //          Moving: the free leg drives up; a long jump trades ≈ 10 % of the run-up speed for lift.
  //  · air   a ballistic arc (falling at g); horizontal speed held (no steering in the air). The
  //          legs follow poses relative to the hips (tuck, knee drive, trailing leg) and converge on
  //          their landing spots.
  //  · land  forefoot first; the pelvis keeps its landing speed and is caught by a damped spring
  //          on top of the normal height solver, so the absorption depth follows from the impact
  //          and decays into the walk, run or stance without a seam. Moving: the gait resumes with
  //          the landing foot at the start of its stance.

  /** Pelvis height the leg could reach to an ankle at `aRoot` (root frame), hips `lead` ahead. */
  _reach(f, aRoot, lead = 0) {
    const d = this.dims;
    const qP = quatYawRollPitch(this.pelvisYaw.x, this.pelvisRoll.x, this.pelvisPitch.x, this._t.q3);
    const off = this._t.v2.copy(d.hipJoint[f.side]).applyQuaternion(qP);
    const hx = this.pelvisX.x + this.rest.Hips.charPos.x + off.x + this.comPert.x.x;
    const hz = this.pelvisZ.x + this.rest.Hips.charPos.z + off.z + this.comPert.x.z + lead;
    const hor2 = (hx - aRoot.x) ** 2 + (hz - aRoot.z) ** 2;
    return aRoot.y - d.groundY + Math.sqrt(Math.max(d.reach * d.reach - hor2, 0)) - off.y;
  }

  /** Reach of a planted foot rolled onto its toes by `pitch`, hips `lead` further ahead. */
  _reachRolled(f, pitch, lead) {
    const a = this._ankleFromPlant(f.ball, f.yaw + f.pivotYaw.x, pitch, this._t.v4);
    return this._reach(f, this._toRoot(a, this._t.v4), lead);
  }

  _updateJump(dt) {
    const g = this.gait, d = this.dims, L = d.L, st = this.style;
    const fL = this.feet.L, fR = this.feet.R;
    // A request is kept for a moment, so a press just before landing (or while a stance step
    // finishes) still jumps.
    if (this.jumpQueued >= 0 && this.jumpState?.phase === 'land') this.jumpQueued = this.time; // buffered until it can go
    if (this.jumpQueued >= 0 && this.time - this.jumpQueued > 0.6) this.jumpQueued = -1;
    if (!this.jumpState && this.jumpQueued >= 0 && this.strikeT < 0) {
      const moving = this.gaitActive && g.v > 0.5;
      if (!moving) {
        // A stance-correction step not yet under way gives way to the jump.
        if (fL.planted && fR.planted) fL.pending = fR.pending = null;
        // (An idle step in the air finishes first, hurried.)
        const ready = fL.planted && fR.planted;
        if (ready) {
          this.jumpState = { type: 'stand', phase: 'prep', t: 0, tPrep: 0.2, D: L * mix(0.2, 0.14, this.guardW.x), y0: this.pelvisFinalY, support: [fL, fR] };
          this.jumpQueued = -1;
        }
      } else {
        const type = g.sprint > 0.5 ? 'long' : g.rb > 0.5 ? 'leap' : 'hop';
        // Take off from the next foot to land (or the one just landed, if early in its stance).
        let takeoff = null;
        for (const f of [fL, fR]) if (f.planted && f.gaitStance && this._stanceS(f) < 0.45 && !f.needWrap) takeoff = f;
        if (!takeoff) {
          const sw = [fL, fR].filter((f) => f.swing?.kind === 'gait').sort((a, b) => b.swing.t - a.swing.t);
          takeoff = sw[0] || null;
        }
        if (takeoff) {
          this.jumpState = { type, phase: 'prep', t: 0, takeoff, lead: takeoff === fL ? fR : fL, support: [takeoff], y0: this.pelvisFinalY };
          this.jumpQueued = -1;
        }
      }
    }
    const j = this.jumpState;
    if (!j) { this.jumpBlend.step(0, dt); return; }
    j.t += dt;
    const P = this.jumpPose;

    if (j.phase === 'prep') {
      if (j.type === 'stand') {
        const u = smoothstep(0, 1, j.t / j.tPrep);
        P.arm.L = P.arm.R = -55 * u; P.elbow.L = P.elbow.R = 20; P.trunk = 28 * u; P.pelvis = 12 * u; P.abd = 0;
        if (j.t >= j.tPrep) this._jumpPush(j);
      } else {
        // Moving: carry on with the gait until the take-off foot is down, then push off it.
        const f = j.takeoff;
        // (The blur run's contacts are a frame or less, and land late on purpose: any contact will do.)
        if (f.planted && f.gaitStance && (!f.needWrap || (g.blur ?? 0) > 0.5)) this._jumpPush(j);
        else if (!this.gaitActive && fL.planted && fR.planted) {
          // Came to a stop before the take-off step: jump from standing instead.
          this.jumpState = { type: 'stand', phase: 'prep', t: 0, tPrep: 0.2, D: L * mix(0.2, 0.14, this.guardW.x), y0: this.pelvisFinalY, support: [fL, fR] };
        } else if (j.t > 1.2) this.jumpState = null; // could not find the step: give up
      }
    } else if (j.phase === 'push') {
      const u = clamp(j.t / j.tPush, 0, 1);
      this._jumpArms(j, -1 + u);
      if (j.t >= j.tPush) this._jumpAir(j);
    } else if (j.phase === 'air') {
      const phi = clamp(j.t / j.T, 0, 1);
      this._jumpArms(j, phi);
      if (j.t >= j.T) this._jumpLand(j);
    } else if (j.phase === 'land') {
      const k = smoothstep(0, 0.25, j.t);
      const im = j.impact;
      if (j.type === 'stand') { P.arm.L = P.arm.R = mix(40, 30, k); P.elbow.L = P.elbow.R = 35; P.trunk = (10 + 22 * im) * (1 - smoothstep(0.15, 0.7, j.t)); P.pelvis = 10 * im; P.abd = 10; }
      else { P.trunk = mix(P.trunk, 6 + 18 * im, k); P.abd = mix(P.abd, 4, k); }
      // The landing's poses play out, then the jump is over (its absorption decays on, in landOff),
      // so the next jump can follow straight away.
      if (j.t > (j.type === 'stand' ? 0.45 : 0.22)) this.jumpState = null;
    }
    // Moving jumps start their poses from the arms' own swing (see _jumpPush), so they can blend in
    // fast and be fully driven by take-off; on landing they hand straight back to the gait's swing.
    const stand = j.type === 'stand';
    const posed = j.phase === 'push' || j.phase === 'air' || (j.phase === 'prep' && stand) || (j.phase === 'land' && j.t < (stand ? 0.45 : 0.06));
    this.jumpBlend.omega = j.phase === 'land' ? (stand ? 5 : 9) : stand ? 10 : 24;
    this.jumpBlend.step(posed ? 1 : 0, dt);
  }

  /** Arm / trunk / pelvis poses through push (phi −1 → 0) and flight (0 → 1). Degrees. */
  _jumpArms(j, phi) {
    const P = this.jumpPose, sideT = j.takeoff?.side;
    const up = smoothstep(-1, 0, phi), late = smoothstep(0.4, 1, phi);
    if (j.type === 'stand') {
      // Arms swing from behind the hips to forward-up through the push, then come down forward
      // for the landing; the trunk straightens for take-off and folds a little in the air.
      const a = phi < 0 ? mix(-55, 115, smoothstep(-0.9, 0, phi)) : mix(115, 45, smoothstep(0.1, 1, phi));
      P.arm.L = P.arm.R = a;
      P.elbow.L = P.elbow.R = phi < 0 ? 12 : mix(15, 30, phi);
      P.trunk = phi < 0 ? mix(28, -2, smoothstep(-1, 0, phi)) : mix(-2, 8, smoothstep(0, 0.5, phi));
      P.pelvis = phi < 0 ? mix(12, 0, up) : 2 + 4 * late;
      P.abd = 6 * late;
    } else if (j.type === 'hop') {
      // Walking hop: an exaggerated walking arm swing in opposition to the knee drive (take-off-side
      // arm forward), easing back toward neutral as the free leg reaches for the landing.
      const from = (s) => j.arm0?.[s] ?? 0, fe = (s) => j.elbow0?.[s] ?? 20;
      const fwd = 38 - 14 * late, back = -24 + 10 * late;
      for (const s of ['L', 'R']) {
        P.arm[s] = mix(from(s), s === sideT ? fwd : back, up);
        P.elbow[s] = mix(fe(s), s === sideT ? 40 : 18, up);
      }
      P.trunk = 3 + 4 * late; P.pelvis = 0; P.abd = 6 * up;
    } else if (j.type === 'leap') {
      // Running leap: the arm on the take-off side drives forward-up with the free knee, the other
      // reaches back (a split of the arms opposing the legs'), held through the flight; both settle
      // into the run's carriage for the landing.
      const from = (s) => j.arm0?.[s] ?? 0, fe = (s) => j.elbow0?.[s] ?? 85;
      const fwd = 95 - 40 * late, back = -55 + 20 * late;
      for (const s of ['L', 'R']) {
        P.arm[s] = mix(from(s), s === sideT ? fwd : back, up);
        P.elbow[s] = mix(fe(s), s === sideT ? mix(55, 80, late) : mix(30, 70, late), up);
      }
      P.trunk = 8 + 6 * late; P.pelvis = 2; P.abd = 4 + 10 * up - 6 * late;
    } else {
      // Long jump: both arms drive up at take-off (take-off side higher), "sail" overhead, then
      // sweep forward and down as the legs reach out for the landing; trunk upright at take-off,
      // folding forward to land.
      const tSide = phi < 0 ? 95 : mix(95, 130, smoothstep(0, 0.4, phi)) - 105 * late;
      const oSide = phi < 0 ? 55 : mix(55, 125, smoothstep(0, 0.4, phi)) - 100 * late;
      const from = (s) => j.arm0?.[s] ?? 0, fe = (s) => j.elbow0?.[s] ?? 90;
      for (const s of ['L', 'R']) {
        P.arm[s] = phi < 0 ? mix(from(s), s === sideT ? tSide : oSide, up) : s === sideT ? tSide : oSide;
        P.elbow[s] = phi < 0 ? mix(fe(s), 60, up) : mix(40, 25, late);
      }
      P.trunk = phi < 0 ? 2 : mix(4, 22, late); P.pelvis = 2 + 4 * late; P.abd = 14 * smoothstep(0, 0.3, phi);
    }
  }

  _jumpPush(j) {
    const g = this.gait, L = this.dims.L, st = this.style;
    j.phase = 'push'; j.t = j.type === 'stand' ? Math.max(0, j.t - j.tPrep) : 0; j.frozen = true; // keep the time past the boundary
    j.yS = this.pelvisFinalY; j.vS = this.pelvisVelY;
    const sex = Math.min(st.jumpVz / 2.2, st.jumpMoveCap ?? Infinity); // men jump higher
    if (j.type === 'stand') {
      j.tPush = 0.24;
      j.vz = st.jumpVz * (1 - 0.15 * this.guardW.x);
      j.yTo = Math.min(this._reachRolled(this.feet.L, -45 * DEG, 0), this._reachRolled(this.feet.R, -45 * DEG, 0)) - 0.005 * L;
    } else {
      const v = g.v;
      j.tPush = j.type === 'hop' ? 0.24 : j.type === 'leap' ? clamp(g.duty / g.f, 0.16, 0.24) : 0.15;
      j.vz = (j.type === 'hop' ? 1.2 : j.type === 'leap' ? 1.8 : 2.3) * sex;
      j.speed0 = this.speed.x;
      j.arm0 = { L: this.arm.L.swing.x / DEG, R: this.arm.R.swing.x / DEG };
      j.elbow0 = { L: this.arm.L.elbow.x / DEG, R: this.arm.R.elbow.x / DEG };
      j.speedTo = this.speed.x * (j.type === 'long' ? 0.9 : j.type === 'leap' ? 0.97 : 1) * (st.jumpCarry ?? 1);
      const vMean = 0.5 * (j.speed0 + j.speedTo);
      j.yTo = this._reachRolled(j.takeoff, -50 * DEG, vMean * j.tPush) - 0.005 * L;
      // The free leg leaves the ground now (walking) or is already swinging (running): it drives up.
      this._beginAir(j.lead, 'lead', j);
    }
    j.yTo = Math.max(j.yTo, j.yS + 0.01 * L); // the push must end higher than it starts
  }

  _jumpAir(j) {
    const g = this.gait, d = this.dims, L = d.L;
    j.phase = 'air'; j.t = Math.max(0, j.t - j.tPush);
    for (const f of j.support) this._beginAir(f, j.type === 'stand' ? 'stand' : 'trail', j);
    // Landing spots and height. The root travels straight on at the take-off speed.
    // (The legs' speed: past it the walkway carries the landing spot along with her through the flight.)
    const v = this.gait.v, fwd = this._fwd;
    const landers = j.type === 'stand' ? [this.feet.L, this.feet.R] : [j.lead];
    const guessT = 2 * j.vz / G;
    const solveT = (yLand) => {
      const disc = j.vz * j.vz + 2 * G * Math.max(j.yTo - yLand, -j.vz * j.vz / (2 * G) + 1e-4);
      return (j.vz + Math.sqrt(Math.max(disc, 0))) / G;
    };
    const plan = (T) => {
      let yLand = Infinity;
      for (const f of landers) {
        const sw = f.swing;
        let yaw, xR, zR;
        if (j.type === 'stand') {
          const a = this._toRoot(f.ankle, this._t.v6); // land where it took off (relative to the body)
          yaw = f.yaw; xR = a.x; zR = clamp(a.z, -0.1 * L, 0.1 * L) + 0.03 * L;
        } else {
          // Running landing: like a gait touchdown at the speed carried, ahead of the hips.
          const tSt = g.duty / g.f;
          yaw = this.heading + f.sign * this._toeOut(f);
          xR = f.sign * g.halfWidth;
          zR = this.rest.Hips.charPos.z + this.pelvisZ.x + v * tSt * 0.5 * this._placeK();
        }
        // Ball point in the world at landing time (root moved v·T forward).
        const A = this._t.v7.set(xR, 0, zR).applyQuaternion(this._rootQ).add(this._rootPos).addScaledVector(fwd, v * T);
        this._settleOnStep(A, yaw);
        // (Never onto a floor far above the one she left — a cliff's top 70 m up, at the far end of a
        // fast leap — which no leg can reach: the wall in the way is the root's to meet.)
        if (A.y > this._rootPos.y + L) A.y = this._rootPos.y + d.groundY;
        sw.targetYaw = yaw;
        this._ballFromAnkleGround(A, yaw, sw.targetBall);
        sw.landPitch = j.type === 'stand' ? -14 * DEG : this._landPitch(g.rb);
        this._ankleFromPlant(sw.targetBall, yaw, sw.landPitch, sw.end);
        sw.gaitLanding = j.type !== 'stand';
        // Hip height at which this leg just reaches its landing ankle (hips at the same relative spot).
        const aR = this._toRoot(this._t.v8.copy(sw.end).addScaledVector(fwd, -v * T), this._t.v8);
        yLand = Math.min(yLand, this._reach(f, aR, 0) - (j.type === 'stand' ? 0.02 : 0.015) * L);
      }
      return yLand;
    };
    let T = guessT;
    for (let i = 0; i < 3; i++) { j.yLand = plan(T); T = solveT(j.yLand); }
    j.T = T;
    this.lastLiftoff = this.time;
  }

  /** Puts a foot into the air for a jump. Role: 'stand' (two-footed), 'lead' (free leg), 'trail'. */
  _beginAir(f, role, j) {
    if (f.swing?.kind !== 'air') {
      const startPitch = f.pitch.x;
      this._beginSwing(f, 'air', { t: 0 });
      f.swing.startPitch = startPitch;
    }
    const sw = f.swing;
    sw.role = role; sw.age = 0;
    sw.start.copy(f.ankle); sw.v0.copy(f.ankleVel);
    f.gaitStance = false;
    f.pending = null;
  }

  /** Ankle and foot pitch of a foot in the air (called from _updateFeet). */
  _updateAirFoot(f, dt) {
    const j = this.jumpState, sw = f.swing, d = this.dims, L = d.L;
    sw.age += dt;
    if (!j) { // jump abandoned mid-way (should not happen): drop the foot straight down
      sw.kind = 'event'; sw.t = 0.5; return;
    }
    // Flight fraction: −1 → 0 through the push (free leg), 0 → 1 in the air.
    const phi = j.phase === 'push' ? -1 + clamp(j.t / j.tPush, 0, 1) : j.phase === 'air' ? clamp(j.t / j.T, 0, 1) : 1;
    // Hip-relative pose: drop of the ankle below the hip joint and its reach forward (× L).
    let drop, fwd, pitch;
    const k = smoothstep;
    if (sw.role === 'stand') {
      drop = phi < 0.45 ? mix(0.95, 0.78, k(0, 0.45, phi)) : mix(0.78, 0.9, k(0.45, 1, phi));
      fwd = 0.05 * k(0, 0.45, phi);
      pitch = mix(-45, -25, k(0, 0.4, phi));
    } else if (sw.role === 'lead') {
      // Knee drive: the thigh comes up toward horizontal with the shin hanging, then the leg
      // reaches forward and down for the landing.
      const u = k(-1, 0, phi);
      drop = mix(0.8, j.type === 'hop' ? 0.75 : 0.6, u);
      fwd = mix(0.05, j.type === 'hop' ? 0.25 : 0.38, u);
      if (j.type === 'leap') {
        // Leap: past the knee drive the shin swings out, reaching forward into the split.
        const ext = k(0.1, 0.5, phi);
        drop = mix(drop, 0.7, ext); fwd = mix(fwd, 0.55, ext);
      }
      pitch = mix(-20, 0, u);
    } else {
      // Trailing (take-off) leg: extended behind at take-off, heel folding up; a leap holds it
      // behind (split), a long jump brings it through so both knees are up for the landing.
      const fold = k(0, 0.35, phi);
      drop = mix(0.92, 0.66, fold);
      fwd = mix(-0.42, -0.36, fold);
      if (j.type === 'leap') {
        // Leap: the take-off leg stays long behind (a split), the knee only softening.
        drop = mix(0.92, 0.8, fold); fwd = mix(-0.42, -0.5, fold);
      }
      if (j.type === 'long') { drop = mix(drop, 0.62, k(0.35, 0.9, phi)); fwd = mix(fwd, 0.1, k(0.35, 0.9, phi)); }
      pitch = mix(-50, -30, fold);
    }
    // The speed force's leap: she keeps running in the air (the long jumper's hitch-kick, the comics'
    // running on air), the legs cycling at the gait's readable rate until they reach for the landing.
    const hk = j.phase === 'air' ? (this.gait.blur ?? 0) * k(0.05, 0.2, phi) * (1 - k(0.6, 0.85, phi)) : 0;
    if (hk > 0) {
      const a = 2 * Math.PI * F_CAP * sw.age + (sw.role === 'lead' ? 0 : Math.PI);
      fwd = mix(fwd, 0.08 + 0.32 * Math.sin(a), hk);
      drop = mix(drop, 0.78 - 0.16 * Math.max(0, Math.cos(a)), hk);
    }
    // Hip joint for this leg, in the root frame, at the jump's own pelvis height right now.
    const yP = this._jumpY(j);
    const hj = d.hipJoint[f.side];
    const pos = this._t.v6.set(
      this.rest.Hips.charPos.x + this.pelvisX.x + hj.x * 1.05,
      d.groundY + yP + hj.y - drop * L,
      this.rest.Hips.charPos.z + this.pelvisZ.x + hj.z + fwd * L,
    ).applyMatrix4(this.root.matrixWorld);
    // Blend in from where the foot left the ground (carrying its velocity), and converge on the
    // landing spot over the second half of the flight.
    const w0 = smootherstep(0, 0.14, sw.age);
    const from = this._t.v7.copy(sw.start).addScaledVector(sw.v0, Math.min(sw.age, 0.1) * (1 - w0));
    f.ankle.copy(from).lerp(pos, w0);
    if (sw.landPitch != null && j.phase === 'air') {
      const wl = smootherstep(0.5, 1, phi);
      f.ankle.lerp(sw.end, wl);
      pitch = mix(pitch * DEG, sw.landPitch, smootherstep(0.6, 1, phi)) / DEG;
    }
    f.pitch.x = mix(sw.startPitch, pitch * DEG, w0); f.pitch.v = 0;
    f.yaw += wrapAngle((sw.targetYaw ?? f.yaw) - f.yaw) * (1 - Math.exp(-6 * dt));
    f.swingW = 0;
    f.toe.step(Math.max(0, -f.pitch.x), dt);
  }

  /** The jump's pelvis height (above the ground) at its current time, for prep / push / air. */
  _jumpY(j) {
    if (j.phase === 'push') {
      // Leaves the ground already decelerating at g (the push force fades to nothing at toe-off).
      return quinticHermite(j.yS, j.vS, 0, j.yTo, j.vz, -G, j.tPush, j.t);
    }
    if (j.phase === 'air') { const t = Math.min(j.t, j.T); return j.yTo + j.vz * t - 0.5 * G * t * t; }
    if (j.phase === 'prep' && j.type === 'stand') return j.y0 - j.D * minimumJerk(clamp(j.t / j.tPrep, 0, 1));
    return this.pelvisFinalY;
  }

  _jumpLand(j) {
    const g = this.gait;
    const landers = j.type === 'stand' ? [this.feet.L, this.feet.R] : [j.lead];
    for (const f of landers) { f.ankle.copy(f.swing.end); f.pitch.x = f.swing.landPitch; this._land(f); }
    const vLand = j.vz - G * j.T; // vertical speed at touchdown (negative)
    j.vLand = vLand;
    j.impact = clamp((-vLand - 1) / 2, 0, 1.2);
    j.t = Math.max(0, j.t - j.T); // time already spent on the ground this frame
    j.phase = 'land'; j.frozen = false;
    if (j.type !== 'stand') {
      // Resume the gait with the landing foot at the start of its stance (walking: just after it,
      // so the other foot is due to lift and swing through).
      const lead = j.lead, trail = j.takeoff;
      const duty = this._duty(lead);
      const pLead = Math.max(0, duty - 0.5);
      this.phase = wrap01(pLead - (lead.side === 'R' ? 0.5 : 0));
      this.gaitActive = true;
      const pTr = wrap01(this.phase + (trail.side === 'R' ? 0.5 : 0));
      const dTr = this._duty(trail);
      const t0 = pTr >= dTr ? (pTr - dTr) / (1 - dTr) : 0;
      trail.swing = null; trail.planted = true; // so _beginSwing records it cleanly
      this._beginSwing(trail, 'gait', { t: t0, rate: g.f / (1 - dTr), height: g.swingH });
      trail.swing.start.copy(trail.ankle);
      trail.swing.fromAir = true;
      trail.swing.startRoot = this._toRoot(trail.ankle, new THREE.Vector3());
    }
  }

  /** Pelvis height during a jump, given the normal solver's height `y` (called from _updatePelvis). */
  _jumpPelvis(y, dt) {
    const j = this.jumpState, L = this.dims.L;
    if (j.phase === 'prep') {
      if (j.type === 'stand') return this._jumpY(j);
      // Penultimate step of a leap / long jump: the hips come down a few centimetres.
      return y - (j.type === 'hop' ? 0 : 0.035 * L) * smoothstep(0, 0.25, j.t);
    }
    if (j.phase === 'push' || j.phase === 'air') {
      const yy = this._jumpY(j);
      j.yLast = yy; j.vLast = j.phase === 'air' ? j.vz - G * Math.min(j.t, j.T) : (yy - (j.yPrev ?? yy)) / Math.max(dt, EPS);
      j.yPrev = yy;
      return yy;
    }
    // Landing: carry the landing height and speed, and let a damped spring return to the normal
    // height. Stiffer (shallower, quicker) for running landings, which the legs keep cycling through.
    if (!j.caught) {
      j.caught = true;
      const stand = j.type === 'stand';
      this.landOff.omega = stand ? 5.5 : j.type === 'long' ? 12 : 14;
      this.landOff.x = (j.yLast ?? y) - y;
      this.landOff.v = j.vLand;
    }
    return y;
  }

  // ----- Foot planner -------------------------------------------------------
  /** Ankle position from a planted ball point, heading and pitch (heel rocker / forefoot rocker). */
  /**
   * Ankle position for a foot planted at `ball`, pitched by `pitch` (+ toes up). On a slope
   * (`slope`, the ground's pitch along the foot) the heel rests on the slope, below the ball.
   */
  _ankleFromPlant(ball, yaw, pitch, out, slope = 0) {
    const d = this.dims;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let px, py, pz, rf, ru;
    if (pitch - slope >= 0) {
      // Heel rocker: pivot at the heel, ankle is (heelBack, ankleH) from it.
      const back = d.ballFwd + d.heelBack, bh = back * Math.cos(slope);
      px = ball.x - fx * bh; pz = ball.z - fz * bh; py = ball.y - back * Math.sin(slope);
      rf = d.heelBack; ru = d.ankleH;
    } else {
      // Forefoot rocker: pivot at the metatarsal heads.
      px = ball.x; py = ball.y; pz = ball.z;
      rf = -d.ballFwd; ru = d.ankleH;
    }
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const f = rf * c - ru * s;
    const u = rf * s + ru * c;
    out.set(px + fx * f, py + u, pz + fz * f);
    return out;
  }

  /** Floor height (world) under a point: the terrain, or flat at the root. */
  _floor(x, z) {
    return this.ground ? this.ground(x, z) : this._rootPos.y;
  }
  /** Ground pitch along a foot (+ uphill toward the toes) with its ball at `ball`. */
  _slopeAt(ball, yaw) {
    if (!this.ground) return 0;
    const len = this.dims.ballFwd + this.dims.heelBack;
    const hb = this.ground(ball.x, ball.z), hh = this.ground(ball.x - Math.sin(yaw) * len, ball.z - Math.cos(yaw) * len);
    const sl = Math.atan2(hb - hh, len);
    return Math.abs(sl) < 25 * DEG ? sl : 0; // steeper is a step edge, not a slope
  }

  /** Cross-slope of the support surface in character-left coordinates. */
  _slopeAcrossAt(ball, yaw) {
    if (!this.ground) return 0;
    const w = Math.max(this.dims.footHalfWidth, 0.035);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const hL = this.ground(ball.x + lx * w, ball.z + lz * w);
    const hR = this.ground(ball.x - lx * w, ball.z - lz * w);
    if (Math.abs(hL - hR) > 0.12) return 0; // a step edge is not a sloped plane
    return clamp(Math.atan2(hL - hR, 2 * w), -25 * DEG, 25 * DEG);
  }

  /** Ground point under the ankle → ball point for a given yaw. */
  _ballFromAnkleGround(A, yaw, out) {
    return out.set(A.x + Math.sin(yaw) * this.dims.ballFwd, A.y, A.z + Math.cos(yaw) * this.dims.ballFwd);
  }

  /** Root-relative stance target for idle / guard (world ankle-ground point + yaw). */
  _stanceDesired(foot, outA) {
    const d = this.dims, L = d.L;
    let x, z, yawOff;
    if (this.guardTarget > 0.5) {
      // Orthodox guard: lead (left) foot forward and slightly turned in, rear foot turned out ~45°.
      if (foot.side === 'L') { x = d.hipHalf * 1.35; z = 0.25 * L; yawOff = -18 * DEG; }
      else { x = -d.hipHalf * 1.55; z = -0.25 * L; yawOff = -48 * DEG; }
    } else {
      // Relaxed stance: habitual toe-out, plus where this foot happened to be re-planted.
      const j = this.stanceJit[foot.side];
      x = foot.sign * d.hipHalf * this.style.stanceWidth + j.x; z = j.z; yawOff = foot.sign * (this.traits.toeOut[foot.side] * 0.8 + j.yaw);
      const b = this.braceTarget;
      if (b > 0) { x *= 1 + 0.75 * b; z += (foot.side === 'L' ? 0.15 : -0.12) * L * b; yawOff += (foot.side === 'R' ? -14 : 4) * DEG * b; }
    }
    // Turning in place: aim steps a little ahead of the turn so the feet lead rather than trail.
    const lead = this.gaitActive ? 0 : clamp(this.yawRate.x * 0.3, -0.5, 0.5);
    const c = Math.cos(lead), sn = Math.sin(lead);
    outA.set(x * c + z * sn, 0, z * c - x * sn).applyQuaternion(this._rootQ).add(this._rootPos);
    const yaw = this.heading + lead + yawOff;
    this._settleOnStep(outA, yaw);
    return yaw;
  }

  _stanceError() {
    let e = 0;
    for (const f of [this.feet.L, this.feet.R]) {
      const A = this._t.v6;
      const yaw = this._stanceDesired(f, A);
      const cur = this._t.v7.set(f.ball.x - Math.sin(f.yaw) * this.dims.ballFwd, 0, f.ball.z - Math.cos(f.yaw) * this.dims.ballFwd);
      e = Math.max(e, Math.hypot(cur.x - A.x, cur.z - A.z) + 0.25 * this.dims.L * Math.abs(wrapAngle(f.yaw - yaw)) / (30 * DEG));
    }
    return e;
  }

  /** Foot pitch during gait stance: heel strike → foot flat → heel-off → toe-off. */
  _stancePitch(s, rb) {
    // Sprinting lands on the ball of the foot and stays up on it: the heel only settles a little under
    // load and never reaches the ground (≈ 3 cm more leg), then the foot rolls further at toe-off.
    const sp = this.gait.sprint ?? 0;
    const hs = this._landPitch(rb);
    const flat = -14 * DEG * sp;
    const to = -(mix(this.style.toeOff, this.style.toeOffRun, rb) + 8 * sp) * DEG;
    const flatAt = mix(mix(0.16, 0.1, rb), 0.3, sp);
    const heelOff = mix(mix(0.55, 0.38, rb), 0.3, sp);
    if (s < flatAt) return mix(hs, flat, smootherstep(0, flatAt, s));
    if (s < heelOff) return flat;
    return mix(flat, to, easeInPow((s - heelOff) / (1 - heelOff), 1.6));
  }

  /** Foot pitch at touchdown: heel strike walking (+20°) and jogging (+12°), forefoot sprinting (−18°). */
  _landPitch(rb) {
    return mix(mix(20, 12, rb), -18, this.gait.sprint ?? 0) * DEG * (1 - 0.5 * this.crouchW.x); // sneaking sets the foot down flatter
  }

  /** Advances the per-step noise processes at each gait lift-off. */
  _stepNoise(foot) {
    this.noiseCad.step();
    this.noiseSpeed.step();
    // Each stride is a slightly different version of the last: pelvic motion and arm swing
    // amplitudes vary by a few percent from step to step.
    const r = this.rng;
    this.jit.roll = 1 + 0.08 * clamp(gauss(r), -2, 2);
    this.jit.yaw = 1 + 0.1 * clamp(gauss(r), -2, 2);
    this.jit.arm[foot.side] = 1 + 0.1 * clamp(gauss(r), -2, 2);
  }

  _beginSwing(foot, kind, opts = {}) {
    const sw = {
      kind,
      t: opts.t ?? 0,
      rate: opts.rate ?? 1 / 0.4,
      start: foot.ankle.clone(),
      startFloor: foot.ball.y - this.dims.groundY, // floor it leaves from (stepping up / down is between floors)
      // Toe-off point with the foot rolled as far as it may go: where the pelvis limit continues from.
      startRoll: foot.gaitStance && foot.pitch.x <= 0
        ? this._ankleFromPlant(foot.ball, foot.yaw + foot.pivotYaw.x, Math.min(foot.pitch.x, this._maxRoll()), new THREE.Vector3())
        : foot.ankle.clone(),
      // Toe-off velocity: the swing continues the rocker's motion instead of stalling at lift-off.
      v0: foot.ankleVel.clone(),
      pv0: clamp(foot.pitchVel, -8, 8),
      ankle0: foot.ankleAngle ?? 0,
      startRoot: this._toRoot(foot.ankle, new THREE.Vector3()),
      startYaw: foot.yaw,
      startPitch: foot.pitch.x,
      height: opts.height ?? 0.08 * this.dims.L,
      fixedA: opts.fixedA || null,
      fixedYaw: opts.fixedYaw ?? null,
      urgent: !!opts.urgent,
      targetBall: new THREE.Vector3(),
      end: new THREE.Vector3(), // touchdown ankle (world)
      targetYaw: foot.yaw,
      wN: 0,
      lN: 0,
    };
    foot.swing = sw;
    foot.planted = false;
    foot.pending = null;
    this.lastLiftoff = this.time;
  }

  /**
   * Running swing, authored relative to the hip (root frame) rather than the ground: the foot
   * keeps travelling back after toe-off, the heel folds up under the buttock (short pendulum),
   * the knee drives forward and up, the shank unfolds, then the foot paws back so it meets the
   * ground moving rearward (ground-speed matching). Piecewise cubic Hermite through key poses.
   */
  _runSwingAnkle(sw, endWorld, t, out) {
    const d = this.dims, L = d.L, g = this.gait;
    const s0 = sw.startRoot;
    const vT = g.v / Math.max(sw.rate, EPS); // root travel over a whole swing (m per unit t)
    // Keys are relative to the hip at their own time: the landing point relative to the hip at touchdown.
    const e = this._toRoot(endWorld, this._t.v7);
    e.z -= vT * (1 - t);
    const hRec = g.recH, k = g.drive, gy = d.groundY;
    const T = RUN_SWING_T;
    const Z = this._runZ || (this._runZ = new Float64Array(5));
    const Y = this._runY || (this._runY = new Float64Array(5));
    // Sprinting ("front-side" mechanics): the heel folds tight under the buttock, the thigh drives up
    // toward horizontal so the foot passes well ahead of the hip and high, the shin unfolds while the
    // knee is still up, then the foot strikes down and back close under the body (pawback).
    const sp = g.sprint, bl = g.blur ?? 0;
    // (The speed force's blur run exaggerates it, the comics' run: the thigh up past horizontal, the
    // heel tight to the buttock.)
    Z[0] = s0.z; Z[1] = s0.z + 0.07 * L; Z[2] = (mix(mix(0.0, 0.08, k), 0.18, sp) + 0.08 * bl) * L; Z[3] = e.z + mix(0.06, 0.02, sp) * L; Z[4] = e.z;
    Y[0] = s0.y; Y[1] = gy + hRec; Y[2] = gy + mix(0.66 * hRec, 0.5 * L, sp) + 0.06 * L * bl; Y[3] = e.y + mix(mix(0.09, 0.13, k), 0.2, sp) * L; Y[4] = e.y;
    let i = 0;
    while (i < 3 && t > T[i + 1]) i++;
    const h = T[i + 1] - T[i];
    const u = clamp((t - T[i]) / h, 0, 1);
    const slope = (A, j) => (A[j + 1] - A[j - 1]) / (T[j + 1] - T[j - 1]);
    const mz = (j) => (j === 0 ? -0.55 * vT : j === 4 ? -0.7 * vT : j === 3 ? 0 : slope(Z, j));
    const my = (j) => (j === 0 ? (Y[1] - Y[0]) / T[1] : j === 4 ? (Y[4] - Y[3]) / (1 - T[3]) : j === 1 ? 0 : slope(Y, j));
    const z = cubicHermite(Z[i], mz(i) * h, Z[i + 1], mz(i + 1) * h, u);
    const y = cubicHermite(Y[i], my(i) * h, Y[i + 1], my(i + 1) * h, u);
    const x = s0.x + (e.x - s0.x) * minimumJerk(t);
    return out.set(x, y, z).applyMatrix4(this.root.matrixWorld);
  }

  /**
   * Never land a foot on or across the other foot's line: lateral clearance (in the landing
   * heading's frame) grows from a narrow running track to a full foot width as the feet overlap.
   */
  _keepSide(foot, A, yaw, footYaw) {
    const d = this.dims, L = d.L;
    const o = foot === this.feet.L ? this.feet.R : this.feet.L;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const dx = A.x - o.ankle.x, dz = A.z - o.ankle.z;
    const fwd = dx * fx + dz * fz;
    const lat = (dx * fz - dz * fx) * foot.sign; // +X (character left) = (fz, −fx)
    const overlap = 1 - smoothstep(0.25 * L, 0.5 * L, Math.abs(fwd));
    const need = mix(0.45 * d.hipHalf, FOOT_CLEAR * L, overlap);
    if (lat < need) {
      const k = (need - lat) * foot.sign;
      A.x += fz * k;
      A.z -= fx * k;
    }
    // Whole feet (heel → toe tip), so a toed-in landing cannot overlap the other foot either.
    const a0 = this._t.v6, a1 = this._t.v7, b0 = this._t.v4, b1 = this._t.v5;
    this._footSegment(A, footYaw, a0, a1);
    const oA = this._t.v8.set(o.ball.x - Math.sin(o.yaw) * d.ballFwd, A.y, o.ball.z - Math.cos(o.yaw) * d.ballFwd);
    this._footSegment(oA, o.yaw + o.pivotYaw.x, b0, b1);
    const gap = closestSegments(a0, a1, b0, b1, _cp1, _cp2);
    const needGap = FOOT_CLEAR * 0.8 * L;
    if (gap < needGap) {
      const k = (needGap - gap) * foot.sign;
      A.x += fz * k;
      A.z -= fx * k;
    }
  }

  /** Ground-plane heel → toe-tip segment of a foot whose ankle ground point is A. */
  _footSegment(A, yaw, heel, toe) {
    const d = this.dims, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const back = d.ballFwd + d.heelBack, front = 0.1 * d.L;
    heel.set(A.x - fx * (back - d.ballFwd), A.y, A.z - fz * (back - d.ballFwd));
    toe.set(A.x + fx * (d.ballFwd + front), A.y, A.z + fz * (d.ballFwd + front));
  }

  /** The swing foot passes outside the other leg (no scissoring through it, e.g. when turning). */
  _passClear(foot, t) {
    const L = this.dims.L;
    const o = foot === this.feet.L ? this.feet.R : this.feet.L;
    const a = this._toRoot(foot.ankle, this._t.v6);
    const b = this._toRoot(o.ankle, this._t.v7);
    const overlap = 1 - smoothstep(0.3 * L, 0.6 * L, Math.abs(a.z - b.z));
    const deficit = PASS_CLEAR * L * overlap - foot.sign * (a.x - b.x);
    const push = softRamp(deficit, 0.03 * L) * smoothstep(0, 0.15, t) * (1 - smoothstep(0.85, 1, t));
    if (push > 0) {
      a.x += foot.sign * push;
      foot.ankle.copy(a).applyMatrix4(this.root.matrixWorld);
    }
  }

  _land(foot) {
    const sw = foot.swing;
    foot.ball.copy(sw.targetBall);
    foot.yaw = sw.targetYaw;
    foot.slope = sw.slope ?? this._slopeAt(foot.ball, foot.yaw);
    foot.crossSlope = this._slopeAcrossAt(foot.ball, foot.yaw);
    foot.planted = true;
    foot.swing = null;
    foot.swingW = 0;
    foot.sinceLand = 0;
    foot.pivotYaw.reset(0);
    const g = this.gait;
    if (sw.kind === 'air') {
      // Jump landing: the pelvis absorbs it (see _jumpPelvis); the gait is resumed by the jump.
      foot.gaitStance = !!sw.gaitLanding;
      foot.needWrap = false;
      return;
    }
    if (sw.kind === 'gait') {
      foot.gaitStance = true;
      foot.needWrap = wrap01(this.phase + (foot.side === 'R' ? 0.5 : 0)) > this._duty(foot);
      // Heel-strike shock: downward velocity into the pelvis spring (knee-flexion damping),
      // trunk flexion bounce. Scales with gait energy.
      // (Running's sink onto the leg comes from the spring-mass profile; this is only the thud.)
      const e = mix(0.1, 0.07, g.rb) * clamp(g.v / 1.4, 0.3, 2.2);
      this.pelvisY.impulse(-e);
      this.trunkBounce.impulse(e * 1.6);
    } else {
      foot.gaitStance = false;
      this.pelvisY.impulse(-0.04);
      // After a balance step, the new support becomes home: move the root under the COM.
      if (sw.urgent && this.driveRoot) {
        const off = this._t.v0.copy(this.comPert.x).applyQuaternion(this._rootQ);
        off.y = 0;
        this.root.position.add(off);
        this.comPert.x.set(0, 0, 0);
        this._updateRootFrame();
      }
    }
  }

  _updateFeet(dt) {
    const g = this.gait, d = this.dims, L = d.L;
    const A = this._t.v3;

    for (const foot of [this.feet.L, this.feet.R]) {
      foot.sinceLand += dt;
      if (foot.planted && !foot.swing) {
        foot.slope = this._slopeAt(foot.ball, foot.yaw);
        foot.crossSlope = this._slopeAcrossAt(foot.ball, foot.yaw);
      }
      // Velocities of the final (posed) ankle and foot pitch, one frame old.
      foot.ankleVel.subVectors(foot.ankle, foot.prevAnkle).divideScalar(Math.max(dt, EPS));
      foot.prevAnkle.copy(foot.ankle);
      foot.pitchVel = (foot.pitch.x - foot.prevPitch) / Math.max(dt, EPS);
      foot.prevPitch = foot.pitch.x;
      let p = wrap01(this.phase + (foot.side === 'R' ? 0.5 : 0));

      // ---- Liftoff (gait, phase-locked) ----
      if (this.gaitActive && foot.planted && !this.jumpState?.frozen) {
        const duty = this._duty(foot);
        if (foot.needWrap && p < duty) foot.needWrap = false;
        // Running, a foot that landed after its stance window (the cadence rising under it: the
        // speed force accelerates at 50 m/s²) takes one brief contact and is off again once it has
        // swept back as far as a stance would take it, instead of waiting most of a cycle for its
        // phase to come round with the leg dragged out behind (it sat the hips 35 cm down).
        if (foot.needWrap && g.rb > 0.5 && foot.gaitStance) {
          const behind = (this._rootPos.x - foot.ankle.x) * this._fwd.x + (this._rootPos.z - foot.ankle.z) * this._fwd.z;
          if (behind > Math.min(g.v * duty / g.f * (1 - 0.5 * this._placeK()) + 0.04 * L, 0.7 * L)) foot.needWrap = false;
        }
        // Kinematic stance limit: when braking out of a run the duty factor jumps up, which would
        // keep this foot planted until the leg is stretched far behind the hip (a lunge). Once it
        // has swept as far back as the current gait would take it, advance the phase to lift-off.
        // Running (other foot in the air) too: braking from a sprint, the foot can trail no further
        // than a toe-off reach of ≈ 0.7 L, however long the slowing gait's stance would be.
        const other = foot === this.feet.L ? this.feet.R : this.feet.L;
        if (!foot.needWrap && foot.gaitStance && p < duty && (other.planted || g.rb > 0.5)) {
          const tSt = duty / g.f;
          // On a curve each foot sweeps an arc of its own radius: the outside foot travels further
          // behind than the hips in the same stance time, the inside foot less. Without this the
          // limit cuts every outside stance short and the steps alternate long / short (a gallop).
          const dx = this._rootPos.x - foot.ankle.x, dz = this._rootPos.z - foot.ankle.z;
          const lat = -(dx * this._fwd.z - dz * this._fwd.x); // foot's offset to the character's left
          const arc = clamp(1 - lat * this.yawRate.x / Math.max(g.v, 0.3), 0.7, 1.6);
          const behindMax = Math.min((g.v * tSt * (1 - 0.5 * this._placeK()) + 0.04 * L) * arc, 0.7 * L * Math.max(arc, 1));
          const behind = dx * this._fwd.x + dz * this._fwd.z;
          // A leg that can no longer reach the hips even fully up on its toes lets go rather than
          // holding them down: otherwise the body is dragged down by the trailing leg (braking from
          // a sprint it yanked the hips down 2 cm in a frame; in a tight walking turn the outside
          // foot, trailing far and wide, buckled the inside knee every other step).
          if (behind > behindMax || (p > 0.5 * duty && this._trailsOutOfReach(foot))) {
            this.phase = wrap01(this.phase + duty - p);
            p = duty;
          }
        }
        if (!foot.needWrap && p >= duty) {
          const rate = g.f / (1 - duty);
          this._stepNoise(foot);
          // Toe clearance varies stride to stride with a right-skewed spread; now and then a
          // stride only just clears the ground.
          const hMul = Math.exp(0.1 * gauss(this.rng)) * (this.rng() < 0.05 ? 0.7 : 1);
          // Always start at t = 0 (a late lift-off would otherwise skip the slow start of the path).
          this._beginSwing(foot, 'gait', { t: 0, rate, height: g.swingH * hMul });
          // Per-step placement noise: width (anti-correlated, SD ≈ 1.7 cm per foot → ≈ 2.4 cm step
          // width) and a white step-length residual (≈ 1.5 %), plus the persistent limb bias.
          foot.swing.wN = this.noiseWidth.step() * 0.017 * (L / 0.888) * g.slow;
          foot.swing.lN = (0.015 * gauss(this.rng) + this.traits.stepBias[foot.side]) * 0.5 * g.strideLen;
        }
      }
      // ---- Pending event step (anticipatory postural adjustment) ----
      if (foot.pending && foot.planted) {
        foot.pending.timer -= dt;
        if (foot.pending.timer <= 0) {
          const pe = foot.pending;
          this._beginSwing(foot, 'event', pe);
        }
      }

      if (foot.swing?.kind === 'air') { this._updateAirFoot(foot, dt); continue; }
      if (foot.swing) {
        const sw = foot.swing;
        if (sw.kind === 'gait' && this.gaitActive) {
          const duty = this._duty(foot), rate = g.f / (1 - duty);
          sw.rate = rate;
          // Running, the swing lands when its phase comes round (p = 1), catching up if it set off
          // late. A late lift (a stance cut short advances the shared phase under the other leg's
          // swing; a late landing is held until it has swept back) otherwise lands late again every
          // stride, and the legs drift together: both feet up at once, a hop (user report).
          if (g.rb > 0.5) sw.rate = clamp((1 - sw.t) * g.f / Math.max(p >= duty ? 1 - p : 0, 0.02), 0.7 * rate, 2.5 * rate);
        } else if (sw.kind === 'event' && this._hurry) sw.rate = Math.max(sw.rate, 1 / 0.16);
        sw.t = Math.min(1, sw.t + sw.rate * dt);
        const remaining = (1 - sw.t) / sw.rate;

        // ---- Landing target ----
        let landPitch;
        if (sw.kind === 'gait') {
          // Raibert placement: predicted hip position at touchdown + half the stance sweep,
          // corrected by COM velocity error (perturbation) for balance.
          const headPred = this.heading + this.yawRate.x * remaining;
          const tSt = g.duty / g.f;
          // On a curve the foot is placed beside where the hip will be at mid-stance (on the arc,
          // with the heading it will have then), so both feet sweep the same angle under the body:
          // the outside foot lands further ahead along its wider arc instead of trailing behind.
          const tMid = remaining + tSt * 0.5 * this._placeK();
          const hMid = this.heading + this.yawRate.x * tMid, hChord = this.heading + this.travel + this.yawRate.x * tMid * 0.5;
          const fx = Math.sin(hMid), fz = Math.cos(hMid);
          const rx = fz, rz = -fx; // character-left axis (+X) for that heading
          const pertV = this._t.v4.copy(this.comPert.v).applyQuaternion(this._rootQ);
          // Turning: the body leans in, so the feet land outward of the hips (both legs stay under
          // their own hip instead of the outside leg crossing beneath the body).
          const lean = this._turnLean(g);
          const out = this.speedForce > SPEEDSTER ? 0 : -d.hipsH * Math.tan(lean) * mix(0.45, 0.2, g.rb) * 0.6;
          A.set(
            this._rootPos.x + Math.sin(hChord) * g.v * tMid + this._travelDir.x * sw.lN + rx * (foot.sign * (g.halfWidth + sw.wN) + out) + pertV.x * tSt * 0.5,
            0,
            this._rootPos.z + Math.cos(hChord) * g.v * tMid + this._travelDir.z * sw.lN + rz * (foot.sign * (g.halfWidth + sw.wN) + out) + pertV.z * tSt * 0.5,
          );
          sw.targetYaw = headPred + foot.sign * this._toeOut(foot);
          this._settleOnStep(A, sw.targetYaw);
          // Nor a step up no leg could take (a cliff face the long strides reach before the body does:
          // the top of a 70 m mesa): the wall in front is the root's to meet (a stop, a crash, a wall run).
          { const o = foot === this.feet.L ? this.feet.R : this.feet.L; if (A.y - o.ball.y > 0.6 * L) A.y = o.ball.y; }
          // A landing spot far below the standing foot is not a step but a drop. Running, she goes
          // over; walking, the step falls short at the edge (and she teeters).
          if (this.ground) {
            const o = foot === this.feet.L ? this.feet.R : this.feet.L;
            if (o.ball.y - A.y > 0.65 * L) {
              if (g.v > 1.25 * this.traits.walkSpeed || !this.edgeStop) this.onFallOff?.(); // (a superhero walks off too)
              else {
                const top = o.ball.y - d.groundY, fx = Math.sin(sw.targetYaw), fz = Math.cos(sw.targetYaw);
                for (let i = 0; i < 12 && top - this.ground(A.x + fx * (d.ballFwd + 0.09 * L), A.z + fz * (d.ballFwd + 0.09 * L)) > 0.1; i++) { A.x -= fx * 0.04; A.z -= fz * 0.04; }
                A.y = top + d.groundY;
                if (!this.nmOwned && this.time - (this._teeterT ?? -9) > 2.5) { this._teeterT = this.time; this.onTeeter?.(this._fwd.clone()); }
                this.speed.x *= 0.3; this.speed.v = 0;
              }
            }
          }
          // Stopping: the last steps close up. As the body slows, the landing spot blends toward
          // where this foot will stand once she has stopped (≈ 2v/ω further on, the braking
          // distance), so a shorter step is followed by a closing step beside the other foot.
          // (Walking stops only: stopping from a run takes its own few steps.)
          const close = this.stopping && !this.jumpState ? (1 - smoothstep(0.35, 1.0, g.v)) * (1 - smoothstep(1.8, 3, this.brakeFrom)) : 0;
          if (close > 0) {
            const S = (this._stopA ||= new THREE.Vector3());
            const yawS = this._stanceDesired(foot, S);
            S.addScaledVector(this._travelDir, 2 * g.v / this.brakeOmega);
            this._settleOnStep(S, yawS);
            A.lerp(S, close);
            sw.targetYaw += wrapAngle(yawS - sw.targetYaw) * close;
          }
          landPitch = this._landPitch(g.rb) * (1 - 0.6 * close) * (1 - 0.75 * (g.lat ?? 0)); // a closing step (or a side-step) is set down flatter
        } else {
          let yaw;
          if (sw.fixedA) { A.copy(sw.fixedA); yaw = sw.fixedYaw; this._settleOnStep(A, yaw); }
          else yaw = this._stanceDesired(foot, A);
          sw.targetYaw = yaw;
          landPitch = 4 * DEG;
        }
        this._keepSide(foot, A, sw.kind === 'gait' ? sw.targetYaw - foot.sign * this._toeOut(foot) : this.heading, sw.targetYaw);
        // Commit to the landing spot over the last third of the swing: steering changes late in
        // the swing can no longer yank the foot just before it touches down.
        if (!sw.aim) { sw.aim = A.clone(); sw.aimYaw = sw.targetYaw; }
        const track = 1 - smoothstep(0.6, 0.95, sw.t);
        sw.aim.lerp(A, track);
        sw.aimYaw += wrapAngle(sw.targetYaw - sw.aimYaw) * track;
        A.copy(sw.aim);
        sw.targetYaw = sw.aimYaw;
        this._ballFromAnkleGround(A, sw.targetYaw, sw.targetBall);
        // (The ball re-sampled on that cliff's top would undo the limit above.)
        if (sw.kind === 'gait') { const o = foot === this.feet.L ? this.feet.R : this.feet.L; if (sw.targetBall.y - o.ball.y > 0.6 * L) sw.targetBall.y = o.ball.y; }

        // ---- Swing trajectory ----
        const rb = sw.kind === 'gait' ? g.rb : 0;
        const t = sw.t;
        // Horizontal: minimum-jerk transport (Flash & Hogan); the swing foot passes under the hip
        // near mid-swing while the arc's early peak produces heel recovery when running.
        const sh = minimumJerk(t);
        // Walking steps arrive with a quarter of the swing's average forward speed (≈ 0.9 m/s at
        // a normal walk, as measured at heel contact): the foot is still travelling when the leg
        // straightens, instead of reaching the spot early and holding the leg out locked.
        const sf = sw.kind === 'gait' ? strikeTransport(t, 0.25 * (1 - rb)) : sh;
        sw.slope = this._slopeAt(sw.targetBall, sw.targetYaw);
        landPitch += sw.slope;
        const end = this._ankleFromPlant(sw.targetBall, sw.targetYaw, landPitch, this._t.v5, sw.slope);
        sw.end.copy(end);
        const dist = Math.hypot(end.x - sw.start.x, end.z - sw.start.z);
        // Stepping up, the foot rises early (and a little higher) to clear the edge; stepping
        // down, it travels out over the edge first and drops late.
        // A step is a change of floor height, not of ankle height (the ankle lifts off high on the
        // toes and lands low on the heel even on flat ground).
        const dy = end.y - sw.start.y, dF = sw.targetBall.y - d.groundY - sw.startFloor, step = Math.abs(dF) > 0.03 * L;
        const h = (sw.kind === 'gait' ? sw.height : clamp(0.28 * dist + 0.03 * L, 0.03 * L, 0.11 * L)) + (step ? 0.25 * Math.abs(dF) : 0);
        const vy = !step ? sh : dF > 0 ? smootherstep(0.02, 0.55, t) : smootherstep(0.45, 0.95, t);
        const sx = step && dF < 0 ? smootherstep(0, 0.6, t) : sf; // stepping down: reach out first, then drop
        // Walking: the ankle rises early (the knee folds right after toe-off, peaking at ≈ 72 % of
        // the stride) and the foot then travels low and fast through mid-swing (toe clearance
        // ≈ 1.5–2 cm), so the thigh is not hauled up and the knee does not snap straight late.
        const arc = sw.kind === 'gait' ? asymmetricBump(t, mix(0.28, 0.33, rb), mix(6, 4, rb)) : asymmetricBump(t, 0.42, 4);
        // Still travelling forward at contact, the heel glides in at a shallow angle (≈ 6°) rather
        // than reaching floor level early and skidding along it.
        const glide = sw.kind === 'gait' ? 0.1 * (1 - sf) * dist * smoothstep(0.5, 0.8, t) * (1 - rb) : 0;
        foot.ankle.set(
          sw.start.x + (end.x - sw.start.x) * sx,
          sw.start.y + dy * vy + h * arc + glide,
          sw.start.z + (end.z - sw.start.z) * sx,
        );
        // Starts at the toe-off velocity and fades out well before landing: t·(1 − t)³.
        const carry = t * (1 - t) ** 3 / Math.max(sw.rate, EPS);
        foot.ankle.addScaledVector(sw.v0, carry);
        if (rb > 0.001) foot.ankle.lerp(this._runSwingAnkle(sw, end, t, this._t.v6), rb);
        this._passClear(foot, t);
        // Over terrain: the swinging foot (ankle, ball and toes) stays above the ground under it —
        // only where the ground rises above the swing's own path (a step edge, a curb). On flat
        // ground or an even slope the normal swing is left alone (a rigid-toe clearance there
        // lifts every step into a march).
        if (this.ground && t < 0.97) {
          const fx = Math.sin(foot.yaw), fz = Math.cos(foot.yaw), a = foot.ankle;
          const toe = d.ballFwd + 0.09 * d.L, pc = Math.cos(foot.pitch.x), ps = Math.sin(foot.pitch.x);
          const gMax = Math.max(this.ground(a.x, a.z), this.ground(a.x + fx * toe * pc, a.z + fz * toe * pc), this.ground(a.x - fx * d.heelBack, a.z - fz * d.heelBack));
          const fs = sw.startFloor, fe = sw.targetBall.y - d.groundY;
          if (gMax > fs + (fe - fs) * sx + 0.015 * L) {
            // The lowest point of the foot below the ankle at this pitch (toes down: the toe tip).
            const below = Math.max(d.ankleH * pc - Math.min(0, toe * ps), d.ankleH * pc + Math.max(0, d.heelBack * ps));
            const need = gMax + d.groundY + below + 0.012 * L * (1 - smoothstep(0.85, 0.97, t));
            if (a.y < need) a.y = need;
          }
        }
        // Collision push from the pose solver (see _resolveCollisions), smoothed and faded.
        foot.colTarget *= Math.exp(-2 * dt); // remembered for a step or two: the next pass starts clear
        foot.colPush.step(foot.colTarget, dt);
        const colFade = smoothstep(0, 0.12, t) * (1 - smoothstep(0.78, 1, t));
        if (foot.colPush.x * colFade > 1e-5) {
          const a = this._toRoot(foot.ankle, this._t.v6);
          a.x += foot.sign * foot.colPush.x * colFade;
          foot.ankle.copy(a).applyMatrix4(this.root.matrixWorld);
        }
        // Yaw rotates toward landing heading; pitch: toe-off → neutral (clearance) → heel-strike.
        foot.yaw = sw.startYaw + wrapAngle(sw.targetYaw - sw.startYaw) * smootherstep(0, 0.85, t);
        let pitchT;
        if (sw.kind === 'gait') {
          pitchT = t < 0.5
            ? sw.startPitch * (1 - smootherstep(0, 0.5, t))
            : landPitch * smootherstep(0.5, 1, t);
        } else {
          const lift = -clamp(dist / (0.5 * L), 0.2, 1) * 14 * DEG;
          pitchT = cubicHermite(sw.startPitch, 0, landPitch, 0, t) + lift * asymmetricBump(t, 0.3, 3);
        }
        pitchT += sw.pv0 * carry;
        foot.pitch.x = pitchT; // swing pitch is analytic (C1 by construction)
        foot.pitch.v = 0;
        // Gait swing: mid-swing the foot hangs off the shank (ankle angle, not ground angle), so
        // it points down when the heel folds back and only dorsiflexes for the next contact.
        if (sw.kind === 'gait') {
          // Sprinting: toes pulled up through the front-side swing ("dorsiflexed recovery").
          const sp = g.sprint;
          const pf = mix(mix(-18, -32, rb), -40, sp), mid = mix(mix(-2, -14, rb), 6, sp), hs = mix(mix(4, 2, rb), -8, sp);
          // Starts from the ankle angle the foot actually left the ground with.
          const early = mix(sw.ankle0 / DEG, pf, smootherstep(0, 0.3, t));
          foot.swingAnkle = (t < 0.45 ? mix(early, mid, smootherstep(0, 0.45, t)) : mix(mid, hs, smootherstep(0.45, 0.85, t))) * DEG;
          foot.swingW = smoothstep(0, 0.2, t) * (1 - smoothstep(0.72, 0.96, t));
        } else foot.swingW = 0;
        foot.toe.step(Math.max(0, -pitchT), dt); // toes relax back to neutral as the foot levels

        if (sw.t >= 1) this._land(foot);
        continue;
      }

      // ---- Planted foot ----
      let pitchTarget = 0;
      if (this.gaitActive && foot.gaitStance) {
        pitchTarget = this._stancePitch(this._stanceS(foot), g.rb);
      } else if (this.gaitActive) {
        pitchTarget = 0;
      } else {
        // Guard: rear heel slightly raised (on the ball); strike drives the rear-foot pivot.
        const gw = this.guardW.x;
        if (foot.side === 'R') {
          pitchTarget = -(12 + 20 * this.drives.foot.s.x) * DEG * gw;
          foot.pivotYaw.step(38 * DEG * this.drives.foot.s.x * gw, dt);
        } else {
          pitchTarget = 0;
        }
        // Ordinary standing keeps the sole level; heel lift is reserved for deliberate guard and
        // turning-pivot actions rather than the idle weight shift.
        // Turning in place: the planted foot pivots on its ball (heel lifted a little) to follow
        // the body, rather than staying put until the feet point in very different directions.
        const pivot = smoothstep(0.15, 0.6, Math.abs(this.yawRate.x));
        if (pivot > 0) {
          const err = wrapAngle(this._stanceDesired(foot, this._t.v6) - foot.yaw);
          foot.yaw += err * (1 - Math.exp(-4 * dt)) * pivot;
          pitchTarget -= 7 * DEG * pivot;
        }
        foot.gaitStance = false;
      }
      // Pushing off for a jump: the heels rise as the legs extend (plantarflexion), and in the
      // crouch before a standing jump the feet stay flat.
      const j = this.jumpState;
      if (j && j.support?.includes(foot)) {
        if (j.phase === 'push') pitchTarget = Math.min(pitchTarget, -48 * DEG * smoothstep(0.3, 1, j.t / j.tPush));
        else if (j.phase === 'prep' && j.type === 'stand') pitchTarget = 0;
      }
      foot.pitch.step(pitchTarget + foot.slope, dt);
      // Ball pivot: when pivoting on the forefoot, the ball stays fixed and the heel swings.
      const yaw = foot.yaw + foot.pivotYaw.x;
      this._ankleFromPlant(foot.ball, yaw, foot.pitch.x, foot.ankle, foot.slope);
      // Toes stay flat on the ground exactly (MTP dorsiflexion = −foot pitch during heel-off).
      foot.toe.x = Math.max(0, foot.slope - foot.pitch.x);
      foot.toe.v = 0;
    }

    if (!this.gaitActive && !this.jumpState && this.jumpQueued < 0 && this.crawl.state === 'stand') this._eventStepping();
  }

  /** Event-driven stepping: capture-point balance recovery and stance re-positioning. */
  _eventStepping() {
    const fL = this.feet.L, fR = this.feet.R;
    if (fL.swing || fR.swing || fL.pending || fR.pending) return;
    if (this.strikeT >= 0) return;
    const d = this.dims, L = d.L;

    // --- Capture point (linear inverted pendulum): ξ = x + ẋ/ω₀, ω₀ = √(g/z) ---
    const com = this._t.v0.set(this.pelvisX.x + this.comPert.x.x, 0, this.pelvisZ.x + this.comPert.x.z);
    const vel = this._t.v1.set(this.pelvisX.v + this.comPert.v.x, 0, this.pelvisZ.v + this.comPert.v.z);
    const w0 = Math.sqrt(G / Math.max(this.pelvisFinalY, 0.3));
    const xi = com.addScaledVector(vel, 1 / w0); // root frame
    // Base of support: capsule between the two foot centres (root frame), radius = half foot width.
    const cL = this._footCenterRoot(fL, this._t.v2);
    const cR = this._footCenterRoot(fR, this._t.v4);
    const seg = this._t.v5.copy(cR).sub(cL);
    const tProj = clamp(this._t.v6.copy(xi).sub(cL).dot(seg) / Math.max(seg.lengthSq(), EPS), 0, 1);
    const closest = this._t.v6.copy(cL).addScaledVector(seg, tProj);
    const out = Math.hypot(xi.x - closest.x, xi.z - closest.z) - (d.footHalfWidth + 0.35 * d.ballFwd);
    if (out > 0.015 * L) {
      const err = this._t.v7.set(xi.x - closest.x, 0, xi.z - closest.z).normalize();
      // Step with the foot on the side of the fall; for sagittal falls, the trailing foot.
      const mid = this._t.v8.copy(cL).add(cR).multiplyScalar(0.5);
      let foot;
      if (Math.abs(err.x) > 0.45) foot = err.x > 0 ? fL : fR;
      else foot = (cL.clone().sub(mid).dot(err) < cR.clone().sub(mid).dot(err)) ? fL : fR;
      const other = foot === fL ? fR : fL;
      const otherC = foot === fL ? cR : cL;
      // Target: past the capture point, offset to the stepping foot's side; length-limited.
      const tgt = xi.clone().addScaledVector(err, 0.04 * L);
      tgt.x += foot.sign * d.hipHalf * 0.5;
      const reachV = tgt.clone().sub(otherC);
      const maxStep = 0.8 * L;
      if (reachV.length() > maxStep) tgt.copy(otherC).addScaledVector(reachV.normalize(), maxStep);
      const Aw = tgt.applyQuaternion(this._rootQ).add(this._rootPos);
      this._settleOnStep(Aw, other.yaw);
      foot.pending = { timer: 0.025, urgent: true, fixedA: Aw, fixedYaw: other.yaw + (foot.sign - other.sign) * 0 + foot.sign * 6 * DEG, rate: 1 / 0.26 };
      return;
    }

    // --- Stance re-positioning (settling after gait, entering/leaving guard, turning in place) ---
    const turning = Math.abs(this.yawRate.x) > 0.3;
    if (fL.sinceLand < (turning ? 0.06 : 0.18) || fR.sinceLand < (turning ? 0.06 : 0.18)) return;
    let worst = null, worstE = 0;
    for (const f of [fL, fR]) {
      const A = this._t.v6;
      const yaw = this._stanceDesired(f, A);
      const cur = this._t.v7.set(f.ball.x - Math.sin(f.yaw) * d.ballFwd, 0, f.ball.z - Math.cos(f.yaw) * d.ballFwd);
      // Standing, a foot a little ahead of the other is fine (people stop slightly staggered and
      // stay so): fore-aft offsets count half; sideways (stance width) is held as before.
      const ex = cur.x - A.x, ez = cur.z - A.z, along = ex * this._fwd.x + ez * this._fwd.z;
      const loose = this.guardTarget < 0.5 && !turning ? 0.5 : 1;
      const posE = Math.sqrt(Math.max(0, ex * ex + ez * ez - along * along) + (loose * along) ** 2);
      const yawE = Math.abs(wrapAngle(f.yaw - yaw));
      const e = posE / (0.07 * L) + yawE / (20 * DEG);
      if (e > worstE) { worstE = e; worst = { f, posE }; }
    }
    if (worst && worstE > 1) {
      const dur = clamp(0.38 + 0.16 * worst.posE / L, 0.38, 0.55);
      worst.f.pending = { timer: turning ? 0.06 : 0.2, urgent: false, rate: 1 / (turning ? Math.min(dur, 0.3) : dur) };
    }
  }

  _footCenterRoot(foot, out) {
    const fx = Math.sin(foot.yaw), fz = Math.cos(foot.yaw);
    const back = 0.5 * (this.dims.ballFwd + this.dims.heelBack);
    out.set(foot.ball.x - fx * back * 0.6, 0, foot.ball.z - fz * back * 0.6).sub(this._rootPos);
    out.y = 0;
    return out.applyQuaternion(this._rootQInv);
  }

  // ----- Weight distribution -----------------------------------------------
  _updateWeights(dt) {
    const g = this.gait, fL = this.feet.L, fR = this.feet.R;
    let target = this.weightL.x;
    if (this.gaitActive || fL.swing?.kind === 'gait' || fR.swing?.kind === 'gait') {
      const F = (f) => {
        if (!f.planted) return 0;
        if (!f.gaitStance) return 1;
        const s = this._stanceS(f);
        return mix(grfWalk(s), grfRun(s, 0.3), g.rb);
      };
      const a = F(fL), b = F(fR);
      if (a + b > 0.05) target = a / (a + b);
      this.grf = a + b;
      this.weightL.omega = 26;
    } else {
      const gw = this.guardW.x;
      // Idle contrapposto shift; guard: lead 45% → 68% as the hip drives through the strike.
      const lead = 0.45 + 0.23 * this.drives.hip.s.x;
      target = mix(0.5 + 0.38 * this.shift.x, lead, gw);
      // Gait initiation: load the stance foot so the other one can lift.
      target = mix(target, this.initStance === 'L' ? 0.85 : 0.15, this.apaW);
      if (fL.swing || fL.pending) target = 0;
      if (fR.swing || fR.pending) target = 1;
      this.grf = 1;
      this.weightL.omega = fL.pending?.urgent || fR.pending?.urgent || fL.swing?.urgent || fR.swing?.urgent ? 22 : this.apaW > 0 ? 14 : 9;
    }
    // Walking/running: the load follows the ground forces in time (feed-forward), so the hips
    // arrive over the stance foot at mid-stance.
    if (this.gaitActive) this.weightL.follow(target, dt, 1, 0, 8);
    else { this.weightL.step(target, dt); this.weightL._pt = undefined; }
    this.weightL.x = clamp(this.weightL.x, 0, 1);
  }

  // ----- Idle behaviours: weight shifting, gaze, breathing -------------------
  _updateBehaviours(dt) {
    const idleW = (1 - this.gait.locoW) * (1 - this.guardW.x) * (this.gaitActive ? 0 : 1);
    // The longer she stands, the more restless she gets: shifts and fidgets come more often.
    this.standT = idleW > 0.9 ? this.standT + dt : 0;
    const restless = smoothstep(0, 90, this.standT);

    // Weight-shift state machine (contrapposto), sometimes with a re-planted foot.
    this.shiftTimer -= dt;
    if (this.shiftTimer <= 0) {
      const r = this.rng();
      const amp = this.style.shiftAmp;
      this.shiftTarget = r < 0.3 ? 0 : (this.shiftTarget > 0 ? -1 : 1) * (amp + 0.4 * amp * this.rng() / 0.6);
      this.shiftTimer = (mix(9, 4, restless) + this.rng() * 6) * this.style.shiftEvery;
      if (idleW > 0.9 && this.rng() < 0.3) this._replant(this.shiftTarget > 0 ? this.feet.R : this.feet.L);
    }
    this.shift.step(this.shiftTarget * idleW, dt);
    this._updateFidget(dt, idleW, restless);

    // Gaze shifts: head turns to new fixation points, critically damped (≈0.4 s).
    this.gazeTimer -= dt;
    if (this.gazeTimer <= 0) {
      const center = this.rng() < 0.45;
      this.gazeTarget.yaw = center ? 0 : (this.rng() * 2 - 1) * 28 * DEG;
      this.gazeTarget.pitch = center ? 0 : (this.rng() * 1.6 - 0.9) * 8 * DEG;
      this.gazeTimer = 2.2 + this.rng() * 4.5;
    }
    const lw = this.lookW.x, rw = this.recoverW.x;
    const fw = this.flinchW.x;
    this.gazeYaw.step(mix(this.gazeTarget.yaw * idleW * (1 - rw), this.lookRel.yaw, lw) * (1 - fw), dt);
    this.gazePitch.step(mix(this.gazeTarget.pitch * idleW + 22 * DEG * rw, this.lookRel.pitch, lw) * (1 - fw), dt);

    // Fatigue: running hard builds it (≈ 9 s of all-out sprinting to the limit); it recovers slowly
    // on the move, faster standing, fastest bent over with the hands on the knees.
    const vsN = this.gait.v / Math.sqrt(this.dims.L / 0.888);
    const hard = smoothstep(this.traits.jogSpeed * 1.1, this.traits.sprintSpeed * 0.95, vsN);
    if (hard > 0 && !this.style.tireless && !this.speedForce) this.fatigue = Math.min(1, this.fatigue + hard * dt / 9);
    else this.fatigue = Math.max(0, this.fatigue - dt / (rw > 0.5 ? 14 : this.gaitActive ? 40 : 24));
    const still = !this.gaitActive && this.gait.v < 0.1 && this.guardTarget < 0.5 && this.targetSpeed < 0.01
      && this.crouchTarget < 0.5 && !this.jumpState && this.strikeT < 0 && this.crawl.state === 'stand';
    this.recoverT = still ? this.recoverT + dt : 0;
    if (!this.recovering && this.recoverT > 0.35 && this.fatigue > 0.45) this.recovering = true;
    if (this.recovering && (!still || this.fatigue < 0.12)) this.recovering = false;
    this.recoverW.step(this.recovering ? 1 : 0, dt);
    this.flinchT = Math.max(0, this.flinchT - dt);
    this.flinchW.omega = this.flinchT > 0 ? 17 : 7; // in fast, out slowly
    this.flinchW.step(this.flinchT > 0 ? 1 : 0, dt);
    this.leadW.step(this.leadOn ? 1 : 0, dt);
    this.leadDt = dt;
    if (this.leadW.x <= 0.001) this.leadBend = 0;
    this.balanceDebt = Math.max(0, this.balanceDebt - 0.8 * dt);

    // Exertion: fast rise under load, slow recovery (first-order physiological lag).
    const load = Math.max(clamp(this.gait.v / (this.traits.jogSpeed * Math.sqrt(this.dims.L / 0.888)), 0, 1) ** 1.5 + (this.strikeT >= 0 ? 0.35 : 0), 0.9 * this.fatigue);
    const tau = load > this.exertion ? 7 : 16;
    this.exertion += (load - this.exertion) * (1 - Math.exp(-dt / tau));

    // Breathing: ~16 → 38 breaths/min; inhale active (smootherstep), exhale passive (exponential recoil).
    const bpm = this.traits.breathRate + 22 * this.exertion;
    const prevCycle = this.breathCycle;
    this.breathPhase += (bpm / 60) * dt;
    this.breathCycle = Math.floor(this.breathPhase);
    if (this.breathCycle !== prevCycle) this.breathDepth = 0.8 + 0.4 * (0.5 + 0.5 * this.noise.noise(this.breathCycle * 0.73 + 100));
    const b = wrap01(this.breathPhase);
    const inhaleEnd = 0.38, exhaleEnd = mix(0.86, 0.97, this.exertion);
    this.breath = b < inhaleEnd ? smootherstep(0, inhaleEnd, b)
      : b < exhaleEnd ? 1 - easeOutExp((b - inhaleEnd) / (exhaleEnd - inhaleEnd), 4.5) : 0;
    this.breath *= this.breathDepth * (1 + 1.6 * this.exertion) * (this.style.breathAmp ?? 1);
  }

  /** Re-plants a foot a little differently (standing people rarely keep the same footprint). */
  _replant(foot) {
    if (foot.swing || foot.pending || this.feet.L.pending || this.feet.R.pending || this.strikeT >= 0) return;
    const L = this.dims.L, j = this.stanceJit[foot.side], r = this.rng;
    j.x = foot.sign * (0.04 * L * (r() - 0.35));
    j.z = 0.05 * L * (r() * 2 - 1);
    j.yaw = (r() * 2 - 1) * 6 * DEG;
    foot.pending = { timer: 0.25, urgent: false, rate: 1 / (0.45 + 0.15 * r()) };
  }

  /**
   * Fidgets: brief excursions that return to baseline (shrugs, neck stretches, knee softening,
   * hand fiddling, a small lean), on top of the slow sway and the weight shifts.
   */
  _updateFidget(dt, idleW, restless) {
    const f = this.fidget;
    if (f) {
      f.t += dt;
      if (f.t >= f.dur) this.fidget = null;
    }
    if (idleW < 0.9) { this.fidgetTimer = Math.max(this.fidgetTimer, 3); return; }
    this.fidgetTimer -= dt;
    if (this.fidgetTimer > 0 || this.fidget) return;
    const r = this.rng;
    const types = [['shrug', 0.9], ['neck', 1.8], ['bob', 1.1], ['hand', 1.4], ['lean', 2.2], ['replant', 0]];
    const [type, dur] = types[Math.floor(r() * types.length)];
    this.fidgetTimer = -Math.log(1 - r()) * mix(14, 6, restless) + 2;
    if (type === 'replant') { this._replant(r() < 0.5 ? this.feet.L : this.feet.R); return; }
    this.fidget = { type, t: 0, dur: dur * (0.8 + 0.4 * r()), side: r() < 0.5 ? 'L' : 'R', amp: 0.6 + 0.4 * r(), dir: r() < 0.5 ? -1 : 1 };
  }

  /** Envelope (0..1) of the active fidget if it is of this type, else 0. */
  _fid(type, side) {
    const f = this.fidget;
    if (!f || f.type !== type || (side && f.side !== side)) return 0;
    return asymmetricBump(f.t / f.dur, 0.35, 3) * f.amp * (1 - this.gait.locoW);
  }

  // ----- Pelvis --------------------------------------------------------------
  _updatePelvis(dt) {
    const g = this.gait, d = this.dims, L = d.L, t = this.time;
    const gw = this.guardW.x, locoW = g.locoW, rb = g.rb;
    const idleW = (1 - locoW) * (1 - gw);
    const fL = this.feet.L, fR = this.feet.R;
    const wL = this.weightL.x, wR = 1 - wL;
    const hip = this.drives.hip.s.x;

    // Foot positions in root frame (ankle ground point).
    const aL = this._toRoot(fL.ankle, this._t.v0);
    const aR = this._toRoot(fR.ankle, this._t.v1);

    // ---- Lateral / AP COM placement over the weighted base of support ----
    const cx = wL * aL.x + wR * aR.x;
    const cz = wL * aL.z + wR * aR.z;
    const gaitBlend = this.gaitActive ? 1 : 0;
    // (Strafing, the feet spread along the travel instead: the hips mostly ride the middle.)
    const lam = mix(0.9, mix(this.style.swayWalk, this.style.swayRun, rb) * (1 - 0.8 * (g.latK ?? 0)), gaitBlend); // walking hip sway over the stance foot (±2–2.5 cm)
    const turnLean = this._turnLean(g), sfT = this.speedForce > SPEEDSTER ? 1 : 0;
    const accLean = this._accLean(g, this.leanAccel) * Math.cos(this.travel);
    const swayX = this.noise.fbm(t * 0.21 + 11.3) * 0.009 * L * (0.4 + 0.6 * idleW);
    const swayZ = this.noise.fbm(t * 0.17 + 47.1) * 0.012 * L * (0.4 + 0.6 * idleW);
    const tx = cx * lam + d.hipsH * Math.tan(turnLean) * mix(mix(0.45, 0.2, rb), 0, sfT) + swayX;
    const tz = cz * 0.9 * (1 - gaitBlend) + d.hipsH * Math.tan(accLean) * 0.22 + 0.07 * L * hip * gw + swayZ
      + 0.03 * L * this.apaW // gait initiation: the body falls forward into the first step
      - 0.035 * L * this.crouchW.x - 0.09 * L * this.recoverW.x; // bent over, the hips go back to balance the trunk
    this.pelvisX.omega = mix(8, 12, gaitBlend);
    this.pelvisZ.omega = mix(6.5, 10, gaitBlend);
    // Feed-forward while walking: the hips arrive over the stance foot at mid-stance, in step with
    // the weight transfer, rather than a fifth of a stride late.
    this.pelvisX.follow(tx, dt, locoW, 0, 1);
    // Within-step speed rhythm: the body is propelled, not carried at a constant speed. Walking
    // trades kinetic for potential energy (an inverted pendulum, ≈ 65 % recovered, Cavagna 1977):
    // slowest at the top of the vault, fastest in double support, ≈ ±7 % of the speed. Running
    // brakes into mid-stance and is propelled out of it, slowest at the bottom. Derived from the
    // pelvis's actual height swing, as a fore-aft offset on top of the hips' smoothed position.
    const surgeOn = this.gaitActive && !this.jumpState ? g.locoW * smoothstep(0.3, 0.7, g.v) * Math.max(0, Math.cos(this.travel)) : 0;
    this.surgeYm += (this.pelvisFinalY - this.surgeYm) * Math.min(1, dt / 0.5);
    const surgeV = surgeOn * mix(-0.45, 0.8, rb) * G * (this.pelvisFinalY - this.surgeYm) / Math.max(g.v, 0.5);
    this.surgeZ += (surgeV - this.surgeZ / 0.4) * dt; // leaks back to zero (no drift)
    this.pelvisZ.x -= this.surgeApplied;
    this.pelvisZ.step(tz, dt);
    this.pelvisZ.x += this.surgeZ; this.surgeApplied = this.surgeZ;

    // ---- Rotation ----
    const zDiff = clamp((aL.z - aR.z) / (2 * L), -1.2, 1.2);
    const yawFeet = -this.style.pelvisYawGain * mix(1, this.style.pelvisYawRun, rb) * (1 + 0.3 * g.sprint) * zDiff * (gaitBlend ? this.jit.yaw : 0.5);
    const yawGuard = (-30 + 42 * hip) * DEG;
    // Standing: the pelvis faces where the feet face (turning in place, the upper body leads and
    // the hips follow the feet), so the legs never wind around each other.
    let footLag = 0;
    if (!this.gaitActive) {
      const facing = (f) => wrapAngle(f.yaw + f.pivotYaw.x - this.heading);
      footLag = clamp(0.5 * (facing(fL) + facing(fR)), -0.7, 0.7) * 0.7;
    }
    this.yawFeet = yawFeet;
    this.pelvisYaw.omega = mix(18, 30, gw);
    // The hips blade into guard only as far as the feet have reached the guard stance.
    const ready = this.guardTarget > 0.5 && !this.gaitActive ? 1 - smoothstep(0.08 * L, 0.3 * L, this._stanceError()) : 0;
    this.guardReady.step(ready, dt);
    // Contrapposto: standing on one leg, the hip of the free leg comes slightly forward.
    const yawShift = 2.5 * DEG * this.shift.x * idleW;
    this.pelvisYaw.follow(mix(yawFeet + footLag + yawShift, yawGuard, gw * this.guardReady.x), dt, locoW);
    this.footFacing = footLag;
    const st = this.style;
    const rollAmp = mix(mix(st.rollIdle, st.rollWalk, locoW), st.rollRun, rb * gaitBlend) * DEG * (1 - 0.6 * gw) * (gaitBlend ? this.jit.roll : 1);
    // Obliquity. Standing: the loaded hip is higher (contrapposto), in proportion to the load.
    // Walking: the swing side drops hardest right after weight acceptance (≈ 15–20 % of the
    // stride, gluteus medius catching it) and recovers through single support; running drops it
    // around mid-stance, at the force peak.
    const drop = (f) => (f.planted && f.gaitStance ? asymmetricBump(this._stanceS(f), mix(0.28, 0.45, rb), mix(3, 2.4, rb)) : 0);
    const rollGait = (drop(fL) - drop(fR)) * gaitBlend;
    this.pelvisRoll.follow(rollAmp * mix(wL - wR, rollGait, locoW) - turnLean * (this.speedForce > SPEEDSTER ? 0 : 0.15), dt, locoW);
    // Quiet stance sways as one inverted pendulum about the ankles: when the hips drift forward
    // the whole body (pelvis, trunk) leans with them; the head re-levels on top.
    const swayLean = Math.atan(swayZ / d.hipsH) * idleW;
    const pitchT = mix(0, mix(3, 7, rb) + 2 * g.sprint, locoW) * DEG + this.jumpBlend.x * this.jumpPose.pelvis * DEG + 8 * DEG * gw + accLean * 0.35 + this._speedLean(g) * (this.speedForce > SPEEDSTER ? 0.5 : 0.3) + 2 * DEG * hip * gw + this.traits.pelvicTilt + swayLean
      + (12 * this.crouchW.x + 28 * this.recoverW.x) * DEG;
    this.pelvisPitch.step(pitchT, dt);

    // ---- Height: designed vertical profile, then the leg-reach constraint ----
    const qP = quatYawRollPitch(this.pelvisYaw.x, this.pelvisRoll.x, this.pelvisPitch.x, this._t.q0);
    // Smoothing width of the soft minimum over the legs' reach limits. Standing, both legs give the
    // same limit and the soft minimum sits k·ln 2 below it (bent knees), so it is narrower there.
    const k = mix(0.005, 0.008, locoW) * L;
    const limit = (f, a, lead) => {
      const off = this._t.v2.copy(d.hipJoint[f.side]).applyQuaternion(qP);
      const hx = this.pelvisX.x + this.rest.Hips.charPos.x + off.x + this.comPert.x.x;
      const hz = this.pelvisZ.x + this.rest.Hips.charPos.z + off.z + this.comPert.x.z + lead;
      const hor2 = (hx - a.x) ** 2 + (hz - a.z) ** 2;
      return a.y - d.groundY + Math.sqrt(Math.max(d.reach * d.reach - hor2, 0)) - off.y;
    };
    const cw = this.crouchW.x, rw = this.recoverW.x;
    // Standing and walking aim above the legs' reach, so the reach limit sets the height: the loaded
    // knee stands locked straight, and the walking stance knee straightens by mid-stance as the hip
    // vaults over the foot (≈ 5°, as in people) instead of riding bent.
    const crouch = L * (0.002 * idleW + mix(-0.02, 0.03, rb) * locoW + 0.075 * gw + 0.02 * hip * gw + 0.14 * cw + 0.15 * rw + 0.05 * this.braceW.x * idleW + (this.style.sink ?? 0));
    // Cornering, the hips sink and the knees stay soft (the legs reach out sideways under a leaning
    // body); otherwise the stance legs lock straight and the turn is walked on stilts.
    const corner = smoothstep(0.4, 2.2, Math.abs(g.v * this.yawRate.x)) * locoW * gaitBlend;
    // (A speedster's hard turn: down low into it like a short-track skater, the inside hand reaching
    // for the ground.)
    this.hardTurn = this.speedForce > SPEEDSTER ? smoothstep(1.2, 2.2, Math.abs(this.yawRate.x)) * smoothstep(20, 40, g.vTrue ?? g.v) * locoW : 0;
    this.hardTurnW = (this.hardTurnW ?? 0) + (this.hardTurn - (this.hardTurnW ?? 0)) * (1 - Math.exp(-5 * dt)); // (eased: the deeper lean comes in over ≈ 0.2 s)
    // The whole-body lean the root carries next frame: in over ≈ 0.15 s, out over ≈ 0.25 s (and none in the air).
    { const want = this.speedForce > SPEEDSTER && !this.jumpState ? this._turnLean(g) : 0, cur = this.turnLeanS ?? 0;
      this.turnLeanS = cur + (want - cur) * (1 - Math.exp(-(Math.abs(want) > Math.abs(cur) ? 7 : 4) * dt)); }
    let y = d.hipsH - crouch - 0.045 * L * corner - 0.28 * L * this.hardTurn - 0.006 * L * Math.abs(this.shift.x) - 0.022 * L * this._fid('bob');
    let yAcc = 0; // feed-forward so the spring tracks the running profile without lag
    this.pelvisY.omega = mix(20, 46, rb * gaitBlend);
    if (this.gaitActive) {
      if (rb > 0) {
        // Running is a bouncing spring-mass: a half-sine ground force (peak ≈ 2 BW) whose impulse
        // over a step equals body weight, between ballistic flights. The body is still falling at
        // touchdown and keeps sinking onto the leg until mid-stance, then is thrown up into the
        // next flight. Leg stiffness (`stiff`, see stanceImpulse) sets how far it sinks. Offsets are
        // relative to the touchdown height, a little below the straight-leg reach to the landing foot.
        const Tc = g.duty / g.f, Tf = Math.max(0, 1 / (2 * g.f) - Tc);
        const v0 = -0.5 * G * Tf;
        const stiff = mix(this.style.runStiff, 0.65, smoothstep(2.6, 5.5, g.v * Math.sqrt(0.888 / L))); // a sprinter's leg is much stiffer
        let dy = Infinity, dv = 0, da = 0, rem = Infinity;
        for (const f of [fL, fR]) {
          if (f.swing?.kind === 'gait') rem = Math.min(rem, (1 - f.swing.t) / Math.max(f.swing.rate, EPS));
          if (!f.planted || !f.gaitStance) continue;
          const du = this._duty(f), Tcf = du / g.f, wf = Math.PI / Tcf, Pf = ((Tcf + Tf) / Tcf) * (Math.PI / 2);
          const u = this._stanceS(f), t = u * Tcf;
          // Soft spring-mass part (half-sine force) ...
          let yy = v0 * t + G * ((Pf / wf) * (t - Math.sin(wf * t) / wf) - 0.5 * t * t);
          let vv = v0 + G * ((Pf / wf) * (1 - Math.cos(wf * t)) - t);
          let aa = G * (Pf * Math.sin(wf * t) - 1);
          // ... mixed with a stiff part: the fall is stopped hard right after contact and the body
          // launched hard at toe-off (impact and push-off force peaks). Same take-off and landing
          // speeds, so the flights stay truly ballistic; a stiffer leg just sinks less in between.
          const imp = stanceImpulse(u, -v0, Tcf);
          yy = mix(yy, imp.y, stiff); vv = mix(vv, imp.v, stiff); aa = mix(aa, imp.a, stiff);
          if (yy < dy) { dy = yy; dv = vv; da = aa; }
        }
        if (dy === Infinity) {
          // Flight: y = (g/2)·τ·(T − τ), T = elapsed + time until the landing foot touches down.
          const tau = Math.max(0, this.time - this.lastLiftoff);
          const T = clamp(tau + (Number.isFinite(rem) ? rem : 0), tau, 2 * Tf + 0.05);
          dy = 0.5 * G * tau * (T - tau); dv = G * (0.5 * T - tau); da = -G;
        }
        // Touchdown height: the reach of the swinging leg to its landing point, predicted at contact,
        // and no higher than the stance leg can follow to its toe-off (foot fully rolled; this
        // matters when turning, where the feet land wide of the hips).
        let reachTd = Infinity;
        for (const f of [fL, fR]) {
          const sw = f.swing;
          if (sw?.kind === 'gait') {
            const tau = (1 - sw.t) / Math.max(sw.rate, EPS);
            reachTd = Math.min(reachTd, limit(f, this._alongArc(this._toRoot(sw.end, this._t.v4), tau), 0));
          } else if (f.planted && f.gaitStance) {
            const left = (1 - this._stanceS(f)) * this._duty(f) / g.f;
            const ar = this._toRoot(this._ankleFromPlant(f.ball, f.yaw + f.pivotYaw.x, this._maxRoll(), this._t.v4), this._t.v4);
            reachTd = Math.min(reachTd, limit(f, this._alongArc(ar, left), 0) + 0.01 * L);
          }
        }
        // Held while a jump owns the hips (the gait's timing is frozen, so its predictions go stale).
        const jumping = this.jumpState && this.jumpState.phase !== 'land' && this.jumpState.phase !== 'prep';
        if (Number.isFinite(reachTd) && !jumping) this.runTouch.step(reachTd, dt);
        // Sprinting lands on a straighter leg. Braking, the steps shorten faster than the smoothed
        // reach follows, so the hips sink a little (as people do when stopping hard) instead of
        // riding the landing leg's limit into contact.
        // (Capped: the speed force brakes at up to 160 m/s², and uncapped this sat her down in a crouch
        // with her legs curled under her every time she eased off.)
        const brake = Math.min(Math.max(0, -this.accelFwd) * 0.004, 0.025 * L);
        // (A crouch — the Hulk charging a leap on the run — runs lower, on bent legs.)
        const yTouch = this.runTouch.x - mix(0.008, 0.004, g.sprint) * L - brake - 0.16 * L * this.crouchW.x;
        // Never scaled once running: the flights are real ballistic arcs (falling at g), which is what
        // reads as weight. It fades in only as flight phases appear: through the walk→run switch the
        // stance is still walking-length, and this model would sink it absurdly deep.
        const bounce = this.jumpState && this.jumpState.phase !== 'land' ? 0 : smoothstep(0.0, 0.04, Tf); // a jump owns the hips while airborne
        y = mix(y, yTouch + dy * bounce, rb);
        yAcc = rb * bounce * (da + 2 * this.pelvisY.zeta * this.pelvisY.omega * dv);
      }
    }
    this.pelvisY.step(y, dt, yAcc);

    // Reach constraint: the hip joint can be no further than `reach` from each planted ankle.
    // This produces the inverted-pendulum vault of walking (determinants of gait emerge
    // from heel/forefoot rockers, pelvic rotation and obliquity raising the ankles/hips).
    // All limits are merged with one smooth minimum (always below each of them) and every leg's
    // limit is continuous through lift-off and touchdown, so no limit engages or lets go with a jolt.
    let lse = 0;
    const add = (y) => { lse += Math.exp((this.pelvisY.x - y) / k); };
    const maxRoll = this._maxRoll();
    for (const f of [fL, fR]) {
      const a = f === fL ? aL : aR;
      f.rollTo = f.pitch.x;
      if (f.planted && f.gaitStance && f.pitch.x <= 0) {
        // Pre-swing / toe-off: rather than holding the pelvis down, the trailing foot may roll
        // further onto its toes (up to maxRoll, see below); the limit is the leg's reach with
        // the foot rolled as far as it is allowed to be at this point of the stance.
        // From the planned stance pitch, not the current one (which the roll below adjusts).
        const sf = this._stanceS(f), base = Math.min(this._stancePitch(sf, rb), 0);
        f.rollTo = Math.min(base, mix(base, maxRoll, smoothstep(0.75, 1, sf)));
        const ar = this._toRoot(this._ankleFromPlant(f.ball, f.yaw + f.pivotYaw.x, f.rollTo, this._t.v4), this._t.v4);
        add(limit(f, ar, 0));
        continue;
      }
      // Lifting off, the limit lets go gradually (knee flexion) rather than all at once: it is
      // held at its toe-off value and relaxed, instead of following the rising swing foot.
      if (!f.planted) {
        // A jump sets the height while airborne; a swing that began in the air (the trailing leg
        // after a jump landing) has no lift-off to let go of.
        if (!f.swing || f.swing.kind === 'air' || f.swing.fromAir) continue;
        // The toe-off point keeps the rocker's velocity at first, then comes to rest relative to the hip.
        const sw = f.swing, el = sw.t / Math.max(sw.rate, EPS), w = smoothstep(0, 0.3, sw.t);
        const s0 = this._toRoot(this._t.v4.copy(sw.startRoll).addScaledVector(sw.v0, el * (1 - w)), this._t.v4);
        s0.z += g.v * el * w;
        // Gone by the second half of the swing (the landing blend below governs there; and while
        // braking, holding the point at the current speed would drift it back behind the hip). On a
        // curve it lets go sooner: the outside foot leaves from far behind and wide, and held there
        // it buckled the inside knee.
        add(limit(f, s0, 0) + smoothstep(0, mix(0.6 - 0.35 * smoothstep(0.3, 1.5, Math.abs(this.yawRate.x)), mix(0.25, 0.12, g.sprint), rb), sw.t) * 0.15 * L + smoothstep(0.5, 0.9, sw.t) * L);
        continue;
      }
      add(limit(f, a, 0));
    }
    let finalY = this.pelvisY.x - k * Math.log(1 + lse);
    const reachY = finalY; // every leg's reach limit merged (before the landing blend)
    const vs = this.walkY;
    // Landing leg: over the swing the pelvis eases down to where that leg will need it at
    // touchdown (hip predicted forward by the remaining root travel). The vault's rise right after
    // contact is taken up by the loading response (knee yield), below.
    for (const f of [fL, fR]) {
      const sw = f.swing;
      if (!sw || sw.kind === 'air') continue;
      const e = this._toRoot(sw.end, this._t.v4);
      const tau = (1 - sw.t) / Math.max(sw.rate, EPS);
      const touch = limit(f, this._alongArc(e, tau), 0);
      // From mid-swing (walking): earlier, it pulled the hips below the stance leg's reach through
      // terminal stance and the stance knee never straightened. Running already arrives below this
      // reach by design, and in flight the body may arc above it (the leg is in the air), so there
      // it acts only in the last instant before contact.
      finalY = mix(finalY, softMin(finalY, touch, k), smootherstep(mix(0.5, 0.85, rb), 1, sw.t));
    }
    // Walking height is a smooth wave, not the legs' limits followed point by point (that rises,
    // stalls and rises again each step, and pops up at every heel strike). The centre of mass of a
    // walker moves very nearly sinusoidally at twice the stride rate, lowest around heel strike and
    // highest at mid single support; the knees take up the difference to the legs' reach (they
    // yield after contact, straighten at mid-stance, flex into toe-off). The wave's crest and trough
    // are learned step by step from the actual geometry: the stance leg's full reach and the
    // landing leg's reach at touchdown. The reach limits stay as a ceiling.
    const walkW = this.gaitActive && !this.jumpState ? 1 - rb : 0;
    // Learned per leg: on a curve, or with a longer leg, the two sides' contacts and crests differ,
    // and one shared trough left the leg with the shorter reach landing with its knee bent deeper
    // every other step (a limp).
    const vL = vs.L, vR = vs.R;
    if (walkW > 0) {
      vs.peak = Math.max(vs.peak, reachY);
      for (const f of [fL, fR]) {
        if (!(f.planted && f.gaitStance && f.sinceLand === 0)) continue;
        // A new step: this contact's trough is the new leg's reach; the crest just passed was the
        // other leg's stance.
        const own = vs[f.side], other = vs[f.side === 'L' ? 'R' : 'L'];
        own.T = Number.isFinite(own.T) ? mix(own.T, reachY, 0.6) : reachY;
        if (Number.isFinite(vs.peak)) other.P = Number.isFinite(other.P) ? mix(other.P, vs.peak, 0.6) : vs.peak;
        vs.peak = -Infinity;
      }
      // Until both legs have shown their values, each borrows the other's.
      const val = (a, b) => (Number.isFinite(a) ? a : b);
      const PL = val(vL.P, vR.P), PR = val(vR.P, vL.P), TL = val(vL.T, vR.T), TR = val(vR.T, vL.T);
      if (Number.isFinite(PL) && Number.isFinite(TL)) {
        // Eased, so a new step's values never make the wave jump.
        if (!vs.eased) { vL.Ps.reset(PL); vR.Ps.reset(PR); vL.Ts.reset(TL); vR.Ts.reset(TR); vs.eased = true; }
        // At least ≈ 0.6 of a compass gait's drop over half a step (the trough learned from the very
        // first steps, taken from a standstill, can come out too high).
        const half = 0.25 * g.strideLen, drop = d.reach - Math.sqrt(Math.max(d.reach * d.reach - half * half, 0));
        const pL = vL.Ps.step(PL, dt), pR = vR.Ps.step(PR, dt);
        const lo = Math.min(pL, pR) - 0.6 * drop;
        const tL = Math.min(vL.Ts.step(TL, dt), lo), tR = Math.min(vR.Ts.step(TR, dt), lo);
        // Trough just after each contact (left at phase 0.02, right at 0.52), crest at mid single
        // support (0.27 of the stride after it); cosine-eased from each extreme to the next.
        const u = wrap01(this.phase - 0.02) * 4, i = Math.min(3, Math.floor(u));
        const ext = [tL, pL, tR, pR, tL];
        const wave = ext[i] + (ext[i + 1] - ext[i]) * 0.5 * (1 - Math.cos(Math.PI * (u - i)));
        vs.on = Math.min(1, vs.on + dt / 0.4); // takes over gently once the first step has shown its values
        vs.w = walkW * smootherstep(0, 1, vs.on);
        finalY = mix(finalY, softMin(wave - 0.004 * L, finalY, 0.006 * L), vs.w); // just under the reach: no kinks where it meets it
      }
    } else { vL.P = vL.T = vR.P = vR.T = NaN; vs.peak = -Infinity; vs.eased = false; vs.on = 0; vs.w = 0; }
    finalY = Math.max(finalY, d.hipsH - 0.4 * L);
    // (A leg asked to reach the impossible — an ankle tens of metres up a cliff — must not take the
    // whole body out of the world: the height falls back to standing and the springs are re-seated.)
    if (!Number.isFinite(finalY)) finalY = d.hipsH;
    for (const sp of [this.pelvisY, this.pelvisRise, this.runTouch]) if (!Number.isFinite(sp.x + sp.v)) { sp.x = d.hipsH; sp.v = 0; }
    for (const sp of [this.pelvisAccY, this.nod, this.trunkBounce]) if (!Number.isFinite(sp.x + sp.v)) { sp.x = 0; sp.v = 0; }
    // When a limit lets go (walking toe-off), the pelvis rises on a spring rather than jumping up to it.
    const rise = this.pelvisRise;
    rise.omega = 36;
    // Fed forward up to the vault's own rate, so the stance leg's rise is tracked without lag (a
    // lagging spring kept the stance knee bent ~15° all through the vault); a sudden release
    // (faster than that) still rises on the spring.
    rise.follow(finalY, dt, 1, 0, 0.6);
    // Running follows its own bounce profile (and releases its limits continuously).
    finalY = mix(softMinU(rise.x, finalY, 0.01 * L), finalY, rb * gaitBlend);

    // Legs push, they do not pull: supported by them, the body cannot drop faster than it would
    // fall. Where the height plan asks for that (stepping off a box or a stair) the hips fall
    // ballistically instead and then rejoin the plan on a fast spring.
    // Otherwise the plan is followed exactly. (A jump or the crawl owns the hips by itself.)
    {
      const hy = this.hipY, gDown = G * mix(0.95, 1.05, rb);
      // The hips fall in the world, not in the root's frame: as the root rides up a slope the plan
      // drops relative to it, and that is not a drop off a ledge.
      const rootY = this.root.position.y, dR = rootY - (hy.rootY ?? rootY);
      hy.rootY = rootY; hy.y -= dR; hy.prev -= dR;
      if (this.jumpState || this.crawl.owns || !(dt > 0)) { hy.mode = 0; hy.v = (finalY - hy.y) / Math.max(dt, EPS); hy.y = finalY; }
      else {
        const yb = hy.y + hy.v * dt - 0.5 * gDown * dt * dt; // where a free fall would be
        // Only for real drops, from one level down to another (the feet on different heights). The
        // gait's own contact turnarounds are left as designed: a tight walking turn dips the hips
        // faster than 0.8 m/s at heel strike, and catching that as a fall threw the hips up past
        // the legs' reach (stance legs locked straight through the turn).
        const yAt = (f) => (f.swing?.targetBall ?? f.ball).y;
        const levels = Math.max(Math.abs(fL.ball.y - fR.ball.y), Math.abs(yAt(fL) - yAt(fR)), Math.abs(yAt(fL) - fR.ball.y), Math.abs(fL.ball.y - yAt(fR))) > 0.04 * L;
        if (hy.mode === 0 && levels && finalY < yb && (finalY - hy.prev) / dt < -0.8) hy.mode = 1;
        if (hy.mode === 1) {
          if (finalY >= yb) hy.mode = 2; // the plan has caught the fall
          else { hy.y = yb; hy.v -= gDown * dt; }
        }
        if (hy.mode === 2) {
          // Rejoin: the error to the plan decays on a critically damped spring, never faster than
          // falling, and hands back once it is gone.
          const desV = (finalY - hy.prev) / dt;
          springStep(hy.y - finalY, hy.v - desV, 0, 40, 1, dt, hy.o);
          const a = Math.max(-gDown, (desV + hy.o.v - hy.v) / dt);
          hy.y += (hy.v + 0.5 * a * dt) * dt; hy.v += a * dt;
          // Rejoining from below, it never overshoots the plan (the legs' reach): braked only by
          // gravity, an overshoot would throw the hips up into the air.
          if (hy.y >= finalY || (Math.abs(hy.y - finalY) < 5e-4 && Math.abs(hy.v - desV) < 0.05)) hy.mode = 0;
        }
        if (hy.mode === 0) { hy.v = (finalY - hy.y) / dt; hy.y = finalY; }
      }
      hy.prev = finalY;
      finalY = hy.y;
    }
    if (this.jumpState) finalY = this._jumpPelvis(finalY, dt);
    // Landing absorption, decaying into the normal height (outlives the jump state).
    if (!this.jumpState || this.jumpState.phase === 'land') {
      this.landOff.step(0, dt);
      finalY += this.landOff.x;
    } else if (this.jumpState.phase !== 'prep') this.landOff.x = this.landOff.v = 0;

    // Toe-off roll: a trailing foot the hip has moved out of reach pitches further about its ball
    // (heel rising) until the ankle is back within reach, so the toes stay on the ground.
    for (const f of [fL, fR]) {
      const jumpFoot = this.jumpState?.phase === 'push' && this.jumpState.support.includes(f);
      if (!f.planted || !(f.gaitStance || jumpFoot) || f.pitch.x > 0) continue;
      if (jumpFoot) f.rollTo = -65 * DEG;
      const off = this._t.v2.copy(d.hipJoint[f.side]).applyQuaternion(qP);
      const hip = this._t.v5.set(
        this.pelvisX.x + this.rest.Hips.charPos.x + off.x + this.comPert.x.x,
        finalY + d.groundY + off.y,
        this.pelvisZ.x + this.rest.Hips.charPos.z + off.z + this.comPert.x.z,
      ).applyMatrix4(this.root.matrixWorld);
      const yaw = f.yaw + f.pivotYaw.x, r2 = (d.reach * 0.999) ** 2, A = this._t.v6;
      if (this._ankleFromPlant(f.ball, yaw, f.pitch.x, A).distanceToSquared(hip) <= r2) continue;
      let lo = f.pitch.x, hi = f.rollTo; // lo out of reach, hi within (the limit above allowed for it)
      if (this._ankleFromPlant(f.ball, yaw, hi, A).distanceToSquared(hip) <= r2) {
        for (let i = 0; i < 10; i++) {
          const m = 0.5 * (lo + hi);
          if (this._ankleFromPlant(f.ball, yaw, m, A).distanceToSquared(hip) <= r2) hi = m; else lo = m;
        }
      }
      f.pitch.x = hi;
      this._ankleFromPlant(f.ball, yaw, hi, f.ankle);
      f.toe.x = Math.max(0, -hi);
    }

    // Vertical / lateral acceleration (drives secondary motion).
    const vy = (finalY - this.pelvisFinalY) / dt;
    this.pelvisAccY.step((vy - this.pelvisVelY) / dt, dt);
    this.pelvisVelY = vy;
    if (!Number.isFinite(finalY)) finalY = d.hipsH;
    this.pelvisFinalY = finalY;
    const lat = this.pelvisX.x + this.comPert.x.x;
    const vl = (lat - this.pelvisPrevLat) / dt;
    this.pelvisAccLat.step((vl - this.pelvisVelLat) / dt, dt);
    this.pelvisVelLat = vl;
    this.pelvisPrevLat = lat;
  }

  _toRoot(world, out) {
    return out.copy(world).applyMatrix4(this._rootInvM);
  }

  /**
   * A point in the root frame, re-expressed in the frame the root will have `tau` s from now,
   * travelling at the gait speed along the arc the current yaw rate turns. (Predicted straight
   * ahead instead, a hard turn put the landing foot far out to the side and sank the hips.)
   */
  _alongArc(a, tau) {
    const v = this.gait.v, th = this.yawRate.x * tau;
    const fz = Math.abs(th) < 1e-4 ? v * tau : (v * tau * Math.sin(th)) / th;
    const fx = Math.abs(th) < 1e-4 ? v * tau * th / 2 : (v * tau * (1 - Math.cos(th))) / th;
    const dx = a.x - fx, dz = a.z - fz, c = Math.cos(th), s = Math.sin(th);
    return a.set(dx * c - dz * s, a.y, dx * s + dz * c);
  }

  // ----- Trunk, neck, head -----------------------------------------------------
  _updateTrunk(dt) {
    const g = this.gait, gw = this.guardW.x, locoW = g.locoW, rb = g.rb, t = this.time;
    const idleW = (1 - locoW) * (1 - gw);
    const spineD = this.drives.spine.s.x;
    const accLean = this._accLean(g, this.leanAccel);
    const turnLean = this._turnLean(g);

    // Thorax counter-rotation (angular-momentum cancellation): world thorax yaw opposes pelvis
    // at brisk speeds, but when strolling the thorax turns with the pelvis.
    const counter = mix(mix(-0.3, this.style.thoraxWalk, smoothstep(0.6, 1.4, g.v)), this.style.thoraxRun * (1 + 0.25 * g.sprint), rb);
    // Turns are led from the top: eyes and head toward the new direction (by up to ~30°), the
    // thorax part of the way, the pelvis and feet last.
    // (Faded out when the wanted direction is nearly behind her, where its sign flips, and while
    // the cursor look leads.)
    const ahead = clamp(this.lookAhead * 0.6, -30 * DEG, 30 * DEG) * (1 - smoothstep(110 * DEG, 165 * DEG, Math.abs(this.lookAhead)));
    this.lookYaw.step(ahead * (1 - gw) * (1 - 0.7 * this.lookW.x), dt);
    // Looking far to the side, the chest turns a little to help the neck.
    const lookChest = 0.3 * this.lookW.x * this.lookRel.yaw * (1 - 0.5 * locoW);
    const thoraxWorld = mix(-counter * this.yawFeet + 0.3 * this.lookYaw.x + lookChest, (-22 + 50 * spineD) * DEG, gw);
    // Feed-forward while moving, so the thorax swings against the pelvis in time with it rather
    // than a quarter-cycle behind (which reads as the chest wobbling on its own).
    this.spineYaw.follow(clamp(thoraxWorld - this.pelvisYaw.x, -50 * DEG, 50 * DEG), dt, g.locoW);

    const swayP = this.noise.fbm(t * 0.13 + 3.1) * 0.9 * DEG;
    const swayR = this.noise.fbm(t * 0.11 + 9.7) * 0.7 * DEG;
    const fLean = this._fid('lean') * (this.fidget?.dir || 1) * 3 * DEG;
    // Sprinting leans further into the run; while bursting from slow, the acceleration lean
    // (a/g) adds a lot more (up to ≈ 20°), easing as she nears top speed.
    const pitchT = accLean * 0.65 + this._speedLean(g) * (this.speedForce > SPEEDSTER ? 0.5 : 0.7) + mix(0, mix(2, 6 + 4 * g.drive + 2 * g.sprint, rb), locoW) * DEG + this.jumpBlend.x * this.jumpPose.trunk * DEG + 6 * DEG * gw + 7 * DEG * spineD * gw
      - this.breath * 1.0 * DEG * mix(0.4, 1, this.exertion) + swayP
      + 2.5 * DEG * this.apaW - 0.8 * this.traits.pelvicTilt + Math.abs(fLean) * 0.5
      + (20 * this.crouchW.x + 54 * this.recoverW.x - 5 * this.flinchW.x + (this.style.hunch ?? 0)) * DEG;
    this.spinePitch.step(pitchT, dt);
    // Lateral bend against the pelvic tilt, applied to the pelvis's current tilt (no lag): moving,
    // the chest stays nearly level and rides over the hips' side-to-side sway; standing in
    // contrapposto over-corrects, so the shoulders tilt opposite the hips (shoulder lower on the
    // loaded side) and the spine makes a gentle S.
    const counterRoll = mix(mix(this.style.contrapposto, mix(0.95, 0.85, rb), locoW), 0.75, gw);
    this.spineRoll.step(-turnLean * (this.speedForce > SPEEDSTER ? 0.12 : 0.35) - 4 * DEG * spineD * gw + swayR + fLean, dt);
    this.spineCounterRoll = -counterRoll * this.pelvisRoll.x;
    // Shoulder swagger (men): the torso sways over the stance leg relative to the pelvis, which
    // itself stays level. Driven by the load (already in time with the steps), not by a spring.
    this.swagger = -this.style.swagger * DEG * (2 * this.weightL.x - 1) * locoW * (1 - 0.5 * rb) * (1 - gw);
    this.spineRollTot = this.spineRoll.x + this.swagger + this.spineCounterRoll;

    // Inertia-driven secondary motion from pelvis acceleration.
    const ay = clamp(this.pelvisAccY.x, -40, 40);
    // Load folds the trunk and nods the head in proportion to the vertical acceleration of the hips
    // (quasi-static, with a little lag and overshoot): heavy landings fold them forward, flights
    // (−g) let them rise. Sprint ±2.5°, jog ±1.5°, walk ±0.5°. The shoulder girdle sags likewise.
    this.nod.step(0.22 * ay * DEG, dt);
    this.trunkBounce.step(0.28 * ay * DEG, dt);
    this.shoulderSag.step(0, dt, -ay);
    this.headSway.step(0, dt, -clamp(this.pelvisAccLat.x, -30, 30) * 0.4 * DEG * 10);

    // Head: gaze stabilisation (vestibulo-collic): world yaw → gaze target, level horizon.
    // Head: gaze stabilisation (vestibulo-collic reflex). The springs carry only where she means
    // to look; the reflex cancels most of the trunk's own motion directly, so the head stays
    // steady in space while the body rotates and tilts beneath it.
    const spineYawTot = this.spineYaw.x, spinePitchTot = this.spinePitch.x + this.trunkBounce.x;
    const headWorldYaw = this.gazeYaw.x + this.yawRate.x * 0.28 * (1 - gw) + this.lookYaw.x;
    this.headYaw.step(headWorldYaw, dt);
    this.headYawTot = clamp(this.headYaw.x - 0.92 * (this.pelvisYaw.x + spineYawTot), -70 * DEG, 70 * DEG);
    const nPitch = this.noise.fbm(t * 0.19 + 21.5) * 1.6 * DEG * (0.5 + idleW);
    const nYaw = this.noise.fbm(t * 0.15 + 33.3) * 1.8 * DEG * (0.4 + idleW);
    // Neck stretch fidget: the head tips to one side and a little forward, then comes back.
    const neck = this._fid('neck');
    const neckDir = this.fidget?.dir || 1;
    this.headPitch.step(this.gazePitch.x + 7 * DEG * gw + 2 * DEG + nPitch + 8 * DEG * neck, dt);
    this.headRoll.step(this.noise.fbm(t * 0.12 + 5.5) * 1.0 * DEG + 14 * DEG * neck * neckDir, dt);
    this.headPitchTot = this.headPitch.x - (this.pelvisPitch.x + spinePitchTot) * 0.85 + 16 * DEG * this.flinchW.x;
    // A flinch turns the face away directly (a reflex, not a gaze shift).
    this.headYawTot = clamp(this.headYawTot - this.flinchSide * 32 * DEG * this.flinchW.x, -70 * DEG, 70 * DEG);
    this.headRollTot = this.headRoll.x - (this.pelvisRoll.x + this.spineRollTot) * 0.9;
    this.headNoiseYaw = nYaw;
  }

  // ----- Arm drives (FK pendulums) ----------------------------------------------
  /**
   * The arm pendulums brought to rest, for taking the body back after something else posed it:
   * left as they were (a flat-out sprint's swing, still moving fast), they would whirl the arms
   * round on the loose idle spring.
   */
  settleArms() {
    for (const s of ['L', 'R']) {
      const a = this.arm[s];
      a.swing.x = a.swing.v = 0;
      a.elbow.x = this.style.elbowWalk * DEG; a.elbow.v = 0; a.prevElbowV = 0;
      a.wrist.x = a.wrist.v = 0; a.flop.x = a.flop.v = 0; a.fa = a.faV = 0;
      this.armAbd[s].x = this.armAbd[s].v = 0;
    }
    this.speed.v = 0;
  }

  _updateArms(dt) {
    const g = this.gait;
    const locoW = g.locoW, rb = g.rb;
    // Shoulder flex/ext: walking ±18° slightly behind neutral; running swings further and
    // further back (hand from hip pocket to chest), growing with speed.
    // Sprinting arms pump through ≈ 110–120° at the shoulder (hand from chin height to behind the hip).
    const cw = this.crouchW.x;
    const amp = mix(this.style.armSwing, mix(32, 44, g.drive) + 10 * g.sprint, rb) * DEG * locoW * clamp(g.v / 1.2, 0.35, 1) * (1 - 0.5 * cw) * (1 + 0.2 * (g.blur ?? 0));
    // Relative to the trunk, which already leans forward. Jogging swings further back than forward
    // (shoulder ≈ +20° / −45°), so on the back swing the hand reaches the hip, not the thigh in front of it.
    const bias = mix(-4, -12, rb) * DEG * locoW + 14 * DEG * cw; // crouched, the arms are carried forward
    // Arm = driven pendulum, loose (ω ≈ 1.7× step rate) so it trails the legs and overshoots a
    // little; passive at rest (ω ≈ 5.5, a 0.6 m physical pendulum).
    const ratio = 1.7, zeta = 0.55;
    const omega = mix(5.5, 2 * Math.PI * g.f * ratio, locoW);
    // Each arm opposes the ipsilateral leg: it peaks forward around the contralateral heel
    // strike (p ≈ 0.5). The drive is advanced by the pendulum's steady-state lag minus a ~10°
    // physiological lag, and its amplitude is pre-divided by the pendulum's gain.
    const r = 1 / ratio;
    const lag = Math.atan2(2 * zeta * r, 1 - r * r) / (2 * Math.PI) - 0.03;
    const gain = 1 / Math.hypot(1 - r * r, 2 * zeta * r);
    const accF = clamp(this.accelFwd, -8, 8);
    const ay = clamp(this.pelvisAccY.x, -40, 40);
    for (const s of ['L', 'R']) {
      const a = this.arm[s];
      const p = wrap01(this.phase + (s === 'R' ? 0.5 : 0));
      const drive = this.gaitActive || locoW > 0.01 ? Math.cos(2 * Math.PI * (p - 0.5 + lag)) : 0;
      // Jumping: the arms are driven to the jump's poses (stiffer, less loose) over the gait swing.
      const jb = this.jumpBlend.x, jp = this.jumpPose;
      a.swing.omega = mix(omega, 21, jb); // the arm swing of a jump is a fast, driven action
      a.swing.zeta = mix(mix(0.5, zeta, locoW), 0.75, jb);
      // Inertial forcing: accelerating forward swings arms back.
      // Arm swing is personal: one arm (usually the left) swings more, and every cycle differs a little.
      const ampS = amp * this.traits.arm[s] * this.jit.arm[s];
      a.swing.step(mix(bias + (ampS / gain) * drive, jp.arm[s] * DEG, jb), dt, -accF * 1.6 * (1 - jb));
      // Elbow closes as the arm swings forward (hand rises toward the chest) and opens behind.
      const n = amp > 1e-3 ? clamp((a.swing.x - bias) / amp, -1.2, 1.2) : 0;
      // Sprinting: ≈ 100–110° in front, opening to ≈ 50° on the back swing (a longer lever behind).
      const base = mix(mix(this.style.elbowWalk, this.style.elbowWalk + 12, locoW), mix(mix(86, 94, g.drive), 80, g.sprint), rb * locoW);
      // Walking elbow range ≈ 30° (±15°); jogging holds ~85–95° and opens only a little on the
      // back swing (so the hand passes the hip, not the thigh). Idle hand fiddling bends it up.
      const elbowT = (base + locoW * mix(mix(15, 10, rb), 26, g.sprint) * n) * DEG + this.traits.elbow[s] + 22 * DEG * this._fid('hand', s) + 30 * DEG * cw;
      a.elbow.omega = mix(16, 22, locoW);
      a.elbow.step(Math.max(mix(elbowT, jp.elbow[s] * DEG, jb), 4 * DEG), dt, -ay * 0.5);
      const elbowAcc = (a.elbow.v - a.prevElbowV) / dt;
      a.prevElbowV = a.elbow.v;
      // A jogger's loose fist stays in line with the forearm (it does not bend toward the thigh).
      a.wrist.step(mix(3, -4, rb * locoW) * DEG, dt, -clamp(elbowAcc, -400, 400) * 0.08);
      // A relaxed hand hangs from the wrist: it trails the forearm's swing (lags its angular
      // acceleration, ≈ ±5–8° walking) and droops a little toward vertical when the forearm comes
      // up in front. Held in line by a jogger's fist and when the hands are in use.
      const fa = a.swing.x + a.elbow.x, faV = (fa - a.fa) / Math.max(dt, 1e-4);
      const faAcc = clamp((faV - a.faV) / Math.max(dt, 1e-4), -80, 80);
      a.fa = fa; a.faV = faV;
      const loose = (1 - 0.85 * rb * locoW) * (1 - this.guardW.x) * (1 - jb);
      a.flop.step(-0.2 * Math.max(0, fa) * loose, dt, -1.3 * faAcc * loose);
    }
    // A frantic sprint runs with open, tense hands rather than a jogger's loose fist.
    // The speed force's blur run: knife hands, the fingers straight (the Flash's own, not a sprinter's).
    this.fingerCurl.step(mix(mix(0, mix(0.35, 0.12, g.sprint) * (1 - (g.blur ?? 0)), rb * locoW), 1, this.guardW.x), dt);
  }

  // -------------------------------------------------------------------------
  // Pose solve (writes bone transforms)
  // -------------------------------------------------------------------------
  _setCharRotation(key, R) {
    const b = this.bones[key];
    if (!b) return;
    const r = this.rest[key];
    b.quaternion.copy(r.parentCharQInv).multiply(R).multiply(r.parentCharQ).multiply(r.q0);
  }

  _solvePose() {
    const d = this.dims, g = this.gait, gw = this.guardW.x, T = this._t;
    this._updateRootFrame();

    // ---- Pelvis (Hips) ----
    const imp = (spring, scale, out) => {
      const v = T.v7.copy(spring.x).multiplyScalar(scale);
      const ang = v.length();
      return ang < EPS ? out.identity() : out.setFromAxisAngle(v.divideScalar(ang), ang);
    };
    const qPelvis = quatYawRollPitch(this.pelvisYaw.x, this.pelvisRoll.x, this.pelvisPitch.x, T.q0);
    qPelvis.premultiply(imp(this.pelvisImp, 1, T.q1));
    this._setCharRotation('Hips', qPelvis);
    const hipsRest = this.rest.Hips.charPos;
    const hipsWorld = T.v0.set(
      hipsRest.x + this.pelvisX.x + this.comPert.x.x,
      d.groundY + this.pelvisFinalY,
      hipsRest.z + this.pelvisZ.x + this.comPert.x.z,
    ).applyMatrix4(this.root.matrixWorld);
    const hips = this.bones.Hips;
    hips.parent.updateWorldMatrix(true, false);
    hips.position.copy(hips.parent.worldToLocal(hipsWorld));

    // ---- Spine chain (distributed, with impulse layer) ----
    const spineW = [0.28, 0.34, 0.38];
    const impW = [0.4, 0.33, 0.27];
    // The side bend against the pelvic tilt happens low in the lumbar spine, so the trunk column
    // stands upright over the hips and travels with them instead of leaning out of phase.
    const counterW = [0.85, 0.15, 0];
    const yawTot = this.spineYaw.x, pitchTot = this.spinePitch.x + this.trunkBounce.x, rollTot = this.spineRoll.x + this.swagger;
    ['Spine', 'Spine1', 'Spine2'].forEach((k, i) => {
      const roll = rollTot * spineW[i] + this.spineCounterRoll * counterW[i];
      const q = quatYawRollPitch(yawTot * spineW[i], roll, pitchTot * spineW[i], T.q2);
      q.premultiply(imp(this.spineImp, impW[i], T.q1));
      this._setCharRotation(k, q);
    });

    // ---- Neck / head ----
    // Forward head posture: the neck juts forward and the head tips back to keep the eyes level.
    const headW = [0.4, 0.6], fhp = [this.traits.forwardHead, -this.traits.forwardHead];
    ['Neck', 'Head'].forEach((k, i) => {
      const q = quatYawRollPitch(
        (this.headYawTot + this.headNoiseYaw) * headW[i],
        (this.headRollTot + this.headSway.x) * headW[i],
        (this.headPitchTot + this.nod.x) * headW[i] + fhp[i] * (1 - gw), T.q2);
      q.premultiply(imp(this.headImp, headW[i], T.q1));
      this._setCharRotation(k, q);
    });

    // ---- Breathing: belly (lumbar) vs chest expansion via counter-scaled segments ----
    const chestFrac = mix(0.3, 0.75, this.exertion);
    this._breathScale('Spine', ['Spine1'], 1 + 0.012 * this.breath * (1 - chestFrac));
    this._breathScale('Spine2', ['Neck', 'LeftShoulder', 'RightShoulder'], 1 + 0.016 * this.breath * chestFrac);

    // ---- Clavicles ----
    const sd = this.drives.shoulder.s.x * gw;
    for (const s of ['L', 'R']) {
      const key = s === 'L' ? 'LeftShoulder' : 'RightShoulder';
      if (!this.bones[key]) continue;
      const swing = this.arm[s].swing.x;
      let elev = this.breath * mix(0.6, 2.6, this.exertion) * DEG + 5 * DEG * gw + 7 * DEG * this._fid('shrug') + 10 * DEG * this.flinchW.x;
      elev += clamp(this.shoulderSag.x / 0.15, -0.1, 0.1); // the girdle sags on landings, lifts in flight
      let prot = 0.28 * swing + this.traits.roundShoulders * (1 - gw);
      elev += 0.1 * Math.max(0, swing) * g.locoW;
      elev += 5 * DEG * g.sprint; // all-out effort: shoulders tense and ride up
      if (s === 'R') { prot += 16 * DEG * sd; elev += 6 * DEG * sd; }
      else { prot -= 4 * DEG * sd; }
      const q = quatYawRollPitch(-prot, elev, 0, T.q2);
      if (s === 'R') mirrorQuat(q);
      this._setCharRotation(key, q);
      this.clavElev[s] = elev;
    }

    // ---- FK arms (locomotion / idle) ----
    const fkLocal = {};
    for (const s of ['L', 'R']) {
      const side = s === 'L' ? 'Left' : 'Right';
      const sign = s === 'L' ? 1 : -1;
      const a = this.arm[s], c = this.chains['arm' + s];
      // Elbows close to the ribs, upper arms just clear of the hips; jogging carries them a little
      // wider so the hands pass outside the hips instead of being pushed out every stride.
      const st = this.style;
      const abd = (st.armAbd + 2 * g.locoW + st.armAbdRun * g.rb * g.locoW + this.jumpBlend.x * this.jumpPose.abd + 5 * this.crouchW.x) * DEG;
      const down = T.v1.set(sign * Math.sin(abd), -Math.cos(abd), 0);
      const qLower = T.q3.setFromUnitVectors(c.u0, down);
      // Humeral internal rotation: the flexed forearm angles toward the midline instead of
      // pointing straight ahead.
      // Running: the hands cross toward the midline on the forward swing (in front of the chest)
      // but pass outside the hip on the back swing, clear of the thigh coming forward.
      const fwdF = smoothstep(-0.25, 0.25, a.swing.x);
      const inRot = g.locoW * (st.armInRot + 10 * g.rb * fwdF) * DEG;
      qLower.premultiply(T.q4.setFromAxisAngle(down, sign * inRot));
      const kappa = (st.armCross + 8 * g.sprint) * DEG * g.rb * g.locoW * fwdF; // swing crosses the midline when running
      const qSwing = T.q2.setFromAxisAngle(T.v2.set(Math.cos(kappa), 0, Math.sin(kappa)), -a.swing.x);
      if (s === 'R') mirrorQuat(qSwing);
      // The arm hangs from the shoulder: a lifted or sagging shoulder girdle (breathing, a shrug,
      // landings) raises or lowers the shoulder joint, it does not swing the arm out sideways.
      // So the clavicle's elevation is taken back out of the arm (its protraction stays).
      const qComp = quatYawRollPitch(0, -this.clavElev[s], 0, T.q5);
      if (s === 'R') mirrorQuat(qComp);
      this._setCharRotation(side + 'Arm', qComp.multiply(qSwing).multiply(qLower));
      // Carrying angle (≈ 10–15° in women, softened here): the extended forearm angles away from the body so the hand
      // clears the hip; it disappears as the elbow flexes.
      const carry = sign * st.carryAngle * DEG * (1 - smoothstep(0, 80 * DEG, a.elbow.x));
      this._setCharRotation(side + 'ForeArm', T.q2.setFromAxisAngle(AXIS_Z, carry).multiply(T.q4.setFromAxisAngle(c.h0, -a.elbow.x)));
      this._setCharRotation(side + 'Hand', T.q2.setFromAxisAngle(T.v2.set(0, 0, sign), -a.wrist.x).multiply(T.q4.setFromAxisAngle(T.v3.set(0, 1, 0), -sign * a.flop.x)));
      fkLocal[s] = [
        this.bones[side + 'Arm'].quaternion.clone(),
        this.bones[side + 'ForeArm'].quaternion.clone(),
        this.bones[side + 'Hand'].quaternion.clone(),
      ];
    }
    this._solveFingers();

    this.model.updateMatrixWorld(true);

    // ---- Legs: analytic two-bone IK + foot orientation ----
    for (const s of ['L', 'R']) this._solveLeg(s);

    // ---- Guard arms: two-bone IK blended over FK ----
    if (gw > 0.001) this._solveGuardArms(fkLocal, gw);
    // ---- Out of breath: hands on the thighs just above the knees ----
    const rw = this.recoverW.x * (1 - gw);
    if (rw > 0.001) this._solveRestArms(fkLocal, rw);
    const fw = this.flinchW.x * (1 - gw);
    if (fw > 0.001) this._solveFlinchArms(fkLocal, fw);
    if (this.leadW.x > 0.001) this._solveLeadArm(fkLocal, this.leadW.x);

    // ---- Self-collision: no limb passes through another ----
    this._resolveCollisions();
  }

  _breathScale(key, children, k) {
    const b = this.bones[key];
    if (!b) return;
    b.scale.copy(this.rest[key].s0).multiplyScalar(k);
    for (const c of children) {
      const cb = this.bones[c];
      if (cb && cb.parent === b) cb.scale.copy(this.rest[c].s0).divideScalar(k);
    }
  }

  _solveFingers() {
    const T = this._t;
    for (const s of ['L', 'R']) {
      const c = Math.min(1, this.fingerCurl.x + 0.45 * this._fid('hand', s));
      const side = s === 'L' ? 'Left' : 'Right';
      const sign = s === 'L' ? 1 : -1;
      const axis = T.v1.set(0, 0, sign);
      for (const f of FINGERS) {
        for (let j = 0; j < 3; j++) {
          const ang = mix(FINGER_RELAXED[f][j], FINGER_FIST[j] * (f === 'Index' ? 0.95 : 1), c) * DEG;
          this._setCharRotation(`${side}Hand${f}${j + 1}`, T.q2.setFromAxisAngle(axis, -ang));
        }
      }
      // Thumb (authored for the left hand, mirrored).
      const t1 = T.q2.setFromEuler(_euler.set(mix(10, 38, c) * DEG, mix(6, 22, c) * DEG, 0, 'XYZ'));
      if (s === 'R') mirrorQuat(t1);
      this._setCharRotation(`${side}HandThumb1`, t1);
      const tAxis = T.v2.set(1, 0, -1).normalize();
      for (let j = 2; j <= 3; j++) {
        const q = T.q3.setFromAxisAngle(tAxis, mix(8, 34, c) * DEG);
        if (s === 'R') mirrorQuat(q);
        this._setCharRotation(`${side}HandThumb${j}`, q);
      }
    }
  }

  /**
   * Two-bone IK. Returns world-space unit directions of the upper/lower segment and the
   * hinge axis. `poleDir` gives the direction the middle joint should displace toward.
   */
  _twoBone(A, target, poleDir, a, b, maxReach, out) {
    const T = this._t;
    const dv = T.v4.copy(target).sub(A);
    let dist = dv.length();
    const dir = dist > EPS ? dv.divideScalar(dist) : dv.set(0, -1, 0);
    dist = clamp(dist, Math.abs(a - b) + 1e-4, (a + b) * maxReach);
    const cosA = clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const perp = T.v5.copy(poleDir).addScaledVector(dir, -poleDir.dot(dir));
    if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(dir, -dir.z);
    perp.normalize();
    out.upper.copy(dir).multiplyScalar(cosA).addScaledVector(perp, sinA);
    const mid = T.v6.copy(A).addScaledVector(out.upper, a);
    const end = T.v7.copy(A).addScaledVector(dir, dist);
    out.lower.copy(end).sub(mid).normalize();
    out.hinge.crossVectors(dir, perp).normalize();
    return out;
  }

  _ikOut() {
    if (!this.__ik) this.__ik = { upper: new THREE.Vector3(), lower: new THREE.Vector3(), hinge: new THREE.Vector3() };
    return this.__ik;
  }

  /** Writes upper/lower local rotations from IK directions using hinge-aligned frames. */
  _applyChain(c, ik, upperWorldOut, lowerWorldOut) {
    const T = this._t;
    // World → character space for the IK directions.
    const u = T.v1.copy(ik.upper).applyQuaternion(this._rootQInv);
    const l = T.v2.copy(ik.lower).applyQuaternion(this._rootQInv);
    const h = T.v3.copy(ik.hinge).applyQuaternion(this._rootQInv);
    const up = this.bones[c.up], mid = this.bones[c.mid];
    // Upper: R = F(u,h)·F(u0,h0)⁻¹ ; world = rootQ · R · restCharQ
    const R = frameQuat(u, h, T.q2).multiply(c.restUpperInv);
    upperWorldOut.copy(this._rootQ).multiply(R).multiply(this.rest[c.up].charQ);
    up.parent.getWorldQuaternion(T.q3);
    up.quaternion.copy(T.q3.invert()).multiply(upperWorldOut);
    const R2 = frameQuat(l, h, T.q2).multiply(c.restLowerInv);
    lowerWorldOut.copy(this._rootQ).multiply(R2).multiply(this.rest[c.mid].charQ);
    mid.quaternion.copy(T.q3.copy(upperWorldOut).invert()).multiply(lowerWorldOut);
  }

  _solveLeg(s, ankle) {
    const T = this._t, d = this.dims;
    const foot = this.feet[s], c = this.chains['leg' + s];
    const side = s === 'L' ? 'Left' : 'Right';
    const A = this.bones[c.up].getWorldPosition(T.v0);
    const yaw = foot.yaw + foot.pivotYaw.x;
    // Knees face forward with the pelvis: toe-out comes from the shank's external torsion, not
    // from turning the knee out (which reads as bow-legged).
    const pYaw = this.heading + this.pelvisYaw.x;
    const kneeYaw = yaw + wrapAngle(pYaw - yaw) * 0.8;
    const pole = T.v8.set(Math.sin(kneeYaw), 0.05, Math.cos(kneeYaw));
    // A swinging foot is never asked to be out of the leg's reach: at speed the body leaves the
    // lifted foot behind faster than its path recovers it, and a leg locked straight behind reads as
    // broken. Past ≈ 95 % of the reach the target is drawn in toward the hip (smoothly, saturating
    // short of full extension) — the knee folding, as the heel recovery of a sprinter does.
    // (Only a foot trailing behind the hip, early in its swing: reaching forward to land it is left
    // alone, or it would snap out to its foothold at touchdown.)
    let tgt = ankle || foot.ankle;
    const sw = foot.swing;
    if (!foot.planted && sw?.kind === 'gait') {
      const R = (c.a + c.b) * 0.985, r0 = R * 0.95, dist = A.distanceTo(tgt);
      const behind = -((tgt.x - A.x) * Math.sin(this.heading) + (tgt.z - A.z) * Math.cos(this.heading));
      const w = (1 - smoothstep(0.35, 0.6, sw.t)) * smoothstep(0, 0.1 * d.L, behind);
      if (dist > r0 && w > 0) {
        const dd = r0 + (R - r0) * Math.tanh((dist - r0) / (R - r0));
        tgt = T.v9.copy(tgt).sub(A).multiplyScalar(mix(1, dd / dist, w)).add(A);
      }
    }
    const ik = this._twoBone(A, tgt, pole, c.a, c.b, 0.9995, this._ikOut());
    const upperW = T.q4, lowerW = T.q5;
    this._applyChain(c, ik, upperW, lowerW);

    // Foot: yaw relative to heading, pitch about the foot's lateral axis.
    let pitch = foot.pitch.x;
    // Shank inclination in the foot's sagittal plane (+ = ankle behind the knee).
    const fy = yaw - this.heading, sx = Math.sin(fy), sz = Math.cos(fy);
    const l = T.v1.copy(ik.lower).applyQuaternion(this._rootQInv);
    const phi = Math.atan2(-(l.x * sx + l.z * sz), -l.y);
    foot.ankleAngle = foot.pitch.x + phi; // remembered so the next swing starts from it
    if (foot.swing && foot.swingW > 0) pitch = mix(pitch, foot.swingAnkle - phi, foot.swingW);
    if (!foot.planted) {
      // Toe clearance: the toe tip stays above the ground. The ball is (F, −H) from the ankle and
      // the toes (length T) hinge up from it by the MTP angle τ, so just after toe-off the bent
      // toes are already clear and the foot is not yanked up. One Newton step on
      // y(p) = h + F·sin p − H·cos p + T·sin(p + τ).
      const ankleW = T.v2.copy(A).addScaledVector(ik.upper, c.a).addScaledVector(ik.lower, c.b);
      const tipD = d.ballFwd + 0.1 * d.L; // ground under the ankle or the toe tip, whichever is higher
      const ankleY = ankleW.y - Math.max(this._floor(ankleW.x, ankleW.z), this._floor(ankleW.x + Math.sin(yaw) * tipD, ankleW.z + Math.cos(yaw) * tipD)) - d.groundY;
      const F = d.ballFwd, H = d.ankleH, Tl = 0.1 * d.L, tau = foot.toe.x;
      const y = ankleY + F * Math.sin(pitch) - H * Math.cos(pitch) + Tl * Math.sin(pitch + tau);
      const dy = F * Math.cos(pitch) + H * Math.sin(pitch) + Tl * Math.cos(pitch + tau);
      const need = 0.01 * d.L * smoothstep(0, 0.3, foot.swing ? foot.swing.t : 1);
      if (dy > 0.2 * F) pitch += softRamp((need - y) / dy, 6 * DEG);
    }
    // Rearfoot roll (subtalar inversion +, eversion −), lagged slightly so no event snaps it.
    foot.inv = (foot.inv ?? 0) + (this._footInversion(foot) - (foot.inv ?? 0)) * Math.min(1, (this._poseDt || 1 / 60) * 25);
    const terrainRoll = foot.planted && !foot.swing ? foot.crossSlope || 0 : 0;
    const footR = quatYawRollPitch(yaw - this.heading, terrainRoll - foot.sign * foot.inv, -pitch, T.q0);
    const footW = T.q1.copy(this._rootQ).multiply(footR).multiply(foot.flatQ).multiply(this.rest[side + 'Foot'].charQ);
    this.bones[side + 'Foot'].quaternion.copy(T.q2.copy(lowerW).invert()).multiply(footW);

    // Toes stay on the ground during heel-off (MTP dorsiflexion).
    const toeKey = side + 'ToeBase';
    if (this.bones[toeKey]) {
      const toeAng = foot.toe.x;
      this._setCharRotation(toeKey, T.q2.setFromAxisAngle(AXIS_X, -toeAng));
    }
  }

  /**
   * Rearfoot inversion over the gait cycle (Perry & Burnfield 2010): the heel lands on its outer
   * edge (inverted ≈ 4°), rolls in under load (eversion, pronation, peaking ≈ 35 % into stance),
   * comes back through neutral, and re-inverts as the heel rises and push-off rolls over the big
   * toe. Running everts further; a sprinter's forefoot strike lands near neutral.
   */
  _footInversion(foot) {
    const g = this.gait, w = g.locoW;
    if (w < 0.001) return 0;
    const rb = g.rb, ev = mix(4.5, 7, rb), inv0 = mix(4, 2, rb) * (1 - (g.sprint ?? 0)), push = mix(6, 8, rb);
    let a = 0;
    if (foot.planted && foot.gaitStance) {
      const s = this._stanceS(foot);
      a = s < 0.35 ? mix(inv0, -ev, smootherstep(0, 0.35, s))
        : s < 0.7 ? mix(-ev, 0, smootherstep(0.35, 0.7, s))
        : mix(0, push, smootherstep(0.7, 1, s));
    } else if (foot.swing?.kind === 'gait') {
      const t = foot.swing.t;
      a = t < 0.5 ? mix(push, 1, smootherstep(0, 0.5, t)) : mix(1, inv0, smootherstep(0.5, 1, t));
    }
    return a * DEG * w;
  }

  _solveGuardArms(fkLocal, gw) {
    const T = this._t, d = this.dims, sc = d.L / 0.888;
    const head = this.bones.Head.getWorldPosition(new THREE.Vector3());
    const ad = this.drives.arm.s.x, sd = this.drives.shoulder.s.x;
    const toWorldDir = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(this._rootQ);
    const toWorldOff = (x, y, z) => toWorldDir(x * sc, y * sc, z * sc).add(head);

    for (const s of ['L', 'R']) {
      const side = s === 'L' ? 'Left' : 'Right';
      const c = this.chains['arm' + s];
      const shoulder = this.bones[c.up].getWorldPosition(new THREE.Vector3());
      let target, pole, palm;
      if (s === 'L') {
        // Lead hand: eye-to-chin height in front of the face; retracts to the chin during the cross.
        target = toWorldOff(0.08 - 0.02 * sd, -0.03 + 0.02 * sd, 0.3 - 0.12 * sd);
        pole = toWorldDir(0.35, -1, -0.25);
        palm = toWorldDir(-0.75, -0.35, 0);
      } else {
        const guardT = toWorldOff(-0.11, -0.06, 0.16);
        // Strike line: from the (moving) rear shoulder toward the chin-height target point,
        // reach limited to 97.5% so the elbow never locks.
        const aim = toWorldOff(0, -0.03, 2.0);
        const dir = aim.sub(shoulder).normalize();
        const strikeT = shoulder.clone().addScaledVector(dir, d.armLen * 0.975);
        target = guardT.clone().add(strikeT.sub(guardT).multiplyScalar(ad));
        pole = toWorldDir(mix(-0.4, -0.55, ad), -1, mix(-0.25, 0.05, ad));
        // Corkscrew: vertical fist in guard → pronated (palm down) at impact.
        const pr = clamp(ad, 0, 1);
        palm = toWorldDir(mix(0.75, 0.15, pr), mix(-0.35, -1, pr), 0);
      }
      this._armIK(s, shoulder, target, pole.normalize(), palm, gw, fkLocal);
    }
  }

  /** Hands resting on the thighs just above the knees, elbows out (bent over, getting her breath back). */
  _solveRestArms(fkLocal, w) {
    const d = this.dims, b = this.bones, V = () => new THREE.Vector3();
    for (const s of ['L', 'R']) {
      const side = s === 'L' ? 'Left' : 'Right', sign = s === 'L' ? 1 : -1, c = this.chains['arm' + s];
      const hipJ = b[side + 'UpLeg'].getWorldPosition(V()), knee = b[side + 'Leg'].getWorldPosition(V());
      const tdir = knee.clone().sub(hipJ).normalize();
      const top = UP.clone().addScaledVector(tdir, -tdir.y).normalize(); // the thigh's upper surface
      const lat = V().set(sign, 0, 0).applyQuaternion(this._rootQ);
      const target = knee.addScaledVector(tdir, -0.2 * d.thigh).addScaledVector(top, 0.07 * d.L).addScaledVector(lat, 0.015 * d.L);
      const pole = lat.multiplyScalar(0.8).addScaledVector(this._fwd, -0.5).addScaledVector(UP, -0.2).normalize();
      const palm = top.negate().addScaledVector(lat, -0.25).normalize();
      this._armIK(s, b[c.up].getWorldPosition(V()), target, pole, palm, w, fkLocal);
    }
  }

  /** The held hand reaches toward the hold point (clamped to the arm's reach), palm down and in. */
  _solveLeadArm(fkLocal, w) {
    const d = this.dims, s = this.leadSide, sign = s === 'L' ? 1 : -1, c = this.chains['arm' + s];
    let sh = this.bones[c.up].getWorldPosition(new THREE.Vector3());
    // Out of the arm's reach (the skater's hand on the floor from a shoulder still 0.8 m up), the
    // trunk bends toward it, about the base of the spine, by what the arm lacks (up to 55°), shared
    // over the three spine bones; eased so the shoulder drops into it instead of snapping.
    {
      const P = this.bones.Spine.getWorldPosition(new THREE.Vector3());
      const a = sh.clone().sub(P), b = this.leadPoint.clone().sub(P);
      const axis = new THREE.Vector3().crossVectors(a, b), reach = d.armLen * 0.96;
      let want = 0;
      if (axis.lengthSq() > 1e-10) axis.normalize();
      if (axis.lengthSq() > 0.5 && sh.distanceTo(this.leadPoint) > reach) {
        const q = new THREE.Quaternion(), r = new THREE.Vector3();
        let lo = 0, hi = Math.min(a.angleTo(b), 55 * DEG);
        for (let i = 0; i < 12; i++) {
          const m = (lo + hi) / 2;
          if (r.copy(a).applyQuaternion(q.setFromAxisAngle(axis, m)).distanceTo(b) > reach) lo = m; else hi = m;
        }
        want = hi * w;
      }
      const cur = this.leadBend ?? 0;
      this.leadBend = cur + (want - cur) * (1 - Math.exp(-12 * (this.leadDt ?? 1 / 60)));
      if (this.leadBend > 1e-3 && axis.lengthSq() > 0.5) {
        const R = new THREE.Quaternion().setFromAxisAngle(axis, this.leadBend / 3), Pq = new THREE.Quaternion();
        for (const k of ['Spine', 'Spine1', 'Spine2']) {
          const bone = this.bones[k];
          bone.parent.getWorldQuaternion(Pq);
          bone.quaternion.premultiply(Pq.clone().invert().multiply(R).multiply(Pq));
          bone.updateMatrixWorld(true);
        }
        sh = this.bones[c.up].getWorldPosition(sh);
      }
    }
    const to = this.leadPoint.clone().sub(sh);
    if (to.length() > d.armLen * 0.985) to.setLength(d.armLen * 0.985);
    const lat = new THREE.Vector3(sign, 0, 0).applyQuaternion(this._rootQ);
    const pole = lat.clone().multiplyScalar(0.5).addScaledVector(UP, -1).normalize();
    const palm = UP.clone().negate().addScaledVector(lat, -0.5).normalize();
    this._armIK(s, sh, sh.clone().add(to), pole, palm, w, fkLocal);
  }

  /** Flinch: forearms up in front of the face, palms out, a little toward the side it comes from. */
  _solveFlinchArms(fkLocal, w) {
    const d = this.dims, b = this.bones, V = () => new THREE.Vector3();
    const head = b.Head.getWorldPosition(V());
    const dir = (x, y, z) => V().set(x, y, z).applyQuaternion(this._rootQ);
    for (const s of ['L', 'R']) {
      const sign = s === 'L' ? 1 : -1, c = this.chains['arm' + s];
      const toward = this.flinchSide === sign ? 0.06 : 0; // the near hand reaches further out
      const target = head.clone().add(dir((sign * 0.09 + this.flinchSide * 0.05) * d.L, -0.02 * d.L, (0.24 + toward) * d.L));
      this._armIK(s, b[c.up].getWorldPosition(V()), target, dir(sign * 0.6, -1, -0.2).normalize(), dir(this.flinchSide * 0.3, 0.1, 1).normalize(), w, fkLocal);
    }
  }

  /** Two-bone arm IK to a target with the palm facing `palm`, blended over the FK pose by w. */
  _armIK(s, shoulder, target, pole, palm, w, fkLocal) {
    const T = this._t;
    const side = s === 'L' ? 'Left' : 'Right';
    const c = this.chains['arm' + s];
    {
      const ik = this._twoBone(shoulder, target, pole, c.a, c.b, 0.9995, this._ikOut());
      const upperW = T.q4, lowerW = T.q5;
      this._applyChain(c, ik, upperW, lowerW);

      // Hand orientation from forearm axis + palm normal; 55% of the twist goes to the forearm.
      const axisC = T.v1.copy(ik.lower).applyQuaternion(this._rootQInv);
      const palmC = T.v2.copy(palm).applyQuaternion(this._rootQInv);
      const handR = frameQuat(axisC, palmC, T.q0).multiply(c.restHandInv);
      const handW = T.q1.copy(this._rootQ).multiply(handR).multiply(this.rest[side + 'Hand'].charQ);
      // Current forearm "palm" direction: rest palm carried by the forearm's world rotation.
      const palmNow = T.v3.copy(c.palm0).applyQuaternion(T.q2.copy(this.rest[c.mid].charQ).invert()).applyQuaternion(lowerW);
      const ax = ik.lower;
      const pd = T.v5.copy(palm).addScaledVector(ax, -palm.dot(ax)).normalize();
      palmNow.addScaledVector(ax, -palmNow.dot(ax)).normalize();
      const twist = Math.atan2(T.v6.crossVectors(palmNow, pd).dot(ax), clamp(palmNow.dot(pd), -1, 1));
      lowerW.premultiply(T.q2.setFromAxisAngle(ax, twist * 0.55));
      const mid = this.bones[c.mid];
      mid.quaternion.copy(T.q3.copy(upperW).invert()).multiply(lowerW);
      const ikHand = T.q3.copy(lowerW).invert().multiply(handW);

      // Blend IK over FK in local space.
      const bones = [this.bones[c.up], mid, this.bones[side + 'Hand']];
      const ikLocal = [bones[0].quaternion.clone(), bones[1].quaternion.clone(), ikHand.clone()];
      for (let i = 0; i < 3; i++) bones[i].quaternion.copy(fkLocal[s][i]).slerp(ikLocal[i], w);
    }
  }

  // -------------------------------------------------------------------------
  // Self-collision (capsules fitted to the skinned mesh)
  // -------------------------------------------------------------------------
  /**
   * One capsule per body segment, in bone-local space. Radii come from the skinned mesh
   * (60th percentile distance of the vertices each bone dominates); rigs without skinned
   * geometry fall back to anthropometric proportions of the leg length.
   */
  _fitCapsules() {
    const d = this.dims, L = d.L;
    this.model.updateMatrixWorld(true);
    const W = (key) => this.bones[key] && this.bones[key].getWorldPosition(new THREE.Vector3());
    const childW = (key, name) => {
      const b = this.bones[key];
      const c = b && b.children.find((o) => (o.isBone || o.type === 'Bone') && canonicalBoneName(o.name) === name);
      return c ? c.getWorldPosition(new THREE.Vector3()) : null;
    };
    const charDir = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(this._rootQ);
    const spec = [];
    const add = (key, a, b, r, trim = 0) => { if (a && b) spec.push({ key, wa: a, wb: b, fallback: r * L, trim }); };
    add('Hips', W('Hips'), W('Spine'), 0.16);
    add('Spine', W('Spine'), W('Spine1'), 0.135);
    add('Spine1', W('Spine1'), W('Spine2'), 0.13);
    add('Spine2', W('Spine2'), W('Neck'), 0.12);
    const head = W('Head');
    add('Head', head, childW('Head', 'HeadTop_End') || head.clone().addScaledVector(charDir(0, 1, 0), 0.2 * L), 0.11);
    for (const S of ['Left', 'Right']) {
      // Thighs start a quarter of the way down: at the crotch the skin blends into the pelvis.
      add(S + 'UpLeg', W(S + 'UpLeg'), W(S + 'Leg'), 0.088, 0.25);
      add(S + 'Leg', W(S + 'Leg'), W(S + 'Foot'), 0.069);
      if (this.bones[S + 'ToeBase']) {
        add(S + 'Foot', W(S + 'Foot'), W(S + 'ToeBase'), 0.043);
        const toe = W(S + 'ToeBase');
        add(S + 'ToeBase', toe, childW(S + 'ToeBase', S + 'Toe_End') || toe.clone().addScaledVector(charDir(0, 0, 1), 0.1 * L), 0.05);
      }
      add(S + 'Arm', W(S + 'Arm'), W(S + 'ForeArm'), 0.055);
      add(S + 'ForeArm', W(S + 'ForeArm'), W(S + 'Hand'), 0.045);
      const hand = W(S + 'Hand'), mid = W(S + 'HandMiddle1');
      add(S + 'Hand', hand, mid ? mid.clone().sub(hand).multiplyScalar(2).add(hand)
        : hand.clone().sub(W(S + 'ForeArm')).setLength(0.2 * L).add(hand), 0.034);
      // Fingertips and thumb tip ride on their own bones: curled, they fold out of the hand capsule.
      for (const f of ['Thumb', 'Index', 'Pinky']) {
        const k = `${S}Hand${f}3`;
        if (this.bones[k]) add(k, W(k), childW(k, `${S}Hand${f}4`) || W(k).clone().sub(W(`${S}Hand${f}2`)).add(W(k)), 0.011);
      }
    }

    // Vertices dominated (weight ≥ 0.6) by each capsule's bone, in bind pose.
    const samples = {};
    const boneKey = new Map(Object.entries(this.bones).map(([k, b]) => [b, k]));
    const v = new THREE.Vector3();
    this.model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      const g = o.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!si || !sw) return;
      const n = g.attributes.position.count, step = Math.max(1, Math.floor(n / 6000));
      for (let i = 0; i < n; i += step) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        if (bw < 0.6) continue;
        const key = boneKey.get(o.skeleton.bones[best]);
        if (!key) continue;
        o.getVertexPosition(i, v);
        (samples[key] ||= []).push(v.clone().applyMatrix4(o.matrixWorld));
      }
    });

    this.caps = {};
    const ca = new THREE.Vector3(), cb = new THREE.Vector3();
    for (const c of spec) {
      let r = c.fallback, rOuter = c.fallback * 1.15;
      const pts = samples[c.key];
      if (pts && pts.length >= 30) {
        const ds = pts.map((p) => closestSegments(p, p, c.wa, c.wb, ca, cb)).sort((x, y) => x - y);
        r = ds[Math.floor(ds.length * 0.6)];
        rOuter = ds[Math.floor(ds.length * 0.8)];
      }
      // A very heavy build (the Hulk) keeps the legs' own collision to ordinary proportions: fitted
      // to his thighs, the capsules would shove the feet apart on every step and turn.
      const cap = this.style.legCapsule;
      if (cap && /(UpLeg|Leg)$/.test(c.key)) r = Math.min(r, (c.key.endsWith('UpLeg') ? cap[0] : cap[1]) * L);
      const bone = this.bones[c.key];
      if (c.trim) {
        // The untrimmed thigh covers the outer hip and upper thigh, where the hands pass; arms
        // collide with it, while leg-vs-leg checks use the trimmed part (the crotch blends in).
        // Sized a little beyond the median skin (the hip flesh at the top is the flank capsules' job).
        this.caps[c.key + 'Full'] = {
          bone, r: rOuter + 0.008 * L,
          a: bone.worldToLocal(c.wa.clone()), b: bone.worldToLocal(c.wb.clone()),
          wa: new THREE.Vector3(), wb: new THREE.Vector3(),
        };
        c.wa.lerp(c.wb, c.trim); // radius fitted on the full bone, collision on the trimmed part
      }
      this.caps[c.key] = {
        bone, r,
        a: bone.worldToLocal(c.wa.clone()), b: bone.worldToLocal(c.wb.clone()),
        wa: new THREE.Vector3(), wb: new THREE.Vector3(),
      };
    }

    // Upper thighs (arms only): the thigh is a cone, much thicker at the top (more so on the
    // feminized figure), so the upper half gets its own, thicker capsule that swings with it.
    for (const S of ['Left', 'Right']) {
      const J = W(S + 'UpLeg'), K = W(S + 'Leg'), bone = this.bones[S + 'UpLeg'];
      if (!J || !K) continue;
      const axis = K.clone().sub(J), len = axis.length();
      axis.divideScalar(len);
      const wa = J.clone(), wb = J.clone().addScaledVector(axis, 0.45 * len);
      const pts = (samples[S + 'UpLeg'] || []).filter((p) => {
        const t = this._t.v1.copy(p).sub(J).dot(axis) / len;
        return t >= 0.05 && t <= 0.5;
      });
      let r = 0.1 * L;
      if (pts.length >= 30) {
        const ds = pts.map((p) => closestSegments(p, p, wa, wb, ca, cb)).sort((x, y) => x - y);
        r = ds[Math.floor(ds.length * 0.95)];
      }
      this.caps[S + 'UpLegTop'] = {
        bone, r: r + 0.006 * L,
        a: bone.worldToLocal(wa.clone()), b: bone.worldToLocal(wb.clone()),
        wa: new THREE.Vector3(), wb: new THREE.Vector3(),
      };
    }

    // Waist (arms only): the pelvis capsule is fitted to the hip flesh but reaches up into the
    // (narrow) waist, where the elbows and forearms pass; the flanks already cover the hips.
    if (this.caps.Hips) {
      const h = this.caps.Hips;
      this.caps.Waist = { bone: h.bone, r: Math.min(h.r, this.caps.Spine?.r ?? h.r), a: h.a.clone(), b: h.b.clone(), wa: new THREE.Vector3(), wb: new THREE.Vector3() };
    }

    // Hip flanks (arms only): with linear-blend skinning the outer and rear flesh of the upper
    // thigh stays largely with the pelvis when the thigh swings, so a thigh capsule alone leaves
    // it uncovered right where the hands pass. One vertical capsule per side rides on the pelvis.
    const hips = this.bones.Hips, up = charDir(0, 1, 0);
    for (const S of ['Left', 'Right']) {
      const J = W(S + 'UpLeg');
      if (!J) continue;
      const wa = J.clone().addScaledVector(up, 0.04 * L), wb = J.clone().addScaledVector(up, -0.2 * L);
      const side = this._t.v0.copy(J).sub(W('Hips'));
      const pts = [...(samples[S + 'UpLeg'] || []), ...(samples.Hips || [])].filter((p) => {
        const h = this._t.v1.copy(p).sub(wb).dot(up);
        return h >= 0 && h <= 0.24 * L && this._t.v1.copy(p).sub(W('Hips')).dot(side) > 0.3 * side.lengthSq();
      });
      let r = 0.1 * L;
      if (pts.length >= 30) {
        // Radius = how far the flesh reaches sideways (where the hands pass); the glutes behind
        // would otherwise inflate it and hold the arms out.
        const lat = this._t.v2.copy(side).addScaledVector(up, -side.dot(up)).normalize();
        const ds = pts.map((p) => this._t.v1.copy(p).sub(J).dot(lat)).filter((x) => x > 0).sort((x, y) => x - y);
        if (ds.length >= 30) r = ds[Math.floor(ds.length * 0.95)];
      }
      // Sit the rounded top at hip-joint height: the waist above is narrow and must stay free for
      // the forearms on the back swing.
      wa.copy(J).addScaledVector(up, Math.min(0.04 * L, 0.06 * L - r));
      if (wa.distanceTo(wb) < 0.05 * L) wa.copy(wb).addScaledVector(up, 0.05 * L);
      this.caps[S + 'Flank'] = {
        bone: hips, r: r + 0.008 * L,
        a: hips.worldToLocal(wa.clone()), b: hips.worldToLocal(wb.clone()),
        wa: new THREE.Vector3(), wb: new THREE.Vector3(),
      };
    }
  }

  _cap(key) {
    const c = this.caps[key];
    if (!c) return null;
    c.wa.copy(c.a).applyMatrix4(c.bone.matrixWorld);
    c.wb.copy(c.b).applyMatrix4(c.bone.matrixWorld);
    return c;
  }

  /** Signed overlap (r_a + r_b − distance, negative when apart) of the closest pair from lists A and B. */
  _overlap(keysA, keysB) {
    let best = -Infinity;
    for (const ka of keysA) {
      const a = this._cap(ka);
      if (!a) continue;
      for (const kb of keysB) {
        const b = this._cap(kb);
        if (!b) continue;
        best = Math.max(best, a.r + b.r - closestSegments(a.wa, a.wb, b.wa, b.wb, _cp1, _cp2));
      }
    }
    return best;
  }

  /** Deepest penetration between capsule lists A and B; contact points/normal (B → A) in `hit`. */
  _deepest(keysA, keysB, hit) {
    hit.pen = 0;
    for (const ka of keysA) {
      const a = this._cap(ka);
      if (!a) continue;
      for (const kb of keysB) {
        const b = this._cap(kb);
        if (!b) continue;
        const dist = closestSegments(a.wa, a.wb, b.wa, b.wb, _cp1, _cp2);
        const pen = a.r + b.r - dist;
        if (pen > hit.pen) {
          hit.pen = pen;
          hit.key = ka;
          hit.pa.copy(_cp1);
          hit.n.subVectors(_cp1, _cp2);
          if (hit.n.lengthSq() < 1e-10) hit.n.set(0, 0, 0);
          else hit.n.normalize();
        }
      }
    }
    return hit;
  }

  /**
   * Post-pose safety net (the planner already keeps feet and swings apart): a swinging leg is
   * pushed around the other leg by moving its IK target, and arms are rotated at the shoulder
   * away from the torso, legs, head and the other arm. Corrections are functions of the current
   * pose only, so they are as continuous as the motion itself.
   */
  _resolveCollisions() {
    const T = this._t, L = this.dims.L;
    const hit = this._hit || (this._hit = { pen: 0, key: '', pa: new THREE.Vector3(), n: new THREE.Vector3() });
    // Thighs are allowed to brush (soft tissue, and normal for a female figure); knees, shins and
    // feet are what steer a swing leg around the other one.
    const legs = { L: ['LeftLeg', 'LeftFoot', 'LeftToeBase'], R: ['RightLeg', 'RightFoot', 'RightToeBase'] };
    this.bones.Hips.updateMatrixWorld(true); // legs/arms were just re-posed by IK

    // ---- Legs: a swinging leg steers around the other one ----
    // The depth (scaled by the contact's lever along the leg) feeds a lateral push that the swing
    // path applies through a spring and fades out at lift-off and touchdown, so feet never jump.
    // The shin capsule's radius is fitted to the calf; where the legs actually pass (low shin,
    // ankle) they are much slimmer, so leg-vs-leg checks use a tapered radius.
    const shins = [this.caps.LeftLeg, this.caps.RightLeg].filter(Boolean);
    for (const c of shins) { c.rFull ??= c.r; c.r = c.rFull * 0.72; }
    for (const s of ['L', 'R']) {
      const foot = this.feet[s];
      if (!foot.swing) continue;
      this._deepest(legs[s], legs[s === 'L' ? 'R' : 'L'], hit);
      if (hit.pen <= 0) continue;
      const hipP = this.bones[s === 'L' ? 'LeftUpLeg' : 'RightUpLeg'].getWorldPosition(T.v6);
      const lever = clamp(hipP.distanceTo(hit.pa) / Math.max(hipP.distanceTo(foot.ankle), 1e-3), 0.35, 1);
      foot.colTarget = Math.min(foot.colTarget + (hit.pen + 0.004 * L) / lever, 0.25 * L);
    }
    for (const c of shins) c.r = c.rFull;

    // ---- Arms ----
    const body = ['Waist', 'LeftFlank', 'RightFlank', 'Spine', 'Spine1', 'Spine2', 'Head', 'LeftUpLegTop', 'RightUpLegTop', 'LeftUpLegFull', 'RightUpLegFull', 'LeftLeg', 'RightLeg'];
    const lower = ['Waist', 'LeftFlank', 'RightFlank', 'LeftUpLegTop', 'RightUpLegTop', 'LeftUpLegFull', 'RightUpLegFull'];
    const striking = this.drives.arm.s.x > 0.02;
    const fwdW = this._abdAxis || (this._abdAxis = new THREE.Vector3());
    fwdW.set(0, 0, 1).applyQuaternion(this._rootQ);
    for (const S of ['Left', 'Right']) {
      const arm = this.bones[S + 'Arm'];
      // Curled fingers fold toward the palm, out of the straight hand capsule: thicken it.
      const hc = this.caps[S + 'Hand'];
      if (hc) {
        hc.r0 ??= hc.r;
        hc.r = hc.r0 + 0.03 * L * clamp(this.fingerCurl.x + 0.45 * this._fid('hand', S[0]), 0, 1);
      }
      // (The thumb may brush the hip: as the first thing to touch it, it pushed the whole arm out.)
      const own = [S + 'ForeArm', S + 'Hand', S + 'HandIndex3', S + 'HandPinky3'];
      const otherArm = S === 'Left' ? ['RightArm', 'RightForeArm', 'RightHand'] : ['LeftArm', 'LeftForeArm', 'LeftHand'];

      // Body contacts: the arm swings out sideways (about the shoulder's forward axis) by the
      // smallest angle that clears the body, found by bisection. That angle varies continuously
      // with the pose, unlike pushing away from whichever contact happens to be deepest (which
      // flips between hip, thigh and fingertips and makes the arm jitter). It rises as needed
      // and eases back down on a spring.
      const sign = S === 'Left' ? 1 : -1;
      const parentQ = arm.parent.getWorldQuaternion(T.q5);
      const parentInv = T.q2.copy(parentQ).invert();
      const worldQ0 = T.q3.copy(parentQ).multiply(arm.quaternion);
      const margin = 0.013 * L;
      // Signed clearance deficit at a given abduction (> 0: closer than the margin, or inside).
      const penAt = (theta) => {
        T.q4.setFromAxisAngle(fwdW, sign * theta).multiply(worldQ0);
        arm.quaternion.copy(parentInv).multiply(T.q4);
        arm.updateMatrixWorld(true);
        return Math.max(this._overlap(own, body), this._overlap([S + 'Arm'], lower)) + margin;
      };
      let need = 0;
      let pLo = penAt(0);
      if (pLo > 0) {
        let lo = 0, hi = 40 * DEG, pHi = penAt(hi);
        if (pHi > 0) need = hi;
        else {
          for (let i = 0; i < 6; i++) {
            const mid = 0.5 * (lo + hi), pm = penAt(mid);
            if (pm > 0) { lo = mid; pLo = pm; } else { hi = mid; pHi = pm; }
          }
          // Interpolate the zero crossing so the angle is continuous, not quantised to the bisection.
          need = lo + (hi - lo) * pLo / Math.max(pLo - pHi, 1e-9);
        }
      }
      need *= 1 - 0.9 * this.recoverW.x; // hands on the knees are meant to touch the thighs
      const abd = this.armAbd[S[0]];
      // Eased in quickly (a spring, so contacts never kink the arm's path) and back fairly soon (the
      // arm returns to its line after passing the hip rather than staying out); the
      // ~1 cm clearance margin absorbs the short lag on the way in.
      abd.omega = need > abd.x ? 55 : 18;
      abd.step(need, this._poseDt);
      T.q4.setFromAxisAngle(fwdW, sign * abd.x).multiply(worldQ0);
      arm.quaternion.copy(parentInv).multiply(T.q4);
      arm.updateMatrixWorld(true);

      // Arm vs arm (guard / strike): the lead (left) arm yields to a striking rear arm; otherwise each takes half.
      if (S === 'Left' || !striking) {
        for (let i = 0; i < 3; i++) {
          this._deepest([S + 'Arm', ...own], otherArm, hit);
          const pen = hit.pen * (striking ? 1 : 0.5);
          if (pen <= 0 || hit.n.lengthSq() < 0.5) break;
          const sh = arm.getWorldPosition(T.v5);
          const r = T.v4.subVectors(hit.pa, sh);
          const axis = T.v3.crossVectors(r, hit.n);
          const rl = r.length();
          if (axis.lengthSq() < 1e-10 || rl < 1e-4) break;
          axis.normalize();
          const wq = arm.getWorldQuaternion(T.q3).premultiply(T.q4.setFromAxisAngle(axis, Math.atan2(pen + margin, rl)));
          arm.quaternion.copy(arm.parent.getWorldQuaternion(T.q5).invert().multiply(wq));
          arm.updateMatrixWorld(true);
        }
      }
    }
  }
}

export default ProceduralHumanoidAnimator;
