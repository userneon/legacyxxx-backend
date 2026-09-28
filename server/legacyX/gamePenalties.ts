import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { banTerm } from "./bans";
import { legacyXError } from "./supabase";

/**
 * Voice mutes ("comm") and chat gags ("gag") issued on a CS2 server (LegacyX-Admin), recorded as
 * public penalties so they show on /penalties, the player's profile and the Discord feed. The game
 * server still enforces them itself; this is the record. Bans go through bans.ts.
 */

type Db = SupabaseClient<any, any, any, any, any>;

const steamId64 = z.string().regex(/^7656119\d{10}$/, "SteamID64 is required");
const commType = z.enum(["comm", "gag"]);

export const issueCommPenaltySchema = z.object({
  steamId: steamId64,
  type: commType,
  /** 0 = permanent. Up to one year. */
  durationMinutes: z.number().int().min(0).max(525_600),
  reason: z.string().trim().min(1).max(200),
  issuerName: z.string().trim().min(1).max(64),
});

export const liftCommPenaltySchema = z.object({
  steamId: steamId64,
  type: commType,
  issuerName: z.string().trim().min(1).max(64),
});

export async function issueCommPenalty(db: Db, input: z.infer<typeof issueCommPenaltySchema>, now = new Date()) {
  const isPermanent = input.durationMinutes === 0;
  const expiresAt = isPermanent ? null : new Date(now.getTime() + input.durationMinutes * 60_000).toISOString();
  const { data: userId, error: userError } = await db.rpc("ensure_steam_user", { p_steam_id: input.steamId, p_username: `Steam ${input.steamId}`, p_avatar: "" });
  legacyXError(userError, "Unable to resolve player");
  if (!userId) throw Object.assign(new Error("Player could not be created"), { statusCode: 500 });
  const { data, error } = await db
    .from("penalties")
    .insert({ user_id: userId, type: input.type, reason: input.reason, term: banTerm(input.durationMinutes), is_permanent: isPermanent, expires_at: expiresAt, admin_name: input.issuerName })
    .select("id")
    .single();
  legacyXError(error, "Unable to record penalty");
  return { penaltyId: String(data!.id), isPermanent, expiresAt };
}

/** Marks the player's active mutes (or gags) as lifted. */
export async function liftCommPenalties(db: Db, input: z.infer<typeof liftCommPenaltySchema>) {
  const { data: user, error: userError } = await db.from("users").select("id").eq("steam_id", input.steamId).maybeSingle();
  legacyXError(userError, "Unable to resolve player");
  if (!user?.id) return { lifted: 0 };
  const { data, error } = await db
    .from("penalties")
    .update({ is_unbanned: true })
    .eq("user_id", user.id)
    .eq("type", input.type)
    .eq("is_unbanned", false)
    .select("id");
  legacyXError(error, "Unable to lift penalty");
  return { lifted: (data ?? []).length };
}
