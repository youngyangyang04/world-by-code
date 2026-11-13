import * as THREE from 'three';

// 程序化 PBR 贴图：札甲（铁甲片）、皮革、锻铁、旗面织物。
// 全部由高度场生成法线贴图，因此在掠射的夕阳下甲片有真实的明暗起伏。

function canvasTex(w, h, pixels, srgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.putImageData(new ImageData(pixels, w, h), 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

function heightToNormal(H, w, h, strength) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xl = H[y * w + ((x - 1 + w) % w)], xr = H[y * w + ((x + 1) % w)];
    const yu = H[((y - 1 + h) % h) * w + x], yd = H[((y + 1) % h) * w + x];
    let nx = (xl - xr) * strength, ny = (yd - yu) * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const o = (y * w + x) * 4;
    out[o] = (nx / l * 0.5 + 0.5) * 255; out[o + 1] = (ny / l * 0.5 + 0.5) * 255; out[o + 2] = (nz / l * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
  return out;
}

function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 4) { let s = 0, a = 0.5; for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); x *= 2.03; y *= 2.03; a *= 0.5; } return s; }
// 可平铺噪声（周期 p）
function tnoise(x, y, p) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const m = (n) => ((n % p) + p) % p;
  const a = hash2(m(xi), m(yi)), b = hash2(m(xi + 1), m(yi)), c = hash2(m(xi), m(yi + 1)), d = hash2(m(xi + 1), m(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// 札甲：成排的长条铁甲片，上排压下排，左右叠压，甲片上端有穿绳孔与皮绳
function lamellar({ cols = 8, rows = 6, tint = [0.36, 0.35, 0.34], lace = [0.33, 0.08, 0.05] } = {}) {
  const W = 512, Hh = 512;
  const H = new Float32Array(W * Hh), col = new Uint8ClampedArray(W * Hh * 4), orm = new Uint8ClampedArray(W * Hh * 4);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const v = (y / Hh) * rows, row = Math.floor(v), fy = v - row; // fy: 0 顶 → 1 底
    const u = (x / W) * cols + (row % 2) * 0.5, ci = Math.floor(u), fx = u - ci;
    const id = hash2(((ci % cols) + cols) % cols + 3.1, row + 7.7);
    // 甲片横截面：微拱 + 左压右的台阶
    const cx = fx - 0.5;
    let h = 0.55 + 0.25 * (1 - 4 * cx * cx) + 0.12 * (fx);
    // 纵向：下端外翘（压在下一排之上），底边圆角
    const bottom = 1 - fy;
    const round = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(cx) * 2, 2.6)));
    const edge = Math.min(1, bottom / (0.1 + 0.1 * (1 - round)));
    h = (h + 0.55 * fy) * (0.35 + 0.65 * Math.min(1, edge * 1.4));
    // 甲片间缝
    const gap = Math.min(fx, 1 - fx) < 0.035 ? 0.55 : 1;
    h *= gap;
    // 穿绳孔与皮绳（上端两孔 + 中部一道横向编绳）
    const hx = Math.abs(Math.abs(cx) - 0.2), hy = Math.abs(fy - 0.2);
    const hole = hx < 0.055 && hy < 0.045;
    const laceBand = Math.abs(fy - 0.2) < 0.03 && Math.abs(cx) < 0.26;
    if (laceBand) h += 0.2;
    if (hole) h -= 0.12;
    h += (id - 0.5) * 0.12; // 每片略有高低
    const wear = tnoise((x / W) * 16, (y / Hh) * 16, 16) * 0.6 + tnoise((x / W) * 64, (y / Hh) * 64, 64) * 0.4;
    H[y * W + x] = h + wear * 0.03;
    const o = (y * W + x) * 4;
    // 颜色：铁色，缝隙积尘发暗，边缘磨亮，少量锈迹
    const shade = (0.72 + 0.4 * id) * (gap < 1 ? 0.35 : 1) * (0.55 + 0.45 * Math.min(1, edge * 2));
    const rust = Math.max(0, wear - 0.62) * 2.2;
    let r = tint[0] * shade, g = tint[1] * shade, b = tint[2] * shade;
    r += rust * 0.2; g += rust * 0.07; b -= rust * 0.02;
    const bright = fy > 0.82 && gap === 1 ? 0.14 : 0;
    r += bright; g += bright; b += bright;
    let metal = 1, rough = 0.34 + 0.28 * wear + rust * 0.35 + (gap < 1 ? 0.4 : 0);
    if (laceBand || hole) { r = lace[0] * (0.7 + 0.5 * wear); g = lace[1] * (0.7 + 0.5 * wear); b = lace[2] * (0.7 + 0.5 * wear); metal = 0; rough = 0.85; }
    col[o] = r * 255; col[o + 1] = g * 255; col[o + 2] = b * 255; col[o + 3] = 255;
    const ao = 0.55 + 0.45 * Math.min(1, edge * 1.6) * (gap < 1 ? 0.5 : 1);
    orm[o] = ao * 255; orm[o + 1] = Math.min(1, rough) * 255; orm[o + 2] = metal * 255; orm[o + 3] = 255;
  }
  return { map: canvasTex(W, Hh, col, true), normalMap: canvasTex(W, Hh, heightToNormal(H, W, Hh, 7.0), false), orm: canvasTex(W, Hh, orm, false) };
}

