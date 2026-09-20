/**
 * Builds the public match detail (rosters, per-player stats, round timeline) from MatchZy data:
 * rank_match_results rows (one per player per map), match_rounds rows (one per round_end) and the
 * original map_result payload (team names).
 */
type Row = Record<string, unknown>;
type TeamKey = "team1" | "team2";

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0)) || 0;
const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const first = (value: unknown): Row => obj(Array.isArray(value) ? value[0] : value);
const round1 = (value: number) => Math.round(value * 10) / 10;

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

export function mapMatchPlayer(row: Row) {
  const stats = obj(row.stats);
  const user = first(row.users);
  const kills = num(row.kills);
  const deaths = num(row.deaths);
  const roundsPlayed = num(stats.rounds_played);
  // Fields added to the MatchZy normaliser later are absent on older rows; report them as null, not 0.
  const has = (field: string) => field in stats;
  return {
    userId: str(user.id) || null,
    steamId: str(user.steam_id),
    username: str(user.username) || "Unknown player",
    avatar: str(user.avatar),
    kills,
    deaths,
    assists: num(row.assists),
    kdDiff: kills - deaths,
    headshotPercent: kills > 0 ? round1((num(row.headshot_kills) / kills) * 100) : 0,
    adr: has("damage") && roundsPlayed > 0 ? round1(num(stats.damage) / roundsPlayed) : null,
    kastPercent: has("kast") && roundsPlayed > 0 ? round1((num(stats.kast) / roundsPlayed) * 100) : null,
    mvps: has("mvp") ? num(stats.mvp) : null,
    utilityDamage: has("utility_damage") ? num(stats.utility_damage) : null,
    enemiesFlashed: has("enemies_flashed") ? num(stats.enemies_flashed) : null,
    firstKills: has("first_kills_t") || has("first_kills_ct") ? num(stats.first_kills_t) + num(stats.first_kills_ct) : null,
    firstDeaths: has("first_deaths_t") || has("first_deaths_ct") ? num(stats.first_deaths_t) + num(stats.first_deaths_ct) : null,
    multiKills: has("3k") ? { k3: num(stats["3k"]), k4: num(stats["4k"]), k5: num(stats["5k"]) } : null,
    clutchesWon: has("1v1") ? ["1v1", "1v2", "1v3", "1v4", "1v5"].reduce((sum, key) => sum + num(stats[key]), 0) : null,
    ratingDelta: num(row.rating_delta),
    roundsPlayed,
  };
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

export function mapMatchDetail(input: { matchId: string; mapNumber: number; results: Row[]; rounds: Row[]; receiptPayload: unknown }) {
  const payload = obj(input.receiptPayload);
  const teamKeys: TeamKey[] = ["team1", "team2"];
  const teams = teamKeys.map((key) => {
    const rows = input.results.filter((row) => str(row.team_key) === key);
    const players = rows.map(mapMatchPlayer).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return {
      key,
      name: str(obj(payload[key]).name) || (key === "team1" ? "Team 1" : "Team 2"),
      score: rows.length ? num(rows[0]!.score_for) : num(obj(payload[key]).score),
      won: rows.some((row) => str(row.outcome) === "win"),
      players,
    };
  });
  const sample = input.results[0] ?? {};
  return {
    matchId: input.matchId,
    mapNumber: input.mapNumber,
    mapName: str(sample.map_name),
    playedAt: str(sample.created_at) || null,
    winner: teams.find((team) => team.won)?.key ?? null,
    teams,
    rounds: mapMatchRounds(input.rounds),
  };
}

/** Profile "Recent matches" entry from a MatchZy result row; carries the ids needed to open match details. */
export function mapRankedRecentMatch(row: Row) {
  const kills = num(row.kills);
  const deaths = num(row.deaths);
  return {
    map: str(row.map_name),
    result: str(row.outcome) === "win" ? "Win" : "Loss",
    score: `${num(row.score_for)}:${num(row.score_against)}`,
    kd: (kills / Math.max(1, deaths)).toFixed(2),
    matchId: str(row.match_external_id),
    mapNumber: num(row.map_number),
    playedAt: str(row.created_at) || null,
  };
}
