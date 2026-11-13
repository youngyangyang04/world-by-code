import * as THREE from 'three';
import { Herd } from './herd.js';
import { buildParts, buildFlagGeometry, RIG } from './parts.js';
import { markMover } from '../fx/post.js';
import { addBarding, addMane } from './horseGear.js';
import { terrainHeight } from '../env/heightfield.js';

// ---------------------------------------------------------------------------
// 骑兵集群控制器
//   · 战马：VAT 实例化（Herd），每匹马独立步态相位，步频由“相对地面速度 / 步幅长度”决定。
//   · 骑手与鞍具：按“部件类型”实例化（约 20 个 InstancedMesh 画出全部骑手），
//     每帧在 CPU 上把 马实例矩阵 × 马背挂点 × 部件局部姿态 写入实例矩阵；手臂用两段骨骼 IK。
//   · 队形：固定纵列 + 插在纵列之间的“超越车道”，任何时刻两骑中心横向间距 ≥ 1.7m，纵向不同列 → 不穿模。
//   · 每只蹄子越过“触地相位”时，在蹄的世界坐标处喷发扬沙粒子，并回调蹄声。
// ---------------------------------------------------------------------------

export const FLAG_MAP_FRAGMENT = `
  #ifdef USE_MAP
    vec2 flagUv = vMapUv; if (!gl_FrontFacing) flagUv.x = 1.0 - flagUv.x;
    diffuseColor *= texture2D(map, flagUv);
  #endif`;

// 蹄地打滑系数：源动画步幅只有 3.6m（偏“袭步”而非全速奔跑），为了得到冲锋的速度感，
// 世界速度比蹄子的理论速度快 15%。近处马蹄被扬沙遮挡，实际观感中不可察觉。
export const SLIP = 1.15;

const COAT = [
  [0.5, 0.47, 0.45], [0.4, 0.38, 0.37], [0.24, 0.23, 0.23], [0.62, 0.56, 0.5], [0.46, 0.4, 0.35],
  [0.17, 0.16, 0.17], [0.85, 0.84, 0.82], [0.34, 0.3, 0.28], [0.55, 0.48, 0.42], [0.28, 0.26, 0.25],
];

// 队形槽位（相对玩家，x 右 / z 后；按优先级排列，人数滑块取前 N 个）
function buildSlots() {
  const s = [];
  const add = (x, z, o = {}) => s.push({ x, z, banner: false, ot: 0, ...o });
  add(-2.9, -0.6); add(2.9, -0.4); add(-2.9, -8.2, { banner: true }); add(2.9, -7.6); add(-6.3, -1.2); add(6.3, 0.3);
  // 正前方的前锋（不让视野正中空无一人）
  add(0.3, -11.5); add(-1.7, -18.5); add(2.1, -24.5);
  add(-4.6, 10, { ot: 24 }); add(4.6, 12.5, { ot: 27 });
  add(-6.3, -8.8); add(6.3, -8.4, { banner: true }); add(-2.9, 6.4); add(2.9, 6.8);
  add(-9.7, -0.2); add(9.7, -1.0); add(-8.0, 13, { ot: 22 }); add(0, 7.4);
  add(-9.7, -7.9); add(9.7, -8.9); add(8.0, 15, { ot: 30 }); add(-6.3, 6.0, { banner: true });
  add(6.3, 6.9); add(-13.1, -0.9); add(13.1, 0.2); add(1.9, -16.5); add(-0.4, -27.5); add(-13.1, -8.3);
  add(13.1, -7.7, { banner: true }); add(-9.7, 6.6); add(9.7, 6.2); add(-11.4, 16, { ot: 26 }); add(11.4, 14, { ot: 24 });
  add(-8, -15.8); add(8, -16.4); add(-16.5, -0.5); add(16.5, -1.1); add(0, 14.5); add(-2.9, 13.6); add(2.9, 14.1);
  add(-16.5, -8); add(16.5, -8.6, { banner: true });
  return s;
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _H = new THREE.Matrix4(), _S = new THREE.Matrix4(), _T = new THREE.Matrix4(), _Hd = new THREE.Matrix4(), _M = new THREE.Matrix4(), _L = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const BACK = new THREE.Vector3(0, 0, 1), UP = new THREE.Vector3(0, 1, 0);
const _sh = new THREE.Vector3(), _hand = new THREE.Vector3(), _wrist = new THREE.Vector3(), _elbow = new THREE.Vector3(), _dir = new THREE.Vector3(), _pole = new THREE.Vector3();
const _bit = new THREE.Vector3(), _hp = new THREE.Vector3();

function basisY(out, yAxis, hint, pos, sy = 1) {
  // 以 yAxis 为 Y 轴，hint 决定 X 轴朝向
  _x.copy(hint).addScaledVector(yAxis, -hint.dot(yAxis));
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0).addScaledVector(yAxis, -yAxis.x);
  _x.normalize();
  _z.crossVectors(_x, yAxis);
  const e = out.elements;
  e[0] = _x.x; e[1] = _x.y; e[2] = _x.z; e[3] = 0;
  e[4] = yAxis.x * sy; e[5] = yAxis.y * sy; e[6] = yAxis.z * sy; e[7] = 0;
  e[8] = _z.x; e[9] = _z.y; e[10] = _z.z; e[11] = 0;
  e[12] = pos.x; e[13] = pos.y; e[14] = pos.z; e[15] = 1;
  return out;
}

