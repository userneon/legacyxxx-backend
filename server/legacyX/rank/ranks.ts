/**
 * Legacy-X rank ladder (RANK-SYSTEM.md section 4). Rank = the highest threshold the player's EXP has reached.
 * The same table lives in legacy_x.competitive_rank_definitions; this copy lets the API and the EXP calculation
 * resolve ranks without a database round trip and is checked against the spec by ranks.test.ts.
 */
export type RankTier = "recruit" | "operator" | "vanguard" | "ace" | "apex" | "legacy";

export interface RankDefinition {
  id: number;
  slug: string;
  name: string;
  tier: RankTier;
  minimumExp: number;
  imageKey: string;
}

export const RANKS: readonly RankDefinition[] = [
  { id: 1, slug: "recruit-i", name: "Recruit I", tier: "recruit", minimumExp: 0, imageKey: "rank-01" },
  { id: 2, slug: "recruit-ii", name: "Recruit II", tier: "recruit", minimumExp: 600, imageKey: "rank-02" },
  { id: 3, slug: "recruit-iii", name: "Recruit III", tier: "recruit", minimumExp: 700, imageKey: "rank-03" },
  { id: 4, slug: "recruit-iv", name: "Recruit IV", tier: "recruit", minimumExp: 800, imageKey: "rank-04" },
  { id: 5, slug: "recruit-v", name: "Recruit V", tier: "recruit", minimumExp: 900, imageKey: "rank-05" },
  { id: 6, slug: "recruit-vi", name: "Recruit VI", tier: "recruit", minimumExp: 950, imageKey: "rank-06" },
  { id: 7, slug: "operator-i", name: "Operator I", tier: "operator", minimumExp: 1000, imageKey: "rank-07" },
  { id: 8, slug: "operator-ii", name: "Operator II", tier: "operator", minimumExp: 1100, imageKey: "rank-08" },
  { id: 9, slug: "operator-iii", name: "Operator III", tier: "operator", minimumExp: 1200, imageKey: "rank-09" },
  { id: 10, slug: "operator-iv", name: "Operator IV", tier: "operator", minimumExp: 1300, imageKey: "rank-10" },
  { id: 11, slug: "vanguard-i", name: "Vanguard I", tier: "vanguard", minimumExp: 1400, imageKey: "rank-11" },
  { id: 12, slug: "vanguard-ii", name: "Vanguard II", tier: "vanguard", minimumExp: 1500, imageKey: "rank-12" },
  { id: 13, slug: "vanguard-iii", name: "Vanguard III", tier: "vanguard", minimumExp: 1600, imageKey: "rank-13" },
  { id: 14, slug: "vanguard-iv", name: "Vanguard IV", tier: "vanguard", minimumExp: 1700, imageKey: "rank-14" },
  { id: 15, slug: "ace-i", name: "Ace I", tier: "ace", minimumExp: 1800, imageKey: "rank-15" },
  { id: 16, slug: "ace-ii", name: "Ace II", tier: "ace", minimumExp: 1950, imageKey: "rank-16" },
  { id: 17, slug: "apex", name: "Apex", tier: "apex", minimumExp: 2100, imageKey: "rank-17" },
  { id: 18, slug: "legacy", name: "Legacy", tier: "legacy", minimumExp: 2300, imageKey: "rank-18" },
];

/** Every player starts here (Operator I). */
export const STARTING_EXP = 1000;
/** Pro League unlocks on reaching this EXP (Vanguard I)… */
export const PRO_LEAGUE_UNLOCK_EXP = 1400;
/** …and is only taken away again below this EXP, so players don't flip in and out. */
export const PRO_LEAGUE_KEEP_EXP = 1350;
export const PRO_LEAGUE_RANK_ID = 11;

export function rankForExp(exp: number): RankDefinition {
  const value = Math.max(0, Math.floor(exp));
  let current = RANKS[0]!;
  for (const rank of RANKS) {
    if (value >= rank.minimumExp) current = rank;
  }
  return current;
}

export function nextRankAfter(rank: RankDefinition): RankDefinition | null {
  return RANKS.find(candidate => candidate.id === rank.id + 1) ?? null;
}

export function rankById(id: number): RankDefinition | null {
  return RANKS.find(rank => rank.id === id) ?? null;
}

/**
 * Pro League access after a match. `wasUnlocked` is the access the player had before the EXP change.
 * Mirrors the rule inside legacy_x.apply_competitive_match_exp.
 */
export function proLeagueUnlocked(exp: number, wasUnlocked: boolean): boolean {
  return exp >= PRO_LEAGUE_UNLOCK_EXP || (wasUnlocked && exp >= PRO_LEAGUE_KEEP_EXP);
}

export interface RankProgress {
  exp: number;
  rank: RankDefinition;
  next: RankDefinition | null;
  /** EXP still needed for the next rank; null at Legacy. */
  expToNext: number | null;
  /** 0–1 share of the way from this rank's threshold to the next one; 1 at Legacy. */
  progress: number;
}

export function rankProgress(exp: number): RankProgress {
  const value = Math.max(0, Math.floor(exp));
  const rank = rankForExp(value);
  const next = nextRankAfter(rank);
  if (!next) return { exp: value, rank, next: null, expToNext: null, progress: 1 };
  const span = next.minimumExp - rank.minimumExp;
  return { exp: value, rank, next, expToNext: next.minimumExp - value, progress: Math.min(1, Math.max(0, (value - rank.minimumExp) / span)) };
}
