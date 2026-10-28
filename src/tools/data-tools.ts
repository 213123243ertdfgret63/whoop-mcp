import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  baseline,
  compare,
  complete,
  correlate,
  METRIC_NAMES,
  METRICS,
  type Metric,
  mean,
  trainingLoad,
  trend,
  value,
} from "../whoop/analytics.ts";
import {
  addDays,
  type Cycle,
  currentDayIndex,
  type Day,
  dataQuality,
  dayRow,
  daysBetween,
  fetchDays,
  type Getter,
  type IsoDate,
  listAll,
  localDate,
  localTime,
  PATHS,
  type Recovery,
  type Sleep,
  shapeCycle,
  shapeRecovery,
  shapeSleep,
  shapeWorkout,
  todayLocal,
  type Workout,
} from "../whoop/data.ts";
import { DISCLAIMER, errorResult, jsonResult, READ_ONLY } from "./common.ts";

const MAX_DAYS = 90;
/** Extra days fetched so a WHOOP day still running from a few dates back keeps its full history window. */
const ROLLBACK_MARGIN_DAYS = 7;

/** Shared date-range inputs: an explicit range, or the last `days` days ending on `end_date` (default today). */
const rangeShape = (defaultDays: number) => ({
  start_date: z.iso.date().optional().describe("First day, YYYY-MM-DD (local date)."),
  end_date: z.iso.date().optional().describe("Last day, YYYY-MM-DD (local date). Defaults to today."),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_DAYS)
    .optional()
    .describe(`Number of days ending on end_date, when start_date is not given. Defaults to ${defaultDays}.`),
});

interface RangeInput {
  start_date?: string;
  end_date?: string;
  days?: number;
}

export class InputError extends Error {}

export function resolveRange(input: RangeInput, defaultDays: number): { from: IsoDate; to: IsoDate } {
  const to = input.end_date ?? todayLocal();
  const from = input.start_date ?? addDays(to, -((input.days ?? defaultDays) - 1));
  if (from > to) throw new InputError(`start_date (${from}) must be on or before end_date (${to}).`);
  if (daysBetween(from, to) + 1 > MAX_DAYS) {
    throw new InputError(`The range is ${daysBetween(from, to) + 1} days; the maximum is ${MAX_DAYS}.`);
  }
  return { from, to };
}

const MAX_RAW_DAYS = 7;
const raw = z
  .boolean()
  .default(false)
  .describe(`Also return the original WHOOP records. Large: only for ranges of up to ${MAX_RAW_DAYS} days.`);

function checkRaw(wantRaw: boolean | undefined, from: IsoDate, to: IsoDate): void {
  const n = daysBetween(from, to) + 1;
  if (wantRaw && n > MAX_RAW_DAYS) {
    throw new InputError(
      `raw is limited to ${MAX_RAW_DAYS} days (this range is ${n}); narrow the range, or use whoop_get_record for one record.`,
    );
  }
}

/** How WHOOP defines its heart-rate zones; Claude would otherwise assume % of max heart rate. */
export const ZONE_LEGEND =
  "WHOOP heart-rate zones are % of heart-rate reserve: bpm = resting HR + pct x (max HR - resting HR); z0 under 50%, z1 50-60%, z2 60-70%, z3 70-80%, z4 80-90%, z5 90-100%. Do not convert them with % of max HR.";
const metric = z.enum(METRIC_NAMES);
const METRIC_HELP = Object.entries(METRICS)
  .map(([name, m]) => `${name} = ${m.label}`)
  .join("; ");

function rawDays(days: Day[]) {
  return days.map((d) => ({
    date: d.date,
    cycle: d.cycle ?? null,
    recovery: d.recovery ?? null,
    sleep: d.sleep ?? null,
    naps: d.naps,
    workouts: d.workouts,
  }));
}

function localTimeOf(iso: string | undefined, offset: string | undefined): string {
  return localTime(iso, offset) ?? "an unknown time";
}

