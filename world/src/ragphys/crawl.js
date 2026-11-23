// Crawling: on hands and knees, and the army crawl (prone, on the forearms).
//
// A layer over the standing animator. While she is down it owns the whole skeleton: each frame a
// posture "spec" (world-space contact points, girdle angles, gaze) is built from the crawl gait or
// from a transition's keyframes, and solved onto the bones (pelvis + distributed spine, head toward
// the gaze, two-bone IK for arms and legs with poles toward the wanted elbow / knee points).
//
// Getting down starts from a snapshot of her actual standing pose, so nothing pops: stop, sink into
// a squat with the heels rising, knees to the floor (toes tucked), lean onto the hands, and roll the
// feet onto their tops. Getting up runs the same way back, ending on the standing animator's own
// live pose, which was re-planted under the kneeling feet when the get-up began.
//
// Hands and knees (adults crawl mostly trot-like: diagonal pairs move nearly together, the hand
// leading its knee by ~10 % of the cycle). Duty ≈ 0.68, ~1 Hz at 0.5 m/s. Contacts stay put in
// the world through stance; swings land a half stance-length ahead of their body-relative spot.
// Hip and shoulder heights follow from the planted knees and hands; the girdles yaw with the limbs
// (the advancing knee carries its hip forward) and roll toward the side that is unloaded.
//
// Army crawl: chest low, the forearms pull (elbows planted in turn) while the opposite knee is drawn
// up to the side and pushes as it straightens back (frog-leg, inner foot edge on the floor). The
// body surges with each pull; the pelvis rolls up on the drawn-up side; the head stays up, eyes low.
import * as THREE from 'three';
import { Spring, mix, clamp, smoothstep, smootherstep, wrap01, quatYawRollPitch, mirrorQuat, frameQuat } from './ProceduralHumanoidAnimator.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const V = () => new THREE.Vector3();
const SIDES = ['L', 'R'];
const THUMB_FLAT = new THREE.Euler(0, -10 * Math.PI / 180, 20 * Math.PI / 180, 'XYZ');
const SIGN = { L: 1, R: -1 };
const NAME = { L: 'Left', R: 'Right' };
const LOW = new Set(['army', 'toArmy', 'back', 'toBack', 'fromBack', 'lie', 'toLie', 'fromLie', 'ragdoll', 'fromRagdoll']);
const SEATED = new Set(['sit', 'sitDown', 'sitUp']);
const HK_LIVE = new Set(['down', 'up', 'toArmy', 'fromArmy']);
const ARMY_LIVE = new Set(['toArmy', 'fromArmy', 'toBack', 'fromBack', 'fromRagdoll']);

// Hands and knees: diagonal pairs, hand leading its knee.
const HK = { off: { hL: 0, kR: 0.1, hR: 0.5, kL: 0.6 }, stop: [[0.11, 0.17], [0.61, 0.67]] };
// Army: the left elbow pulls with the right knee's push, and vice versa.
const ARMY = { duty: 0.55, off: { eL: 0, kR: 0, eR: 0.5, kL: 0.5 }, stop: [[0.005, 0.045], [0.505, 0.545]] };

function mkSpec() {
  const pair = () => ({ L: V(), R: V() });
  return {
    hip: V(), sh: V(), pYaw: 0, pRoll: 0, cYaw: 0, cRoll: 0, lord: 0, gazePitch: 0, gazeYaw: 0, rollAll: 0,
    knee: pair(), ankle: pair(), footF: pair(), footU: pair(), toe: { L: 0, R: 0 },
    hand: pair(), elbow: pair(), handF: pair(), handN: pair(),
    flat: 0, clav: 0, clavElev: 0, clavProt: 0,
  };
}
function copySpec(a, out) { return lerpSpec(a, a, 0, out); }
function lerpSpec(a, b, t, out) {
  for (const k of SCAL) out[k] = mix(a[k], b[k], t);
  out.hip.lerpVectors(a.hip, b.hip, t);
  out.sh.lerpVectors(a.sh, b.sh, t);
  for (const k of ['knee', 'ankle', 'hand', 'elbow']) for (const sd of SIDES) out[k][sd].lerpVectors(a[k][sd], b[k][sd], t);
  for (const k of ['footF', 'footU', 'handF', 'handN']) for (const sd of SIDES) {
    out[k][sd].lerpVectors(a[k][sd], b[k][sd], t);
    if (out[k][sd].lengthSq() < 1e-6) out[k][sd].copy(b[k][sd]);
    out[k][sd].normalize();
  }
  for (const sd of SIDES) out.toe[sd] = mix(a.toe[sd], b.toe[sd], t);
  return out;
}

// rollAll: the whole trunk (and head) turned about the hip → shoulder line (rolling onto the side / back).
const SCAL = ['pYaw', 'pRoll', 'cYaw', 'cRoll', 'lord', 'gazePitch', 'gazeYaw', 'flat', 'clav', 'clavElev', 'clavProt', 'rollAll'];
const VECS = ['knee', 'ankle', 'footF', 'footU', 'hand', 'elbow', 'handF', 'handN'];
const SPEC_N = SCAL.length + 6 + VECS.length * 6 + 2;
const GAZE_I = SCAL.indexOf('gazePitch');
const UNIT = new Set(['footF', 'footU', 'handF', 'handN']);
function specToArr(sp, a) {
  let i = 0;
  for (const k of SCAL) a[i++] = sp[k];
  for (const v of [sp.hip, sp.sh]) { a[i++] = v.x; a[i++] = v.y; a[i++] = v.z; }
  for (const k of VECS) for (const sd of SIDES) { const v = sp[k][sd]; a[i++] = v.x; a[i++] = v.y; a[i++] = v.z; }
  a[i++] = sp.toe.L; a[i++] = sp.toe.R;
  return a;
}
function arrToSpec(a, sp) {
  let i = 0;
  for (const k of SCAL) sp[k] = a[i++];
  for (const v of [sp.hip, sp.sh]) { v.set(a[i], a[i + 1], a[i + 2]); i += 3; }
  for (const k of VECS) for (const sd of SIDES) {
    const v = sp[k][sd].set(a[i], a[i + 1], a[i + 2]); i += 3;
    if (UNIT.has(k)) v.normalize();
  }
  sp.toe.L = a[i++]; sp.toe.R = a[i++];
  return sp;
}
/**
 * Monotone cubic (Fritsch–Carlson / PCHIP) through keyframes at non-uniform times, components
 * [i0, i1): smooth flow through the keys, no overshoot, and a value held between two keys stays put.
 */
function pchip(keys, arrs, t, out, i0, i1) {
  const n = keys.length;
  let j = 0;
  while (j < n - 2 && t >= keys[j + 1].t) j++;
  const t0 = keys[j].t, t1 = keys[j + 1].t, h = t1 - t0;
  const u = clamp((t - t0) / h, 0, 1);
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const slope = (k, c) => {
    if (k <= 0 || k >= n - 1) return 0;
    const ha = keys[k].t - keys[k - 1].t, hb = keys[k + 1].t - keys[k].t;
    const da = (arrs[k][c] - arrs[k - 1][c]) / ha, db = (arrs[k + 1][c] - arrs[k][c]) / hb;
    if (da * db <= 0) return 0;
    const w1 = 2 * hb + ha, w2 = hb + 2 * ha;
    return (w1 + w2) / (w1 / da + w2 / db);
  };
  for (let c = i0; c < i1; c++) {
    const p0 = arrs[j][c], p1 = arrs[j + 1][c];
    out[c] = h00 * p0 + h10 * h * slope(j, c) + h01 * p1 + h11 * h * slope(j + 1, c);
  }
}

export class Crawl {
  constructor(an) {
    this.an = an;
    const d = an.dims, R = an.rest, ch = an.chains;
    this.sc = d.L / 0.888;
    this.thigh = ch.legL.a; this.shin = ch.legL.b;
    this.upperArm = ch.armL.a; this.foreArm = ch.armL.b;
    const hipMid = R.LeftUpLeg.charPos.clone().add(R.RightUpLeg.charPos).multiplyScalar(0.5);
    const shMid = R.LeftArm.charPos.clone().add(R.RightArm.charPos).multiplyScalar(0.5);
    this.Ls = hipMid.distanceTo(shMid);
    this.shX = Math.abs(R.LeftArm.charPos.x - R.RightArm.charPos.x) / 2;
    this.hipX = d.hipHalf;
    this.m0 = hipMid.clone().sub(R.Hips.charPos); // hip-joint midpoint from the Hips bone (rest, char)

    this.goal = 'stand';
    // stand | waitStop | down | hk | toArmy | army | fromArmy | up | toBack | back | fromBack |
    // sitDown | sit | sitUp | toLie | lie | fromLie
    this.state = 'stand';
    this.hold = 0; // after a fall: a moment on the floor before getting up
    this.rollSign = 1;
    this.t = 0;
    this.origin = V(); // body frame: ground point under the hip-joint midpoint
    this.heading = 0;
    this.v = new Spring(3, 1);
    this.yawRate = new Spring(5, 1);
    this.phase = 0;
    this.active = false;
    this.hipH = new Spring(10, 1);
    this.shH = new Spring(10, 1);
    this.armyShH = new Spring(10, 1); // its own spring: the hands-and-knees one keeps running in transitions
    this.camY = new Spring(3, 1, 0.95);
    const limb = () => ({ pos: V(), from: V(), swing: false, s: 0 });
    this.hk = { hL: limb(), hR: limb(), kL: limb(), kR: limb() };
    this.army = { eL: limb(), eR: limb(), thL: 0, thR: 0 };

    this.spec = mkSpec(); this.specA = mkSpec(); this.specB = mkSpec(); this.specC = mkSpec();
    this.snap = mkSpec(); this.stand = mkSpec();
    this.keys = null;
    this._v = Array.from({ length: 12 }, V);
    this._q = Array.from({ length: 8 }, () => new THREE.Quaternion());
    this._m = new THREE.Matrix4();
  }

  /** True while the crawl owns the pose (anything but plain standing). */
  get owns() { return this.state !== 'stand' && this.state !== 'waitStop'; }
  /** True while the standing simulation should be paused (getting up ends on its live pose). */
  get freezesStand() { return this.owns && !this.keys?.liveStand; }

  /**
   * The ragdoll (nm.js) owns her: the crawl does nothing until `fromRagdoll` takes her back.
   */
  toRagdoll() {
    this.keys = null;
    this.state = 'ragdoll';
    this.hold = 0;
  }

