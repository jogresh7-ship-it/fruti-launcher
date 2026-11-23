// Active ragdoll: the animator's mesh-fitted segments remain connected by physical joints, while
// capped muscles apply their own torques instead of making the skeleton a rigid animation puppet.
// Rapier handles contacts and momentum; target-following muscles yield under impacts, with passive
// anatomical stops and balance pins retained for the game's existing Euphoria behaviour interface.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

// name, bone, parent part, capsule keys (from the animator's mesh-fitted capsules), mass fraction (Winter).
function partList() {
  const p = [
    ['pelvis', 'Hips', null, ['Hips'], 0.142],
    ['spine', 'Spine', 'pelvis', ['Spine'], 0.1],
    ['spine1', 'Spine1', 'spine', ['Spine1'], 0.12],
    ['chest', 'Spine2', 'spine1', ['Spine2'], 0.135],
    ['neck', 'Neck', 'chest', [], 0.012],
    ['head', 'Head', 'neck', ['Head'], 0.069],
  ];
  for (const [s, N] of [['L', 'Left'], ['R', 'Right']]) {
    p.push(
      ['upperArm' + s, N + 'Arm', 'chest', [N + 'Arm'], 0.028],
      ['foreArm' + s, N + 'ForeArm', 'upperArm' + s, [N + 'ForeArm'], 0.016],
      ['hand' + s, N + 'Hand', 'foreArm' + s, [N + 'Hand'], 0.006],
      ['thigh' + s, N + 'UpLeg', 'pelvis', [N + 'UpLegFull'], 0.1],
      ['shin' + s, N + 'Leg', 'thigh' + s, [N + 'Leg'], 0.0465],
      ['foot' + s, N + 'Foot', 'shin' + s, [N + 'Foot', N + 'ToeBase'], 0.0145],
    );
  }
  return p;
}

// Joint limits relative to the bind pose: swing toward ref1 / ref2 (degrees, + = the bone's tip moves
// toward that direction) and twist about the bone. Refs: F forward, U up, X her left, O outward (side).
const LIMITS = {
  spine: { r1: 'F', a: [-20, 35], r2: 'X', b: [-20, 20], t: [-20, 20] },
  spine1: { r1: 'F', a: [-20, 35], r2: 'X', b: [-20, 20], t: [-20, 20] },
  chest: { r1: 'F', a: [-20, 30], r2: 'X', b: [-18, 18], t: [-20, 20] },
  neck: { r1: 'F', a: [-35, 45], r2: 'X', b: [-25, 25], t: [-40, 40] },
  head: { r1: 'F', a: [-30, 30], r2: 'X', b: [-20, 20], t: [-40, 40] },
  upperArm: { r1: 'F', a: [-45, 135], r2: 'U', b: [-100, 80], t: [-80, 80] },
  foreArm: { r1: 'F', a: [-3, 150], r2: 'U', b: [-6, 6], t: [-85, 85] },
  hand: { r1: 'F', a: [-30, 30], r2: 'U', b: [-70, 70], t: [-10, 10] },
  thigh: { r1: 'F', a: [-25, 120], r2: 'O', b: [-25, 50], t: [-40, 40] },
  shin: { r1: 'F', a: [-150, 3], r2: 'O', b: [-5, 5], t: [-25, 25] },
  foot: { r1: 'U', a: [-50, 22], r2: 'O', b: [-12, 12], t: [-22, 22] }, // (dorsiflexion capped at 22°: toes never cock up at the front)
};
const LIMIT_BETA = 0.2; // firmer anatomical stops while keeping corrections stable at 240 Hz
const MIN_INERTIA = 0.004; // kg·m²: a small numerical floor without making hands/feet unrealistically sluggish

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _kp = new THREE.Vector3(), _kq = new THREE.Quaternion();
const _wb1 = new THREE.Quaternion(), _wb2 = new THREE.Quaternion(), _wb3 = new THREE.Quaternion();

/** Rotation vector (axis·angle, shortest way) of a quaternion. */
function rotVec(q, out) {
  const w = Math.max(-1, Math.min(1, q.w)), s = Math.sqrt(Math.max(0, 1 - w * w));
  const a = 2 * Math.acos(Math.abs(w)) * (w < 0 ? -1 : 1);
  if (s < 1e-6) return out.set(q.x * 2, q.y * 2, q.z * 2);
  return out.set(q.x / s * a, q.y / s * a, q.z / s * a);
}

/** The ragdoll part a capsule of the animator (see _fitCapsules) belongs to. */
export function partForCap(key) {
  const s = key.startsWith('Left') ? 'L' : key.startsWith('Right') ? 'R' : '';
  const k = key.replace(/^(Left|Right)/, '');
  if (/^Hand/.test(k)) return 'hand' + s;
  if (/^ForeArm/.test(k)) return 'foreArm' + s;
  if (/^Arm/.test(k)) return 'upperArm' + s;
  if (/^UpLeg/.test(k)) return 'thigh' + s;
  if (/^Leg/.test(k)) return 'shin' + s;
  if (/^(Foot|ToeBase)/.test(k)) return 'foot' + s;
  if (/^Flank|^Waist|^Hips/.test(key)) return 'pelvis';
  return { Spine: 'spine', Spine1: 'spine1', Spine2: 'chest', Neck: 'neck', Head: 'head' }[key] || 'chest';
}

export class Ragdoll {
  constructor(physics, an) {
    this.ph = physics;
    this.R = physics.R;
    this.an = an;
    this.dynamic = false;
    this.animationPhysics = false; // dynamic collision-aware tracking while walking and getting up
    this.assisted = false; // true when the animation is the muscle target, not a free fall behavior
    // Momentum carry: a push or a fall gives the whole body a velocity. The muscle/pin TARGETS keep travelling
    // with it (and ease back), so the pins steer the body instead of braking it. (carry m/s, carryOff m)
    this.carry = new THREE.Vector3(); this.carryOff = new THREE.Vector3(); this.carryCap = 0.3; this.carryTau = 0.9;
    this.crouch = 0; // m the hips sink: the stumble crouch (nm.js eases it; lowers every muscle target except the feet)
    this.blendIn = null; // see beginBlendIn(): eases the muscle targets from the physical pose into an animation
    this.flatten = 1; // plantar reflex strength: planted soles are levelled to the ground (0 = off)
    this.parts = [];
    this.byName = {};
    this._build();
  }

