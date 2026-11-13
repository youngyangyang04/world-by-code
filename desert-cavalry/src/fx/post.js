import * as THREE from 'three';
import { ATMOSPHERE_GLSL, atmosphereUniforms } from '../env/atmosphere.js';

// 自定义 HDR 后期管线：
//   1. 不透明场景 → rtScene（半浮点 HDR + 深度纹理，MSAA）。随相机运动的物体把 alpha 写成 0 作为“动体遮罩”。
//   2. 沙尘粒子 → rtDust（降分辨率、预乘 alpha、着色器内手动软深度测试）。
//   3. 合成：高度雾 + 沙尘叠加。
//   4. 相机运动模糊：由深度重建世界坐标，用上一帧 VP 矩阵反投影求速度；动体（战马/骑手/自己的手）不被拖影。
//   5. Bloom（多级降采样 / 升采样）。
//   6. 输出：ACES 色调映射、暖色调色、暗角、色散、胶片颗粒。

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function fsMaterial(frag, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false, toneMapped: false,
  });
}

// 让材质把 alpha 写为 0 —— 标记“随相机一起运动”的像素
export function markMover(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <dithering_fragment>', '#include <dithering_fragment>\n gl_FragColor.a = 0.0;');
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (key ? key() : '') + '|mover';
  return material;
}

