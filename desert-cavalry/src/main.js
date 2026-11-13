import * as THREE from 'three';
import { createSky, createEnvironment, createSunLight, atmosphereUniforms } from './env/atmosphere.js';
import { createTerrain, createMountains, createPebbles } from './env/terrain.js';
import { Pipeline } from './fx/post.js';
import { createDustSystem } from './fx/dust.js';
import { HoofPrints } from './fx/hoofprints.js';
import { createMaterialLibrary } from './cavalry/materials.js';
import { loadHorseAsset } from './cavalry/horseAsset.js';
import { Cavalry, SLIP } from './cavalry/cavalry.js';
import { Legion } from './cavalry/legion.js';
import { PlayerRig } from './core/playerRig.js';
import { DURATION, sampleTimeline, EventCursor } from './core/timeline.js';
import { BattleAudio } from './audio/battleAudio.js';
import { Recorder } from './core/recorder.js';
import { bindUI } from './ui/ui.js';

const DEBUG = new URLSearchParams(location.search).has('debug');
const BASE_STRIDE_HZ = 2.45;  // 基准步频（真实奔马约 2.2–2.6 Hz）
const FADE_OUT = 0.7, FADE_IN = 0.9;

const canvas = document.getElementById('view');
const note = document.getElementById('load-note');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(64, 16 / 9, 0.07, 14000);

// ------------------------------------------------------------------ 资源
note.textContent = '载入地表贴图…';
const texLoader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const loadTex = (n, srgb) => texLoader.loadAsync(`./assets/textures/${n}`).then((t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = Math.min(8, maxAniso);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t;
});
const [sandD, sandN, sandR, gravD, gravN, gravR, rockD, rockN] = await Promise.all([
  loadTex('sand_01_diff_2k.jpg', true), loadTex('sand_01_nor_gl_2k.jpg'), loadTex('sand_01_rough_2k.jpg'),
  loadTex('sandy_gravel_02_diff_2k.jpg', true), loadTex('sandy_gravel_02_nor_gl_2k.jpg'), loadTex('sandy_gravel_02_rough_2k.jpg'),
  loadTex('cliff_side_diff_2k.jpg', true), loadTex('cliff_side_nor_gl_2k.jpg'),
]);

// ------------------------------------------------------------------ 环境
const sky = createSky(); sky.scale.setScalar(9000); scene.add(sky);
scene.environment = createEnvironment(renderer);
scene.environmentIntensity = 1.35;
const { sun, hemi, follow: followSun } = createSunLight(); scene.add(sun, sun.target, hemi);
const terrain = createTerrain({ sandD, sandN, sandR, gravD, gravN, gravR }); scene.add(terrain);
const mountains = createMountains({ d: rockD, n: rockN }); scene.add(mountains);
const pebbles = createPebbles({ d: rockD }); scene.add(pebbles);

const pipeline = new Pipeline(renderer);
const dust = createDustSystem(pipeline.depthUniforms); scene.add(dust.group);
const prints = new HoofPrints(); scene.add(prints.mesh);

// ------------------------------------------------------------------ 骑兵
note.textContent = '载入战马并烘焙奔跑动画…';
const lib = createMaterialLibrary();
const asset = await loadHorseAsset('./assets/models/horse_run.glb');
const cavalry = new Cavalry({ asset, lib, dust, prints, uniforms: atmosphereUniforms });
scene.add(cavalry.group);
const rig = new PlayerRig(camera);
const audio = new BattleAudio();
const recorder = new Recorder(canvas);
const BASE_SPEED = asset.strideLength * SLIP * BASE_STRIDE_HZ;

// ------------------------------------------------------------------ 状态
const state = {
  mode: 'idle',           // idle（开场待机，世界在跑、时间线停在 0）| playing | paused
  t: 0, simTime: 0, speedMul: 1, dustOn: true, soundOn: true,
  px: 0, pz: 0, fade: 0, recording: false,
  recFormat: Recorder.pick('mp4') ? 'mp4' : 'webm',
};
const tl = {};
const cursor = new EventCursor();
const playerInfo = { x: 0, z: 0, speed: BASE_SPEED };
const shoutIdx = [];
// 军阵：先让近景骑兵算出一帧姿态（供烘焙远景骑手），再创建
sampleTimeline(0, tl);
cavalry.update(0, tl, playerInfo);
const legion = new Legion({ asset, lib, cavalry, dust, timeUniform: atmosphereUniforms.uTime });
scene.add(legion.group);
const STRIDE = asset.strideLength * SLIP;
const nearList = [];
const _p = new THREE.Vector3(), _inv = new THREE.Matrix4();