// 手部目标（torso 参考坐标）与槊的指向：carry 持槊行进 / rally 高举 / level 平端冲刺
const POSE = {
  npc: {
    carry: { hand: new THREE.Vector3(0.39, 1.86, -0.22), dir: new THREE.Vector3(0.04, 0.93, -0.36).normalize() },
    rally: { hand: new THREE.Vector3(0.42, 2.56, -0.12), dir: new THREE.Vector3(0.02, 0.5, -0.86).normalize() },
    level: { hand: new THREE.Vector3(0.33, 1.9, -0.16), dir: new THREE.Vector3(-0.03, 0.05, -1).normalize() },
    rein: new THREE.Vector3(-0.07, 1.86, -0.34),
  },
  // 玩家：双手抬高前伸，保证第一人称画面下方能看到缰绳手、护臂与长槊
  player: {
    carry: { hand: new THREE.Vector3(0.34, 2.05, -0.5), dir: new THREE.Vector3(0.075, 0.2, -0.977).normalize() },
    rally: { hand: new THREE.Vector3(0.4, 2.1, -0.62), dir: new THREE.Vector3(0.07, 0.36, -0.93).normalize() },
    level: { hand: new THREE.Vector3(0.36, 1.84, -0.4), dir: new THREE.Vector3(-0.015, 0.085, -1).normalize() },
    rein: new THREE.Vector3(-0.17, 1.98, -0.62),
  },
};

