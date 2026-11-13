import * as THREE from 'three';
import { vatGLSL } from './horseAsset.js';
import { buildFlagGeometry, RIG } from './parts.js';
import { HEIGHT_GLSL, terrainHeight } from '../env/heightfield.js';
import { atmosphere } from '../env/atmosphere.js';
import { markMover } from '../fx/post.js';
import { FLAG_MAP_FRAGMENT } from './cavalry.js';

// ---------------------------------------------------------------------------
// 军阵（中远景的成百上千铁骑）
//   近处 20–40 骑由 Cavalry 负责（高精度、CPU 姿态、IK）。这里负责它们之外的整个军阵：
//   · 完全由 GPU 驱动：每个实例只有 (队形偏移 x/z, 初始相位, 随机种子) 四个数，
//     世界位置 = 玩家位置 + 队形偏移，贴地高度、坡度俯仰、步态相位都在顶点着色器里算，CPU 每帧零开销。
//   · 战马 LOD：对同一匹马的顶点做“顶点聚类”减面（运行时进行，不修改模型文件），
//     每个保留顶点记住自己的原始顶点号，仍然从同一张顶点动画纹理取奔跑动画 → 远处的马同样在真实奔跑。
//   · 骑手 LOD：把近景骑手某一帧的全部部件（持槊行进姿态）烘焙合并成一个网格再聚类减面，
//     挂在马背挂点上（挂点轨迹存成一张小纹理），随马背起伏。
//   · 两档精度：42m 内为中景档，其外为远景档。队形相对玩家固定，所以分档是静态的。
//   · 每骑脚下有一条顺着夕阳方向的假阴影；部分骑手擎旗；按人数持续喷发尘团形成尘带。
// ---------------------------------------------------------------------------

export const LEGION_MAX = 2000;
const MID_RANGE = 42;

const COATS = [
  [0.5, 0.47, 0.45], [0.4, 0.38, 0.37], [0.24, 0.23, 0.23], [0.62, 0.56, 0.5], [0.46, 0.4, 0.35],
  [0.17, 0.16, 0.17], [0.85, 0.84, 0.82], [0.34, 0.3, 0.28], [0.55, 0.48, 0.42], [0.28, 0.26, 0.25],
];

function lgGLSL() {
  return /* glsl */ `
uniform vec2 uLgPlayer; uniform float uLgClock; uniform float uTime;
attribute vec4 aInst;
${HEIGHT_GLSL}
vec2 lgXZ; float lgGy; float lgC; float lgS; float lgPhase;
void lgInit() {
  float seed = aInst.w;
  lgXZ = uLgPlayer + aInst.xy + vec2(0.2 * sin(uTime * 0.31 + seed * 40.0), 0.6 * sin(uTime * 0.23 + seed * 60.0));
  lgGy = terrainHeight(lgXZ);
  float sl = (terrainHeight(lgXZ + vec2(0.0, -1.2)) - terrainHeight(lgXZ + vec2(0.0, 1.2))) / 2.4;
  float a = atan(sl) * 0.8;
  lgC = cos(a); lgS = sin(a);
  lgPhase = aInst.z + uLgClock * (1.0 + 0.05 * (seed - 0.5));
}
vec3 lgRot(vec3 p) { return vec3(p.x, p.y * lgC - p.z * lgS, p.y * lgS + p.z * lgC); }
vec3 lgWorld(vec3 p) { return lgRot(p) + vec3(lgXZ.x, lgGy, lgXZ.y); }
`;
}
function sockGLSL(N) {
  return /* glsl */ `
uniform highp sampler2D tLgSock;
vec3 lgSp; vec4 lgSq;
vec3 lgQrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void lgSocket() {
  float x = fract(lgPhase) * ${N}.0;
  int f0 = int(x) % ${N}; int f1 = (f0 + 1) % ${N}; float a = fract(x);
  lgSp = mix(texelFetch(tLgSock, ivec2(f0, 0), 0).xyz, texelFetch(tLgSock, ivec2(f1, 0), 0).xyz, a);
  vec4 q0 = texelFetch(tLgSock, ivec2(f0, 1), 0), q1 = texelFetch(tLgSock, ivec2(f1, 1), 0);
  if (dot(q0, q1) < 0.0) q1 = -q1;
  lgSq = normalize(mix(q0, q1, a));
}
`;
}

