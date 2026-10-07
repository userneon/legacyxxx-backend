/** Reactions on reviews: one per player per review, picked from a short fixed list. */
export const REACTIONS = ["like", "love", "funny"] as const;
export type Reaction = (typeof REACTIONS)[number];

export type ReactionSummary = { reactions: Record<Reaction, number>; myReaction: Reaction | null };

export function isReaction(value: unknown): value is Reaction {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

/** Counts per reaction for each review, and which one the viewer picked. Unknown reactions in the data are ignored. */
export function tallyReactions(rows: Array<Record<string, unknown>>, viewerId: string | null) {
  const summaries = new Map<string, ReactionSummary>();
  const empty = (): ReactionSummary => ({ reactions: { like: 0, love: 0, funny: 0 }, myReaction: null });
  for (const row of rows) {
    if (!isReaction(row.reaction)) continue;
    const key = String(row.feedback_id);
    const summary = summaries.get(key) ?? empty();
    summary.reactions[row.reaction] += 1;
    if (viewerId && String(row.user_id) === viewerId) summary.myReaction = row.reaction;
    summaries.set(key, summary);
  }
  return { summaryFor: (feedbackId: string): ReactionSummary => summaries.get(feedbackId) ?? empty() };
}
