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
import { Traffic, DrivenCar, makeCarModel, setCarNight, loadRealCars, setDoor, doorPoints } from "./vehicles.js";
import { makePerson, Walker, Pedestrians, loadCharacter, seatedPose, poseSnapshot, blendPose } from "./people.js";
import { Input } from "./input.js";
import { Physics, loadRapier } from "./ragphys/physics.js";
import { Sound } from "./audio.js";
import { Minimap } from "./minimap.js";

const $ = (s) => document.querySelector(s);
const isTouch = matchMedia("(pointer: coarse)").matches;

// ---------------- settings ----------------
const DEFAULTS = {
  seed: "sunset", size: isTouch ? 8 : 10, height: 1, density: 0.75, palms: 1,
  traffic: isTouch ? 16 : 36, peds: isTouch ? 20 : 60, time: 17.6, timeSpeed: 1, quality: isTouch ? "low" : "high", sens: 1,
};
let params = { ...DEFAULTS };
try { Object.assign(params, JSON.parse(localStorage.getItem("fruti-world") || "{}")); } catch (e) { /* storage blocked */ }
const save = () => { try { localStorage.setItem("fruti-world", JSON.stringify(params)); } catch (e) { /* ignore */ } };

const QUALITY = {
  perf: { pr: 0.55, shadows: 0, bloom: false, reflect: false, msaa: 0, post: false },
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
  camera.far = quality.post === false ? 1400 : 9000;
  camera.updateProjectionMatrix();
  stars.visible = quality.post !== false;
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
let rapier = null, physics = null;
let walker, playerModel, driven = null, state = "menu", limits, menuBlockUntil = 0;
let hours = params.time;
let cam = { yaw: 0.6, pitch: 0.28, dist: 5, far: false };
let camY = null;
let shake = 0, lastDistrict = "", districtTimer = 0;
let seq = null;              // scripted get-in / get-out of a car
let wastedT = -1;            // > 0 while the WASTED screen is up
const stats = { walked: 0, driven: 0, top: 0, punches: 0, kos: 0, stolen: 0, wasted: 0, play: 0 };
const VEHICLE_NAMES = {
  silverado: ["Chevrolet Silverado 1500 RST", "Pickup"], seal: ["BYD Seal", "Sedan"], urus: ["Lamborghini Urus Performante", "SUV"], f1: ["McLaren F1", "Super"],
  sedan: ["Coastline Sedan", "Sedan"], sports: ["Vapor GT", "Sports"], suv: ["Palmetto", "SUV"], taxi: ["Sunshine Cab", "Service"], van: ["Breeze Van", "Van"],
};

async function boot() {
  setLoading("Painting textures…");
  T = await buildTextures({ brick: { diff: brickDiff, nor: brickNor, arm: brickArm }, stucco: { diff: stuccoDiff, nor: stuccoNor, arm: stuccoArm }, stucco2: { diff: stucco2Diff, nor: stucco2Nor, arm: stucco2Arm }, grass: { diff: grassDiff, nor: grassNor, arm: grassArm }, pavers: { diff: paversDiff, nor: paversNor, arm: paversArm }, pebbles: { diff: pebblesDiff, nor: pebblesNor, arm: pebblesArm } });
  setLoading("Loading characters…");
  await loadCharacter();
  setLoading("Loading physics…");
  rapier = await loadRapier().catch((e) => { console.warn("Ragdoll physics unavailable", e); return null; });
  setLoading("Loading cars…");
  await loadRealCars();
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
const TIPS = [
  "Every seed builds a different city. Same seed, same city.",
  "Press F next to any car to get in — even one stopped at the lights.",
  "Hold Space while driving to pull the handbrake and drift.",
  "Crouch with C to sneak. Sprint with Shift.",
  "The city lights up at night: try a fast time speed in the World tab.",
  "Open the map with M, or pause with Esc.",
];
setInterval(() => { const el = $("#loading-tip"); if (el) el.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]; }, 4000);

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
  physics?.world.free();
  physics = rapier ? new Physics(rapier, { boxes: city.colliders, ramps: [], cyls: [] }) : null;
  const rng = makeRng(seed + 99);
  traffic = new Traffic(city, scene, rng, params.traffic);
  peds = new Pedestrians(city, scene, rng, params.peds);
  peds.physics = physics;
  peds.onDeath = () => { stats.kos++; };
  peds.onPlayerHit = () => { sound.crash(6); hurtFlash(); shake = 0.25; };
  seq = null; wastedT = -1; document.body.classList.remove("wasted");
  // player + a car waiting at the curb
  playerModel = makePerson({ body: 0xe8e2d8, joints: 0xff4f8b });
  playerModel.position.copy(city.spawn);
  scene.add(playerModel);
  walker = new Walker(playerModel, limits);
  walker.physics = physics;
  walker.teleport(city.spawn, -Math.PI / 2);
  const car = traffic.spawn(null, "f1");
  car.model.position.set(city.spawn.x - 4.4, 0.03, city.spawn.z - 3);
  car.model.rotation.y = Math.PI;
  traffic.knock(car, new THREE.Vector3());
  car.knocked.spin = 0;
  hours = params.time;
  minimap = new Minimap(city, $("#minimap"), $("#bigmap"), cityName(seed));
  $("#city-name").textContent = cityName(seed);
  $("#pm-city").textContent = cityName(seed);
  $("#pm-seed").textContent = "Seed · " + params.seed;
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
  scene.fog.density = (0.00045 + (1 - day) * 0.00025 + golden * 0.0002) * (quality.post === false ? 3 : 1);
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
  if (Math.abs(hours - envHour) > (quality.post === false ? 2 : 0.2)) {
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
  else if (state === "paused" && activeTab === "map") minimap.drawBig(focusPos(), driven ? driven.heading : walker.facing, $("#pmap"));

  const { night } = updateSky(dt);
  if (quality.post === false) renderer.render(scene, camera);
  else composer.render();
  document.body.classList.toggle("in-menu", state === "menu");
  document.body.classList.toggle("paused", state === "paused");
  if (state !== "menu") minimap.draw(focusPos(), cam.yaw, driven ? driven.heading : walker.facing, traffic.cars, hours);
  $("#clock").textContent = `${String(Math.floor(hours)).padStart(2, "0")}:${String(Math.floor((hours % 1) * 60)).padStart(2, "0")}`;
}

// Ragdolls: step Rapier only while someone is down, then pose their bones from the bodies.
function stepPhysics(dt) {
  if (!physics) return;
  if (!walker.down && !peds.list.some((p) => p.dead?.rd)) return;
  physics.update(dt);
  walker.afterPhysics();
  peds.afterPhysics();
}

const _fp = new THREE.Vector3();
// what the camera and HUD follow: the car you drive, or your body (in world space, even mid get-in)
const focusPos = () => (driven ? driven.pos : playerModel.parent === scene ? walker.pos : playerModel.getWorldPosition(_fp));

const NO_INPUT = { x: 0, y: 0, sprint: false, jump: false, handbrake: false, enter: false, horn: false, crouch: false, attack: false };
function play(realDt, inp) {
  stats.play += realDt;
  // WASTED: slow motion and a grey screen, then back on your feet at the start
  if (walker.dead && wastedT < 0) { wastedT = 0; stats.wasted++; document.body.classList.add("wasted"); sound.crash(20); }
  const dt = wastedT >= 0 ? realDt * 0.35 : realDt;
  if (wastedT >= 0) {
    wastedT += realDt;
    if (wastedT > 6) {
      wastedT = -1;
      document.body.classList.remove("wasted");
      walker.respawn(city.spawn, -Math.PI / 2);
      help("You were patched up and dropped back at the beach.", 5);
    }
  }
  const busy = !!seq || wastedT >= 0;
  const ctl = busy ? NO_INPUT : inp;
  // simulation
  let hit = 0;
  if (seq) updateSeq(dt);
  if (driven) {
    hit = driven.update(dt, seq ? { x: 0, y: driven.speed > 0.5 ? -1 : 0, handbrake: false } : ctl, city.grid, limits);
    stats.driven += Math.abs(driven.speed) * dt;
    stats.top = Math.max(stats.top, Math.abs(driven.speed) * 3.6);
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
    if (ctl.horn) traffic.cars.forEach((c) => { if (!c.knocked && c.model.position.distanceTo(driven.pos) < 30) c.cruise = Math.min(22, c.cruise + dt * 4); });
  } else if (seq) {
    // walker is being moved by the get-in / get-out sequence
  } else {
    // sprint stamina: drains while sprinting, refills otherwise
    const sprinting = ctl.sprint && Math.hypot(ctl.x, ctl.y) > 0.2;
    stamina = THREE.MathUtils.clamp(stamina + (sprinting ? -dt * 9 : dt * 14), 0, 100);
    walker.update(dt, stamina > 2 ? ctl : { ...ctl, sprint: false }, cam.yaw * 1, city.grid, limits);
    stats.walked += walker.speed * dt;
    // collide with cars; a moving one knocks the player down
    for (const c of traffic.cars) {
      const m = c.model, f = tmp.set(Math.sin(m.rotation.y), 0, Math.cos(m.rotation.y));
      const carSpeed = c.knocked ? c.knocked.vel.length() : c.speed;
      for (const o of [-1.3, 0, 1.3]) {
        const cx = m.position.x + f.x * o, cz = m.position.z + f.z * o;
        const dx = walker.pos.x - cx, dz = walker.pos.z - cz, d = Math.hypot(dx, dz);
        if (d < 1.35 && d > 1e-4 && walker.pos.y < 1.3) {
          walker.pos.x = cx + (dx / d) * 1.35; walker.pos.z = cz + (dz / d) * 1.35;
          if (carSpeed > 4 && !walker.down) {
            const v = c.knocked ? c.knocked.vel.clone() : f.clone().multiplyScalar(carSpeed);
            walker.knock(v.multiplyScalar(0.8).add(new THREE.Vector3(dx / d * 2, 3 + carSpeed * 0.2, dz / d * 2)), carSpeed * 5);
            sound.crash(carSpeed); shake = 0.6; hurtFlash();
          }
        }
      }
    }
    // shove pedestrians out of the way (sprinting into them makes them stagger or fall)
    if (!walker.down) for (const pd of peds.list) {
      if (pd.dead) continue;
      const q = pd.model.position, dx = q.x - walker.pos.x, dz = q.z - walker.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.62 && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = 0.79 - d;
        q.x += (dx / d) * push * 0.6; q.z += (dz / d) * push * 0.6;
        walker.pos.x -= (dx / d) * push * 0.4; walker.pos.z -= (dz / d) * push * 0.4;
        if (walker.speed > 1.2) peds.bump(pd, dx / d, dz / d, walker.speed);
      }
    }
  }
  if (hit > 6) { sound.crash(hit); shake = Math.min(1, hit / 25); }

  // punching: the fist lands ~0.22 s into the strike, on whoever is in front within reach
  if (!driven && !busy && ctl.attack) walker.attack();
  if (!driven && walker.punchT > 0 && walker.punchT < 0.4 && !walker.punchHit) {
    walker.punchHit = true;
    const f = new THREE.Vector3(Math.sin(walker.facing), 0, Math.cos(walker.facing));
    let best = null, bd = 1.45;
    for (const pd of peds.list) {
      if (pd.dead) continue;
      const d = pd.model.position.clone().sub(walker.pos).setY(0), dist = d.length();
      if (dist < bd && d.dot(f) > dist * 0.45) { bd = dist; best = pd; }
    }
    if (best) {
      peds.punch(best, best.model.position.clone().sub(walker.pos).setY(0).normalize());
      stats.punches++;
      sound.crash(5); shake = 0.15;
    }
  }

  // enter / exit vehicles
  const near = walker.down || busy ? null : nearestCar();
  if (ctl.enter) {
    if (driven) exitCar();
    else if (near) enterCar(near);
  }
  if (!driven && near) help(`Press <img src="ui/keyboard_f.png" alt="F"> to get in the ${VEHICLE_NAMES[near.model.userData.type]?.[0] || "car"}.`, 0.3, "car");
  else if (helpKey === "car") hideHelp();

  traffic.update(dt, driven ? null : walker.pos, driven ? driven.pos : null, peds.positions());
  walker.inCar = !!driven || (seq && seq.phase !== "walk");
  const carObs = traffic.cars.map((c) => ({ x: c.model.position.x, z: c.model.position.z, h: c.model.rotation.y }));
  if (driven) carObs.push({ x: driven.pos.x, z: driven.pos.z, h: driven.heading });
  peds.update(dt, driven ? driven.pos : null, driven ? driven.vel : null, () => { sound.crash(8); }, camera.position, driven ? driven.pos : walker.pos, carObs, walker);
  stepPhysics(dt);

  if (inp.camera) cam.far = !cam.far;
  if (inp.map) $("#bigmap-wrap").classList.toggle("show");
  // health / stamina bars, damage vignette
  $("#hp i").style.width = walker.health + "%";
  $("#hp").classList.toggle("low", walker.health < 30);
  $("#st i").style.width = stamina + "%";
  flashA = Math.max(0, flashA - realDt * 1.5);
  $("#flash").style.opacity = Math.max(flashA, walker.health < 30 ? 0.35 + Math.sin(stats.play * 5) * 0.1 : 0);
  tickHelp(realDt);
  updateCamera(dt, inp);

  // HUD
  const kmh = driven ? Math.abs(driven.speed) * 3.6 : 0;
  $("#speedo").classList.toggle("show", !!driven);
  if (driven) { $("#speed").textContent = Math.round(kmh); $("#speed-bar").style.width = Math.min(100, kmh / 2.4) + "%"; }
  $("#hud").classList.toggle("driving", !!driven);
  const p = focusPos();
  const dName = districtAt(p);
  if (dName !== lastDistrict) {
    lastDistrict = dName;
    $("#district").textContent = dName;
    $("#area-sub").textContent = city ? $("#city-name").textContent : "";
    $("#area").classList.add("show");
    clearTimeout(areaTO); areaTO = setTimeout(() => $("#area").classList.remove("show"), 5000);
  }
  sound.update({ driving: !!driven, speed: driven ? driven.speed : 0, throttle: ctl.y, horn: inp.horn && !!driven, beach: THREE.MathUtils.clamp(1 - (city.shoreX(p.z) - p.x) / 120, 0, 1), t: mats.time.value });
}

