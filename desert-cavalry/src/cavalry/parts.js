import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// 骑手与鞍具的程序化建模（唐代西域重甲骑兵的概括造型：兜鍪 + 顿项、明光铠护心镜、披膊、札甲腿裙、长槊）。
// 说明：没有找到授权允许、可直接下载的写实唐甲骑兵模型，所以这里全部是程序化几何体 + 程序化 PBR 贴图。
// 这是“过渡版”骑手：曲面建模、带札甲法线贴图，但不是雕刻级角色模型 —— 详见 README「占位与待替换」。
//
// 坐标约定：全部在战马“参考姿态”坐标系中建模（鞍座顶面约在 (0, 1.59, 0)，前进方向 -Z，右侧 +X）。
//   seat  刚体：随马背挂点运动（鞍、鞯、镫、腿）
//   torso 刚体：绕骨盆枢轴前倾 / 起伏（胸甲、披膊、腰带）
//   head  刚体：绕颈部枢轴转动（兜鍪、顿项、面部）
//   手臂为两段骨骼（沿 +Y 建模），由 IK 求解；槊沿 +Y 建模，握持点在原点。
// ---------------------------------------------------------------------------

export const RIG = {
  barrelC: new THREE.Vector3(0, 1.27, 0), barrelR: 0.33,
  pelvis: new THREE.Vector3(0, 1.7, 0.03),
  neck: new THREE.Vector3(0, 2.25, 0.03),
  eye: new THREE.Vector3(0, 2.41, -0.07),
  shoulderR: new THREE.Vector3(0.215, 2.15, 0.03),
  shoulderL: new THREE.Vector3(-0.215, 2.15, 0.03),
  upperArm: 0.3, foreArm: 0.27, wrist: 0.06,
  lanceGrip: 1.35,   // 握持点到槊尾的距离
  lanceLen: 4.3,
  bitR: new THREE.Vector3(0.062, 1.585, -1.6), bitL: new THREE.Vector3(-0.062, 1.585, -1.6),
};

const V2 = (r, y) => new THREE.Vector2(r, y);
const Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

function prep(g) {
  // 统一成非索引 + position/normal/uv，便于合并
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
  return n;
}
const merge = (list) => mergeGeometries(list.map(prep), false);
const lathe = (pts, seg = 24, phi0 = 0, phiL = Math.PI * 2) => new THREE.LatheGeometry(pts.map((p) => V2(p[0], p[1])), seg, phi0, phiL);
function uvScale(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}
// 把沿 +Y（从原点起）建模的几何体摆放到 a→b
function place(g, a, b) {
  const d = new THREE.Vector3().subVectors(b, a).normalize();
  _q.setFromUnitVectors(Y, d);
  g.applyQuaternion(_q);
  g.translate(a.x, a.y, a.z);
  return g;
}
// 沿 +Y 的锥形胶囊：r0（底）→ r1（顶），长度 len，两端半球
function limb(r0, r1, len, seg = 14) {
  const pts = [];
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; pts.push([Math.sin(a) * r0, -Math.cos(a) * r0 * 0.6]); }
  for (let i = 1; i < 6; i++) { const t = i / 6; pts.push([r0 + (r1 - r0) * t, len * t]); }
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; pts.push([Math.cos(a) * r1, len + Math.sin(a) * r1 * 0.6]); }
  return lathe(pts, seg);
}
function mirrorX(g) {
  const m = g.clone();
  m.scale(-1, 1, 1);
  // 镜像后翻转绕序
  const p = m.index ? m.toNonIndexed() : m;
  const pos = p.attributes.position, nor = p.attributes.normal, uv = p.attributes.uv;
  for (let i = 0; i < pos.count; i += 3) {
    for (const a of [pos, nor, uv]) {
      if (!a) continue;
      const n = a.itemSize, arr = a.array, i1 = (i + 1) * n, i2 = (i + 2) * n;
      for (let k = 0; k < n; k++) { const t = arr[i1 + k]; arr[i1 + k] = arr[i2 + k]; arr[i2 + k] = t; }
    }
  }
  return p;
}
const both = (g) => [g, mirrorX(g)];
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

