// Reshapes the mannequin's skinned meshes toward a masculine figure while keeping its look:
// broader, capped shoulders and a trapezius slope into a thicker neck, a wider upper back (lats)
// tapering to a straighter waist, a flat pec plate, narrower hips and flatter glutes, heavier arms
// and calves. Applied as one smooth displacement field (see reshape.js).
import { reshape, gauss, smooth } from './reshape.js';

// Bind-pose landmarks of the mannequin (metres): shoulder joints at (±0.152, 1.438, −0.05), the
// T-posed arms lie along ±X on that line; hip joints at (±0.082, 0.972); neck base ≈ 1.50.
const ARM_Y = 1.438, ARM_Z = -0.05, LEG_X = 0.082;

/** Displacement at point p (x, y, z) in metres, written to out. */
function field(x, y, z, out) {
  let dx = 0, dy = 0, dz = 0;
  const ax = Math.abs(x), s = Math.sign(x) || 1;
  const torso = 1 - smooth(0.13, 0.19, ax); // fades out before the T-posed arms

  // Deltoid caps: a rounded bulge over each shoulder joint, mostly up and out.
  {
    const ex = (ax - 0.175) / 0.085, ey = (y - (ARM_Y + 0.02)) / 0.075, ez = (z - ARM_Z) / 0.085;
    const r2 = ex * ex + ey * ey + ez * ez;
    const w = r2 < 1 ? (1 - r2) * (1 - r2) : 0;
    dx += s * 0.018 * w;
    dy += 0.012 * w;
    dz += 0.006 * w * Math.sign(z - ARM_Z);
  }

  // Trapezius: the line from neck to shoulder rises into a slope instead of a flat shelf.
  const trap = gauss(y, 1.49, 0.035) * smooth(0.035, 0.07, ax) * (1 - smooth(0.13, 0.17, ax)) * smooth(0.02, -0.06, z);
  dy += 0.014 * trap;
  dz -= 0.006 * trap;

  // Upper back and lats wider (V-taper), waist straighter rather than pinched.
  const lat = gauss(y, 1.33, 0.07) * torso;
  dx += x * 0.13 * lat;
  dz -= 0.008 * lat * smooth(0, -0.08, z); // back broadens behind the ribs
  const waist = gauss(y, 1.2, 0.07) * torso;
  dx += x * 0.06 * waist;
  dz += (z - 0.01) * 0.05 * waist;

  // Pecs: a broad, flat plate on the upper chest with a defined lower edge.
  {
    const front = smooth(0.03, 0.1, z) * torso;
    const w = smooth(1.31, 1.36, y) * (1 - smooth(1.44, 1.49, y)) * (1 - smooth(0.09, 0.14, ax));
    dz += 0.012 * w * front;
  }

  // Neck thicker (sternocleidomastoid / traps), not longer.
  const neck = gauss(y, 1.53, 0.045) * (1 - smooth(0.06, 0.1, ax));
  dx += x * 0.14 * neck;
  dz += (z + 0.015) * 0.1 * neck;

  // Hips and the outside of the upper thighs narrower, glutes flatter.
  const hip = gauss(y, 0.9, 0.12) * smooth(0.08, 0.15, ax) * (1 - smooth(0.24, 0.3, ax));
  dx -= x * 0.13 * hip;
  const glute = gauss(y, 0.95, 0.07) * gauss(ax, 0.075, 0.075) * smooth(-0.04, -0.12, z);
  dz += 0.014 * glute;

  // Arms heavier around their own axis: upper arm (biceps / triceps) more than the forearm.
  {
    const along = smooth(0.17, 0.22, ax) * (1 - smooth(0.68, 0.74, ax));
    const band = smooth(1.3, 1.36, y) * (1 - smooth(1.53, 1.57, y));
    const k = along * band * mix3(ax);
    dy += (y - ARM_Y) * k;
    dz += (z - ARM_Z) * k;
  }

  // Calves fuller at the back.
  const calf = gauss(y, 0.36, 0.08) * gauss(ax, LEG_X, 0.07);
  dx += (x - s * LEG_X) * 0.06 * calf;
  dz += (z - 0.0) * 0.08 * calf * smooth(0.0, -0.05, z);

  return out.set(dx, dy, dz);
}

/** Radial thickening along the arm: 12 % at the biceps, 6 % along the forearm. */
function mix3(ax) {
  return 0.12 * (1 - smooth(0.38, 0.48, ax)) + 0.06 * smooth(0.38, 0.48, ax);
}

export function masculinize(model) {
  reshape(model, field);
}
