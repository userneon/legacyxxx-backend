import type { SupabaseClient } from "@supabase/supabase-js";
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
