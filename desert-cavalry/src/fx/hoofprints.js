import * as THREE from 'three';

// 马蹄印：环形缓冲的实例化贴花。每次蹄子触地写入一个实例矩阵，用“正片叠底”把地面压暗成蹄铁形的凹痕。
// 只在出生时写一次矩阵，之后不再更新；旧的蹄印被新的覆盖（此时它们早已落在队伍身后）。
function printTexture() {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  g.filter = 'blur(2.5px)';
  // 蹄铁形压痕（开口朝后）+ 蹄尖刨出的浅坑
  g.strokeStyle = 'rgba(70,52,38,0.95)'; g.lineWidth = 9; g.lineCap = 'round';
  g.beginPath(); g.arc(32, 30, 15, Math.PI * 0.8, Math.PI * 2.2); g.stroke();
  g.fillStyle = 'rgba(120,96,74,0.7)';
  g.beginPath(); g.ellipse(32, 31, 11, 13, 0, 0, 6.283); g.fill();
  g.filter = 'none';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class HoofPrints {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.cursor = 0;
    this.pending = 0;
    this.first = -1;
    const geo = new THREE.PlaneGeometry(0.2, 0.23);
    geo.rotateX(-Math.PI / 2);
    this.tex = printTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'hoofprints';
    this._m = new THREE.Matrix4();
    this.clear();
  }
  clear() {
    const z = this._m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, z);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.first = -1; this.pending = 0;
  }
  add(x, y, z, yaw, scale) {
    const m = this._m, c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale, e = m.elements;
    e[0] = c; e[1] = 0; e[2] = -s; e[3] = 0;
    e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
    e[8] = s; e[9] = 0; e[10] = c; e[11] = 0;
    e[12] = x; e[13] = y + 0.012; e[14] = z; e[15] = 1;
    this.mesh.setMatrixAt(this.cursor, m);
    if (this.first < 0) this.first = this.cursor;
    this.pending++;
    this.cursor = (this.cursor + 1) % this.capacity;
  }
  flush() {
    if (this.first < 0) return;
    const a = this.mesh.instanceMatrix;
    if (this.pending >= this.capacity) a.addUpdateRange(0, this.capacity * 16);
    else {
      const end = this.first + this.pending;
      if (end <= this.capacity) a.addUpdateRange(this.first * 16, this.pending * 16);
      else { a.addUpdateRange(this.first * 16, (this.capacity - this.first) * 16); a.addUpdateRange(0, (end - this.capacity) * 16); }
    }
    a.needsUpdate = true;
    this.first = -1; this.pending = 0;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.tex.dispose(); this.mesh.dispose(); }
}
