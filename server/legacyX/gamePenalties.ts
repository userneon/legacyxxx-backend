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

/** Every mute and gag still in force, for a game server's own copy: the database is the only place they are kept. */
export async function listActiveCommPenalties(db: Db, now = new Date(), limit = 1000) {
  const { data, error } = await db
    .from("penalties")
    .select("type,reason,is_permanent,expires_at,created_at,admin_name,users!penalties_user_id_fkey(steam_id,username)")
    .in("type", ["comm", "gag"])
    .eq("is_unbanned", false)
    .or(`is_permanent.eq.true,expires_at.gt.${now.toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(limit);
  legacyXError(error, "Unable to list mutes and gags");
  return ((data ?? []) as any[]).flatMap((row) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    if (!user?.steam_id) return [];
    return [{
      steamId: String(user.steam_id),
      name: String(user.username ?? ""),
      type: row.type === "gag" ? "gag" : "comm",
      reason: String(row.reason ?? ""),
      isPermanent: Boolean(row.is_permanent),
      expiresAt: (row.expires_at as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
      issuer: String(row.admin_name ?? ""),
    }];
  });
}
