// Loads the Modular Roads Pack (embedded into the bundle) and returns normalized road pieces.
// "Modular Roads Pack" by Mini Loft Games, CC-BY-4.0 — see assets/roads/LICENSE.txt
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import gltfText from "../assets/roads/scene.gltf";
import binURL from "../assets/roads/scene.bin";
import roadJpg from "../assets/roads/Road.jpg";
import interJpg from "../assets/roads/Intersection.jpg";
import { ROAD_W } from "./city.js";

export async function loadRoads(maxAniso) {
  const g = JSON.parse(gltfText);
  g.buffers[0].uri = binURL;
  for (const img of g.images) img.uri = /Intersection/.test(img.uri) ? interJpg : roadJpg;
  const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(JSON.stringify(g), "", ok, fail));
  gltf.scene.updateMatrixWorld(true);

  // Reuse the pack's own textures, with a rougher, non-specular standard material.
  const mats = {};
  const matFor = (m) => {
    if (mats[m.name]) return mats[m.name];
    const map = m.map;
    map.anisotropy = maxAniso;
    return (mats[m.name] = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0 }));
  };

  const W0 = 37.916; // pack road width in meters (incl. sidewalks)
  const s = ROAD_W / W0;
  const piece = (name, yLift) => {
    const node = gltf.scene.getObjectByName(name);
    const out = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      geo.scale(s, s, s);
      geo.translate(0, yLift, 0);
      geo.computeBoundingSphere();
      out.push({ geometry: geo, material: matFor(o.material) });
    });
    return out;
  };
  const straight = piece("Road_1X_Straight", 0.0);
  const lift = 0.1 * s; // intersection asphalt sits 10 cm below the pack's origin
  const box = new THREE.Box3().setFromBufferAttribute(straight[0].geometry.attributes.position);
  return {
    straight,
    x: piece("Road_X_Intersection", lift),
    t: piece("Road_T_Intersection", lift),
    l: piece("Road_L_Intersection", lift),
    straightLen: box.max.x - box.min.x,
  };
}
