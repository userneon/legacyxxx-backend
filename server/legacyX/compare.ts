/**
 * Compare page, head to head (owner request 2026-10-26, "more Compare features"): the ranked matches two players were both in,
 * against each other (who won) and on the same team (how that team did). Only real competitive_match_exp rows.
 */
export type HeadRow = { match_id: string; team_key: string; outcome: string; created_at: string; map_name?: string | null; stats?: Record<string, unknown> | null };

const kills = (row: HeadRow) => Number((row.stats ?? {}).kills) || 0;

export function headToHead(aRows: HeadRow[], bRows: HeadRow[], recentLimit = 10) {
  const bByMatch = new Map(bRows.map((row) => [row.match_id, row]));
  const against = { matches: 0, aWins: 0, bWins: 0, draws: 0, aKills: 0, bKills: 0 };
  const together = { matches: 0, wins: 0, losses: 0, draws: 0 };
  const recent: Array<{ matchId: string; map: string | null; at: string; together: boolean; outcome: "a" | "b" | "draw" | "win" | "loss"; aKills: number; bKills: number }> = [];
  const sorted = [...aRows].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
  for (const a of sorted) {
    const b = bByMatch.get(a.match_id);
    if (!b) continue;
    const same = a.team_key === b.team_key;
    if (same) {
      together.matches += 1;
      if (a.outcome === "win") together.wins += 1; else if (a.outcome === "draw") together.draws += 1; else together.losses += 1;
    } else {
      against.matches += 1;
      against.aKills += kills(a);
      against.bKills += kills(b);
      if (a.outcome === "win") against.aWins += 1; else if (b.outcome === "win") against.bWins += 1; else against.draws += 1;
    }
    if (recent.length < recentLimit) {
      const outcome = same ? (a.outcome === "win" ? "win" : a.outcome === "draw" ? "draw" : "loss") : a.outcome === "win" ? "a" : b.outcome === "win" ? "b" : "draw";
      recent.push({ matchId: a.match_id, map: a.map_name ?? null, at: a.created_at, together: same, outcome, aKills: kills(a), bKills: kills(b) });
    }
  }
  return { against, together, recent };
}
