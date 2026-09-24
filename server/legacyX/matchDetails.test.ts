import { describe, expect, it } from "vitest";
import { mapCompetitiveMatch, mapMatchRounds, roundOutcome } from "./matchDetails";

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

  it("labels unknown round end reasons as other", () => {
    expect(roundOutcome(999)).toBe("other");
  });

  it("maps a ranked match row with the score from the player's side and the EXP breakdown", () => {
    const row = mapCompetitiveMatch({
      event_id: "final-1", match_id: "m-1", team_key: "team2", outcome: "loss",
      exp_before: 1000, exp_delta: -12, exp_after: 988, rank_before: 7, rank_after: 6, counts_as_ranked: true,
      exp_breakdown: { reason: "ranked", result: -19.2, margin: -1, performance: 8, bonus: 0, calibration: 1, omittedTerms: ["bombPlants"] },
      stats: { kills: 22, deaths: 11, assists: 3 },
      calculation_version: "rank-v1.0", created_at: "2026-09-24T10:00:00Z",
      core_matches: { map_name: "de_nuke", finished_at: "2026-09-24T09:59:00Z", result: { competitive_result: { team1: { rounds_won: 13 }, team2: { rounds_won: 9 } } } },
    });
    expect(row).toMatchObject({ map: "de_nuke", outcome: "loss", score: { for: 9, against: 13 }, kd: 2, expDelta: -12, rankAfter: 6, playedAt: "2026-09-24T09:59:00Z" });
    expect(row.breakdown).toMatchObject({ reason: "ranked", result: -19.2, performance: 8, omittedTerms: ["bombPlants"] });
  });
});
