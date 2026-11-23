// Applies a smooth displacement field (character space, metres, bind/T-pose, +Z forward) to every
// skinned mesh of a model. One field moves the surface shell and the joint pieces together, so they
// stay aligned. Normals are carried through the field's Jacobian (no recomputation seams). Must
// run before the animator is built.
import * as THREE from 'three';

export const gauss = (x, mu, sigma) => Math.exp(-((x - mu) * (x - mu)) / (sigma * sigma));
export const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function reshape(model, field) {
  model.updateMatrixWorld(true);
  const p = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const J = new THREE.Matrix3(), Jit = new THREE.Matrix3();
  const h = 0.002;
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    // Bind pose: every bone's skinning matrix is the same, so one matrix maps raw positions to
    // world space (as the skinning shader does: M · B⁻¹ · bone · boneInverse · B).
    const sk = o.skeleton;
    const toWorld = o.matrixWorld.clone().multiply(o.bindMatrixInverse)
      .multiply(sk.bones[0].matrixWorld).multiply(sk.boneInverses[0]).multiply(o.bindMatrix);
    const toLocal = toWorld.clone().invert();
    const g = o.geometry;
    const pos = g.attributes.position, nor = g.attributes.normal;
    const cols = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const axes = [new THREE.Vector3(h, 0, 0), new THREE.Vector3(0, h, 0), new THREE.Vector3(0, 0, h)];
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(toWorld);
      field(p.x, p.y, p.z, d);
      if (nor) {
        // Jacobian of p ↦ p + D(p) by central differences; normals transform by J⁻ᵀ.
        for (let c = 0; c < 3; c++) {
          a.copy(p).add(axes[c]);
          b.copy(p).sub(axes[c]);
          field(a.x, a.y, a.z, a);
          field(b.x, b.y, b.z, b);
          cols[c].subVectors(a, b).divideScalar(2 * h);
          cols[c].setComponent(c, cols[c].getComponent(c) + 1);
        }
        J.set(
          cols[0].x, cols[1].x, cols[2].x,
          cols[0].y, cols[1].y, cols[2].y,
          cols[0].z, cols[1].z, cols[2].z,
        );
        Jit.copy(J).invert().transpose();
        n.fromBufferAttribute(nor, i).applyMatrix3(Jit).normalize();
        nor.setXYZ(i, n.x, n.y, n.z);
      }
      p.add(d).applyMatrix4(toLocal);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  });
}
