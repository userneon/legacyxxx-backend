import { describe, expect, it } from "vitest";
import { headToHead } from "./compare";

const row = (match: string, team: string, outcome: string, killCount: number, at: string) => ({ match_id: match, team_key: team, outcome, created_at: at, map_name: "de_mirage", stats: { kills: killCount } });

describe("head to head", () => {
  it("splits shared matches into against and together, newest first", () => {
    const a = [row("m1", "team1", "win", 20, "2026-10-20T10:00:00Z"), row("m2", "team1", "loss", 10, "2026-10-21T10:00:00Z"), row("m3", "team2", "win", 15, "2026-10-22T10:00:00Z"), row("m4", "team1", "win", 9, "2026-10-23T10:00:00Z")];
    const b = [row("m1", "team2", "loss", 12, "2026-10-20T10:00:00Z"), row("m2", "team2", "win", 18, "2026-10-21T10:00:00Z"), row("m3", "team2", "win", 11, "2026-10-22T10:00:00Z")];
    const result = headToHead(a, b);
    expect(result.against).toEqual({ matches: 2, aWins: 1, bWins: 1, draws: 0, aKills: 30, bKills: 30 });
    expect(result.together).toEqual({ matches: 1, wins: 1, losses: 0, draws: 0 });
    expect(result.recent.map((entry) => entry.matchId)).toEqual(["m3", "m2", "m1"]);
    expect(result.recent[0]).toMatchObject({ together: true, outcome: "win" });
    expect(result.recent[1]).toMatchObject({ together: false, outcome: "b" });
  });
  it("is empty when they never met", () => {
    expect(headToHead([row("m1", "team1", "win", 1, "2026-10-20T10:00:00Z")], []).against.matches).toBe(0);
  });
});
