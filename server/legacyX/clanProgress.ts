/**
 * Clan level, stats, achievements and Clan War rating (owner request 2026-10-25, "clan features are limited").
 *
 * - Level: a clan earns XP when its members finish ranked matches while in the clan (win 25, draw 15, loss 10, a leaver nothing) and
 *   when it wins (100) or plays (40) a Clan War. Levels unlock extra member slots (`LEVEL_PERKS`), given once per level.
 * - Stats: summed from the members' own ranked match rows since they joined; nothing is estimated.
 * - Achievements: thresholds over those real totals.
 * - Clan War: an Elo rating (start 1000, K 32) moved only by finished wars.
 */

export const MATCH_XP = { win: 25, draw: 15, loss: 10 } as const;
export const WAR_XP = { win: 100, played: 40 } as const;

/** XP needed to reach each level (index = level - 1): every level costs 100 more than the one before. */
export const LEVEL_FLOORS = [0, 250, 600, 1050, 1600, 2250, 3000, 3850, 4800, 5850, 7000, 8250, 9600, 11050, 12600] as const;
export const MAX_LEVEL = LEVEL_FLOORS.length;

/** What a level unlocks; extra slots are added to the clan once, the first time it reaches the level. */
export const LEVEL_PERKS: ReadonlyArray<{ level: number; slots: number; perk: string }> = [
  { level: 2, slots: 0, perk: "Level badge on the clan card" },
  { level: 3, slots: 1, perk: "+1 member slot" },
  { level: 5, slots: 1, perk: "+1 member slot, silver level ring" },
  { level: 7, slots: 1, perk: "+1 member slot" },
  { level: 10, slots: 2, perk: "+2 member slots, gold level ring" },
  { level: 15, slots: 2, perk: "+2 member slots, violet level ring" },
];

export function levelFor(xp: number) {
  const safe = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  for (let index = 0; index < LEVEL_FLOORS.length; index += 1) if (safe >= LEVEL_FLOORS[index]) level = index + 1;
  const floor = LEVEL_FLOORS[level - 1];
  const next = level < MAX_LEVEL ? LEVEL_FLOORS[level] : null;
  return { level, xp: safe, floor, next };
}

export function matchXp(outcome: string, leaver: boolean) {
  if (leaver) return 0;
  return outcome === "win" ? MATCH_XP.win : outcome === "draw" ? MATCH_XP.draw : MATCH_XP.loss;
}

/** Elo change for side A after a war (score 1 win, 0.5 draw, 0 loss); side B moves by the opposite. */
export function warRatingChange(ratingA: number, ratingB: number, scoreA: 0 | 0.5 | 1, k = 32) {
  const expected = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  return Math.round(k * (scoreA - expected));
}

export type ClanMatchRow = {
  user_id: string;
  match_id: string;
  outcome: string;
  exp_delta: number;
  created_at: string;
  leaver: boolean;
  stats: Record<string, unknown>;
};