function districtAt(p) {
  if (p.x > city.landX1) return "Beach";
  if (p.x > city.half - ROAD_W / 2) return "Ocean Boulevard";
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

// ---------- getting in and out of cars (walk to the door, open it, duck in, close it) ----------
const ease = (u) => (u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u));
function enterCar(c) {
  traffic.remove(c);            // the car stops where it is (its driver hits the brakes)
  seq = { type: "enter", model: c.model, phase: "walk", t: 0 };
  stats.stolen++;
}

function exitCar() {
  if (!driven) return;
  seq = { type: "exit", model: driven.model, phase: "stop", t: 0 };
}

function updateSeq(dt) {
  const S = seq, m = S.model;
  S.t += dt;
  const h = m.rotation.y;
  const { outside } = doorPoints(m);
  const faceIn = Math.atan2(-Math.cos(h), Math.sin(h)), faceOut = Math.atan2(Math.cos(h), -Math.sin(h));
  const qOf = (yaw) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const next = (phase) => { S.phase = phase; S.t = 0; };
  const info = m.userData.doorInfo, door = m.userData.door;
  // the outside door handle, which moves with the door as it swings
  const handle = () => (door ? door.localToWorld(new THREE.Vector3(0.05, info.height * 0.58, -info.len * 0.82)) : outside.clone().setY(1));
  // blend the whole body from one pose + place to another (the animator is paused meanwhile)
  const blendTo = (u) => {
    blendPose(playerModel, S.from, S.to, u);
    playerModel.position.lerpVectors(S.fromPos, S.toPos, u);
    playerModel.quaternion.slerpQuaternions(S.fromQ, S.toQ, u);
  };
  if (S.type === "enter") {
    if (S.phase === "walk") {
      // walk round the car (front or back, whichever is closer) to the driver's door — never through it
      if (!S.path) {
        const L = m.userData.spec.l / 2 + 1.1, side = info.side + 1.3;
        const lp = m.worldToLocal(walker.pos.clone());
        const end = lp.z > (info.front - info.len / 2) ? L : -L;
        const pts = [];
        if (lp.x < side - 0.4) {
          if (lp.x < -info.side) pts.push(new THREE.Vector3(-side, 0, end));
          pts.push(new THREE.Vector3(side, 0, end));
        }
        S.path = pts.map((v) => m.localToWorld(v));
        S.path.push(outside);
      }
      const tgt = S.path[0];
      const dx = tgt.x - walker.pos.x, dz = tgt.z - walker.pos.z, d = Math.hypot(dx, dz);
      if (d < (S.path.length > 1 ? 0.8 : 0.3)) { S.path.shift(); if (!S.path.length) next("open"); }
      else if (S.t > 8) next("open");
      else walker.auto(dt, Math.atan2(dx, dz), Math.hypot(outside.x - walker.pos.x, outside.z - walker.pos.z) > 3 ? "run" : "walk", city.grid, limits);
      // keep out of the car body
      const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
      for (const o of [-1.3, 0, 1.3]) {
        const cx = m.position.x + f.x * o, cz = m.position.z + f.z * o;
        const ex = walker.pos.x - cx, ez = walker.pos.z - cz, e = Math.hypot(ex, ez), r = info.side + 0.45;
        if (e < r && e > 1e-4) { walker.pos.x = cx + (ex / e) * r; walker.pos.z = cz + (ez / e) * r; }
      }
    } else if (S.phase === "open") {
      // reach for the handle with the right hand, then pull the door open
      walker.anim.setLead("R", handle());
      walker.auto(dt, faceIn, "idle");
      walker.pos.x += (outside.x - walker.pos.x) * Math.min(1, dt * 8); walker.pos.z += (outside.z - walker.pos.z) * Math.min(1, dt * 8);
      setDoor(m, ease((S.t - 0.3) / 0.55));
      if (S.t > 0.9) {
        walker.anim.setLead(null);
        const pose = seatedPose(playerModel, m);
        Object.assign(S, { from: poseSnapshot(playerModel), to: pose.bones, fromPos: playerModel.position.clone(), toPos: pose.pos, fromQ: playerModel.quaternion.clone(), toQ: pose.quat });
        next("in");
      }
    } else if (S.phase === "in") {
      // duck in: turn to face forward, lower onto the seat, legs in, hands to the wheel
      blendTo(ease(S.t / 1.05));
      if (S.t > 1.1) { blendTo(1); m.attach(playerModel); next("close"); }
    } else if (S.phase === "close") {
      setDoor(m, 1 - ease(S.t / 0.35));
      if (S.t > 0.38) {
        setDoor(m, 0);
        driven = new DrivenCar(m);
        driven.heading = h;
        m.add(headlight, headlight.target);
        seq = null;
        showVehicle(m.userData.type);
      }
    }
  } else {
    if (S.phase === "stop") {
      // brake to a stop first (the driving code brakes while a sequence runs)
      if (Math.abs(driven.speed) < 0.6 || S.t > 2.5) next("open");
    } else if (S.phase === "open") {
      setDoor(m, ease(S.t / 0.45));
      if (S.t > 0.5) {
        // hand the car back to the traffic system as a parked car
        m.remove(headlight, headlight.target);
        const car = { model: m, a: 0, b: 0, t: 0, speed: 0, cruise: 12, turn: null, knocked: null };
        traffic.cars.push(car);
        traffic.knock(car, new THREE.Vector3());
        car.knocked.spin = 0;
        S.car = car;
        driven = null;
        scene.attach(playerModel);
        const rest = playerModel.userData.rest;
        Object.assign(S, { from: poseSnapshot(playerModel), to: rest, fromPos: playerModel.position.clone(), toPos: outside.clone().setY(0.04), fromQ: playerModel.quaternion.clone(), toQ: qOf(faceOut) });
        next("out");
      }
    } else if (S.phase === "out") {
      // swing the legs out and stand up beside the car
      blendTo(ease(S.t / 1.0));
      if (S.t > 1.05) {
        blendTo(1);
        walker.teleport(outside, faceOut);
        next("close");
      }
    } else if (S.phase === "close") {
      walker.auto(dt, faceOut, "idle");
      if (S.t > 0.15) walker.anim.setLead("R", handle());
      setDoor(m, 1 - ease((S.t - 0.2) / 0.4));
      if (S.t > 0.65) { setDoor(m, 0); walker.anim.setLead(null); seq = null; }
    }
    // keep the parked car from sliding while the door is open
    if (S.car) S.car.knocked.vel.set(0, 0, 0);
  }
}

