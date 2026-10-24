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

/** The link the member opens: on the website's own address, so the API's host name is not what they see (legacyx.cc proxies /api/v1/auth/steam to the API). */
export function linkStartUrl(origin: string, token: string) {
  return `${origin}/api/v1/auth/steam/discord/${token}`;
}

export function linkCallbackUrl(origin: string, token: string) {
  return `${origin}/api/v1/auth/steam/discord/${token}/callback`;
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

/** What a linked player can be pinged for in Discord. Each one is a "Ping: …" role the bot keeps in step with these switches. */
export const PING_TOPICS = [
  { key: "updates", label: "Updates", description: "Website and game server updates" },
  { key: "news", label: "News", description: "Counter-Strike 2 news" },
  { key: "live", label: "Creators live", description: "A LEGACY-X creator goes live" },
  { key: "play", label: "Servers need players", description: "A server is short of players" },
] as const;
export type PingTopic = (typeof PING_TOPICS)[number]["key"];
export const pingTopicKeys = PING_TOPICS.map((topic) => topic.key) as [PingTopic, ...PingTopic[]];

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
  /** The member's role in their clan ("leader", "co-leader", "member"), or null when they are in no clan. Gives the Clan Member role. */
  clanRole: string | null;
  /** The player's active staff role on the site ("owner", "manager", "admin", "developer", "designer"), or null. Gives the same-named Discord role. */
  staffRole: string | null;
  /** "main" or "creator" for a content creator, or null. Gives Main Content Creator / Content Creator. */
  creatorTier: string | null;
  /** 1, 2 or 3 for the three members who boost right now with the most boosts (the Boosters page's order), else null. */
  boosterPlace: number | null;
  /** The ping topics the player switched on (see PING_TOPICS). Gives the matching "Ping: …" roles. */
  pings: PingTopic[];
};

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);
const one = (value: unknown): Row => (Array.isArray(value) ? (value[0] as Row) ?? {} : (value as Row) ?? {});

/** Discord ID → 1, 2 or 3 for the top three linked members who boost right now (most boosts first, ties: the earlier booster, then the name). */
async function boosterPlaces(db: Db): Promise<Map<string, number>> {
  const { data, error } = await db.from("discord_community_stats").select("discord_id,boosts,boosting_since,display_name,username").eq("boosting", true).gt("boosts", 0).order("boosts", { ascending: false }).limit(50);
  legacyXError(error, "Unable to load Discord boosters");
  const stats = (data ?? []) as Row[];
  if (stats.length === 0) return new Map();
  const { data: linked, error: linkError } = await db.from("discord_links").select("discord_id").in("discord_id", stats.map((row) => text(row.discord_id)));
  legacyXError(linkError, "Unable to load linked boosters");
  const linkedIds = new Set(((linked ?? []) as Row[]).map((row) => text(row.discord_id)));
  const name = (row: Row) => text(row.display_name) || text(row.username);
  return new Map(
    stats
      .filter((row) => linkedIds.has(text(row.discord_id)))
      .sort((a, b) => num(b.boosts) - num(a.boosts) || (text(a.boosting_since) || "9").localeCompare(text(b.boosting_since) || "9") || name(a).localeCompare(name(b)))
      .slice(0, 3)
      .map((row, index) => [text(row.discord_id), index + 1] as [string, number]),
  );
}

/** Every link (or one Discord account's) with the player's current LEGACY-X rank. */
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

  // A failed read must fail the call: the bot treats no answer as "no change" and never strips roles because of it.
  const clanRoles = new Map<string, string>();
  for (let index = 0; index < userIds.length; index += 200) {
    const { data: rows, error: clanError } = await db.from("clan_members").select("user_id,role").in("user_id", userIds.slice(index, index + 200));
    legacyXError(clanError, "Unable to load linked players' clans");
    for (const row of (rows ?? []) as Row[]) clanRoles.set(text(row.user_id), text(row.role) || "member");
  }

  const staffRoles = new Map<string, string>();
  const creatorTiers = new Map<string, string>();
  for (let index = 0; index < userIds.length; index += 200) {
    const ids = userIds.slice(index, index + 200);
    const { data: staffRows, error: staffError } = await db.from("staff").select("user_id,role").in("user_id", ids).eq("status", "active");
    legacyXError(staffError, "Unable to load linked players' staff roles");
    for (const row of (staffRows ?? []) as Row[]) staffRoles.set(text(row.user_id), text(row.role).toLowerCase());
    const { data: creatorRows, error: creatorError } = await db.from("content_creators").select("user_id,tier").in("user_id", ids);
    legacyXError(creatorError, "Unable to load linked players' creator tiers");
    for (const row of (creatorRows ?? []) as Row[]) creatorTiers.set(text(row.user_id), text(row.tier));
  }
  const places = await boosterPlaces(db);
  const pings = new Map<string, PingTopic[]>();
  for (let index = 0; index < userIds.length; index += 200) {
    const { data: rows, error: pingError } = await db.from("discord_pings").select("user_id,topic").in("user_id", userIds.slice(index, index + 200));
    legacyXError(pingError, "Unable to load linked players' pings");
    for (const row of (rows ?? []) as Row[]) {
      const topic = text(row.topic) as PingTopic;
      if (pingTopicKeys.includes(topic)) pings.set(text(row.user_id), [...(pings.get(text(row.user_id)) ?? []), topic]);
    }
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
      clanRole: clanRoles.get(text(link.user_id)) ?? null,
      staffRole: staffRoles.get(text(link.user_id)) || null,
      creatorTier: creatorTiers.get(text(link.user_id)) || null,
      boosterPlace: places.get(text(link.discord_id)) ?? null,
      pings: pings.get(text(link.user_id)) ?? [],
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
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · LEGACY-X</title>
<style>${style}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  const csp = `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  return { html, csp };
}

/**
 * Which users have a Discord account linked, as a set of user IDs. Only the fact is public (a small "Discord linked"
 * mark on profiles and the leaderboard), never the Discord name or ID. If the table cannot be read the marks are
 * simply left off: this must never break the page it decorates.
 */
export async function discordLinkedUserIds(db: Db, userIds?: string[]): Promise<Set<string>> {
  if (userIds && userIds.length === 0) return new Set();
  // With a page's players given (up to 200, so the request URL stays short), only their links are read, not the whole table.
  const query = db.from("discord_links").select("user_id");
  const { data, error } = await (userIds && userIds.length <= 200 ? query.in("user_id", userIds) : query.limit(10000));
  if (error) return new Set();
  return new Set((data ?? []).map((row: { user_id: unknown }) => String(row.user_id)));
}
