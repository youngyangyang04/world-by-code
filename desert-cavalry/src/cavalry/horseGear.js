import * as THREE from 'three';
import { applyVat } from './herd.js';
import { vatGLSL } from './horseAsset.js';
import { markMover } from '../fx/post.js';

// ---------------------------------------------------------------------------
// 战马装具（全部与战马共享 VAT、步态相位与实例矩阵，所以随肌肉与颈部动作一起形变）
//   · 具装（马甲）：把战马网格沿动画法线外推 2cm 作为“壳层”，片元着色器按参考姿态坐标裁出
//     鸡颈（颈甲）/ 当胸 / 马身甲 / 搭后的范围，下摆做成牙边，贴三向投影的札甲 PBR 贴图。
//     头部的同一壳层裁成辔头（鼻带、额带、颊带）。
//   · 马鬃：沿颈脊顶点生成发片，根部锚定在 VAT 顶点上，随奔跑向后飘飞并随步伐起伏。
// ---------------------------------------------------------------------------

export function addBarding(herd, asset, lib) {
  const src = lib.barding;
  const mat = new THREE.MeshStandardMaterial({
    map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap,
    metalness: 1, roughness: 1, envMapIntensity: 1.15, side: THREE.DoubleSide,
  });
  applyVat(mat, asset, {
    offset: 0.02, key: 'barding',
    extraFragment: (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aMinY; varying float vMinY; varying vec3 vRestN;`)
        .replace('vTint = aTint; vRest = position;', 'vTint = aTint; vRest = position; vMinY = aMinY; vRestN = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vMinY; varying vec3 vRestN;
          vec2 bUv; float bTack; float bTrim;`)
        .replace('#include <map_fragment>', `
          {
            vec3 rp = vRest;
            bTack = 0.0; bTrim = 0.0;
            if (rp.z < -1.175) {
              // —— 辔头：沿面部轴线的距离 s 与离鼻梁的深度 h 定义三条皮带
              vec3 dAx = vec3(0.0, -0.476, -0.879), nAx = vec3(0.0, 0.879, -0.476);
              vec3 rel = rp - vec3(0.0, 1.915, -1.2);
              float s = dot(rel, dAx), h = -dot(rel, nAx);
              float nose = step(abs(s - 0.37), 0.014);
              float brow = step(abs(s - 0.075), 0.012) * step(h, 0.1);
              float cheek = step(abs(h - 0.085), 0.011) * step(0.075, s) * step(s, 0.37);
              float thr = step(abs(s - 0.02 - h * 0.35), 0.011) * step(0.06, h);
              if (nose + brow + cheek + thr < 0.5) discard;
              bTack = 1.0;
            } else {
              // —— 具装范围：躯干与颈部（腿、腹底、尾巴除外），下摆牙边
              float hem = 0.985 + 0.014 * abs(sin(rp.z * 42.0 + rp.x * 9.0));
              if (rp.z > 1.02 || vMinY < hem) discard;
              // 马鬃从颈脊正中的缝里长出来
              if (rp.z < -0.38 && abs(rp.x) < 0.012 && vRestN.y > 0.5) discard;
              bTrim = step(vMinY, hem + 0.03);
            }
            vec3 an = abs(normalize(vRestN));
            if (an.x > an.y && an.x > an.z) bUv = vec2(rp.z / 0.3, rp.y / 0.42);
            else if (an.y > an.z) bUv = vec2(rp.z / 0.3, rp.x / 0.42);
            else bUv = vec2(rp.x / 0.3, rp.y / 0.42);
            vec4 texel = texture2D(map, bUv);
            diffuseColor.rgb = mix(texel.rgb, vec3(0.17, 0.035, 0.025), bTrim);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.032, 0.022), bTack);
          }`)
        .replace('#include <roughnessmap_fragment>', `
          vec3 bOrm = texture2D(roughnessMap, bUv).rgb;
          float roughnessFactor = mix(bOrm.g, 0.8, max(bTack, bTrim));`)
        .replace('#include <metalnessmap_fragment>', `float metalnessFactor = mix(bOrm.b, 0.0, max(bTack, bTrim));`)
        .replace('#include <normal_fragment_maps>', `
          {
            mat3 bT = getTangentFrame(-vViewPosition, normal, bUv);
            vec3 bn = texture2D(normalMap, bUv).xyz * 2.0 - 1.0;
            bn.xy *= (1.0 - max(bTack, bTrim)) * 1.2;
            normal = normalize(bT * bn);
          }`);
    },
  });
  markMover(mat);
  const geo = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv', 'aMinY']) geo.setAttribute(k, asset.geometry.attributes[k]);
  geo.setIndex(asset.geometry.index);
  geo.boundingSphere = asset.geometry.boundingSphere;
  const mesh = herd.addLayer(geo, mat, { shadow: false });
  mesh.name = 'barding';
  return mesh;
}

function strandTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 64, 256);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 44; i++) {
    const x = 3 + rnd() * 58, len = 170 + rnd() * 86, w = 2 + rnd() * 4;
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.strokeStyle = gr; g.lineWidth = w;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (rnd() - 0.5) * 8, len * 0.3, x + (rnd() - 0.5) * 12, len * 0.7, x + (rnd() - 0.5) * 16, len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; // v=0 发根
  return t;
}

