import { describe, expect, test } from "bun:test";
import { baseline, correlate, slopePerWeek, stats, trainingLoad, trend } from "../src/whoop/analytics.ts";
import {
  addDays,
  assembleDays,
  currentDayIndex,
  cycleDate,
  dataQuality,
  dateRange,
  dayRow,
  fetchDays,
  listAll,
  localDate,
  localTime,
  offsetMinutes,
  PATHS,
  shapeWorkout,
  todayLocal,
} from "../src/whoop/data.ts";
import { cycle, recovery, sleep, workout } from "./fixtures.ts";

describe("dates", () => {
  test("parses timezone offsets", () => {
    expect(offsetMinutes("Z")).toBe(0);
    expect(offsetMinutes("+01:00")).toBe(60);
    expect(offsetMinutes("-05:30")).toBe(-330);
  });

  test("converts to local dates and times", () => {
    expect(localDate("2026-10-27T23:30:00Z", "+02:00")).toBe("2026-10-28");
    expect(localTime("2026-10-27T08:59:55Z", "+01:00")).toBe("2026-10-27 09:59");
  });

  test("labels a cycle with the day you woke into", () => {
    expect(cycleDate({ start: "2026-10-26T23:30:00Z", timezone_offset: "Z" })).toBe("2026-10-27");
    expect(cycleDate({ start: "2026-10-27T00:05:57Z", timezone_offset: "Z" })).toBe("2026-10-27");
    expect(cycleDate({ start: "2026-10-26T21:30:00Z", timezone_offset: "+02:00" })).toBe("2026-10-27");
  });

  test("date arithmetic", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(dateRange("2026-10-30", "2026-11-01")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(todayLocal(new Date(2026, 9, 27, 23, 59))).toBe("2026-10-27");
  });
});

describe("listAll", () => {
  test("follows next_token with the maximum page size and date filters", async () => {
    const queries: Record<string, unknown>[] = [];
    const pages = [
      { records: [1, 2], next_token: "t2" },
      { records: [3], next_token: null },
    ];
    const client = {
      async get<T>(_path: string, query?: Record<string, unknown>) {
        queries.push(query ?? {});
        return pages[queries.length - 1] as T;
      },
    };
    const res = await listAll<number>(client, "/v2/cycle", new Date("2026-10-01T00:00:00Z"));
    expect(res).toEqual({ records: [1, 2, 3], truncated: false });
    expect(queries[0]).toMatchObject({ limit: 25, start: "2026-10-01T00:00:00.000Z", nextToken: undefined });
    expect(queries[1]).toMatchObject({ nextToken: "t2" });
  });
});

