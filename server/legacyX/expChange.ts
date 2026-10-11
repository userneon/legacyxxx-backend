/**
 * Home's top players show whether a player's EXP just went up or down: the EXP change of their most recent ranked match,
 * if that match was played within the last two days. Older than that, or no ranked match yet, there is no change to show.
 */
export const EXP_CHANGE_WINDOW_MS = 48 * 3_600_000;

type ExpRow = { user_id: string; exp_delta: number; created_at: string };

/** The newest delta per player, only when it is recent. Rows may come in any order. */
export function latestExpChanges(rows: ExpRow[], now = Date.now(), windowMs = EXP_CHANGE_WINDOW_MS): Map<string, number> {
  const newest = new Map<string, ExpRow>();
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at) || now - at > windowMs || typeof row.exp_delta !== "number") continue;
    const seen = newest.get(row.user_id);
    if (!seen || at > Date.parse(seen.created_at)) newest.set(row.user_id, row);
  }
  return new Map(Array.from(newest.entries()).map(([id, row]) => [id, row.exp_delta]));
}
