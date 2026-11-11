// Frame-cost guard: long runs on a Fire tablet or phone end because the horde outgrows the device.
// main.js feeds in the real frame interval and the JS work time of each frame. The spawner multiplies
// its zed cap by `scale` and also respects `maxAlive`; the renderer drops detail when `lite` is set.
// Cost is judged by work time (and by lag against the display's own refresh interval), never by the
// raw interval alone, so a tablet that caps rAF at 30 fps is not mistaken for a slow one.
export const perf = { scale: 1, ms: 16, work: 6, base: 16.7, dropped: false, lite: false, maxAlive: 240, since: 0 };
const SLOW_WORK = 17, FAST_WORK = 11, MIN_SCALE = 0.12;

export function perfTick(rawDt, workMs = 0) {
  const ms = Math.min(250, rawDt * 1000);
  perf.ms += (ms - perf.ms) * 0.06; // smoothed
  perf.work += (Math.min(250, workMs) - perf.work) * 0.06;
  // the display's own interval: the fastest we have seen, drifting up slowly in case it changes (60 -> 30 Hz)
  if (ms >= 6 && ms < perf.base) perf.base = ms; else if (ms >= 6) perf.base += (Math.min(ms, 40) - perf.base) * 0.002;
  perf.since += rawDt;
  if (perf.since < 0.5) return;
  perf.since = 0;
  const lag = perf.ms > Math.max(26, perf.base * 1.6); // frames late relative to the display's own pace
  const slow = perf.work > SLOW_WORK || (lag && perf.work > 9);
  if (slow) perf.scale = Math.max(MIN_SCALE, perf.scale - (perf.work > 34 ? 0.18 : 0.08));
  else if (perf.work < FAST_WORK && !lag) perf.scale = Math.min(1, perf.scale + 0.02);
  perf.dropped = perf.scale < 0.95;
  perf.lite = perf.scale < 0.6;
  perf.maxAlive = Math.round(50 + 190 * perf.scale); // 240 on a healthy device down to ~73 at the floor
}
// paused / menus / hidden tab: forget the timing but keep what we learned about this device
export function perfReset() { perf.ms = perf.base; perf.work = 6; perf.since = 0; }
