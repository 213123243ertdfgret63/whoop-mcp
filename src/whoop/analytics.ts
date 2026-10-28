import type { DayRow } from "./data.ts";

/** Numeric day-row fields the analysis tools accept, with what each one means. */
export const METRICS = {
  recovery: { field: "recovery_pct", label: "recovery %" },
  hrv: { field: "hrv_ms", label: "HRV (ms, RMSSD)" },
  rhr: { field: "resting_hr_bpm", label: "resting heart rate (bpm)" },
  spo2: { field: "spo2_pct", label: "blood oxygen %" },
  skin_temp: { field: "skin_temp_c", label: "skin temperature (°C)" },
  sleep_hours: { field: "sleep_h", label: "hours asleep" },
  sleep_needed: { field: "sleep_needed_h", label: "hours of sleep needed" },
  deep_sleep: { field: "deep_sleep_h", label: "hours of deep (slow-wave) sleep" },
  rem_sleep: { field: "rem_sleep_h", label: "hours of REM sleep" },
  sleep_performance: { field: "sleep_performance_pct", label: "sleep performance %" },
  sleep_efficiency: { field: "sleep_efficiency_pct", label: "sleep efficiency %" },
  sleep_consistency: { field: "sleep_consistency_pct", label: "sleep consistency %" },
  respiratory_rate: { field: "respiratory_rate", label: "respiratory rate (breaths/min)" },
  disturbances: { field: "disturbances", label: "sleep disturbances" },
  strain: { field: "strain", label: "day strain (0-21)" },
  kcal: { field: "kcal", label: "energy (kcal)" },
  avg_hr: { field: "avg_hr_bpm", label: "average heart rate over the day (bpm)" },
  steps: { field: "steps", label: "steps" },
  workout_minutes: { field: "workout_min", label: "workout minutes" },
  workouts: { field: "workouts", label: "number of workouts" },
} as const satisfies Record<string, { field: keyof DayRow; label: string }>;

export type Metric = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as [Metric, ...Metric[]];

export function value(row: DayRow, metric: Metric): number | null {
  const v = row[METRICS[metric].field];
  return typeof v === "number" ? v : null;
}

/**
 * Rows that count for statistics: drops the in-progress day for whole-day totals (strain, kcal, steps,
 * workouts), which would otherwise read as an unusually low day.
 */
export const PARTIAL_METRICS: readonly Metric[] = ["strain", "kcal", "avg_hr", "steps", "workout_minutes", "workouts"];

export function complete(rows: DayRow[], metric: Metric): DayRow[] {
  return PARTIAL_METRICS.includes(metric) ? rows.filter((r) => !r.in_progress) : rows;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MIN_CHRONIC_DAYS = 21;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo);
}

export function stats(values: number[]) {
  const n = values.length;
  if (!n) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    mean: r2(mean),
    median: r2(quantile(sorted, 0.5)),
    sd: r2(sd),
    min: r2(sorted[0] ?? 0),
    max: r2(sorted[n - 1] ?? 0),
    p10: r2(quantile(sorted, 0.1)),
    p90: r2(quantile(sorted, 0.9)),
  };
}

/** Least-squares slope of value over day index, scaled to change per week. */
export function slopePerWeek(points: [number, number][]): number | null {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  if (!sxx) return null;
  const sxy = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  return r2((sxy / sxx) * 7);
}

/** Share of values at or below `v`, 0-100. */
export function percentileOf(values: number[], v: number): number {
  if (!values.length) return 0;
  return Math.round((values.filter((x) => x <= v).length / values.length) * 100);
}

export function trend(rows: DayRow[], metric: Metric) {
  const used = complete(rows, metric);
  const series = used.map((r, i) => ({ i, date: r.date, value: value(r, metric) }));
  const present = series.filter((p): p is { i: number; date: string; value: number } => p.value !== null);
  const values = present.map((p) => p.value);
  const rolling7 = series.map(({ date }, idx) => {
    const window = series.slice(Math.max(0, idx - 6), idx + 1).flatMap((p) => (p.value === null ? [] : [p.value]));
    return { date, avg: window.length ? r2(window.reduce((a, b) => a + b, 0) / window.length) : null };
  });
  const latest = present.at(-1);
  return {
    metric,
    description: METRICS[metric].label,
    ...stats(values),
    slope_per_week: slopePerWeek(present.map((p) => [p.i, p.value])),
    latest: latest ? { date: latest.date, value: latest.value, percentile: percentileOf(values, latest.value) } : null,
    missing_days: series.filter((p) => p.value === null).map((p) => p.date),
    series: series.map(({ date, value: v }, idx) => ({ date, value: v, avg_7d: rolling7[idx]?.avg ?? null })),
  };
}