export class Cavalry {
  constructor({ asset, lib, dust, prints, uniforms, max = 41 }) {
    this.asset = asset; this.lib = lib; this.dust = dust; this.prints = prints; this.max = max;
    this.group = new THREE.Group();
    this.group.name = 'cavalry';
    this.herd = new Herd(asset, max);
    this.group.add(this.herd.horse);
    this.group.add(addBarding(this.herd, asset, lib));
    this.group.add(addMane(this.herd, asset, uniforms.uTime));
    this.slots = buildSlots();
    this.riders = [];
    this.count = 0;
    this.onPlayerHoof = null;
    this.dustAmount = 1;
    this.time = 0;

    for (const k in lib) if (lib[k]?.isMaterial) markMover(lib[k]);
    this.parts = buildParts(lib);
    for (const k in this.parts) {
      const p = this.parts[k];
      p.per = p.perRider ?? 1;
      p.mesh = new THREE.InstancedMesh(p.geo, p.mat, max * p.per);
      p.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      p.mesh.frustumCulled = false;
      p.mesh.castShadow = k !== 'rein';
      p.mesh.receiveShadow = true;
      p.mesh.count = 0;
      p.mesh.name = k;
      this.group.add(p.mesh);
    }

    // 战旗
    this.flagUniforms = { uTime: uniforms.uTime };
    const flagMat = new THREE.MeshStandardMaterial({ map: lib.bannerTex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
    flagMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.flagUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; vec3 flagP;`)
        .replace('#include <beginnormal_vertex>', `
          float fu = clamp(position.x / 1.55, 0.0, 1.0);
          float fph = float(gl_InstanceID) * 1.7;
          float a1 = position.x * 5.2 - uTime * 15.0 + fph + position.y * 1.4;
          float a2 = position.x * 10.5 - uTime * 26.0 + fph * 2.3 - position.y * 3.1;
          float a3 = position.x * 2.1 - uTime * 6.0 + fph * 0.7;
          float amp = pow(fu, 0.75);
          flagP = position;
          flagP.z += (sin(a1) * 0.12 + sin(a2) * 0.04 + sin(a3) * 0.1) * amp;
          flagP.y += (cos(a1 * 0.8) * 0.035 - 0.09 * fu) * fu;
          flagP.x -= 0.05 * fu * (1.0 + sin(a1));
          float dz = (cos(a1) * 5.2 * 0.12 + cos(a2) * 10.5 * 0.04 + cos(a3) * 2.1 * 0.1) * amp;
          vec3 objectNormal = normalize(vec3(-dz, 0.0, 1.0));`)
        .replace('#include <begin_vertex>', 'vec3 transformed = flagP;');
      // 背面把贴图左右翻转 → 旗子两面的「唐」字都是正的
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', FLAG_MAP_FRAGMENT);
    };
    flagMat.customProgramCacheKey = () => 'flag';
    markMover(flagMat);
    this.flag = new THREE.InstancedMesh(buildFlagGeometry(), flagMat, 8);
    this.flag.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flag.frustumCulled = false; this.flag.castShadow = true; this.flag.count = 0;
    this.group.add(this.flag);

    // 玩家自己的头盔在第一人称下不绘制，但仍需投下影子：用一个只写阴影贴图的替身
    this.headShadow = new THREE.Mesh(this.parts.headIron.geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.headShadow.castShadow = true; this.headShadow.frustumCulled = false; this.headShadow.matrixAutoUpdate = false;
    this.group.add(this.headShadow);

    // 马背挂点的平均高度（骑手用它来“吸收”一部分颠簸）
    this.seatMeanY = 0;
    const d = asset.sockets.saddle.data;
    for (let f = 0; f < asset.N; f++) this.seatMeanY += d[f * 7 + 1];
    this.seatMeanY /= asset.N;

    // 玩家（index 0）的姿态输出，供第一人称相机使用
    this.player = {
      horse: new THREE.Matrix4(), seat: new THREE.Matrix4(), torso: new THREE.Matrix4(),
      phase: 0, speed: 0, x: 0, z: 0, seatDy: 0, seatPitch: 0,
    };
    this.setCount(20);
  }

  setCount(nCompanions) {
    const n = Math.min(this.max, nCompanions + 1);
    while (this.riders.length < n) {
      const i = this.riders.length;
      const slot = i === 0 ? { x: 0, z: 0, banner: false, ot: 0 } : this.slots[i - 1];
      const r = {
        i, slot, isPlayer: i === 0,
        phase: Math.random(), seed: Math.random() * 100, s1: Math.random() * 6.28, s2: Math.random() * 6.28, s3: Math.random() * 6.28,
        relX: slot.x, relZ: slot.z, prevRelZ: slot.z, prevRelX: slot.x,
        raiser: !slot.banner && Math.random() < 0.7, leveler: !slot.banner && slot.z < 3 && Math.random() < 0.75,
        delay: Math.random() * 0.8, raise: 0, raiseV: 0, rallyClock: 0, level: 0, shout: 0, speed: 10,
        // 举槊动作的个体差异：反应快慢、举起的高度与外展、挥动的节奏
        armW: 4.2 + Math.random() * 2.2, rhx: -0.03 + Math.random() * 0.13, rhy: -0.22 + Math.random() * 0.25,
        pumpF: 0.5 + Math.random() * 0.35, pumpA: 0.5 + Math.random() * 0.5,
        lean: 0.2 + Math.random() * 0.1,
        strikeDone: [false, false, false, false],
      };
      if (r.isPlayer) { r.raiser = true; r.leveler = true; r.lean = 0.13; r.phase = 0; r.delay = 0.2; }
      this.riders.push(r);
      const c = i === 0 ? COAT[0] : COAT[(i * 7 + 3) % COAT.length];
      this.herd.setTint(i, c[0], c[1], c[2]);
    }
    this.count = n;
    this.herd.setCount(n);
    for (const k in this.parts) this.parts[k].mesh.count = n * this.parts[k].per;
    let nb = 0;
    for (let i = 0; i < n; i++) if (this.riders[i].slot.banner) nb++;
    this.flag.count = Math.min(8, nb);
  }

  reset() {
    this.time = 0;
    for (const r of this.riders) {
      r.relX = r.slot.x; r.relZ = r.slot.z; r.prevRelZ = r.relZ; r.prevRelX = r.relX;
      r.raise = 0; r.raiseV = 0; r.rallyClock = 0; r.level = 0; r.shout = 0;
    }
  }

  // 随机挑 n 名战友呐喊；返回他们的索引（main 用来做空间音效）
  triggerShout(n, out = []) {
    out.length = 0;
    const c = this.count - 1;
    for (let k = 0; k < n && c > 0; k++) {
      const r = this.riders[1 + Math.floor(Math.random() * c)];
      r.shout = 1;
      out.push(r.i);
    }
    return out;
  }
  riderPosition(i, out) { const r = this.riders[i]; return out.set(r.wx, r.wy + 2.2, r.wz); }

  update(dt, tl, player) {
    const A = this.asset, P = this.parts, t = (this.time += dt);
    const stride = A.strideLength * SLIP;
    let flagI = 0;
    for (let i = 0; i < this.count; i++) {
      const r = this.riders[i];
      // —— 队形内的相对运动
      if (!r.isPlayer) {
        const s = r.slot;
        let z = s.z + 0.8 * Math.sin(t * 0.23 + r.s2) + 0.35 * Math.sin(t * 0.61 + r.s3);
        if (s.ot) {
          // 超越者：在自己的车道里从后方冲到前方
          // 一点点赶上来、并肩、再慢慢超过去；各人起步时间略有先后
          const k = THREE.MathUtils.clamp((tl.overtake - r.delay * 0.12) / (1 - 0.8 * 0.12), 0, 1);
          z -= s.ot * k;
        } else if (s.z < 3) z -= tl.surge * (1.2 + 1.6 * (r.seed % 1));
        r.relZ = z;
        r.relX = s.x + 0.2 * Math.sin(t * 0.31 + r.s1);
      } else { r.relX = 0; r.relZ = 0; }
      const vRelZ = dt > 0 ? (r.relZ - r.prevRelZ) / dt : 0, vRelX = dt > 0 ? (r.relX - r.prevRelX) / dt : 0;
      r.prevRelZ = r.relZ; r.prevRelX = r.relX;
      r.speed = Math.max(2, player.speed - vRelZ);
      const prevPhase = r.phase;
      r.phase += (r.speed / stride) * dt;
      const ph = r.phase - Math.floor(r.phase);

      // —— 战马实例矩阵（贴地 + 随坡度俯仰 + 轻微偏航）
      const wx = player.x + r.relX, wz = player.z + r.relZ;
      const wy = terrainHeight(wx, wz);
      const slope = (terrainHeight(wx, wz - 1.2) - terrainHeight(wx, wz + 1.2)) / 2.4;
      r.wx = wx; r.wy = wy; r.wz = wz;
      _e.set(Math.atan(slope) * 0.8, -vRelX * 0.06, 0, 'YXZ');
      _q.setFromEuler(_e);
      _H.compose(_v.set(wx, wy, wz), _q, _one);
      this.herd.setInstance(i, _H, ph);

      // —— 马背挂点
      A.sampleSocket('saddle', ph, _v, _q2);
      const seatDy = _v.y - this.seatMeanY, seatPitch = 2 * _q2.x;
      _S.compose(_v, _q2, _one).premultiply(_H);
      A.sampleSocket('head', ph, _v, _q2);
      _Hd.compose(_v, _q2, _one).premultiply(_H);

      // —— 状态：举槊 / 平端 / 呐喊
      const k = 1 - Math.exp(-dt * 3);
      r.level += ((r.leveler ? tl.level : 0) - r.level) * k;
      // 号令一起，各人先后举槊（0–2.4 秒内陆续响应），而不是同一瞬间齐刷刷抬手
      r.rallyClock = tl.rally > 0.05 ? r.rallyClock + dt : 0;
      const rallyT = r.raiser && r.rallyClock > r.delay * 3 ? tl.rally : 0;
      const raiseTarget = Math.max(rallyT * (1 - r.level), r.shout * (r.slot.banner ? 0 : 0.9));
      // 手臂是有重量的：用欠阻尼弹簧过渡（约 1 秒举到位，带一点过冲再回稳）
      {
        const W = r.armW, Z = 0.72;
        let rem = Math.min(dt, 0.1);
        while (rem > 1e-6) {
          const h = Math.min(rem, 1 / 120);
          r.raiseV += (W * W * (raiseTarget - r.raise) - 2 * Z * W * r.raiseV) * h;
          r.raise += r.raiseV * h;
          rem -= h;
        }
      }
      r.shout = Math.max(0, r.shout - dt * 0.6);

      // —— 躯干：前倾 + 反向抵消马背俯仰 + 吸收部分上下颠簸 + 左右微晃
      const lean = r.lean + 0.1 * r.level - 0.12 * r.raise;
      const tw = Math.PI * 2 * r.phase;
      _e.set(-lean - 0.55 * seatPitch + 0.03 * Math.sin(tw + 1.0), 0.04 * Math.sin(tw * 0.5 + r.seed) - 0.1 * r.raise, 0.025 * Math.sin(tw + r.seed) + 0.07 * r.raise, 'XYZ');
      _q.setFromEuler(_e);
      const pv = RIG.pelvis;
      _T.makeTranslation(-pv.x, -pv.y, -pv.z);
      _M.makeRotationFromQuaternion(_q); _T.premultiply(_M);
      _M.makeTranslation(pv.x, pv.y - 0.4 * seatDy + (r.isPlayer ? 0 : 0.015 * r.raise), pv.z); _T.premultiply(_M);
      _T.premultiply(_S);
      // —— 头：抵消大部分前倾，呐喊时仰头
      const nk = RIG.neck;
      _e.set(lean * 0.85 + 0.2 * r.shout + 0.1 * r.raise + 0.25 * seatPitch, 0.12 * Math.sin(t * 0.7 + r.seed) + 0.25 * r.shout * Math.sin(r.seed), 0, 'XYZ');
      _q.setFromEuler(_e);
      _L.makeTranslation(-nk.x, -nk.y, -nk.z);
      _M.makeRotationFromQuaternion(_q); _L.premultiply(_M);
      _M.makeTranslation(nk.x, nk.y, nk.z); _L.premultiply(_M);
      _L.premultiply(_T);

      // —— 写入刚体部件
      for (const key in P) {
        const p = P[key];
        if (p.frame === 'seat') p.mesh.setMatrixAt(i, _S);
        else if (p.frame === 'torso') p.mesh.setMatrixAt(i, _T);
        else if (p.frame === 'head') p.mesh.setMatrixAt(i, r.isPlayer ? ZERO : _L);
        else if (p.frame === 'horseHead') p.mesh.setMatrixAt(i, _Hd);
      }

      // —— 右臂 + 长槊
      const pose = r.isPlayer ? POSE.player : POSE.npc;
      const rz = r.raise, lv = r.level;
      _hand.copy(pose.carry.hand).addScaledVector(_v3.subVectors(pose.rally.hand, pose.carry.hand), rz).addScaledVector(_v3.subVectors(pose.level.hand, pose.carry.hand), lv);
      _dir.copy(pose.carry.dir).addScaledVector(_v3.subVectors(pose.rally.dir, pose.carry.dir), rz).addScaledVector(_v3.subVectors(pose.level.dir, pose.carry.dir), lv);
      const rc = THREE.MathUtils.clamp(rz, 0, 1);
      if (!r.isPlayer) {
        // 手不是走直线上去的：先向外、向前划一道弧，再举过头顶；每个人举的高度和外展也不一样
        const arc = Math.sin(Math.PI * rc);
        _hand.x += 0.11 * arc + r.rhx * rc;
        _hand.z -= 0.13 * arc;
        _hand.y += r.rhy * rc;
      }
      // 高举之后的挥动：各人节奏不同，上扬快、回落慢，力度时强时弱
      const pa = Math.PI * 2 * r.pumpF * t + r.seed;
      const pump = rc * r.pumpA * (0.55 + 0.45 * Math.sin(t * 0.37 + r.s2)) * (Math.sin(pa) + 0.3 * Math.sin(2 * pa));
      // 随步伐的起伏：举着的手臂比身体慢半拍（惯性）
      _hand.y += 0.012 * Math.sin(tw + 0.6) + 0.028 * rc * Math.sin(tw - 1.2) + 0.055 * pump;
      _hand.z += 0.01 * Math.cos(tw);
      _dir.x += 0.012 * Math.sin(tw * 0.5 + r.seed) + 0.03 * rc * Math.sin(pa * 0.5 + r.s1);
      // 长槊很重：手抬起时槊锋滞后（先低后跟上），落下时反之
      _dir.y += 0.022 * Math.sin(tw + 2.1) + 0.08 * pump - 0.13 * r.raiseV + 0.03 * rc * Math.sin(tw - 2.0);
      _dir.normalize();
      _hand.applyMatrix4(_T);
      _dir.transformDirection(_T);
      basisY(_M, _dir, BACK, _hand);
      P.lanceWood.mesh.setMatrixAt(i, _M); P.lanceSteel.mesh.setMatrixAt(i, _M); P.lanceTassel.mesh.setMatrixAt(i, _M);
      if (r.slot.banner && flagI < this.flag.count) this.flag.setMatrixAt(flagI++, _M);
      if (r.slot.banner) P.lanceTassel.mesh.setMatrixAt(i, ZERO);
      _sh.copy(RIG.shoulderR).applyMatrix4(_T);
      this._arm(i * 2, _sh, _hand, _dir, _pole.set(0.55, -0.75, 0.35), r.isPlayer);

      // —— 左臂 + 缰绳
      _hand.copy(pose.rein);
      _hand.y += 0.012 * Math.sin(tw + 0.9); _hand.z += 0.02 * Math.sin(tw + 2.4);
      _hand.applyMatrix4(_T);
      _bit.copy(RIG.bitL).applyMatrix4(_Hd);
      _v2.copy(RIG.bitR).applyMatrix4(_Hd);
      _dir.subVectors(_bit, _hand).add(_v3.subVectors(_v2, _hand)).normalize();
      _sh.copy(RIG.shoulderL).applyMatrix4(_T);
      this._arm(i * 2 + 1, _sh, _hand, _dir, _pole.set(-0.55, -0.75, 0.35), r.isPlayer);
      // 缰绳：两段直线皮绳（奔驰中缰绳是绷紧的），从衔铁到左拳
      _y.subVectors(_hand, _bit); let len = _y.length(); _y.multiplyScalar(1 / len);
      P.rein.mesh.setMatrixAt(i * 2, basisY(_M, _y, UP, _bit, len));
      _y.subVectors(_hand, _v2); len = _y.length(); _y.multiplyScalar(1 / len);
      P.rein.mesh.setMatrixAt(i * 2 + 1, basisY(_M, _y, UP, _v2, len));

      if (r.isPlayer) {
        const pl = this.player;
        pl.horse.copy(_H); pl.seat.copy(_S); pl.torso.copy(_T);
        pl.phase = r.phase; pl.speed = r.speed; pl.x = wx; pl.z = wz; pl.seatDy = seatDy; pl.seatPitch = seatPitch;
        pl.raise = r.raise; pl.level = r.level;
        this.headShadow.matrix.copy(_L); this.headShadow.matrixWorld.copy(_L);
      }

      // —— 马蹄触地 → 扬沙 + 蹄声
      if (dt > 0) this._hoofs(r, prevPhase, _H);
    }
    this.herd.commit();
    for (const key in P) P[key].mesh.instanceMatrix.needsUpdate = true;
    this.flag.instanceMatrix.needsUpdate = true;
  }

  // 两段骨骼 IK：肩 → 肘 → 腕，并摆放握拳的手
  _arm(slot, shoulder, hand, grip, pole, isPlayer) {
    const P = this.parts, l1 = RIG.upperArm, l2 = RIG.foreArm;
    // 手背方向：大致沿 肩→手，并与握持轴正交
    _y.subVectors(hand, shoulder).addScaledVector(pole, -0.12);
    _y.addScaledVector(grip, -_y.dot(grip));
    if (_y.lengthSq() < 1e-5) _y.copy(UP).addScaledVector(grip, -grip.y);
    _y.normalize();
    _wrist.copy(hand).addScaledVector(_y, -RIG.wrist);
    // 手矩阵：Z = 握持轴，Y = 腕→指节
    _x.crossVectors(_y, grip).normalize();
    const e = _M.elements;
    e[0] = _x.x; e[1] = _x.y; e[2] = _x.z; e[3] = 0; e[4] = _y.x; e[5] = _y.y; e[6] = _y.z; e[7] = 0;
    e[8] = grip.x; e[9] = grip.y; e[10] = grip.z; e[11] = 0; e[12] = hand.x; e[13] = hand.y; e[14] = hand.z; e[15] = 1;
    P.hand.mesh.setMatrixAt(slot, _M);
    _v3.subVectors(_wrist, shoulder);
    let d = _v3.length();
    const dc = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.004);
    _v3.multiplyScalar(1 / d);
    const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    _v4.copy(pole).addScaledVector(_v3, -pole.dot(_v3)).normalize();
    _elbow.copy(shoulder).addScaledVector(_v3, a).addScaledVector(_v4, h);
    _y.subVectors(_elbow, shoulder).normalize();
    P.upperArm.mesh.setMatrixAt(slot, basisY(_M, _y, _v4, shoulder));
    _y.subVectors(_wrist, _elbow); const fl = _y.length(); _y.multiplyScalar(1 / fl);
    basisY(_M, _y, _v4, _elbow, fl / l2);
    P.foreArm.mesh.setMatrixAt(slot, _M); P.foreArmBands.mesh.setMatrixAt(slot, _M);
  }

  _hoofs(r, prevPhase, H) {
    const A = this.asset, dust = this.dust.hoof, time = this.simTime ?? 0, amt = this.dustAmount;
    const p0 = prevPhase - Math.floor(prevPhase), p1 = p0 + (r.phase - prevPhase);
    for (let h = 0; h < 4; h++) {
      const hoof = A.hoofs[h];
      let s = hoof.strike; if (s < p0) s += 1;
      if (s > p1) continue;
      A.sampleHoof(h, hoof.strike, _hp).applyMatrix4(H);
      const gx = _hp.x, gz = _hp.z, gy = terrainHeight(gx, gz);
      if (r.isPlayer) this.onPlayerHoof?.(h, hoof);
      this.prints?.add(gx, gy, gz, (Math.random() - 0.5) * 0.5, 0.9 + Math.random() * 0.3);
      if (amt <= 0) continue;
      const v = r.speed;
      // 土块 / 砂砾：向后上方飞溅（grow = 0 → 受重力）
      const nClod = 3 + ((Math.random() * 3) | 0);
      for (let c = 0; c < nClod; c++) {
        dust.emit(gx + (Math.random() - 0.5) * 0.12, gy + 0.03, gz + (Math.random() - 0.5) * 0.12,
          (Math.random() - 0.5) * 2.4, 1.6 + Math.random() * 3.2, 0.8 + Math.random() * 3.6,
          time, 0.45 + Math.random() * 0.5, 0.007 + Math.random() * 0.016, 0, 0.9);
      }
      // 蹄边炸开的细沙
      for (let c = 0; c < 3; c++) {
        dust.emit(gx + (Math.random() - 0.5) * 0.25, gy + 0.08, gz + (Math.random() - 0.5) * 0.25,
          (Math.random() - 0.5) * 2.2, 0.7 + Math.random() * 1.5, -v * 0.12 + Math.random() * 2.0,
          time, 1.2 + Math.random() * 1.2, 0.14 + Math.random() * 0.1, 0.9 + Math.random() * 0.9, (0.2 + Math.random() * 0.14) * amt);
      }
      // 随风向后扩散、不断膨胀的尘团（彼此重叠，连成马后的沙尘带）
      for (let c = 0; c < 2; c++) {
        dust.emit(gx + (Math.random() - 0.5) * 0.6, gy + 0.3, gz + 0.2 + Math.random() * 0.5,
          (Math.random() - 0.5) * 1.4, 0.4 + Math.random() * 1.0, -v * 0.1 + Math.random() * 1.4,
          time, 4.5 + Math.random() * 5.0, 0.4 + Math.random() * 0.25, 2.4 + Math.random() * 2.6, (0.075 + Math.random() * 0.06) * amt);
      }
    }
  }

  dispose() {
    this.herd.dispose();
    for (const k in this.parts) { this.parts[k].geo.dispose(); this.parts[k].mesh.dispose(); }
    this.flag.geometry.dispose(); this.flag.material.dispose(); this.flag.dispose();
    this.headShadow.material.dispose();
  }
}