export const DUST_LAYER = 1;

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.dustScale = 0.5;
    this.motionBlur = 1.0;
    this.dustEnabled = true;
    const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace };
    const lin = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };

    this.rtScene = new THREE.WebGLRenderTarget(4, 4, { ...hdr, ...lin, samples: 4, depthBuffer: true });
    this.rtScene.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    this.rtDust = new THREE.WebGLRenderTarget(4, 4, { ...hdr, ...lin, depthBuffer: false });
    this.rtA = new THREE.WebGLRenderTarget(4, 4, { ...hdr, ...lin, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(4, 4, { ...hdr, ...lin, depthBuffer: false });
    this.bloomMips = [];
    for (let i = 0; i < 6; i++) this.bloomMips.push(new THREE.WebGLRenderTarget(4, 4, { ...hdr, ...lin, depthBuffer: false }));

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.prevVP = new THREE.Matrix4();
    this.curVP = new THREE.Matrix4();
    this.invVP = new THREE.Matrix4();
    this.firstFrame = true;

    // 供沙尘着色器读取的场景深度
    this.depthUniforms = {
      tSceneDepth: { value: this.rtScene.depthTexture },
      uDustRes: { value: new THREE.Vector2(1, 1) },
      uCamNear: { value: 0.1 },
      uCamFar: { value: 10000 },
    };

    this.matComposite = fsMaterial(/* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene; uniform sampler2D tDepth; uniform sampler2D tDust;
      uniform mat4 uInvVP; uniform vec3 uCamPos; uniform float uDustOn;
      ${ATMOSPHERE_GLSL}
      void main() {
        vec4 sc = texture2D(tScene, vUv);
        float d = texture2D(tDepth, vUv).x;
        vec3 col = sc.rgb;
        if (d < 0.9999999) {
          vec4 wp = uInvVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          wp.xyz /= wp.w;
          vec3 rd = wp.xyz - uCamPos;
          float dist = length(rd);
          rd /= dist;
          float f = fogAmount(uCamPos, rd, dist);
          col = mix(col, hazeColor(rd), f);
        }
        vec4 dust = texture2D(tDust, vUv) * uDustOn;
        col = col * (1.0 - dust.a) + dust.rgb;
        gl_FragColor = vec4(col, sc.a);
      }`, {
      tScene: { value: null }, tDepth: { value: null }, tDust: { value: null },
      uInvVP: { value: this.invVP }, uCamPos: { value: new THREE.Vector3() }, uDustOn: { value: 1 },
      ...atmosphereUniforms,
    });

    this.matBlur = fsMaterial(/* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor; uniform sampler2D tDepth;
      uniform mat4 uInvVP; uniform mat4 uPrevVP; uniform float uStrength; uniform float uJitter;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uJitter) * 43758.5453); }
      void main() {
        vec4 c0 = texture2D(tColor, vUv);
        float d = texture2D(tDepth, vUv).x;
        vec4 wp = uInvVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        vec4 pc = uPrevVP * wp;
        vec2 prevUv = pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5;
        vec2 vel = (vUv - prevUv) * uStrength;
        if (pc.w <= 0.0) vel = vec2(0.0);
        float len = length(vel);
        const float MAXV = 0.045;
        if (len > MAXV) vel *= MAXV / len;
        // 动体（alpha≈0）不拖影
        float self = c0.a;
        if (self < 0.5 || len < 0.0006) { gl_FragColor = vec4(c0.rgb, 1.0); return; }
        vec3 acc = c0.rgb; float wsum = 1.0;
        float j = hash(gl_FragCoord.xy) - 0.5;
        for (int i = 0; i < 12; i++) {
          float t = (float(i) + 0.5 + j) / 12.0 - 0.5;
          vec4 s = texture2D(tColor, vUv + vel * t);
          float w = s.a; // 采样点落在动体上则丢弃，避免把骑兵涂抹到地面上
          acc += s.rgb * w; wsum += w;
        }
        gl_FragColor = vec4(acc / wsum, 1.0);
      }`, {
      tColor: { value: null }, tDepth: { value: null },
      uInvVP: { value: this.invVP }, uPrevVP: { value: this.prevVP }, uStrength: { value: 1 }, uJitter: { value: 0 },
    });

    this.matBright = fsMaterial(/* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tColor, vUv + uTexel * vec2(-1, -1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, -1)).rgb
               + texture2D(tColor, vUv + uTexel * vec2(-1, 1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, 1)).rgb;
        c *= 0.25;
        c = min(c, vec3(40.0));
        float l = max(c.r, max(c.g, c.b));
        float k = max(l - 1.05, 0.0) / max(l, 1e-4);
        gl_FragColor = vec4(c * k, 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });

    this.matDown = fsMaterial(/* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb * 4.0;
        c += texture2D(tColor, vUv + uTexel * vec2(-1, -1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, -1)).rgb
           + texture2D(tColor, vUv + uTexel * vec2(-1, 1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, 1)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });

    this.matUp = fsMaterial(/* glsl */ `
      precision highp float; varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tColor, vUv + uTexel * vec2(-1, 0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, 0)).rgb
               + texture2D(tColor, vUv + uTexel * vec2(0, -1)).rgb + texture2D(tColor, vUv + uTexel * vec2(0, 1)).rgb;
        c = c * 2.0 + texture2D(tColor, vUv + uTexel * vec2(-1, -1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, -1)).rgb
               + texture2D(tColor, vUv + uTexel * vec2(-1, 1)).rgb + texture2D(tColor, vUv + uTexel * vec2(1, 1)).rgb;
        gl_FragColor = vec4(c / 12.0, 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.matUp.blending = THREE.AdditiveBlending;
    this.matUp.transparent = true;

    this.matFinal = fsMaterial(/* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tColor; uniform sampler2D tBloom;
      uniform float uExposure; uniform float uBloom; uniform float uTime; uniform float uVignette; uniform float uFade;
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c);
        // 轻微镜头色散（仅边缘）
        vec2 ca = c * r2 * 0.012;
        vec3 col;
        col.r = texture2D(tColor, vUv - ca).r;
        col.g = texture2D(tColor, vUv).g;
        col.b = texture2D(tColor, vUv + ca).b;
        col += texture2D(tBloom, vUv).rgb * uBloom;
        col *= uExposure;
        col *= 1.0 - uVignette * smoothstep(0.12, 0.62, r2 * 1.25);
        col = aces(col);
        // 调色：高光偏金，暗部略偏青，增强对比（历史战争片的暖色胶片感）
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, col * vec3(1.07, 1.0, 0.88), smoothstep(0.25, 0.9, l));
        col = mix(col, col * vec3(0.9, 0.98, 1.08), (1.0 - smoothstep(0.0, 0.3, l)) * 0.6);
        col = mix(vec3(l), col, 1.06);
        col = (col - 0.5) * 1.12 + 0.5;
        col = pow(max(col, 0.0), vec3(1.0 / 2.2));
        float g = hash(gl_FragCoord.xy + fract(uTime) * 311.0) - 0.5;
        col += g * 0.028 * (1.0 - l * 0.6);
        col = mix(col, vec3(0.83, 0.66, 0.4), uFade);
        gl_FragColor = vec4(col, 1.0);
      }`, {
      tColor: { value: null }, tBloom: { value: null },
      uExposure: { value: 0.62 }, uBloom: { value: 0.085 }, uTime: { value: 0 }, uVignette: { value: 0.42 }, uFade: { value: 0 },
    });
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.rtScene.setSize(w, h);
    const dw = Math.max(2, Math.round(w * this.dustScale)), dh = Math.max(2, Math.round(h * this.dustScale));
    this.rtDust.setSize(dw, dh);
    this.depthUniforms.uDustRes.value.set(dw, dh);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    let bw = w, bh = h;
    for (const m of this.bloomMips) {
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
      m.setSize(bw, bh);
    }
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
  }

  render(scene, camera, time, fade = 0) {
    const r = this.renderer;
    camera.updateMatrixWorld();
    this.curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invVP.copy(this.curVP).invert();
    if (this.firstFrame) { this.prevVP.copy(this.curVP); this.firstFrame = false; }
    this.depthUniforms.uCamNear.value = camera.near;
    this.depthUniforms.uCamFar.value = camera.far;

    // 1. 不透明场景
    camera.layers.set(0);
    r.setRenderTarget(this.rtScene);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);

    // 2. 沙尘
    r.setRenderTarget(this.rtDust);
    r.setClearColor(0x000000, 0);
    r.clear();
    if (this.dustEnabled) {
      camera.layers.set(DUST_LAYER);
      const sa = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      r.render(scene, camera);
      r.shadowMap.autoUpdate = sa;
    }
    camera.layers.set(0);

    // 3. 合成
    const cu = this.matComposite.uniforms;
    cu.tScene.value = this.rtScene.texture;
    cu.tDepth.value = this.rtScene.depthTexture;
    cu.tDust.value = this.rtDust.texture;
    cu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    cu.uDustOn.value = this.dustEnabled ? 1 : 0;
    this._pass(this.matComposite, this.rtA);

    // 4. 运动模糊
    const bu = this.matBlur.uniforms;
    bu.tColor.value = this.rtA.texture;
    bu.tDepth.value = this.rtScene.depthTexture;
    bu.uStrength.value = this.motionBlur;
    bu.uJitter.value = time % 10;
    this._pass(this.matBlur, this.rtB);

    // 5. Bloom
    const mips = this.bloomMips;
    this.matBright.uniforms.tColor.value = this.rtB.texture;
    this.matBright.uniforms.uTexel.value.set(0.5 / this.w, 0.5 / this.h);
    this._pass(this.matBright, mips[0]);
    for (let i = 1; i < mips.length; i++) {
      this.matDown.uniforms.tColor.value = mips[i - 1].texture;
      this.matDown.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this._pass(this.matDown, mips[i]);
    }
    r.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      this.matUp.uniforms.tColor.value = mips[i].texture;
      this.matUp.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this._pass(this.matUp, mips[i - 1]);
    }
    r.autoClear = true;

    // 6. 输出到屏幕
    const fu = this.matFinal.uniforms;
    fu.tColor.value = this.rtB.texture;
    fu.tBloom.value = mips[0].texture;
    fu.uTime.value = time;
    fu.uFade.value = fade;
    this._pass(this.matFinal, null);

    this.prevVP.copy(this.curVP);
  }

  dispose() {
    [this.rtScene, this.rtDust, this.rtA, this.rtB, ...this.bloomMips].forEach((t) => t.dispose());
    [this.matComposite, this.matBlur, this.matBright, this.matDown, this.matUp, this.matFinal].forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}
