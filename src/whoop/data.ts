import type { components } from "./openapi.d.ts";

/**
 * Fetching and shaping WHOOP data for the tools: pagination over the collection endpoints, local dates from
 * each record's `timezone_offset`, unit conversion (hours, kcal, km) and joining cycles, recoveries, sleeps
 * and workouts into one row per day.
 */
export type Cycle = components["schemas"]["Cycle"];
export type Recovery = components["schemas"]["Recovery"];
export type Sleep = components["schemas"]["Sleep"];
export type Workout = components["schemas"]["WorkoutV2"];
type ScoreState = Cycle["score_state"];

export interface Getter {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

export const PATHS = {
  cycles: "/v2/cycle",
  recoveries: "/v2/recovery",
  sleeps: "/v2/activity/sleep",
  workouts: "/v2/activity/workout",
} as const;

const PAGE_SIZE = 25; // WHOOP's maximum
const MAX_PAGES = 40;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const KJ_PER_KCAL = 4.184;

// ---------- dates ----------

export type IsoDate = string; // YYYY-MM-DD

/** Today's date on this computer, which is where the user is. */
export function todayLocal(now = new Date()): IsoDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `+hh:mm`, `-hh:mm` or `Z` to minutes east of UTC. */
export function offsetMinutes(offset: string | undefined): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function shifted(iso: string, offset: string | undefined): Date {
  return new Date(Date.parse(iso) + offsetMinutes(offset) * 60_000);
}

export function localDate(iso: string, offset: string | undefined): IsoDate {
  return shifted(iso, offset).toISOString().slice(0, 10);
}

/** Local wall-clock time, e.g. `2026-10-27 08:59`. */
export function localTime(iso: string | undefined, offset: string | undefined): string | null {
  if (!iso) return null;
  return shifted(iso, offset).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * The day a cycle belongs to. A cycle starts when you fall asleep, often the evening before, so it is
 * labelled with the local date 12 hours after its start: the day you woke up into.
 */
export function cycleDate(cycle: Pick<Cycle, "start" | "timezone_offset">): IsoDate {
  return localDate(new Date(Date.parse(cycle.start) + 12 * HOUR_MS).toISOString(), cycle.timezone_offset);
}

// ---------- fetching ----------

export interface Fetched<T> {
  records: T[];
  /** True when the page cap was hit, so older records may be missing. */
  truncated: boolean;
}

/** Every record of a collection whose start falls in [start, end), following `next_token`. */
export async function listAll<T>(client: Getter, path: string, start: Date, end?: Date): Promise<Fetched<T>> {
  const records: T[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.get<{ records?: T[]; next_token?: string | null }>(path, {
      limit: PAGE_SIZE,
      start: start.toISOString(),
      end: end?.toISOString(),
      nextToken,
    });
    records.push(...(res.records ?? []));
    nextToken = res.next_token ?? undefined;
    if (!nextToken) return { records, truncated: false };
  }
  return { records, truncated: true };
}

export interface Day {
  date: IsoDate;
  cycle?: Cycle;
  recovery?: Recovery;
  /** The main (non-nap) sleep that ended this day's night. */
  sleep?: Sleep;
  naps: Sleep[];
  workouts: Workout[];
}

export interface DaysResult {
  days: Day[];
  truncated: boolean;
  /** Set when the range starts before the account's first cycle, i.e. WHOOP has no older data at all. */
  first_data_date?: IsoDate;
}

/**
 * One `Day` per date from `from` to `to` (inclusive, local dates). Fetches a 2-day margin on each side
 * because cycles start the evening before and time zones shift the boundaries.
 */
export async function fetchDays(
  client: Getter,
  from: IsoDate,
  to: IsoDate,
  include: { workouts?: boolean } = {},
): Promise<DaysResult> {
  const start = new Date(`${addDays(from, -2)}T00:00:00Z`);
  const end = new Date(Math.min(Date.parse(`${addDays(to, 2)}T00:00:00Z`), Date.now() + DAY_MS));
  const [cycles, recoveries, sleeps, workouts] = await Promise.all([
    listAll<Cycle>(client, PATHS.cycles, start, end),
    listAll<Recovery>(client, PATHS.recoveries, start, end),
    listAll<Sleep>(client, PATHS.sleeps, start, end),
    include.workouts === false
      ? Promise.resolve<Fetched<Workout>>({ records: [], truncated: false })
      : listAll<Workout>(client, PATHS.workouts, start, end),
  ]);
  const days = assembleDays(from, to, cycles.records, recoveries.records, sleeps.records, workouts.records);
  const truncated = cycles.truncated || recoveries.truncated || sleeps.truncated || workouts.truncated;
  // Leading days without data are either before the account existed or a wear gap. One request tells them
  // apart: the API lists newest first, so a single record ending before the window means older data exists.
  const firstIdx = days.findIndex((d) => d.cycle);
  const firstCycle = days[firstIdx]?.cycle;
  let first_data_date: IsoDate | undefined;
  // The fetch margin may already hold an earlier cycle (labelled before `from`): then the gap is missed wear.
  const earlierFetched = cycles.records.some((c) => cycleDate(c) < from);
  if (!truncated && firstIdx > 0 && firstCycle && !earlierFetched) {
    const older = await client.get<{ records?: Cycle[] }>(PATHS.cycles, { limit: 1, end: firstCycle.start });
    if (!older.records?.some((c) => c.id !== firstCycle.id)) first_data_date = days[firstIdx]?.date;
  }
  return { days, truncated, ...(first_data_date ? { first_data_date } : {}) };
}

export function assembleDays(
  from: IsoDate,
  to: IsoDate,
  cycles: Cycle[],
  recoveries: Recovery[],
  sleeps: Sleep[],
  workouts: Workout[],
): Day[] {
  const byDate = new Map<IsoDate, Day>(dateRange(from, to).map((date) => [date, { date, naps: [], workouts: [] }]));
  const recoveryByCycle = new Map(recoveries.map((r) => [r.cycle_id, r]));
  const sleepById = new Map(sleeps.map((s) => [s.id, s]));
  const sorted = [...cycles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  for (const cycle of sorted) {
    const day = byDate.get(cycleDate(cycle));
    if (!day) continue;
    day.cycle = cycle; // if two cycles land on one date, the later one wins
    day.recovery = recoveryByCycle.get(cycle.id);
    const linked = day.recovery ? sleepById.get(day.recovery.sleep_id) : undefined;
    day.sleep = linked ?? sleeps.find((s) => s.cycle_id === cycle.id && !s.nap);
    day.naps = sleeps.filter((s) => s.cycle_id === cycle.id && s.nap);
  }

  for (const workout of workouts) {
    const t = Date.parse(workout.start);
    const owner = sorted.findLast((c) => Date.parse(c.start) <= t && (!c.end || t < Date.parse(c.end)));
    const day = byDate.get(owner ? cycleDate(owner) : localDate(workout.start, workout.timezone_offset));
    day?.workouts.push(workout);
  }
  for (const day of byDate.values()) day.workouts.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return [...byDate.values()];
}

// ---------- shaping ----------

const round = (n: number | undefined | null, digits = 1): number | null =>
  n === undefined || n === null || Number.isNaN(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits;
const hours = (ms: number | undefined | null) => round(ms == null ? null : ms / HOUR_MS, 2);
const minutes = (ms: number | undefined | null) => round(ms == null ? null : ms / 60_000, 0);
const kcal = (kj: number | undefined | null) => round(kj == null ? null : kj / KJ_PER_KCAL, 0);

export function shapeRecovery(r: Recovery | undefined) {
  if (!r) return null;
  const s = r.score;
  return {
    score_state: r.score_state,
    recovery_pct: round(s?.recovery_score, 0),
    hrv_ms: round(s?.hrv_rmssd_milli),
    resting_hr_bpm: round(s?.resting_heart_rate, 0),
    spo2_pct: round(s?.spo2_percentage),
    skin_temp_c: round(s?.skin_temp_celsius),
    calibrating: s?.user_calibrating ?? null,
  };
}

/** Time actually asleep: light + deep (slow-wave) + REM. */
export function asleepMs(s: Sleep | undefined): number | undefined {
  const st = s?.score?.stage_summary;
  if (!st) return undefined;
  return st.total_light_sleep_time_milli + st.total_slow_wave_sleep_time_milli + st.total_rem_sleep_time_milli;
}

/** Sleep WHOOP says you needed: baseline + debt + recent strain - recent naps. */
export function sleepNeededMs(s: Sleep | undefined): number | undefined {
  const n = s?.score?.sleep_needed;
  if (!n) return undefined;
  return (
    n.baseline_milli + n.need_from_sleep_debt_milli + n.need_from_recent_strain_milli + n.need_from_recent_nap_milli
  );
}

export function shapeSleep(s: Sleep | undefined) {
  if (!s) return null;
  const sc = s.score;
  const st = sc?.stage_summary;
  const n = sc?.sleep_needed;
  return {
    score_state: s.score_state,
    nap: s.nap,
    start: localTime(s.start, s.timezone_offset),
    end: localTime(s.end, s.timezone_offset),
    in_bed_h: hours(st?.total_in_bed_time_milli),
    asleep_h: hours(asleepMs(s)),
    awake_h: hours(st?.total_awake_time_milli),
    light_h: hours(st?.total_light_sleep_time_milli),
    deep_h: hours(st?.total_slow_wave_sleep_time_milli),
    rem_h: hours(st?.total_rem_sleep_time_milli),
    no_data_h: hours(st?.total_no_data_time_milli),
    sleep_cycles: st?.sleep_cycle_count ?? null,
    disturbances: st?.disturbance_count ?? null,
    needed_h: hours(sleepNeededMs(s)),
    needed_breakdown_h: n
      ? {
          baseline: hours(n.baseline_milli),
          sleep_debt: hours(n.need_from_sleep_debt_milli),
          recent_strain: hours(n.need_from_recent_strain_milli),
          recent_naps: hours(n.need_from_recent_nap_milli),
        }
      : null,
    performance_pct: round(sc?.sleep_performance_percentage, 0),
    efficiency_pct: round(sc?.sleep_efficiency_percentage, 0),
    consistency_pct: round(sc?.sleep_consistency_percentage, 0),
    respiratory_rate: round(sc?.respiratory_rate),
  };
}

export function shapeCycle(c: Cycle | undefined) {
  if (!c) return null;
  return {
    score_state: c.score_state,
    start: localTime(c.start, c.timezone_offset),
    end: localTime(c.end, c.timezone_offset),
    in_progress: !c.end,
    strain: round(c.score?.strain),
    kcal: kcal(c.score?.kilojoule),
    avg_hr_bpm: c.score?.average_heart_rate ?? null,
    max_hr_bpm: c.score?.max_heart_rate ?? null,
    steps: c.step_count ?? null,
  };
}

export function shapeWorkout(w: Workout) {
  const s = w.score;
  const z = s?.zone_durations;
  return {
    sport: w.sport_name,
    score_state: w.score_state,
    start: localTime(w.start, w.timezone_offset),
    end: localTime(w.end, w.timezone_offset),
    duration_min: minutes(Date.parse(w.end) - Date.parse(w.start)),
    strain: round(s?.strain),
    avg_hr_bpm: s?.average_heart_rate ?? null,
    max_hr_bpm: s?.max_heart_rate ?? null,
    kcal: kcal(s?.kilojoule),
    distance_km: round(s?.distance_meter == null ? null : s.distance_meter / 1000, 2),
    altitude_gain_m: round(s?.altitude_gain_meter, 0),
    percent_recorded: round(s?.percent_recorded == null ? null : s.percent_recorded * 100, 0),
    zone_minutes: z
      ? {
          z0: minutes(z.zone_zero_milli),
          z1: minutes(z.zone_one_milli),
          z2: minutes(z.zone_two_milli),
          z3: minutes(z.zone_three_milli),
          z4: minutes(z.zone_four_milli),
          z5: minutes(z.zone_five_milli),
        }
      : null,
  };
}

/** One flat row per day, the shape the summary, trend and comparison tools work on. */
export function dayRow(day: Day) {
  const r = day.recovery?.score;
  const sl = day.sleep?.score;
  const c = day.cycle;
  // A day with no cycle and no workouts wasn't tracked: its counts are unknown, not zero.
  const tracked = Boolean(day.cycle) || day.workouts.length > 0;
  const workoutMs = day.workouts.reduce((sum, w) => sum + (Date.parse(w.end) - Date.parse(w.start)), 0);
  return {
    date: day.date,
    recovery_pct: round(r?.recovery_score, 0),
    hrv_ms: round(r?.hrv_rmssd_milli),
    resting_hr_bpm: round(r?.resting_heart_rate, 0),
    spo2_pct: round(r?.spo2_percentage),
    skin_temp_c: round(r?.skin_temp_celsius),
    sleep_h: hours(asleepMs(day.sleep)),
    sleep_needed_h: hours(sleepNeededMs(day.sleep)),
    deep_sleep_h: hours(sl?.stage_summary.total_slow_wave_sleep_time_milli),
    rem_sleep_h: hours(sl?.stage_summary.total_rem_sleep_time_milli),
    sleep_performance_pct: round(sl?.sleep_performance_percentage, 0),
    sleep_efficiency_pct: round(sl?.sleep_efficiency_percentage, 0),
    sleep_consistency_pct: round(sl?.sleep_consistency_percentage, 0),
    respiratory_rate: round(sl?.respiratory_rate),
    disturbances: sl?.stage_summary.disturbance_count ?? null,
    nap_h: tracked ? hours(day.naps.reduce((sum, n) => sum + (asleepMs(n) ?? 0), 0)) : null,
    strain: round(c?.score?.strain),
    kcal: kcal(c?.score?.kilojoule),
    avg_hr_bpm: c?.score?.average_heart_rate ?? null,
    steps: c?.step_count ?? null,
    workouts: tracked ? day.workouts.length : null,
    workout_min: tracked ? minutes(workoutMs) : null,
    in_progress: c ? !c.end : false,
  };
}

export type DayRow = ReturnType<typeof dayRow>;

/**
 * Index of the day whose WHOOP cycle is running at the end of `days`. A cycle runs from sleep to sleep, so after
 * midnight, or after a night without the strap, the last date has no cycle of its own yet and the open cycle is
 * labelled with an earlier date. Only an open cycle counts, so stale data after a wear gap is never shown as today.
 */
export function currentDayIndex(days: Day[]): number {
  const last = days.length - 1;
  if (last < 0 || days[last]?.cycle) return last;
  const open = days.findLastIndex((d) => d.cycle && !d.cycle.end);
  return open >= 0 ? open : last;
}

/**
 * What a result's numbers rest on, so the model never mistakes missing or pending data for a value.
 * `firstData` is fetchDays' `first_data_date`: dates before it predate the account rather than missed wear.
 */
export function dataQuality(days: Day[], truncated: boolean, firstData?: IsoDate) {
  const states: Record<string, number> = {};
  const count = (state: ScoreState | undefined, kind: string) => {
    if (state) states[`${kind}_${state.toLowerCase()}`] = (states[`${kind}_${state.toLowerCase()}`] ?? 0) + 1;
  };
  for (const d of days) {
    count(d.cycle?.score_state, "cycle");
    count(d.recovery?.score_state, "recovery");
    count(d.sleep?.score_state, "sleep");
  }
  const before = firstData ? days.filter((d) => d.date < firstData).length : 0;
  // Dates after a still-open cycle are covered by it (no sleep detected since), not missed wear.
  const openIdx = days.findLastIndex((d) => d.cycle && !d.cycle.end);
  const inOpen = openIdx >= 0 ? days.slice(openIdx + 1).filter((d) => !d.cycle) : [];
  return {
    days: days.length,
    days_with_recovery: days.filter((d) => d.recovery?.score_state === "SCORED").length,
    days_missing_data: days
      .filter((d, i) => !d.cycle && !(firstData && d.date < firstData) && !(openIdx >= 0 && i > openIdx))
      .map((d) => d.date),
    ...(before ? { first_data_date: firstData, days_before_first_data: before } : {}),
    ...(inOpen.length ? { in_open_cycle: inOpen.map((d) => d.date) } : {}),
    score_states: states,
    calibrating: days.some((d) => d.recovery?.score?.user_calibrating),
    ...(truncated ? { truncated: "Hit the page limit; the oldest records in the range may be missing." } : {}),
  };
}