export function addMane(herd, asset, timeUniform) {
  const R = asset.rest, V = asset.V;
  // —— 颈脊锚点：枕部(-1.14) → 鬐甲(-0.42)，每 2cm 取正中线上最高的顶点
  const anchors = [];
  for (let z = -1.14; z <= -0.4; z += 0.02) {
    let best = -1, by = -1;
    for (let i = 0; i < V; i++) {
      if (Math.abs(R[i * 3 + 2] - z) < 0.014 && Math.abs(R[i * 3]) < 0.03 && R[i * 3 + 1] > by) { by = R[i * 3 + 1]; best = i; }
    }
    if (best >= 0 && by > 1.5 && anchors[anchors.length - 1] !== best) anchors.push(best);
  }
  const SEG = 7, CARDS = 24;
  const pos = [], hair = [], hair2 = [], uv = [], idx = [];
  let rs = 11;
  const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647);
  for (let a = 0; a < anchors.length - 1; a++) {
    const u = a / (anchors.length - 1);
    for (let c = 0; c < CARDS; c++) {
      const len = (0.26 + 0.2 * Math.sin(u * Math.PI) + 0.12 * rnd()) * (0.8 + 0.4 * rnd());
      const seed = rnd(), side = rnd() < 0.5 ? 1 : -1, width = 0.011 + 0.013 * rnd();
      const base = pos.length / 3, sideAmt = side * (0.05 + 0.5 * rnd() * rnd());
      for (let k = 0; k <= SEG; k++) {
        const s = k / SEG;
        for (const ac of [-1, 1]) {
          pos.push(0, 0, 0);
          hair.push(anchors[a], anchors[a + 1], s, ac);
          hair2.push(len, seed, sideAmt, width);
          uv.push(ac * 0.5 + 0.5, s);
        }
      }
      for (let k = 0; k < SEG; k++) { const o = base + k * 2; idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aHair', new THREE.Float32BufferAttribute(hair, 4));
  geo.setAttribute('aHair2', new THREE.Float32BufferAttribute(hair2, 4));
  geo.setIndex(idx);
  geo.boundingSphere = asset.geometry.boundingSphere;

  const tex = strandTexture();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a211c, alphaMap: tex, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.62, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, asset.uniforms);
    sh.uniforms.uTime = timeUniform;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${vatGLSL(asset)}
        attribute float aPhase; attribute vec3 aTint; varying vec3 vTint;
        attribute vec4 aHair; attribute vec4 aHair2;
        uniform float uTime;
        vec3 hTb, hUp, hSd, hairP;
        // 发丝中心线：发根沿法线竖起，随即被迎面风压向后方（沿颈脊指向马肩），叠加风中抖动与步伐起伏
        vec3 hairAt(float s) {
          float seed = aHair2.y, ss = aHair2.z;
          float tw = uTime * 10.0 + seed * 40.0;
          vec3 f = hUp * (0.2 * s - 0.3 * s * s) + hSd * ss * (0.25 * s + 0.35 * s * s) + hTb * 0.96 * pow(s, 1.08);
          f += hUp * sin(tw - s * 5.0) * 0.05 * s * s + hSd * cos(tw * 0.83 - s * 4.0) * 0.06 * s;
          f += hUp * 0.07 * s * sin(6.2832 * aPhase - s * 1.8 + 1.0);
          return f * aHair2.x;
        }`)
      .replace('#include <beginnormal_vertex>', `
        vec3 hr0, hn0, hr1, hn1;
        vatSample(int(aHair.x + 0.5), aPhase, hr0, hn0);
        vatSample(int(aHair.y + 0.5), aPhase, hr1, hn1);
        hTb = normalize(hr1 - hr0);
        hUp = normalize(hn0 + vec3(0.0, 0.6, 0.0));
        hSd = normalize(cross(hTb, hUp));
        float hs = aHair.z;
        vec3 hc = hairAt(hs);
        vec3 hd = normalize(hairAt(hs + 0.08) - hc);
        vec3 wdir = normalize(mix(hSd, hUp, step(0.7, fract(aHair2.y * 7.31)) * 0.7));
        wdir = normalize(wdir - hd * dot(wdir, hd));
        hairP = hr0 + hTb * (fract(aHair2.y * 3.7) - 0.5) * 0.03 - hUp * 0.012 + hc + wdir * aHair.w * aHair2.w * (1.0 - 0.45 * hs);
        vec3 objectNormal = normalize(cross(wdir, hd));
        if (dot(objectNormal, hUp) < 0.0) objectNormal = -objectNormal;
        objectNormal = normalize(objectNormal + hUp * 1.5); // 统一朝上的法线，避免发片各自反光闪烁
        vTint = aTint;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = hairP;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n varying vec3 vTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb *= mix(vec3(0.55), vTint, 0.6) * 0.7;')
      // 逆光时发丝透光：朝向太阳看过去，鬃毛边缘泛金
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #if NUM_DIR_LIGHTS > 0
          float hBack = pow(max(dot(-normalize(vViewPosition), directionalLights[0].direction), 0.0), 2.5);
          totalEmissiveRadiance += vec3(0.42, 0.32, 0.2) * directionalLights[0].color * 0.05 * hBack;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'mane';
  markMover(mat);
  const mesh = herd.addLayer(geo, mat, { shadow: false });
  mesh.name = 'mane';
  return mesh;
}
