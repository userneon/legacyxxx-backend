import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { sha256 } from "./auth";
import { legacyXError } from "./supabase";

/**
 * Linking Discord from the website. A signed-in player presses "Link Discord", Discord proves who they are (OAuth2,
 * scope `identify` only), and the Discord account is bound to the player's LEGACY-X account. The bot then gives the
 * rank role. The client secret never leaves the API; the browser only ever sees Discord's own consent page.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type DiscordOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** The three settings, or null when any is missing (the website then hides the button). */
export function discordOAuthConfig(env: NodeJS.ProcessEnv = process.env): DiscordOAuthConfig | null {
  const clientId = env.DISCORD_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.DISCORD_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri || !/^\d{17,20}$/.test(clientId) || !/^https:\/\//.test(redirectUri)) return null;
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(config: DiscordOAuthConfig, state: string) {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: "identify", state, prompt: "consent" }).toString();
  return url.toString();
}

export function isOAuthState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value);
}

/** One-time state tied to the signed-in player, so the callback knows whose account to link. Only its hash is stored. */
export async function createOAuthState(db: Db, userId: string, now = new Date()) {
  const { error: cleanup } = await db.from("discord_oauth_states").delete().lt("expires_at", now.toISOString());
  legacyXError(cleanup, "Unable to clear old Discord sign-in states");
  const state = randomBytes(24).toString("base64url");
  const { error } = await db.from("discord_oauth_states").insert({ token_hash: sha256(state), user_id: userId, expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString() });
  legacyXError(error, "Unable to start the Discord link");
  return state;
}

/** Uses the state up and says whose it was, or null when it is unknown, used or expired. */
export async function consumeOAuthState(db: Db, state: string, now = new Date()) {
  const { data, error } = await db
    .from("discord_oauth_states")
    .update({ used_at: now.toISOString() })
    .eq("token_hash", sha256(state))
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("user_id");
  legacyXError(error, "Unable to check the Discord link");
  const row = Array.isArray(data) ? data[0] : null;
  return row?.user_id ? String(row.user_id) : null;
}

export type DiscordIdentity = { id: string; name: string };

/** Trades the code for who the Discord account is. The access token is used once and thrown away. */
export async function fetchDiscordIdentity(config: DiscordOAuthConfig, code: string, fetcher: typeof fetch = fetch): Promise<DiscordIdentity> {
  const tokenResponse = await fetcher("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code", code, redirect_uri: config.redirectUri }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw Object.assign(new Error("Discord did not accept the code"), { statusCode: 400 });
  const token = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) throw Object.assign(new Error("Discord sent no access token"), { statusCode: 400 });
  const meResponse = await fetcher("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!meResponse.ok) throw Object.assign(new Error("Discord did not say who this is"), { statusCode: 400 });
  const me = (await meResponse.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
  if (typeof me.id !== "string" || !/^\d{17,20}$/.test(me.id)) throw Object.assign(new Error("Discord sent an unexpected answer"), { statusCode: 400 });
  const name = typeof me.global_name === "string" && me.global_name ? me.global_name : typeof me.username === "string" ? me.username : me.id;
  return { id: me.id, name: name.slice(0, 64) };
}

/** Binds the Discord account to the player. Either side may have been linked before; the new link replaces the old ones. */
export async function linkDiscordAccount(db: Db, userId: string, identity: DiscordIdentity) {
  const { error: deleteError } = await db.from("discord_links").delete().or(`discord_id.eq.${identity.id},user_id.eq.${userId}`);
  legacyXError(deleteError, "Unable to replace the old Discord link");
  const { error } = await db.from("discord_links").insert({ user_id: userId, discord_id: identity.id, discord_name: identity.name });
  legacyXError(error, "Unable to link Discord");
}

/** The player's own link, or null. */
export async function ownDiscordLink(db: Db, userId: string) {
  const { data, error } = await db.from("discord_links").select("discord_id,discord_name,linked_at").eq("user_id", userId).maybeSingle();
  legacyXError(error, "Unable to load the Discord link");
  return data ? { discordId: String(data.discord_id), discordName: String(data.discord_name ?? ""), linkedAt: String(data.linked_at) } : null;
}

export async function removeOwnDiscordLink(db: Db, userId: string) {
  const { data, error } = await db.from("discord_links").delete().eq("user_id", userId).select("user_id");
  legacyXError(error, "Unable to unlink Discord");
  return Array.isArray(data) && data.length > 0;
}