describe("assembleDays", () => {
  const cycles = [
    cycle(1, "2026-10-25T23:30:00Z", "2026-10-27T00:05:00Z"),
    cycle(2, "2026-10-27T00:05:00Z", undefined),
  ];
  const sleeps = [
    sleep("s1", 1, "2026-10-25T23:30:00Z", "2026-10-26T07:30:00Z"),
    sleep("s2", 2, "2026-10-27T00:05:00Z", "2026-10-27T08:00:00Z"),
    sleep("n2", 2, "2026-10-27T14:00:00Z", "2026-10-27T14:30:00Z", true),
  ];
  const recoveries = [recovery(1, "s1", 70), recovery(2, "s2", 31)];
  const workouts = [
    workout("w1", "2026-10-26T18:00:00Z", "2026-10-26T19:00:00Z"),
    workout("w2", "2026-10-27T12:00:00Z", "2026-10-27T13:00:00Z", 4200),
  ];
  const days = assembleDays("2026-10-24", "2026-10-27", cycles, recoveries, sleeps, workouts);

  test("one entry per date, with gaps kept as empty days", () => {
    expect(days.map((d) => d.date)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(days[0]?.cycle).toBeUndefined();
  });

  test("joins recovery, main sleep, naps and workouts to the right day", () => {
    const [, , mon, tue] = days;
    expect(mon?.cycle?.id).toBe(1);
    expect(mon?.recovery?.score?.recovery_score).toBe(70);
    expect(mon?.sleep?.id).toBe("s1");
    expect(mon?.workouts.map((w) => w.id)).toEqual(["w1"]);
    expect(tue?.sleep?.id).toBe("s2");
    expect(tue?.naps.map((n) => n.id)).toEqual(["n2"]);
    expect(tue?.workouts.map((w) => w.id)).toEqual(["w2"]);
  });

  test("day rows convert units and mark untracked and in-progress days", () => {
    const rows = days.map(dayRow);
    expect(rows[0]).toMatchObject({ workouts: null, workout_min: null, nap_h: null, strain: null });
    expect(rows[3]).toMatchObject({
      recovery_pct: 31,
      sleep_h: 7,
      sleep_needed_h: 8,
      kcal: 2000,
      workouts: 1,
      workout_min: 60,
      nap_h: 7,
      in_progress: true,
    });
  });
});

describe("shapeWorkout", () => {
  test("keeps a missing distance as null rather than 0", () => {
    expect(shapeWorkout(workout("w", "2026-10-27T12:00:00Z", "2026-10-27T12:30:00Z")).distance_km).toBeNull();
    expect(shapeWorkout(workout("w", "2026-10-27T12:00:00Z", "2026-10-27T12:30:00Z", 4200)).distance_km).toBe(4.2);
  });

  test("converts zones to minutes and kJ to kcal", () => {
    const w = shapeWorkout(workout("w", "2026-10-27T12:00:00Z", "2026-10-27T13:00:00Z"));
    expect(w).toMatchObject({ duration_min: 60, kcal: 250, percent_recorded: 100 });
    expect(w.zone_minutes).toEqual({ z0: 0, z1: 30, z2: 20, z3: 10, z4: 0, z5: 0 });
  });
});

describe("analytics", () => {
  const row = (date: string, recovery_pct: number | null, strain: number | null, in_progress = false) =>
    ({ ...dayRow({ date, naps: [], workouts: [] }), recovery_pct, strain, in_progress }) as ReturnType<typeof dayRow>;

  test("stats", () => {
    expect(stats([1, 2, 3, 4])).toMatchObject({ n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
    expect(stats([])).toEqual({ n: 0 });
  });

  test("slope per week", () => {
    expect(
      slopePerWeek([
        [0, 1],
        [1, 2],
        [2, 3],
      ]),
    ).toBe(7);
    expect(slopePerWeek([[0, 1]])).toBeNull();
  });

  test("trend skips the in-progress day for whole-day totals", () => {
    const rows = [row("2026-10-25", 50, 10), row("2026-10-26", 60, 12), row("2026-10-27", 40, 3, true)];
    expect(trend(rows, "strain")).toMatchObject({ n: 2, mean: 11 });
    expect(trend(rows, "recovery")).toMatchObject({ n: 3, latest: { date: "2026-10-27", value: 40 } });
  });

  test("baseline needs 7 days before giving a z-score", () => {
    const history = Array.from({ length: 10 }, (_, i) => row(addDays("2026-10-01", i), 50 + (i % 2) * 10, 10));
    const b = baseline(history, row("2026-10-11", 75, 10), "recovery");
    expect(b).toMatchObject({ n: 10, mean: 55, today: 75 });
    expect(b.z_score).toBeGreaterThan(3);
    expect(baseline(history.slice(0, 3), row("2026-10-11", 75, 10), "recovery").z_score).toBeNull();
  });

  test("correlate lines x up with y lag days later", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(addDays("2026-10-01", i), 100 - i * 5, i));
    const lagged = correlate(rows, "strain", "recovery", 1);
    expect(lagged.n).toBe(9);
    expect(lagged.pearson_r).toBe(-1);
    expect(lagged.spearman_rho).toBe(-1);
  });

  test("training load withholds the ratio until there is enough history", () => {
    const short = trainingLoad([row("2026-10-26", 50, 10)]);
    expect(short.acute_chronic_ratio).toBeNull();
    const rows = Array.from({ length: 28 }, (_, i) => row(addDays("2026-10-01", i), 50, i < 21 ? 10 : 15));
    const load = trainingLoad(rows);
    expect(load).toMatchObject({
      acute_strain_7d: 15,
      chronic_strain_28d: 11.25,
      acute_chronic_ratio: 1.33,
      ratio_band: "above usual (ramping up)",
    });
  });
});

describe("the WHOOP day still running", () => {
  // Strap off overnight: the cycle that started on the evening of the 25th never ended.
  const open = [cycle(1, "2026-10-24T22:00:00Z", "2026-10-25T22:00:00Z"), cycle(2, "2026-10-25T22:00:00Z", undefined)];
  const walks = [
    workout("w1", "2026-10-27T07:00:00Z", "2026-10-27T08:00:00Z"),
    workout("w2", "2026-10-27T12:00:00Z", "2026-10-27T13:00:00Z"),
  ];
  const days = assembleDays("2026-10-22", "2026-10-27", open, [], [], walks);

  test("falls back to the open cycle when the last date has none, keeping its workouts", () => {
    const idx = currentDayIndex(days);
    expect(days[idx]?.date).toBe("2026-10-26");
    expect(days[idx]?.workouts.map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  test("keeps the last date when it has its own cycle, or when nothing is open", () => {
    const closed = assembleDays("2026-10-25", "2026-10-27", [open[0]!], [], [], []);
    expect(currentDayIndex(closed)).toBe(2);
    const own = assembleDays("2026-10-25", "2026-10-26", open, [], [], []);
    expect(currentDayIndex(own)).toBe(1);
    expect(currentDayIndex([])).toBe(-1);
  });

  test("data quality separates days before the first data and days inside the open cycle from missed wear", () => {
    const q = dataQuality(days, false, "2026-10-25");
    expect(q.first_data_date).toBe("2026-10-25");
    expect(q.days_before_first_data).toBe(3);
    expect(q.in_open_cycle).toEqual(["2026-10-27"]);
    expect(q.days_missing_data).toEqual([]);
  });

  test("without proof that no older data exists, early gaps stay missing", () => {
    const q = dataQuality(days, false);
    expect(q.first_data_date).toBeUndefined();
    expect(q.days_missing_data).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
  });
});

describe("partial days and sleep shortfall", () => {
  const row = (date: string, extra: Partial<ReturnType<typeof dayRow>> = {}) =>
    ({ ...dayRow({ date, naps: [], workouts: [] }), ...extra }) as ReturnType<typeof dayRow>;

  test("baseline doesn't score today's partial whole-day totals against full days", () => {
    const history = Array.from({ length: 10 }, (_, i) => row(addDays("2026-10-01", i), { strain: 10 + (i % 3) }));
    const b = baseline(history, row("2026-10-11", { strain: 3.1, in_progress: true }), "strain");
    expect(b).toMatchObject({ today: null, today_so_far: 3.1, z_score: null, today_percentile: null });
    expect(b.note).toContain("in progress");
    // Recovery is final in the morning, so it is still compared.
    const r = baseline(
      history.map((h) => ({ ...h, recovery_pct: 50 + (Number(h.date.slice(-1)) % 2) * 10 })),
      row("2026-10-11", { recovery_pct: 80, in_progress: true }),
      "recovery",
    );
    expect(r.z_score).not.toBeNull();
  });

  test("sleep shortfall is the average nightly gap, not a sum that counts carried debt again", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(addDays("2026-10-01", i), { sleep_h: 7, sleep_needed_h: 8 }));
    const load = trainingLoad(rows);
    expect(load.sleep_shortfall_7d_avg_h).toBe(1);
    expect(load).not.toHaveProperty("sleep_debt_7d_h");
  });
});

describe("fetchDays first_data_date", () => {
  const cycles = [cycle(1, "2026-10-25T22:00:00Z", "2026-10-26T22:00:00Z")];
  const getter = (older: unknown[]) => ({
    calls: [] as { path: string; query?: Record<string, unknown> }[],
    async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
      this.calls.push({ path, query });
      if (path === PATHS.cycles && query?.limit === 1) return { records: older } as T;
      return { records: path === PATHS.cycles ? cycles : [] } as T;
    },
  });

  test("is set only when WHOOP has nothing older than the window", async () => {
    const none = await fetchDays(getter([]), "2026-10-20", "2026-10-27");
    expect(none.first_data_date).toBe("2026-10-26");
    const older = cycle(0, "2026-09-01T22:00:00Z", "2026-09-02T22:00:00Z");
    const some = await fetchDays(getter([older]), "2026-10-20", "2026-10-27");
    expect(some.first_data_date).toBeUndefined();
  });

  test("a cycle already fetched in the margin before the range means the gap is missed wear", async () => {
    // Labelled 10-19 (before `from`), fetched because of the two-day margin; then nothing until 10-26.
    const margin = cycle(5, "2026-10-18T23:00:00Z", "2026-10-19T23:00:00Z");
    const g = {
      calls: [] as Record<string, unknown>[],
      async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
        if (query) this.calls.push(query);
        return { records: path === PATHS.cycles ? [margin, ...cycles] : [] } as T;
      },
    };
    const res = await fetchDays(g, "2026-10-20", "2026-10-27");
    expect(res.first_data_date).toBeUndefined();
    expect(g.calls.some((c) => c.limit === 1)).toBe(false);
  });

  test("makes no extra request when the window starts with data", async () => {
    const g = getter([]);
    await fetchDays(g, "2026-10-26", "2026-10-27");
    expect(g.calls.some((c) => c.query?.limit === 1)).toBe(false);
  });
});