// ---------- HUD helpers ----------
let helpKey = null, helpT = 0, areaTO = 0, vehTO = 0, flashA = 0, stamina = 100, activeTab = "map";
function help(html, seconds = 5, key = html) {
  const el = $("#help");
  if (helpKey !== key) { el.innerHTML = html; helpKey = key; }
  helpT = seconds;
  el.classList.add("show");
}
function hideHelp() { helpKey = null; helpT = 0; $("#help").classList.remove("show"); }
function tickHelp(dt) { if (helpT > 0 && (helpT -= dt) <= 0) hideHelp(); }
function hurtFlash() { flashA = 0.9; }
function showVehicle(type) {
  const [name, cls] = VEHICLE_NAMES[type] || ["Car", ""];
  $("#vehicle-name").textContent = name;
  $("#vehicle-class").textContent = cls;
  $("#vehicle").classList.add("show");
  clearTimeout(vehTO); vehTO = setTimeout(() => $("#vehicle").classList.remove("show"), 4000);
}
// first-time tips, one after another
const TUTORIAL = [
  [`Use <img src="ui/keyboard_w.png" alt="W"><img src="ui/keyboard_a.png" alt="A"><img src="ui/keyboard_s.png" alt="S"><img src="ui/keyboard_d.png" alt="D"> to move and the mouse to look around. Hold <img src="ui/keyboard_shift.png" alt="Shift"> to sprint.`, 7],
  [`The McLaren at the curb is yours. Walk up to it and press <img src="ui/keyboard_f.png" alt="F">.`, 7],
  [`Press <img src="ui/keyboard_escape.png" alt="Esc"> to pause, see the map and generate a new city.`, 6],
];
function runTutorial() {
  let i = 0;
  const step = () => { if (i < TUTORIAL.length && state === "play") { if (helpKey !== "car") help(TUTORIAL[i][0], TUTORIAL[i][1]); setTimeout(step, (TUTORIAL[i++][1] + 1) * 1000); } };
  setTimeout(step, 800);
}

