// Fruti World — a procedural open-world coastal city. Entry point: renderer, sky, ocean,
// post-processing, camera, game loop, world-generator menu and HUD.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Water } from "three/examples/jsm/objects/Water.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

// Scanned PBR texture sets (diffuse / normal / ARM), embedded in the bundle.
import brickDiff from "../assets/brick/diff.jpg";
import brickNor from "../assets/brick/nor_gl.jpg";
import brickArm from "../assets/brick/arm.jpg";
import stuccoDiff from "../assets/stucco/diff.jpg";
import stuccoNor from "../assets/stucco/nor_gl.jpg";
import stuccoArm from "../assets/stucco/arm.jpg";
import stucco2Diff from "../assets/stucco2/diff.jpg";
import stucco2Nor from "../assets/stucco2/nor_gl.jpg";
import stucco2Arm from "../assets/stucco2/arm.jpg";
import grassDiff from "../assets/grass/diff.jpg";
import grassNor from "../assets/grass/nor_gl.jpg";
import grassArm from "../assets/grass/arm.jpg";
import paversDiff from "../assets/pavers/diff.jpg";
import paversNor from "../assets/pavers/nor_gl.jpg";
import paversArm from "../assets/pavers/arm.jpg";
import pebblesDiff from "../assets/pebbles/diff.jpg";
import pebblesNor from "../assets/pebbles/nor_gl.jpg";
import pebblesArm from "../assets/pebbles/arm.jpg";

import { hashSeed, makeRng } from "./rng.js";
import { buildTextures } from "./textures.js";
import { makeMaterials } from "./materials.js";
import { loadRoads } from "./roads.js";
import { generateCity, ColliderGrid, cityName, ROAD_W } from "./city.js";
import { Traffic, DrivenCar, makeCarModel, setCarNight } from "./vehicles.js";
import { makePerson, Walker, Pedestrians, loadCharacter } from "./people.js";
import { Input } from "./input.js";
import { Sound } from "./audio.js";
import { Minimap } from "./minimap.js";

const $ = (s) => document.querySelector(s);
const isTouch = matchMedia("(pointer: coarse)").matches;

// ---------------- settings ----------------
const DEFAULTS = {
  seed: "sunset", size: isTouch ? 8 : 10, height: 1, density: 0.75, palms: 1,
  traffic: isTouch ? 16 : 36, peds: isTouch ? 20 : 60, time: 17.6, timeSpeed: 1, quality: isTouch ? "low" : "high",
};
let params = { ...DEFAULTS };
try { Object.assign(params, JSON.parse(localStorage.getItem("fruti-world") || "{}")); } catch (e) { /* storage blocked */ }
const save = () => { try { localStorage.setItem("fruti-world", JSON.stringify(params)); } catch (e) { /* ignore */ } };

const QUALITY = {
  low: { pr: 0.8, shadows: 0, bloom: false, reflect: false, msaa: 0 },
  high: { pr: 1.25, shadows: 2048, bloom: true, reflect: true, msaa: 4 },
  ultra: { pr: 2, shadows: 4096, bloom: true, reflect: true, msaa: 4 },
};

// ---------------- renderer & scene ----------------
const canvas = $("#c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbcd6e6, 0.0011);
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);

// sky
const sky = new Sky();
sky.scale.setScalar(4000);
scene.add(sky);
const skyU = sky.material.uniforms;
skyU.turbidity.value = 4; skyU.rayleigh.value = 1.4; skyU.mieCoefficient.value = 0.004; skyU.mieDirectionalG.value = 0.86;
// Tame the sky's brightness and blend to a starry navy gradient at night.
const skyNight = { value: 0 }, skyGain = { value: 0.6 };
sky.material.onBeforeCompile = (sh) => {
  sh.uniforms.uNight = skyNight; sh.uniforms.uGain = skyGain;
  sh.fragmentShader = "uniform float uNight; uniform float uGain;\n" + sh.fragmentShader.replace("#include <tonemapping_fragment>", `
    vec3 dirN = normalize(vWorldPosition - cameraPosition);
    vec3 nightCol = mix(vec3(0.030, 0.045, 0.090), vec3(0.004, 0.007, 0.020), smoothstep(0.0, 0.5, dirN.y));
    gl_FragColor.rgb = mix(gl_FragColor.rgb * uGain, nightCol, uNight);
    #include <tonemapping_fragment>`);
};
sky.material.needsUpdate = true;
const envScene = new THREE.Scene();
const envSky = new Sky(); envSky.scale.setScalar(400);
envSky.material.uniforms = skyU; // share uniforms
envSky.material.onBeforeCompile = sky.material.onBeforeCompile;
envScene.add(envSky);
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null, envHour = -99;

