// Forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// The model learns an hourly profile from past big launches (the case's
// `comparables`). For every comparable launch we look at its release day
// (UTC) as log-ratios to its own hour-1 print, then predict the target
// game's ratios the same way:
//
//  1. Shape set: console-only, rolling-midnight-local launches (no PC,
//     no simultaneous global unlock, no early access) — the games shaped
//     most like GTA VI, which unlocks at midnight local on PS5/Xbox.
//  2. Similarity: x = ln(hour-1 print / pre-launch max) — how much of
//     the game's recent buzz hour 1 already holds. A small hour 1 next
//     to big buzz means the West has not woken up yet and the day rises
//     much further (the correlation across comparables is about -0.8).
//     Each hour's forecast is a Gaussian-kernel weighted median of the
//     shape set's log-ratios, with the kernel over x, so launches that
//     looked like the target at hour 1 count most.
//  3. Spread: the weighted interquartile range of the same log-ratios,
//     floored at 0.5 log units, so the 90% band stays honest even when
//     the shape set agrees closely.
//  4. Extreme hour 1: when x is below -0.8 the shape set thins out, so
//     the median is blended 60/40 toward a per-hour linear fit of
//     log-ratio on x over the whole comparable tier — the wider set has
//     more leverage at extreme x.
//
// Everything is computed from the case file at run time; nothing is
// hard-coded from any past launch. Fallbacks keep every case valid: no
// usable shape set -> flat persistence at hour 1 with a widening
// spread; no pre-launch history -> the unweighted median shape.
//
// Node 22, standard library only, no network, deterministic: no
// randomness, no clock, every iteration in a fixed order.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Hours to forecast. */
const HOURS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];

/** Kernel width over x (log-ratio of hour-1 print to pre-launch max). */
const KERNEL_BW = 0.5;
/** Floor on the log spread, so the band never claims false precision. */
const SPREAD_FLOOR = 0.5;
/** Below this x the shape set is thin, so blend toward the tier-wide fit. */
const EXTREME_X = -0.8;
/** Weight of the tier-wide fit in the extreme-x blend. */
const EXTREME_W = 0.4;
/** Clamp on x, so no target extrapolates wildly. */
const X_MIN = -2.0;
const X_MAX = 0.5;
/** Clamp on a predicted log-ratio. */
const RATIO_MIN = -1.5;
const RATIO_MAX = 2.5;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels?: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
}

interface CaseInput {
  id: string;
  day_start: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: HourlyPoint[] | null;
  comparables?: Comparable[] | null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (x: number): number => Math.round(x * 100) / 100;
const median = (vals: number[]): number => {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Weighted quantile of (value, weight) pairs, weights >= 0, p in [0, 1]. */
const weightedQuantile = (pairs: Array<[number, number]>, p: number): number => {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return sorted.length > 0 ? sorted[0][0] : 0;
  const target = p * total;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= target) return v;
  }
  return sorted[sorted.length - 1][0];
};

/** The tier a comparable's unlock note assigns it, normalised: the note
 *  writes "Tier: comparable" for the plain comparable tier. */
const tierOf = (c: Comparable): string => {
  const m = /Tier:\s*([a-z-]+)/.exec(c.unlock ?? '');
  if (!m) return 'comp';
  return m[1] === 'comparable' ? 'comp' : m[1];
};

/** Console-only, rolling-midnight-local launch: the GTA VI-like shape set. */
const isRollingConsole = (c: Comparable): boolean => {
  if (tierOf(c) !== 'comp') return false;
  const platforms = (c.platforms ?? '').toLowerCase();
  if (platforms.includes('pc')) return false;
  const unlock = (c.unlock ?? '').toLowerCase();
  if (unlock.includes('early access')) return false;
  if (unlock.includes('single global') || unlock.includes('single simultaneous')) return false;
  if (unlock.includes('simultaneous across') || unlock.includes('simultaneous-global')) return false;
  return true;
};

/** A comparable's release-day (UTC) hourly viewers, hour -> viewers. */
const releaseDay = (c: Comparable): Map<number, number> => {
  const dayStart = Date.parse(c.day_start);
  const out = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    const h = Math.floor((Date.parse(p.from) - dayStart) / 3_600_000) + 1;
    if (h >= 1 && h <= 24 && p.viewers > 0) out.set(h, p.viewers);
  }
  return out;
};

/** Largest hourly viewers before the release day starts. */
const preLaunchMax = (hourly: HourlyPoint[] | undefined | null, dayStart: string): number | null => {
  const ds = Date.parse(dayStart);
  let best: number | null = null;
  for (const p of hourly ?? []) {
    if (Date.parse(p.from) < ds && p.viewers > 0 && (best === null || p.viewers > best)) best = p.viewers;
  }
  return best;
};