/** One phrase for the recovery state, so Claude never waits for a score that will not come. */
export function recoveryText(r: Recovery | undefined, pct: number | null, zone: string | null): string {
  if (!r) return "no recovery recorded for last night";
  if (r.score_state === "PENDING_SCORE") return "recovery still being scored";
  if (r.score_state === "UNSCORABLE")
    return "WHOOP could not score recovery (not enough data, e.g. strap off or loose)";
  const base = `recovery ${pct ?? "n/a"}%${zone ? ` (${zone})` : ""}`;
  return r.score?.user_calibrating ? `${base}, provisional because WHOOP is still calibrating` : base;
}

export function registerDataTools(server: McpServer, client: Getter): void {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<{ data: Record<string, unknown>; summary: string }>,
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: z.object(shape), annotations: READ_ONLY },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's callback types are generic over the schema
      (async (args: any) => {
        try {
          const { data, summary } = await run(args);
          return jsonResult({ ...data, disclaimer: DISCLAIMER }, summary);
        } catch (err) {
          return errorResult(err);
        }
      }) as never,
    );

  tool(
    "whoop_today",
    "Today on WHOOP",
    "Start here for 'how am I today?', training readiness or 'should I train hard?'. One snapshot for a day: last night's sleep (stages, sleep needed vs. got), the morning's recovery (score, HRV, resting HR, SpO2, skin temp), the day's strain, calories and steps so far (in_progress while the day is still running), the day's workouts, and how each key number compares with the previous 30 days. A WHOOP day runs from sleep to sleep, not midnight to midnight: after midnight, or after a night without the strap, the day still running is shown and current_cycle_date says which. Comparisons need 7+ days of history (baseline_days); with fewer, describe today's values and say the baseline is still forming. Recovery is green at 67-100%, yellow at 34-66% and red at 0-33%; while WHOOP is calibrating (the first weeks) treat the score as provisional.",
    {
      date: z.iso.date().optional().describe("Local date, YYYY-MM-DD. Defaults to today."),
      raw,
    },
    async ({ date, raw: wantRaw }) => {
      const requested = date ?? todayLocal();
      const { days, truncated, first_data_date } = await fetchDays(
        client,
        addDays(requested, -(30 + ROLLBACK_MARGIN_DAYS)),
        requested,
      );
      const idx = currentDayIndex(days);
      const today = days[idx];
      if (!today) throw new InputError(`No data for ${requested}.`);
      const historyDays = days.slice(Math.max(0, idx - 30), idx);
      const history = historyDays.map(dayRow);
      const row = dayRow(today);
      const keys: Metric[] = ["recovery", "hrv", "rhr", "sleep_hours", "sleep_performance", "respiratory_rate"];
      if (!row.in_progress) keys.push("strain");
      const vs = keys.map((m) => {
        const b = baseline(history, row, m);
        return {
          metric: m,
          today: b.today,
          baseline_avg: b.n >= 7 && "mean" in b ? b.mean : null,
          baseline_days: b.n,
          z_score: b.z_score,
        };
      });
      const recovery = shapeRecovery(today.recovery);
      const calibrating = recovery?.calibrating === true;
      const zone =
        recovery?.recovery_pct == null
          ? null
          : recovery.recovery_pct >= 67
            ? "green"
            : recovery.recovery_pct >= 34
              ? "yellow"
              : "red";
      const rolled = today.date !== requested && today.cycle !== undefined;
      const openSince = today.cycle && !today.cycle.end ? today.cycle.start : undefined;
      const noSleepSince =
        openSince && Date.now() - Date.parse(openSince) > 30 * 3_600_000
          ? localTimeOf(openSince, today.cycle?.timezone_offset)
          : null;
      const lead = rolled
        ? `The WHOOP day that started ${localTimeOf(today.cycle?.start, today.cycle?.timezone_offset)} is still running (it rolls over after the next sleep), so this shows ${today.date}. `
        : "";
      const noSleep = noSleepSince
        ? ` No sleep has been detected since ${noSleepSince}; the strap may have been off overnight.`
        : "";
      return {
        data: {
          date: requested,
          ...(rolled ? { current_cycle_date: today.date } : {}),
          recovery: recovery
            ? {
                ...recovery,
                zone,
                ...(calibrating
                  ? {
                      zone_note:
                        "WHOOP is still calibrating to this person, so the score and zone are provisional; don't cut habitual activity because of them.",
                    }
                  : {}),
              }
            : null,
          sleep: shapeSleep(today.sleep),
          naps: today.naps.map(shapeSleep),
          day: shapeCycle(today.cycle),
          workouts: today.workouts.map(shapeWorkout),
          vs_last_30_days: vs,
          baseline_window: {
            from: historyDays[0]?.date ?? null,
            to: historyDays.at(-1)?.date ?? null,
            days_with_data: historyDays.filter((d) => d.cycle).length,
            first_data_date: first_data_date ?? null,
            calibrating_days: historyDays.filter((d) => d.recovery?.score?.user_calibrating).length,
          },
          data_quality: dataQuality([today], truncated),
          ...(noSleepSince ? { no_sleep_since: noSleepSince } : {}),
          ...(wantRaw ? { raw: rawDays([today])[0] } : {}),
        },
        summary: today.cycle
          ? `${lead}WHOOP for ${today.date}: ${recoveryText(today.recovery, recovery?.recovery_pct ?? null, zone)}, strain ${row.strain ?? "n/a"}${row.in_progress ? " so far" : ""}, ${today.workouts.length} workout(s).${noSleep}`
          : `No WHOOP cycle for ${requested} yet.`,
      };
    },
  );

  tool(
    "whoop_daily_summaries",
    "Daily WHOOP summaries",
    "One row per day over a date range (default the last 7 days, max 90): recovery, HRV, resting HR, SpO2, skin temp, hours asleep vs. needed, deep and REM sleep, sleep performance/efficiency/consistency, respiratory rate, day strain, kcal, steps, workout count and minutes. Plus averages over the range. Use it for 'how was my week', weekly check-ins and spotting patterns. Days with no WHOOP data have null values; the current day is in_progress.",
    { ...rangeShape(7), raw },
    async (args) => {
      const { from, to } = resolveRange(args, 7);
      checkRaw(args.raw, from, to);
      const { days, truncated, first_data_date } = await fetchDays(client, from, to);
      const rows = days.map(dayRow);
      const avg = (m: Metric) => mean(complete(rows, m).map((r) => value(r, m)));
      return {
        data: {
          from,
          to,
          days: rows,
          averages: {
            recovery_pct: avg("recovery"),
            hrv_ms: avg("hrv"),
            resting_hr_bpm: avg("rhr"),
            sleep_h: avg("sleep_hours"),
            sleep_performance_pct: avg("sleep_performance"),
            strain: avg("strain"),
            kcal: avg("kcal"),
            steps: avg("steps"),
            workout_min: avg("workout_minutes"),
          },
          data_quality: dataQuality(days, truncated, first_data_date),
          ...(args.raw ? { raw: rawDays(days) } : {}),
        },
        summary: `${rows.length} day(s) of WHOOP data from ${from} to ${to}.`,
      };
    },
  );

  tool(
    "whoop_sleep",
    "WHOOP sleep detail",
    "Every sleep in a date range (default last 7 days, max 90), newest last: bed and wake times, hours in bed / asleep / awake, light, deep (slow-wave) and REM hours, sleep cycles, disturbances, sleep needed with its breakdown (baseline, debt, recent strain, naps), performance, efficiency, consistency and respiratory rate. Use it for sleep coaching: bedtime consistency, sleep debt, deep/REM balance.",
    {
      ...rangeShape(7),
      include_naps: z.boolean().default(true).describe("Include naps."),
      raw,
    },
    async (args) => {
      const { from, to } = resolveRange(args, 7);
      checkRaw(args.raw, from, to);
      const start = new Date(`${addDays(from, -1)}T12:00:00Z`);
      const end = new Date(`${addDays(to, 1)}T12:00:00Z`);
      const { records, truncated } = await listAll<Sleep>(client, PATHS.sleeps, start, end);
      const inRange = records
        .filter((s) => {
          const d = localDate(s.end, s.timezone_offset);
          return d >= from && d <= to && (args.include_naps || !s.nap);
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const shaped = inRange.map((s) => ({ date: localDate(s.end, s.timezone_offset), ...shapeSleep(s) }));
      const main = shaped.filter((s) => !s.nap && s.asleep_h !== null);
      return {
        data: {
          from,
          to,
          sleeps: shaped,
          averages: {
            asleep_h: mean(main.map((s) => s.asleep_h)),
            needed_h: mean(main.map((s) => s.needed_h)),
            deep_h: mean(main.map((s) => s.deep_h)),
            rem_h: mean(main.map((s) => s.rem_h)),
            performance_pct: mean(main.map((s) => s.performance_pct)),
            efficiency_pct: mean(main.map((s) => s.efficiency_pct)),
          },
          ...(truncated ? { truncated: "Hit the page limit; the oldest sleeps may be missing." } : {}),
          ...(args.raw ? { raw: inRange } : {}),
        },
        summary: `${shaped.length} sleep(s) from ${from} to ${to}.`,
      };
    },
  );

  tool(
    "whoop_workouts",
    "WHOOP workouts",
    `Every workout in a date range (default last 7 days, max 90): sport, local start/end, duration, strain, average and max HR, kcal, distance, altitude gain, minutes in each heart-rate zone (z0-z5), percent recorded. Plus totals per sport and minutes per zone. Optional sport filter (matches WHOOP's sport name, e.g. running, walking, weightlifting). ${ZONE_LEGEND}`,
    {
      ...rangeShape(7),
      sport: z.string().optional().describe("Only this sport (case-insensitive substring of the sport name)."),
      raw,
    },
    async (args) => {
      const { from, to } = resolveRange(args, 7);
      checkRaw(args.raw, from, to);
      const start = new Date(`${addDays(from, -1)}T00:00:00Z`);
      const end = new Date(`${addDays(to, 2)}T00:00:00Z`);
      const { records, truncated } = await listAll<Workout>(client, PATHS.workouts, start, end);
      const needle = args.sport?.toLowerCase();
      const inRange = records
        .filter((w) => {
          const d = localDate(w.start, w.timezone_offset);
          return d >= from && d <= to && (!needle || w.sport_name.toLowerCase().includes(needle));
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const shaped = inRange.map(shapeWorkout);
      const bySport: Record<string, { count: number; minutes: number; strain_avg: number | null; kcal: number }> = {};
      for (const w of shaped) {
        bySport[w.sport] ??= { count: 0, minutes: 0, strain_avg: null, kcal: 0 };
        const s = bySport[w.sport]!;
        s.count++;
        s.minutes += w.duration_min ?? 0;
        s.kcal += w.kcal ?? 0;
      }
      for (const [sport, s] of Object.entries(bySport)) {
        s.strain_avg = mean(shaped.filter((w) => w.sport === sport).map((w) => w.strain));
      }
      const zones = { z0: 0, z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
      for (const w of shaped) {
        for (const k of Object.keys(zones) as (keyof typeof zones)[]) zones[k] += w.zone_minutes?.[k] ?? 0;
      }
      return {
        data: {
          from,
          to,
          workouts: shaped,
          totals_by_sport: bySport,
          zone_minutes_total: zones,
          ...(truncated ? { truncated: "Hit the page limit; the oldest workouts may be missing." } : {}),
          ...(args.raw ? { raw: inRange } : {}),
        },
        summary: `${shaped.length} workout(s) from ${from} to ${to}${args.sport ? ` matching "${args.sport}"` : ""}.`,
      };
    },
  );

  tool(
    "whoop_trends",
    "WHOOP trends",
    `How one metric moved over the last N days (default 30, max 90): mean, median, SD, min/max, p10/p90, slope per week, the latest value and its percentile, missing days, and a daily series with a 7-day rolling average. Metrics: ${METRIC_HELP}.`,
    {
      metric: metric.describe("Which metric."),
      ...rangeShape(30),
    },
    async (args) => {
      const { from, to } = resolveRange(args, 30);
      const { days, truncated, first_data_date } = await fetchDays(client, from, to, {
        workouts: args.metric === "workouts" || args.metric === "workout_minutes",
      });
      const t = trend(days.map(dayRow), args.metric);
      return {
        data: { from, to, ...t, data_quality: dataQuality(days, truncated, first_data_date) },
        summary: `${METRICS[args.metric].label} from ${from} to ${to}: mean ${"mean" in t ? t.mean : "n/a"}, slope ${t.slope_per_week ?? "n/a"} per week.`,
      };
    },
  );

  tool(
    "whoop_baselines",
    "WHOOP personal baselines",
    `Your personal normal range per metric from the N days before a date (default 30, max 90): mean, SD, p10/median/p90, and that date's value with a z-score and percentile. Use it to judge whether today is unusual for this person rather than against population norms. Metrics default to recovery, hrv, rhr, sleep_hours, sleep_performance, respiratory_rate, strain. Available: ${METRIC_HELP}.`,
    {
      date: z.iso.date().optional().describe("The day to compare, YYYY-MM-DD. Defaults to today."),
      days: z.number().int().min(7).max(MAX_DAYS).default(30).describe("Days of history before date."),
      metrics: z.array(metric).optional().describe("Which metrics."),
    },
    async ({ date, days: n, metrics }) => {
      const requested = date ?? todayLocal();
      const { days, truncated, first_data_date } = await fetchDays(
        client,
        addDays(requested, -(n + ROLLBACK_MARGIN_DAYS)),
        requested,
      );
      const idx = currentDayIndex(days);
      const rows = days.map(dayRow);
      const today = rows[idx];
      const day = today?.date ?? requested;
      const history = rows.slice(Math.max(0, idx - n), idx);
      const list = metrics?.length
        ? metrics
        : (["recovery", "hrv", "rhr", "sleep_hours", "sleep_performance", "respiratory_rate", "strain"] as Metric[]);
      return {
        data: {
          date: requested,
          ...(day !== requested ? { current_cycle_date: day } : {}),
          in_progress: today?.in_progress ?? false,
          history: { from: history[0]?.date ?? addDays(day, -n), to: history.at(-1)?.date ?? addDays(day, -1) },
          baselines: list.map((m) => baseline(history, today, m)),
          data_quality: dataQuality(days.slice(Math.max(0, idx - n), idx + 1), truncated, first_data_date),
        },
        summary: `Baselines over ${history.length} day(s) before ${day}${history[0] ? ` (${history[0].date} to ${history.at(-1)?.date})` : ""}.`,
      };
    },
  );

  const period = z.object({ start_date: z.iso.date(), end_date: z.iso.date() });
  tool(
    "whoop_compare_periods",
    "Compare two WHOOP periods",
    `Side-by-side averages for two date ranges (each up to 90 days), with absolute and % change from A to B and the sample count per period. E.g. this week vs last week, or before vs after a training block. Metrics default to recovery, hrv, rhr, sleep_hours, sleep_performance, strain, steps, workout_minutes. Available: ${METRIC_HELP}.`,
    {
      period_a: period.describe("The earlier / reference period."),
      period_b: period.describe("The period to compare against A."),
      metrics: z.array(metric).optional().describe("Which metrics."),
    },
    async ({ period_a, period_b, metrics }) => {
      const a = resolveRange(period_a, 7);
      const b = resolveRange(period_b, 7);
      const [da, db] = await Promise.all([fetchDays(client, a.from, a.to), fetchDays(client, b.from, b.to)]);
      const ra = da.days.map(dayRow);
      const rb = db.days.map(dayRow);
      const list = metrics?.length
        ? metrics
        : ([
            "recovery",
            "hrv",
            "rhr",
            "sleep_hours",
            "sleep_performance",
            "strain",
            "steps",
            "workout_minutes",
          ] as Metric[]);
      return {
        data: {
          period_a: a,
          period_b: b,
          comparison: list.map((m) => compare(ra, rb, m)),
          data_quality: {
            period_a: dataQuality(da.days, da.truncated, da.first_data_date),
            period_b: dataQuality(db.days, db.truncated, db.first_data_date),
          },
        },
        summary: `Compared ${a.from}..${a.to} with ${b.from}..${b.to}.`,
      };
    },
  );

  tool(
    "whoop_training_load",
    "WHOOP training load",
    `Training load for programming and deload decisions: daily strain over the last N days (default 28, max 90), acute (7-day) vs chronic (28-day) average strain and their ratio (about 0.8-1.3 is the usual band; well above it means load is ramping up fast), the average nightly sleep shortfall over the last 7 days (needed minus asleep), the 7-day average recovery, and workout minutes per heart-rate zone over the last 7 days. Read ratio_band together with recovery_7d_avg: a low ratio with low recovery is usually an appropriate deload, not a reason to add load. ${ZONE_LEGEND}`,
    {
      days: z.number().int().min(7).max(MAX_DAYS).default(28).describe("Days of daily strain to return."),
    },
    async ({ days: n }) => {
      const to = todayLocal();
      const from = addDays(to, -(Math.max(n, 28) - 1));
      const { days, truncated, first_data_date } = await fetchDays(client, from, to);
      const rows = days.map(dayRow);
      const zones = { z0: 0, z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
      for (const d of days.slice(-7)) {
        for (const w of d.workouts) {
          const zm = shapeWorkout(w).zone_minutes;
          for (const k of Object.keys(zones) as (keyof typeof zones)[]) zones[k] += zm?.[k] ?? 0;
        }
      }
      return {
        data: {
          ...trainingLoad(rows),
          zone_minutes_7d: zones,
          daily: rows.slice(-n).map((r) => ({
            date: r.date,
            strain: r.strain,
            recovery_pct: r.recovery_pct,
            sleep_h: r.sleep_h,
            workout_min: r.workout_min,
            in_progress: r.in_progress,
          })),
          data_quality: dataQuality(days, truncated, first_data_date),
        },
        summary: `Training load up to ${to}.`,
      };
    },
  );

  tool(
    "whoop_correlate",
    "Correlate two WHOOP metrics",
    `Correlation between two metrics over the last N days (default 60, max 90), optionally lagged: x on one day vs y lag_days later (e.g. strain vs next-day recovery with lag_days 1, or workout_minutes vs sleep_performance). Returns Pearson r, Spearman rho, n and a strength label. Correlation is not causation. Metrics: ${METRIC_HELP}.`,
    {
      x: metric.describe("The first metric (on day d)."),
      y: metric.describe("The second metric (on day d + lag_days)."),
      lag_days: z.number().int().min(0).max(3).default(0).describe("Days between x and y."),
      days: z.number().int().min(7).max(MAX_DAYS).default(60).describe("Days of history."),
    },
    async ({ x, y, lag_days, days: n }) => {
      const to = todayLocal();
      const from = addDays(to, -(n - 1));
      const { days, truncated, first_data_date } = await fetchDays(client, from, to);
      const c = correlate(days.map(dayRow), x, y, lag_days);
      return {
        data: { from, to, ...c, data_quality: dataQuality(days, truncated, first_data_date) },
        summary: `${x} vs ${y}${lag_days ? ` ${lag_days} day(s) later` : ""}: r = ${c.pearson_r ?? "n/a"} (n = ${c.n}).`,
      };
    },
  );

  tool(
    "whoop_get_record",
    "Get one WHOOP record",
    "Escape hatch: one record by ID, both shaped and as WHOOP returned it. Types: cycle (numeric cycle ID), sleep (UUID), workout (UUID), recovery_for_cycle and sleep_for_cycle (numeric cycle ID). IDs come from the raw output of the other tools.",
    {
      type: z.enum(["cycle", "sleep", "workout", "recovery_for_cycle", "sleep_for_cycle"]),
      id: z.string().min(1).describe("The record ID."),
    },
    async ({ type, id }) => {
      const enc = encodeURIComponent(id);
      switch (type) {
        case "cycle": {
          const r = await client.get<Cycle>(`${PATHS.cycles}/${enc}`);
          return { data: { type, shaped: shapeCycle(r), raw: r }, summary: `Cycle ${id}.` };
        }
        case "sleep": {
          const r = await client.get<Sleep>(`${PATHS.sleeps}/${enc}`);
          return { data: { type, shaped: shapeSleep(r), raw: r }, summary: `Sleep ${id}.` };
        }
        case "workout": {
          const r = await client.get<Workout>(`${PATHS.workouts}/${enc}`);
          return { data: { type, shaped: shapeWorkout(r), raw: r }, summary: `Workout ${id}.` };
        }
        case "recovery_for_cycle": {
          const r = await client.get<Recovery>(`${PATHS.cycles}/${enc}/recovery`);
          return { data: { type, shaped: shapeRecovery(r), raw: r }, summary: `Recovery for cycle ${id}.` };
        }
        case "sleep_for_cycle": {
          const r = await client.get<Sleep>(`${PATHS.cycles}/${enc}/sleep`);
          return { data: { type, shaped: shapeSleep(r), raw: r }, summary: `Sleep for cycle ${id}.` };
        }
      }
    },
  );
}