function updateCamera(dt, inp) {
  const sens = (isTouch ? 0.0045 : 0.0026) * (params.sens || 1);
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
  const ty = (walker && !driven && playerModel.parent === scene ? Math.max(walker.model.position.y, 0) : p.y) + height;
  camY = camY == null || Math.abs(camY - ty) > 5 ? ty : camY + (ty - camY) * Math.min(1, dt * 7);
  camTarget.set(p.x, camY, p.z);
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
  // smooth follow (snaps on teleports)
  if (camera.position.distanceTo(camPos) > 25) camera.position.copy(camPos);
  else camera.position.lerp(camPos, 1 - Math.exp(-dt * 16));
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
  stepPhysics(dt);
}

// ---------------- UI ----------------
function setTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".tab-panel")) p.classList.toggle("on", p.dataset.tab === name);
  if (name === "stats") renderStats();
}
const TAB_ORDER = ["map", "world", "stats", "settings", "controls", "credits"];

function renderStats() {
  const mins = Math.floor(stats.play / 60), secs = Math.floor(stats.play % 60);
  const km = (m) => (m / 1000).toFixed(2) + " km";
  const items = [
    [`${mins}:${String(secs).padStart(2, "0")}`, "Time played"], [km(stats.walked), "On foot"], [km(stats.driven), "Driven"],
    [Math.round(stats.top) + " km/h", "Top speed"], [stats.stolen, "Cars taken"], [stats.punches, "Punches landed"],
    [stats.kos, "People down"], [stats.wasted, "Times wasted"],
  ];
  $("#stats").innerHTML = items.map(([v, k]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
}

function showMenu(on) {
  if (on) {
    const wasPlaying = state === "play";
    state = state === "menu" ? "menu" : "paused";
    $("#menu").classList.add("show");
    $("#menu").classList.toggle("paused", state === "paused");
    setTab(state === "paused" ? "map" : "world");
    const hh = Math.floor(hours), mm = Math.floor((hours % 1) * 60);
    $("#pm-time").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} · ${lastDistrict || "Ocean Boulevard"}`;
    $("#pm-sub").textContent = state === "paused" ? "Paused" : "Open-world city generator";
    if (document.pointerLockElement) document.exitPointerLock();
    if (wasPlaying) sound.setPaused?.(true);
  } else {
    $("#menu").classList.remove("show");
    const first = state === "menu";
    state = "play";
    sound.start();
    if (first) runTutorial();
    if (!isTouch) canvas.requestPointerLock?.();
  }
}

document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement && state === "play" && !isTouch) { showMenu(true); menuBlockUntil = performance.now() + 400; }
});

function buildUI() {
  const f = $("#menu");
  for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));
  addEventListener("keydown", (e) => {
    if (state !== "paused" || e.target.tagName === "INPUT") return;
    const i = TAB_ORDER.indexOf(activeTab);
    if (e.code === "KeyE" || e.code === "ArrowRight") setTab(TAB_ORDER[(i + 1) % TAB_ORDER.length]);
    if (e.code === "KeyQ" || e.code === "ArrowLeft") setTab(TAB_ORDER[(i + TAB_ORDER.length - 1) % TAB_ORDER.length]);
  });
  const set = (name, v) => { const el = f.elements[name]; if (el) el.value = v; const o = $(`#v-${name}`); if (o) o.textContent = fmt(name, v); };
  const fmt = (n, v) => n === "sens" ? `${(+v).toFixed(1)}×` : n === "time" ? `${String(Math.floor(v)).padStart(2, "0")}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}` : n === "height" || n === "palms" ? `${(+v).toFixed(1)}×` : n === "density" ? `${Math.round(v * 100)}%` : n === "timeSpeed" ? (+v === 0 ? "Frozen" : `${v}×`) : n === "size" ? `${v}×${v} blocks` : v;
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
  $("#btn-generate").addEventListener("click", async () => { save(); await generate(); state = "menu"; showMenu(true); lastSig = JSON.stringify({ ...params, time: 0, timeSpeed: 0, quality: 0, sens: 0 }); });
  $("#btn-play").addEventListener("click", async () => {
    save();
    if (state === "menu") {
      // fresh world each time the generator settings changed
      const sig = JSON.stringify({ ...params, time: 0, timeSpeed: 0, quality: 0, sens: 0 });
      if (sig !== lastSig) { await generate(); state = "menu"; }
      lastSig = sig;
      cam.yaw = Math.PI / 2 + 0.4; cam.pitch = 0.25;
    }
    showMenu(false);
  });
  f.elements.quality.addEventListener("change", () => { setupQuality(params.quality, T); });
  $("#btn-mute").addEventListener("click", () => { sound.setMuted(!sound.muted); $("#btn-mute").textContent = sound.muted ? "Sound: off" : "Sound: on"; });
  $("#bigmap-wrap").addEventListener("click", () => $("#bigmap-wrap").classList.remove("show"));
  f.addEventListener("submit", (e) => e.preventDefault());
  lastSig = JSON.stringify({ ...params, time: 0, timeSpeed: 0, quality: 0, sens: 0 });
}
let lastSig = "";

// small console hook for testing: fruti.setHour(22)
window.fruti = { setHour: (h) => { hours = h; envHour = -99; }, get state() { return state; }, get world() { return { peds, walker, traffic, physics, camera, cam, seqPhase: seq?.phase, seqT: seq?.t, seqModel: seq?.model, drivenHeading: driven?.heading }; } };

boot().catch((e) => {
  console.error(e);
  setLoading("Could not start: " + e.message);
});
