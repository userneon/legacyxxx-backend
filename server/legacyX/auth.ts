import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { legacyXDb, legacyXError } from "./supabase";

export type LegacyUser = {
  id: string;
  steamId: string;
  role: UserRole;
  isStaff: boolean;
  username: string;
};

export const userRoles = ["Owner", "Founder", "Manager", "Admin", "Player", "Designer", "Developer"] as const;
export type UserRole = typeof userRoles[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (userRoles as readonly string[]).includes(value);
}

export function isStaffRole(role: UserRole) {
  return role !== "Player";
}

export type PluginPrincipal = {
  id: string;
  name: string;
  scopes: string[];
};

const accessLifetimeSeconds = 15 * 60;
/**
 * A refresh session stays valid for a bounded long-lived period when the
 * browser is inactive. Active tabs rotate it before the access JWT expires.
 */
export const refreshLifetimeMs = 90 * 24 * 60 * 60 * 1000;

function jwtKey() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not configured");
  return new TextEncoder().encode(value);
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hasPluginScope(scopes: unknown, requiredScope: string) {
  return Array.isArray(scopes) && scopes.includes(requiredScope);
}

export async function issueAccessToken(user: LegacyUser) {
  return new SignJWT({ steamId: user.steamId, role: user.role, isStaff: isStaffRole(user.role), username: user.username })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${accessLifetimeSeconds}s`)
    .sign(jwtKey());
}

export async function verifyAccessToken(token: string): Promise<LegacyUser> {
  const { payload } = await jwtVerify(token, jwtKey());
  if (!payload.sub || typeof payload.steamId !== "string" || typeof payload.username !== "string") {
    throw Object.assign(new Error("Invalid access token payload"), { statusCode: 401 });
  }
  const role = isUserRole(payload.role) ? payload.role : payload.isStaff === true ? "Admin" : "Player";
  return {
    id: payload.sub,
    steamId: payload.steamId,
    username: payload.username,
    role,
    isStaff: isStaffRole(role),
  };
}

export async function createRefreshSession(userId: string) {
  const refreshToken = randomBytes(48).toString("base64url");
  const { error } = await legacyXDb().from("user_sessions").insert({
    user_id: userId,
    refresh_token: sha256(refreshToken),
    expires_at: new Date(Date.now() + refreshLifetimeMs).toISOString(),
  });
  legacyXError(error, "Unable to create refresh session");
  return refreshToken;
}

export async function rotateRefreshSession(refreshToken: string): Promise<LegacyUser> {
  const db = legacyXDb();
  const { data: session, error } = await db
    .from("user_sessions")
    .select("id,user_id,expires_at,revoked_at")
    .eq("refresh_token", sha256(refreshToken))
    .maybeSingle();
  legacyXError(error, "Unable to read refresh session");
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    throw Object.assign(new Error("Refresh token is invalid or expired"), { statusCode: 401 });
  }

  const { error: revokeError } = await db.from("user_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", session.id);
  legacyXError(revokeError, "Unable to rotate refresh session");

  const { data: user, error: userError } = await db
    .from("users")
    .select("id,steam_id,username,role,is_staff")
    .eq("id", session.user_id)
    .maybeSingle();
  legacyXError(userError, "Unable to read session user");
  if (!user) throw Object.assign(new Error("Session user no longer exists"), { statusCode: 401 });
  const role = isUserRole(user.role) ? user.role : user.is_staff ? "Admin" : "Player";
  return { id: user.id, steamId: user.steam_id, username: user.username, role, isStaff: isStaffRole(role) };
}

export async function revokeRefreshSession(refreshToken: string) {
  const { error } = await legacyXDb()
    .from("user_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("refresh_token", sha256(refreshToken));
  legacyXError(error, "Unable to revoke refresh session");
}

export async function revokeUserRefreshSessions(userId: string) {
  const { error } = await legacyXDb()
    .from("user_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  legacyXError(error, "Unable to revoke user refresh sessions");
}

export async function authenticatePlugin(rawToken: string, requiredScope: string): Promise<PluginPrincipal> {
  const { data, error } = await legacyXDb()
    .from("api_tokens")
    .select("id,name,scopes,is_active")
    .eq("token_hash", sha256(rawToken))
    .eq("is_active", true)
    .maybeSingle();
  legacyXError(error, "Unable to authenticate plugin token");
  if (!data || !hasPluginScope(data.scopes, requiredScope)) {
    throw Object.assign(new Error("Plugin token is invalid or missing the required scope"), { statusCode: 403 });
  }
  return { id: data.id, name: data.name, scopes: data.scopes };
}

function steamQueryValue(value: unknown) {
  return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

export function steamLoginUrl(origin: string) {
  const callback = `${origin}/api/v1/auth/steam/callback`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": callback,
    "openid.realm": origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `https://steamcommunity.com/openid/login?${params.toString()}`;
}

export async function verifySteamCallback(query: Record<string, unknown>) {
  const claimedId = steamQueryValue(query["openid.claimed_id"]);
  const match = claimedId.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!match) throw Object.assign(new Error("Steam did not provide a valid claimed identity"), { statusCode: 401 });

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("openid.")) params.set(key, steamQueryValue(value));
  }
  params.set("openid.mode", "check_authentication");

  const response = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const body = await response.text();
  if (!response.ok || !body.includes("is_valid:true")) {
    throw Object.assign(new Error("Steam OpenID response could not be verified"), { statusCode: 401 });
  }
  return match[1]!;
}
