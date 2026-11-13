import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// 战马资源：加载“Horse Run”（Amitesh Nandan 等，CC BY-ND 4.0，文件未做任何修改），
// 在运行时把它的逐帧顶点动画烘焙成一个可无缝循环的单步幅“顶点动画纹理”(VAT)。
//
// 源动画的实际情况（由数据分析得出，而不是假设）：
//   · 35 个关键帧，约 3.1 个步幅，带向前的根位移（不是原地动画）；
//   · 步态为四拍“横向奔跑”(transverse gallop)：右后 → 左后 → 右前 → 左前 → 腾空期。
// 烘焙步骤：
//   1. 自相关搜索求出步幅周期 P（帧）与每步幅位移（步幅长度）；
//   2. 取中间一个完整步幅，用 Catmull-Rom 在时间上重采样成 N 帧，并减去匀速根位移 → 原地循环；
//   3. 把首尾闭合误差线性分摊到整个周期 → 严格周期化；
//   4. 由网格连通性找出四条腿的蹄部顶点，得到每只蹄的触地相位 / 落点（驱动扬沙、蹄印、蹄声）；
//   5. 对背部 / 头部 / 臀部的顶点小片做逐帧刚体拟合，得到“挂点”轨迹（骑手、马鞍、面帘、缰绳都挂在上面）。
// 步幅长度同时决定“奔跑速度 ↔ 步频”的换算，使马蹄触地时不打滑。
// ---------------------------------------------------------------------------

export const VAT_W = 2048;
const SCALE = 0.1;      // 模型单位 → 米（肩高约 1.6m 的战马）
const N_FRAMES = 32;    // 烘焙后每步幅帧数

// 从协方差矩阵迭代提取旋转（Müller et al. 2016）
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
const _r0 = new THREE.Vector3(), _r1 = new THREE.Vector3(), _r2 = new THREE.Vector3();
const _om = new THREE.Vector3(), _tv = new THREE.Vector3(), _dq = new THREE.Quaternion(), _rm = new THREE.Matrix4();
function extractRotation(A /* 9 col-major */, q) {
  _c0.set(A[0], A[1], A[2]); _c1.set(A[3], A[4], A[5]); _c2.set(A[6], A[7], A[8]);
  for (let it = 0; it < 30; it++) {
    _rm.makeRotationFromQuaternion(q);
    const e = _rm.elements;
    _r0.set(e[0], e[1], e[2]); _r1.set(e[4], e[5], e[6]); _r2.set(e[8], e[9], e[10]);
    _om.set(0, 0, 0)
      .add(_tv.crossVectors(_r0, _c0)).add(_tv.crossVectors(_r1, _c1)).add(_tv.crossVectors(_r2, _c2));
    const d = Math.abs(_r0.dot(_c0) + _r1.dot(_c1) + _r2.dot(_c2)) + 1e-9;
    _om.multiplyScalar(1 / d);
    const w = _om.length();
    if (w < 1e-9) break;
    _dq.setFromAxisAngle(_om.multiplyScalar(1 / w), w);
    q.premultiply(_dq).normalize();
  }
  return q;
}

