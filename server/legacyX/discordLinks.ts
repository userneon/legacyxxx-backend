import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./auth";
import { legacyXError } from "./supabase";

/**
 * Discord ↔ Steam links for the Discord bot's /link command and rank roles.
 *
 * The bot (plugin token with discord:link) asks for a one-time link request and shows the player
 * the returned URL. Opening it sends them through Steam OpenID; the callback binds their Discord ID
 * to their legacy_x user with complete_discord_link(). Only the token's SHA-256 is stored.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const LINK_REQUEST_TTL_MS = 10 * 60 * 1000;

export const discordIdSchema = z.string().regex(/^\d{17,20}$/, "Discord user ID is required");

export const linkRequestSchema = z.object({
  discordId: discordIdSchema,
  discordName: z.string().trim().min(1).max(64),
});

/** 24 random bytes → 32 base64url characters. */
export function isLinkToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);
}

export function linkCallbackUrl(origin: string, token: string) {
  return `${origin}/api/v1/discord/link/${token}/callback`;
}

/**
 * Steam signs openid.return_to, so an assertion made for another callback (the site login, another
 * link token) cannot be replayed here to link someone else's Discord account.
 */
export function returnToMatches(query: Record<string, unknown>, expected: string) {
  const value = query["openid.return_to"];
  const returnTo = typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
  return returnTo === expected;
}

export async function createLinkRequest(db: Db, input: z.infer<typeof linkRequestSchema>, now = new Date()) {
  // Housekeeping: expired requests are useless and hold no link.
  const { error: cleanupError } = await db.from("discord_link_requests").delete().lt("expires_at", now.toISOString());
  legacyXError(cleanupError, "Unable to clear expired Discord link requests");

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_REQUEST_TTL_MS).toISOString();
  const { error } = await db.from("discord_link_requests").insert({
    token_hash: sha256(token),
    discord_id: input.discordId,
    discord_name: input.discordName,
    expires_at: expiresAt,
  });
  legacyXError(error, "Unable to create Discord link request");
  return { token, expiresAt };
}

/** The pending request behind a token, or null when it is unknown, used or expired. */
export async function pendingLinkRequest(db: Db, token: string, now = new Date()) {
  const { data, error } = await db
    .from("discord_link_requests")
    .select("discord_id,discord_name,expires_at,used_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();
  legacyXError(error, "Unable to read Discord link request");
  if (!data || data.used_at || new Date(data.expires_at).getTime() <= now.getTime()) return null;
  return { discordId: String(data.discord_id), discordName: String(data.discord_name ?? "") };
}

/** Consumes the request and links it to the user. Returns the Discord ID, or null if it was no longer valid. */
export async function completeLink(db: Db, token: string, userId: string) {
  const { data, error } = await db.rpc("complete_discord_link", { p_token_hash: sha256(token), p_user_id: userId });
  legacyXError(error, "Unable to link Discord account");
  return typeof data === "string" && data ? data : null;
}

export type DiscordLink = {
  discordId: string;
  discordName: string;
  linkedAt: string;
  steamId: string;
  username: string;
  rankId: number | null;
  rankName: string | null;
  currentExp: number;
  matchesCompleted: number;
};

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);
const one = (value: unknown): Row => (Array.isArray(value) ? (value[0] as Row) ?? {} : (value as Row) ?? {});

/** Every link (or one Discord account's) with the player's current Legacy-X rank. */
export async function listLinks(db: Db, discordId?: string): Promise<DiscordLink[]> {
  let query = db.from("discord_links").select("user_id,discord_id,discord_name,linked_at,users(steam_id,username)").order("linked_at", { ascending: true }).limit(5000);
  if (discordId) query = query.eq("discord_id", discordId);
  const { data, error } = await query;
  legacyXError(error, "Unable to load Discord links");
  const links = (data ?? []) as Row[];

  const profiles = new Map<string, Row>();
  const userIds = links.map((link) => text(link.user_id)).filter(Boolean);
  for (let index = 0; index < userIds.length; index += 200) {
    const { data: rows, error: profileError } = await db
      .from("competitive_player_profiles")
      .select("user_id,rank_id,rank_name,current_exp,matches_completed")
      .in("user_id", userIds.slice(index, index + 200));
    legacyXError(profileError, "Unable to load linked player ranks");
    for (const row of (rows ?? []) as Row[]) profiles.set(text(row.user_id), row);
  }

  return links.map((link) => {
    const user = one(link.users);
    const profile = profiles.get(text(link.user_id));
    return {
      discordId: text(link.discord_id),
      discordName: text(link.discord_name),
      linkedAt: text(link.linked_at),
      steamId: text(user.steam_id),
      username: text(user.username),
      rankId: profile && profile.rank_id != null ? num(profile.rank_id) : null,
      rankName: profile ? text(profile.rank_name) || null : null,
      currentExp: profile ? num(profile.current_exp) : 0,
      matchesCompleted: profile ? num(profile.matches_completed) : 0,
    };
  });
}

export async function unlink(db: Db, discordId: string) {
  const { data, error } = await db.from("discord_links").delete().eq("discord_id", discordId).select("user_id");
  legacyXError(error, "Unable to unlink Discord account");
  return Array.isArray(data) && data.length > 0;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** The small page the player sees in the browser after the Steam round trip, with a CSP that allows only its own style. */
export function linkResultPage(ok: boolean, title: string, message: string) {
  const accent = ok ? "#22c55e" : "#ef4444";
  const style = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:420px;width:100%;border:1px solid #23272e;border-radius:12px;padding:28px;background:#12151a}
h1{margin:0 0 8px;font-size:20px;color:${accent}}p{margin:0;color:#9ca3af}`;
  const styleHash = createHash("sha256").update(style).digest("base64");
  const html = `<!doctype html>
<html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Legacy-X</title>
<style>${style}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  const csp = `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  return { html, csp };
}