// stars + moon
const stars = (() => {
  const g = new THREE.BufferGeometry(), p = [], r = makeRng(9);
  for (let i = 0; i < 2500; i++) {
    const u = r.next() * 2 - 1, a = r.next() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    if (u < 0.02) continue;
    p.push(s * Math.cos(a) * 3500, u * 3500, s * Math.sin(a) * 3500);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  return new THREE.Points(g, m);
})();
scene.add(stars);
const moon = new THREE.Mesh(new THREE.SphereGeometry(60, 24, 16), new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false }));
scene.add(moon);

// lights
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfdcff, 0x8a7a63, 0.6);
scene.add(hemi);
const headlight = new THREE.SpotLight(0xfff1d6, 0, 70, 0.55, 0.5, 1.2);
headlight.position.set(0, 0.8, 2.3);
headlight.target.position.set(0, 0, 14);

// ocean
let water = null;
const waterGeo = new THREE.PlaneGeometry(12000, 12000);
function makeWater(T, q) {
  if (water) { scene.remove(water); water.material.dispose(); }
  if (q.reflect) {
    water = new Water(waterGeo, {
      textureWidth: 512, textureHeight: 512, waterNormals: T.waterNormals,
      sunDirection: new THREE.Vector3(), sunColor: 0xffffff, waterColor: 0x0b6b7c, distortionScale: 2.4, fog: true, alpha: 1,
    });
    water.material.uniforms.size.value = 3.5;
  } else {
    water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: 0x0f7f8f, roughness: 0.08, metalness: 0.1, normalMap: T.waterNormals, normalScale: new THREE.Vector2(0.4, 0.4) }));
    T.waterNormals.repeat.set(600, 600);
  }
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.2;
  scene.add(water);
}

