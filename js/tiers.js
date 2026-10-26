// Weapon stat card + tiers. Stats are derived from the (balanced) item_db values the game uses:
//   DPS    sustained damage per second including reloads (pellets share 1.6x the listed damage)
//   TTK    seconds to kill a 200 HP infected with sustained fire
//   Reach  range in px; Mag/Reload as listed (after permanent upgrades if a slot is passed)
// Tier = the weapon's power score bucketed 1..5, with class floors/caps so explosives and
// specials are never "early" weapons and every basic pistol is T1.
const ZED_HP = 200;

export function weaponStats(it, stat = (k) => it[k]) {
  const dmg = stat('damage'), rate = Math.max(60, stat('fire-rate') || 500), mag = Math.max(1, stat('max-mag') || it['max-mag'] || 1);
  const pellets = Math.max(1, stat('spread') || 1);
  const reload = stat('reload-time') || 0;
  const perShot = it.kind === 'gun' && pellets > 1 ? dmg * 1.6 : dmg; // pellet weapons: a full point-blank hit is 1.6x
  const hits = Math.min(1.8, 1 + Math.max(0, it.pierce || 0) * 0.2); // pierce is worth a little (shots rarely line up)
  if (it.kind === 'melee') {
    const dps = (dmg * 1000) / rate;
    return { dps, ttk: ZED_HP / dps, reach: it.range || 32, mag: Infinity, reload: 0, burst: dmg, hits: 1 + (it.pierce || 0), score: dps * 0.7 * (1 + 0.1 * (it.pierce || 0)) };
  }
  const cycle = (mag * rate + reload) / mag;      // ms per shot incl. reload
  const dps = (perShot * 1000) / cycle;
  const explosive = ['launcher', 'rocket-launcher'].includes(it.class);
  const score = Math.min(800, dps * hits * (1 + Math.min(0.3, (it.range || 300) / 2000)) * (explosive ? 1.6 : 1));
  return { dps, ttk: ZED_HP / dps, reach: it.range || 0, mag, reload, burst: perShot, hits, score };
}

// Tier thresholds on the score (tuned against the balanced item_db).
const CUTS = [85, 125, 180, 270];
const FORCED = { Beretta92: 1, Knife: 1, machete: 1, chain: 1 }; // the basic pistol and light blades are always Scrap
const FLOOR = { magnum: 3, lmg: 3, launcher: 4, 'rocket-launcher': 5, special: 5, bow: 3, thrower: 4 };
const CAP = { handgun: 3, melee: 3, smg: 4 };

export function tierOf(it) {
  if (it.kind !== 'gun' && it.kind !== 'melee') return 0;
  if (FORCED[it.name]) return FORCED[it.name];
  const s = weaponStats(it).score;
  let t = 1 + CUTS.filter((c) => s >= c).length;
  t = Math.max(t, FLOOR[it.class] || 1);
  t = Math.min(t, CAP[it.class] || 5);
  return t;
}

export const TIER_NAMES = ['', 'Scrap', 'Common', 'Quality', 'Elite', 'Legendary'];
export const TIER_COLORS = ['#888', '#aaa', '#7dff8a', '#6bb8ff', '#c47bff', '#ffb347'];

// Loot found on a map when a match starts is limited to low tiers; the ceiling rises as the
// match goes on and bosses drop one tier higher.
export function lootCap(timeSec, boss = false) {
  return Math.min(4, 2 + Math.floor(timeSec / 360)) + (boss ? 1 : 0);
}

export function statLine(it, stat) {
  const s = weaponStats(it, stat);
  const f = (n) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  const t = tierOf(it);
  if (it.kind === 'melee') return `T${t} ${TIER_NAMES[t]} · DPS ${f(s.dps)} · kills in ${f(s.ttk)}s · hits ${s.hits}`;
  return `T${t} ${TIER_NAMES[t]} · DPS ${f(s.dps)} · kills in ${f(s.ttk)}s · range ${Math.round(s.reach)} · mag ${s.mag} · reload ${f(s.reload / 1000)}s`;
}
