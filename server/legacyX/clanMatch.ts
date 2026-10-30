import type { SupabaseClient } from "@supabase/supabase-js";

import { LEVEL_PERKS, levelFor, matchXp } from "./clanProgress";

type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, any>;

type FinishedPlayer = { userId: string; outcome: "win" | "draw" | "loss"; breakdown: { rule?: string } };

const tell = async (db: Db, userIds: string[], title: string, body: string, metadata: Record<string, unknown>) => {
  if (!userIds.length) return;
  const { error } = await db.from("notifications").insert(userIds.map((userId) => ({ user_id: userId, kind: "clan", title: title.slice(0, 120), body: body.slice(0, 500), metadata })));
  if (error) console.warn("[legacy-x-api] clan notification not saved", error.message);
};

/** Extra member slots for every level the clan has reached since the last time this ran (each level pays once). */
export async function applyLevelPerks(db: Db, clanId: string) {
  const { data: progress } = await db.from("clan_progress").select("xp,perk_level").eq("clan_id", clanId).maybeSingle();
  if (!progress) return;
  const { level } = levelFor(Number(progress.xp));
  const done = Number(progress.perk_level) || 1;
  if (level <= done) return;
  // Claimed first, so two matches finishing together cannot both hand out the same slots.
  const claimed = await db.from("clan_progress").update({ perk_level: level, updated_at: new Date().toISOString() }).eq("clan_id", clanId).eq("perk_level", done).select("clan_id");
  if (claimed.error || !(claimed.data ?? []).length) return;
  const slots = LEVEL_PERKS.filter((perk) => perk.level > done && perk.level <= level).reduce((sum, perk) => sum + perk.slots, 0);
  if (slots > 0) {
    const { data: clan } = await db.from("clans").select("max_players").eq("id", clanId).maybeSingle();
    if (clan) await db.from("clans").update({ max_players: Number(clan.max_players) + slots }).eq("id", clanId).eq("max_players", clan.max_players);
  }
  const { data: managers } = await db.from("clan_members").select("user_id").eq("clan_id", clanId).in("role", ["leader", "co-leader"]);
  await tell(db, ((managers ?? []) as Row[]).map((row) => String(row.user_id)), `Clan level ${level}`, slots > 0 ? `Your clan reached level ${level} and got ${slots} more member slot${slots === 1 ? "" : "s"}.` : `Your clan reached level ${level}.`, { kind: "clan_level", level });
}

const addXp = async (db: Db, clanId: string, ref: string, xp: number, reason: string) => {
  if (xp <= 0) return;
  const { error } = await db.rpc("add_clan_xp", { p_clan_id: clanId, p_ref: ref, p_xp: xp, p_reason: reason });
  if (error) throw error;
};

/**
 * After a ranked match: clan XP for every member who played it (in the clan before the match ended). A replayed match changes nothing (refs).
 */
export async function recordClanMatch(db: Db, matchId: string, players: FinishedPlayer[], finishedAt: Date) {
  if (!players.length) return;
  const { data, error } = await db.from("clan_members").select("user_id,clan_id,created_at").in("user_id", players.map((player) => player.userId));
  if (error) throw error;
  const clanOf = new Map<string, string>();
  for (const row of (data ?? []) as Row[]) if (Date.parse(String(row.created_at)) <= finishedAt.getTime()) clanOf.set(String(row.user_id), String(row.clan_id));
  const touched = new Set<string>();
  for (const player of players) {
    const clanId = clanOf.get(player.userId);
    if (!clanId) continue;
    await addXp(db, clanId, `match:${matchId}:${player.userId}`, matchXp(player.outcome, player.breakdown?.rule === "leaver"), "match");
    touched.add(clanId);
  }

  for (const clanId of Array.from(touched)) await applyLevelPerks(db, clanId);
}
