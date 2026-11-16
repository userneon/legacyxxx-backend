import { z } from "zod";

import { mapExpRecentMatch } from "./matchDetails";

type Row = Record<string, unknown>;

export const HISTORY_PAGE = 25;

/** `before` is a timestamp from an earlier page, `result` is win or loss, `map` is a map name; anything else is refused. */
export const historyQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  result: z.enum(["win", "loss"]).optional(),
  map: z.string().trim().min(1).max(64).optional(),
});

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A match in the History list: the Recent matches row plus the player's kills, deaths, assists and headshot share. */
export function historyRow(row: Row) {
  const stats = row.stats && typeof row.stats === "object" && !Array.isArray(row.stats) ? (row.stats as Row) : {};
  const kills = num(stats.kills);
  return {
    ...mapExpRecentMatch(row),
    kills,
    deaths: num(stats.deaths),
    assists: num(stats.assists),
    headshotPercent: kills > 0 ? Math.round((num(stats.headshot_kills) / kills) * 100) : null,
    mvps: num(stats.mvps),
  };
}