export function buildParts(lib) {
  const P = {};
  const C = RIG.barrelC, R = RIG.barrelR;

  // ============================ seat 刚体 ============================
  // 马背上的半筒形曲面片（绕 Z 轴）
  const backShell = (r, halfAngle, z0, z1, seg = 20) => {
    const g = new THREE.CylinderGeometry(r, r, z1 - z0, seg, 4, true, Math.PI - halfAngle, halfAngle * 2);
    g.rotateX(Math.PI / 2);
    g.translate(C.x, C.y, (z0 + z1) / 2);
    return g;
  };
  // 鞍鞯 / 障泥（织物，垂到马腹两侧）
  const cloth = backShell(R + 0.014, 1.5, -0.42, 0.5, 26);
  const clothTrim = backShell(R + 0.018, 1.56, 0.5, 0.535, 26);
  const clothTrim2 = backShell(R + 0.018, 1.56, -0.455, -0.42, 26);
  // 鞍座 + 前后鞍桥（唐式高桥鞍）+ 镫革 + 靴
  const seat = backShell(R + 0.04, 1.05, -0.27, 0.3, 18);
  const pommel = new THREE.TorusGeometry(0.165, 0.036, 8, 18, Math.PI); pommel.scale(1, 1.05, 1); pommel.translate(0, 1.565, -0.275);
  const cantle = new THREE.TorusGeometry(0.175, 0.038, 8, 18, Math.PI); cantle.scale(1, 0.8, 1); cantle.rotateX(-0.55); cantle.translate(0, 1.54, 0.29);
  const hip = v3(0.125, 1.7, 0.03), knee = v3(0.375, 1.42, -0.3), ankle = v3(0.41, 0.99, -0.17), toe = v3(0.46, 0.94, -0.42);
  const strapTop = v3(0.34, 1.5, -0.1), strapBot = v3(0.415, 1.0, -0.2);
  const strap = place(new THREE.BoxGeometry(0.035, strapTop.distanceTo(strapBot), 0.008).translate(0, strapTop.distanceTo(strapBot) / 2, 0), strapTop, strapBot);
  const shin = place(limb(0.07, 0.05, knee.distanceTo(ankle)), knee, ankle);
  const foot = place(limb(0.05, 0.042, 0.2, 10).scale(1, 1, 0.8), v3(0.41, 0.965, -0.14), toe);
  const kneeCap = new THREE.SphereGeometry(0.078, 12, 8).translate(knee.x, knee.y, knee.z);
  P.seatLeather = { geo: merge([seat, pommel, cantle, clothTrim, clothTrim2, ...both(strap)]), mat: lib.leather, frame: 'seat' };
  P.seatBoots = { geo: merge([...both(shin), ...both(foot), ...both(kneeCap)]), mat: lib.leatherDark, frame: 'seat' };
  P.seatCloth = { geo: merge([cloth]), mat: lib.cloth, frame: 'seat' };
  // 马镫（铁）
  const stir = new THREE.TorusGeometry(0.062, 0.009, 6, 14, Math.PI); stir.rotateY(Math.PI / 2); stir.translate(0.415, 0.95, -0.22);
  const tread = new THREE.BoxGeometry(0.05, 0.012, 0.125).translate(0.415, 0.948, -0.22);
  P.seatIron = { geo: merge([...both(stir), ...both(tread)]), mat: lib.iron, frame: 'seat' };
  // 腿裙（札甲，包覆大腿到膝）
  const thighLen = hip.distanceTo(knee);
  const tasset = place(uvScale(lathe([[0.112, 0.02], [0.118, thighLen * 0.5], [0.108, thighLen * 0.96], [0.1, thighLen * 1.02]], 16), 3, 1.4), hip, knee);
  P.seatLamellar = { geo: merge(both(tasset)), mat: lib.lamellar, frame: 'seat' };

  // ============================ torso 刚体 ============================
  const pz = RIG.pelvis.z;
  const cuirass = uvScale(lathe([[0.19, 1.6], [0.2, 1.66], [0.178, 1.74], [0.172, 1.8], [0.188, 1.92], [0.207, 2.04], [0.202, 2.12], [0.168, 2.19], [0.105, 2.235], [0.088, 2.262]], 28), 5, 1.9);
  cuirass.scale(1, 1, 0.74); cuirass.translate(0, 0, pz);
  // 披膊：不是球形肩甲，而是从肩头垂下、贴着上臂外侧的两层札甲片（上层短、压住下层），肩顶只有一块低平的过渡甲
  const flap = (rTop, rMid, rBot, yTop, yBot, arc) => {
    const g = uvScale(lathe([[rBot * 0.97, yBot], [rBot, yBot + 0.03], [rMid, (yTop + yBot) / 2], [rTop, yTop]], 14, Math.PI / 2 - arc / 2, arc), 2.2, 1.1);
    g.scale(1, 1, 1.12); g.rotateZ(0.2); g.translate(0.232, 2.165, pz);
    return g;
  };
  const pauldLower = flap(0.07, 0.088, 0.094, -0.02, -0.27, 3.5);
  const pauldUpper = flap(0.066, 0.094, 0.103, 0.035, -0.12, 3.7);
  const pauldCap = uvScale(new THREE.SphereGeometry(0.08, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 2, 0.6);
  pauldCap.scale(1.1, 0.42, 1.2); pauldCap.rotateZ(-0.25); pauldCap.translate(0.222, 2.178, pz);
  const pauld = merge([pauldLower, pauldUpper, pauldCap]);
  P.torsoLamellar = { geo: merge([cuirass, ...both(pauld)]), mat: lib.lamellar, frame: 'torso' };
  const belt = new THREE.TorusGeometry(0.176, 0.022, 8, 28); belt.rotateX(Math.PI / 2); belt.scale(1, 1.3, 0.74); belt.translate(0, 1.795, pz);
  // 胸前十字束甲绊
  const strapA = new THREE.TorusGeometry(0.2, 0.011, 6, 20, Math.PI * 0.9); strapA.rotateX(Math.PI / 2); strapA.rotateY(Math.PI * 0.05); strapA.scale(1, 1.6, 0.74); strapA.translate(0, 1.96, pz);
  P.torsoLeather = { geo: merge([belt, strapA]), mat: lib.leatherDark, frame: 'torso' };
  // 明光铠护心镜（胸前两面、背后一面，抛光钢）
  const disc = new THREE.SphereGeometry(0.066, 20, 10); disc.scale(1, 1, 0.24);
  const d1 = disc.clone().rotateY(-0.34).translate(0.088, 2.035, pz - 0.143);
  const d3 = disc.clone().translate(0, 2.03, pz + 0.152);
  const buckle = new THREE.BoxGeometry(0.06, 0.05, 0.02).translate(0, 1.795, pz - 0.135);
  P.torsoSteel = { geo: merge([...both(d1), d3, buckle]), mat: lib.steel, frame: 'torso' };

  // ============================ head 刚体 ============================
  const nz = RIG.neck.z;
  const skull = new THREE.SphereGeometry(0.094, 18, 12); skull.scale(0.9, 1.12, 1.0); skull.translate(0, 2.395, nz - 0.01);
  P.headSkin = { geo: merge([skull]), mat: lib.skin, frame: 'head' };
  // 防沙面巾 + 护颈布（遮住面部，只在盔沿下留一道眼缝）
  const scarf = lathe([[0.07, 2.22], [0.086, 2.29], [0.1, 2.35], [0.097, 2.385], [0.088, 2.395]], 20); scarf.translate(0, 0, nz - 0.012);
  P.headCloth = { geo: merge([scarf]), mat: lib.clothDark, frame: 'head' };
  // 兜鍪（铁盔）：盔体 + 盔沿 + 眉庇 + 盔顶缨管
  const bowl = lathe([[0.121, 2.405], [0.124, 2.44], [0.116, 2.495], [0.092, 2.545], [0.05, 2.578], [0.016, 2.59], [0.012, 2.64]], 24); bowl.translate(0, 0, nz - 0.005);
  const brim = new THREE.TorusGeometry(0.123, 0.011, 6, 28); brim.rotateX(Math.PI / 2); brim.translate(0, 2.405, nz - 0.005);
  const visor = new THREE.SphereGeometry(0.13, 16, 6, Math.PI * 0.72, Math.PI * 0.56, Math.PI * 0.42, Math.PI * 0.12); visor.translate(0, 2.37, nz - 0.005);
  const ridges = [];
  for (let i = 0; i < 4; i++) { const r = new THREE.TorusGeometry(0.119, 0.006, 5, 20, Math.PI); r.scale(1, 1.55, 1); r.rotateY((i / 4) * Math.PI); r.translate(0, 2.405, nz - 0.005); ridges.push(r); }
  P.headIron = { geo: merge([bowl, brim, visor, ...ridges]), mat: lib.iron, frame: 'head' };
  // 顿项（盔后垂下的札甲护颈）
  const avent = uvScale(lathe([[0.214, 2.212], [0.186, 2.25], [0.142, 2.33], [0.127, 2.412]], 22, Math.PI + 0.8, Math.PI * 2 - 1.6), 4, 0.6); avent.translate(0, 0, nz - 0.005);
  // 护面：顿项在正面合拢成札甲面甲，遮住口鼻与脸颊，只在盔沿下留一道眼缝
  const faceGuard = uvScale(lathe([[0.196, 2.214], [0.17, 2.25], [0.128, 2.32], [0.118, 2.36], [0.112, 2.374]], 12, Math.PI - 0.86, 1.72), 1.6, 0.6); faceGuard.translate(0, 0, nz - 0.005);
  const guardRim = new THREE.TorusGeometry(0.113, 0.006, 5, 12, 1.72); guardRim.rotateX(Math.PI / 2); guardRim.rotateY(Math.PI / 2 + 0.86); guardRim.translate(0, 2.375, nz - 0.005);
  P.headLamellar = { geo: merge([avent, faceGuard, guardRim]), mat: lib.lamellar, frame: 'head' };
  // 盔缨（红）
  const plume = lathe([[0.006, 0], [0.03, 0.03], [0.05, 0.09], [0.042, 0.16], [0.018, 0.23], [0.0, 0.27]], 12); plume.scale(1, 1, 1.5); plume.rotateX(0.55); plume.translate(0, 2.63, nz - 0.005);
  P.headPlume = { geo: merge([plume]), mat: lib.tassel, frame: 'head' };

  // ============================ 手臂（沿 +Y） ============================
  P.upperArm = { geo: merge([limb(0.06, 0.052, RIG.upperArm)]), mat: lib.cloth, frame: 'bone', perRider: 2 };
  const vamb = lathe([[0.0, -0.01], [0.052, 0.0], [0.057, 0.03], [0.05, 0.14], [0.043, 0.25], [0.04, RIG.foreArm], [0.0, RIG.foreArm + 0.005]], 14);
  const bands = [0.05, 0.14, 0.23].map((y) => { const t = new THREE.TorusGeometry(0.052 - y * 0.035, 0.006, 5, 14); t.rotateX(Math.PI / 2); t.translate(0, y, 0); return t; });
  P.foreArm = { geo: merge([uvScale(vamb, 3, 1)]), mat: lib.lamellar, frame: 'bone', perRider: 2 };
  P.foreArmBands = { geo: merge(bands), mat: lib.leatherDark, frame: 'bone', perRider: 2 };
  // 握拳的手（皮手套）：握持轴沿 Z，腕在 -Y
  const palm = new THREE.SphereGeometry(1, 12, 8); palm.scale(0.03, 0.036, 0.048); palm.translate(0, -0.022, 0);
  const fingers = [];
  for (let i = 0; i < 4; i++) { const f = new THREE.TorusGeometry(0.027, 0.0125, 6, 12, Math.PI * 1.35); f.rotateZ(-Math.PI * 0.18); f.translate(0, 0.004, -0.036 + i * 0.024); fingers.push(f); }
  const thumb = limb(0.013, 0.011, 0.05, 8); thumb.rotateX(Math.PI / 2); thumb.rotateY(0.5); thumb.translate(-0.028, 0.0, -0.03);
  const cuff = lathe([[0.036, -0.075], [0.044, -0.055], [0.04, -0.04]], 12);
  P.hand = { geo: merge([palm, ...fingers, thumb, cuff]), mat: lib.leatherDark, frame: 'bone', perRider: 2 };

  // ============================ 长槊（沿 +Y，握点在原点） ============================
  const G = RIG.lanceGrip, L = RIG.lanceLen;
  const shaft = new THREE.CylinderGeometry(0.0165, 0.02, L - 0.45, 10).translate(0, (L - 0.45) / 2 - G, 0);
  P.lanceWood = { geo: merge([shaft]), mat: lib.wood, frame: 'lance' };
  const tipY = L - 0.45 - G;
  const blade = new THREE.ConeGeometry(0.034, 0.5, 4); blade.scale(1, 1, 0.32); blade.translate(0, tipY + 0.3, 0);
  const socket = new THREE.CylinderGeometry(0.02, 0.024, 0.14, 10).translate(0, tipY, 0);
  const guard = new THREE.CylinderGeometry(0.034, 0.034, 0.012, 12).translate(0, tipY + 0.06, 0);
  const butt = new THREE.ConeGeometry(0.022, 0.16, 8); butt.rotateX(Math.PI); butt.translate(0, -G - 0.07, 0);
  P.lanceSteel = { geo: merge([blade, socket, guard, butt]), mat: lib.steel, frame: 'lance' };
  const tassel = lathe([[0.022, 0.0], [0.05, -0.04], [0.058, -0.1], [0.04, -0.2], [0.012, -0.27], [0, -0.28]].reverse(), 12); tassel.translate(0, tipY - 0.06, 0);
  P.lanceTassel = { geo: merge([tassel]), mat: lib.tassel, frame: 'lance' };

  // ============================ 战马面帘（铁，随头部挂点） ============================
  const ridgeA = v3(0, 1.915, -1.2), ridgeB = v3(0, 1.655, -1.68);
  const cl = ridgeA.distanceTo(ridgeB);
  const cham = lathe([[0.06, -0.03], [0.1, 0.0], [0.103, cl * 0.25], [0.096, cl * 0.55], [0.088, cl * 0.78], [0.075, cl * 0.82]], 14, -0.95, 1.9);
  const boss = new THREE.SphereGeometry(0.028, 10, 6).translate(0, cl * 0.16, 0.1);
  const chGeo = merge([cham, boss]);
  {
    const d = new THREE.Vector3().subVectors(ridgeB, ridgeA).normalize();
    const n = new THREE.Vector3(0, -d.z, d.y).normalize(); // 面部朝外（上前方）
    if (n.y < 0) n.negate();
    const x = new THREE.Vector3().crossVectors(d, n);
    // 旋转轴在头骨内部（沿法线向内 0.09），甲面贴着额头与鼻梁
    _m.makeBasis(x, d, n); _m.setPosition(ridgeA.x - n.x * 0.09, ridgeA.y - n.y * 0.09, ridgeA.z - n.z * 0.09);
    chGeo.applyMatrix4(_m);
  }
  P.chamfron = { geo: chGeo, mat: lib.iron, frame: 'horseHead' };
  // 面帘顶的红缨
  const tuft = lathe([[0.0, 0], [0.02, 0.02], [0.03, 0.08], [0.012, 0.16], [0, 0.18]], 8); tuft.rotateX(0.5); tuft.translate(0, 1.925, -1.2);
  P.chamfronTuft = { geo: merge([tuft]), mat: lib.tassel, frame: 'horseHead' };

  // ============================ 缰绳段（单位长度，沿 +Y） ============================
  P.rein = { geo: merge([new THREE.CylinderGeometry(0.0065, 0.0065, 1, 6, 1, true).translate(0, 0.5, 0)]), mat: lib.leatherDark, frame: 'segment', perRider: 2 };

  return P;
}

// 旗面：细分平面，旗杆侧沿 Y，旗尾沿 +X（由槊的局部 +X 指向世界后方）
export function buildFlagGeometry() {
  const w = 1.55, h = 0.95;
  const g = new THREE.PlaneGeometry(w, h, 30, 12);
  g.translate(w / 2, 0, 0);
  // 火焰形牙边：旗尾处高度收窄成燕尾
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / w, v = p.getY(i) / h;
    const notch = u > 0.72 ? (u - 0.72) / 0.28 : 0;
    p.setY(i, p.getY(i) * (1 - 0.0 * notch) + 0);
    if (Math.abs(v) < 0.18) p.setX(i, p.getX(i) - notch * w * 0.2 * (1 - Math.abs(v) / 0.18));
  }
  g.translate(0, RIG.lanceLen - RIG.lanceGrip - 0.45 - h / 2 - 0.12, 0);
  return g;
}