  /**
   * Back from the ragdoll lying on the floor: from a snapshot of the physical pose, settle into
   * lying prone (the army crawl's rest) or on the back (lying with the knees up), from where the
   * usual floor transitions get her up. `pelvis`, `toward` (world): the hips and the direction her
   * head lies in.
   */
  fromRagdoll(prone, pelvis, toward) {
    const an = this.an, sc = this.sc;
    this._snapshot(this.snap);
    const dir = toward.clone().setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(an.heading), 0, Math.cos(an.heading));
    dir.normalize();
    // Prone: facing the way the head lies. On the back: lying back with the knees up, so facing the
    // other way (her feet are where she would sit up toward).
    this.heading = Math.atan2(dir.x, dir.z) + (prone ? 0 : Math.PI);
    an.heading = this.heading;
    this._axes();
    this.origin.set(pelvis.x, an.ground ? an.ground(pelvis.x, pelvis.z) : this.origin.y, pelvis.z);
    if (!an.ground) this.origin.y = an.root.position.y;
    this.base = { O: this.origin.clone(), h: this.heading };
    an.root.position.copy(this.origin);
    an.root.quaternion.setFromAxisAngle(UP, this.heading);
    an._updateRootFrame();
    // A requested stand-up should continue directly from the captured fall pose, not pause there.
    this.hold = this.goal === 'stand' ? 0 : 0.6;
    const snap = () => this.snap;
    if (prone) {
      this._initArmy();
      this._seq('fromRagdoll', [{ t: 0, get: snap }, { t: 1.1, get: () => this.specB }], 'army', null);
    } else {
      const F = this._F;
      const ball = { L: this.origin.clone().addScaledVector(F, 0.7 * sc).addScaledVector(this._X, 0.12 * sc), R: this.origin.clone().addScaledVector(F, 0.7 * sc).addScaledVector(this._X, -0.12 * sc) };
      for (const s of SIDES) ball[s].y = this._ground();
      this.sitBall = ball;
      const lie = mkSpec();
      this._seq('fromRagdoll', [{ t: 0, get: snap }, { t: 1.2, get: () => this._lieSpec(lie) }], 'lie', null);
    }
  }

  /** Knocked down: backward into a sit, forward onto hands and knees; she gets up after a moment. */
  fall(kind) {
    if (this.state !== 'stand') return;
    this.state = kind === 'back' ? 'sitDown' : 'down';
    this.t = 0;
    this._needSnap = kind === 'back' ? 'fallBack' : 'fallFwd';
  }

  setGoal(g) {
    this.goal = g;
    if (g !== 'stand' && this.state === 'stand') this.state = 'waitStop';
    if (g === 'stand' && this.state === 'waitStop') this.state = 'stand';
  }

  // ---------------------------------------------------------------------------
  // Body frame helpers
  // ---------------------------------------------------------------------------
  _axes(h = this.heading) {
    this._F ||= V(); this._X ||= V();
    this._F.set(Math.sin(h), 0, Math.cos(h));
    this._X.set(Math.cos(h), 0, -Math.sin(h)); // character +X (her left)
    return this;
  }
  /** World point at body-frame (x left, y up, z forward) from origin O with heading h. */
  _pt(x, y, z, out, O = this.origin, h = this.heading) {
    const sh = Math.sin(h), chh = Math.cos(h);
    return out.set(O.x + chh * x + sh * z, O.y + y, O.z - sh * x + chh * z);
  }
  /** Body-frame coordinates of a world point. */
  _rel(P, out, O = this.origin, h = this.heading) {
    const dx = P.x - O.x, dz = P.z - O.z, sh = Math.sin(h), chh = Math.cos(h);
    return out.set(chh * dx - sh * dz, P.y - O.y, sh * dx + chh * dz);
  }
  _ground() { return this.an._rootPos.y + this.an.dims.groundY; }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  simulate(dt) {
    const an = this.an, st = this.state;
    const camY = LOW.has(st) ? 0.4 : SEATED.has(st) ? 0.62 : this.owns ? 0.55 : 0.95 - 0.22 * an.crouchW.x - 0.15 * an.recoverW.x;
    this.camY.step(camY, dt);
    if (st === 'stand') return;
    if (st === 'waitStop') {
      const f = an.feet;
      // (Getting down starts from the captured pose, so an idle step need not finish; only a gait step
      // still in the air is waited for.)
      const gaitSwing = (s) => s.swing && s.swing.kind !== 'event';
      const settled = an.speed.x < 0.5 && !an.jumpState && an.strikeT < 0 && !gaitSwing(f.L) && !gaitSwing(f.R) && an.guardW.x < 0.4;
      if (settled) {
        const sit = this.goal === 'sit' || this.goal === 'lie';
        this.state = sit ? 'sitDown' : 'down'; this.t = 0; this._needSnap = sit ? 'sit' : 'down';
      }
      return;
    }
    this.t += dt;
    if (st === 'hk' || st === 'army') this._locomote(dt);
    // Transitions end into the next state; a different goal starts the next transition at once.
    if (this.keys && this.t >= this.keys.total) {
      const next = this.keys.next;
      this.keys = null;
      this.state = next === 'stand' && this.goal !== 'stand' ? 'waitStop' : next;
      if (next === 'stand') return;
    }
    if (this.keys) return;
    if (this.hold > 0) { this.hold -= dt; return; }
    const s = this.state, g = this.goal;
    if (s === 'hk' && this._canLeave()) {
      if (g === 'army' || g === 'back') this._beginToArmy();
      else if (g !== 'crawl') this._beginUp();
    } else if (s === 'army' && this._canLeave()) {
      if (g === 'back') this._beginToBack();
      else if (g !== 'army') this._beginFromArmy();
    } else if (s === 'back' && g !== 'back') this._beginFromBack();
    else if (s === 'sit') {
      if (g === 'lie') this._beginToLie();
      else if (g !== 'sit') this._beginSitUp();
    } else if (s === 'lie' && g !== 'lie') this._beginFromLie();
  }

  /** Leave a crawl only with every limb down (the gait stops in a support phase first). */
  _canLeave() { return !this.active; }

  _locomote(dt) {
    const an = this.an, sc = this.sc;
    const army = this.state === 'army';
    const leaving = (this.goal === 'crawl' ? 'hk' : this.goal) !== this.state;
    const want = leaving ? 0 : an.targetSpeed;
    this.v.step(want, dt);
    const v = Math.max(0, this.v.x);
    this.yawRate.step(leaving ? 0 : an.turnInput * (army ? 0.55 : 0.85), dt);
    this.heading += this.yawRate.x * dt;
    // Army crawl surges with each pull (peaks mid-stance of each elbow).
    // On hands and knees it surges more gently, fastest while a diagonal pair is in the air.
    const surge = army ? 1 + 0.45 * Math.cos(4 * Math.PI * (this.phase - 0.275)) : 1 + 0.15 * Math.cos(4 * Math.PI * (this.phase - 0.39));
    this._axes();
    this.origin.addScaledVector(this._F, v * surge * dt);
    // On terrain the body follows the height of the ground under it (one level for all contacts).
    if (an.ground) this.origin.y += (an.ground(this.origin.x, this.origin.z) - this.origin.y) * (1 - Math.exp(-5 * dt));
    an.heading = this.heading;
    an.root.position.copy(this.origin);
    an.root.quaternion.setFromAxisAngle(UP, this.heading);

    const moving = want > 0.02 || v > 0.03 || Math.abs(this.yawRate.x) > 0.05 || (!leaving && Math.abs(an.turnInput) > 0.05);
    const f = army ? 0.35 + 1.0 * v / sc : 0.55 + 1.0 * v / sc;
    const err = army ? this._armyErr() : this._hkErr();
    if (!this.active && (moving || err > 0.05 * sc)) this.active = true;
    if (this.active) {
      const stops = (army ? ARMY : HK).stop;
      const inStop = stops.some(([a, b]) => this.phase >= a && this.phase < b);
      if (!moving && inStop && err < 0.05 * sc && this._allPlanted()) this.active = false;
      else this.phase = wrap01(this.phase + Math.max(f, 0.75) * dt);
    }
    if (army) this._armyLimbs(v, f); else this._hkLimbs(v, f);
  }

  _allPlanted() {
    if (this.state === 'army') return !this.army.eL.swing && !this.army.eR.swing;
    return Object.values(this.hk).every((l) => !l.swing);
  }

  // ----- Hands and knees -----
  _hkDims() {
    const sc = this.sc, a = this.thigh;
    const kneeY = 0.055 * sc, handY = 0.045 * sc;
    const hipH = kneeY + a * Math.cos(6 * DEG);
    const shH = handY + 0.985 * (this.upperArm + this.foreArm);
    const shZ = Math.sqrt(Math.max(this.Ls ** 2 - (shH - hipH) ** 2, 0.04));
    return { kneeY, handY, hipH, shH, shZ };
  }
  _hkNominal(key, out) {
    const m = this._hkDims(), s = key[1] === 'L' ? 1 : -1;
    if (key[0] === 'h') return out.set(s * this.shX * 0.95, m.handY, m.shZ + 0.02 * this.sc);
    return out.set(s * this.hipX * 1.05, m.kneeY, -0.03 * this.sc);
  }
  _hkErr() {
    let e = 0;
    const r = this._v[0], n = this._v[1];
    for (const k in this.hk) {
      const l = this.hk[k];
      if (l.swing) continue;
      this._rel(l.pos, r); this._hkNominal(k, n);
      e = Math.max(e, Math.hypot(r.x - n.x, r.z - n.z));
    }
    return e;
  }
  _hkLimbs(v, f) {
    const duty = clamp(0.7 - 0.08 * v / this.sc, 0.6, 0.7);
    const D = v * duty / Math.max(f, 0.5); // stance length
    const g = this._ground();
    for (const k in this.hk) {
      const l = this.hk[k];
      const p = wrap01(this.phase - HK.off[k]);
      const inSwing = this.active && p >= duty;
      if (inSwing && !l.swing) { l.swing = true; l.from.copy(l.pos); }
      if (!l.swing) { l.s = 0; continue; }
      const s = inSwing ? (p - duty) / (1 - duty) : 1;
      const tRem = (1 - s) * (1 - duty) / Math.max(f, 0.5);
      const hPred = this.heading + this.yawRate.x * tRem;
      const O = this._v[2].copy(this.origin).addScaledVector(this._v[3].set(Math.sin(hPred), 0, Math.cos(hPred)), v * tRem);
      const n = this._hkNominal(k, this._v[4]);
      n.z += D / 2;
      const target = this._pt(n.x, 0, n.z, this._v[5], O, hPred);
      target.y = g + n.y;
      const e = smootherstep(0.04, 1, s);
      l.pos.lerpVectors(l.from, target, e);
      l.s = s;
      if (!inSwing) { l.swing = false; l.s = 0; l.pos.copy(target); }
    }
  }

  // ----- Army crawl -----
  _armyDims() {
    const sc = this.sc;
    const hipY = 0.125 * sc, elbowY = 0.05 * sc, handY = 0.05 * sc, kneeY = 0.065 * sc;
    return { hipY, elbowY, handY, kneeY };
  }
  _armyShH() {
    const m = this._armyDims(), a = this.upperArm, sc = this.sc;
    let sum = 0, n = 0;
    const r = this._v[6];
    for (const s of SIDES) {
      const l = this.army['e' + s];
      if (l.swing) continue;
      this._rel(l.pos, r);
      const zS = this._armyShZ(this.armyShH.x || 0.2 * sc);
      const horiz = Math.hypot(r.x - SIGN[s] * this.shX, r.z - zS);
      sum += m.elbowY + Math.sqrt(Math.max(a * a - horiz * horiz, 0)); n++;
    }
    return clamp(n ? sum / n : 0.2 * sc, 0.14 * sc, 0.3 * sc);
  }
  _armyShZ(shH) {
    const m = this._armyDims();
    return Math.sqrt(Math.max(this.Ls ** 2 - (shH - m.hipY) ** 2, 0.04));
  }
  _armyNominal(s, out) {
    const m = this._armyDims(), sc = this.sc;
    return out.set(SIGN[s] * (this.shX + 0.06 * sc), m.elbowY, this._armyShZ(0.2 * sc) + 0.1 * sc);
  }
  _armyErr() {
    let e = 0;
    const r = this._v[0], n = this._v[1];
    for (const s of SIDES) {
      const l = this.army['e' + s];
      if (l.swing) continue;
      this._rel(l.pos, r); this._armyNominal(s, n);
      e = Math.max(e, Math.hypot(r.x - n.x, r.z - n.z));
    }
    return e;
  }
  _armyLimbs(v, f) {
    const duty = ARMY.duty;
    const D = v * duty / Math.max(f, 0.5);
    const g = this._ground();
    for (const s of SIDES) {
      const l = this.army['e' + s];
      const p = wrap01(this.phase - ARMY.off['e' + s]);
      const inSwing = this.active && p >= duty;
      if (inSwing && !l.swing) { l.swing = true; l.from.copy(l.pos); }
      if (l.swing) {
        const sw = inSwing ? (p - duty) / (1 - duty) : 1;
        const tRem = (1 - sw) * (1 - duty) / Math.max(f, 0.5);
        const hPred = this.heading + this.yawRate.x * tRem;
        const O = this._v[2].copy(this.origin).addScaledVector(this._v[3].set(Math.sin(hPred), 0, Math.cos(hPred)), v * tRem);
        const n = this._armyNominal(s, this._v[4]);
        n.z += D / 2;
        const target = this._pt(n.x, 0, n.z, this._v[5], O, hPred);
        target.y = g + n.y;
        l.pos.lerpVectors(l.from, target, smootherstep(0, 1, sw));
        l.s = sw;
        if (!inSwing) { l.swing = false; l.s = 0; l.pos.copy(target); }
      }
      // Legs: the knee is drawn up to the side (swing) and pushes back as the leg straightens.
      if (this.active) {
        const pk = wrap01(this.phase - ARMY.off['k' + s]);
        const th = pk < duty
          ? mix(62, 8, 1 - (1 - smoothstep(0, 0.8, pk / duty)) ** 2) // the push straightens the leg early
          : mix(8, 62, smootherstep(0, 1, (pk - duty) / (1 - duty)));
        this.army['th' + s] = th * DEG;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Posture specs
  // ---------------------------------------------------------------------------
  /** The standing pose as it is right now (bones must be posed). */
  _snapshot(out) {
    const an = this.an, b = an.bones, R = an.rest, T = this._q;
    an.model.updateMatrixWorld(true);
    const P = (k, v) => b[k].getWorldPosition(v);
    out.hip.copy(P('LeftUpLeg', this._v[0])).add(P('RightUpLeg', this._v[1])).multiplyScalar(0.5);
    out.sh.copy(P('LeftArm', this._v[0])).add(P('RightArm', this._v[1])).multiplyScalar(0.5);
    for (const s of SIDES) {
      const N = NAME[s], c = an.chains['arm' + s];
      P(N + 'Leg', out.knee[s]); P(N + 'Foot', out.ankle[s]);
      P(N + 'ForeArm', out.elbow[s]); P(N + 'Hand', out.hand[s]);
      const fq = b[N + 'Foot'].getWorldQuaternion(T[0]).multiply(T[1].copy(R[N + 'Foot'].charQ).invert());
      out.footF[s].set(0, 0, 1).applyQuaternion(fq); out.footU[s].set(0, 1, 0).applyQuaternion(fq);
      const hq = b[N + 'Hand'].getWorldQuaternion(T[0]).multiply(T[1].copy(R[N + 'Hand'].charQ).invert());
      out.handF[s].copy(c.l0).applyQuaternion(hq); out.handN[s].copy(c.palm0).applyQuaternion(hq);
      out.toe[s] = an.feet[s].toe.x;
    }
    const hq = b.Head.getWorldQuaternion(T[0]).multiply(T[1].copy(R.Head.charQ).invert());
    const dir = this._v[2].set(0, 0, 1).applyQuaternion(hq).applyQuaternion(an._rootQInv);
    out.gazeYaw = Math.atan2(dir.x, dir.z);
    out.gazePitch = Math.atan2(-dir.y, Math.hypot(dir.x, dir.z));
    out.pYaw = out.pRoll = out.cYaw = out.cRoll = out.lord = 0;
    out.flat = out.clav = out.clavElev = out.clavProt = out.rollAll = 0;
    return out;
  }

  /** Foot orientation from the leg's plane: plantar angle θ from neutral (toward the shin). */
  _footFromLeg(Hj, K, A, theta, F, U) {
    const dir = this._v[7].copy(A).sub(Hj).normalize();
    const perp = this._v[8].copy(K).sub(Hj);
    perp.addScaledVector(dir, -perp.dot(dir));
    if (perp.lengthSq() < 1e-4) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
    perp.normalize();
    const h = this._v[9].crossVectors(dir, perp).normalize();
    const s = this._v[10].copy(A).sub(K).normalize();
    const f0 = this._v[11].crossVectors(h, s).normalize();
    F.copy(f0).multiplyScalar(Math.cos(theta)).addScaledVector(s, Math.sin(theta)).normalize();
    U.crossVectors(h, F).normalize();
  }

  /** Tucked-toe foot (heel up 70°, ball on the floor): ankle offset from the ball, shin reach. */
  _tuck() {
    if (this._tk) return this._tk;
    const o = this.an._ankleFromPlant(V(), 0, -70 * DEG, V());
    const dy = o.y - 0.055 * this.sc;
    return (this._tk = { ay: o.y, az: o.z, reach: Math.sqrt(Math.max(this.shin ** 2 - dy * dy, 0)) });
  }
  /** Kneeling on toes tucked under: where the knee rests for a ball point, and back. */
  _kneeFromBall(ball, out = V()) {
    const t = this._tuck();
    this._axes();
    out.copy(ball).addScaledVector(this._F, t.az + t.reach);
    out.y = this._ground() + 0.055 * this.sc;
    return out;
  }
  _ballFromKnee(knee, out = V()) {
    const t = this._tuck();
    this._axes();
    out.copy(knee).addScaledVector(this._F, -(t.az + t.reach));
    out.y = this._ground();
    return out;
  }

  /** World point / direction from transition-base body coordinates (x left, y above ground, z forward). */
  _b(x, y, z) { const B = this.base; return this._pt(x, 0, z, V(), B.O, B.h).setY(this._ground() + y); }
  _bd(x, y, z) { const h = this.base.h, c = Math.cos(h), s = Math.sin(h); return new THREE.Vector3(c * x + s * z, y, -s * x + c * z).normalize(); }

  /**
   * A transition pose. `o`: hip (world), lean (trunk from vertical), roll / yaw of the girdles, gaze,
   * feet {L,R}: {ball, pitch} (on the ball of the foot / flat), {roll: knee} (turning over between
   * tucked toes and lying on its top), {top: knee}; knees {L,R}: pole points; hands {L,R}: {pos, F, N}.
   */
  _mk(out, o) {
    const an = this.an, sc = this.sc, h = this.base.h, g = this._ground();
    const F = this._bd(0, 0, 1), X = this._bd(1, 0, 0);
    out.hip.copy(o.hip);
    const lean = o.lean ?? 0;
    out.sh.copy(o.hip).addScaledVector(UP, this.Ls * Math.cos(lean)).addScaledVector(F, this.Ls * Math.sin(lean)).addScaledVector(X, o.lat ?? 0);
    out.pYaw = o.pYaw ?? 0; out.pRoll = o.pRoll ?? 0; out.cYaw = o.cYaw ?? 0; out.cRoll = o.cRoll ?? 0;
    out.lord = o.lord ?? 0; out.gazePitch = o.gaze ?? 0; out.gazeYaw = 0;
    out.flat = o.flat ?? 0; out.clav = o.clav ?? 0; out.clavElev = o.clavElev ?? 0; out.clavProt = o.clavProt ?? 0;
    out.rollAll = o.rollAll ?? 0;
    const t = this._tuck();
    for (const s of SIDES) {
      const f = o.feet[s];
      if (f.ball) {
        an._ankleFromPlant(f.ball, h, f.pitch, out.ankle[s]);
        const c = Math.cos(f.pitch), si = Math.sin(f.pitch);
        out.footF[s].copy(F).multiplyScalar(c).addScaledVector(UP, si);
        out.footU[s].copy(F).multiplyScalar(-si).addScaledVector(UP, c);
        out.toe[s] = clamp(-f.pitch, 0, 70 * DEG);
      } else if (f.roll) {
        // Halfway over: pointing down, the ankle lifted so the toes clear the floor.
        out.ankle[s].copy(f.roll).addScaledVector(F, -0.27 * sc); out.ankle[s].y = g + 0.17 * sc;
        out.footF[s].copy(F).multiplyScalar(-0.1).addScaledVector(UP, -1).normalize();
        out.footU[s].copy(F).addScaledVector(UP, -0.1).normalize();
        out.toe[s] = 20 * DEG;
      } else if (f.top) {
        // On its top, trailing behind the knee.
        out.ankle[s].copy(f.top).addScaledVector(F, -Math.sqrt(this.shin ** 2 - (0.02 * sc) ** 2)); out.ankle[s].y = g + 0.075 * sc;
        out.footF[s].copy(F).multiplyScalar(-0.96).addScaledVector(UP, -0.28).normalize();
        out.footU[s].copy(F).multiplyScalar(0.28).addScaledVector(UP, -0.96).normalize();
        out.toe[s] = 0;
      }
      out.knee[s].copy(o.knees[s]);
      const hd = o.hands[s];
      out.hand[s].copy(hd.pos);
      out.handF[s].copy(hd.F); out.handN[s].copy(hd.N);
      // Elbows: back and a little out from the line shoulder → hand.
      const S = this._v[0].copy(out.sh).addScaledVector(X, SIGN[s] * this.shX);
      out.elbow[s].copy(S).add(out.hand[s]).multiplyScalar(0.5).addScaledVector(F, -0.2 * sc).addScaledVector(X, SIGN[s] * 0.1 * sc);
      if (hd.elbow) out.elbow[s].copy(hd.elbow);
    }
    return out;
  }
  /** Hand flat on the floor, fingers a little in. */
  _palmDown(s, pos) {
    const yawIn = -SIGN[s] * 10 * DEG;
    return { pos, F: this._bd(Math.sin(yawIn), 0, Math.cos(yawIn)), N: new THREE.Vector3(0, -1, 0) };
  }
  /** Hand reaching in a direction (body coords), palm facing in and down. */
  _reach(s, pos, fx, fy, fz) {
    return { pos, F: this._bd(fx, fy, fz), N: this._bd(-SIGN[s], -0.6, 0) };
  }
  /** Hand resting on top of the thigh just above the knee. */
  _onKnee(s, knee) {
    const F = this._bd(0, 0, 1);
    const pos = knee.clone().addScaledVector(UP, 0.075 * this.sc).addScaledVector(F, -0.07 * this.sc).addScaledVector(this._bd(1, 0, 0), SIGN[s] * 0.015 * this.sc);
    return { pos, F: this._bd(0, -0.45, 1), N: this._bd(0, -1, -0.3) };
  }
  /** A copy of a live spec with some feet replaced (see _mk feet). */
  _withFeet(live, feet, out) {
    copySpec(live, out);
    const tmp = this._mk(this._feetTmp ||= mkSpec(), { hip: live.hip, feet, knees: live.knee, hands: { L: { pos: live.hand.L, F: live.handF.L, N: live.handN.L }, R: { pos: live.hand.R, F: live.handF.R, N: live.handN.R } } });
    for (const s of SIDES) {
      if (feet[s].keep) continue;
      out.ankle[s].copy(tmp.ankle[s]); out.footF[s].copy(tmp.footF[s]); out.footU[s].copy(tmp.footU[s]); out.toe[s] = tmp.toe[s];
    }
    return out;
  }

  /** Hands and knees, from the gait state. */
  _hkSpec(out) {
    const sc = this.sc, a = this.thigh, g = this._ground(), m = this._hkDims();
    this._axes();
    const F = this._F, X = this._X, r = this._v[0];
    // Hip height from the planted knees, shoulder height from the planted hands.
    let hs = 0, hn = 0, ss = 0, sn = 0;
    const R = 0.985 * (this.upperArm + this.foreArm);
    for (const s of SIDES) {
      const k = this.hk['k' + s], h = this.hk['h' + s];
      if (!k.swing) { this._rel(k.pos, r); const hz = Math.hypot(r.x - SIGN[s] * this.hipX, r.z); hs += m.kneeY + Math.sqrt(Math.max(a * a - hz * hz, 0)); hn++; }
      if (!h.swing) { this._rel(h.pos, r); const hz = Math.hypot(r.x - SIGN[s] * this.shX, r.z - m.shZ); ss += m.handY + Math.sqrt(Math.max(R * R - hz * hz, 0)); sn++; }
    }
    const dt = this.an._poseDt || 1 / 60;
    this.hipH.step(hn ? hs / hn : m.hipH, dt);
    this.shH.step(sn ? ss / sn : m.shH, dt);
    // Swing arc: lifts early, sets down softly.
    const swing = (l) => (l.swing ? Math.sin(Math.PI * l.s ** 0.8) ** 1.2 : 0);
    const sk = { L: swing(this.hk.kL), R: swing(this.hk.kR) }, sh = { L: swing(this.hk.hL), R: swing(this.hk.hR) };
    // A little side-to-side weight shift onto the supporting diagonal.
    const sway = 0.012 * sc * (sk.R + sh.R - sk.L - sh.L) * 0.5;
    this._pt(sway, 0, 0, out.hip); out.hip.y = g + this.hipH.x;
    const shZ = Math.sqrt(Math.max(this.Ls ** 2 - (this.shH.x - this.hipH.x) ** 2, 0.04));
    this._pt(sway * 1.4, 0, shZ, out.sh); out.sh.y = g + this.shH.x;
    // Girdles yaw with their limbs (the forward knee carries its hip forward).
    const kL = this._rel(this.hk.kL.pos, this._v[1]), kR = this._rel(this.hk.kR.pos, this._v[2]);
    const hL = this._rel(this.hk.hL.pos, this._v[3]), hR = this._rel(this.hk.hR.pos, this._v[4]);
    // (Kept small: yawing the chest swings the whole trunk about the pelvis, a lateral spine bend.)
    out.pYaw = clamp(-0.3 * Math.atan2(kL.z - kR.z, kL.x - kR.x), -10 * DEG, 10 * DEG);
    out.cYaw = clamp(-0.15 * Math.atan2(hL.z - hR.z, hL.x - hR.x), -7 * DEG, 7 * DEG);
    out.pRoll = 7 * DEG * (sk.R - sk.L);
    out.cRoll = 4 * DEG * (sh.R - sh.L);
    out.lord = 4 * DEG;
    const Hj = this._v[5];
    for (const s of SIDES) {
      const sg = SIGN[s];
      const k = this.hk['k' + s], h = this.hk['h' + s];
      out.knee[s].copy(k.pos).addScaledVector(UP, 0.035 * sc * swing(k));
      // Shin trails behind, the foot on its top, lifting a little with the knee.
      const ay = m.kneeY + 0.02 * sc + 0.03 * sc * swing(k);
      const dy = ay - (out.knee[s].y - g);
      const back = this._v[6].copy(F).negate().addScaledVector(X, -sg * 0.06).normalize();
      out.ankle[s].copy(out.knee[s]).addScaledVector(back, Math.sqrt(Math.max(this.shin ** 2 - dy * dy, 0)));
      out.ankle[s].y = g + ay;
      Hj.copy(out.hip).addScaledVector(X, sg * this.hipX);
      this._footFromLeg(Hj, out.knee[s], out.ankle[s], 72 * DEG, out.footF[s], out.footU[s]);
      out.toe[s] = 0;
      out.hand[s].copy(h.pos).addScaledVector(UP, 0.07 * sc * swing(h));
      const S = this._v[6].copy(out.sh).addScaledVector(X, sg * this.shX);
      out.elbow[s].copy(S).add(out.hand[s]).multiplyScalar(0.5).addScaledVector(F, -0.2 * sc).addScaledVector(X, sg * 0.08 * sc);
      const yawIn = -sg * 10 * DEG;
      out.handF[s].copy(F).multiplyScalar(Math.cos(yawIn)).addScaledVector(X, Math.sin(yawIn)).addScaledVector(UP, -0.25 * swing(h)).normalize();
      out.handN[s].set(0, -1, 0).addScaledVector(F, 0.3 * swing(h)).normalize();
    }
    this._gaze(out, 26 * DEG, clamp(this.an.lookAhead * 0.5, -40 * DEG, 40 * DEG), 0.6);
    out.flat = 1; out.clav = 1; out.clavElev = 2 * DEG; out.clavProt = 8 * DEG; out.rollAll = 0;
    return out;
  }

  /** Army crawl, from the gait state. */
  _armySpec(out) {
    const sc = this.sc, g = this._ground(), m = this._armyDims(), a = this.thigh;
    this._axes();
    const F = this._F, X = this._X;
    const dt = this.an._poseDt || 1 / 60;
    this.armyShH.step(this._armyShH(), dt);
    const thL = this.army.thL, thR = this.army.thR;
    const roll = 0.24 * (thL - thR);
    const swing = (l) => (l.swing ? Math.sin(Math.PI * l.s ** 0.85) : 0);
    const swL = swing(this.army.eL), swR = swing(this.army.eR);
    // The weight rolls onto the long leg and the hip rises on the drawn-up side (smoothly through
    // level, no kink); the chest shifts over the pulling elbow.
    const hipSway = 0.018 * sc * (thR - thL) / (54 * DEG);
    this._pt(hipSway, 0, 0, out.hip); out.hip.y = g + m.hipY + (Math.hypot(roll, 3 * DEG) - 3 * DEG) * this.hipX * 0.6;
    const shZ = this._armyShZ(this.armyShH.x);
    this._pt(0.025 * sc * (swR - swL), 0, shZ, out.sh); out.sh.y = g + this.armyShH.x;
    const eL = this._rel(this.army.eL.pos, this._v[1]), eR = this._rel(this.army.eR.pos, this._v[2]);
    out.pYaw = 0.25 * (thR - thL) * 0.5;
    out.cYaw = clamp(-0.15 * Math.atan2(eL.z - eR.z, eL.x - eR.x), -7 * DEG, 7 * DEG);
    out.pRoll = roll;
    out.cRoll = 7 * DEG * (swL - swR) - 0.3 * roll;
    out.lord = -9 * DEG;
    const Hj = this._v[3];
    for (const s of SIDES) {
      const sg = SIGN[s], th = this.army['th' + s], e = this.army['e' + s];
      // Elbow on the floor, forearm forward and in, palm down.
      // Reaching: the elbow lifts, the forearm swings straighter ahead and the hand clears the floor.
      const sw = swing(e);
      out.elbow[s].copy(e.pos).addScaledVector(UP, 0.05 * sc * sw);
      const ang = -sg * (22 - 9 * sw) * DEG;
      const dirH = this._v[4].copy(F).multiplyScalar(Math.cos(ang)).addScaledVector(X, Math.sin(ang));
      const dy = m.handY - m.elbowY;
      out.hand[s].copy(out.elbow[s]).addScaledVector(dirH, Math.sqrt(this.foreArm ** 2 - dy * dy)).addScaledVector(UP, dy + 0.035 * sc * sw);
      out.handF[s].copy(dirH).addScaledVector(UP, -0.15 * sw).normalize(); out.handN[s].set(0, -1, 0).addScaledVector(F, 0.2 * sw).normalize();
      // Knee on the floor at thigh's length from the hip joint, swept out to the side by θ.
      Hj.copy(out.hip).addScaledVector(X, sg * this.hipX);
      const dyk = Hj.y - (g + m.kneeY);
      const rk = Math.sqrt(Math.max(a * a - dyk * dyk, 0));
      const kd = this._v[5].copy(X).multiplyScalar(sg * Math.sin(th)).addScaledVector(F, -Math.cos(th));
      out.knee[s].copy(Hj).addScaledVector(kd, rk); out.knee[s].y = g + m.kneeY;
      // Shin: nearly straight behind when extended, folded back toward the midline when drawn up.
      const frog = smoothstep(10 * DEG, 60 * DEG, th);
      const kap = mix(10, 105, frog) * DEG;
      const sa = th - kap;
      const sd = this._v[6].copy(X).multiplyScalar(sg * Math.sin(sa)).addScaledVector(F, -Math.cos(sa));
      const ay = mix(0.075, 0.05, frog) * sc;
      const dya = ay - m.kneeY;
      out.ankle[s].copy(out.knee[s]).addScaledVector(sd, Math.sqrt(Math.max(this.shin ** 2 - dya * dya, 0)));
      out.ankle[s].y = g + ay;
      this._footFromLeg(Hj, out.knee[s], out.ankle[s], mix(72, 40, frog) * DEG, out.footF[s], out.footU[s]);
      out.toe[s] = mix(25, 0, frog) * DEG;
    }
    this._gaze(out, 18 * DEG, clamp(this.an.lookAhead * 0.5, -40 * DEG, 40 * DEG), 0.5);
    out.flat = 1; out.clav = 1; out.clavElev = 9 * DEG; out.clavProt = 4 * DEG; out.rollAll = 0;
    return out;
  }

  /**
   * Between hands-and-knees (a) and the army crawl (b), part by part: w = { arm: {L, R}, leg: {L, R},
   * sh, hip, trunk } (0 = a, 1 = b); `roll` drops the chest toward one side.
   */
  _partBlend(a, b, w, out, roll = 0) {
    copySpec(a, out);
    const unit = (k, sd, t) => {
      const o = out[k][sd].lerpVectors(a[k][sd], b[k][sd], t);
      if (o.lengthSq() < 1e-6) o.copy(b[k][sd]);
      o.normalize();
    };
    out.hip.lerpVectors(a.hip, b.hip, w.hip);
    out.sh.lerpVectors(a.sh, b.sh, w.sh);
    for (const sd of SIDES) {
      const ta = w.arm[sd], tl = w.leg[sd];
      out.hand[sd].lerpVectors(a.hand[sd], b.hand[sd], ta); out.elbow[sd].lerpVectors(a.elbow[sd], b.elbow[sd], ta);
      unit('handF', sd, ta); unit('handN', sd, ta);
      out.knee[sd].lerpVectors(a.knee[sd], b.knee[sd], tl); out.ankle[sd].lerpVectors(a.ankle[sd], b.ankle[sd], tl);
      unit('footF', sd, tl); unit('footU', sd, tl);
      out.toe[sd] = mix(a.toe[sd], b.toe[sd], tl);
    }
    for (const k of SCAL) out[k] = mix(a[k], b[k], w.trunk);
    out.cRoll += roll;
    return out;
  }

  /**
   * Staged transition between the crawls (stages in hands-and-knees → army order; `back` plays them
   * in reverse). A limb moving between two stages lifts off the floor in proportion to how far it goes.
   */
  _crawlSwap(state, stages, next, back) {
    const T = stages[stages.length - 1].t;
    const st = back ? stages.slice().reverse().map((x) => ({ ...x, t: T - x.t })) : stages;
    const keys = st.map((x) => { const sp = mkSpec(); return { t: x.t, w: x.w, get: () => this._partBlend(this.specA, this.specB, x.w, sp, x.roll) }; });
    this._seq(state, keys, next, (i, u, spec) => {
      const a = keys[i].w, b = keys[i + 1].w, lift = Math.sin(Math.PI * u) * this.sc;
      for (const s of SIDES) {
        spec.hand[s].y += 0.08 * lift * Math.abs(b.arm[s] - a.arm[s]);
        const kl = 0.035 * lift * Math.abs(b.leg[s] - a.leg[s]);
        spec.knee[s].y += kl; spec.ankle[s].y += kl;
      }
    });
  }
  /**
   * Stages: one forearm down, then the other, then the legs slide back long (and frog out) with
   * the hips sinking behind them; the legs always lead, or the knees would be driven into the floor.
   */
  _swapStages() {
    const K = this.an.rng() < 0.5 ? 'L' : 'R', O = K === 'L' ? 'R' : 'L';
    const W = (aK, aO, sh, hip, lL, lR, trunk) => ({ arm: { [K]: aK, [O]: aO }, leg: { L: lL, R: lR }, sh, hip, trunk });
    return [
      { t: 0, w: W(0, 0, 0, 0, 0, 0, 0) },
      { t: 0.45, w: W(1, 0, 0.45, 0, 0, 0, 0.3), roll: -SIGN[K] * 5 * DEG },
      { t: 0.85, w: W(1, 1, 0.75, 0, 0.08, 0.08, 0.5) },
      { t: 1.4, w: W(1, 1, 0.9, 0.5, 0.78, 0.62, 0.8) },
      { t: 1.9, w: W(1, 1, 1, 1, 1, 1, 1) },
    ];
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------
  /**
   * Start a transition through key poses at the given times. Keys are getters (live ones are
   * re-evaluated each frame); the pose follows a monotone cubic through them, so it flows from one
   * to the next without stopping, and nothing held still between two keys drifts.
   */
  _seq(state, keys, next, bump, { scale = 1, liveStand = false } = {}) {
    this.state = state;
    if (scale !== 1) for (const k of keys) k.t *= scale;
    this.keys = { keys, total: keys[keys.length - 1].t, next, bump, liveStand, arrs: keys.map(() => new Float64Array(SPEC_N)) };
    this.t = 0;
    this._filt = null;
  }

  _beginDown() {
    const an = this.an, sc = this.sc;
    this._snapshot(this.snap);
    this.heading = an.heading;
    this._axes();
    const F = this._F;
    // The feet stay where they are; the knees come down in front of them, one at a time.
    const ball = { L: an.feet.L.ball.clone(), R: an.feet.R.ball.clone() };
    const knee = { L: this._kneeFromBall(ball.L), R: this._kneeFromBall(ball.R) };
    this.origin.copy(knee.L).add(knee.R).multiplyScalar(0.5).addScaledVector(F, 0.03 * sc);
    this.origin.y = an.root.position.y;
    this.base = { O: this.origin.clone(), h: this.heading };
    an.root.position.copy(this.origin);
    an._updateRootFrame();
    this._initHk(knee);
    // The first knee down is the one under the foot further back (or either, at random).
    const zl = this._rel(ball.L, V()).z, zr = this._rel(ball.R, V()).z;
    const K = Math.abs(zl - zr) > 0.03 * sc ? (zl < zr ? 'L' : 'R') : an.rng() < 0.5 ? 'L' : 'R';
    const Fr = K === 'L' ? 'R' : 'L', kx = SIGN[K] * 0.11 * sc, fx = SIGN[Fr] * 0.11 * sc, fs = SIGN[Fr];
    const zb = this._rel(ball.L, V()).add(this._rel(ball.R, V())).multiplyScalar(0.5).z; // balls, relative to the base
    const spot = (s) => this.hk['h' + s].pos.clone();
    const hk = this._hkDims();
    const kneelY = 0.055 * sc + this.thigh * 0.97;
    const mid = knee.L.clone().add(knee.R).multiplyScalar(0.5);
    const P = (o) => { const sp = mkSpec(); return () => this._mk(sp, o); };
    const feet = (k, f) => ({ [K]: k, [Fr]: f });
    // 1. Bending: hips back and down, heels rising, reaching toward the floor (one hand leads).
    const k1 = P({
      hip: this._b(0.03 * sc * fs, 0.66 * sc, zb - 0.19 * sc), lean: 26 * DEG, lat: 0.02 * sc * fs, gaze: 30 * DEG,
      feet: feet({ ball: ball[K], pitch: -20 * DEG }, { ball: ball[Fr], pitch: -10 * DEG }),
      knees: feet(this._b(kx, 0.38 * sc, zb + 0.25 * sc), this._b(fx, 0.4 * sc, zb + 0.24 * sc)),
      hands: feet(this._reach(K, this._b(kx * 1.6, 0.36 * sc, zb + 0.25 * sc), 0, -0.7, 0.7), this._reach(Fr, this._b(fx * 1.7, 0.48 * sc, zb + 0.18 * sc), 0, -0.8, 0.6)),
      flat: 0.3, clav: 0.3,
    });
    // 2. The first knee touches down; the pelvis dips on that side.
    const k2 = P({
      hip: this._b(0.02 * sc * fs, 0.5 * sc, zb + 0.1 * sc), lean: 42 * DEG, gaze: 36 * DEG,
      pRoll: -SIGN[K] * 6 * DEG, cRoll: SIGN[K] * 3 * DEG,
      feet: feet({ ball: ball[K], pitch: -70 * DEG }, { ball: ball[Fr], pitch: -32 * DEG }),
      knees: feet(knee[K], this._b(fx, 0.28 * sc, zb + 0.4 * sc)),
      hands: feet(this._reach(K, spot(K).addScaledVector(UP, 0.22 * sc).addScaledVector(F, -0.15 * sc), 0, -0.6, 0.8), this._reach(Fr, this._b(fx * 1.6, 0.32 * sc, zb + 0.45 * sc), 0, -0.7, 0.7)),
      flat: 0.6, clav: 0.5,
    });
    // 3. Both knees down; leaning onto the first hand, the other on its way.
    const k3 = P({
      hip: mid.clone().setY(this._ground() + kneelY).addScaledVector(F, 0.02 * sc), lean: 74 * DEG, gaze: 32 * DEG,
      feet: feet({ ball: ball[K], pitch: -70 * DEG }, { ball: ball[Fr], pitch: -70 * DEG }),
      knees: feet(knee[K], knee[Fr]),
      hands: feet(this._palmDown(K, spot(K)), this._reach(Fr, spot(Fr).addScaledVector(UP, 0.09 * sc).addScaledVector(F, -0.08 * sc), 0, -0.5, 0.85)),
      flat: 0.9, clav: 0.9,
    });
    // 4–6. On hands and knees; the feet turn over onto their tops one after the other.
    const L4 = mkSpec(), L5 = mkSpec(), L6 = mkSpec();
    this._seq('down', [
      { t: 0, get: () => this.snap },
      { t: 0.42, get: k1 },
      { t: 0.78, get: k2 },
      { t: 1.06, get: k3 },
      { t: 1.28, get: () => this._withFeet(this.specA, feet({ ball: ball[K], pitch: -70 * DEG }, { ball: ball[Fr], pitch: -70 * DEG }), L4) },
      { t: 1.5, get: () => this._withFeet(this.specA, feet({ roll: knee[K] }, { ball: ball[Fr], pitch: -70 * DEG }), L5) },
      { t: 1.7, get: () => this._withFeet(this.specA, feet({ keep: true }, { roll: knee[Fr] }), L6) },
      { t: 1.95, get: () => this.specA },
    ], 'hk');
  }

  /**
   * Knocked forward: the protective reflex throws the hands out first, the elbows give as they
   * take the weight, then the knees hit; she ends on hands and knees and stays a moment.
   */
  _beginFallFwd() {
    const an = this.an, sc = this.sc;
    this._snapshot(this.snap);
    this.heading = an.heading;
    this._axes();
    const F = this._F;
    const ball = { L: an.feet.L.ball.clone(), R: an.feet.R.ball.clone() };
    const knee = { L: this._kneeFromBall(ball.L), R: this._kneeFromBall(ball.R) };
    this.origin.copy(knee.L).add(knee.R).multiplyScalar(0.5).addScaledVector(F, 0.03 * sc);
    this.origin.y = an.root.position.y;
    this.base = { O: this.origin.clone(), h: this.heading };
    an.root.position.copy(this.origin);
    an._updateRootFrame();
    this._initHk(knee);
    this.hold = 1.2;
    const zb = this._rel(ball.L, V()).add(this._rel(ball.R, V())).multiplyScalar(0.5).z;
    const B = (x, y, z) => this._b(x * sc, y * sc, z * sc);
    const both = (f) => ({ L: f('L'), R: f('R') });
    const spot = (s) => this.hk['h' + s].pos.clone();
    const P = (o) => { const sp = mkSpec(); return () => this._mk(sp, o); };
    const tuck = (pitch) => ({ L: { ball: ball.L, pitch }, R: { ball: ball.R, pitch } });
    const kneelY = 0.055 * sc + this.thigh * 0.97;
    const mid = knee.L.clone().add(knee.R).multiplyScalar(0.5);
    const L4 = mkSpec(), L5 = mkSpec();
    this._seq('down', [
      { t: 0, get: () => this.snap },
      // Pitching forward, heels up, the hands flung out ahead and down.
      { t: 0.27, get: P({
        hip: this._b(0, 0.78 * sc, (zb + 0.12) * sc / sc), lean: 40 * DEG, gaze: 18 * DEG, feet: tuck(-25 * DEG),
        knees: both((s) => B(SIGN[s] * 0.11, 0.42, zb / sc + 0.32)),
        hands: both((s) => this._reach(s, B(SIGN[s] * 0.25, 0.55, zb / sc + 0.8), 0, -0.5, 0.85)), flat: 0.3, clav: 0.4,
      }) },
      // The hands hit (arms nearly straight); the knees are still on the way.
      { t: 0.46, get: P({
        hip: this._b(0, 0.58 * sc, zb + 0.2 * sc), lean: 64 * DEG, gaze: 22 * DEG, feet: tuck(-55 * DEG),
        knees: both((s) => B(SIGN[s] * 0.11, 0.2, zb / sc + 0.44)),
        hands: both((s) => this._palmDown(s, spot(s).addScaledVector(F, 0.05 * sc))), flat: 0.9, clav: 0.8,
      }) },
      // Knees down; the elbows give under the load.
      { t: 0.62, get: P({
        hip: mid.clone().setY(this._ground() + kneelY - 0.02 * sc), lean: 80 * DEG, gaze: 24 * DEG, feet: tuck(-70 * DEG),
        knees: knee, hands: both((s) => this._palmDown(s, spot(s).addScaledVector(F, 0.03 * sc))), flat: 1, clav: 1,
      }) },
      { t: 0.92, get: () => this._withFeet(this.specA, tuck(-70 * DEG), L4) },
      { t: 1.17, get: () => this._withFeet(this.specA, { L: { roll: knee.L }, R: { roll: knee.R } }, L5) },
      { t: 1.42, get: () => this.specA },
    ], 'hk');
  }

  _beginUp() {
    const an = this.an, sc = this.sc;
    this._axes();
    const F = this._F;
    this.base = { O: this.origin.clone(), h: this.heading };
    const knee = { L: this.hk.kL.pos.clone(), R: this.hk.kR.pos.clone() };
    const ball = { L: this._ballFromKnee(knee.L), R: this._ballFromKnee(knee.R) };
    // The standing figure is re-planted on these balls; it stands up from there.
    an._resetStance(ball);
    const K = an.rng() < 0.5 ? 'L' : 'R', Fr = K === 'L' ? 'R' : 'L';
    const kx = SIGN[K] * 0.11 * sc, fx = SIGN[Fr] * 0.11 * sc, fs = SIGN[Fr];
    const zb = this._rel(ball.L, V()).add(this._rel(ball.R, V())).multiplyScalar(0.5).z;
    const kz = this._rel(knee.L, V()).z;
    const feet = (k, f) => ({ [K]: k, [Fr]: f });
    const P = (o) => { const sp = mkSpec(); return () => this._mk(sp, o); };
    const tuck = (s, pitch = -70 * DEG) => ({ ball: ball[s], pitch });
    const L1 = mkSpec(), L2 = mkSpec(), L3 = mkSpec();
    // 4. Rocking back onto the feet: hands push off (one first), knees leave the floor.
    const fKnee4 = this._b(fx, 0.15 * sc, kz + 0.05 * sc);
    const k4 = P({
      hip: this._b(0, 0.44 * sc, zb + 0.14 * sc), lean: 50 * DEG, gaze: 28 * DEG, pRoll: SIGN[K] * 4 * DEG,
      feet: feet(tuck(K, -52 * DEG), tuck(Fr, -56 * DEG)),
      knees: feet(this._b(kx, 0.13 * sc, kz + 0.05 * sc), fKnee4),
      hands: feet(this._reach(K, this._b(kx * 1.5, 0.08 * sc, zb + 0.62 * sc), 0, -0.35, 1), this._reach(Fr, this._b(fx * 1.5, 0.3 * sc, zb + 0.5 * sc), 0, -0.6, 0.8)),
      flat: 0.6, clav: 0.6,
    });
    // 5. Deep squat on the toes, a hand on the knee, the other arm forward for balance.
    const fKnee5 = this._b(fx, 0.36 * sc, zb + 0.3 * sc);
    const k5 = P({
      hip: this._b(0.02 * sc * fs, 0.48 * sc, zb - 0.1 * sc), lean: 36 * DEG, gaze: 22 * DEG,
      feet: feet(tuck(K, -30 * DEG), tuck(Fr, -24 * DEG)),
      knees: feet(this._b(kx, 0.36 * sc, zb + 0.3 * sc), fKnee5),
      hands: feet(this._reach(K, this._b(kx * 1.4, 0.48 * sc, zb + 0.42 * sc), 0, -0.3, 1), this._onKnee(Fr, fKnee5)),
      flat: 0.2, clav: 0.3,
    });
    // 6. Rising: heels coming down, arms settling.
    const k6 = P({
      hip: this._b(0, 0.84 * sc, zb - 0.13 * sc), lean: 14 * DEG, gaze: 8 * DEG,
      feet: feet(tuck(K, -6 * DEG), tuck(Fr, -3 * DEG)),
      knees: feet(this._b(kx, 0.5 * sc, zb + 0.12 * sc), this._b(fx, 0.5 * sc, zb + 0.12 * sc)),
      hands: feet(this._reach(K, this._b(kx * 1.6, 0.66 * sc, zb + 0.1 * sc), 0, -1, 0.2), this._reach(Fr, this._b(fx * 1.6, 0.7 * sc, zb + 0.08 * sc), 0, -1, 0.25)),
    });
    this._seq('up', [
      { t: 0, get: () => this.specA },
      // 1–3. The toes tuck under, one foot after the other, as the weight rocks back.
      { t: 0.26, get: () => this._withFeet(this.specA, feet({ roll: knee[K] }, { keep: true }), L1) },
      { t: 0.48, get: () => this._withFeet(this.specA, feet(tuck(K), { roll: knee[Fr] }), L2) },
      { t: 0.7, get: () => { const o = this._withFeet(this.specA, feet(tuck(K), tuck(Fr)), L3); o.hip.addScaledVector(F, -0.05 * sc); o.sh.addScaledVector(F, -0.03 * sc); return o; } },
      { t: 1.02, get: k4 },
      { t: 1.38, get: k5 },
      { t: 1.78, get: k6 },
      { t: 2.15, get: () => this.stand },
    ], 'stand', null, { liveStand: true });
  }

  _beginToArmy() {
    this._initArmy();
    this._crawlSwap('toArmy', this._swapStages(), 'army', false);
  }

  _beginFromArmy() {
    this._initHk(null);
    this._crawlSwap('fromArmy', this._swapStages(), 'hk', true);
  }

  // ----- Floor poses: sitting, lying back, rolled onto the back -----
  /** Gaze toward the look target (if any), blended over the pose's own. */
  _gaze(out, pitch, yaw, kPitch = 1) {
    const an = this.an, w = an.lookW.x;
    out.gazeYaw = mix(yaw, clamp(an.lookRel.yaw, -60 * DEG, 60 * DEG), w);
    out.gazePitch = mix(pitch, an.lookRel.pitch, w * kPitch);
    return out;
  }
  /** Knee points for both legs from base coords (x mirrored). */
  _kn(x, y, z) { const sc = this.sc; return { L: this._b(x * sc, y * sc, z * sc), R: this._b(-x * sc, y * sc, z * sc) }; }
  _flatFeet() { const b = this.sitBall; return { L: { ball: b.L, pitch: 0 }, R: { ball: b.R, pitch: 0 } }; }
  /** Sitting hand: flat on the floor behind and beside the hip, fingers pointing back and out. */
  _sitHand(s) {
    const sc = this.sc;
    return { pos: this._b(SIGN[s] * 0.22 * sc, 0.045 * sc, -0.29 * sc), F: this._bd(SIGN[s] * 0.75, 0, -0.65), N: new THREE.Vector3(0, -1, 0) };
  }

  /** Sitting on the floor: knees up, feet flat, leaning back on the hands. */
  _sitSpec(out) {
    const sc = this.sc;
    this._mk(out, {
      hip: this._b(0, 0.125 * sc, 0), lean: -22 * DEG, lord: -10 * DEG, gaze: 6 * DEG,
      feet: this._flatFeet(), knees: this._kn(0.15, 0.43, 0.29),
      hands: { L: this._sitHand('L'), R: this._sitHand('R') },
      flat: 1, clav: 0.5, clavElev: 4 * DEG, clavProt: -6 * DEG,
    });
    // A slow breath lifts the chest a little.
    out.sh.y += 0.006 * sc * this.an.breath;
    return this._gaze(out, out.gazePitch, 0, 0.8);
  }
  /** Halfway down: propped on the elbows. */
  _elbowsSpec(out) {
    const sc = this.sc, hand = (s) => ({
      pos: this._b(SIGN[s] * 0.2 * sc, 0.045 * sc, -0.2 * sc), F: this._bd(SIGN[s] * 0.1, 0, 1), N: new THREE.Vector3(0, -1, 0),
      elbow: this._b(SIGN[s] * 0.22 * sc, 0.04 * sc, -0.47 * sc),
    });
    return this._mk(out, {
      hip: this._b(0, 0.125 * sc, 0), lean: -66 * DEG, lord: -6 * DEG, gaze: 12 * DEG,
      feet: this._flatFeet(), knees: this._kn(0.15, 0.44, 0.3),
      hands: { L: hand('L'), R: hand('R') }, flat: 1, clav: 0.6, clavElev: 8 * DEG, clavProt: -8 * DEG,
    });
  }
  /** Lying back, knees up, arms on the floor beside her. */
  _lieSpec(out) {
    const sc = this.sc, hand = (s) => ({
      pos: this._b(SIGN[s] * 0.27 * sc, 0.04 * sc, -0.05 * sc), F: this._bd(SIGN[s] * 0.15, 0, 1), N: new THREE.Vector3(0, -1, 0),
      elbow: this._b(SIGN[s] * 0.3 * sc, 0.05 * sc, -0.28 * sc),
    });
    this._mk(out, {
      hip: this._b(0, 0.15 * sc, 0), lean: -88 * DEG, gaze: -78 * DEG,
      feet: this._flatFeet(), knees: this._kn(0.14, 0.45, 0.3),
      hands: { L: hand('L'), R: hand('R') }, flat: 0.6, clav: 0.2,
    });
    out.sh.y += 0.005 * sc * this.an.breath;
    return out;
  }

  /** The gait-free body frame point (origin, heading) at body coords, at height y above the floor. */
  _at(x, y, z, out = V()) { this._pt(x, 0, z, out); out.y = this._ground() + y; return out; }
  /**
   * Rolled onto the back from the army crawl: legs long, face up; arms overhead (`arms` 0), out
   * to the sides (1) or down by the sides (2): after the roll they sweep down along the floor.
   */
  _backSpec(out, arms = 2) {
    const sc = this.sc, F = this._bd(0, 0, 1), X = this._bd(1, 0, 0), a = this.thigh, b = this.shin, Ls = this.Ls;
    this.base = { O: this.origin.clone(), h: this.heading };
    this._at(0, 0.15 * sc, 0, out.hip);
    this._at(0, 0.15 * sc + 0.004 * sc * this.an.breath, Ls * 0.99, out.sh);
    out.rollAll = this.rollSign * Math.PI;
    out.pYaw = out.pRoll = out.cYaw = out.cRoll = out.lord = out.gazeYaw = 0;
    out.gazePitch = 80 * DEG;
    out.flat = 0.5; out.clav = 0.3; out.clavElev = 0; out.clavProt = -4 * DEG;
    for (const s of SIDES) {
      const lx = -SIGN[s]; // turned over: her left lies on the base's right
      this._at(lx * (this.hipX + 0.01 * sc), 0.1 * sc, -a, out.knee[s]);
      this._at(lx * (this.hipX + 0.035 * sc), 0.075 * sc, -(a + b * 0.98), out.ankle[s]);
      out.footF[s].copy(UP).multiplyScalar(0.8).addScaledVector(F, -0.5).addScaledVector(X, lx * 0.25).normalize();
      out.footU[s].copy(F).multiplyScalar(0.8).addScaledVector(UP, 0.5).normalize();
      out.toe[s] = 0;
      if (arms === 0) {
        this._at(lx * (this.shX + 0.13 * sc), 0.05 * sc, Ls + 0.47 * sc, out.hand[s]);
        this._at(lx * (this.shX + 0.17 * sc), 0.07 * sc, Ls + 0.2 * sc, out.elbow[s]);
        out.handF[s].copy(F);
      } else if (arms === 1) {
        this._at(lx * (this.shX + 0.5 * sc), 0.05 * sc, Ls + 0.08 * sc, out.hand[s]);
        this._at(lx * (this.shX + 0.25 * sc), 0.07 * sc, Ls + 0.02 * sc, out.elbow[s]);
        out.handF[s].copy(X).multiplyScalar(lx).addScaledVector(F, 0.2).normalize();
      } else {
        this._at(lx * (this.shX + 0.1 * sc), 0.05 * sc, Ls - 0.5 * sc, out.hand[s]);
        this._at(lx * (this.shX + 0.09 * sc), 0.065 * sc, Ls - 0.26 * sc, out.elbow[s]);
        out.handF[s].copy(F).negate().addScaledVector(X, lx * 0.2).normalize();
      }
      out.handN[s].set(0, 1, 0);
    }
    return out;
  }
  /** Rolling: on the side, the lower arm overhead, the upper hand on the floor in front of the chest. */
  _sideSpec(out) {
    const sc = this.sc, F = this._bd(0, 0, 1), sg = this.rollSign, a = this.thigh, b = this.shin, Ls = this.Ls;
    const front = this._bd(sg, 0, 0); // where her chest faces
    const D = sg > 0 ? 'R' : 'L', U = D === 'L' ? 'R' : 'L';
    this._at(0, 0.21 * sc, 0, out.hip);
    this._at(0, 0.24 * sc, Ls, out.sh);
    out.rollAll = sg * Math.PI / 2;
    out.pYaw = out.pRoll = out.cYaw = out.cRoll = out.lord = out.gazeYaw = 0;
    out.gazePitch = 75 * DEG;
    out.flat = 0.7; out.clav = 0.5; out.clavElev = 6 * DEG; out.clavProt = 6 * DEG;
    // Legs stacked, the upper one a little forward and bent.
    this._at(sg * 0.03 * sc, 0.07 * sc, -a, out.knee[D]);
    this._at(sg * 0.04 * sc, 0.07 * sc, -(a + b) * 0.99, out.ankle[D]);
    this._at(sg * 0.12 * sc, 0.19 * sc, -a * 0.92, out.knee[U]);
    this._at(sg * 0.08 * sc, 0.16 * sc, -(a + b) * 0.93, out.ankle[U]);
    for (const s of SIDES) {
      out.footF[s].copy(front).multiplyScalar(0.6).addScaledVector(F, -0.8).normalize();
      out.footU[s].copy(F).multiplyScalar(0.6).addScaledVector(front, 0.8).normalize();
      out.toe[s] = 0;
    }
    this._at(0, 0.06 * sc, Ls + 0.48 * sc, out.hand[D]);
    this._at(sg * 0.05 * sc, 0.07 * sc, Ls + 0.22 * sc, out.elbow[D]);
    out.handF[D].copy(F); out.handN[D].copy(front);
    this._at(sg * 0.3 * sc, 0.05 * sc, Ls + 0.05 * sc, out.hand[U]);
    this._at(sg * 0.12 * sc, 0.3 * sc, Ls, out.elbow[U]);
    out.handF[U].copy(F).addScaledVector(front, 0.3).normalize(); out.handN[U].set(0, -1, 0);
    return out;
  }
  /** About to roll: legs straightened, the lower arm reaching ahead, a first tilt. */
  _preRollSpec(army, out) {
    const sc = this.sc, F = this._bd(0, 0, 1), sg = this.rollSign, a = this.thigh, b = this.shin, Ls = this.Ls;
    const D = sg > 0 ? 'R' : 'L';
    copySpec(army, out);
    out.rollAll = sg * 12 * DEG;
    out.pRoll = out.cRoll = out.pYaw = 0;
    out.hip.y = this._ground() + 0.15 * sc;
    for (const s of SIDES) {
      this._at(SIGN[s] * (this.hipX + 0.02 * sc), 0.075 * sc, -a, out.knee[s]);
      this._at(SIGN[s] * (this.hipX + 0.04 * sc), 0.08 * sc, -(a + b) * 0.995, out.ankle[s]);
      out.footF[s].copy(F).multiplyScalar(-0.9).addScaledVector(UP, -0.4).normalize();
      out.footU[s].copy(UP).multiplyScalar(-0.9).addScaledVector(F, 0.4).normalize();
      out.toe[s] = 0;
    }
    this._at(SIGN[D] * (this.shX + 0.05 * sc), 0.06 * sc, Ls + 0.5 * sc, out.hand[D]);
    this._at(SIGN[D] * (this.shX + 0.08 * sc), 0.08 * sc, Ls + 0.25 * sc, out.elbow[D]);
    out.handF[D].copy(F); out.handN[D].set(0, -1, 0);
    return out;
  }

  /**
   * Sit down on the floor from standing, the way most adults do it: lower into a squat with the
   * weight kept over the feet (heels rising), reach one hand's fingertips to the floor beside the
   * hip, and sit back onto the seat with that hand and the feet taking the weight. Knocked
   * backward instead, she falls into the sit: hips dropping back, both hands thrown back to catch.
   */
  _beginSit(fall) {
    const an = this.an, sc = this.sc;
    this._snapshot(this.snap);
    this.heading = an.heading;
    this._axes();
    const ball = { L: an.feet.L.ball.clone(), R: an.feet.R.ball.clone() };
    for (const s of SIDES) ball[s].y = this._ground();
    this.sitBall = ball;
    this.origin.copy(ball.L).add(ball.R).multiplyScalar(0.5).addScaledVector(this._F, -0.7 * sc);
    this.origin.y = an.root.position.y;
    this.base = { O: this.origin.clone(), h: this.heading };
    an.root.position.copy(this.origin);
    an.root.quaternion.setFromAxisAngle(UP, this.heading);
    an._updateRootFrame();
    const K = an.rng() < 0.5 ? 'L' : 'R', Fr = K === 'L' ? 'R' : 'L';
    const P = (o) => { const sp = mkSpec(); return () => this._mk(sp, o); };
    const both = (f) => ({ L: f('L'), R: f('R') });
    const pair = (k, f) => ({ [K]: k, [Fr]: f });
    const feet = (pitch) => ({ L: { ball: ball.L, pitch }, R: { ball: ball.R, pitch } });
    const B = (x, y, z) => this._b(x * sc, y * sc, z * sc);
    // Reaching back for the floor: the lower the hand, the flatter it comes in.
    const back = (s, y = 0.14, z = -0.14) => this._reach(s, B(SIGN[s] * 0.24, y, z), SIGN[s] * 0.4, -mix(0.25, 0.8, clamp((y - 0.1) / 0.25, 0, 1)), -0.7);
    const ahead = (s, y, z) => this._reach(s, B(SIGN[s] * 0.2, y, z), 0, -0.3, 1);
    // Fingertips to the floor beside the hip (the wrist a hand's length up).
    const tips = (s, z) => ({ pos: B(SIGN[s] * 0.27, 0.17, z), F: this._bd(SIGN[s] * 0.25, -1, -0.15), N: this._bd(SIGN[s], -0.1, 0) });
    const sitSp = mkSpec();
    if (fall) {
      this.hold = 1.4;
      this._seq('sitDown', [
        { t: 0, get: () => this.snap },
        // Knees buckle, the hips drop back, the arms fly forward.
        { t: 0.3, get: P({
          hip: B(0, 0.62, 0.36), lean: 4 * DEG, gaze: -6 * DEG, feet: feet(0), knees: this._kn(0.13, 0.5, 0.7),
          hands: both((s) => this._reach(s, B(SIGN[s] * 0.27, 0.95, 0.75), SIGN[s] * 0.2, 0.1, 1)), flat: 0.1, clav: 0.3,
        }) },
        // Falling back: both hands reach back for the floor.
        { t: 0.55, get: P({
          hip: B(0, 0.3, 0.14), lean: -16 * DEG, gaze: 10 * DEG, feet: feet(0), knees: this._kn(0.14, 0.47, 0.52),
          hands: both((s) => back(s, 0.2, -0.2)), flat: 0.5, clav: 0.4,
        }) },
        // Seat and hands hit together, leaning back on the arms.
        { t: 0.72, get: P({
          hip: B(0, 0.13, 0.0), lean: -30 * DEG, lord: -10 * DEG, gaze: 14 * DEG, feet: feet(0), knees: this._kn(0.15, 0.42, 0.3),
          hands: both((s) => this._sitHand(s)), flat: 1, clav: 0.5, clavElev: 8 * DEG,
        }) },
        { t: 1.3, get: () => this._sitSpec(sitSp) },
      ], 'sit');
      return;
    }
    this._seq('sitDown', [
      { t: 0, get: () => this.snap },
      // 1. Down into a squat over the feet, arms forward to counterbalance.
      { t: 0.55, get: P({
        hip: B(0, 0.56, 0.42), lean: 34 * DEG, gaze: 24 * DEG, feet: feet(0), knees: this._kn(0.12, 0.5, 0.74),
        hands: both((s) => ahead(s, 0.8, 0.95)), flat: 0.1, clav: 0.2,
      }) },
      // 2. Deep, heels up; one hand goes down beside the hip.
      { t: 1.0, get: P({
        hip: B(0, 0.36, 0.38), lean: 38 * DEG, gaze: 22 * DEG, feet: feet(-16 * DEG), knees: this._kn(0.15, 0.48, 0.74),
        hands: pair(this._reach(K, B(SIGN[K] * 0.27, 0.28, 0.26), SIGN[K] * 0.2, -1, 0), ahead(Fr, 0.62, 0.82)), flat: 0.3, clav: 0.3,
      }) },
      // 3. Fingertips on the floor: the hand and feet hold her as the hips go back and down.
      { t: 1.3, get: P({
        hip: B(0, 0.22, 0.18), lean: 16 * DEG, gaze: 14 * DEG, feet: feet(-8 * DEG), knees: this._kn(0.15, 0.46, 0.55),
        hands: pair(tips(K, 0.08), ahead(Fr, 0.45, 0.6)), flat: 0.5, clav: 0.4,
      }) },
      // 4. On the seat; the hand walks back, the other reaches back too.
      { t: 1.6, get: P({
        hip: B(0, 0.135, 0.03), lean: -10 * DEG, lord: -6 * DEG, gaze: 8 * DEG, feet: feet(0), knees: this._kn(0.14, 0.44, 0.32),
        hands: pair(this._sitHand(K), back(Fr, 0.13, -0.2)), flat: 0.9, clav: 0.4,
      }) },
      { t: 2.0, get: () => this._sitSpec(sitSp) },
    ], 'sit');
  }

  /**
   * From sitting back up to standing: lean forward with a hand pushing on the floor beside the
   * hip until the seat lifts, then a short rock forward over the feet and up.
   */
  _beginSitUp() {
    const an = this.an, sc = this.sc;
    this.base = { O: this.origin.clone(), h: this.heading };
    an._resetStance(this.sitBall);
    const K = an.rng() < 0.5 ? 'L' : 'R', Fr = K === 'L' ? 'R' : 'L';
    const P = (o) => { const sp = mkSpec(); return () => this._mk(sp, o); };
    const pair = (k, f) => ({ [K]: k, [Fr]: f });
    const both = (f) => ({ L: f('L'), R: f('R') });
    const B = (x, y, z) => this._b(x * sc, y * sc, z * sc);
    const feet = (pitch) => ({ L: { ball: this.sitBall.L, pitch }, R: { ball: this.sitBall.R, pitch } });
    const push = (z, y = 0.045) => ({ pos: B(SIGN[K] * 0.26, y, z), F: this._bd(SIGN[K] * 0.75, 0, -0.65), N: new THREE.Vector3(0, -1, 0) });
    const kn1 = this._kn(0.13, 0.45, 0.4), kn2 = this._kn(0.12, 0.47, 0.66);
    const sitSp = mkSpec();
    this._seq('sitUp', [
      { t: 0, get: () => this._sitSpec(sitSp) },
      // 1. Lean in, the hand set beside the hip, the other on the knee.
      { t: 0.45, get: P({
        hip: B(0, 0.135, 0.06), lean: 20 * DEG, gaze: 16 * DEG, feet: feet(0), knees: kn1,
        hands: pair(push(0.06), this._onKnee(Fr, kn1[Fr])), flat: 0.8, clav: 0.5,
      }) },
      // 2. The push: the seat lifts, fingertips still on the floor.
      { t: 0.8, get: P({
        hip: B(0, 0.24, 0.2), lean: 40 * DEG, gaze: 18 * DEG, feet: feet(0), knees: kn2,
        hands: pair({ pos: B(SIGN[K] * 0.26, 0.17, 0.2), F: this._bd(SIGN[K] * 0.5, -0.7, -0.3), N: this._bd(SIGN[K] * 0.7, -0.7, 0) }, this._onKnee(Fr, kn2[Fr])),
        flat: 0.4, clav: 0.3,
      }) },
      // 3. Rocked forward over the feet.
      { t: 1.05, get: P({
        hip: B(0, 0.42, 0.42), lean: 40 * DEG, gaze: 18 * DEG, feet: feet(0), knees: this._kn(0.12, 0.48, 0.74),
        hands: both((s) => this._reach(s, B(SIGN[s] * 0.22, 0.5, 0.72), 0, -0.6, 0.8)),
      }) },
      // 4. Rising.
      { t: 1.5, get: P({
        hip: B(0, 0.72, 0.5), lean: 20 * DEG, gaze: 8 * DEG, feet: feet(0), knees: this._kn(0.11, 0.5, 0.66),
        hands: both((s) => this._reach(s, B(SIGN[s] * 0.22, 0.62, 0.55), 0, -1, 0.25)),
      }) },
      { t: 1.95, get: () => this.stand },
    ], 'stand', null, { liveStand: true });
  }

  _beginToLie() {
    const a = mkSpec(), b = mkSpec(), c = mkSpec();
    this._seq('toLie', [
      { t: 0, get: () => this._sitSpec(a) },
      { t: 0.75, get: () => this._elbowsSpec(b) },
      { t: 1.55, get: () => this._lieSpec(c) },
    ], 'lie', (i, u, spec) => {
      // The hands lift as they move from behind the hips to under the elbows, and out to the sides.
      const l = 0.05 * this.sc * Math.sin(Math.PI * u);
      for (const s of SIDES) spec.hand[s].y += l;
    });
  }
  _beginFromLie() {
    const a = mkSpec(), b = mkSpec(), c = mkSpec();
    this._seq('fromLie', [
      { t: 0, get: () => this._lieSpec(a) },
      { t: 0.7, get: () => this._elbowsSpec(b) },
      { t: 1.45, get: () => this._sitSpec(c) },
    ], 'sit', (i, u, spec) => {
      const l = 0.05 * this.sc * Math.sin(Math.PI * u);
      for (const s of SIDES) spec.hand[s].y += l;
    });
  }

  /** Army crawl → on the back: straighten the legs, reach ahead with the lower arm, roll over it. */
  _beginToBack() {
    this.rollSign = this.an.rng() < 0.5 ? 1 : -1;
    this.base = { O: this.origin.clone(), h: this.heading };
    const a = mkSpec(), b = mkSpec(), c = mkSpec(), d = mkSpec(), e = mkSpec();
    this._seq('toBack', [
      { t: 0, get: () => this.specB },
      { t: 0.5, get: () => this._preRollSpec(this.specB, a) },
      { t: 1.05, get: () => this._sideSpec(b) },
      { t: 1.8, get: () => this._backSpec(c, 0) },
      { t: 2.25, get: () => this._backSpec(d, 1) },
      { t: 2.75, get: () => this._backSpec(e, 2) },
    ], 'back', (i, u, spec) => { if (i === 2) this._overArm(spec, u); });
  }
  _beginFromBack() {
    this.base = { O: this.origin.clone(), h: this.heading };
    const a = mkSpec(), b = mkSpec(), c = mkSpec(), d = mkSpec(), e = mkSpec();
    this._seq('fromBack', [
      { t: 0, get: () => this._backSpec(a, 2) },
      { t: 0.5, get: () => this._backSpec(d, 1) },
      { t: 0.95, get: () => this._backSpec(e, 0) },
      { t: 1.7, get: () => this._sideSpec(b) },
      { t: 2.25, get: () => this._preRollSpec(this.specB, c) },
      { t: 2.8, get: () => this.specB },
    ], 'army', (i, u, spec) => { if (i === 2) this._overArm(spec, u); });
  }
  /** Between the side and the back, the upper arm swings over the body in an arc. */
  _overArm(spec, u) {
    const U = this.rollSign > 0 ? 'L' : 'R', l = Math.sin(Math.PI * u) * this.sc;
    spec.hand[U].y += 0.38 * l; spec.elbow[U].y += 0.25 * l;
  }

  _initHk(knees) {
    const g = this._ground();
    this.active = false; this.phase = 0.14; this.v.x = this.v.v = 0; this.yawRate.x = this.yawRate.v = 0;
    const m = this._hkDims();
    this.hipH.x = m.hipH; this.shH.x = m.shH; this.hipH.v = this.shH.v = 0;
    for (const k in this.hk) {
      const l = this.hk[k];
      l.swing = false; l.s = 0;
      if (knees && k[0] === 'k') l.pos.copy(knees[k[1]]);
      else this._pt(...this._hkNominal(k, this._v[0]).toArray(), l.pos);
      l.pos.y = g + this._hkNominal(k, this._v[0]).y;
    }
  }

  _initArmy() {
    const g = this._ground();
    this.active = false; this.phase = 0.02; this.v.x = this.v.v = 0;
    this.armyShH.x = 0.2 * this.sc; this.armyShH.v = 0;
    for (const s of SIDES) {
      const l = this.army['e' + s];
      l.swing = false; l.s = 0;
      const n = this._armyNominal(s, this._v[0]);
      this._pt(n.x, 0, n.z, l.pos); l.pos.y = g + n.y;
    }
    // At rest: the right knee drawn up, the left leg long (the phase the gait stops in).
    this.army.thL = 8 * DEG; this.army.thR = 62 * DEG;
  }

  // ---------------------------------------------------------------------------
  // Pose
  // ---------------------------------------------------------------------------
  /** Called after the standing animator has posed the bones. */
  apply() {
    if (!this.owns) return;
    if (this._needSnap) {
      const k = this._needSnap;
      this._needSnap = null;
      if (k === 'sit' || k === 'fallBack') this._beginSit(k === 'fallBack');
      else if (k === 'fallFwd') this._beginFallFwd();
      else this._beginDown();
    }
    if (this.keys?.liveStand) this._snapshot(this.stand);
    let spec;
    const st = this.state;
    if (this.keys) {
      const K = this.keys;
      // Live keys read the current crawl postures.
      if (HK_LIVE.has(st)) this._hkSpec(this.specA);
      if (ARMY_LIVE.has(st)) this._armySpec(this.specB);
      K.keys.forEach((k, i) => specToArr(k.get(), K.arrs[i]));
      const out = this._arr || (this._arr = new Float64Array(SPEC_N));
      const t = Math.min(this.t, K.total);
      pchip(K.keys, K.arrs, t, out, 0, SPEC_N);
      // The eyes lead the body a little.
      pchip(K.keys, K.arrs, Math.min(t + 0.1, K.total), out, GAZE_I, GAZE_I + 2);
      spec = arrToSpec(out, this.spec);
      if (K.bump) {
        let i = 0;
        while (i < K.keys.length - 2 && t >= K.keys[i + 1].t) i++;
        K.bump(i, clamp((t - K.keys[i].t) / (K.keys[i + 1].t - K.keys[i].t), 0, 1), spec);
      }
      // Interpolated ankles cut the chord of a foot's roll about its ball: keep ball and heel on or
      // above the floor.
      const d = this.an.dims, g = this._ground();
      for (const sd of SIDES) {
        const A = spec.ankle[sd], Fv = spec.footF[sd], Uv = spec.footU[sd];
        const ball = A.y + Fv.y * d.ballFwd - Uv.y * d.ankleH;
        const heel = A.y - Fv.y * d.heelBack - Uv.y * d.ankleH;
        const lift = Math.max(0, g - ball, g - heel);
        A.y += lift;
      }
      // The upper trunk carries weight: the shoulders lag a little behind the pose and settle
      // (the hips stay exact, they carry the legs' contacts; faded out before the end, so the
      // hand-over is exact).
      const dt = this.an._poseDt || 1 / 60;
      if (!this._filt) this._filt = { x: spec.sh.clone(), v: V() };
      const f = this._filt, w = 1 - smoothstep(0.8, 1, t / K.total), om = 14, ze = 0.7;
      f.v.addScaledVector(this._v[0].copy(spec.sh).sub(f.x).multiplyScalar(om * om).addScaledVector(f.v, -2 * ze * om), dt);
      f.x.addScaledVector(f.v, dt);
      spec.sh.lerp(f.x, w);
    } else if (st === 'hk') spec = this._hkSpec(this.spec);
    else if (st === 'army') spec = this._armySpec(this.spec);
    else if (st === 'back') spec = this._backSpec(this.spec);
    else if (st === 'sit') spec = this._sitSpec(this.spec);
    else if (st === 'lie') spec = this._lieSpec(this.spec);
    else return;
    this._solve(spec);
  }

  /**
   * Two-bone IK whose middle joint (knee / elbow) stays at least `clear`·sc above the floor: a pole
   * that would put it through the floor is tipped upward until it clears.
   */
  _limbIK(A, target, pole, a, b, clear) {
    const an = this.an, floor = this._ground() + clear * this.sc;
    let ik = an._twoBone(A, target, pole, a, b, 0.9995, an._ikOut());
    for (let i = 0; i < 4; i++) {
      const midY = A.y + ik.upper.y * a;
      if (midY >= floor) break;
      pole.addScaledVector(UP, (floor - midY) / a * 4 + 0.1).normalize();
      ik = an._twoBone(A, target, pole, a, b, 0.9995, an._ikOut());
    }
    return ik;
  }
  /** A target too close to fold the joint past `maxFlex`° is moved out along the same direction. */
  _foldLimit(A, target, a, b, maxFlex) {
    const dMin = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos((180 - maxFlex) * DEG));
    const d = target.distanceTo(A);
    if (d >= dMin || d < 1e-6) return target;
    return (this._fl ||= V()).copy(target).sub(A).multiplyScalar(dMin / d).add(A);
  }

  _solve(S) {
    const an = this.an, d = an.dims, b = an.bones, R = an.rest, q = this._q, v = this._v;
    an._updateRootFrame();
    const rootQ = an._rootQ, rootQi = an._rootQInv;
    const toChar = (w, out) => out.copy(w).applyQuaternion(rootQi);

    // ---- Trunk: pelvis + spine toward the shoulder point, head toward the gaze ----
    const axW = v[0].copy(S.sh).sub(S.hip);
    const axC = toChar(axW, v[1]);
    const P0 = Math.atan2(axC.z, axC.y);
    let P = P0;
    // Rolled over: everything built as if lying face down, then turned about the trunk's long axis.
    const Ra = (this._qa ||= new THREE.Quaternion()).setFromAxisAngle((this._axU ||= V()).copy(axC).normalize(), S.rollAll);
    const Rp = q[0], Rc = q[1], E = q[2], I = q[3].identity();
    const poseTrunk = () => {
      quatYawRollPitch(S.pYaw, S.pRoll, P + S.lord, Rp).premultiply(Ra);
      quatYawRollPitch(S.cYaw, S.cRoll, P - S.lord * 0.6, Rc).premultiply(Ra);
      an._setCharRotation('Hips', Rp);
      const hipsW = v[2].copy(this.m0).applyQuaternion(Rp).applyQuaternion(rootQ);
      hipsW.subVectors(S.hip, hipsW);
      b.Hips.parent.updateWorldMatrix(true, false);
      b.Hips.position.copy(b.Hips.parent.worldToLocal(hipsW));
      E.copy(Rp).invert().multiply(Rc);
      const w = [0.3, 0.35, 0.35];
      ['Spine', 'Spine1', 'Spine2'].forEach((k, i) => an._setCharRotation(k, q[4].copy(I).slerp(E, w[i])));
    };
    poseTrunk();
    // One correction pass: aim the actual shoulder line at the wanted shoulder point.
    an.model.updateMatrixWorld(true);
    const shA = v[3].copy(b.LeftArm.getWorldPosition(v[4])).add(b.RightArm.getWorldPosition(v[5])).multiplyScalar(0.5);
    const axA = toChar(shA.sub(S.hip), v[4]);
    P += Math.cos(S.rollAll) * (P0 - Math.atan2(axA.z, axA.y)); // a roll turns the pitch error over
    poseTrunk();
    // Head: the remaining rotation to the gaze, split over neck and head.
    const Rh = quatYawRollPitch(S.gazeYaw, 0, S.gazePitch, q[5]).premultiply(Ra);
    const Eh = q[6].copy(Rc).invert().multiply(Rh);
    // The cervical spine bends ~65° at most (extension looking up while prone, flexion lying back).
    const eAng = 2 * Math.acos(clamp(Math.abs(Eh.w), 0, 1)), eMax = 65 * DEG;
    if (eAng > eMax) Eh.slerp(q[3], 1 - eMax / eAng);
    an._setCharRotation('Neck', q[4].copy(I).slerp(Eh, 0.45));
    an._setCharRotation('Head', q[7].copy(q[4]).invert().multiply(Eh));
    // Clavicles: protracted and set for weight bearing.
    for (const s of SIDES) {
      const key = NAME[s] + 'Shoulder';
      if (!b[key] || S.clav <= 0) continue;
      const before = q[4].copy(b[key].quaternion);
      const cq = quatYawRollPitch(-S.clavProt, S.clavElev, 0, q[5]);
      if (s === 'R') mirrorQuat(cq);
      an._setCharRotation(key, cq);
      b[key].quaternion.copy(before.slerp(b[key].quaternion, S.clav));
    }
    an.model.updateMatrixWorld(true);

    // ---- Arms: IK to the hands, elbows toward their points ----
    for (const s of SIDES) {
      const N = NAME[s], c = an.chains['arm' + s];
      const Sh = b[c.up].getWorldPosition(v[5]);
      const pole = v[6].copy(Sh).add(S.hand[s]).multiplyScalar(-0.5).add(S.elbow[s]);
      if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0);
      pole.normalize();
      const ik = this._limbIK(Sh, this._foldLimit(Sh, S.hand[s], c.a, c.b, 145), pole, c.a, c.b, 0.045);
      const upperW = q[4], lowerW = q[5];
      an._applyChain(c, ik, upperW, lowerW);
      // Wrist limit: past ~95° of bend the fingers lift (the heel of the hand stays down) rather
      // than the wrist folding further.
      const hF = this._hF ||= V(), hN = this._hN ||= V();
      hF.copy(S.handF[s]); hN.copy(S.handN[s]);
      const wAng = hF.angleTo(ik.lower), wMax = 95 * DEG;
      if (wAng > wMax) {
        const ax = v[9].crossVectors(hF, ik.lower);
        if (ax.lengthSq() > 1e-8) { ax.normalize(); hF.applyAxisAngle(ax, wAng - wMax); hN.applyAxisAngle(ax, wAng - wMax); }
      }
      // Hand: fingers along handF, palm facing handN; part of the twist goes to the forearm.
      const axisC = toChar(hF, v[7]), palmC = toChar(hN, v[8]);
      const handR = frameQuat(axisC, palmC, q[6]).multiply(c.restHandInv);
      const handW = q[7].copy(rootQ).multiply(handR).multiply(R[N + 'Hand'].charQ);
      const palmNow = v[9].copy(c.palm0).applyQuaternion(q[2].copy(R[c.mid].charQ).invert()).applyQuaternion(lowerW);
      const ax = v[10].copy(ik.lower);
      const pd = v[11].copy(hN).addScaledVector(ax, -hN.dot(ax));
      if (pd.lengthSq() > 1e-6) {
        pd.normalize();
        palmNow.addScaledVector(ax, -palmNow.dot(ax)).normalize();
        const twist = Math.atan2(v[0].crossVectors(palmNow, pd).dot(ax), clamp(palmNow.dot(pd), -1, 1));
        lowerW.premultiply(q[2].setFromAxisAngle(ax, twist * 0.55));
        b[c.mid].quaternion.copy(q[2].copy(upperW).invert()).multiply(lowerW);
      }
      b[N + 'Hand'].quaternion.copy(q[2].copy(lowerW).invert()).multiply(handW);
    }

    // ---- Legs: IK to the ankles, knees toward their points; feet as specified ----
    for (const s of SIDES) {
      const N = NAME[s], c = an.chains['leg' + s];
      const H = b[c.up].getWorldPosition(v[5]);
      const pole = v[6].copy(H).add(S.ankle[s]).multiplyScalar(-0.5).add(S.knee[s]);
      if (pole.lengthSq() < 1e-8) pole.copy(S.footF[s]);
      pole.normalize();
      const ik = this._limbIK(H, this._foldLimit(H, S.ankle[s], c.a, c.b, 152), pole, c.a, c.b, 0.05);
      const upperW = q[4], lowerW = q[5];
      an._applyChain(c, ik, upperW, lowerW);
      const Fc = toChar(S.footF[s], v[7]).normalize();
      const Uc = toChar(S.footU[s], v[8]);
      Uc.addScaledVector(Fc, -Uc.dot(Fc)).normalize();
      const Xc = v[9].crossVectors(Uc, Fc);
      const footR = q[6].setFromRotationMatrix(this._m.makeBasis(Xc, Uc, Fc));
      const footW = q[7].copy(rootQ).multiply(footR).multiply(R[N + 'Foot'].charQ);
      b[N + 'Foot'].quaternion.copy(q[2].copy(lowerW).invert()).multiply(footW);
      if (b[N + 'ToeBase']) an._setCharRotation(N + 'ToeBase', q[2].setFromAxisAngle(v[0].set(1, 0, 0), -S.toe[s]));
    }

    // ---- Fingers: flat on the floor ----
    if (S.flat > 0) {
      for (const s of SIDES) {
        const N = NAME[s], axis = v[0].set(0, 0, SIGN[s]);
        for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
          for (let j = 0; j < 3; j++) {
            const key = `${N}Hand${f}${j + 1}`;
            if (!b[key]) continue;
            const before = q[4].copy(b[key].quaternion);
            an._setCharRotation(key, q[5].setFromAxisAngle(axis, -[6, 5, 3][j] * DEG));
            b[key].quaternion.copy(before.slerp(b[key].quaternion, S.flat));
          }
        }
        // Thumb along the floor, spread ~35° from the fingers (left-hand pose, mirrored).
        for (let j = 1; j <= 3; j++) {
          const key = `${N}HandThumb${j}`;
          if (!b[key]) continue;
          const before = q[4].copy(b[key].quaternion);
          const tq = j === 1 ? q[5].setFromEuler(THUMB_FLAT) : q[5].identity();
          if (s === 'R') mirrorQuat(tq);
          an._setCharRotation(key, tq);
          b[key].quaternion.copy(before.slerp(b[key].quaternion, S.flat));
        }
      }
    }
  }
}
