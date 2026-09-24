/**
 * Match rows for the website: the ranked match history entry (competitive_match_exp + core_matches) and the
 * round timeline (match_rounds, one row per MatchZy round_end).
 */
type Row = Record<string, unknown>;
type TeamKey = "team1" | "team2";

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0)) || 0;
const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

export type RoundOutcome = "elimination" | "bomb_exploded" | "bomb_defused" | "time_expired" | "surrender" | "other";

/**
 * CS2 RoundEndReason codes as sent in MatchZy round_end.reason. Unknown codes still render as "other",
 * so a mismatch only affects the icon, never the round winner.
 */
export function roundOutcome(reason: unknown): RoundOutcome {
  switch (num(reason)) {
    case 1: return "bomb_exploded";
    case 7: return "bomb_defused";
    case 8:
    case 9: return "elimination";
    case 12: return "time_expired";
    case 17:
    case 18: return "surrender";
    default: return "other";
  }
}

/** MatchZy's round_end winner.team is the map leader, so the round winner is whichever score went up. */
export function mapMatchRounds(rows: Row[]) {
  let previous = { team1: 0, team2: 0 };
  return [...rows]
    .sort((a, b) => num(a.round_number) - num(b.round_number))
    .map((row) => {
      const score = { team1: num(row.team1_score), team2: num(row.team2_score) };
      const team1Up = score.team1 > previous.team1;
      const team2Up = score.team2 > previous.team2;
      const winnerTeam: TeamKey | null = team1Up && !team2Up ? "team1" : team2Up && !team1Up ? "team2" : null;
      previous = score;
      const side = str(row.winner_side);
      return {
        number: num(row.round_number),
        winnerTeam,
        winnerSide: side === "t" || side === "ct" ? side : null,
        outcome: roundOutcome(row.reason),
        score,
      };
    });
}

/**
 * Ranked match row (competitive_match_exp joined with core_matches) for the profile and match lists:
 * result, score from the player's side, K/D and the EXP change with its breakdown.
 */
export function mapCompetitiveMatch(row: Row) {
  const match = (row.core_matches ?? {}) as Row;
  const result = (match.result ?? {}) as Row;
  const competitive = (result.competitive_result ?? {}) as Row;
  const own = str(row.team_key) === "team2" ? "team2" : "team1";
  const other = own === "team1" ? "team2" : "team1";
  const roundsFor = (competitive[own] as Row | undefined)?.rounds_won;
  const roundsAgainst = (competitive[other] as Row | undefined)?.rounds_won;
  const stats = (row.stats ?? {}) as Row;
  const breakdown = (row.exp_breakdown ?? {}) as Row;
  const kills = num(stats.kills);
  const deaths = num(stats.deaths);
  const outcome = str(row.outcome);
  return {
    eventId: str(row.event_id),
    matchId: str(row.match_id),
    map: str(match.map_name) || str(result.map_name),
    outcome: outcome === "win" || outcome === "draw" ? outcome : "loss",
    score: typeof roundsFor === "number" && typeof roundsAgainst === "number" ? { for: roundsFor, against: roundsAgainst } : null,
    kills,
    deaths,
    assists: num(stats.assists),
    kd: Number((kills / Math.max(1, deaths)).toFixed(2)),
    expBefore: num(row.exp_before),
    expDelta: num(row.exp_delta),
    expAfter: num(row.exp_after),
    rankBefore: num(row.rank_before),
    rankAfter: num(row.rank_after),
    countsAsRanked: row.counts_as_ranked === true,
    breakdown: {
      reason: str(breakdown.reason) || "ranked",
      result: num(breakdown.result),
      margin: num(breakdown.margin),
      performance: num(breakdown.performance),
      bonus: num(breakdown.bonus),
      calibration: num(breakdown.calibration) || 1,
      shortHandedHalved: breakdown.shortHandedHalved === true,
      omittedTerms: Array.isArray(breakdown.omittedTerms) ? breakdown.omittedTerms.map(String) : [],
    },
    calculationVersion: str(row.calculation_version),
    playedAt: str(match.finished_at) || str(row.created_at) || null,
  };
}
