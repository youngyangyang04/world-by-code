import * as THREE from 'three';

// 大气参数：天空、距离雾、沙尘粒子共用同一组颜色，保证远景与天空自然融合。
export const atmosphere = {
  // 冲锋方向为 -Z。太阳在左前方低空（夕阳），逆光照亮沙尘。
  sunDir: new THREE.Vector3(-0.62, 0.17, -0.77).normalize(),
  sunColor: new THREE.Color(1.0, 0.56, 0.24),
  sunIntensity: 5.2,
  zenith: new THREE.Color(0.2, 0.3, 0.46),
  horizon: new THREE.Color(0.95, 0.62, 0.32),
  haze: new THREE.Color(0.8, 0.56, 0.33),      // 背光方向的尘霾色
  hazeSun: new THREE.Color(1.22, 0.68, 0.28),   // 朝向太阳的散射色
  fogDensity: 0.00085,
  fogHeightFalloff: 0.012,
};

export const atmosphereUniforms = {
  uSunDir: { value: atmosphere.sunDir },
  uSunColor: { value: atmosphere.sunColor },
  uZenith: { value: atmosphere.zenith },
  uHorizon: { value: atmosphere.horizon },
  uHaze: { value: atmosphere.haze },
  uHazeSun: { value: atmosphere.hazeSun },
  uFogDensity: { value: atmosphere.fogDensity },
  uFogFalloff: { value: atmosphere.fogHeightFalloff },
  uDustAmount: { value: 1.0 },
  uTime: { value: 0 },
};

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uHazeSun;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uDustAmount;

// 沿视线方向的尘霾内散射颜色（朝向太阳时更亮更金）
vec3 hazeColor(vec3 dir) {
  float c = max(dot(dir, uSunDir), 0.0);
  float mie = pow(c, 6.0) * 0.75 + pow(c, 48.0) * 1.6;
  return mix(uHaze, uHazeSun, clamp(mie, 0.0, 1.0)) * (1.0 + mie * 0.6);
}
// 指数高度雾：ro 相机位置，dir 视线方向，dist 距离
float fogAmount(vec3 ro, vec3 dir, float dist) {
  float dens = uFogDensity * (0.35 + 0.65 * uDustAmount);
  float k = uFogFalloff;
  float dy = dir.y;
  float a = exp(-k * max(ro.y, 0.0));
  float integral = abs(dy) > 1e-4 ? (1.0 - exp(-k * dy * dist)) / (k * dy) : dist;
  return 1.0 - exp(-dens * a * max(integral, 0.0));
}
`;

const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
`;
export { NOISE_GLSL };

// 程序化夕阳天空：天顶—地平线渐变、日轮与光晕、高空卷云、地平线滚动沙尘云。
export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: atmosphereUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform float uTime;
      ${ATMOSPHERE_GLSL}
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float y = max(d.y, 0.0);
        float cs = max(dot(d, uSunDir), 0.0);
        // 基础渐变
        vec3 col = mix(uHorizon, uZenith, pow(y, 0.42));
        // 太阳一侧的天空整体偏暖偏亮
        col += uSunColor * (pow(cs, 3.0) * 0.5 + pow(cs, 14.0) * 0.9) * (1.0 - y * 0.6);
        // 高空卷云（被夕阳染成金红）
        if (d.y > 0.02) {
          vec2 cp = d.xz / (d.y + 0.12) * 1.4;
          float c1 = fbm(cp * vec2(0.55, 1.5) + vec2(uTime * 0.004, 0.0));
          float c2 = fbm(cp * 2.3 + 7.0 + vec2(uTime * 0.006, 0.0));
          float cloud = smoothstep(0.5, 0.86, c1 * 0.75 + c2 * 0.4) * smoothstep(0.02, 0.2, d.y);
          vec3 cloudCol = mix(vec3(0.48, 0.33, 0.3), uSunColor * 1.9 + vec3(0.25, 0.1, 0.03), pow(cs, 2.0) * 0.8 + 0.18);
          col = mix(col, cloudCol, cloud * 0.6);
        }
        // 地平线尘霾带 + 远处翻滚的沙尘云
        vec3 hz = hazeColor(d);
        float band = exp(-y * 9.0);
        float az = atan(d.x, -d.z);
        float wall = fbm(vec2(az * 5.0 + uTime * 0.01, y * 22.0 - uTime * 0.012));
        float wall2 = fbm(vec2(az * 13.0 - uTime * 0.016, y * 48.0));
        float dustWall = smoothstep(0.16 + 0.1 * wall2, 0.0, y - wall * 0.12) * (0.55 + 0.45 * uDustAmount);
        vec3 wallCol = hz * (0.62 + 0.5 * wall2);
        col = mix(col, hz, band * 0.9);
        col = mix(col, wallCol, dustWall * 0.85);
        // 日轮（被尘霾柔化）
        float disc = smoothstep(0.99955, 0.99985, cs);
        col += uSunColor * disc * 26.0 * smoothstep(-0.01, 0.06, d.y);
        col += uSunColor * pow(cs, 900.0) * 3.0;
        // 地平线以下
        col = mix(col, uHaze * 0.55, smoothstep(0.0, -0.06, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}

// 由天空生成 PBR 环境贴图（铁甲的反射 / 环境光来自这片夕阳天空）
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  const sky = createSky();
  sky.scale.setScalar(50);
  s.add(sky);
  // 地面反射光：一块暖色大地
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(60, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.29, 0.17) }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  s.add(ground);
  const rt = pmrem.fromScene(s, 0.02, 0.1, 200);
  pmrem.dispose();
  sky.geometry.dispose();
  ground.geometry.dispose();
  ground.material.dispose();
  return rt.texture;
}

export function createSunLight() {
  const sun = new THREE.DirectionalLight(atmosphere.sunColor, atmosphere.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const c = sun.shadow.camera;
  c.left = -46; c.right = 46; c.top = 46; c.bottom = -46; c.near = 1; c.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2.5;
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.62, 0.66, 0.82), new THREE.Color(0.72, 0.5, 0.3), 1.25);
  const _snap = new THREE.Vector3();
  function follow(target) {
    // 阴影相机跟随玩家，并按纹素对齐，避免阴影边缘游动
    _snap.copy(target);
    sun.target.position.copy(_snap);
    sun.position.copy(_snap).addScaledVector(atmosphere.sunDir, 200);
    sun.target.updateMatrixWorld();
  }
  return { sun, hemi, follow };
}
