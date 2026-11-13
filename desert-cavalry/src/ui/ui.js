// 极简控制层：开始遮罩 + 底部悬浮控制条（鼠标移入画面时出现，H 键固定/隐藏）
export function bindUI({ state, onStart, onPause, onReplay, onCount, onLegion, onSpeed, onDust, onSound, onRecord, onFormat, mp4Supported, duration }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay'), hud = $('hud'), panel = $('panel'), frame = $('frame');
  const btnStart = $('btn-start'), btnPause = $('btn-pause'), btnRec = $('btn-rec'), clock = $('clock');

  btnStart.addEventListener('click', () => { overlay.classList.add('hidden'); onStart(); });
  btnPause.addEventListener('click', onPause);
  $('btn-replay').addEventListener('click', onReplay);
  $('rng-count').addEventListener('input', (e) => { $('out-count').textContent = e.target.value; onCount(+e.target.value); });
  $('rng-legion').addEventListener('input', (e) => { $('out-legion').textContent = e.target.value; onLegion(+e.target.value); });
  $('rng-speed').addEventListener('input', (e) => { $('out-speed').textContent = (+e.target.value).toFixed(2) + '×'; onSpeed(+e.target.value); });
  $('chk-dust').addEventListener('change', (e) => onDust(e.target.checked));
  $('chk-sound').addEventListener('change', (e) => onSound(e.target.checked));
  const selFmt = $('sel-format');
  if (!mp4Supported) { selFmt.querySelector('[value=mp4]').disabled = true; selFmt.title = '此浏览器不能直接录制 MP4，只能导出 WebM'; }
  selFmt.value = state.recFormat;
  selFmt.addEventListener('change', (e) => onFormat(e.target.value));
  btnRec.addEventListener('click', () => { overlay.classList.add('hidden'); onRecord(); });
  const fullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else $('stage').requestFullscreen?.(); };
  $('btn-full').addEventListener('click', fullscreen);
  const togglePanel = () => { panel.classList.toggle('collapsed'); hud.classList.toggle('pinned', !panel.classList.contains('collapsed')); };
  $('btn-panel').addEventListener('click', togglePanel);
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); if (state.mode === 'idle') btnStart.click(); else onPause(); }
    else if (e.key === 'r' || e.key === 'R') onReplay();
    else if (e.key === 'f' || e.key === 'F') fullscreen();
    else if (e.key === 'h' || e.key === 'H') togglePanel();
  });
  // 鼠标静止 2.5 秒后隐藏控制条
  let hideTimer = 0;
  frame.addEventListener('pointermove', () => {
    hud.classList.add('awake');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hud.classList.remove('awake'), 2500);
  });

  return {
    ready() { btnStart.disabled = false; btnStart.textContent = '开始冲锋'; },
    sync() {
      btnPause.textContent = state.mode === 'paused' ? '继续' : '暂停';
      btnRec.textContent = state.recording ? '● 停止录制' : '录制';
      selFmt.disabled = !!state.recording;
      btnRec.classList.toggle('on', !!state.recording);
    },
    tick() {
      const t = state.mode === 'idle' ? 0 : state.t;
      clock.textContent = `${t.toFixed(1).padStart(4, '0')} / ${duration.toFixed(1)}`;
    },
  };
}
