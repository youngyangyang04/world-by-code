import * as THREE from 'three';
import { ATMOSPHERE_GLSL, NOISE_GLSL, atmosphereUniforms } from '../env/atmosphere.js';
import { HEIGHT_GLSL } from '../env/heightfield.js';
import { DUST_LAYER } from './post.js';

// ---------------------------------------------------------------------------
// GPU 沙尘系统
//   · HoofDust   —— 环形缓冲的实例化公告板。CPU 只在“出生”时写入一次（位置/速度/出生时间），
//                   之后的运动（阻力、风、湍流、上升、贴地）、膨胀、淡出全部在顶点着色器里完成。
//   · AirMotes   —— 围绕相机取模循环的空气浮尘微粒。
//   · DustBanks  —— 中远距离缓慢翻滚的大尺度尘云（暗示尘幕之后的大军）。
// 光照：Henyey-Greenstein 前向散射 —— 朝向夕阳时沙尘被照成金色；逆光时团块边缘发亮、核心偏暗。
// 遮挡：与场景深度做软深度测试，形成真实的远近遮挡关系。
// ---------------------------------------------------------------------------

function makePuffAtlas() {
  // 2×2 图集，每格一种程序化烟团（多层随机高斯团叠加出不规则的絮状边缘）
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * S, oy = (cell >> 1) * S;
    g.save();
    g.beginPath(); g.rect(ox, oy, S, S); g.clip();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i++) {
      const a = rnd() * 6.283, rr = Math.pow(rnd(), 0.8) * S * 0.27;
      const x = ox + S / 2 + Math.cos(a) * rr, y = oy + S / 2 + Math.sin(a) * rr;
      const r = S * (0.06 + 0.15 * rnd()) * (1 - rr / (S * 0.5));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const al = 0.05 + 0.1 * rnd();
      gr.addColorStop(0, `rgba(255,255,255,${al})`);
      gr.addColorStop(0.5, `rgba(255,255,255,${al * 0.45})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const DUST_COMMON = /* glsl */ `
uniform sampler2D tSceneDepth;
uniform vec2 uDustRes;
uniform float uCamNear;
uniform float uCamFar;
float linDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uCamNear * uCamFar / (uCamFar + uCamNear - z * (uCamFar - uCamNear));
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
// 体积感光照：rd 为相机→粒子方向，q 为团块内局部坐标（-1..1），a 为该像素的密度
vec3 dustLight(vec3 rd, vec2 q, float a, vec2 sunScreen, vec3 albedo) {
  float c = dot(rd, uSunDir);
  float fwd = hg(c, 0.72) * 5.0 + hg(c, 0.25) * 1.8;       // 前向散射
  float rim = mix(1.0, 1.0 - 0.72 * a, smoothstep(-0.2, 0.8, c)); // 逆光时核心自遮挡变暗
  float side = 0.82 + 0.3 * dot(q, sunScreen);               // 朝阳的一侧更亮
  vec3 amb = mix(uHaze, uZenith, 0.25) * 0.5;
  // 顺光（背向太阳看）时沙尘是偏白的土黄，逆光时才被染成金色
  vec3 sunC = mix(vec3(dot(uSunColor, vec3(0.4, 0.4, 0.2))) * vec3(1.0, 0.88, 0.72), uSunColor, smoothstep(-0.5, 0.6, c));
  return albedo * (amb + sunC * (0.42 + fwd) * rim * side);
}
`;

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_IDX = [0, 1, 2, 0, 2, 3];

export class HoofDust {
  constructor(depthUniforms, capacity = 48000) {
    this.capacity = capacity;
    this.cursor = 0;
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
    this.STRIDE = 12; // pos3, vel3, birth, life, size0, grow, seed, opacity
    this.data = new Float32Array(capacity * this.STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * this.STRIDE + 6] = -1e5; // 出生时间置于远古 → 不可见

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    geo.setIndex(QUAD_IDX);
    this.ib = new THREE.InstancedInterleavedBuffer(this.data, this.STRIDE, 1);
    this.ib.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(this.ib, 3, 0));
    geo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(this.ib, 3, 3));
    geo.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.ib, 2, 6));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(this.ib, 2, 8));
    geo.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(this.ib, 2, 10));
    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      ...atmosphereUniforms, ...depthUniforms,
      tPuff: { value: makePuffAtlas() },
      uWind: { value: new THREE.Vector3(1.6, 0, 2.4) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec3 aPos; attribute vec3 aVel; attribute vec2 aLife; attribute vec2 aSize; attribute vec2 aMisc;
        uniform float uTime; uniform vec3 uWind; uniform vec3 uSunDir;
        varying vec2 vQ; varying vec4 vInfo; varying vec3 vRd; varying float vViewZ; varying vec2 vSunScr; varying float vDist;
        ${HEIGHT_GLSL}
        void main() {
          float age = uTime - aLife.x;
          float t = age / aLife.y;
          if (t < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float seed = aMisc.x;
          float heavy = step(aSize.y, 0.0001);   // grow==0 → 土块/砂砾，受重力
          // 空气阻力下的位移积分
          float k = mix(2.6, 1.1, heavy);
          vec3 p = aPos + aVel * (1.0 - exp(-k * age)) / k;
          // 风把细尘向后上方带走；土块受重力回落
          float lift = (1.0 - heavy);
          p += uWind * age * lift * (0.35 + 0.5 * fract(seed * 7.3));
          p.y += lift * (0.28 + 0.5 * fract(seed * 3.7)) * sqrt(age + 0.02) * (0.5 + aSize.x)
               - heavy * 4.9 * age * age * 0.55;
          // 湍流卷动
          float ph = seed * 40.0;
          p += lift * vec3(sin(age * 1.3 + ph), 0.6 * sin(age * 0.9 + ph * 1.7), cos(age * 1.1 + ph * 0.6)) * (0.1 + 0.2 * age);
          float size = aSize.x + aSize.y * (1.0 - exp(-age * 1.4)) + aSize.y * 0.2 * age;
          float gh = terrainHeight(p.xz);
          p.y = max(p.y, gh + size * mix(0.34, 0.5, heavy));
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float rot = seed * 6.283 + age * (fract(seed * 13.7) - 0.5) * 0.9 * lift;
          float cr = cos(rot), sr = sin(rot);
          vec2 q = position.xy;
          mv.xy += vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y) * size;
          gl_Position = projectionMatrix * mv;
          vQ = q;
          float fadeIn = smoothstep(0.0, mix(0.1, 0.02, heavy), t);
          float fadeOut = 1.0 - smoothstep(mix(0.3, 0.75, heavy), 1.0, t);
          vInfo = vec4(seed, aMisc.y * fadeIn * fadeOut, heavy, rot);
          vRd = normalize(p - cameraPosition);
          vDist = length(p - cameraPosition);
          vViewZ = -mv.z;
          vec3 sv = mat3(viewMatrix) * uSunDir;
          vec2 ss = normalize(sv.xy + 1e-4);
          vSunScr = vec2(cr * ss.x + sr * ss.y, -sr * ss.x + cr * ss.y);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tPuff;
        varying vec2 vQ; varying vec4 vInfo; varying vec3 vRd; varying float vViewZ; varying vec2 vSunScr; varying float vDist;
        ${ATMOSPHERE_GLSL}
        ${DUST_COMMON}
        void main() {
          float cell = floor(fract(vInfo.x * 91.7) * 4.0);
          vec2 uv = (vQ * 0.5 + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
          float a = texture2D(tPuff, uv).a;
          float heavy = vInfo.z;
          a = mix(a, smoothstep(1.0, 0.55, length(vQ)), heavy);
          a = clamp(a * 1.35, 0.0, 1.0) * vInfo.y;
          // 软深度：与不透明场景的距离越近越淡 → 沙尘被战马/地面自然遮挡
          float sceneZ = linDepth(texture2D(tSceneDepth, gl_FragCoord.xy / uDustRes).x);
          float soft = clamp((sceneZ - vViewZ) / mix(0.9, 0.08, heavy), 0.0, 1.0);
          float nearFade = smoothstep(0.25, mix(2.4, 0.6, heavy), vViewZ);
          a *= soft * nearFade;
          if (a < 0.003) discard;
          vec3 albedo = mix(vec3(0.86, 0.66, 0.42), vec3(0.42, 0.3, 0.19), heavy);
          vec3 col = dustLight(vRd, vQ, a, vSunScr, albedo);
          // 土块是不透明固体：不做前向散射，只受漫反射光
          col = mix(col, albedo * (uHaze * 0.5 + uSunColor * 0.9), heavy);
          // 远处的尘融入大气
          float f = fogAmount(cameraPosition, vRd, vDist);
          col = mix(col, hazeColor(vRd), f);
          gl_FragColor = vec4(col * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(DUST_LAYER);
    this.mesh.name = 'hoofDust';
  }

  // grow==0 表示受重力的土块
  emit(x, y, z, vx, vy, vz, time, life, size0, grow, opacity) {
    const i = this.cursor, o = i * this.STRIDE, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = time; d[o + 7] = life; d[o + 8] = size0; d[o + 9] = grow;
    d[o + 10] = Math.random(); d[o + 11] = opacity;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount++;
    this.cursor = (i + 1) % this.capacity;
  }

  // 每帧调用一次：只上传本帧新写入的区间
  flush() {
    if (this.dirtyFrom < 0) return;
    const S = this.STRIDE; // 区间由 three 在上传后自动清空；这里只追加，保证“多次 step 才渲染一次”时不丢数据
    if (this.dirtyCount >= this.capacity) {
      this.ib.addUpdateRange(0, this.capacity * S);
    } else {
      const end = this.dirtyFrom + this.dirtyCount;
      if (end <= this.capacity) {
        this.ib.addUpdateRange(this.dirtyFrom * S, this.dirtyCount * S);
      } else {
        this.ib.addUpdateRange(this.dirtyFrom * S, (this.capacity - this.dirtyFrom) * S);
        this.ib.addUpdateRange(0, (end - this.capacity) * S);
      }
    }
    this.ib.needsUpdate = true;
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * this.STRIDE + 6] = -1e5;
    this.dirtyFrom = 0; this.dirtyCount = this.capacity;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.uniforms.tPuff.value.dispose(); }
}

// 围绕相机循环的环境沙尘：type 0 = 空气中的细小颗粒；type 1 = 中远距离的大团尘云
export class AmbientDust {
  constructor(depthUniforms, puffTex, { count, box, sizeMin, sizeMax, opacity, minDist, mote }) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    geo.setIndex(QUAD_IDX);
    const a = new Float32Array(count * 4), b = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      a[i * 4] = Math.random() * box.x; a[i * 4 + 1] = Math.random(); a[i * 4 + 2] = Math.random() * box.z;
      a[i * 4 + 3] = Math.random();
      b[i * 2] = sizeMin + (sizeMax - sizeMin) * Math.pow(Math.random(), 2.0);
      b[i * 2 + 1] = 0.4 + 0.6 * Math.random();
    }
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(a, 4));
    geo.setAttribute('aSz', new THREE.InstancedBufferAttribute(b, 2));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.uniforms = {
      ...atmosphereUniforms, ...depthUniforms,
      tPuff: { value: puffTex },
      uBox: { value: new THREE.Vector3(box.x, box.y, box.z) },
      uWind: { value: new THREE.Vector3(1.6, 0, 2.4) },
      uOpacity: { value: opacity },
      uMinDist: { value: minDist },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: mote ? { MOTE: '' } : {},
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: /* glsl */ `
        attribute vec4 aBase; attribute vec2 aSz;
        uniform float uTime; uniform vec3 uBox; uniform vec3 uWind; uniform float uMinDist; uniform float uDustAmount; uniform vec3 uSunDir;
        varying vec2 vQ; varying vec4 vInfo; varying vec3 vRd; varying float vViewZ; varying vec2 vSunScr; varying float vDist;
        ${HEIGHT_GLSL}
        void main() {
          float seed = aBase.w;
          vec2 drift = uWind.xz * uTime * (0.5 + seed);
          vec2 xz = mod(aBase.xz + drift - cameraPosition.xz, uBox.xz) - 0.5 * uBox.xz;
          vec2 edge = 1.0 - smoothstep(0.38, 0.5, abs(xz) / uBox.xz);
          vec3 p = vec3(xz.x + cameraPosition.x, 0.0, xz.y + cameraPosition.z);
          float gh = terrainHeight(p.xz);
        #ifdef MOTE
          p.y = gh + 0.1 + aBase.y * aBase.y * uBox.y + 0.25 * sin(uTime * (1.0 + seed * 2.0) + seed * 50.0);
          p.xz += 0.3 * vec2(sin(uTime * 1.7 + seed * 31.0), cos(uTime * 1.3 + seed * 17.0));
        #else
          p.y = gh + aSz.x * (0.3 + 0.35 * aBase.y);
        #endif
          float size = aSz.x;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float rot = seed * 6.283 + uTime * (seed - 0.5) * 0.12;
          float cr = cos(rot), sr = sin(rot);
          vec2 q = position.xy;
          mv.xy += vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y) * size;
          gl_Position = projectionMatrix * mv;
          vQ = q;
          vDist = length(p - cameraPosition);
          float pulse = 0.6 + 0.4 * sin(uTime * 0.21 + seed * 30.0);
          vInfo = vec4(seed, aSz.y * edge.x * edge.y * smoothstep(uMinDist, uMinDist * 2.2, vDist) * pulse * uDustAmount, 0.0, rot);
          vRd = normalize(p - cameraPosition);
          vViewZ = -mv.z;
          vec3 sv = mat3(viewMatrix) * uSunDir;
          vec2 ss = normalize(sv.xy + 1e-4);
          vSunScr = vec2(cr * ss.x + sr * ss.y, -sr * ss.x + cr * ss.y);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tPuff; uniform float uOpacity;
        varying vec2 vQ; varying vec4 vInfo; varying vec3 vRd; varying float vViewZ; varying vec2 vSunScr; varying float vDist;
        ${ATMOSPHERE_GLSL}
        ${DUST_COMMON}
        void main() {
          float sceneZ = linDepth(texture2D(tSceneDepth, gl_FragCoord.xy / uDustRes).x);
        #ifdef MOTE
          float a = smoothstep(1.0, 0.2, length(vQ)) * vInfo.y * uOpacity;
          a *= step(vViewZ, sceneZ) * smoothstep(0.15, 0.6, vViewZ);
          if (a < 0.003) discard;
          float c = dot(vRd, uSunDir);
          vec3 col = vec3(1.0, 0.82, 0.55) * (0.35 + uSunColor * (hg(c, 0.8) * 14.0 + 0.6));
          gl_FragColor = vec4(col * a, a * 0.6);
        #else
          float cell = floor(fract(vInfo.x * 91.7) * 4.0);
          vec2 uv = (vQ * 0.5 + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
          float a = clamp(texture2D(tPuff, uv).a * 1.3, 0.0, 1.0) * vInfo.y * uOpacity;
          float soft = clamp((sceneZ - vViewZ) / 12.0, 0.0, 1.0);
          a *= soft;
          if (a < 0.003) discard;
          vec3 col = dustLight(vRd, vQ, a, vSunScr, vec3(0.84, 0.64, 0.42));
          float f = fogAmount(cameraPosition, vRd, vDist);
          col = mix(col, hazeColor(vRd), f * 0.85);
          gl_FragColor = vec4(col * a, a);
        #endif
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(DUST_LAYER);
  }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

export function createDustSystem(depthUniforms) {
  const hoof = new HoofDust(depthUniforms);
  const puff = hoof.uniforms.tPuff.value;
  const motes = new AmbientDust(depthUniforms, puff, {
    count: 5000, box: { x: 50, y: 7, z: 50 }, sizeMin: 0.006, sizeMax: 0.022, opacity: 0.9, minDist: 0.3, mote: true,
  });
  const banks = new AmbientDust(depthUniforms, puff, {
    count: 170, box: { x: 1500, y: 1, z: 1500 }, sizeMin: 30, sizeMax: 110, opacity: 0.22, minDist: 70, mote: false,
  });
  banks.mesh.renderOrder = -2; motes.mesh.renderOrder = 2; hoof.mesh.renderOrder = 0;
  const group = new THREE.Group();
  group.add(banks.mesh, hoof.mesh, motes.mesh);
  group.name = 'dust';
  return { group, hoof, motes, banks, dispose() { hoof.dispose(); motes.dispose(); banks.dispose(); } };
}
