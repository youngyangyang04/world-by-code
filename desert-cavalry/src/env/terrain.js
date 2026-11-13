import * as THREE from 'three';
import { HEIGHT_GLSL } from './heightfield.js';
import { NOISE_GLSL } from './atmosphere.js';

// 跟随玩家的大地网格：中心密、边缘疏的非均匀栅格，高度在顶点着色器里由 terrainHeight 计算。
// 贴图使用世界坐标 UV + 两种尺度混合 + 两套 PBR 材质（细沙 / 砾石戈壁）按噪声遮罩混合，消除平铺感。
export function createTerrain(tex) {
  const N = 300;
  const R = 5200;
  const geo = new THREE.PlaneGeometry(2, 2, N, N);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i), v = p.getZ(i);
    const r = Math.max(Math.abs(u), Math.abs(v));
    const k = r > 0 ? (Math.pow(r, 2.6) * R) / r : 0;
    p.setXYZ(i, u * k, 0, v * k);
  }
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 2);

  const uniforms = {
    uOrigin: { value: new THREE.Vector2() },
    tSandD: { value: tex.sandD }, tSandN: { value: tex.sandN }, tSandR: { value: tex.sandR },
    tGravD: { value: tex.gravD }, tGravN: { value: tex.gravN }, tGravR: { value: tex.gravR },
  };

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uOrigin;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        ${HEIGHT_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec2 wxz = position.xz + uOrigin;
        vec3 objectNormal = terrainNormal(wxz);
        vWNormal = objectNormal;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(wxz.x, terrainHeight(wxz), wxz.y);
        vWPos = transformed;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tSandD; uniform sampler2D tSandN; uniform sampler2D tSandR;
        uniform sampler2D tGravD; uniform sampler2D tGravN; uniform sampler2D tGravR;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        ${NOISE_GLSL}
        vec3 gNrm; float gRough;
        `)
      .replace('#include <map_fragment>', `
        vec2 wp = vWPos.xz;
        float camD = length(vViewPosition);
        // 近景用小尺度贴图，远景过渡到大尺度，避免远处出现重复花纹
        vec2 uvA = wp * 0.36, uvB = wp * 0.047 + 3.7;
        float farMix = smoothstep(14.0, 70.0, camD);
        // 细沙 / 砾石遮罩：低频噪声 + 走廊内更多砾石
        float m = fbm(wp * 0.021 + 11.0) * 0.75 + vnoise(wp * 0.23) * 0.25;
        float grav = smoothstep(0.42, 0.62, m) * (1.0 - smoothstep(120.0, 380.0, abs(wp.x)) * 0.85);
        vec3 sD = mix(texture2D(tSandD, uvA).rgb, texture2D(tSandD, uvB).rgb, farMix);
        vec3 gD = mix(texture2D(tGravD, uvA * 0.8).rgb, texture2D(tGravD, uvB * 1.3).rgb, farMix);
        vec3 sN = mix(texture2D(tSandN, uvA).xyz, texture2D(tSandN, uvB).xyz, farMix) * 2.0 - 1.0;
        vec3 gN = mix(texture2D(tGravN, uvA * 0.8).xyz, texture2D(tGravN, uvB * 1.3).xyz, farMix) * 2.0 - 1.0;
        float sR = mix(texture2D(tSandR, uvA).g, texture2D(tSandR, uvB).g, farMix);
        float gR = mix(texture2D(tGravR, uvA * 0.8).g, texture2D(tGravR, uvB * 1.3).g, farMix);
        vec3 albedo = mix(sD, gD, grav);
        gNrm = normalize(mix(sN, gN, grav));
        gRough = mix(sR, gR, grav);
        // 统一成河西戈壁的土黄色调 + 大尺度明暗/色相变化
        float lum = dot(albedo, vec3(0.3, 0.55, 0.15));
        vec3 tint = mix(vec3(0.86, 0.62, 0.36), vec3(0.7, 0.53, 0.36), grav);
        albedo = mix(albedo, tint * (0.35 + lum * 1.25), 0.72);
        float macro = fbm(wp * 0.006 + 31.0);
        albedo *= 0.62 + 0.42 * macro;
        albedo = mix(albedo, albedo * vec3(1.08, 0.94, 0.8), smoothstep(0.35, 0.75, fbm(wp * 0.0023)));
        // 风吹沙纹（沙丘上明显）
        float duneK = smoothstep(100.0, 400.0, abs(wp.x));
        float ripple = sin((wp.x * 0.8 + wp.y * 0.35) * 9.0 + 4.0 * vnoise(wp * 0.35));
        gNrm.xy += vec2(0.8, 0.35) * ripple * 0.1 * duneK * (1.0 - farMix);
        diffuseColor.rgb *= albedo;
        `)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = clamp(gRough * 1.1, 0.86, 1.0);`)
      .replace('#include <normal_fragment_maps>', `
        {
          vec3 Nw = normalize(vWNormal);
          vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
          vec3 Bw = cross(Tw, Nw); // 指向 -Z
          vec3 n = normalize(vec3(gNrm.xy * 1.25, gNrm.z));
          vec3 nw = normalize(Tw * n.x - Bw * n.y + Nw * n.z);
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = 'terrain';
  mesh.userData.setOrigin = (x, z) => uniforms.uOrigin.value.set(Math.round(x), Math.round(z));
  return mesh;
}

// 远处连绵的荒山：多层山脊环带，随玩家平移（视差可忽略），靠距离雾分出层次。
export function createMountains(rockTex) {
  const group = new THREE.Group();
  group.name = 'mountains';
  const layers = [
    { r: 3300, h: 330, seed: 1.3, col: 0x86633f },
    { r: 4500, h: 620, seed: 4.1, col: 0x7a5a3d },
    { r: 6200, h: 1050, seed: 8.7, col: 0x6c523d },
  ];
  const n1 = (x, s) => {
    let v = 0, a = 1, f = 1, t = 0;
    for (let o = 0; o < 6; o++) {
      v += a * Math.abs(Math.sin(x * f + s * (o + 1) * 1.7) * Math.cos(x * f * 0.63 + s * 2.3 + o));
      t += a; a *= 0.52; f *= 2.07;
    }
    return v / t;
  };
  for (const L of layers) {
    const SEG = 420, ROWS = 10;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const ridge = Math.pow(n1(a * 5.0, L.seed), 1.25);
      // 正前方留出走廊开口（河西走廊：两山夹一川）
      const fwd = Math.cos(a);
      const H = L.h * (0.25 + ridge) * (0.3 + 0.7 * (1 - Math.pow(Math.abs(fwd), 4)));
      for (let j = 0; j <= ROWS; j++) {
        const t = j / ROWS;
        const rr = L.r * (1 - 0.3 * (1 - t)) + (1 - t) * 60 * Math.sin(a * 37 + j);
        const prof = Math.pow(t, 1.35);
        const y = H * prof * (1 + 0.12 * Math.sin(a * 91 + j * 1.7) * (1 - t)) - 40;
        pos.push(Math.sin(a) * rr, y, -Math.cos(a) * rr);
        uv.push((a * L.r) / 420, (t * H) / 300);
      }
    }
    for (let i = 0; i < SEG; i++) for (let j = 0; j < ROWS; j++) {
      const a = i * (ROWS + 1) + j, b = a + ROWS + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({
      color: L.col, map: rockTex?.d ?? null, normalMap: rockTex?.n ?? null,
      roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    });
    if (m.normalMap) m.normalScale.set(2.5, 2.5);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

// 碎石：InstancedMesh，位置在顶点着色器里围绕玩家取模循环，无需每帧更新矩阵。
export function createPebbles(rockTex) {
  const COUNT = 2600, BOX = 90;
  const base = new THREE.IcosahedronGeometry(1, 1);
  const bp = base.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
    const k = 1 + 0.28 * Math.sin(x * 5.1 + y * 3.3) * Math.cos(z * 4.7 + x * 2.1);
    bp.setXYZ(i, x * k, y * k * 0.62, z * k);
  }
  base.computeVertexNormals();
  const geo = new THREE.InstancedBufferGeometry().copy(base);
  const off = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    off[i * 4] = Math.random() * BOX;
    off[i * 4 + 1] = Math.random() * BOX;
    const r = Math.random();
    off[i * 4 + 2] = 0.012 + 0.06 * r * r * r + (Math.random() < 0.008 ? 0.1 : 0);
    off[i * 4 + 3] = Math.random() * 6.283;
  }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  geo.instanceCount = COUNT;
  const uniforms = { uOrigin: { value: new THREE.Vector2() } };
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9ab86, map: rockTex?.d ?? null, roughness: 0.92 });
  const inject = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aOff; uniform vec2 uOrigin;
        ${HEIGHT_GLSL}
        vec3 pebbleRot(vec3 v) { float c = cos(aOff.w), s = sin(aOff.w); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }`)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = pebbleRot(normal);`)
      .replace('#include <begin_vertex>', `
        vec2 cxz = mod(aOff.xy - uOrigin, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)} + uOrigin;
        float edge = 1.0 - smoothstep(${(BOX * 0.4).toFixed(1)}, ${(BOX * 0.5).toFixed(1)}, max(abs(cxz.x - uOrigin.x), abs(cxz.y - uOrigin.y)));
        vec3 transformed = pebbleRot(position) * aOff.z * edge + vec3(cxz.x, terrainHeight(cxz) + aOff.z * 0.18, cxz.y);`);
  };
  mat.onBeforeCompile = inject;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'pebbles';
  mesh.userData.setOrigin = (x, z) => uniforms.uOrigin.value.set(x, z);
  return mesh;
}
