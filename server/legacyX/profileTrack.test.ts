import { describe, expect, it } from "vitest";
import { buildTrack } from "./profileTrack";

const row = (over: Record<string, unknown>, stats: Record<string, unknown> = {}) => ({
  match_id: "m" + Math.random(),
  outcome: "win",
  exp_delta: 10,
  created_at: "2026-11-10T12:00:00Z",
  core_matches: { map_name: "de_mirage", finished_at: "2026-11-10T12:00:00Z" },
  stats: { kills: 20, deaths: 10, assists: 5, headshot_kills: 10, rounds_played: 24, mvps: 3, entry_kills: 2, clutches_won: 1, clutches_won_1v3_plus: 0, rounds_3k: 2, rounds_4k: 1, rounds_5k: 0, bomb_plants: 1, bomb_defuses: 0, ...stats },
  ...over,
});

describe("buildTrack", () => {
  it("has nothing to show for no matches", () => {
    const track = buildTrack([]);
    expect(track.matches).toBe(0);
    expect(track.rates.kd).toBeNull();
    expect(track.best).toBeNull();
    expect(track.form).toEqual([]);
  });

  it("adds up what the plugin reported", () => {
    const track = buildTrack([row({}), row({ outcome: "loss", exp_delta: -14 }, { kills: 10, deaths: 20, headshot_kills: 2 })]);
    expect(track.matches).toBe(2);
    expect(track.record).toEqual({ wins: 1, losses: 1, draws: 0, winRate: 50 });
    expect(track.totals.kills).toBe(30);
    expect(track.rates.kd).toBe(1);
    expect(track.rates.headshotPercent).toBe(40);
    expect(track.rates.killsPerRound).toBe(0.63);
    expect(track.multiKills.rounds3k).toBe(4);
    expect(track.rates.expPerMatch).toBe(-2);
    expect(track.best?.kills).toBe(20);
    expect(track.worst?.kills).toBe(10);
  });

  it("tracks streaks from the newest match back", () => {
    const rows = [row({}), row({}), row({ outcome: "loss" }), row({}), row({}), row({}), row({ outcome: "loss" })];
    const track = buildTrack(rows);
    expect(track.streaks.current).toEqual({ type: "win", count: 2 });
    expect(track.streaks.bestWin).toBe(3);
    expect(track.streaks.bestLoss).toBe(1);
  });

  it("groups maps and puts the form oldest first", () => {
    const track = buildTrack([
      row({ core_matches: { map_name: "de_inferno", finished_at: "2026-11-12T12:00:00Z" } }),
      row({}),
      row({}),
    ]);
    expect(track.maps.map((entry) => [entry.map, entry.matches])).toEqual([["de_mirage", 2], ["de_inferno", 1]]);
    expect(track.form[track.form.length - 1].map).toBe("de_inferno");
  });

  it("reads the weekday and hour in Ulaanbaatar time", () => {
    // 2026-11-10 is a Tuesday; 12:00 UTC is 20:00 in Ulaanbaatar.
    const track = buildTrack([row({})]);
    expect(track.activity.weekdays[1]).toBe(1);
    expect(track.activity.hours[20]).toBe(1);
  });
});
