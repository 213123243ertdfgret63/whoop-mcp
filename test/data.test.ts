import { describe, expect, test } from "bun:test";
import { baseline, correlate, slopePerWeek, stats, trainingLoad, trend } from "../src/whoop/analytics.ts";
import {
  addDays,
  assembleDays,
  cycleDate,
  dateRange,
  dayRow,
  listAll,
  localDate,
  localTime,
  offsetMinutes,
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