  _build() {
    const R = this.R, world = this.ph.world, an = this.an, mass = an.mass;
    an.model.updateMatrixWorld(true);
    const rootQ = an._rootQ;
    for (const [name, boneKey, parentName, capKeys, frac] of partList()) {
      const bone = an.bones[boneKey];
      const pos = bone.getWorldPosition(new THREE.Vector3()), quat = bone.getWorldQuaternion(new THREE.Quaternion());
      const inv = quat.clone().invert();
      const toLocal = (w) => w.clone().sub(pos).applyQuaternion(inv);
      // Capsules: the animator's, or (neck) one from this bone to the head.
      const segs = [];
      for (const k of capKeys) {
        const c = an.caps[k] || an.caps[k.replace('Full', '')];
        if (!c) continue;
        const r = k.endsWith('Full') ? an.caps[k.replace('Full', '')].r : c.r;
        segs.push({ a: toLocal(c.a.clone().applyMatrix4(bone.matrixWorld)), b: toLocal(c.b.clone().applyMatrix4(bone.matrixWorld)), r });
      }
      if (!segs.length) segs.push({ a: new THREE.Vector3(), b: toLocal(an.bones.Head.getWorldPosition(new THREE.Vector3())), r: 0.045 * an.dims.L / 0.888 });
      const vol = segs.map((s) => Math.PI * s.r * s.r * (s.a.distanceTo(s.b) + (4 / 3) * s.r));
      const vTot = vol.reduce((a, b) => a + b, 0);
      const m = mass * frac;
      const rb = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pos.x, pos.y, pos.z).setRotation(quat)
        .setLinearDamping(0.05).setAngularDamping(0.3).setCanSleep(false).setCcdEnabled(true));
      const colliders = segs.map((s) => {
        const mid = s.a.clone().add(s.b).multiplyScalar(0.5), dir = s.b.clone().sub(s.a);
        const half = Math.max(dir.length() / 2, 1e-3);
        const rot = new THREE.Quaternion().setFromUnitVectors(UP, dir.lengthSq() > 1e-8 ? dir.normalize() : UP);
        const d = R.ColliderDesc.capsule(half, s.r).setTranslation(mid.x, mid.y, mid.z).setRotation(rot)
          .setDensity(m / vTot).setFriction(0.65).setRestitution(0.0)
          .setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
        return world.createCollider(d, rb);
      });
      // A rounded capsule foot can roll onto its toe or heel instead of settling sole-down. Keep
      // the mesh-fitted capsules, but add a broad sole collider and retain its frame for terrain fit.
      let soleCenterLocal = null, soleUpLocal = null, soleHalfHeight = 0, soleFrame = null;
      if (name.startsWith('foot') && segs.length) {
        const scale = an.dims.L / 0.888;
        const localUp = UP.clone().applyQuaternion(inv).normalize();
        const forward = (segs[1]?.b.clone().sub(segs[1].a) || segs[0].b.clone().sub(segs[0].a));
        forward.addScaledVector(localUp, -forward.dot(localUp));
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(localUp, forward).normalize();
        const points = segs.flatMap((s) => [s.a, s.b]);
        const dotRange = (axis) => {
          let lo = Infinity, hi = -Infinity;
          for (const v of points) { const d = v.dot(axis); lo = Math.min(lo, d); hi = Math.max(hi, d); }
          return [lo, hi];
        };
        const [x0, x1] = dotRange(right), [y0] = dotRange(localUp), [z0raw, z1] = dotRange(forward);
        const radius = Math.max(...segs.map((s) => s.r));
        // The capsules start at the ankle, so the heel hung in the air and the foot rocked toe-down
        // on its ball. The plate now runs from the heel to the toe tip, flat, with rounded edges.
        const heel = Math.min(an.dims.heelBack || 0.05 * scale, 0.075 * scale);
        const z0 = z0raw - heel;
        const border = 0.006 * scale; // bevel so the toe/heel edge rolls over instead of catching
        const halfWidth = Math.max((x1 - x0) * 0.5 + radius * 0.4, 0.03 * scale);
        const halfLength = Math.max((z1 - z0) * 0.5 + radius * 0.4, 0.08 * scale);
        const halfHeight = 0.014 * scale;
        const center = right.clone().multiplyScalar((x0 + x1) * 0.5)
          .addScaledVector(forward, (z0 + z1) * 0.5)
          .addScaledVector(localUp, y0 - radius + halfHeight + 0.002 * scale);
        const basis = new THREE.Matrix4().makeBasis(right, localUp, forward);
        const soleQ = new THREE.Quaternion().setFromRotationMatrix(basis);
        soleCenterLocal = center.clone(); soleUpLocal = localUp.clone(); soleHalfHeight = halfHeight;
        soleFrame = { right: right.clone(), forward: forward.clone(), halfWidth, halfLength, halfHeight };
        const sole = R.ColliderDesc.roundCuboid(Math.max(halfWidth - border, 0.005), Math.max(halfHeight - border * 0.5, 0.004), Math.max(halfLength - border, 0.005), border)
          .setTranslation(center.x, center.y, center.z).setRotation(soleQ)
          .setMass(0.001).setFriction(0.95).setRestitution(0)
          .setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
        colliders.push(world.createCollider(sole, rb));
      }
      // Compute the compound capsule's center and inertia from every collider, not just the
      // first segment (feet include both the foot and toe). This keeps muscle torques calibrated.
      const comLocal = new THREE.Vector3();
      for (let i = 0; i < segs.length; i++) comLocal.addScaledVector(segs[i].a.clone().add(segs[i].b).multiplyScalar(0.5), vol[i]);
      comLocal.divideScalar(vTot);
      const ax = segs[0].b.clone().sub(segs[0].a);
      const axisLocal = ax.lengthSq() > 1e-8 ? ax.normalize() : new THREE.Vector3(0, 1, 0);
      let Icom = 0, Iax = 0, lenSq = 0, maxRadius = 0;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i], mi = m * vol[i] / vTot;
        const mid = seg.a.clone().add(seg.b).multiplyScalar(0.5);
        const d = mid.sub(comLocal), length = seg.a.distanceTo(seg.b);
        Icom += mi * (length * length / 12 + seg.r * seg.r / 4 + d.lengthSq());
        const axialOffset = d.lengthSq() - d.dot(axisLocal) ** 2;
        Iax += mi * (seg.r * seg.r / 2 + Math.max(0, axialOffset));
        lenSq += vol[i] * (length + 2 * seg.r) ** 2;
        maxRadius = Math.max(maxRadius, seg.r);
      }
      const extra = Math.max(0, MIN_INERTIA - Icom);
      if (extra > 0) rb.setAdditionalMassProperties(0, { x: 0, y: 0, z: 0 }, { x: extra, y: extra, z: extra }, { x: 0, y: 0, z: 0, w: 1 }, false);
      const part = {
        restFrame: an.rest[boneKey].charQ.clone().invert(), // body frame ← her (character) frame, in the bind pose
        Icom: Icom + extra, Iax: Iax + extra, r: maxRadius, segments: segs,
        axisLocal,
        name, kind: name.replace(/[LR]$/, ''), side: /[LR]$/.test(name) ? name.slice(-1) : null,
        bone, rb, colliders, mass: m, len: Math.sqrt(lenSq / vTot),
        comLocal, soleCenterLocal, soleUpLocal, soleHalfHeight, soleFrame,
        parent: parentName ? this.byName[parentName] : null, children: [],
        tPos: pos.clone(), tQuat: quat.clone(), tVel: new THREE.Vector3(), tAng: new THREE.Vector3(),
        prevPos: pos.clone(), prevQuat: quat.clone(),
        pin: 0, pinRot: 0, // pin weights toward the animated pose
      };
      if (part.parent) part.parent.children.push(part);
      this.parts.push(part);
      this.byName[name] = part;
    }
    // Joints: at each child bone's origin.
    for (const p of this.parts) {
      if (!p.parent) continue;
      const P = p.parent;
      const a1 = p.tPos.clone().sub(P.tPos).applyQuaternion(P.tQuat.clone().invert());
      const jd = R.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: 0, y: 0, z: 0 });
      p.joint = world.createImpulseJoint(jd, P.rb, p.rb, true);
      p.joint.setContactsEnabled(false);
      this._setupJoint(p);
    }
    // Self-collision: parts that overlap where they meet never collide (pelvis–thighs, chest–upper
    // arms, the spine segments, neck–chest, and anything two joints apart along a chain).
    const near = (a, b) => a.parent === b || b.parent === a || a.parent && a.parent === b.parent || a.parent?.parent === b || b.parent?.parent === a;
    for (const a of this.parts) for (const b of this.parts) {
      const torso = (q) => /pelvis|spine|chest|neck/.test(q.kind);
      if (a === b || !(near(a, b) || (torso(a) && torso(b)) || (a.kind === 'thigh' && b.kind === 'thigh') || (a.kind === 'upperArm' && /spine|chest/.test(b.kind)))) continue;
      for (const ca of a.colliders) for (const cb of b.colliders) this.ph.exclude(ca.handle, cb.handle);
    }
    this.totalMass = this.parts.reduce((s, q) => s + q.mass, 0);
    this._subtree();
    this._ctl = (dt, frac) => this._control(dt, frac);
    this.ph.onStep.push(this._ctl);
  }

  /** Joint frames (bind pose): twist axis along the bone, swing axes toward the reference directions. */
  _setupJoint(p) {
    const an = this.an, R = an.rest, P = p.parent;
    const key = (b) => b.name.replace(/^mixamorig\d*[:_]?/i, '').replace(/^.*[:|]/, '');
    const qP = R[key(P.bone)].charQ, qC = R[key(p.bone)].charQ;
    p.restRel = qP.clone().invert().multiply(qC);
    // Bone direction (child local): toward its first child bone in the bind pose.
    const childBone = p.kind === 'hand' ? an.bones[key(p.bone) + 'Middle1'] || p.bone.children.find((o) => o.isBone)
      : p.children[0]?.bone || p.bone.children.find((o) => o.isBone);
    const dirChar = childBone
      ? R[key(childBone)] ? R[key(childBone)].charPos.clone().sub(R[key(p.bone)].charPos) : new THREE.Vector3(0, 1, 0).applyQuaternion(qC)
      : new THREE.Vector3(0, 1, 0).applyQuaternion(qC);
    if (p.kind === 'foot' && R[key(p.bone).replace('Foot', 'ToeBase')]) dirChar.copy(R[key(p.bone).replace('Foot', 'ToeBase')].charPos).sub(R[key(p.bone)].charPos);
    if (p.kind === 'head') dirChar.set(0, 1, 0);
    const toLocal = qC.clone().invert();
    const T = dirChar.normalize().applyQuaternion(toLocal);
    const sideSign = p.side === 'R' ? -1 : 1;
    const refChar = { F: new THREE.Vector3(0, 0, 1), U: new THREE.Vector3(0, 1, 0), X: new THREE.Vector3(1, 0, 0), O: new THREE.Vector3(sideSign, 0, 0) };
    const lim = LIMITS[p.kind];
    const axis = (r) => {
      const ref = refChar[r].clone().applyQuaternion(toLocal);
      ref.addScaledVector(T, -ref.dot(T));
      return new THREE.Vector3().crossVectors(T, ref.normalize()).normalize();
    };
    p.lim = { T, A1: axis(lim.r1), A2: axis(lim.r2), a: lim.a.map((x) => x * DEG), b: lim.b.map((x) => x * DEG), t: lim.t.map((x) => x * DEG) };
    // Muscle state. Joint torque caps are the adult-scale peak efforts from the replacement
    // active-ragdoll model; scaling with mass and stature preserves the same feel across rigs.
    const peak = {
      spine: 320, spine1: 320, chest: 280, neck: 45, head: 45,
      upperArm: 75, foreArm: 55, hand: 20, thigh: 560, shin: 620, foot: 180,
    }[p.kind] || 160;
    p.maxTorque = peak * (this.an.mass / 76.32) * (this.an.dims.L / 0.888);
    p.maxTorque0 = p.maxTorque; // nm.js scales maxTorque from this (bracing / catching boost)
    p.k = 10; p.z = 1; p.grav = 0;
    p.target = p.restRel.clone(); // relative rotation the muscle pulls toward (set from the animation)
    p.override = null; p.overrideW = 0; // a behaviour's own target, blended over the animation's
  }

  /** Mass and inertia moved by each joint (the subtree beyond it), for scaling the muscles. */
  _subtree() {
    const walk = (p) => [p, ...p.children.flatMap(walk)];
    for (const p of this.parts) {
      const sub = walk(p);
      p.sub = sub;
      p.subMass = sub.reduce((s, q) => s + q.mass, 0);
      let I = 0;
      // Each body's inertia about this joint: its own (rod) plus its mass at its centre's distance.
      for (const q of sub) I += q.mass * (q.comLocal.clone().applyQuaternion(q.tQuat).add(q.tPos).distanceToSquared(p.tPos) + q.len * q.len / 12);
      p.Ieff = Math.max(I, 0.002);
      p.Iself = p.mass * p.len * p.len / 12 + 1e-4;
    }
    // Reduced inertia of the joint's two sides (the parent body alone about the joint: the other
    // joints are free to turn). A torque on a light parent makes the pair's effective frequency
    // much higher than k; explicit integration needs it below ≈ 0.45 / step.
    // Twist: inertia of the subtree about the child's long axis (tiny for a limb: m r²/2).
    for (const p of this.parts) {
      const axW = p.axisLocal.clone().applyQuaternion(p.tQuat);
      let I = 0;
      for (const q of p.sub) {
        const c = q.comLocal.clone().applyQuaternion(q.tQuat).add(q.tPos).sub(p.tPos);
        const dPerp2 = c.lengthSq() - c.dot(axW) ** 2;
        I += q.Iax + q.mass * Math.max(0, dPerp2);
      }
      p.IaxSub = I;
    }
    // A torque on a joint spins both bodies about their own centres at first: the pair's reduced
    // inertia is what explicit control at a fixed step has to respect. The parent side is taken at
    // its smallest (about its own long axis), the child's across and along its axis.
    for (const p of this.parts) {
      if (!p.parent) continue;
      const Ip = p.parent.Iax;
      p.Ired = p.Icom * Ip / (p.Icom + Ip);
      p.IredAx = p.Iax * Ip / (p.Iax + Ip);
    }
  }

  /**
   * Torque for a desired relative acceleration-like vector, split about the child's long axis:
   * across it scaled by the moved inertia, along it (twist) by the axial one; each capped so the
   * pair stays stable at this step (effective frequency ≤ 0.4 / step).
   *   err: rotation error (world), w: relative angular velocity (world), k, z: stiffness, damping.
   */
  _pd(p, err, w, k, z, dt, out) {
    const wMax = 0.4 / dt;
    const T = _v4.copy(p.axisLocal).applyQuaternion(p.rb.rotation());
    const Ip = Math.min(p.Ieff, p.Ired * (wMax / k) ** 2), Ia = Math.min(p.IaxSub, p.IredAx * (wMax / k) ** 2);
    const cp = Math.min(2 * z * k * Ip, 0.8 * p.Ired / dt), ca = Math.min(2 * z * k * Ia, 0.8 * p.IredAx / dt);
    const eA = err.dot(T), wA = w.dot(T);
    out.copy(err).addScaledVector(T, -eA).multiplyScalar(Ip * k * k)
      .addScaledVector(T, Ia * k * k * eA)
      .addScaledVector(w, -cp).addScaledVector(T, (cp - ca) * wA);
    return out;
  }

  /** Per frame, before physics: read the animated pose (targets), and follow it while kinematic. */
  addCarry(v) { this.carry.add(v); }
  clearCarry() { this.carry.set(0, 0, 0); this.carryOff.set(0, 0, 0); }
  _stepCarry(dt) {
    if (dt <= 0) return;
    this.carryOff.addScaledVector(this.carry, dt);
    const m = this.carryOff.length();
    if (m > this.carryCap) { this.carryOff.multiplyScalar(this.carryCap / m); this.carry.multiplyScalar(Math.exp(-dt / 0.12)); } // out of reach: the target stops, the pins catch the body
    this.carry.multiplyScalar(Math.exp(-dt / this.carryTau));
    this.carryOff.multiplyScalar(Math.exp(-dt / (this.carryTau * 1.4))); // and the target eases back to the animation
  }

  sync(dt) {
    this._stepCarry(dt);
    const bi = this.blendIn;
    if (bi) {
      bi.t += dt;
      const k = Math.min(1, Math.max(0, 1 - bi.t / bi.d));
      bi.w = k * k * (3 - 2 * k);
      if (bi.t >= bi.d) this.blendIn = null;
    }
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.prevPos.copy(p.tPos); p.prevQuat.copy(p.tQuat);
      p.bone.getWorldPosition(p.tPos);
      p.bone.getWorldQuaternion(p.tQuat);
      if (p.kind === 'foot') this._fitPlantedFoot(p);
      if (this.crouch > 0.001 && p.kind !== 'foot') p.tPos.y -= this.crouch * (p.kind === 'shin' ? 0.35 : 1);
      if (p.kind !== 'foot' && this.carryOff.lengthSq() > 1e-8) p.tPos.addScaledVector(this.carryOff, p.kind === 'shin' ? 0.5 : 1);
      if (bi && this.blendIn) { const s = bi.snap[i]; p.tPos.lerp(s.pos, bi.w); p.tQuat.slerp(s.quat, bi.w); }
      if (dt > 0) {
        p.tVel.subVectors(p.tPos, p.prevPos).divideScalar(dt);
        rotVec(_q.copy(p.tQuat).multiply(_q2.copy(p.prevQuat).invert()), p.tAng).divideScalar(dt);
      }
      if (p.parent) p.target.copy(p.parent.tQuat).invert().multiply(p.tQuat);
    }
  }

  /** Align planted sole targets with the sampled terrain plane and correct foot hover. */
  _fitPlantedFoot(p) {
    const an = this.an, foot = an.feet?.[p.side];
    if (!foot?.planted || foot.swing || !p.soleUpLocal || !an.ground || an.crawl?.owns || an.jumpState) return;
    if (an.nm?.active && !['balance', 'blend', 'teeter'].includes(an.nm.mode)) return;
    if (Math.abs(foot.pitch?.x || 0) > 14 * DEG) return; // preserve intentional heel/toe roll
    const eps = Math.max(0.045 * an.dims.L, 0.035), ground = an.ground;
    const x = p.tPos.x, z = p.tPos.z;
    const h0 = ground(x, z), hx0 = ground(x - eps, z), hx1 = ground(x + eps, z);
    const hz0 = ground(x, z - eps), hz1 = ground(x, z + eps);
    const heights = [h0, hx0, hx1, hz0, hz1];
    if (Math.max(...heights) - Math.min(...heights) > 0.12) return; // don't span a stair edge
    let sx = -(hx1 - hx0) / (2 * eps), sz = -(hz1 - hz0) / (2 * eps);
    const maxSlope = Math.tan(25 * DEG), slope = Math.hypot(sx, sz);
    if (slope > maxSlope) { sx *= maxSlope / slope; sz *= maxSlope / slope; }
    const normal = _v.set(sx, 1, sz).normalize();
    const currentUp = _v2.copy(p.soleUpLocal).applyQuaternion(p.tQuat);
    const correction = this._footCorrection || (this._footCorrection = new THREE.Quaternion());
    correction.setFromUnitVectors(currentUp, normal);
    p.tQuat.premultiply(correction);
    const center = p.soleCenterLocal.clone().applyQuaternion(p.tQuat).add(p.tPos);
    const bottom = center.y - p.soleHalfHeight * Math.abs(normal.y);
    p.tPos.y -= THREE.MathUtils.clamp(bottom - h0, -0.08, 0.08);
  }

  /**
   * Smooth hand-off into an animation (get-up, recovery): the animation's pose is only a lossy
   * reconstruction of the physical one, so the muscle targets start AT the current physical pose
   * and ease into the animation over `duration` s (smoothstep). Nothing pops, nothing stutters.
   */
  beginBlendIn(duration = 0.5) {
    this.blendIn = {
      t: 0, d: Math.max(0.05, duration), w: 1,
      snap: this.parts.map((p) => ({ pos: new THREE.Vector3().copy(p.rb.translation()), quat: new THREE.Quaternion().copy(p.rb.rotation()) })),
    };
  }

  /** Does this part touch (or nearly touch) the floor? Returns the lowest clearance of its capsules (m, <0 = penetrating). */
  clearance(p) {
    const an = this.an, pos = p.rb.translation(), q = p.rb.rotation();
    let best = Infinity;
    for (const seg of p.segments) {
      for (const e of [seg.a, seg.b]) {
        const w = _v.copy(e).applyQuaternion(_q.set(q.x, q.y, q.z, q.w)).add(pos);
        best = Math.min(best, w.y - seg.r - (an.ground ? an.ground(w.x, w.z) : 0));
      }
    }
    return best;
  }

  /** Plantar reflex: a foot resting on the ground is levelled to it (a light torque; the muscles still own big moves). */
  _flattenFoot(p, dt) {
    const an = this.an, rb = p.rb, t = rb.translation();
    const q = _q.copy(rb.rotation());
    const c = _v2.copy(p.soleCenterLocal).applyQuaternion(q).add(t);
    const g = an.ground ? an.ground(c.x, c.z) : 0;
    if (c.y - p.soleHalfHeight - g > 0.045) return; // in the air: the muscles decide
    const foot = an.feet?.[p.side];
    if (foot && (foot.swing || Math.abs(foot.pitch?.x || 0) > 0.3)) return; // an intended heel / toe roll
    const e = 0.06, gx = (an.ground ? an.ground(c.x + e, c.z) - an.ground(c.x - e, c.z) : 0) / (2 * e), gz = (an.ground ? an.ground(c.x, c.z + e) - an.ground(c.x, c.z - e) : 0) / (2 * e);
    const n = _v3.set(-Math.max(-0.4, Math.min(0.4, gx)), 1, -Math.max(-0.4, Math.min(0.4, gz))).normalize();
    const up = _v.copy(p.soleUpLocal).applyQuaternion(q);
    const err = _v4.crossVectors(up, n); // rotation that brings the sole's up to the ground's
    const w = rb.angvel();
    const wn = w.x * n.x + w.y * n.y + w.z * n.z;
    const I = Math.max(p.Icom, 0.03), kp = 196, kd = 28, k = this.flatten;
    let tx = (err.x * kp - (w.x - n.x * wn) * kd) * I * k, ty = (err.y * kp - (w.y - n.y * wn) * kd) * I * k, tz = (err.z * kp - (w.z - n.z * wn) * kd) * I * k;
    const m = Math.hypot(tx, ty, tz), cap = 60;
    if (m > cap) { tx *= cap / m; ty *= cap / m; tz *= cap / m; }
    rb.applyTorqueImpulse({ x: tx * dt, y: ty * dt, z: tz * dt }, true);
  }

  /** Kinematic, with the world not stepping: the bodies put straight onto the pose. */
  park() {
    if (this.dynamic) return;
    for (const p of this.parts) { p.rb.setTranslation(p.tPos, false); p.rb.setRotation(p.tQuat, false); }
  }

  /** Keep even authored animation physically collidable, with the pose held by compliant muscles. */
  setAnimationPhysics(on = true) {
    this.animationPhysics = on;
    if (on) {
      if (!this.dynamic) this.setDynamic(true);
      this.assisted = true;
    } else {
      this.assisted = false;
      this.setDynamic(false);
    }
  }

  /** Physics takes over (velocities carried over from the animation), or hands back. */
  setDynamic(on) {
    if (on) this.assisted = false;
    else if (this.animationPhysics) { this.assisted = true; return; }
    if (on === this.dynamic) return;
    this.dynamic = on;
    const R = this.R;
    // sync() runs once per rendered frame; when an impact activates physics between syncs, correct
    // the cached part velocities to the animator's current root velocity. Keep each limb's own
    // swing velocity, but never lose the body's travel momentum at the hand-off.
    const rootVel = this.an.velocity;
    const pelvisVel = this.byName.pelvis.tVel;
    const velocityCorrection = on && rootVel ? new THREE.Vector3(rootVel.x - pelvisVel.x, rootVel.y - pelvisVel.y, rootVel.z - pelvisVel.z) : null;
    for (const p of this.parts) {
      p.rb.setBodyType(on ? R.RigidBodyType.Dynamic : R.RigidBodyType.KinematicPositionBased, true);
      if (on) {
        p.rb.setTranslation(p.tPos, true); p.rb.setRotation(p.tQuat, true);
        const v = velocityCorrection ? p.tVel.clone().add(velocityCorrection) : p.tVel;
        p.rb.setLinvel(v, true); p.rb.setAngvel(p.tAng, true);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Control (every fixed step while dynamic)
  // ---------------------------------------------------------------------------
  _control(dt, frac = 1) {
    if (!this.dynamic) {
      // Kinematic: the frame's motion spread over its sub-steps (moved all in the first, the bodies
      // would hit what they touch at the frame's speed × the number of steps).
      for (const p of this.parts) {
        p.rb.setNextKinematicTranslation(_kp.lerpVectors(p.prevPos, p.tPos, frac));
        p.rb.setNextKinematicRotation(_kq.slerpQuaternions(p.prevQuat, p.tQuat, frac));
      }
      return;
    }
    if (this.assisted) this._setAnimationMuscles();
    for (const p of this.parts) if (p.parent) this._muscle(p, dt);
    for (const p of this.parts) if (p.pin > 0 || p.pinRot > 0) this._pinBody(p, dt);
    if (this.flatten > 0) for (const p of this.parts) if (p.soleUpLocal) this._flattenFoot(p, dt);
  }

  /** Compliant animation tracking: joint limits and contact impulses can move the pose off target. */
  _setAnimationMuscles() {
    const crawl = this.an.crawl;
    const recovering = !!crawl?.owns && crawl.state !== 'ragdoll';
    const liveStand = recovering && crawl.keys?.liveStand;
    let standRamp = liveStand ? THREE.MathUtils.clamp((crawl.t / crawl.keys.total - 0.48) / 0.52, 0, 1) : 0;
    standRamp *= standRamp * (3 - 2 * standRamp);
    const blend = (a, b) => a + (b - a) * standRamp;
    for (const p of this.parts) {
      const kind = p.kind;
      const arm = /upperArm|foreArm|hand/.test(kind);
      const leg = /thigh|shin|foot/.test(kind);
      // Upright gait has active postural tone; get-up limbs relax only enough to route around contact.
      const activeK = arm ? 13 : leg ? (kind === 'foot' ? 23 : 17) : /neck|head/.test(kind) ? 14 : 17;
      const recoveryK = arm ? 8.5 : leg ? (kind === 'foot' ? 13 : 10) : /neck|head/.test(kind) ? 11 : 12;
      p.k = recovering ? blend(recoveryK, activeK) : activeK;
      p.z = recovering ? blend(1.12, 1.05) : 1.05;
      p.grav = leg ? 0.62 : arm ? 0.16 : 0.34;
      const activePin = kind === 'pelvis' ? 0.76 : arm ? 0.38 : leg ? 0.7 : 0.62;
      const recoveryPin = kind === 'pelvis' ? 0.44 : arm ? 0.16 : leg ? 0.3 : 0.42;
      p.pin = recovering ? blend(recoveryPin, activePin) : activePin;
      const activeRot = kind === 'foot' ? 0.96 : activePin * (kind === 'pelvis' ? 0.72 : 0.58);
      const recoveryRot = recoveryPin * (kind === 'pelvis' ? 0.72 : 0.42);
      p.pinRot = recovering ? blend(recoveryRot, activeRot) : activeRot;
    }
  }

  _muscle(p, dt) {
    const P = p.parent, rb = p.rb, prb = P.rb;
    // Own scratch quaternions: the limit code below uses the shared ones.
    const qC = (this._mqc ||= new THREE.Quaternion()).copy(rb.rotation()), qP = (this._mqp ||= new THREE.Quaternion()).copy(prb.rotation());
    const rel = (this._mrel ||= new THREE.Quaternion()).copy(qP).invert().multiply(qC); // current relative rotation (child in parent)
    // Target: the animation's, with a behaviour's override blended over it.
    const tgt = this._tq || (this._tq = new THREE.Quaternion());
    tgt.copy(p.target);
    if (p.override && p.overrideW > 0) tgt.slerp(p.override, p.overrideW);
    // Error rotation in the child's frame, then to world.
    const err = rotVec(this._eq = (this._eq || new THREE.Quaternion()).copy(rel).invert().multiply(tgt), _v);
    err.applyQuaternion(qC);
    const wC = rb.angvel(), wP = prb.angvel();
    const wRel = _v2.set(wC.x - wP.x, wC.y - wP.y, wC.z - wP.z);
    const tau = this._pd(p, err, wRel, p.k, p.z, dt, _v3);
    // Gravity compensation: hold the subtree's weight about this joint.
    if (p.grav > 0) {
      const com = this._subCom(p, _v4);
      const jp = rb.translation();
      com.set(com.x - jp.x, com.y - jp.y, com.z - jp.z);
      tau.addScaledVector(_v.set(-com.z, 0, com.x), p.grav * p.subMass * 9.81);
    }
    // Capped active muscles: the joint PD still pulls toward its current animation/behaviour
    // target, but cannot overpower an impact with an unlimited corrective torque. A shortening
    // muscle loses force at high angular speed (eccentric resistance remains strong).
    const errLen = err.length();
    if (errLen > 1e-5) {
      const shortening = Math.max(0, wRel.dot(_v.copy(err).multiplyScalar(1 / errLen)));
      const forceVelocity = Math.max(0.35, 1 - shortening / 12);
      const cap = p.maxTorque * forceVelocity;
      const magnitude = tau.length();
      if (magnitude > cap) tau.multiplyScalar(cap / magnitude);
    }
    this._limits(p, rel, qP, qC, wRel, tau, dt);
    rb.applyTorqueImpulse({ x: tau.x * dt, y: tau.y * dt, z: tau.z * dt }, true);
    prb.applyTorqueImpulse({ x: -tau.x * dt, y: -tau.y * dt, z: -tau.z * dt }, true);
  }

  /**
   * Limit penalty of a relative rotation: how far (rad) swing toward the two reference axes and
   * twist about the bone go past their ranges, measured from the bind pose. Returns the squared sum.
   */
  _penalty(p, rel) {
    const L = p.lim;
    const dev = this._dq || (this._dq = new THREE.Quaternion());
    dev.copy(p.restRel).invert().multiply(rel);
    if (dev.w < 0) dev.set(-dev.x, -dev.y, -dev.z, -dev.w);
    const T = L.T, proj = dev.x * T.x + dev.y * T.y + dev.z * T.z;
    const tw = this._tw || (this._tw = new THREE.Quaternion());
    tw.set(T.x * proj, T.y * proj, T.z * proj, dev.w);
    if (tw.lengthSq() < 1e-10) tw.identity(); else tw.normalize();
    const twist = rotVec(tw, this._tv || (this._tv = new THREE.Vector3())).dot(T);
    const sw = this._sw || (this._sw = new THREE.Quaternion());
    sw.copy(dev).multiply((this._twi ||= new THREE.Quaternion()).copy(tw).invert());
    const sv = rotVec(sw, this._sv || (this._sv = new THREE.Vector3()));
    const over = (x, r) => (x < r[0] ? x - r[0] : x > r[1] ? x - r[1] : 0);
    const oa = over(sv.dot(L.A1), L.a), ob = over(sv.dot(L.A2), L.b), ot = over(twist, L.t);
    return oa * oa + ob * ob + ot * ot;
  }

  /**
   * Joint limits as a one-sided velocity constraint, like a physics engine's: the direction that goes
   * deeper past a limit is the gradient of the limit penalty with respect to small world rotations of
   * the child (numerical, so no frame conventions can get it backwards); motion that way is cancelled
   * with an impulse computed from the joint's reduced inertia, plus a gentle push back inside.
   */
  _limits(p, rel, qP, qC, wRel, tau, dt) {
    const E = this._penalty(p, rel);
    if (E <= 0) return;
    const g = this._g || (this._g = new THREE.Vector3());
    const h = 0.01, dq = this._dq2 || (this._dq2 = new THREE.Quaternion()), r2 = this._r2 || (this._r2 = new THREE.Quaternion());
    const qPi = this._qpi || (this._qpi = new THREE.Quaternion());
    qPi.copy(qP).invert();
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 3; i++) {
      const ax = _v4.set(...axes[i]);
      dq.setFromAxisAngle(ax, h);
      const tq = this._tq2 || (this._tq2 = new THREE.Quaternion());
      const ep = this._penalty(p, r2.copy(qPi).multiply(tq.copy(dq).multiply(qC)));
      dq.setFromAxisAngle(ax, -h);
      const em = this._penalty(p, r2.copy(qPi).multiply(tq.copy(dq).multiply(qC)));
      g.setComponent(i, (ep - em) / (2 * h));
    }
    const gl = g.length();
    if (gl < 1e-9) return;
    const x = Math.sqrt(E), dir = g.divideScalar(gl); // dir: rotating this way goes deeper
    // Relative velocity after this step's muscle torque, into the limit.
    const T = _v.copy(p.axisLocal).applyQuaternion(qC), ct = dir.dot(T);
    const Id = p.Ired * (1 - ct * ct) + p.IredAx * ct * ct; // reduced inertia about this direction
    const vd = wRel.dot(dir) + tau.dot(dir) * dt / Id;
    const want = vd + LIMIT_BETA * x / dt;
    if (want <= 0) return;
    // Cancel it: a torque impulse J on the child (−J on the parent) changes the relative velocity by J / Id.
    tau.addScaledVector(dir, -Id * want / dt);
  }

  _subCom(p, out) {
    out.set(0, 0, 0);
    for (const q of p.sub) { const t = q.rb.translation(); out.x += t.x * q.mass; out.y += t.y * q.mass; out.z += t.z * q.mass; }
    return out.divideScalar(p.subMass);
  }

  /** Pin: a spring-damper toward the animated pose (helper force), position and orientation. */
  _pinBody(p, dt) {
    const rb = p.rb, m = p.mass, t = rb.translation(), v = rb.linvel();
    if (p.pin > 0) {
      // The pelvis pin stands in for the legs bearing the body's weight: it pulls with the whole mass.
      const kp = 14, w = p.pin * (p.parent ? 1 : this.totalMass / m);
      // pinDrop lowers the target (m): the hips sinking onto the knees.
      const f = _v.set(p.tPos.x - t.x, p.tPos.y - (p.pinDrop || 0) - t.y, p.tPos.z - t.z).multiplyScalar(kp * kp * m * w)
        .addScaledVector(_v2.set(p.tVel.x - v.x, p.tVel.y - v.y, p.tVel.z - v.z), 2 * kp * m * w);
      rb.applyImpulse({ x: f.x * dt, y: f.y * dt, z: f.z * dt }, true);
    }
    if (p.pinRot > 0) {
      const kr = 14 * Math.sqrt(p.pinRot), w = p.pinRot;
      const e = rotVec(_q.copy(p.tQuat).multiply(_q2.copy(rb.rotation()).invert()), _v);
      const av = rb.angvel();
      const dw = _v2.set(av.x - p.tAng.x, av.y - p.tAng.y, av.z - p.tAng.z);
      // Own inertias: across the long axis and about it.
      const T = _v4.copy(p.axisLocal).applyQuaternion(rb.rotation());
      const eA = e.dot(T), wA = dw.dot(T);
      const tau = _v3.copy(e).addScaledVector(T, -eA).multiplyScalar(kr * kr * p.Icom).addScaledVector(T, kr * kr * p.Iax * eA)
        .addScaledVector(dw, -2 * kr * p.Icom).addScaledVector(T, 2 * kr * (p.Icom - p.Iax) * wA);
      rb.applyTorqueImpulse({ x: tau.x * dt, y: tau.y * dt, z: tau.z * dt }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries and output
  // ---------------------------------------------------------------------------
  com(out = new THREE.Vector3()) {
    out.set(0, 0, 0); let M = 0;
    for (const p of this.parts) { const t = p.rb.translation(); out.x += t.x * p.mass; out.y += t.y * p.mass; out.z += t.z * p.mass; M += p.mass; }
    return out.divideScalar(M);
  }
  comVel(out = new THREE.Vector3()) {
    out.set(0, 0, 0); let M = 0;
    for (const p of this.parts) { const v = p.rb.linvel(); out.x += v.x * p.mass; out.y += v.y * p.mass; out.z += v.z * p.mass; M += p.mass; }
    return out.divideScalar(M);
  }
  /** Mean speed of the body parts (m/s): how much she is still moving. */
  motion() {
    let s = 0;
    for (const p of this.parts) { const v = p.rb.linvel(), w = p.rb.angvel(); s += Math.hypot(v.x, v.y, v.z) + 0.15 * Math.hypot(w.x, w.y, w.z); }
    return s / this.parts.length;
  }

  /** Muscles of a group: 'fb' | 'ub' | 'lb' | 'spine' | 'neck' | 'armL' | 'armR' | 'legL' | 'legR' | 'arms' | 'legs'. */
  group(mask) {
    const G = {
      fb: () => true, ub: (p) => !/thigh|shin|foot/.test(p.kind), lb: (p) => /thigh|shin|foot/.test(p.kind),
      spine: (p) => /spine|chest/.test(p.kind), neck: (p) => /neck|head/.test(p.kind),
      arms: (p) => /upperArm|foreArm|hand/.test(p.kind), legs: (p) => /thigh|shin|foot/.test(p.kind),
      armL: (p) => /upperArm|foreArm|hand/.test(p.kind) && p.side === 'L', armR: (p) => /upperArm|foreArm|hand/.test(p.kind) && p.side === 'R',
      legL: (p) => /thigh|shin|foot/.test(p.kind) && p.side === 'L', legR: (p) => /thigh|shin|foot/.test(p.kind) && p.side === 'R',
    }[mask];
    return this.parts.filter((p) => p.parent && G(p));
  }
  setStiffness(mask, k, z = 1) { for (const p of this.group(mask)) { p.k = k; p.z = z; } }

  /** An impulse (N·s, world vector) at a world point on a part. */
  impulse(name, J, point) {
    const p = this.byName[name];
    if (!p) return;
    p.rb.applyImpulseAtPoint({ x: J.x, y: J.y, z: J.z }, point || p.rb.translation(), true);
  }

  /** Write the bodies' poses onto the bones (blended over the animation by w), parents first. */
  writeBack(w = 1) {
    const inv = _wb1, wq = _wb2, lq = _wb3;
    for (const p of this.parts) {
      const b = p.bone, par = b.parent;
      par.updateWorldMatrix(true, false);
      par.getWorldQuaternion(inv).invert();
      wq.copy(p.rb.rotation());
      lq.copy(inv).multiply(wq);
      b.quaternion.slerp(lq, w);
      if (!p.parent) {
        const t = p.rb.translation();
        const lp = par.worldToLocal(_v.set(t.x, t.y, t.z));
        b.position.lerp(lp, w);
      }
      b.updateMatrixWorld(true);
    }
  }

  /** Hold a part at a world point (a hand gripping a ledge): a ball joint to the world. */
  attach(name, localAnchor, worldPoint) {
    const R = this.R, w = this.ph.world, p = this.byName[name];
    this._fixed ||= w.createRigidBody(R.RigidBodyDesc.fixed());
    const jd = R.JointData.spherical({ x: localAnchor.x, y: localAnchor.y, z: localAnchor.z }, { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z });
    const j = w.createImpulseJoint(jd, p.rb, this._fixed, true);
    j.setContactsEnabled(false);
    return j;
  }
  detach(j) { if (j) this.ph.world.removeImpulseJoint(j, true); }

  dispose() {
    const w = this.ph.world;
    if (this._fixed) w.removeRigidBody(this._fixed);
    this.ph.release(this.parts.flatMap((p) => p.colliders.map((c) => c.handle)));
    for (const p of this.parts) w.removeRigidBody(p.rb);
    const i = this.ph.onStep.indexOf(this._ctl);
    if (i >= 0) this.ph.onStep.splice(i, 1);
  }
}