export async function loadHorseAsset(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  let src = null;
  gltf.scene.traverse((o) => { if (o.isMesh && o.geometry.morphAttributes.position?.length) src = o; });
  if (!src) throw new Error('horse model: no morph-animated mesh found');
  const g = src.geometry;
  const V = g.attributes.position.count;
  const basePos = g.attributes.position.array, baseNrm = g.attributes.normal.array;
  const mp = g.morphAttributes.position, mn = g.morphAttributes.normal;
  const relative = g.morphTargetsRelative;

  // 关键帧序列：由动画轨道读出每个关键帧对应的目标索引（-1 = 基础网格）
  const track = gltf.animations[0]?.tracks.find((t) => t.name.endsWith('morphTargetInfluences'));
  const nT = mp.length;
  const keyTargets = [];
  if (track) {
    const nK = track.times.length;
    for (let k = 0; k < nK; k++) {
      let best = -1, bw = 0.5;
      for (let t = 0; t < nT; t++) { const w = track.values[k * nT + t]; if (w > bw) { bw = w; best = t; } }
      keyTargets.push(best);
    }
    // 最后一个关键帧回到基础网格（循环跳回点）→ 丢弃
    if (keyTargets.length > 2 && keyTargets[keyTargets.length - 1] === keyTargets[0]) keyTargets.pop();
  } else {
    keyTargets.push(-1);
    for (let t = 0; t < nT; t++) keyTargets.push(t);
  }
  const F = keyTargets.length;

  // 源帧 → 统一坐标系（前进方向 -Z，上 +Y，右 +X，单位米）
  // 模型原始朝向 +X：x' = z, z' = -x
  const srcP = [], srcN = [];
  for (let f = 0; f < F; f++) {
    const t = keyTargets[f], P = new Float32Array(V * 3), Nn = new Float32Array(V * 3);
    const dp = t >= 0 ? mp[t].array : null, dn = t >= 0 && mn ? mn[t].array : null;
    for (let i = 0; i < V; i++) {
      const o = i * 3;
      let x = basePos[o], y = basePos[o + 1], z = basePos[o + 2];
      let nx = baseNrm[o], ny = baseNrm[o + 1], nz = baseNrm[o + 2];
      if (dp) { if (relative) { x += dp[o]; y += dp[o + 1]; z += dp[o + 2]; } else { x = dp[o]; y = dp[o + 1]; z = dp[o + 2]; } }
      if (dn) { if (relative) { nx += dn[o]; ny += dn[o + 1]; nz += dn[o + 2]; } else { nx = dn[o]; ny = dn[o + 1]; nz = dn[o + 2]; } }
      P[o] = z * SCALE; P[o + 1] = y * SCALE; P[o + 2] = -x * SCALE;
      Nn[o] = nz; Nn[o + 1] = ny; Nn[o + 2] = -nx;
    }
    srcP.push(P); srcN.push(Nn);
  }

  // —— 1. 周期搜索
  const sub = []; for (let i = 0; i < V; i += 7) sub.push(i);
  const lerpAt = (arr, k, i, c) => { const k0 = Math.min(F - 2, Math.floor(k)), a = k - k0; return arr[k0][i * 3 + c] * (1 - a) + arr[k0 + 1][i * 3 + c] * a; };
  let best = { err: Infinity, P: F, dz: 0 };
  for (let P = 8; P <= F - 3; P += 0.02) {
    let err = 0, n = 0, dzs = 0;
    for (let k = 0; k <= F - 1 - P; k += 1) {
      let mdz = 0;
      for (const i of sub) mdz += lerpAt(srcP, k + P, i, 2) - lerpAt(srcP, k, i, 2);
      mdz /= sub.length; dzs += mdz;
      for (const i of sub) {
        const ex = lerpAt(srcP, k + P, i, 0) - lerpAt(srcP, k, i, 0), ey = lerpAt(srcP, k + P, i, 1) - lerpAt(srcP, k, i, 1);
        const ez = lerpAt(srcP, k + P, i, 2) - lerpAt(srcP, k, i, 2) - mdz;
        err += ex * ex + ey * ey + ez * ez;
      }
      n++;
    }
    if (n < 3) break;
    err = Math.sqrt(err / (n * sub.length));
    if (err < best.err) best = { err, P, dz: dzs / n };
  }
  const period = best.P, strideLength = Math.abs(best.dz), vz = best.dz / period; // 每帧根位移（负 = 向前）

  // —— 2/3. Catmull-Rom 重采样 + 去根位移 + 闭合
  const k0 = Math.max(1, Math.min(F - 2 - period, (F - 1 - period) / 2));
  const cr = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const evalFrame = (arr, k, out, isPos) => {
    const i1 = Math.min(F - 2, Math.floor(k)), t = k - i1, i0 = Math.max(0, i1 - 1), i2 = i1 + 1, i3 = Math.min(F - 1, i1 + 2);
    const a = arr[i0], b = arr[i1], c = arr[i2], d = arr[i3];
    const shift = isPos ? -vz * (k - k0) : 0;
    for (let j = 0; j < V * 3; j++) out[j] = cr(a[j], b[j], c[j], d[j], t);
    if (isPos) for (let i = 0; i < V; i++) out[i * 3 + 2] += shift;
    return out;
  };
  const first = evalFrame(srcP, k0, new Float32Array(V * 3), true);
  const last = evalFrame(srcP, k0 + period, new Float32Array(V * 3), true);
  const frames = [], normals = [];
  for (let f = 0; f < N_FRAMES; f++) {
    const phi = f / N_FRAMES;
    const P = evalFrame(srcP, k0 + phi * period, new Float32Array(V * 3), true);
    for (let j = 0; j < V * 3; j++) P[j] -= (phi - 0.5) * (last[j] - first[j]);
    const Nn = evalFrame(srcN, k0 + phi * period, new Float32Array(V * 3), false);
    for (let i = 0; i < V; i++) {
      const o = i * 3, l = Math.hypot(Nn[o], Nn[o + 1], Nn[o + 2]) || 1;
      Nn[o] /= l; Nn[o + 1] /= l; Nn[o + 2] /= l;
    }
    frames.push(P); normals.push(Nn);
  }
  // 居中（x、z）并落地（y）
  let minY = Infinity, cx = 0, cz = 0;
  for (const P of frames) for (let i = 0; i < V; i++) { minY = Math.min(minY, P[i * 3 + 1]); cx += P[i * 3]; cz += P[i * 3 + 2]; }
  cx /= V * N_FRAMES; cz /= V * N_FRAMES;
  cz += 0.6; // 让鞍座位于 z≈0（顶点质心偏向头颈一侧）
  for (const P of frames) for (let i = 0; i < V; i++) { P[i * 3] -= cx; P[i * 3 + 1] -= minY; P[i * 3 + 2] -= cz; }

  // —— 参考姿态（rest）：第 0 帧。所有挂件都在这个姿态的坐标系里建模
  const rest = frames[0], restN = normals[0];

  // —— 4. 四蹄
  const index = g.index.array;
  const weld = new Int32Array(V), wmap = new Map();
  for (let i = 0; i < V; i++) {
    const key = `${Math.round(rest[i * 3] * 2000)},${Math.round(rest[i * 3 + 1] * 2000)},${Math.round(rest[i * 3 + 2] * 2000)}`;
    if (!wmap.has(key)) wmap.set(key, i);
    weld[i] = wmap.get(key);
  }
  const vMinY = new Float32Array(V).fill(Infinity);
  for (const P of frames) for (let i = 0; i < V; i++) vMinY[i] = Math.min(vMinY[i], P[i * 3 + 1]);
  const parent = new Int32Array(V).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const low = (i) => vMinY[i] < 0.3;
  for (let t = 0; t < index.length; t += 3) {
    const a = weld[index[t]], b = weld[index[t + 1]], c = weld[index[t + 2]];
    if (low(a) && low(b)) parent[find(a)] = find(b);
    if (low(b) && low(c)) parent[find(b)] = find(c);
    if (low(a) && low(c)) parent[find(a)] = find(c);
  }
  const comps = new Map();
  for (let i = 0; i < V; i++) if (low(i)) { const r = find(weld[i]); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
  const legs = [...comps.values()].filter((c) => c.length > 20).map((c) => {
    let mx = 0, mz = 0;
    for (const P of frames) for (const i of c) { mx += P[i * 3]; mz += P[i * 3 + 2]; }
    return { verts: c, mx: mx / (c.length * N_FRAMES), mz: mz / (c.length * N_FRAMES) };
  });
  if (legs.length !== 4) console.warn(`horse bake: expected 4 legs, found ${legs.length}`);
  legs.sort((a, b) => a.mz - b.mz); // 前腿 z 更小
  const hoofs = legs.map((L, li) => {
    const fore = li < 2, right = L.mx > 0;
    const bottom = [...L.verts].sort((a, b) => vMinY[a] - vMinY[b]).slice(0, Math.max(6, L.verts.length >> 2));
    const tr = new Float32Array(N_FRAMES * 3);
    for (let f = 0; f < N_FRAMES; f++) {
      let y = Infinity, x = 0, z = 0;
      for (const i of bottom) { y = Math.min(y, frames[f][i * 3 + 1]); x += frames[f][i * 3]; z += frames[f][i * 3 + 2]; }
      tr[f * 3] = x / bottom.length; tr[f * 3 + 1] = y; tr[f * 3 + 2] = z / bottom.length;
    }
    // 触地：高度 < 4.5cm。strike = 由腾空转触地的相位，lift = 离地相位
    const TH = 0.045;
    let strike = 0, lift = 0;
    for (let f = 0; f < N_FRAMES; f++) {
      const y0 = tr[f * 3 + 1], y1 = tr[((f + 1) % N_FRAMES) * 3 + 1];
      if (y0 >= TH && y1 < TH) strike = (f + (y0 - TH) / (y0 - y1)) / N_FRAMES;
      if (y0 < TH && y1 >= TH) lift = (f + (TH - y0) / (y1 - y0)) / N_FRAMES;
    }
    return { name: (fore ? 'F' : 'H') + (right ? 'R' : 'L'), fore, right, track: tr, strike, lift };
  });

  // —— 5. 挂点：顶点小片的逐帧刚体拟合（rest → frame）
  function makeSocket(center, radius) {
    const ids = [];
    for (let i = 0; i < V; i++) {
      const dx = rest[i * 3] - center[0], dy = rest[i * 3 + 1] - center[1], dz = rest[i * 3 + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz < radius * radius) ids.push(i);
    }
    const data = new Float32Array(N_FRAMES * 7);
    const q = new THREE.Quaternion();
    const cr0 = [0, 0, 0];
    for (const i of ids) { cr0[0] += rest[i * 3]; cr0[1] += rest[i * 3 + 1]; cr0[2] += rest[i * 3 + 2]; }
    cr0[0] /= ids.length; cr0[1] /= ids.length; cr0[2] /= ids.length;
    const A = new Float64Array(9), v = new THREE.Vector3();
    for (let f = 0; f < N_FRAMES; f++) {
      const P = frames[f], cf = [0, 0, 0];
      for (const i of ids) { cf[0] += P[i * 3]; cf[1] += P[i * 3 + 1]; cf[2] += P[i * 3 + 2]; }
      cf[0] /= ids.length; cf[1] /= ids.length; cf[2] /= ids.length;
      A.fill(0);
      for (const i of ids) {
        const rx = rest[i * 3] - cr0[0], ry = rest[i * 3 + 1] - cr0[1], rz = rest[i * 3 + 2] - cr0[2];
        const px = P[i * 3] - cf[0], py = P[i * 3 + 1] - cf[1], pz = P[i * 3 + 2] - cf[2];
        // A = Σ p r^T（列主序）
        A[0] += px * rx; A[1] += py * rx; A[2] += pz * rx;
        A[3] += px * ry; A[4] += py * ry; A[5] += pz * ry;
        A[6] += px * rz; A[7] += py * rz; A[8] += pz * rz;
      }
      extractRotation(A, q); // 以上一帧结果为初值，保证连续
      // t = cf - R * cr0
      v.set(cr0[0], cr0[1], cr0[2]).applyQuaternion(q);
      const o = f * 7;
      data[o] = cf[0] - v.x; data[o + 1] = cf[1] - v.y; data[o + 2] = cf[2] - v.z;
      data[o + 3] = q.x; data[o + 4] = q.y; data[o + 5] = q.z; data[o + 6] = q.w;
    }
    return { data, count: ids.length };
  }
  const sockets = {
    saddle: makeSocket([0, 1.4, 0.05], 0.42),
    head: makeSocket([0, 1.72, -1.42], 0.24),
    neck: makeSocket([0, 1.7, -0.8], 0.2),
    croup: makeSocket([0, 1.45, 0.85], 0.3),
    chest: makeSocket([0, 1.2, -0.55], 0.28),
  };
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  // 采样挂点在相位 phase 时的刚体变换（rest → 当前），写入 outPos / outQuat
  function sampleSocket(name, phase, outPos, outQuat) {
    const d = sockets[name].data;
    const x = (phase - Math.floor(phase)) * N_FRAMES, f0 = Math.floor(x) % N_FRAMES, f1 = (f0 + 1) % N_FRAMES, a = x - Math.floor(x);
    const o0 = f0 * 7, o1 = f1 * 7;
    outPos.set(d[o0] + (d[o1] - d[o0]) * a, d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * a, d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * a);
    _qa.set(d[o0 + 3], d[o0 + 4], d[o0 + 5], d[o0 + 6]); _qb.set(d[o1 + 3], d[o1 + 4], d[o1 + 5], d[o1 + 6]);
    outQuat.copy(_qa).slerp(_qb, a);
  }
  function sampleHoof(h, phase, out) {
    const d = hoofs[h].track;
    const x = (phase - Math.floor(phase)) * N_FRAMES, f0 = Math.floor(x) % N_FRAMES, f1 = (f0 + 1) % N_FRAMES, a = x - Math.floor(x);
    out.set(d[f0 * 3] + (d[f1 * 3] - d[f0 * 3]) * a, d[f0 * 3 + 1] + (d[f1 * 3 + 1] - d[f0 * 3 + 1]) * a, d[f0 * 3 + 2] + (d[f1 * 3 + 2] - d[f0 * 3 + 2]) * a);
    return out;
  }

  // —— VAT 纹理（位置 / 法线），每帧占 VAT_R 行
  const VAT_R = Math.ceil(V / VAT_W);
  const pd = new Float32Array(VAT_W * VAT_R * N_FRAMES * 4), nd = new Float32Array(VAT_W * VAT_R * N_FRAMES * 4);
  for (let f = 0; f < N_FRAMES; f++) {
    const base = f * VAT_R * VAT_W * 4, P = frames[f], Nn = normals[f];
    for (let i = 0; i < V; i++) {
      pd[base + i * 4] = P[i * 3]; pd[base + i * 4 + 1] = P[i * 3 + 1]; pd[base + i * 4 + 2] = P[i * 3 + 2]; pd[base + i * 4 + 3] = 1;
      nd[base + i * 4] = Nn[i * 3]; nd[base + i * 4 + 1] = Nn[i * 3 + 1]; nd[base + i * 4 + 2] = Nn[i * 3 + 2]; nd[base + i * 4 + 3] = 0;
    }
  }
  const mkTex = (d) => {
    const t = new THREE.DataTexture(d, VAT_W, VAT_R * N_FRAMES, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  };
  const posTex = mkTex(pd), nrmTex = mkTex(nd);

  // —— 渲染用几何体：rest 姿态 + 原 UV + 原索引
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rest.slice(), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(restN.slice(), 3));
  geometry.setAttribute('uv', g.attributes.uv.clone());
  geometry.setAttribute('aMinY', new THREE.BufferAttribute(vMinY, 1)); // 每个顶点在整个步幅中的最低高度（区分躯干与腿）
  geometry.setIndex(new THREE.BufferAttribute(index.slice(), 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.6);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-0.6, 0, -2.2), new THREE.Vector3(0.6, 2.3, 2.2));

  const sm = src.material;
  const maps = { map: sm.map ?? null, orm: sm.roughnessMap ?? sm.aoMap ?? null, normalMap: sm.normalMap ?? null };

  return {
    V, N: N_FRAMES, VAT_R, geometry, rest, restN, frames, index,
    posTex, nrmTex, maps,
    period, strideLength, loopError: best.err,
    hoofs, sockets, sampleSocket, sampleHoof,
    uniforms: { tVatPos: { value: posTex }, tVatNrm: { value: nrmTex } },
    dispose() { posTex.dispose(); nrmTex.dispose(); geometry.dispose(); maps.map?.dispose(); maps.orm?.dispose(); },
  };
}

// VAT 采样 GLSL（顶点着色器用）。id = 顶点序号，phase = 步态相位 0..1
export function vatGLSL(asset) {
  return /* glsl */ `
uniform highp sampler2D tVatPos;
uniform highp sampler2D tVatNrm;
vec3 vatFetch(highp sampler2D t, int id, int f) {
  return texelFetch(t, ivec2(id % ${VAT_W}, f * ${asset.VAT_R} + id / ${VAT_W}), 0).xyz;
}
void vatSample(int id, float phase, out vec3 p, out vec3 n) {
  float x = fract(phase) * ${asset.N}.0;
  int f0 = int(x) % ${asset.N};
  int f1 = (f0 + 1) % ${asset.N};
  float a = fract(x);
  p = mix(vatFetch(tVatPos, id, f0), vatFetch(tVatPos, id, f1), a);
  n = normalize(mix(vatFetch(tVatNrm, id, f0), vatFetch(tVatNrm, id, f1), a));
}
`;
}
