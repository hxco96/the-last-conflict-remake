// Frame-time guard: long runs on a Fire tablet or phone end because the horde outgrows the device.
// main.js feeds every real frame time in; the spawner multiplies its zed cap by `scale`, which
// slides down to 0.35 while frames take longer than ~26 ms and creeps back up when there's headroom.
export const perf = { scale: 1, ms: 16, dropped: false, since: 0 };
const SLOW = 26, FAST = 20;

export function perfTick(rawDt) {
  const ms = Math.min(250, rawDt * 1000);
  perf.ms += (ms - perf.ms) * 0.04; // smoothed
  perf.since += rawDt;
  if (perf.since < 1) return;
  perf.since = 0;
  if (perf.ms > SLOW) perf.scale = Math.max(0.35, perf.scale - 0.08);
  else if (perf.ms < FAST) perf.scale = Math.min(1, perf.scale + 0.04);
  perf.dropped = perf.scale < 0.95;
}
// paused / menus / hidden tab: forget the timing but keep what we learned about this device
export function perfReset() { perf.ms = 16; perf.since = 0; }