/** Personal baseline from `history`, and how `today` compares (z-score, percentile). */
export function baseline(history: DayRow[], today: DayRow | undefined, metric: Metric) {
  const values = complete(history, metric).flatMap((r) => {
    const v = value(r, metric);
    return v === null ? [] : [v];
  });
  const s = stats(values);
  const t = today ? value(today, metric) : null;
  if (today?.in_progress && PARTIAL_METRICS.includes(metric)) {
    return {
      metric,
      description: METRICS[metric].label,
      ...s,
      today: null,
      today_so_far: t,
      z_score: null,
      today_percentile: null,
      note: "Day in progress; whole-day totals are not comparable yet.",
    };
  }
  const enough = s.n >= 7;
  return {
    metric,
    description: METRICS[metric].label,
    ...s,
    today: t,
    z_score: enough && t !== null && "sd" in s && s.sd ? r2((t - s.mean) / s.sd) : null,
    today_percentile: enough && t !== null ? percentileOf(values, t) : null,
    ...(enough ? {} : { note: "Fewer than 7 days of data; not enough for a baseline." }),
  };
}

export function mean(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number");
  return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

export function compare(a: DayRow[], b: DayRow[], metric: Metric) {
  const ma = mean(complete(a, metric).map((r) => value(r, metric)));
  const mb = mean(complete(b, metric).map((r) => value(r, metric)));
  return {
    metric,
    description: METRICS[metric].label,
    period_a_mean: ma,
    period_b_mean: mb,
    change: ma !== null && mb !== null ? r2(mb - ma) : null,
    change_pct: ma !== null && mb !== null && ma !== 0 ? r2(((mb - ma) / Math.abs(ma)) * 100) : null,
    n_a: complete(a, metric).filter((r) => value(r, metric) !== null).length,
    n_b: complete(b, metric).filter((r) => value(r, metric) !== null).length,
  };
}

function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j++;
    for (let k = i; k <= j; k++) out[order[k]?.[1] ?? 0] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx && syy ? r2(sxy / Math.sqrt(sxx * syy)) : null;
}

/** Correlates x on day d with y on day d + lag (e.g. strain today vs. recovery tomorrow with lag 1). */
export function correlate(rows: DayRow[], x: Metric, y: Metric, lag: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  // rows are consecutive days, so the row lag positions later is lag days later
  rows.forEach((row, i) => {
    const later = rows[i + lag];
    if (!later) return;
    const vx = complete([row], x).length ? value(row, x) : null;
    const vy = complete([later], y).length ? value(later, y) : null;
    if (vx !== null && vy !== null) {
      xs.push(vx);
      ys.push(vy);
    }
  });
  const r = pearson(xs, ys);
  const strength =
    r === null
      ? null
      : Math.abs(r) < 0.1
        ? "none"
        : Math.abs(r) < 0.3
          ? "weak"
          : Math.abs(r) < 0.5
            ? "moderate"
            : "strong";
  return {
    x: { metric: x, description: METRICS[x].label },
    y: { metric: y, description: METRICS[y].label, lag_days: lag },
    n: xs.length,
    pearson_r: r,
    spearman_rho: pearson(ranks(xs), ranks(ys)),
    strength,
    note: `${xs.length < 14 ? "Few data points, so treat this as a hint. " : ""}Correlation is not causation.`,
  };
}

/**
 * Training load from day strain: acute (7-day) vs chronic (28-day) average and their ratio. A ratio well
 * above the usual band (roughly 0.8-1.3) means load is rising faster than you're used to.
 */
export function trainingLoad(rows: DayRow[]) {
  const done = rows.filter((r) => !r.in_progress);
  const last = (n: number) => done.slice(-n).flatMap((r) => (r.strain === null ? [] : [r.strain]));
  const acute = mean(last(7));
  const chronic = mean(last(28));
  const enough = last(28).length >= MIN_CHRONIC_DAYS;
  const ratio = enough && acute !== null && chronic ? r2(acute / chronic) : null;
  const lastWeek = rows.slice(-7);
  // WHOOP's "sleep needed" already carries the previous nights' debt, so nightly shortfalls must not be summed.
  const shortfall = mean(
    lastWeek.map((r) => (r.sleep_h !== null && r.sleep_needed_h !== null ? r.sleep_needed_h - r.sleep_h : null)),
  );
  return {
    acute_strain_7d: acute,
    chronic_strain_28d: chronic,
    acute_chronic_ratio: ratio,
    ratio_band:
      ratio === null
        ? null
        : ratio < 0.8
          ? "below usual (lighter than your recent norm: a planned deload, illness/rest, or less training)"
          : ratio <= 1.3
            ? "usual range"
            : "above usual (ramping up)",
    days_with_strain: { acute: last(7).length, chronic: last(28).length },
    ...(enough ? {} : { note: `The ratio needs at least ${MIN_CHRONIC_DAYS} of the last 28 days with strain data.` }),
    sleep_shortfall_7d_avg_h: shortfall,
    sleep_shortfall_note:
      "Average nightly gap between sleep needed and sleep got. Sleep needed already includes carried-over debt, so these gaps don't add up to a total.",
    recovery_7d_avg: mean(lastWeek.map((r) => r.recovery_pct)),
  };
}