cavalry.onPlayerHoof = (h, hoof) => {
  const s = 0.75 + 0.25 * tl.intensity;
  rig.impact(s, hoof.fore);
  audio.hoof(s, hoof.right ? 0.6 : -0.6, !hoof.fore);
};

function camLocal(i, out) {
  cavalry.riderPosition(i, _p).applyMatrix4(_inv);
  out.x = _p.x; out.y = _p.y; out.z = _p.z;
  return out;
}

function fireEvent(ev) {
  if (ev.type === 'shout') {
    cavalry.triggerShout(ev.n, shoutIdx); // 只保留举槊动作，不出声
  } else if (ev.type === 'whinny') {
    const i = cavalry.count > 1 ? 1 + Math.floor(Math.random() * Math.min(6, cavalry.count - 1)) : 0;
    audio.whinny(camLocal(i, {}), 0.8);
  }
}

function restartWorld() {
  // 回到原点（保持浮点精度，也让每一遍演出完全一致）
  state.px = 0; state.pz = 0;
  dust.hoof.clear();
  prints.clear();
  cavalry.reset();
  rig.reset();
  cursor.reset();
  pipeline.firstFrame = true;
}

function step(dt) {
  state.simTime += dt;
  if (state.mode === 'playing') {
    state.t += dt;
    if (state.t >= DURATION) {
      // 一遍演出结束：停止录制，循环重播
      if (state.recording) stopRecording();
      state.t -= DURATION;
      restartWorld();
    }
  }
  sampleTimeline(state.t, tl);
  if (state.mode === 'idle') { tl.yaw = 0.25 * Math.sin(state.simTime * 0.25); tl.pitch = -0.16; }
  const speed = BASE_SPEED * tl.speed * state.speedMul;
  state.pz -= speed * dt;
  state.px = 0.5 * Math.sin(state.simTime * 0.13);
  playerInfo.x = state.px; playerInfo.z = state.pz; playerInfo.speed = speed;

  atmosphereUniforms.uTime.value = state.simTime;
  atmosphereUniforms.uDustAmount.value = state.dustOn ? 0.75 + 0.6 * tl.intensity : 0.2;
  cavalry.simTime = state.simTime;
  cavalry.dustAmount = state.dustOn ? 0.75 + 0.5 * tl.intensity : 0;
  cavalry.update(dt, tl, playerInfo);
  legion.update(dt, state.simTime, playerInfo, STRIDE, cavalry.dustAmount);
  rig.update(dt, cavalry.player, tl);

  // 环境跟随
  const cp = camera.position;
  sky.position.copy(cp);
  mountains.position.set(cp.x, 0, cp.z);
  terrain.userData.setOrigin(cp.x, cp.z);
  pebbles.userData.setOrigin(cp.x, cp.z);
  followSun(_p.set(state.px, cavalry.player.horse.elements[13], state.pz - 2));

  // 事件与声音
  _inv.copy(camera.matrixWorld).invert();
  if (state.mode === 'playing') cursor.advance(state.t, fireEvent);
  nearList.length = 0;
  for (let i = 1; i < Math.min(cavalry.count, 7); i++) nearList.push(camLocal(i, nearList[i - 1] ?? {}));
  audio.update(state.mode === 'playing' ? tl.intensity : 0.15, tl.speed * state.speedMul, nearList);

  dust.hoof.flush();
  prints.flush();

  // 循环处的沙尘转场
  let f = 0;
  if (state.mode !== 'idle') {
    if (state.t > DURATION - FADE_OUT) f = (state.t - (DURATION - FADE_OUT)) / FADE_OUT;
    else if (state.t < FADE_IN && state.loops > 0) f = 1 - state.t / FADE_IN;
  }
  state.fade = f * f * (3 - 2 * f);
}
state.loops = 0;

function render(dt) {
  pipeline.motionBlur = dt > 0 ? Math.min(2.5, (1 / 48) / dt) : 0; // 180° 快门（1/48 秒）
  pipeline.dustEnabled = state.dustOn;
  pipeline.render(scene, camera, state.simTime, state.fade);
}

// ------------------------------------------------------------------ 尺寸
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const pr = Math.min(window.devicePixelRatio || 1, 2, 2560 / w);
  const W = Math.round(w * pr), H = Math.round(h * pr);
  renderer.setSize(W, H, false);
  pipeline.setSize(W, H);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