// 顶点聚类减面。src: 非索引的 {pos, nor, uv, col, pbr, key2?}；返回索引化结果
function cluster(src, cell) {
  const n = src.pos.length / 3, map = new Map(), remap = new Int32Array(n);
  const out = { pos: [], nor: [], uv: [], col: [], pbr: [], ids: [], index: [] };
  const inv = 1 / cell;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let key = `${Math.floor(src.pos[o] * inv)},${Math.floor(src.pos[o + 1] * inv)},${Math.floor(src.pos[o + 2] * inv)}|${src.mat ? src.mat[i] : 0}`;
    if (src.pos2) key += `|${Math.floor(src.pos2[o] * inv)},${Math.floor(src.pos2[o + 1] * inv)},${Math.floor(src.pos2[o + 2] * inv)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = out.pos.length / 3; map.set(key, j);
      out.pos.push(src.pos[o], src.pos[o + 1], src.pos[o + 2]);
      out.nor.push(0, 0, 0);
      out.uv.push(src.uv[i * 2], src.uv[i * 2 + 1]);
      if (src.col) out.col.push(src.col[o], src.col[o + 1], src.col[o + 2]);
      if (src.pbr) out.pbr.push(src.pbr[o], src.pbr[o + 1], src.pbr[o + 2]);
      out.ids.push(src.ids ? src.ids[i] : i);
    }
    if (src.nor) { out.nor[j * 3] += src.nor[o]; out.nor[j * 3 + 1] += src.nor[o + 1]; out.nor[j * 3 + 2] += src.nor[o + 2]; }
    remap[i] = j;
  }
  const idx = src.index;
  const nt = (idx ? idx.length : n) / 3;
  for (let t = 0; t < nt; t++) {
    const a = remap[idx ? idx[t * 3] : t * 3], b = remap[idx ? idx[t * 3 + 1] : t * 3 + 1], c = remap[idx ? idx[t * 3 + 2] : t * 3 + 2];
    if (a !== b && b !== c && a !== c) out.index.push(a, b, c);
  }
  for (let j = 0; j < out.nor.length; j += 3) {
    const l = Math.hypot(out.nor[j], out.nor[j + 1], out.nor[j + 2]) || 1;
    out.nor[j] /= l; out.nor[j + 1] /= l; out.nor[j + 2] /= l;
  }
  return out;
}

function horseLod(asset, cell) {
  const V = asset.V, uv = asset.geometry.attributes.uv.array, minY = asset.geometry.attributes.aMinY.array;
  const c = cluster({ pos: asset.rest, pos2: asset.frames[asset.N >> 1], uv, index: asset.index }, cell);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(c.uv, 2));
  g.setAttribute('aVid', new THREE.Float32BufferAttribute(c.ids, 1));
  g.setAttribute('aMinY', new THREE.Float32BufferAttribute(c.ids.map((i) => minY[i]), 1));
  g.setIndex(c.index);
  g.userData.tris = c.index.length / 3;
  return g;
}

// 从近景骑兵第 i 号骑手当前帧的部件矩阵，烘焙出“相对马背挂点”的合并骑手网格
function bakeRider(cavalry, lib, i) {
  const P = cavalry.parts;
  const S = new THREE.Matrix4(); P.seatLeather.mesh.getMatrixAt(i, S);
  const invS = S.clone().invert();
  const M = new THREE.Matrix4(), n3 = new THREE.Matrix3(), v = new THREE.Vector3();
  const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
  const look = new Map([
    [lib.lamellar, { c: [1, 1, 1], p: [1, 0.5, 1], id: 0 }],
    [lib.iron, { c: C(0x6f6d6a), p: [1, 0.5, 0], id: 1 }],
    [lib.steel, { c: C(0xa9a7a2), p: [1, 0.35, 0], id: 2 }],
    [lib.leather, { c: C(0x7a5236), p: [0, 0.72, 0], id: 3 }],
    [lib.leatherDark, { c: C(0x44352c), p: [0, 0.68, 0], id: 4 }],
    [lib.cloth, { c: C(0x4d130e), p: [0, 0.95, 0], id: 5 }],
    [lib.clothDark, { c: C(0x2a2320), p: [0, 0.95, 0], id: 6 }],
    [lib.wood, { c: C(0x3a2416), p: [0, 0.55, 0], id: 7 }],
    [lib.tassel, { c: C(0xa3160f), p: [0, 0.9, 0], id: 8 }],
    [lib.skin, { c: C(0x9c6b4c), p: [0, 0.65, 0], id: 9 }],
  ]);
  const body = { pos: [], nor: [], uv: [], col: [], pbr: [], mat: [] };
  const push = (dst, geo, rel, L) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, nr = g.attributes.normal, uv = g.attributes.uv;
    n3.getNormalMatrix(rel);
    for (let k = 0; k < p.count; k++) {
      v.fromBufferAttribute(p, k).applyMatrix4(rel); dst.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(nr, k).applyMatrix3(n3).normalize(); dst.nor.push(v.x, v.y, v.z);
      dst.uv.push(uv ? uv.getX(k) : 0, uv ? uv.getY(k) : 0);
      dst.col.push(...L.c); dst.pbr.push(...L.p); dst.mat.push(L.id);
    }
  };
  for (const key in P) {
    const part = P[key];
    if (part.frame === 'horseHead' || part.frame === 'segment' || part.frame === 'lance') continue;
    const L = look.get(part.mat);
    for (let k = 0; k < part.per; k++) {
      part.mesh.getMatrixAt(i * part.per + k, M);
      push(body, part.geo, M.premultiply(invS), L);
    }
  }
  // 长槊太细，聚类会把它抹掉：单独做一根低面数的槊（略加粗，远处不至于闪烁消失）
  const lanceRel = new THREE.Matrix4(); P.lanceWood.mesh.getMatrixAt(i, lanceRel); lanceRel.premultiply(invS);
  const lance = { pos: [], nor: [], uv: [], col: [], pbr: [], mat: [] };
  const G = RIG.lanceGrip, len = RIG.lanceLen - 0.45, tipY = len - G;
  push(lance, new THREE.BoxGeometry(0.05, len, 0.05).translate(0, len / 2 - G, 0), lanceRel, look.get(lib.wood));
  push(lance, new THREE.ConeGeometry(0.045, 0.55, 4).translate(0, tipY + 0.3, 0), lanceRel, look.get(lib.steel));
  push(lance, new THREE.OctahedronGeometry(0.075).scale(1, 1.8, 1).translate(0, tipY - 0.16, 0), lanceRel, look.get(lib.tassel));
  return { body, lance, lanceRel };
}

function riderLod(baked, cell) {
  const a = cluster(baked.body, cell), b = cluster(baked.lance, 1e-4);
  const off = a.pos.length / 3;
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos.concat(b.pos), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor.concat(b.nor), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv.concat(b.uv), 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(a.col.concat(b.col), 3));
  g.setAttribute('aPbr', new THREE.Float32BufferAttribute(a.pbr.concat(b.pbr), 3));
  g.setIndex(a.index.concat(b.index.map((x) => x + off)));
  g.userData.tris = (a.index.length + b.index.length) / 3;
  return g;
}

export class Legion {
  constructor({ asset, lib, cavalry, dust, timeUniform }) {
    this.asset = asset; this.dust = dust;
    this.group = new THREE.Group(); this.group.name = 'legion';
    this.uniforms = {
      uLgPlayer: { value: new THREE.Vector2() }, uLgClock: { value: 0 }, uTime: timeUniform,
      tLgSock: { value: null }, tLam: { value: lib.barding.map }, uLgLance: { value: new THREE.Matrix4() },
      ...asset.uniforms,
    };
    // —— 马背挂点轨迹纹理
    const N = asset.N, sd = asset.sockets.saddle.data, td = new Float32Array(N * 2 * 4);
    for (let f = 0; f < N; f++) {
      td.set([sd[f * 7], sd[f * 7 + 1], sd[f * 7 + 2], 0], f * 4);
      td.set([sd[f * 7 + 3], sd[f * 7 + 4], sd[f * 7 + 5], sd[f * 7 + 6]], (N + f) * 4);
    }
    this.sockTex = new THREE.DataTexture(td, N, 2, THREE.RGBAFormat, THREE.FloatType);
    this.sockTex.minFilter = this.sockTex.magFilter = THREE.NearestFilter; this.sockTex.needsUpdate = true;
    this.uniforms.tLgSock.value = this.sockTex;

    // —— 队形：与近景相同的纵列间距（3.4m），行距 7.5m，带抖动；挖掉近景骑兵所在的区域
    let rs = 12345;
    const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
    const all = [];
    for (let k = 0; k < 44; k++) for (const sgn of [-1, 1]) for (let z = -135; z <= 60; z += 7.5) {
      const x = sgn * (2.9 + 3.4 * k);
      if (Math.abs(x) < 20 && z > -21 && z < 20) continue;
      const px = x + (rnd() - 0.5) * 0.9, pz = z + (rnd() - 0.5) * 2.4;
      all.push({ x: px, z: pz, ph: rnd(), seed: rnd(), coat: COATS[(rnd() * COATS.length) | 0], pr: Math.hypot(px, pz > 0 ? pz * 2.2 : pz) });
    }
    // 正中一列（玩家的正前方与正后方）：近处留给近卫的前锋，35m 以外由军阵接上
    for (let z = -135; z <= 60; z += 7.5) {
      if (z > -34 && z < 20) continue;
      const px = (rnd() - 0.5) * 0.8, pz = z + (rnd() - 0.5) * 2.4;
      all.push({ x: px, z: pz, ph: rnd(), seed: 0.1 + 0.9 * rnd(), coat: COATS[(rnd() * COATS.length) | 0], pr: Math.hypot(px, pz > 0 ? pz * 2.2 : pz) });
    }
    all.sort((a, b) => a.pr - b.pr);
    this.all = all.slice(0, LEGION_MAX);

    // —— 材质
    const U = this.uniforms;
    const horseMat = new THREE.MeshStandardMaterial({ map: asset.maps.map, metalness: 0, roughness: 0.8, envMapIntensity: 0.9 });
    horseMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          ${lgGLSL()} ${vatGLSL(asset)}
          attribute float aVid; attribute float aMinY; attribute vec3 aTint;
          varying vec3 vTint; varying vec3 vRest; varying float vMinY;
          vec3 lgP; vec3 lgN;`)
        .replace('#include <beginnormal_vertex>', `
          lgInit(); vatSample(int(aVid + 0.5), lgPhase, lgP, lgN);
          vec3 objectNormal = lgRot(lgN);
          vTint = aTint; vRest = position; vMinY = aMinY;`)
        .replace('#include <begin_vertex>', 'vec3 transformed = lgWorld(lgP);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tLam; varying vec3 vTint; varying vec3 vRest; varying float vMinY; float lgBard;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          // 远景马甲：不再另画壳层，直接在马身上按同样的范围涂成札甲
          lgBard = step(-1.175, vRest.z) * step(vRest.z, 1.02) * step(0.99, vMinY);
          diffuseColor.rgb = mix(diffuseColor.rgb * vTint, texture2D(tLam, vec2(vRest.z / 0.3, vRest.y / 0.42)).rgb, lgBard);`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.8, 0.5, lgBard);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = lgBard;');
    };
    horseMat.customProgramCacheKey = () => 'lgHorse';
    markMover(horseMat);

    const riderMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1, envMapIntensity: 1.2 });
    riderMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          ${lgGLSL()} ${sockGLSL(N)}
          attribute vec3 aPbr; varying vec3 vPbr; varying vec2 vLgUv;`)
        .replace('#include <beginnormal_vertex>', `
          lgInit(); lgSocket();
          vec3 objectNormal = lgRot(lgQrot(lgSq, normal));
          vPbr = aPbr; vLgUv = uv;`)
        .replace('#include <begin_vertex>', 'vec3 transformed = lgWorld(lgSp + lgQrot(lgSq, position));');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n uniform sampler2D tLam; varying vec3 vPbr; varying vec2 vLgUv;')
        .replace('#include <map_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), texture2D(tLam, vLgUv).rgb * 1.6, vPbr.z);')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.y;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;');
    };
    riderMat.customProgramCacheKey = () => 'lgRider';
    markMover(riderMat);

    const flagMat = new THREE.MeshStandardMaterial({ map: lib.bannerTex, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
    flagMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          ${lgGLSL()} ${sockGLSL(N)}
          uniform mat4 uLgLance; vec3 flagP;`)
        .replace('#include <beginnormal_vertex>', `
          lgInit(); lgSocket();
          float fu = clamp(position.x / 1.55, 0.0, 1.0);
          float a1 = position.x * 5.2 - uTime * 15.0 + aInst.w * 50.0 + position.y * 1.4;
          float a3 = position.x * 2.1 - uTime * 6.0 + aInst.w * 20.0;
          float amp = pow(fu, 0.75);
          flagP = position;
          flagP.z += (sin(a1) * 0.13 + sin(a3) * 0.1) * amp;
          flagP.y += (cos(a1 * 0.8) * 0.035 - 0.09 * fu) * fu;
          float dz = (cos(a1) * 0.68 + cos(a3) * 0.21) * amp;
          vec3 objectNormal = lgRot(lgQrot(lgSq, mat3(uLgLance) * normalize(vec3(-dz, 0.0, 1.0))));`)
        .replace('#include <begin_vertex>', 'vec3 transformed = lgWorld(lgSp + lgQrot(lgSq, (uLgLance * vec4(flagP, 1.0)).xyz));');
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', FLAG_MAP_FRAGMENT);
    };
    flagMat.customProgramCacheKey = () => 'lgFlag';
    markMover(flagMat);

    // 假阴影：顺着夕阳方向拉长的柔和暗斑（正片叠底）
    const sd2 = new THREE.Vector2(-atmosphere.sunDir.x, -atmosphere.sunDir.z).normalize();
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uShDir: { value: sd2 } },
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: `${lgGLSL()}
        uniform vec2 uShDir; varying vec2 vUv;
        void main() {
          lgInit(); vUv = uv;
          vec2 side = vec2(-uShDir.y, uShDir.x);
          vec2 xz = lgXZ + side * (uv.x - 0.5) * 2.4 + uShDir * (uv.y * 11.0 - 0.9);
          gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, terrainHeight(xz) + 0.04, xz.y, 1.0);
        }`,
      fragmentShader: `varying vec2 vUv;
        void main() {
          float a = (1.0 - smoothstep(0.12, 0.5, abs(vUv.x - 0.5))) * smoothstep(0.0, 0.07, vUv.y) * pow(clamp(1.0 - vUv.y, 0.0, 1.0), 0.8);
          gl_FragColor = vec4(vec3(1.0 - 0.5 * clamp(a, 0.0, 1.0)), 1.0);
        }`,
    });
    this.materials = [horseMat, riderMat, flagMat, shadowMat];

    // —— 几何体（两档 LOD）
    const baked = bakeRider(cavalry, lib, 1);
    U.uLgLance.value.copy(baked.lanceRel);
    const mk = (geo, mat, cap, tint) => {
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      geo.setAttribute('aInst', inst);
      if (tint) geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
      geo.instanceCount = 0;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false; m.receiveShadow = false; m.castShadow = false;
      this.group.add(m);
      return m;
    };
    const cap = this.all.length;
    this.tiers = [
      { horse: mk(horseLod(asset, 0.06), horseMat, cap, true), rider: mk(riderLod(baked, 0.055), riderMat, cap) },
      { horse: mk(horseLod(asset, 0.11), horseMat, cap, true), rider: mk(riderLod(baked, 0.11), riderMat, cap) },
    ];
    const plane = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1, 1, 6));
    this.shadow = mk(plane, shadowMat, cap);
    this.shadow.renderOrder = 4;
    const fg = new THREE.InstancedBufferGeometry().copy(buildFlagGeometry());
    this.flags = mk(fg, flagMat, cap);
    this.info = this.tiers.map((t) => ({ horseTris: t.horse.geometry.userData.tris, riderTris: t.rider.geometry.userData.tris }));
    this.count = 0; this.emitAcc = 0;
    this.setCount(1000);
  }

  setCount(n) {
    n = Math.max(0, Math.min(this.all.length, n | 0));
    this.count = n;
    const c = [0, 0]; let nf = 0;
    const sh = this.shadow.geometry.attributes.aInst, fl = this.flags.geometry.attributes.aInst;
    for (let i = 0; i < n; i++) {
      const r = this.all[i], t = Math.hypot(r.x, r.z) < MID_RANGE ? 0 : 1, T = this.tiers[t], j = c[t]++;
      T.horse.geometry.attributes.aInst.setXYZW(j, r.x, r.z, r.ph, r.seed);
      T.horse.geometry.attributes.aTint.setXYZ(j, r.coat[0], r.coat[1], r.coat[2]);
      T.rider.geometry.attributes.aInst.setXYZW(j, r.x, r.z, r.ph, r.seed);
      sh.setXYZW(i, r.x, r.z, r.ph, r.seed);
      if (r.seed < 0.07) fl.setXYZW(nf++, r.x, r.z, r.ph, r.seed);
    }
    this.tiers.forEach((T, t) => {
      for (const m of [T.horse, T.rider]) { m.geometry.instanceCount = c[t]; m.geometry.attributes.aInst.needsUpdate = true; m.visible = c[t] > 0; }
      T.horse.geometry.attributes.aTint.needsUpdate = true;
    });
    this.shadow.geometry.instanceCount = n; sh.needsUpdate = true; this.shadow.visible = n > 0;
    this.flags.geometry.instanceCount = nf; fl.needsUpdate = true; this.flags.visible = nf > 0;
    this.tierCounts = c; this.flagCount = nf;
  }

  // 每帧：推进步态时钟、跟随玩家、按人数喷发尘团
  update(dt, time, player, stride, dustAmount) {
    this.uniforms.uLgPlayer.value.set(player.x, player.z);
    this.uniforms.uLgClock.value += (player.speed / stride) * dt;
    if (dustAmount <= 0 || !this.count) return;
    this.emitAcc += Math.min(this.count, 1400) * 0.55 * dt;
    const hoof = this.dust.hoof, v = player.speed;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const r = this.all[(Math.random() * this.count) | 0];
      const x = player.x + r.x + (Math.random() - 0.5), z = player.z + r.z + 1 + Math.random();
      const far = Math.min(1, Math.hypot(r.x, r.z) / 120);
      hoof.emit(x, terrainHeight(x, z) + 0.35, z, (Math.random() - 0.5) * 1.4, 0.4 + Math.random(), -v * 0.1 + Math.random() * 1.4,
        time, 5 + Math.random() * 4 + 3 * far, 0.5 + 0.4 * far, 2.6 + Math.random() * 2.4 + 2.5 * far, (0.035 + Math.random() * 0.035) * dustAmount);
    }
  }

  dispose() {
    for (const T of this.tiers) { T.horse.geometry.dispose(); T.rider.geometry.dispose(); }
    this.shadow.geometry.dispose(); this.flags.geometry.dispose(); this.sockTex.dispose();
    this.materials.forEach((m) => m.dispose());
  }
}