const count = (stats: Record<string, unknown>, key: string) => {
  const value = Number(stats[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

/** Totals and per-member lines from the members' ranked rows (already limited to the time each was in the clan). */
export function clanStats(rows: ClanMatchRow[], now = Date.now()) {
  const totals = { matches: 0, wins: 0, draws: 0, losses: 0, kills: 0, deaths: 0, assists: 0, headshots: 0, aces: 0, clutches: 0, rounds: 0 };
  const matchIds = new Set<string>();
  const people = new Map<string, { userId: string; matches: number; wins: number; kills: number; deaths: number; headshots: number; weekExp: number }>();
  const weekAgo = now - 7 * 86_400_000;
  for (const row of rows) {
    const stats = row.stats ?? {};
    const line = people.get(row.user_id) ?? { userId: row.user_id, matches: 0, wins: 0, kills: 0, deaths: 0, headshots: 0, weekExp: 0 };
    const kills = count(stats, "kills");
    const deaths = count(stats, "deaths");
    const headshots = count(stats, "headshot_kills");
    line.matches += 1;
    line.kills += kills;
    line.deaths += deaths;
    line.headshots += headshots;
    if (row.outcome === "win") line.wins += 1;
    if (Date.parse(row.created_at) >= weekAgo) line.weekExp += Number(row.exp_delta) || 0;
    people.set(row.user_id, line);
    totals.kills += kills;
    totals.deaths += deaths;
    totals.headshots += headshots;
    totals.assists += count(stats, "assists");
    totals.rounds += count(stats, "rounds_played");
    totals.aces += count(stats, "5k");
    totals.clutches += ["1v1", "1v2", "1v3", "1v4", "1v5"].reduce((sum, key) => sum + count(stats, key), 0);
    // A match counts once for the clan however many members played it; its result is the first member's (they share a team in a clan match).
    if (!matchIds.has(row.match_id)) {
      matchIds.add(row.match_id);
      totals.matches += 1;
      if (row.outcome === "win") totals.wins += 1;
      else if (row.outcome === "draw") totals.draws += 1;
      else totals.losses += 1;
    }
  }
  const lines = Array.from(people.values());
  const best = <T,>(list: T[], score: (entry: T) => number) => list.filter((entry) => score(entry) > 0).sort((a, b) => score(b) - score(a))[0] ?? null;
  const kd = (entry: { kills: number; deaths: number }) => entry.kills / Math.max(1, entry.deaths);
  return {
    totals: {
      ...totals,
      kd: totals.deaths ? Math.round((totals.kills / totals.deaths) * 100) / 100 : totals.kills ? totals.kills : 0,
      winRate: totals.matches ? Math.round((totals.wins / totals.matches) * 1000) / 10 : 0,
      headshotRate: totals.kills ? Math.round((totals.headshots / totals.kills) * 1000) / 10 : 0,
    },
    leaders: {
      kills: best(lines, (entry) => entry.kills),
      kd: best(lines.filter((entry) => entry.matches >= 5), (entry) => kd(entry)),
      wins: best(lines, (entry) => entry.wins),
      weekMvp: best(lines, (entry) => entry.weekExp),
    },
    members: lines,
  };
}

type AchievementInput = { wins: number; matches: number; aces: number; clutches: number; warsWon: number; level: number; members: number };

const LADDERS: ReadonlyArray<{ id: string; title: string; key: keyof AchievementInput; goals: number[] }> = [
  { id: "wins", title: "Wins", key: "wins", goals: [10, 50, 100, 500] },
  { id: "matches", title: "Matches played", key: "matches", goals: [50, 250, 1000] },
  { id: "aces", title: "Aces", key: "aces", goals: [1, 10, 50] },
  { id: "clutches", title: "Clutches", key: "clutches", goals: [10, 50, 200] },
  { id: "wars", title: "Clan Wars won", key: "warsWon", goals: [1, 10, 50] },
  { id: "level", title: "Clan level", key: "level", goals: [5, 10, 15] },
  { id: "members", title: "Members", key: "members", goals: [10, 25] },
];

/** Each ladder at its next goal: tier is how many goals are done (0 to all), progress the real value. */
export function clanAchievements(input: AchievementInput) {
  return LADDERS.map((ladder) => {
    const value = Math.max(0, Math.floor(Number(input[ladder.key]) || 0));
    const tier = ladder.goals.filter((goal) => value >= goal).length;
    const goal = ladder.goals[Math.min(tier, ladder.goals.length - 1)];
    return { id: ladder.id, title: ladder.title, tier, tiers: ladder.goals.length, value, goal, complete: tier === ladder.goals.length };
  });
}

/**
 * Which clan each team of a finished match stands for, when it is a Clan War: at least `min(3, team size)` players of a team from
 * one clan, and the two teams from different clans. Null for any other match.
 */
export function warSides(players: Array<{ userId: string; team: string }>, clanOf: Map<string, string>) {
  const teams = new Map<string, string[]>();
  for (const player of players) teams.set(player.team, [...(teams.get(player.team) ?? []), player.userId]);
  if (teams.size !== 2) return null;
  const sides: Array<{ team: string; clanId: string }> = [];
  for (const [team, ids] of Array.from(teams.entries())) {
    const counts = new Map<string, number>();
    for (const id of ids) { const clan = clanOf.get(id); if (clan) counts.set(clan, (counts.get(clan) ?? 0) + 1); }
    const [clanId, size] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (!clanId || size < Math.min(3, ids.length)) return null;
    sides.push({ team, clanId });
  }
  if (sides[0].clanId === sides[1].clanId) return null;
  return sides;
}
