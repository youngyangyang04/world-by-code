// 地形高度函数 —— JS 与 GLSL 两份实现必须保持逐项一致：
// JS 版供马蹄落点 / 骑兵贴地使用，GLSL 版供地形顶点位移和沙尘贴地使用。
// 冲锋走廊（|x| < 90m）是平缓的戈壁滩，两侧逐渐隆起为沙丘。

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function terrainHeight(x, z) {
  let h = 1.1 * Math.sin(x * 0.0113 + 1.3) * Math.cos(z * 0.0097 + 0.4);
  h += 0.45 * Math.sin(x * 0.033 - z * 0.027 + 2.1);
  h += 0.1 * Math.sin(x * 0.21 + z * 0.13) * Math.sin(z * 0.17 - x * 0.09 + 1.0);
  const side = smoothstep(90, 420, Math.abs(x));
  const a = x * 0.0105 + z * 0.0042 + 1.7 * Math.sin(z * 0.0031 + x * 0.0017);
  const ridge = 1 - Math.abs(Math.sin(a));
  const d = Math.pow(ridge, 1.6) * (0.6 + 0.4 * Math.sin(x * 0.004 - z * 0.006 + 0.5));
  return h + side * 22 * d;
}

export const HEIGHT_GLSL = /* glsl */ `
float terrainHeight(vec2 p) {
  float x = p.x, z = p.y;
  float h = 1.1 * sin(x * 0.0113 + 1.3) * cos(z * 0.0097 + 0.4);
  h += 0.45 * sin(x * 0.033 - z * 0.027 + 2.1);
  h += 0.1 * sin(x * 0.21 + z * 0.13) * sin(z * 0.17 - x * 0.09 + 1.0);
  float side = smoothstep(90.0, 420.0, abs(x));
  float a = x * 0.0105 + z * 0.0042 + 1.7 * sin(z * 0.0031 + x * 0.0017);
  float ridge = 1.0 - abs(sin(a));
  float d = pow(ridge, 1.6) * (0.6 + 0.4 * sin(x * 0.004 - z * 0.006 + 0.5));
  return h + side * 22.0 * d;
}
vec3 terrainNormal(vec2 p) {
  float e = 0.35;
  float hx = terrainHeight(p + vec2(e, 0.0)) - terrainHeight(p - vec2(e, 0.0));
  float hz = terrainHeight(p + vec2(0.0, e)) - terrainHeight(p - vec2(0.0, e));
  return normalize(vec3(-hx, 2.0 * e, -hz));
}
`;
