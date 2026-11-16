import { describe, expect, it } from "vitest";
import { historyQuery, historyRow } from "./profileHistory";

describe("historyQuery", () => {
  it("accepts a cursor, a result and a map", () => {
    expect(historyQuery.parse({ before: "2026-11-10T12:00:00.000Z", result: "win", map: "de_mirage" })).toEqual({ before: "2026-11-10T12:00:00.000Z", result: "win", map: "de_mirage" });
    expect(historyQuery.parse({})).toEqual({});
  });
  it("refuses anything else", () => {
    expect(() => historyQuery.parse({ result: "draw" })).toThrow();
    expect(() => historyQuery.parse({ before: "yesterday" })).toThrow();
  });
});

describe("historyRow", () => {
  it("adds kills, deaths, assists and the headshot share to the recent-match row", () => {
    const row = historyRow({ match_id: "m1", outcome: "win", team_key: "team1", exp_delta: 12, exp_after: 100, created_at: "2026-11-10T12:00:00Z", core_matches: { map_name: "de_mirage", finished_at: "2026-11-10T12:00:00Z", result: null }, stats: { kills: 20, deaths: 10, assists: 4, headshot_kills: 9, mvps: 3 } });
    expect(row).toMatchObject({ matchId: "m1", map: "de_mirage", kills: 20, deaths: 10, assists: 4, headshotPercent: 45, mvps: 3, kd: "2.00" });
  });
  it("has no headshot share without kills", () => {
    expect(historyRow({ outcome: "loss", stats: { kills: 0, deaths: 5 } }).headshotPercent).toBeNull();
  });
});
