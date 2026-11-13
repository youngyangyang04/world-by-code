import * as THREE from 'three';
import { RIG } from '../cavalry/parts.js';

// ---------------------------------------------------------------------------
// 第一人称骑手相机
//   · 眼睛的位置不是“写死的抖动”，而是由战马动画真实推导：
//       马实例矩阵 × 马背挂点（逐帧刚体拟合自马背顶点）× 骑手躯干姿态 × 眼睛在躯干上的位置。
//     所以颠簸的幅度、节奏、前后涌动都与战马的奔跑周期严格同步。
//   · 再经过一个欠阻尼的“脖颈弹簧”（在马的局部坐标系里积分，避免匀速前进造成滞后）→ 头部有惯性与重量感。
//   · 每只蹄子落地时给弹簧一个向下的冲量（由步态相位触发）→ 有节律的冲击感，而不是随机抖动。
//   · 视线方向由时间线（转头）+ 步态耦合的点头 / 侧倾组成；人的前庭反射会稳住视线，所以角度幅度很小。
// ---------------------------------------------------------------------------

const _eye = new THREE.Vector3(), _neck = new THREE.Vector3(), _hp = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();

export class PlayerRig {
  constructor(camera) {
    this.camera = camera;
    this.off = new THREE.Vector3();   // 弹簧状态：眼睛相对马实例原点的偏移
    this.vel = new THREE.Vector3();
    this.init = false;
    this.baseFov = 64;
    this.eyeLocal = new THREE.Vector3().subVectors(RIG.eye, RIG.neck);
  }

  reset() { this.init = false; this.vel.set(0, 0, 0); }

  // 蹄落地冲击（strength 0..1）
  impact(strength, fore) {
    this.vel.y -= (fore ? 0.2 : 0.12) * strength;
    this.vel.z += (fore ? 0.05 : -0.03) * strength;
  }

  update(dt, pl, tl) {
    const cam = this.camera;
    // 头部朝向：时间线的转头 / 俯仰
    const yaw = tl.yaw, pitch = tl.pitch;
    // 眼睛目标位置：颈部枢轴（随躯干）+ 转头后的眼睛偏移
    _neck.copy(RIG.neck).applyMatrix4(pl.torso);
    _e.set(pitch * 0.5, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _eye.copy(this.eyeLocal).applyQuaternion(_q).add(_neck);
    _hp.setFromMatrixPosition(pl.horse);
    _t.subVectors(_eye, _hp);
    if (!this.init) { this.off.copy(_t); this.vel.set(0, 0, 0); this.init = true; }
    // 脖颈弹簧（半隐式欧拉，子步积分保证稳定）
    const W = 2 * Math.PI * 4.6, Z = 0.55;
    let rem = Math.min(dt, 0.1);
    while (rem > 1e-6) {
      const h = Math.min(rem, 1 / 240);
      this.vel.x += (W * W * (_t.x - this.off.x) - 2 * Z * W * this.vel.x) * h;
      this.vel.y += (W * W * (_t.y - this.off.y) - 2 * Z * W * this.vel.y) * h;
      this.vel.z += (W * W * (_t.z - this.off.z) - 2 * Z * W * this.vel.z) * h;
      this.off.addScaledVector(this.vel, h);
      rem -= h;
    }
    cam.position.copy(_hp).add(this.off);
    // 步态耦合的头部转动：马背俯仰的一小部分 + 竖直速度引起的点头 + 横向速度引起的侧倾
    const nod = pl.seatPitch * 0.22 - this.vel.y * 0.014;
    const roll = -this.vel.x * 0.03 + 0.006 * Math.sin(Math.PI * 2 * pl.phase + 0.8);
    _e.set(pitch + nod, yaw + 0.004 * Math.sin(Math.PI * 2 * pl.phase), roll, 'YXZ');
    cam.quaternion.setFromEuler(_e);
    // 速度越快视野略宽（速度感）
    const fov = this.baseFov + 9 * (tl.speed - 0.9) + 2.5 * tl.intensity;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
