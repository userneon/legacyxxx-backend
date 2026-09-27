import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { legacyXError } from "./supabase";

/**
 * Central SteamID bans issued by trusted tools (the Discord bot) through plugin-token routes.
 *
 * Every ban writes two rows: `penalties` is the public record shown on /penalties and profiles,
 * `bans` is the admin-system row the game servers check. The Root API is the only writer; game
 * servers read active bans through POST /plugin/bans/check and kick matching players.
 */

type Db = SupabaseClient<any, any, any, any, any>;

const steamId64 = z.string().regex(/^7656119\d{10}$/, "SteamID64 is required");

export const issueBanSchema = z.object({
  steamId: steamId64,
  /** 0 = permanent. Up to one year. */
  durationMinutes: z.number().int().min(0).max(525_600),
  reason: z.string().trim().min(1).max(200),
  /** Who issued it, as shown on the penalties page (e.g. the Discord staff member). */
  issuerName: z.string().trim().min(1).max(64),
});

export const revokeBanSchema = z.object({
  steamId: steamId64,
  issuerName: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(200).optional(),
});

export const checkBansSchema = z.object({
  steamIds: z.array(steamId64).min(1).max(128),
});

// Bans issued this way carry the lowest staff immunity, so any staff member can review or lift
// them, and permanent ones go to the review queue like other permanent bans below manager rank.
const ISSUER_IMMUNITY = 20;

export function banTerm(minutes: number) {
  if (minutes === 0) return "Permanent";
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export async function issueBan(db: Db, input: z.infer<typeof issueBanSchema>, now = new Date()) {
  const isPermanent = input.durationMinutes === 0;
  const expiresAt = isPermanent ? null : new Date(now.getTime() + input.durationMinutes * 60_000).toISOString();

  // The player may never have signed in on the site; the ban still needs their user row.
  const { data: userId, error: userError } = await db.rpc("ensure_steam_user", { p_steam_id: input.steamId, p_username: `Steam ${input.steamId}`, p_avatar: "" });
  legacyXError(userError, "Unable to resolve banned player");
  if (!userId) throw Object.assign(new Error("Banned player could not be created"), { statusCode: 500 });

  const { data: penalty, error: penaltyError } = await db
    .from("penalties")
    .insert({ user_id: userId, type: "ban", reason: input.reason, term: banTerm(input.durationMinutes), is_permanent: isPermanent, expires_at: expiresAt, admin_name: input.issuerName })
    .select("id")
    .single();
  legacyXError(penaltyError, "Unable to record penalty");
  if (!penalty) throw Object.assign(new Error("Penalty was not recorded"), { statusCode: 500 });

  const { data: ban, error: banError } = await db
    .from("bans")
    .insert({
      steam_id: input.steamId,
      user_id: userId,
      reason: input.reason,
      is_permanent: isPermanent,
      expires_at: expiresAt,
      issuer_immunity: ISSUER_IMMUNITY,
      source: "panel",
      review_status: isPermanent ? "pending" : "none",
      penalty_id: penalty.id,
    })
    .select("id")
    .single();
  if (banError) {
    // Keep the two tables consistent: no public penalty without the ban behind it.
    await db.from("penalties").delete().eq("id", penalty.id);
    legacyXError(banError, "Unable to record ban");
  }

  return { banId: ban!.id as string, penaltyId: penalty.id as string, userId: userId as string, isPermanent, expiresAt, term: banTerm(input.durationMinutes) };
}

export async function revokeBans(db: Db, input: z.infer<typeof revokeBanSchema>, now = new Date()) {
  const nowIso = now.toISOString();
  const reason = input.reason ?? `Lifted by ${input.issuerName}`;

  const { data: bans, error: bansError } = await db
    .from("bans")
    .update({ revoked_at: nowIso, revoke_reason: reason })
    .eq("steam_id", input.steamId)
    .is("revoked_at", null)
    .select("id,penalty_id,user_id");
  legacyXError(bansError, "Unable to lift bans");

  // Also lift ban penalties recorded without an admin-system row (older records).
  const { data: user, error: userError } = await db.from("users").select("id").eq("steam_id", input.steamId).maybeSingle();
  legacyXError(userError, "Unable to resolve player");
  let penalties: Array<{ id: string }> = [];
  if (user?.id) {
    const { data, error } = await db
      .from("penalties")
      .update({ is_unbanned: true })
      .eq("user_id", user.id)
      .eq("type", "ban")
      .eq("is_unbanned", false)
      .select("id");
    legacyXError(error, "Unable to update penalties");
    penalties = data ?? [];
  }

  return { bansLifted: (bans ?? []).length, penaltiesLifted: penalties.length };
}

export type ActiveBan = { steamId: string; reason: string; isPermanent: boolean; expiresAt: string | null };

/** Active bans among the given SteamIDs (not lifted, not expired). */
export async function activeBans(db: Db, steamIds: string[], now = new Date()): Promise<ActiveBan[]> {
  const { data, error } = await db
    .from("bans")
    .select("steam_id,reason,is_permanent,expires_at")
    .in("steam_id", steamIds)
    .is("revoked_at", null);
  legacyXError(error, "Unable to read bans");
  const seen = new Set<string>();
  return (data ?? [])
    .filter((row) => row.is_permanent || (row.expires_at && Date.parse(row.expires_at) > now.getTime()))
    .filter((row) => !seen.has(row.steam_id) && seen.add(row.steam_id))
    .map((row) => ({ steamId: row.steam_id, reason: row.reason, isPermanent: Boolean(row.is_permanent), expiresAt: row.expires_at ?? null }));
}

/** Name and avatar for the ban card (the Discord bot draws them). Null if the player has no row. */
export async function bannedPlayer(db: Db, steamId: string) {
  const { data, error } = await db.from("users").select("username,avatar").eq("steam_id", steamId).maybeSingle();
  legacyXError(error, "Unable to read player");
  return data ? { steamId, username: String(data.username ?? ""), avatar: String(data.avatar ?? "") } : null;
}
