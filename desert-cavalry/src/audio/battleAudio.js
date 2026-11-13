// 战场音效引擎（Web Audio API）
//   · 只有两类声音：马蹄 与 马嘶鸣。
//   · 真实录音采样（见 ASSETS.md）负责：群马奔腾、邻近战友的马蹄、嘶鸣。
//   · 自己战马的四蹄落地声由程序合成，并由步态相位精确触发 —— 保证声画同步。
//   · 邻近战友的马蹄 / 嘶鸣使用 HRTF PannerNode 做空间定位（坐标为相机局部坐标，听者固定在原点）。
//   · 任何采样缺失时使用合成兜底，并在 report 中如实标注，不假装已加载。

const SAMPLE_NAMES = ['gallop_close', 'stampede', 'whinny', 'whinny_alt'];

export class BattleAudio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.report = { loaded: [], synthesized: [] };
    this.enabled = true;
    this.started = false;
    this.intensity = 0;
    this.spatialLoops = [];
  }

  // 必须在用户手势中调用
  async init(baseUrl = './assets/audio/') {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 18; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.streamDest = ctx.createMediaStreamDestination(); // 供 WebM 录制
    comp.connect(this.streamDest);

    // 开阔地的远距离混响（程序生成的衰减噪声冲激响应）
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.6, 2.2);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain).connect(this.master);

    this.noise = this._noiseBuffer(4);
    await Promise.all(SAMPLE_NAMES.map((n) => this._load(baseUrl, n)));
  }

  async _load(base, name) {
    const ext = new Audio().canPlayType('audio/ogg; codecs=vorbis') ? 'ogg' : 'mp3';
    try {
      const res = await fetch(`${base}${name}.${ext}`);
      if (!res.ok) throw new Error(res.status);
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/html')) throw new Error('not audio');
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.report.loaded.push(name);
    } catch {
      this.report.synthesized.push(name);
    }
  }

  _noiseBuffer(sec) {
    const ctx = this.ctx, b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx, n = ctx.sampleRate * sec, b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += ((Math.random() * 2 - 1) - lp) * (0.5 - 0.42 * t);
        d[i] = lp * Math.pow(1 - t, decay) * (i < 400 ? i / 400 : 1);
      }
    }
    return b;
  }

  // 把录音首尾交叉淡化成无缝循环
  _seamless(buf, fade = 0.6) {
    const ctx = this.ctx, sr = buf.sampleRate, f = Math.min(Math.floor(fade * sr), buf.length >> 2), n = buf.length - f;
    const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = out.getChannelData(c);
      d.set(s.subarray(0, n));
      for (let i = 0; i < f; i++) {
        const k = i / f;
        d[i] = s[i] * Math.sqrt(k) + s[n + i] * Math.sqrt(1 - k);
      }
    }
    return out;
  }

  _loop(buffer, { gain = 0, rate = 1, dest = this.master, offset = 0 } = {}) {
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffer; src.loop = true; src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(0, offset % buffer.duration);
    return { src, gain: g };
  }

  _panner(refDistance = 3, rolloff = 1.1) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = refDistance; p.rolloffFactor = rolloff; p.maxDistance = 400;
    p.connect(this.master);
    return p;
  }

  start() {
    if (this.started || !this.ctx) return;
    this.started = true;
    const ctx = this.ctx, B = this.buffers;

    // —— 远处千军万马的低频轰鸣：录音循环 + 棕噪低频层
    const rumbleBus = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    rumbleBus.connect(lp).connect(this.master);
    this.rumbleLP = lp;
    this.stampede = B.stampede
      ? [this._loop(this._seamless(B.stampede), { dest: rumbleBus, rate: 0.82 }), this._loop(this._seamless(B.stampede), { dest: rumbleBus, rate: 0.68, offset: 3.7 })]
      : [];
    const sub = ctx.createBiquadFilter(); sub.type = 'lowpass'; sub.frequency.value = 70; sub.Q.value = 0.8;
    this.subGain = ctx.createGain(); this.subGain.gain.value = 0;
    const subSrc = ctx.createBufferSource(); subSrc.buffer = this.noise; subSrc.loop = true;
    subSrc.connect(sub).connect(this.subGain).connect(this.master); subSrc.start();
    // 群蹄的颗粒感：带通噪声被 ~11Hz 不规则调制
    const grit = ctx.createBiquadFilter(); grit.type = 'bandpass'; grit.frequency.value = 240; grit.Q.value = 0.7;
    this.gritGain = ctx.createGain(); this.gritGain.gain.value = 0;
    const gritSrc = ctx.createBufferSource(); gritSrc.buffer = this.noise; gritSrc.loop = true; gritSrc.playbackRate.value = 0.7;
    const am = ctx.createGain(); am.gain.value = 0.55;
    for (const f of [9.7, 13.1, 6.3]) { const o = ctx.createOscillator(); o.frequency.value = f; const og = ctx.createGain(); og.gain.value = 0.15; o.connect(og).connect(am.gain); o.start(); }
    gritSrc.connect(grit).connect(am).connect(this.gritGain).connect(this.master); gritSrc.start();

    // —— 邻近战友的马蹄声：空间化的奔跑录音循环（速率各不相同 → 相位自然错开）
    if (B.gallop_close) {
      const loopBuf = this._seamless(B.gallop_close, 0.25);
      for (let i = 0; i < 6; i++) {
        const p = this._panner(2.5, 1.3);
        const l = this._loop(loopBuf, { dest: p, gain: 0, rate: 0.94 + i * 0.035, offset: i * 1.37 });
        this.spatialLoops.push({ panner: p, gain: l.gain });
      }
    }
    this.master.gain.setTargetAtTime(this.enabled ? 0.75 : 0, ctx.currentTime, 0.3);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.75 : 0, this.ctx.currentTime, 0.08);
  }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }

  // 每帧：intensity 0..1 演出强度；speed 相对速度；near = [{x,y,z}] 相机局部坐标下最近的战友
  update(intensity, speed, near) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime, I = (this.intensity = intensity);
    for (const s of this.stampede) s.gain.gain.setTargetAtTime(0.5 + 0.9 * I, t, 0.25);
    this.rumbleLP.frequency.setTargetAtTime(500 + 1500 * I, t, 0.3);
    this.subGain.gain.setTargetAtTime(0.35 + 0.75 * I, t, 0.25);
    this.gritGain.gain.setTargetAtTime(0.1 + 0.3 * I, t, 0.25);
    for (let i = 0; i < this.spatialLoops.length; i++) {
      const L = this.spatialLoops[i], n = near[i];
      if (n) {
        L.panner.positionX.setTargetAtTime(n.x, t, 0.05);
        L.panner.positionY.setTargetAtTime(n.y, t, 0.05);
        L.panner.positionZ.setTargetAtTime(n.z, t, 0.05);
        L.gain.gain.setTargetAtTime(0.75, t, 0.2);
      } else L.gain.gain.setTargetAtTime(0, t, 0.2);
    }
  }

  // 自己战马的一次蹄落地（由步态相位触发）。pan: -1 左 … 1 右；hind: 后蹄更沉
  hoof(strength, pan, hind) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createStereoPanner(); out.pan.value = pan * 0.5; out.connect(this.master);
    // 低频“咚”：蹄铁砸进沙土
    const o = ctx.createOscillator(), og = ctx.createGain();
    const f0 = (hind ? 78 : 96) * (0.94 + Math.random() * 0.12);
    o.frequency.setValueAtTime(f0 * 1.9, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.09);
    og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(0.75 * strength, t + 0.004); og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(og).connect(out); o.start(t); o.stop(t + 0.18);
    // 沙土摩擦与碎石飞溅：短促带通噪声
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = (hind ? 520 : 760) + Math.random() * 300; bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.5 * strength, t + 0.003); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.1 + Math.random() * 0.05);
    n.connect(bp).connect(ng).connect(out); n.start(t, Math.random() * 3, 0.2);
  }

  _spatialShot(name, pos, gain, rate, maxDur) {
    const b = this.buffers[name];
    if (!this.started || !b) return false;
    const ctx = this.ctx, t = ctx.currentTime;
    const p = this._panner(4, 1.0);
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    const g = ctx.createGain();
    const dur = Math.min(maxDur, b.duration / rate);
    const off = Math.random() * Math.max(0, b.duration - dur * rate);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.06);
    g.gain.setValueAtTime(gain, t + dur - 0.3); g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(g); g.connect(p);
    const send = ctx.createGain(); send.gain.value = 0.25; g.connect(send).connect(this.reverb);
    s.start(t, off, dur * rate);
    s.onended = () => { p.disconnect(); g.disconnect(); send.disconnect(); };
    return true;
  }
  whinny(pos, gain = 1) { return this._spatialShot(Math.random() < 0.5 && this.buffers.whinny_alt ? 'whinny_alt' : 'whinny', pos, 1.1 * gain, 0.92 + Math.random() * 0.2, 3.0); }
}