// 锻铁（头盔、护臂、槊刃）：锤痕 + 划痕
function forgedIron() {
  const W = 256, H = new Float32Array(W * W), orm = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const n = tnoise(x / 16, y / 16, 16) * 0.6 + tnoise(x / 5, y / 5, 51) * 0.25 + tnoise(x / 2, y / 40, 6) * 0.3;
    H[y * W + x] = n;
    const o = (y * W + x) * 4;
    orm[o] = 255; orm[o + 1] = (0.3 + 0.35 * n) * 255; orm[o + 2] = 255; orm[o + 3] = 255;
  }
  return { normalMap: canvasTex(W, W, heightToNormal(H, W, W, 1.6), false), orm: canvasTex(W, W, orm, false) };
}

function leather() {
  const W = 256, H = new Float32Array(W * W), col = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const n = tnoise(x / 3, y / 3, 85) * 0.5 + tnoise(x / 9, y / 9, 28) * 0.5;
    const crack = Math.pow(Math.abs(tnoise(x / 14, y / 14, 18) - 0.5) * 2, 0.4);
    H[y * W + x] = n * 0.6 + crack * 0.5;
    const o = (y * W + x) * 4, s = 0.6 + 0.5 * n * crack;
    col[o] = 150 * s; col[o + 1] = 96 * s; col[o + 2] = 60 * s; col[o + 3] = 255;
  }
  return { map: canvasTex(W, W, col, true), normalMap: canvasTex(W, W, heightToNormal(H, W, W, 2.2), false) };
}

// 旗面：朱红底、黑色上下镶边，正中金色「唐」字。旗面是单层双面的，背面在着色器里把 u 翻转，所以两面看到的字都是正的。
function bannerCloth(base = '#8f1b12', trim = '#17100c', gold = '#e2bb62') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 512);
  g.fillStyle = trim; g.fillRect(0, 0, 512, 30); g.fillRect(0, 482, 512, 30);
  g.fillStyle = gold; g.fillRect(0, 30, 512, 5); g.fillRect(0, 477, 512, 5);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 330px "Kaiti SC", "STKaiti", "KaiTi", "Songti SC", "SimSun", "Noto Serif CJK SC", serif';
  // 画布 512 宽对应旗面 1.55m、512 高对应 0.95m：横向要压扁 0.61 倍，贴到旗上字才是正方的
  g.save(); g.translate(256, 262); g.scale(0.61, 1);
  g.lineJoin = 'round'; g.strokeStyle = 'rgba(20,10,6,0.85)'; g.lineWidth = 16; g.strokeText('唐', 0, 0);
  g.fillStyle = gold; g.fillText('唐', 0, 0);
  g.restore();
  // 织物经纬 + 风化褪色
  const img = g.getImageData(0, 0, 512, 512), d = img.data;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const o = (y * 512 + x) * 4;
    const weave = 0.9 + 0.1 * ((x % 3 === 0 ? 1 : 0) + (y % 3 === 0 ? 1 : 0)) * 0.5;
    const fade = 0.8 + 0.28 * fbm(x / 90, y / 90);
    d[o] *= weave * fade; d[o + 1] *= weave * fade; d[o + 2] *= weave * fade;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function createMaterialLibrary() {
  const lam = lamellar();
  const lamDark = lamellar({ tint: [0.2, 0.19, 0.19], lace: [0.4, 0.1, 0.05] });
  const iron = forgedIron();
  const lth = leather();
  const mk = (p) => new THREE.MeshStandardMaterial(p);
  const lib = {
    // 骑兵身甲（札甲）
    lamellar: mk({ map: lam.map, normalMap: lam.normalMap, roughnessMap: lam.orm, metalnessMap: lam.orm, aoMap: lam.orm, metalness: 1, roughness: 1, envMapIntensity: 1.25 }),
    // 马甲（具装）：颜色更深
    barding: mk({ map: lamDark.map, normalMap: lamDark.normalMap, roughnessMap: lamDark.orm, metalnessMap: lamDark.orm, metalness: 1, roughness: 1, envMapIntensity: 1.2, side: THREE.DoubleSide }),
    iron: mk({ color: 0x6f6d6a, normalMap: iron.normalMap, roughnessMap: iron.orm, metalness: 1, roughness: 1, envMapIntensity: 1.3 }),
    steel: mk({ color: 0xa9a7a2, normalMap: iron.normalMap, roughnessMap: iron.orm, metalness: 1, roughness: 0.7, envMapIntensity: 1.5 }),
    bronze: mk({ color: 0xa87a3a, normalMap: iron.normalMap, roughnessMap: iron.orm, metalness: 1, roughness: 0.9 }),
    leather: mk({ map: lth.map, normalMap: lth.normalMap, roughness: 0.72, metalness: 0 }),
    leatherDark: mk({ map: lth.map, color: 0x6a5648, normalMap: lth.normalMap, roughness: 0.66, metalness: 0 }),
    cloth: mk({ color: 0x4d130e, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
    clothDark: mk({ color: 0x2a2320, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
    wood: mk({ color: 0x3a2416, roughness: 0.55, metalness: 0 }),
    tassel: mk({ color: 0xa3160f, roughness: 0.9, metalness: 0 }),
    skin: mk({ color: 0x9c6b4c, roughness: 0.65, metalness: 0 }),
  };
  lib.bannerTex = bannerCloth();
  lib.dispose = () => {
    for (const k in lib) {
      const m = lib[k];
      if (m?.isMaterial) { for (const t of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) m[t]?.dispose(); m.dispose(); }
    }
    lib.bannerTex.dispose();
  };
  return lib;
}
