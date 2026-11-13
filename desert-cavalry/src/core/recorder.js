// 视频录制：捕获画布视频流 + Web Audio 混音输出，录完自动下载。支持 MP4（H.264 + AAC）与 WebM（VP9 + Opus）。
const MIMES = {
  mp4: ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
};
export class Recorder {
  constructor(canvas) { this.canvas = canvas; this.rec = null; this.chunks = []; this.ext = 'webm'; this.mime = ''; }
  static supported() { return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream; }
  // 浏览器是否能直接录制该格式（MP4 需要较新的 Chrome / Edge / Safari）
  static pick(format) { return Recorder.supported() ? MIMES[format]?.find((m) => MediaRecorder.isTypeSupported(m)) ?? null : null; }
  get active() { return !!this.rec; }
  start(audioStream, format = 'webm') {
    if (this.rec) return false;
    let mime = Recorder.pick(format);
    this.ext = format;
    if (!mime) { mime = Recorder.pick('webm'); this.ext = 'webm'; } // 不支持时退回 WebM
    this.mime = mime;
    const stream = this.canvas.captureStream(60);
    if (audioStream) for (const t of audioStream.getAudioTracks()) stream.addTrack(t);
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    return true;
  }
  stop() {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime.split(';')[0] });
        this.rec = null; this.chunks = [];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `iron-cavalry-charge-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${this.ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        resolve(blob);
      };
      rec.stop();
    });
  }
}
