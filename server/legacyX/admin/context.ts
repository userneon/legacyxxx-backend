import type { Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { parseCookieHeader } from "../../_core/cookieHeader";
import { sha256, type LegacyUser } from "../auth";
import { apiError, asyncRoute, requireUser, type ApiRequest } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import { can, isStaff, type Denial, type Principal, type RoleSummary } from "./permissions";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

export const steamIdPattern = /^7656\d{13}$/;

/* ---------------------------------------------------------------------------
 * Principals
 * ------------------------------------------------------------------------ */

function principalFromRows(user: { id: string; steamId: string; username: string }, rows: DbRow[]): Principal {
  const roles: RoleSummary[] = [];
  const permissions = new Set<string>();
  for (const row of rows) {
    const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
    if (!role) continue;
    roles.push({ id: String(role.id), name: String(role.name), immunity: Number(role.immunity) || 0, isLocked: role.is_locked === true });
    for (const grant of (role.role_permissions ?? []) as DbRow[]) permissions.add(String(grant.permission_key));
  }
  roles.sort((a, b) => b.immunity - a.immunity);
  return { userId: user.id, steamId: user.steamId, username: user.username, roles, permissions, immunity: roles[0]?.immunity ?? 0 };
}

const roleSelect = "role_id,roles(id,name,immunity,is_locked,role_permissions(permission_key))";

export async function loadPrincipal(user: LegacyUser): Promise<Principal> {
  const { data, error } = await db().from("user_roles").select(roleSelect).eq("user_id", user.id);
  legacyXError(error, "Unable to load staff roles");
  return principalFromRows(user, (data ?? []) as DbRow[]);
}

/** Resolves a SteamID64 to its principal. Unknown players are a principal with no roles and immunity 0. */
export async function loadPrincipalBySteamId(steamId: string): Promise<Principal> {
  const { data: user, error } = await db().from("users").select("id,steam_id,username").eq("steam_id", steamId).maybeSingle();
  legacyXError(error, "Unable to resolve player");
  if (!user) return { userId: "", steamId, username: "", roles: [], permissions: new Set(), immunity: 0 };
  return loadPrincipal({ id: String(user.id), steamId, username: String(user.username) });
}

/* ---------------------------------------------------------------------------
 * Route guards
 * ------------------------------------------------------------------------ */

export type AdminHandler = (req: ApiRequest, res: Response, actor: Principal) => Promise<void>;

/** Signed-in staff member holding every listed permission. */
export function adminRoute(permissions: string | string[], handler: AdminHandler) {
  const required = Array.isArray(permissions) ? permissions : [permissions];
  return asyncRoute(async (req, res) => {
    const actor = await loadPrincipal(await requireUser(req));
    if (!isStaff(actor)) apiError(403, "Staff access is required");
    for (const key of required) if (!can(actor, key)) apiError(403, `Missing permission ${key}`);
    await handler(req, res, actor);
  });
}

/** Signed-in staff member holding at least one of the listed permissions. */
export function adminAnyRoute(permissions: string[], handler: AdminHandler) {
  return asyncRoute(async (req, res) => {
    const actor = await loadPrincipal(await requireUser(req));
    if (!isStaff(actor)) apiError(403, "Staff access is required");
    if (!permissions.some(key => can(actor, key))) apiError(403, "Missing permission");
    await handler(req, res, actor);
  });
}

/** Turns a rule's refusal into a 403. */
export function enforce(denial: Denial) {
  if (denial) apiError(403, denial);
}

/* ---------------------------------------------------------------------------
 * Re-authentication for role and permission changes
 * ------------------------------------------------------------------------ */

export const reauthCookieName = "legacyx_admin_reauth";
export const reauthLifetimeSeconds = 10 * 60;

function reauthKey() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is not configured");
  return new TextEncoder().encode(`${value}:admin-reauth`);
}

export async function issueReauthToken(userId: string) {
  return new SignJWT({ purpose: "admin_reauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${reauthLifetimeSeconds}s`)
    .sign(reauthKey());
}

export async function reauthExpiry(req: Request, userId: string): Promise<Date | null> {
  const raw = parseCookieHeader(req.headers.cookie ?? "")[reauthCookieName];
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, reauthKey());
    if (payload.purpose !== "admin_reauth" || payload.sub !== userId || !payload.exp) return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export async function requireReauth(req: Request, actor: Principal) {
  if (!(await reauthExpiry(req, actor.userId))) apiError(428, "Re-authentication with Steam is required for this change");
}

export function reauthCookieOptions(maxAgeMs: number) {
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  return { httpOnly: true, secure: true, sameSite: "lax" as const, domain: domain || undefined, path: "/api/v1", maxAge: maxAgeMs };
}

/* ---------------------------------------------------------------------------
 * Audit log (insert-only)
 * ------------------------------------------------------------------------ */

export type AuditEntry = {
  action: string;
  targetType?: string;
  targetId?: string | null;
  targetSteamId?: string | null;
  serverId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

export async function writeAudit(actor: Pick<Principal, "userId" | "steamId" | "immunity"> | null, entry: AuditEntry) {
  const { error } = await db().from("admin_audit_logs").insert({
    actor_user_id: actor?.userId || null,
    actor_steam_id: actor?.steamId || null,
    actor_immunity: actor ? actor.immunity : null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    target_steam_id: entry.targetSteamId ?? null,
    server_id: entry.serverId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    metadata: entry.metadata ?? {},
  });
  // A mutating action that cannot be audited must not look successful.
  legacyXError(error, "Unable to write the audit log");
}

/* ---------------------------------------------------------------------------
 * Game server authentication
 * ------------------------------------------------------------------------ */

export type GameServerPrincipal = { id: string; name: string };
export type ServerRequest = ApiRequest & { gameServer?: GameServerPrincipal };

export const serverKeyPrefix = "lxs_";

function serverCredential(req: Request) {
  const header = req.header("x-server-key")?.trim();
  if (header) return header;
  const value = req.header("authorization");
  if (value?.startsWith("Bearer ")) return value.slice(7).trim();
  apiError(401, "Game server API key is required");
}

export async function authenticateGameServer(req: ServerRequest): Promise<GameServerPrincipal> {
  const key = serverCredential(req);
  if (!key.startsWith(serverKeyPrefix) || key.length < 40) apiError(401, "Game server API key is invalid");
  const { data, error } = await db()
    .from("game_servers")
    .select("id,name")
    .eq("api_key_hash", sha256(key))
    .is("deleted_at", null)
    .maybeSingle();
  legacyXError(error, "Unable to verify game server");
  if (!data) apiError(401, "Game server API key is invalid");
  const server = { id: String(data.id), name: String(data.name) };
  req.gameServer = server;
  void db().from("game_servers").update({ last_seen_at: new Date().toISOString() }).eq("id", server.id).then(() => undefined);
  return server;
}

export function serverRoute(handler: (req: ServerRequest, res: Response, server: GameServerPrincipal) => Promise<void>) {
  return asyncRoute(async (req, res) => handler(req, res, await authenticateGameServer(req)));
}