// post-processing
let composer, bloom, grade, quality;
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.12 }, uVig: { value: 0.32 }, uWarm: { value: 1 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uVig, uWarm; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      // warm highlights, teal shadows
      c.rgb += mix(vec3(-0.01, 0.006, 0.02), vec3(0.025, 0.008, -0.02), smoothstep(0.2, 0.8, l)) * uWarm;
      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0, smoothstep(0.85, 0.25, d), uVig);
      gl_FragColor = c;
    }`,
};
function setupQuality(name, T) {
  quality = QUALITY[name] || QUALITY.high;
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pr));
  renderer.shadowMap.enabled = quality.shadows > 0;
  sun.castShadow = quality.shadows > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(quality.shadows, quality.shadows);
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    const s = quality.shadows > 2048 ? 150 : 110;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 1200 });
    sun.shadow.camera.updateProjectionMatrix();
  }
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality.msaa });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.55, 0.92);
  bloom.enabled = quality.bloom;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  if (T) makeWater(T, quality);
  resize();
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer?.setSize(w, h);
  composer?.setPixelRatio(renderer.getPixelRatio());
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// ---------------- world state ----------------
const input = new Input(canvas, $("#hud"));
const sound = new Sound();
let T, roads, mats, city, traffic, peds, minimap;
let walker, playerModel, driven = null, state = "menu", limits, menuBlockUntil = 0;
let hours = params.time;
let cam = { yaw: 0.6, pitch: 0.28, dist: 5, far: false };
let shake = 0, lastDistrict = "", districtTimer = 0;

async function boot() {
  setLoading("Painting textures…");
  T = await buildTextures({ brick: { diff: brickDiff, nor: brickNor, arm: brickArm }, stucco: { diff: stuccoDiff, nor: stuccoNor, arm: stuccoArm }, stucco2: { diff: stucco2Diff, nor: stucco2Nor, arm: stucco2Arm }, grass: { diff: grassDiff, nor: grassNor, arm: grassArm }, pavers: { diff: paversDiff, nor: paversNor, arm: paversArm }, pebbles: { diff: pebblesDiff, nor: pebblesNor, arm: pebblesArm } });
  setLoading("Loading characters…");
  await loadCharacter();
  setLoading("Loading road pack…");
  roads = await loadRoads(maxAniso);
  mats = makeMaterials(T);
  setupQuality(params.quality, T);
  buildUI();
  await generate();
  $("#loading").classList.add("hide");
  showMenu(true);
  requestAnimationFrame(loop);
}

function setLoading(t) { $("#loading-text").textContent = t; }

function disposeWorld() {
  if (!city) return;
  scene.remove(city.group);
  city.group.traverse((o) => { if (o.geometry && o.isMesh && !o.isInstancedMesh) o.geometry.dispose(); });
  traffic.dispose(); peds.dispose();
  if (driven) { scene.remove(driven.model); driven = null; }
  if (playerModel) scene.remove(playerModel);
}

async function generate() {
  $("#loading").classList.remove("hide");
  setLoading("Generating " + cityName(hashSeed(params.seed)) + "…");
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  disposeWorld();
  const seed = hashSeed(String(params.seed));
  const p = { ...params, seed };
  city = generateCity(p, T, roads, mats);
  city.grid = new ColliderGrid(city.colliders);
  limits = { ...city.bounds, shoreX: city.shoreX, beachY: city.beachY };
  for (const m of city.neonLights) mats.extraGlow(m, "sign");
  scene.add(city.group);
  const rng = makeRng(seed + 99);
  traffic = new Traffic(city, scene, rng, params.traffic);
  peds = new Pedestrians(city, scene, rng, params.peds);
  // player + a car waiting at the curb
  playerModel = makePerson({ body: 0xe8e2d8, joints: 0xff4f8b });
  playerModel.position.copy(city.spawn);
  scene.add(playerModel);
  walker = new Walker(playerModel);
  walker.facing = -Math.PI / 2;
  const car = traffic.spawn();
  car.model.position.set(city.spawn.x - 4.4, 0.03, city.spawn.z - 3);
  car.model.rotation.y = Math.PI;
  traffic.knock(car, new THREE.Vector3());
  car.knocked.spin = 0;
  hours = params.time;
  minimap = new Minimap(city, $("#minimap"), $("#bigmap"), cityName(seed));
  $("#city-name").textContent = cityName(seed);
  envHour = -99;
  $("#loading").classList.add("hide");
}

// ---------------- day / night ----------------
const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3();
const C = (h) => new THREE.Color(h);
const FOG_DAY = C(0xb9d5e8), FOG_SET = C(0xf0b48c), FOG_NIGHT = C(0x0a1324);
function updateSky(dt) {
  if (params.timeSpeed > 0 && state === "play") hours = (hours + dt * params.timeSpeed / 60) % 24;
  if (state === "menu") hours = (hours + dt * 0.02) % 24;
  const t = (hours - 6) / 12; // 0 at sunrise, 1 at sunset
  const elev = Math.sin(t * Math.PI) * 68; // degrees
  const az = 100 + t * 160;
  sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
  moonDir.copy(sunDir).multiplyScalar(-1);
  moonDir.y = Math.abs(moonDir.y) * 0.8 + 0.25; moonDir.normalize();
  skyU.sunPosition.value.copy(sunDir);
  const day = THREE.MathUtils.smoothstep(elev, -6, 8);
  const night = 1 - THREE.MathUtils.smoothstep(elev, -10, 2);
  const golden = day * (1 - THREE.MathUtils.smoothstep(elev, 4, 24));

  const focus = driven ? driven.pos : walker.pos;
  const useMoon = elev < -3;
  const ld = useMoon ? moonDir : sunDir;
  sun.position.copy(focus).addScaledVector(ld, 500);
  sun.target.position.copy(focus);
  sun.color.setRGB(1, 0.93 - golden * 0.25, 0.85 - golden * 0.45);
  if (useMoon) sun.color.setRGB(0.55, 0.65, 1);
  sun.intensity = useMoon ? 0.4 * night : 0.2 + day * 3.6;
  hemi.intensity = 0.15 + day * 0.7;
  hemi.color.setRGB(0.75 - night * 0.5, 0.86 - night * 0.55, 1 - night * 0.5);
  scene.fog.color.copy(FOG_DAY).lerp(FOG_SET, golden * 0.8).lerp(FOG_NIGHT, night);
  scene.fog.density = 0.00045 + (1 - day) * 0.00025 + golden * 0.0002;
  renderer.toneMappingExposure = 0.82 + night * 0.25;
  skyNight.value = night;
  stars.material.opacity = night;
  moon.position.copy(camera.position).addScaledVector(moonDir, 3000);
  moon.visible = night > 0.05;
  if (water?.material.uniforms?.sunDirection) {
    water.material.uniforms.sunDirection.value.copy(ld);
    water.material.uniforms.sunColor.value.copy(sun.color).multiplyScalar(useMoon ? 0.5 : 1);
    water.material.uniforms.waterColor.value.setRGB(0.03, 0.36 - night * 0.3, 0.42 - night * 0.34);
  }
  mats.setNight(night);
  setCarNight(night);
  if (bloom) bloom.strength = 0.18 + night * 0.5;
  headlight.intensity = night * 120;
  grade.uniforms.uWarm.value = 1 - night * 0.7;
  // refresh reflections when the sky changed enough
  if (Math.abs(hours - envHour) > 0.2) {
    envHour = hours;
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0, 0.1, 1000);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.25 + day * 0.75;
  }
  return { night, day };
}

// ---------------- game loop ----------------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3(), camTarget = new THREE.Vector3(), camPos = new THREE.Vector3();
let fps = 60;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  const inp = input.read();
  mats.time.value += dt;
  if (water?.material.uniforms?.time) water.material.uniforms.time.value += dt * 0.6;
  else if (T) T.waterNormals.offset.x += dt * 0.004;

  if (inp.menu && state !== "menu" && performance.now() > menuBlockUntil) showMenu(state === "play");
  if (state === "play") play(dt, inp);
  else if (state === "menu") attract(dt);

  const { night } = updateSky(dt);
  composer.render();
  document.body.classList.toggle("in-menu", state === "menu");
  if (state !== "menu") minimap.draw(focusPos(), cam.yaw, driven ? driven.heading : walker.facing, traffic.cars, hours);
  $("#clock").textContent = `${String(Math.floor(hours)).padStart(2, "0")}:${String(Math.floor((hours % 1) * 60)).padStart(2, "0")}`;
}

const focusPos = () => (driven ? driven.pos : walker.pos);

function play(dt, inp) {
  // simulation
  let hit = 0;
  if (driven) {
    hit = driven.update(dt, inp, city.grid, limits);
    // bump traffic
    for (const c of traffic.cars) {
      const p = c.model.position, dx = p.x - driven.pos.x, dz = p.z - driven.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 10 && d2 > 1e-4) {
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        const rel = driven.vel.x * nx + driven.vel.z * nz;
        driven.pos.x -= nx * (3.2 - d) * 0.5; driven.pos.z -= nz * (3.2 - d) * 0.5;
        if (rel > 0) {
          const push = new THREE.Vector3(nx, 0, nz).multiplyScalar(rel * 0.9).add(driven.vel.clone().multiplyScalar(0.3));
          if (c.knocked) c.knocked.vel.add(push); else traffic.knock(c, push);
          driven.vel.x -= nx * rel * 0.7; driven.vel.z -= nz * rel * 0.7;
          hit = Math.max(hit, rel);
        }
      }
    }
    if (inp.horn) traffic.cars.forEach((c) => { if (!c.knocked && c.model.position.distanceTo(driven.pos) < 30) c.cruise = Math.min(22, c.cruise + dt * 4); });
  } else {
    walker.update(dt, inp, cam.yaw, city.grid, limits);
    // keep out of cars
    for (const c of traffic.cars) {
      const m = c.model, f = tmp.set(Math.sin(m.rotation.y), 0, Math.cos(m.rotation.y));
      for (const o of [-1.2, 1.2]) {
        const cx = m.position.x + f.x * o, cz = m.position.z + f.z * o;
        const dx = walker.pos.x - cx, dz = walker.pos.z - cz, d = Math.hypot(dx, dz);
        if (d < 1.4 && d > 1e-4 && (walker.jumpY || 0) < 1.2) { walker.pos.x = cx + (dx / d) * 1.4; walker.pos.z = cz + (dz / d) * 1.4; }
      }
    }
  }
  if (hit > 6) { sound.crash(hit); shake = Math.min(1, hit / 25); }

  // enter / exit vehicles
  const near = nearestCar();
  if (inp.enter) {
    if (driven) exitCar();
    else if (near) enterCar(near);
  }
  setPrompt(!driven && near ? "enter" : null);

  traffic.update(dt, driven ? null : walker.pos, driven ? driven.pos : null, peds.positions());
  peds.update(dt, driven ? driven.pos : null, driven ? driven.vel : null, () => { sound.crash(8); }, camera.position);

  if (inp.camera) cam.far = !cam.far;
  if (inp.map) $("#bigmap-wrap").classList.toggle("show");
  updateCamera(dt, inp);

  // HUD
  const kmh = driven ? Math.abs(driven.speed) * 3.6 : 0;
  $("#speedo").classList.toggle("show", !!driven);
  if (driven) { $("#speed").textContent = Math.round(kmh); $("#speed-bar").style.width = Math.min(100, kmh / 2.4) + "%"; }
  $("#hud").classList.toggle("driving", !!driven);
  const p = focusPos();
  const dName = districtAt(p);
  if (dName !== lastDistrict) { lastDistrict = dName; $("#district").textContent = dName; $("#district").classList.remove("show"); void $("#district").offsetWidth; $("#district").classList.add("show"); }
  sound.update({ driving: !!driven, speed: driven ? driven.speed : 0, throttle: inp.y, horn: inp.horn && !!driven, beach: THREE.MathUtils.clamp(1 - (city.shoreX(p.z) - p.x) / 120, 0, 1), t: mats.time.value });
}

function districtAt(p) {
  if (p.x > city.landX1) return "Beach";
  for (const b of city.blocks) if (p.x > b.x0 - ROAD_W / 2 && p.x < b.x1 + ROAD_W / 2 && p.z > b.z0 - ROAD_W / 2 && p.z < b.z1 + ROAD_W / 2) {
    return { downtown: "Downtown", midtown: "Midtown", residential: "Palm Heights", beach: "Ocean Boulevard", park: "City Park" }[b.kind];
  }
  return "Outskirts";
}

function nearestCar() {
  let best = null, bd = 5.5;
  for (const c of traffic.cars) {
    const d = c.model.position.distanceTo(walker.pos);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function enterCar(c) {
  traffic.remove(c);
  driven = new DrivenCar(c.model);
  driven.heading = c.model.rotation.y;
  if (c.speed && !c.knocked) driven.vel.set(Math.sin(driven.heading), 0, Math.cos(driven.heading)).multiplyScalar(c.speed * 0.3);
  c.model.add(headlight, headlight.target);
  playerModel.visible = false;
  cam.yaw = driven.heading + Math.PI;
}

function exitCar() {
  const m = driven.model;
  const left = new THREE.Vector3(Math.cos(driven.heading), 0, -Math.sin(driven.heading));
  walker.pos.copy(driven.pos).addScaledVector(left, 1.9);
  walker.jumpY = 0;
  walker.facing = driven.heading;
  playerModel.visible = true;
  m.remove(headlight, headlight.target);
  // hand the car back to the traffic system as a parked (knocked) car
  const car = { model: m, a: 0, b: 0, t: 0, speed: 0, cruise: 12, turn: null, knocked: null };
  traffic.cars.push(car);
  traffic.knock(car, driven.vel);
  car.knocked.spin = 0;
  driven = null;
}

function updateCamera(dt, inp) {
  const sens = isTouch ? 0.0045 : 0.0026;
  cam.yaw -= inp.look.x * sens;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + inp.look.y * sens * 0.8, -0.15, 1.25);
  cam.dist = THREE.MathUtils.clamp(cam.dist + inp.zoom * 0.8, 3, 18);
  const p = focusPos();
  let dist, height;
  if (driven) {
    const sp = Math.abs(driven.speed);
    dist = (cam.far ? 13 : 8.2) + sp * 0.06;
    height = 1.7;
    if (!inp.recentLook && sp > 2) {
      const want = driven.heading + (driven.speed < -1 ? 0 : Math.PI);
      let d = want - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      cam.yaw += d * Math.min(1, dt * 2.5);
      cam.pitch += (0.16 - cam.pitch) * Math.min(1, dt * 1.5);
    }
    camera.fov += (60 + Math.min(18, sp * 0.4) - camera.fov) * Math.min(1, dt * 3);
  } else {
    dist = cam.far ? 7.5 : cam.dist;
    height = 1.55;
    camera.fov += (58 - camera.fov) * Math.min(1, dt * 3);
  }
  camera.updateProjectionMatrix();
  camTarget.set(p.x, (walker && !driven ? walker.model.position.y : p.y) + height, p.z);
  const cp = Math.cos(cam.pitch);
  const dir = tmp.set(Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), Math.cos(cam.yaw) * cp);
  // pull the camera in front of walls
  let d = dist;
  for (let s = 0.5; s <= dist; s += 0.5) {
    const x = camTarget.x + dir.x * s, y = camTarget.y + dir.y * s, z = camTarget.z + dir.z * s;
    if (city.grid.inside(x, y, z)) { d = Math.max(1.2, s - 0.6); break; }
  }
  camPos.copy(camTarget).addScaledVector(dir, d);
  camPos.y = Math.max(camPos.y, 0.5);
  if (shake > 0) { camPos.x += (Math.random() - 0.5) * shake; camPos.y += (Math.random() - 0.5) * shake; shake = Math.max(0, shake - dt * 2.5); }
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

// slow cinematic orbit around downtown behind the menu
let attractT = 0;
function attract(dt) {
  attractT += dt * 0.04;
  const c = city.downtown, r = city.half * 1.25;
  camera.position.set(c.x + Math.cos(attractT) * r, 90 + Math.sin(attractT * 0.7) * 30, c.z + Math.sin(attractT) * r);
  camera.lookAt(c.x, 30, c.z);
  camera.fov = 55; camera.updateProjectionMatrix();
  traffic.update(dt, null, null, peds.positions());
  peds.update(dt, null, null, null, camera.position);
}

// ---------------- UI ----------------
function setPrompt(kind) {
  const el = $("#prompt");
  el.classList.toggle("show", !!kind);
}

function showMenu(on) {
  if (on) {
    state = state === "menu" ? "menu" : "paused";
    $("#menu").classList.add("show");
    $("#menu").classList.toggle("paused", state === "paused");
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    $("#menu").classList.remove("show");
    state = "play";
    sound.start();
    if (!isTouch) canvas.requestPointerLock?.();
  }
}

document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && state === "play" && !isTouch) { showMenu(true); menuBlockUntil = performance.now() + 400; }
});

function buildUI() {
  const f = $("#gen");
  const set = (name, v) => { const el = f.elements[name]; if (el) el.value = v; const o = $(`#v-${name}`); if (o) o.textContent = fmt(name, v); };
  const fmt = (n, v) => n === "time" ? `${String(Math.floor(v)).padStart(2, "0")}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}` : n === "height" || n === "palms" ? `${(+v).toFixed(1)}×` : n === "density" ? `${Math.round(v * 100)}%` : n === "timeSpeed" ? (+v === 0 ? "Frozen" : `${v}×`) : n === "size" ? `${v}×${v} blocks` : v;
  for (const [k, v] of Object.entries(params)) set(k, v);
  f.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.name) return;
    params[el.name] = el.type === "range" ? +el.value : el.value;
    const o = $(`#v-${el.name}`); if (o) o.textContent = fmt(el.name, el.value);
    if (el.name === "time") { hours = +el.value; envHour = -99; }
    if (el.name === "timeSpeed") { /* live */ }
    if (el.name === "seed") $("#seed-name").textContent = cityName(hashSeed(el.value));
    save();
  });
  $("#seed-name").textContent = cityName(hashSeed(params.seed));
  $("#dice").addEventListener("click", () => {
    const words = ["neon", "palm", "coral", "breeze", "vice", "marina", "flamingo", "sunset", "tide", "boulevard", "ocean", "heat", "velvet", "cruise"];
    params.seed = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9999)}`;
    set("seed", params.seed);
    $("#seed-name").textContent = cityName(hashSeed(params.seed));
    save();
  });
  $("#btn-generate").addEventListener("click", async () => { save(); await generate(); state = "menu"; $("#menu").classList.remove("paused"); });
  $("#btn-play").addEventListener("click", async () => {
    save();
    if (state === "menu") {
      // fresh world each time the generator settings changed
      const sig = JSON.stringify({ ...params, time: 0, timeSpeed: 0, quality: 0 });
      if (sig !== lastSig) await generate();
      lastSig = sig;
      cam.yaw = Math.PI / 2 + 0.4; cam.pitch = 0.25;
    }
    showMenu(false);
  });
  f.elements.quality.addEventListener("change", () => { setupQuality(params.quality, T); });
  $("#btn-mute").addEventListener("click", () => { sound.setMuted(!sound.muted); $("#btn-mute").textContent = sound.muted ? "Sound: off" : "Sound: on"; });
  $("#bigmap-wrap").addEventListener("click", () => $("#bigmap-wrap").classList.remove("show"));
  f.addEventListener("submit", (e) => e.preventDefault());
  lastSig = JSON.stringify({ ...params, time: 0, timeSpeed: 0, quality: 0 });
}
let lastSig = "";

// small console hook for testing: fruti.setHour(22)
window.fruti = { setHour: (h) => { hours = h; envHour = -99; }, get state() { return state; } };

boot().catch((e) => {
  console.error(e);
  setLoading("Could not start: " + e.message);
});
