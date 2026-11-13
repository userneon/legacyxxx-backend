import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { sha256 } from "./auth";
import { legacyXError } from "./supabase";

/**
 * Connecting TikTok from the website (owner request 2026-11-13, "add TikTok OAuth2 for the creators"). A content creator presses "Connect TikTok",
 * TikTok (Login Kit v2) shows its own consent page and proves who the account is, and the account is bound to the creator. Scopes: user.info.basic,
 * user.info.profile (the @username) and user.info.stats (followers, likes, videos). The client secret never leaves the API, the access token is used
 * once and thrown away, and only the public profile is kept (`legacy_x.creator_tiktok`, supabase/legacy_x_creator_tiktok.sql).
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const TIKTOK_STATE_TTL_MS = 10 * 60 * 1000;
export const TIKTOK_SCOPES = "user.info.basic,user.info.profile,user.info.stats";

export type TikTokConfig = { clientKey: string; clientSecret: string; redirectUri: string };

/** The three settings, or null when any is missing (the website then says it is not set up). */
export function tiktokConfig(env: NodeJS.ProcessEnv = process.env): TikTokConfig | null {
  const clientKey = env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = env.TIKTOK_CLIENT_SECRET?.trim();
  const redirectUri = env.TIKTOK_REDIRECT_URI?.trim();
  if (!clientKey || !clientSecret || !redirectUri || !/^[A-Za-z0-9_-]{8,64}$/.test(clientKey) || !/^https:\/\//.test(redirectUri)) return null;
  return { clientKey, clientSecret, redirectUri };
}

export function tiktokAuthorizeUrl(config: TikTokConfig, state: string) {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.search = new URLSearchParams({ client_key: config.clientKey, scope: TIKTOK_SCOPES, response_type: "code", redirect_uri: config.redirectUri, state }).toString();
  return url.toString();
}

export function isTikTokState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);
}

/** One-time state tied to the signed-in creator. Only its hash is stored. */
export async function createTikTokState(db: Db, userId: string, now = new Date()) {
  const { error: cleanup } = await db.from("tiktok_oauth_states").delete().lt("expires_at", now.toISOString());
  legacyXError(cleanup, "Unable to clear old TikTok sign-in states");
  const state = randomBytes(24).toString("base64url");
  const { error } = await db.from("tiktok_oauth_states").insert({ token_hash: sha256(state), user_id: userId, expires_at: new Date(now.getTime() + TIKTOK_STATE_TTL_MS).toISOString() });
  legacyXError(error, "Unable to start the TikTok link");
  return state;
}

/** Uses the state up and says whose it was, or null when it is unknown, used or expired. */
export async function consumeTikTokState(db: Db, state: string, now = new Date()) {
  const { data, error } = await db
    .from("tiktok_oauth_states")
    .update({ used_at: now.toISOString() })
    .eq("token_hash", sha256(state))
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("user_id");
  legacyXError(error, "Unable to check the TikTok link");
  const row = Array.isArray(data) ? data[0] : null;
  return row?.user_id ? String(row.user_id) : null;
}

export type TikTokProfile = { openId: string; username: string; displayName: string; avatarUrl: string | null; followers: number | null; likes: number | null; videos: number | null };

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/** TikTok handles are letters, digits, dots and underscores. */
export const cleanTikTokUsername = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9._]{1,64}$/.test(value) ? value : "");

/** Trades the code for who the TikTok account is. The access token is used for one request and thrown away. */
export async function fetchTikTokProfile(config: TikTokConfig, code: string, fetcher: typeof fetch = fetch): Promise<TikTokProfile> {
  const tokenResponse = await fetcher("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: config.clientKey, client_secret: config.clientSecret, code, grant_type: "authorization_code", redirect_uri: config.redirectUri }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw Object.assign(new Error("TikTok did not accept the code"), { statusCode: 400 });
  const token = (await tokenResponse.json()) as { access_token?: unknown; open_id?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token || typeof token.open_id !== "string" || !token.open_id) throw Object.assign(new Error("TikTok sent no access token"), { statusCode: 400 });
  const fields = "open_id,display_name,avatar_url,username,follower_count,likes_count,video_count";
  const meResponse = await fetcher(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!meResponse.ok) throw Object.assign(new Error("TikTok did not say who this is"), { statusCode: 400 });
  const body = (await meResponse.json()) as { data?: { user?: Record<string, unknown> } };
  const user = body.data?.user;
  if (!user || typeof user.open_id !== "string" || user.open_id !== token.open_id) throw Object.assign(new Error("TikTok sent an unexpected answer"), { statusCode: 400 });
  const avatar = typeof user.avatar_url === "string" && /^https:\/\//.test(user.avatar_url) ? user.avatar_url.slice(0, 500) : null;
  return {
    openId: user.open_id,
    username: cleanTikTokUsername(user.username),
    displayName: typeof user.display_name === "string" ? user.display_name.slice(0, 100) : "",
    avatarUrl: avatar,
    followers: count(user.follower_count),
    likes: count(user.likes_count),
    videos: count(user.video_count),
  };
}

/** Binds the TikTok account to the creator. Either side may have been linked before; the new link replaces the old ones. */
export async function linkTikTokAccount(db: Db, userId: string, profile: TikTokProfile) {
  const { error: deleteError } = await db.from("creator_tiktok").delete().or(`open_id.eq.${profile.openId},user_id.eq.${userId}`);
  legacyXError(deleteError, "Unable to replace the old TikTok link");
  const { error } = await db.from("creator_tiktok").insert({
    user_id: userId, open_id: profile.openId, username: profile.username, display_name: profile.displayName, avatar_url: profile.avatarUrl,
    follower_count: profile.followers, likes_count: profile.likes, video_count: profile.videos,
  });
  legacyXError(error, "Unable to link TikTok");
}

export type TikTokLink = { username: string; displayName: string; avatarUrl: string | null; followers: number | null; likes: number | null; videos: number | null; linkedAt: string };

const toLink = (row: Record<string, unknown>): TikTokLink => ({
  username: String(row.username ?? ""), displayName: String(row.display_name ?? ""), avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
  followers: count(row.follower_count), likes: count(row.likes_count), videos: count(row.video_count), linkedAt: String(row.linked_at),
});

/** The creator's own link, or null. */
export async function ownTikTokLink(db: Db, userId: string): Promise<TikTokLink | null> {
  const { data, error } = await db.from("creator_tiktok").select("username,display_name,avatar_url,follower_count,likes_count,video_count,linked_at").eq("user_id", userId).maybeSingle();
  legacyXError(error, "Unable to load the TikTok link");
  return data ? toLink(data as Record<string, unknown>) : null;
}

export async function removeOwnTikTokLink(db: Db, userId: string) {
  const { data, error } = await db.from("creator_tiktok").delete().eq("user_id", userId).select("user_id");
  legacyXError(error, "Unable to unlink TikTok");
  return Array.isArray(data) && data.length > 0;
}

/** The verified accounts of several creators, by user id (the public Creators page marks them). */
export async function tiktokLinksFor(db: Db, userIds: string[]): Promise<Map<string, TikTokLink>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await db.from("creator_tiktok").select("user_id,username,display_name,avatar_url,follower_count,likes_count,video_count,linked_at").in("user_id", userIds);
  if (error) return new Map();
  return new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.user_id), toLink(row)]));
}