// ------------------------------------------------------------------ 控制
async function start() {
  if (!audio.ctx) {
    await audio.init();
    audio.start();
    audio.setEnabled(state.soundOn);
    if (audio.report.synthesized.length) console.info('[audio] 以下采样缺失，已改用程序合成：', audio.report.synthesized.join(', '));
  }
  audio.resume();
  state.loops = 0; state.t = 0; state.mode = 'playing';
  restartWorld();
  ui.sync();
}
function togglePause() {
  if (state.mode === 'playing') { state.mode = 'paused'; audio.suspend(); }
  else if (state.mode === 'paused') { state.mode = 'playing'; audio.resume(); }
  ui.sync();
}
function replay() { if (state.mode === 'idle') return start(); state.t = 0; state.loops = 0; state.mode = 'playing'; audio.resume(); restartWorld(); ui.sync(); }
async function startRecording() {
  if (!Recorder.supported()) { alert('此浏览器不支持 MediaRecorder / captureStream，无法录制视频。'); return; }
  await start();
  recorder.start(audio.streamDest?.stream, state.recFormat);
  state.recording = true; ui.sync();
}
async function stopRecording() {
  if (!state.recording) return;
  state.recording = false; ui.sync();
  await recorder.stop();
}

const ui = bindUI({
  state,
  onStart: start, onPause: togglePause, onReplay: replay,
  onCount: (n) => cavalry.setCount(n),
  onLegion: (n) => legion.setCount(n),
  onSpeed: (v) => { state.speedMul = v; },
  onDust: (on) => { state.dustOn = on; },
  onSound: (on) => { state.soundOn = on; audio.setEnabled(on); },
  onFormat: (f) => { state.recFormat = f; },
  mp4Supported: !!Recorder.pick('mp4'),
  onRecord: () => (state.recording ? stopRecording() : startRecording()),
  duration: DURATION,
});

// ------------------------------------------------------------------ 主循环（真实时间差）
let last = performance.now();
if (!DEBUG) {
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (state.mode !== 'paused') step(dt);
    render(state.mode === 'paused' ? 0 : dt);
    ui.tick();
  });
}
// 标签页隐藏时暂停计时，避免回来后跳帧
document.addEventListener('visibilitychange', () => { last = performance.now(); });

// 可选的地址栏参数：?legion=500 指定军阵人数，?nodust 关闭黄沙（便于在较弱的机器上直接打开）
{
  const q = new URLSearchParams(location.search);
  if (q.has('legion')) { const n = +q.get('legion'); legion.setCount(n); document.getElementById('rng-legion').value = n; document.getElementById('out-legion').textContent = n; }
  if (q.has('nodust')) { state.dustOn = false; document.getElementById('chk-dust').checked = false; }
}

// 预热：先跑几帧让着色器编译、沙尘带成形
for (let i = 0; i < 90; i++) step(1 / 60);
render(1 / 60);
note.textContent = '';
ui.ready();

// 页面离开时释放 GPU 资源
addEventListener('pagehide', () => {
  renderer.setAnimationLoop(null);
  cavalry.dispose(); legion.dispose(); dust.dispose(); prints.dispose(); pipeline.dispose(); lib.dispose(); asset.dispose();
  [sandD, sandN, sandR, gravD, gravN, gravR, rockD, rockN, scene.environment].forEach((t) => t?.dispose());
  renderer.dispose();
});

// ------------------------------------------------------------------ 调试钩子（?debug=1，供无头截图使用）
if (DEBUG) {
  window.__seek = (t, opts = {}) => {
    state.mode = 'playing'; state.t = 0; state.loops = 0; restartWorld();
    if (opts.count) cavalry.setCount(opts.count);
    if (opts.legion !== undefined) legion.setCount(opts.legion);
    if (opts.dust !== undefined) state.dustOn = opts.dust;
    document.getElementById('overlay').style.display = 'none';
    for (let i = 0; i < 60; i++) { state.mode = 'idle'; step(1 / 60); }
    state.mode = 'playing'; state.t = 0;
    while (state.t < t) step(1 / 60);
    render(1 / 60); step(1 / 60);
    if (opts.cam) {
      const c = opts.cam, e = cavalry.player.horse.elements;
      camera.position.set(e[12] + c[0], e[13] + c[1], e[14] + c[2]);
      camera.lookAt(e[12] + c[3], e[13] + c[4], e[14] + c[5]);
      if (opts.fov) { camera.fov = opts.fov; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld(); pipeline.firstFrame = true;
    }
    render(1 / 60);
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, speed: playerInfo.speed, stride: asset.strideLength, period: asset.period };
  };
  window.__bench = (frames = 120) => {
    const gl = renderer.getContext();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { step(1 / 60); render(1 / 60); }
    gl.finish();
    return { msPerFrame: (performance.now() - t0) / frames };
  };
  window.__legion = legion; window.__state = state; window.__cavalry = cavalry; window.__camera = camera; window.__scene = scene; window.__pipeline = pipeline;
  window.__renderOnce = () => render(1 / 60);
}
window.__ready = true;
