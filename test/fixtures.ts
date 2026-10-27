import type { Cycle, Recovery, Sleep, Workout } from "../src/whoop/data.ts";

/** WHOOP v2 records shaped like real API responses, for the data and tool tests. */
const base = { user_id: 1, created_at: "2026-10-27T09:00:00Z", updated_at: "2026-10-27T09:00:00Z" };

export function cycle(id: number, start: string, end: string | undefined, extra: Partial<Cycle> = {}): Cycle {
  return {
    ...base,
    id,
    start,
    end,
    timezone_offset: "Z",
    score_state: "SCORED",
    score: { strain: 10, kilojoule: 8368, average_heart_rate: 80, max_heart_rate: 150 },
    step_count: 8000,
    ...extra,
  };
}

export function sleep(id: string, cycleId: number, start: string, end: string, nap = false): Sleep {
  return {
    ...base,
    id,
    cycle_id: cycleId,
    start,
    end,
    nap,
    timezone_offset: "Z",
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 8 * 3_600_000,
        total_awake_time_milli: 3_600_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 4 * 3_600_000,
        total_slow_wave_sleep_time_milli: 2 * 3_600_000,
        total_rem_sleep_time_milli: 3_600_000,
        sleep_cycle_count: 4,
        disturbance_count: 5,
      },
      sleep_needed: {
        baseline_milli: 8 * 3_600_000,
        need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 14,
      sleep_performance_percentage: 80,
      sleep_consistency_percentage: 70,
      sleep_efficiency_percentage: 88,
    },
  } as Sleep;
}

export function recovery(cycleId: number, sleepId: string, score = 50): Recovery {
  return {
    ...base,
    cycle_id: cycleId,
    sleep_id: sleepId,
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: score,
      resting_heart_rate: 60,
      hrv_rmssd_milli: 50,
      spo2_percentage: 96,
      skin_temp_celsius: 33.5,
    },
  };
}

export function workout(id: string, start: string, end: string, distance: number | null = null): Workout {
  return {
    ...base,
    id,
    start,
    end,
    timezone_offset: "Z",
    sport_name: "walking",
    score_state: "SCORED",
    score: {
      strain: 8,
      average_heart_rate: 120,
      max_heart_rate: 150,
      kilojoule: 1046,
      percent_recorded: 1,
      distance_meter: distance,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 1_800_000,
        zone_two_milli: 1_200_000,
        zone_three_milli: 600_000,
        zone_four_milli: 0,
        zone_five_milli: 0,
      },
    },
  } as unknown as Workout;
}
