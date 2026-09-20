import { describe, expect, it } from "vitest";
import { mapMatchDetail, mapMatchRounds, mapRankedRecentMatch, roundOutcome } from "./matchDetails";

const player = (steamId: string, team: string, kills: number, deaths: number, stats: Record<string, unknown> = {}) => ({
  event_id: "matchzy:42:1:map_result",
  team_key: team,
  outcome: team === "team1" ? "win" : "loss",
  score_for: team === "team1" ? 13 : 9,
  map_name: "de_mirage",
  kills,
  deaths,
  assists: 3,
  headshot_kills: Math.floor(kills / 2),
  rating_delta: team === "team1" ? 30 : -18,
  stats: { rounds_played: 22, ...stats },
  created_at: "2026-09-19T10:00:00Z",
  users: { id: `user-${steamId}`, steam_id: steamId, username: `P${steamId}`, avatar: "" },
});

describe("match details", () => {
  it("derives each round winner from score changes, ignoring MatchZy's map-leader winner.team", () => {
    const rounds = mapMatchRounds([
      { round_number: 2, winner_side: "t", reason: 1, team1_score: 1, team2_score: 1 },
      { round_number: 1, winner_side: "ct", reason: 8, team1_score: 1, team2_score: 0 },
      { round_number: 3, winner_side: "ct", reason: 7, team1_score: 2, team2_score: 1 },
    ]);
    expect(rounds.map((round) => [round.number, round.winnerTeam, round.winnerSide, round.outcome])).toEqual([
      [1, "team1", "ct", "elimination"],
      [2, "team2", "t", "bomb_exploded"],
      [3, "team1", "ct", "bomb_defused"],
    ]);
  });

  it("builds rosters sorted by kills with derived ADR, KAST and HS% and team names from the map_result payload", () => {
    const detail = mapMatchDetail({
      matchId: "42",
      mapNumber: 1,
      results: [
        player("1", "team1", 12, 15, { damage: 1540, kast: 15, mvp: 2, "3k": 1, "4k": 0, "5k": 0, "1v1": 1, "1v2": 1 }),
        player("2", "team1", 25, 10),
        player("3", "team2", 18, 16),
      ],
      rounds: [],
      receiptPayload: { team1: { name: "LEGACY Blue" }, team2: { name: "LEGACY Orange" } },
    });

    expect(detail.winner).toBe("team1");
    expect(detail.teams.map((team) => [team.name, team.score, team.won])).toEqual([["LEGACY Blue", 13, true], ["LEGACY Orange", 9, false]]);
    expect(detail.teams[0]!.players.map((p) => p.steamId)).toEqual(["2", "1"]);
    const detailed = detail.teams[0]!.players[1]!;
    expect(detailed).toMatchObject({ adr: 70, kastPercent: 68.2, mvps: 2, headshotPercent: 50, kdDiff: -3, clutchesWon: 2, multiKills: { k3: 1, k4: 0, k5: 0 } });
    // Rows ingested before detail stats were kept report null instead of a misleading 0.
    expect(detail.teams[0]!.players[0]).toMatchObject({ adr: null, kastPercent: null, mvps: null, clutchesWon: null });
  });

  it("maps recent matches with the ids needed to open details", () => {
    expect(mapRankedRecentMatch({ match_external_id: "42", map_number: 1, map_name: "de_nuke", outcome: "win", score_for: 13, score_against: 7, kills: 20, deaths: 0, created_at: "2026-09-19T10:00:00Z" }))
      .toEqual({ map: "de_nuke", result: "Win", score: "13:7", kd: "20.00", matchId: "42", mapNumber: 1, playedAt: "2026-09-19T10:00:00Z" });
    expect(roundOutcome(999)).toBe("other");
  });
});
