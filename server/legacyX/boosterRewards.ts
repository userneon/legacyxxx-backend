import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCommunity } from "./discordCommunity";
import { legacyXError } from "./supabase";

/**
 * What a Discord server booster gets (owner decision 2026-10-17): the Server Booster avatar frame, once, kept for good even when the
 * boosting stops; no coins. It goes to the LEGACY-X profile the member linked Discord to: a booster who links later gets it then.
 * While the member still boosts, the profile also shows a Booster badge (`discordBoosting`).
 */
type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, unknown>;

export const BOOSTER_FRAME_ID = "server-booster";

/** Gives the frame to every linked member who has boosted (optionally only these Discord IDs). Returns how many were checked. */
export async function grantBoosterFrames(db: Db, discordIds?: string[]): Promise<number> {
  let query = db.from("discord_community_stats").select("discord_id").gt("boosts", 0).limit(5000);
  if (discordIds) {
    if (discordIds.length === 0) return 0;
    query = query.in("discord_id", discordIds.slice(0, 200));
  }
  const { data, error } = await query;
  legacyXError(error, "Unable to read Discord boosters");
  const boosters = ((data ?? []) as Row[]).map((row) => String(row.discord_id));
  let granted = 0;
  for (let index = 0; index < boosters.length; index += 200) {
    const { data: links, error: linkError } = await db.from("discord_links").select("user_id").in("discord_id", boosters.slice(index, index + 200));
    legacyXError(linkError, "Unable to read Discord links");
    const rows = ((links ?? []) as Row[]).map((link) => ({ user_id: String(link.user_id), item_id: BOOSTER_FRAME_ID, source: "achievement" }));
    if (rows.length === 0) continue;
    const { error: grantError } = await db.from("cosmetic_owned").upsert(rows, { onConflict: "user_id,item_id", ignoreDuplicates: true });
    legacyXError(grantError, "Unable to give the booster frame");
    granted += rows.length;
  }
  return granted;
}

/** True while this user's linked Discord account boosts the server. Never throws: the badge is decoration. */
export async function isBoostingNow(db: Db, userId: string): Promise<boolean> {
  try {
    const { data: link } = await db.from("discord_links").select("discord_id").eq("user_id", userId).maybeSingle();
    if (!link) return false;
    const { data } = await db.from("discord_community_stats").select("boosting").eq("discord_id", String((link as Row).discord_id)).maybeSingle();
    return (data as Row | null)?.boosting === true;
  } catch {
    return false;
  }
}

/**
 * The booster podium (owner request 2026-10-23): the three members with the most server boosts wear the Gold, Silver and Bronze booster
 * frames. The frames follow the ranking on Leaders → Boosters: when someone passes a place, the frame moves with the place (it is owned
 * only while held, never kept). Only linked members with at least one boost count, and ties are broken as the ladder breaks them.
 */
export const BOOSTER_PODIUM_FRAMES = ["booster-gold", "booster-silver", "booster-bronze"] as const;

type Pair = { userId: string; itemId: string };

/** What has to change so that `holders[i]` (a user id, or null) owns and only owns podium frame i. */
export function planPodium(holders: (string | null)[], owned: Pair[], equipped: Pair[]) {
  const wanted = new Map<string, string>();
  holders.forEach((userId, index) => { if (userId) wanted.set(`${userId}:${BOOSTER_PODIUM_FRAMES[index]}`, userId); });
  const has = new Set(owned.map((pair) => `${pair.userId}:${pair.itemId}`));
  const grant = Array.from(wanted.keys()).filter((key) => !has.has(key)).map((key) => ({ userId: wanted.get(key)!, itemId: key.slice(key.indexOf(":") + 1) }));
  const revoke = owned.filter((pair) => !wanted.has(`${pair.userId}:${pair.itemId}`));
  // Whoever was wearing a frame that is taken from them wears their new podium frame instead (if they hold one).
  const equip: Pair[] = [];
  const unequip: Pair[] = [];
  for (const pair of equipped) {
    if (wanted.has(`${pair.userId}:${pair.itemId}`)) continue;
    const next = BOOSTER_PODIUM_FRAMES.find((itemId) => wanted.has(`${pair.userId}:${itemId}`));
    if (next) equip.push({ userId: pair.userId, itemId: next });
    else unequip.push(pair);
  }
  return { grant, revoke, equip, unequip };
}

/** Reads the ladder and brings the three frames in line with it. Safe to call as often as the community report arrives. */
export async function syncBoosterPodium(db: Db): Promise<void> {
  const top = (await loadCommunity(db, "boosts", 3)).filter((entry) => entry.boosts > 0);
  const holders: (string | null)[] = [null, null, null];
  if (top.length > 0) {
    const { data, error } = await db.from("users").select("id,steam_id").in("steam_id", top.map((entry) => entry.steamId));
    legacyXError(error, "Unable to read the top boosters");
    const idBySteam = new Map(((data ?? []) as Row[]).map((row) => [String(row.steam_id), String(row.id)]));
    top.forEach((entry, index) => { holders[index] = idBySteam.get(entry.steamId) ?? null; });
  }
  const items = [...BOOSTER_PODIUM_FRAMES];
  const [owned, equipped] = await Promise.all([
    db.from("cosmetic_owned").select("user_id,item_id").in("item_id", items),
    db.from("cosmetic_equipped").select("user_id,item_id").eq("kind", "frame").in("item_id", items),
  ]);
  legacyXError(owned.error || equipped.error, "Unable to read the podium frames");
  const pairs = (rows: unknown) => ((rows ?? []) as Row[]).map((row) => ({ userId: String(row.user_id), itemId: String(row.item_id) }));
  const plan = planPodium(holders, pairs(owned.data), pairs(equipped.data));
  for (const pair of plan.revoke) {
    const { error } = await db.from("cosmetic_owned").delete().eq("user_id", pair.userId).eq("item_id", pair.itemId);
    legacyXError(error, "Unable to take a podium frame back");
  }
  if (plan.grant.length > 0) {
    const { error } = await db.from("cosmetic_owned").upsert(plan.grant.map((pair) => ({ user_id: pair.userId, item_id: pair.itemId, source: "achievement" })), { onConflict: "user_id,item_id", ignoreDuplicates: true });
    legacyXError(error, "Unable to give the podium frames");
  }
  for (const pair of plan.unequip) {
    const { error } = await db.from("cosmetic_equipped").delete().eq("user_id", pair.userId).eq("kind", "frame").eq("item_id", pair.itemId);
    legacyXError(error, "Unable to take off a podium frame");
  }
  for (const pair of plan.equip) {
    const { error } = await db.from("cosmetic_equipped").upsert({ user_id: pair.userId, kind: "frame", item_id: pair.itemId, updated_at: new Date().toISOString() }, { onConflict: "user_id,kind" });
    legacyXError(error, "Unable to move a podium frame");
  }
}