/** Log-ratio curves (hour -> ln(viewers / hour-1)) of the comparables passing `pred`. */
interface ShapeCurve {
  x: number;
  ratios: Map<number, number>;
}

const shapeCurves = (comparables: Comparable[], pred: (c: Comparable) => boolean): ShapeCurve[] => {
  const out: ShapeCurve[] = [];
  for (const c of comparables) {
    if (!pred(c)) continue;
    const day = releaseDay(c);
    const v1 = day.get(1);
    if (v1 === undefined || day.size < 12) continue;
    const pre = preLaunchMax(c.hourly, c.day_start);
    if (pre === null || pre <= 0) continue;
    const ratios = new Map<number, number>();
    for (const [h, v] of day) ratios.set(h, Math.log(v / v1));
    out.push({ x: Math.log(v1 / pre), ratios });
  }
  return out;
};

/** Per-hour least-squares fit of log-ratio on x over the given curves. */
const linearFit = (curves: ShapeCurve[], hour: number): { a: number; b: number } | null => {
  const pts: Array<[number, number]> = [];
  for (const c of curves) {
    const y = c.ratios.get(hour);
    if (y !== undefined) pts.push([c.x, y]);
  }
  if (pts.length < 4) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
};

/** Forecast one case: {hour -> [q05, q25, q50, q75, q95]} in viewers. */
const forecastCase = (c: CaseInput): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first?.viewers ?? 1);
  const comparables = c.comparables ?? [];

  // The target's similarity coordinate, from its own pre-launch history.
  const pre = preLaunchMax(c.history_hourly, c.day_start);
  const xTarget = pre !== null && pre > 0 ? clamp(Math.log(p1 / pre), X_MIN, X_MAX) : null;

  const rolling = shapeCurves(comparables, isRollingConsole);
  const tierWide = shapeCurves(comparables, (x) => tierOf(x) === 'comp');

  const hours = c.forecast.map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  const wanted = hours.length > 0 ? hours : HOURS;

  return wanted.map((h) => {
    // Kernel-weighted median and spread over the rolling-console shape set.
    let med: number | null = null;
    let sigma = SPREAD_FLOOR;
    if (rolling.length > 0) {
      const pairs: Array<[number, number]> = [];
      for (const curve of rolling) {
        const y = curve.ratios.get(h);
        if (y === undefined) continue;
        const w = xTarget === null ? 1 : Math.exp(-0.5 * Math.pow((curve.x - xTarget) / KERNEL_BW, 2));
        pairs.push([y, w]);
      }
      if (pairs.length > 0) {
        med = weightedQuantile(pairs, 0.5);
        const iqr = weightedQuantile(pairs, 0.75) - weightedQuantile(pairs, 0.25);
        sigma = Math.max(iqr / 1.349, SPREAD_FLOOR);
      }
    }
    // Fallback: the unweighted median shape of the whole comparable tier.
    if (med === null && tierWide.length > 0) {
      const vals: number[] = [];
      for (const curve of tierWide) {
        const y = curve.ratios.get(h);
        if (y !== undefined) vals.push(y);
      }
      if (vals.length > 0) {
        med = median(vals);
        const s = [...vals].sort((a, b) => a - b);
        const iqr = s[Math.floor((3 * s.length) / 4)] - s[Math.floor(s.length / 4)];
        sigma = Math.max(iqr / 1.349, SPREAD_FLOOR);
      }
    }
    // Extreme hour 1: blend toward the tier-wide linear fit on x.
    if (med !== null && xTarget !== null && xTarget < EXTREME_X && tierWide.length >= 4) {
      const fit = linearFit(tierWide, h);
      if (fit !== null) {
        const reg = clamp(fit.a + fit.b * xTarget, RATIO_MIN, RATIO_MAX);
        med = (1 - EXTREME_W) * med + EXTREME_W * reg;
      }
    }
    // Last fallback: flat persistence with a widening spread.
    const m = med === null ? 0 : clamp(med, RATIO_MIN, RATIO_MAX);
    const s = med === null ? 0.35 + 0.1 * Math.sqrt(h - 1) : sigma;
    const q = Z.map((z) => clamp(round2(p1 * Math.exp(m + z * s)), 1, 1_000_000_000));
    // Rounding can only equalise, never reverse, but enforce order anyway.
    for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i], q[i - 1]);
    return { hour: h, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseInput;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
