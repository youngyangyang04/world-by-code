// 20 秒演出时间线：只描述“导演意图”（视线、速度、强度、事件），
// 不直接操作场景 —— 由 main.js 读取后驱动相机、骑兵、沙尘与声音。

export const DURATION = 20;

const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
function track(keys, t) {
  // keys: [[time, value], ...] 关键帧之间用 smootherstep 插值
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

const D = Math.PI / 180;
// 视线偏航（正 = 向左转头）
const YAW = [[0, 0], [1.6, 0], [2.6, 14 * D], [3.6, -10 * D], [4.7, 0], [5.0, 0], [6.3, 78 * D], [7.5, 62 * D], [8.9, -72 * D], [9.6, -64 * D], [10.5, 0], [20, 0]];
// 视线俯仰（负 = 低头）。开场略低头看到马颈马耳，随后抬头
const PITCH = [[0, -15 * D], [1.8, -9 * D], [5, -7 * D], [6.3, -5 * D], [8.9, -5 * D], [10.5, -8 * D], [13, -6 * D], [15, -9 * D], [20, -7 * D]];
// 冲锋速度系数
const SPEED = [[0, 0.9], [5, 0.95], [10, 1.0], [12.5, 1.07], [15, 1.12], [20, 1.16]];
// 演出强度（声音 / 沙尘 / 镜头颠簸）
const INTENSITY = [[0, 0.3], [5, 0.42], [10, 0.6], [15, 0.88], [18, 1.0], [20, 1.0]];
// 战友举槊呐喊的程度
const RALLY = [[0, 0], [10.2, 0], [11.2, 1], [14, 0.75], [15.5, 1], [20, 0.9]];
// 战友向前压上（超越玩家）的推进量
const SURGE = [[0, 0], [9.5, 0], [15, 1], [20, 1]];

// 平端长槊冲刺（最后阶段）
const LEVEL = [[0, 0], [15.2, 0], [16.8, 1], [20, 1]];

// 一次性事件
export const EVENTS = [
  { t: 0.5, type: 'snort' },
  { t: 1.4, type: 'whinny' },
  { t: 4.2, type: 'shout', n: 1 },
  { t: 6.4, type: 'whinny' },
  { t: 8.2, type: 'snort' },
  { t: 10.3, type: 'shout', n: 5 },
  { t: 11.6, type: 'whinny' },
  { t: 12.4, type: 'shout', n: 4 },
  { t: 14.2, type: 'shout', n: 6 },
  { t: 15.3, type: 'whinny' },
  { t: 16.0, type: 'shout', n: 7 },
  { t: 17.6, type: 'shout', n: 6 },
  { t: 18.4, type: 'whinny' },
  { t: 19.0, type: 'shout', n: 8 },
];
// 战鼓：10 秒起由疏到密
(() => {
  let t = 9.2, gap = 1.0;
  while (t < DURATION) {
    EVENTS.push({ t, type: 'drum', s: Math.min(1, 0.45 + (t - 9) * 0.06) });
    if (t > 14.5) EVENTS.push({ t: t + gap * 0.5, type: 'drum', s: 0.5 });
    t += gap;
    gap = Math.max(0.52, gap * 0.955);
  }
  EVENTS.sort((a, b) => a.t - b.t);
})();

export function sampleTimeline(t, out = {}) {
  out.yaw = track(YAW, t);
  out.pitch = track(PITCH, t);
  out.speed = track(SPEED, t);
  out.intensity = track(INTENSITY, t);
  out.rally = track(RALLY, t);
  out.surge = track(SURGE, t);
  out.level = track(LEVEL, t);
  // 后排骑兵的超越进度：从第 2.5 秒到 19.5 秒缓慢、近似匀速地赶上来（相对速度约 1.5–2.4 m/s）
  const o = Math.min(1, Math.max(0, (t - 2.5) / 17));
  out.overtake = o * o * (3 - 2 * o);
  return out;
}

// 事件游标：返回 (prevT, t] 区间内触发的事件
export class EventCursor {
  constructor() { this.i = 0; }
  reset() { this.i = 0; }
  seek(t) { this.i = 0; while (this.i < EVENTS.length && EVENTS[this.i].t <= t) this.i++; }
  advance(t, cb) {
    while (this.i < EVENTS.length && EVENTS[this.i].t <= t) cb(EVENTS[this.i++]);
  }
}
