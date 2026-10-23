import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCommunity } from "./discordCommunity";
import { legacyXError } from "./supabase";

/**
 * What a Discord server booster gets: the Server Booster avatar frame; no coins. It goes to the LEGACY-X profile the member linked Discord
 * to: a booster who links later gets it then. Owner decision 2026-10-23 (replacing "kept for good" of 2026-10-17): the frame lasts only while
 * the member boosts. Discord does not say how many boosts a member has left, only whether any remains (`boosting`), so one boost ending while
 * another still runs changes nothing; the frame goes when the last one ends. While the member boosts, the profile also shows a Booster badge.
 */
type Db = SupabaseClient<any, any, any, any, any>;
type Row = Record<string, unknown>;

export const BOOSTER_FRAME_ID = "server-booster";

/** Gives the frame to every linked member who boosts right now (optionally only these Discord IDs). Returns how many were checked. */
export async function grantBoosterFrames(db: Db, discordIds?: string[]): Promise<number> {
  let query = db.from("discord_community_stats").select("discord_id").gt("boosts", 0).eq("boosting", true).limit(5000);
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

/** Which of these holders no longer boost: those whose linked Discord is not in the boosting set (or who have no link any more). */
export function staleFrameHolders(holders: { userId: string; discordId: string | null }[], boosting: Set<string>): string[] {
  return holders.filter((holder) => !holder.discordId || !boosting.has(holder.discordId)).map((holder) => holder.userId);
}

/** Takes the Server Booster frame (and takes it off) from everyone who stopped boosting. Frames a staff member gave by hand are left alone. */
export async function endBoosterFrames(db: Db): Promise<number> {
  const { data: owned, error } = await db.from("cosmetic_owned").select("user_id").eq("item_id", BOOSTER_FRAME_ID).eq("source", "achievement").limit(10000);
  legacyXError(error, "Unable to read the booster frames");
  const userIds = ((owned ?? []) as Row[]).map((row) => String(row.user_id));
  const discordOf = new Map<string, string>();
  for (let index = 0; index < userIds.length; index += 200) {
    const { data, error: linkError } = await db.from("discord_links").select("user_id,discord_id").in("user_id", userIds.slice(index, index + 200));
    legacyXError(linkError, "Unable to read Discord links");
    for (const row of (data ?? []) as Row[]) discordOf.set(String(row.user_id), String(row.discord_id));
  }
  const boosting = new Set<string>();
  const discordIds = Array.from(new Set(discordOf.values()));
  for (let index = 0; index < discordIds.length; index += 200) {
    const { data, error: statError } = await db.from("discord_community_stats").select("discord_id").eq("boosting", true).in("discord_id", discordIds.slice(index, index + 200));
    legacyXError(statError, "Unable to read Discord boosters");
    for (const row of (data ?? []) as Row[]) boosting.add(String(row.discord_id));
  }
  const stale = staleFrameHolders(userIds.map((userId) => ({ userId, discordId: discordOf.get(userId) ?? null })), boosting);
  for (let index = 0; index < stale.length; index += 200) {
    const batch = stale.slice(index, index + 200);
    const { error: takeError } = await db.from("cosmetic_owned").delete().eq("item_id", BOOSTER_FRAME_ID).eq("source", "achievement").in("user_id", batch);
    legacyXError(takeError, "Unable to take the booster frame back");
    const { error: offError } = await db.from("cosmetic_equipped").delete().eq("kind", "frame").eq("item_id", BOOSTER_FRAME_ID).in("user_id", batch);
    legacyXError(offError, "Unable to take off the booster frame");
  }
  return stale.length;
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
  // A place is the member's place on the ladder; it is worn only while they boost, so a member who stopped leaves their place empty.
  const top = await loadCommunity(db, "boosts", 3);
  const holders: (string | null)[] = [null, null, null];
  const wearing = top.filter((entry) => entry.boosts > 0 && entry.boosting);
  if (wearing.length > 0) {
    const { data, error } = await db.from("users").select("id,steam_id").in("steam_id", wearing.map((entry) => entry.steamId));
    legacyXError(error, "Unable to read the top boosters");
    const idBySteam = new Map(((data ?? []) as Row[]).map((row) => [String(row.steam_id), String(row.id)]));
    top.forEach((entry, index) => { if (entry.boosts > 0 && entry.boosting) holders[index] = idBySteam.get(entry.steamId) ?? null; });
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
  // Someone who falls off the podium goes back to the Server Booster frame every booster keeps, if they have it; otherwise the frame just comes off.
  const fallen = Array.from(new Set(plan.unequip.map((pair) => pair.userId)));
  const hasBase = new Set<string>();
  if (fallen.length > 0) {
    const { data, error } = await db.from("cosmetic_owned").select("user_id").eq("item_id", BOOSTER_FRAME_ID).in("user_id", fallen);
    legacyXError(error, "Unable to read the booster frames");
    for (const row of (data ?? []) as Row[]) hasBase.add(String(row.user_id));
  }
  for (const pair of plan.unequip) {
    if (hasBase.has(pair.userId)) {
      const { error } = await db.from("cosmetic_equipped").upsert({ user_id: pair.userId, kind: "frame", item_id: BOOSTER_FRAME_ID, updated_at: new Date().toISOString() }, { onConflict: "user_id,kind" });
      legacyXError(error, "Unable to put the booster frame back");
      continue;
    }
    const { error } = await db.from("cosmetic_equipped").delete().eq("user_id", pair.userId).eq("kind", "frame").eq("item_id", pair.itemId);
    legacyXError(error, "Unable to take off a podium frame");
  }
  for (const pair of plan.equip) {
    const { error } = await db.from("cosmetic_equipped").upsert({ user_id: pair.userId, kind: "frame", item_id: pair.itemId, updated_at: new Date().toISOString() }, { onConflict: "user_id,kind" });
    legacyXError(error, "Unable to move a podium frame");
  }
}

/** 1, 2 or 3 while this player holds the Gold, Silver or Bronze booster frame (their place on the podium), otherwise null. Never throws: it is decoration. */
export async function boosterPlaceOf(db: Db, userId: string): Promise<1 | 2 | 3 | null> {
  try {
    const { data } = await db.from("cosmetic_owned").select("item_id").eq("user_id", userId).in("item_id", [...BOOSTER_PODIUM_FRAMES]);
    const owned = new Set(((data ?? []) as Row[]).map((row) => String(row.item_id)));
    const index = BOOSTER_PODIUM_FRAMES.findIndex((itemId) => owned.has(itemId));
    return index === 0 ? 1 : index === 1 ? 2 : index === 2 ? 3 : null;
  } catch {
    return null;
  }
}
