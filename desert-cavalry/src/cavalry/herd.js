import * as THREE from 'three';
import { vatGLSL } from './horseAsset.js';
import { markMover } from '../fx/post.js';

// 给标准材质 / 深度材质注入 VAT 顶点动画。所有使用 VAT 的 InstancedMesh 共享 aPhase / aTint 实例属性。
//   offset     —— 沿动画法线外推（马甲壳层用）
//   tint       —— 是否乘以每实例毛色
export function applyVat(material, asset, { offset = 0, tint = false, key = '', extraVertex = '', extraFragment = null } = {}) {
  const isDepth = material.isMeshDepthMaterial || material.isMeshDistanceMaterial;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, asset.uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      ${vatGLSL(asset)}
      attribute float aPhase;
      attribute vec3 aTint;
      varying vec3 vTint;
      varying vec3 vRest;
      vec3 vatP; vec3 vatN;`);
    if (isDepth) {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `
        vatSample(gl_VertexID, aPhase, vatP, vatN);
        vRest = position;
        vec3 transformed = vatP + vatN * ${offset.toFixed(4)};
        ${extraVertex}`);
    } else {
      sh.vertexShader = sh.vertexShader
        .replace('#include <beginnormal_vertex>', `
          vatSample(gl_VertexID, aPhase, vatP, vatN);
          vec3 objectNormal = vatN;
          vTint = aTint; vRest = position;`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vatP + vatN * ${offset.toFixed(4)};
          ${extraVertex}`);
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vTint; varying vec3 vRest;`);
    if (tint && !isDepth) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= vTint;`)
        // 马毛不该像镜面：限制最小粗糙度（原贴图在尾部等处过于光滑，逆光时会出现刺眼高光）
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = max(roughnessFactor, 0.5);`);
    }
    extraFragment?.(sh);
  };
  material.customProgramCacheKey = () => `vat|${offset}|${tint}|${key}|${isDepth}`;
  return material;
}

// 马群：一个 InstancedMesh 画出所有战马（含玩家坐骑），每个实例有独立的步态相位与毛色。
export class Herd {
  constructor(asset, maxCount) {
    this.asset = asset;
    this.max = maxCount;
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(maxCount), 1);
    this.phase.setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 3).fill(1), 3);
    this.layers = [];

    const m = asset.maps;
    this.horseMat = markMover(applyVat(new THREE.MeshStandardMaterial({
      map: m.map, roughnessMap: m.orm, aoMap: m.orm, metalness: 0, roughness: 1, envMapIntensity: 0.9,
    }), asset, { tint: true, key: 'horse' }));
    this.horse = this.addLayer(asset.geometry, this.horseMat, { shadow: true });
    this.horse.name = 'herd';
  }

  // 新增一层共享 VAT 的实例化网格（马甲、鬃毛等）
  addLayer(geometry, material, { shadow = false, offset = 0, depthMaterial = null } = {}) {
    geometry.setAttribute('aPhase', this.phase);
    geometry.setAttribute('aTint', this.tint);
    const mesh = new THREE.InstancedMesh(geometry, material, this.max);
    if (this.layers.length) mesh.instanceMatrix = this.layers[0].instanceMatrix;
    else mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (shadow) {
      mesh.customDepthMaterial = depthMaterial ?? applyVat(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), this.asset, { offset, key: 'depth' });
    }
    mesh.count = 0;
    this.layers.push(mesh);
    return mesh;
  }

  setCount(n) { for (const l of this.layers) l.count = n; }
  setTint(i, r, g, b) { this.tint.setXYZ(i, r, g, b); this.tint.needsUpdate = true; }
  setInstance(i, matrix, phase) {
    this.horse.setMatrixAt(i, matrix);
    this.phase.array[i] = phase - Math.floor(phase);
  }
  commit() {
    this.horse.instanceMatrix.needsUpdate = true;
    this.phase.needsUpdate = true;
  }
  dispose() {
    for (const l of this.layers) { l.material.dispose(); l.customDepthMaterial?.dispose(); l.dispose(); }
  }
}
