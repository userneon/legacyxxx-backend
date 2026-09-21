/** Staff panel: identity, dashboard, search, live servers, servers and player moderation views. */
import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { sha256, steamLoginUrl, verifySteamCallback } from "../auth";
import { apiError, asyncRoute, userRoute } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import {
  adminAnyRoute,
  adminRoute,
  issueReauthToken,
  loadPrincipal,
  loadPrincipalBySteamId,
  reauthCookieName,
  reauthCookieOptions,
  reauthExpiry,
  reauthLifetimeSeconds,
  serverKeyPrefix,
  steamIdPattern,
  writeAudit,
} from "./context";
import { activeBan, activeMute, currentServerFor, queueGameAction } from "./moderation";
import { can, checkIssueBan, checkIssueMute, checkKick, isStaff, outranks, type Principal } from "./permissions";
import { playerCards, playerFlags, userCards } from "./players";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

const steamIdParam = z.string().regex(steamIdPattern, "SteamID64 is required");
const uuid = z.string().uuid();
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().datetime().optional() });

export function staffSummary(principal: Principal) {
  return {
    roles: principal.roles.map(role => ({ id: role.id, name: role.name, immunity: role.immunity })),
    permissions: [...principal.permissions].sort(),
    immunity: principal.immunity,
  };
}

function publicPlayer(row: DbRow) {
  return { steamId: row.steam_id, username: row.username, avatar: row.avatar ?? "", level: Number(row.level) || 0, rank: row.rank ?? "", memberSince: row.created_at };
}

function onlineCutoff() {
  return new Date(Date.now() - 2 * 60_000).toISOString();
}

function frontendOrigin() {
  const configured = process.env.FRONTEND_ORIGIN?.trim() || process.env.POST_LOGIN_REDIRECT?.trim();
  if (!configured) apiError(500, "FRONTEND_ORIGIN must be configured");
  return new URL(configured).origin;
}

function openIdOrigin(req: Request) {
  const configured = process.env.STEAM_OPENID_ORIGIN?.trim() || process.env.PUBLIC_API_ORIGIN?.trim();
  return configured ? configured.replace(/\/$/, "") : `${req.protocol}://${req.get("host")}`;
}

function safeReturnTo(value: unknown) {
  return typeof value === "string" && /^\/panel(\/[\w\-/]*)?$/.test(value) ? value : "/panel/staff";
}

export async function countBadge(actor: Principal) {
  const [reports, review] = await Promise.all([
    can(actor, "reports.view") ? db().from("reports").select("id", { count: "exact", head: true }).eq("status", "open") : Promise.resolve({ count: 0, error: null }),
    can(actor, "bans.review") ? db().from("bans").select("id", { count: "exact", head: true }).eq("review_status", "pending") : Promise.resolve({ count: 0, error: null }),
  ]);
  legacyXError(reports.error || review.error, "Unable to count pending work");
  return { reports: reports.count ?? 0, reviewQueue: review.count ?? 0, total: (reports.count ?? 0) + (review.count ?? 0) };
}

async function serverList(includeKeys: boolean) {
  const { data, error } = await db().from("game_servers").select("id,name,map,mode,max_players,ip_address,port,last_seen_at,api_key_prefix,api_key_rotated_at,created_at")
    .is("deleted_at", null).order("name");
  legacyXError(error, "Unable to load servers");
  const servers = (data ?? []) as DbRow[];
  const { data: open, error: openError } = await db().from("player_sessions").select("server_id").is("disconnected_at", null);
  legacyXError(openError, "Unable to count players");
  const counts = new Map<string, number>();
  for (const row of (open ?? []) as DbRow[]) counts.set(row.server_id, (counts.get(row.server_id) ?? 0) + 1);
  const cutoff = onlineCutoff();
  return servers.map(server => ({
    id: server.id,
    name: server.name,
    map: server.map,
    mode: server.mode,
    maxPlayers: server.max_players,
    address: server.ip_address ? `${server.ip_address}${server.port ? `:${server.port}` : ""}` : null,
    online: Boolean(server.last_seen_at && server.last_seen_at > cutoff),
    lastSeenAt: server.last_seen_at,
    players: counts.get(server.id) ?? 0,
    ...(includeKeys ? { apiKeyPrefix: server.api_key_prefix, apiKeyRotatedAt: server.api_key_rotated_at, hasApiKey: Boolean(server.api_key_prefix) } : {}),
  }));
}

async function loadServer(serverId: string) {
  const { data, error } = await db().from("game_servers").select("id,name,map,mode,max_players,ip_address,port,last_seen_at").eq("id", serverId).is("deleted_at", null).maybeSingle();
  legacyXError(error, "Unable to load server");
  if (!data) apiError(404, "Server was not found");
  return data as DbRow;
}

function newServerKey() {
  const key = `${serverKeyPrefix}${randomBytes(24).toString("base64url")}`;
  return { key, hash: sha256(key), prefix: key.slice(0, serverKeyPrefix.length + 6) };
}

async function sessionRows(rows: DbRow[], serverId?: string) {
  const ids = rows.map(row => row.steam_id);
  const [cards, flags, immunities] = await Promise.all([playerCards(ids), playerFlags(ids, serverId), immunityBySteamId(ids)]);
  return rows.map(row => ({
    sessionId: row.id,
    steamId: row.steam_id,
    name: row.player_name,
    avatar: cards.get(row.steam_id)?.avatar ?? "",
    matchId: row.match_id,
    serverId: row.server_id,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    immunity: immunities.get(row.steam_id) ?? 0,
    flags: flags.get(row.steam_id),
  }));
}

async function immunityBySteamId(steamIds: string[]) {
  const map = new Map<string, number>();
  const ids = [...new Set(steamIds)];
  if (ids.length === 0) return map;
  const { data, error } = await db().from("users").select("steam_id,user_roles!user_roles_user_id_fkey(roles(immunity))").in("steam_id", ids);
  legacyXError(error, "Unable to resolve immunity");
  for (const row of (data ?? []) as DbRow[]) {
    let best = 0;
    for (const grant of (row.user_roles ?? []) as DbRow[]) {
      const role = Array.isArray(grant.roles) ? grant.roles[0] : grant.roles;
      best = Math.max(best, Number(role?.immunity) || 0);
    }
    map.set(row.steam_id, best);
  }
  return map;
}

export function mapChat(row: DbRow) {
  return { id: row.id, steamId: row.steam_id, name: row.player_name, message: row.message, teamOnly: row.team_only, serverId: row.server_id, matchId: row.match_id, sentAt: row.sent_at };
}

export function createPanelRouter() {
  const router = Router();

  /* -------------------------------------------------------------------------
   * Identity
   * ---------------------------------------------------------------------- */

  /** Extends the signed-in identity with staff roles; `staff` is null for players. */
  router.get("/users/me", userRoute(async (_req, res, user) => {
    const [principal, profile] = await Promise.all([
      loadPrincipal(user),
      db().from("users").select("id,steam_id,username,avatar").eq("id", user.id).maybeSingle(),
    ]);
    legacyXError(profile.error, "Unable to load user");
    if (!profile.data) apiError(404, "User was not found");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: { id: profile.data.id, steamId: profile.data.steam_id, username: profile.data.username, avatar: profile.data.avatar ?? "" },
      staff: isStaff(principal) ? staffSummary(principal) : null,
    });
  }));

  router.get("/admin/badge", adminRoute("panel.access", async (_req, res, actor) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await countBadge(actor));
  }));

  /* Re-authentication: a fresh Steam sign-in unlocks role changes for ten minutes. */
  router.get("/admin/reauth/status", adminRoute("panel.access", async (req, res, actor) => {
    const expires = await reauthExpiry(req, actor.userId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ fresh: Boolean(expires), expiresAt: expires?.toISOString() ?? null });
  }));

  router.get("/admin/reauth/steam", asyncRoute(async (req, res) => {
    const origin = openIdOrigin(req);
    const returnTo = safeReturnTo(req.query.returnTo);
    const callback = `${origin}/api/v1/admin/reauth/steam/callback?returnTo=${encodeURIComponent(returnTo)}`;
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, steamLoginUrl(origin, callback));
  }));

  router.get("/admin/reauth/steam/callback", asyncRoute(async (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    const target = new URL(returnTo, frontendOrigin());
    res.setHeader("Cache-Control", "no-store");
    try {
      const steamId = await verifySteamCallback(req.query as Record<string, unknown>);
      const { data: user, error } = await db().from("users").select("id,steam_id,username").eq("steam_id", steamId).maybeSingle();
      legacyXError(error, "Unable to resolve identity");
      if (!user) apiError(403, "Unknown Steam account");
      const principal = await loadPrincipal({ id: user.id, steamId, username: user.username });
      if (!isStaff(principal)) apiError(403, "Staff access is required");
      res.cookie(reauthCookieName, await issueReauthToken(user.id), reauthCookieOptions(reauthLifetimeSeconds * 1000));
      await writeAudit(principal, { action: "auth.reauth", targetType: "user", targetId: user.id });
      target.searchParams.set("reauth", "done");
    } catch {
      target.searchParams.set("reauth", "failed");
    }
    res.redirect(302, target.toString());
  }));

  /* -------------------------------------------------------------------------
   * Dashboard, search and live
   * ---------------------------------------------------------------------- */

  router.get("/admin/dashboard", adminRoute("panel.access", async (_req, res, actor) => {
    const now = new Date().toISOString();
    const active = `is_permanent.eq.true,expires_at.gt.${now}`;
    const [badge, bans, mutes, appeals, servers] = await Promise.all([
      countBadge(actor),
      can(actor, "bans.view") ? db().from("bans").select("id", { count: "exact", head: true }).is("revoked_at", null).or(active) : Promise.resolve({ count: null, error: null }),
      can(actor, "mutes.view") ? db().from("mutes").select("id", { count: "exact", head: true }).is("revoked_at", null).or(active) : Promise.resolve({ count: null, error: null }),
      can(actor, "appeals.view") ? db().from("ban_appeals").select("id", { count: "exact", head: true }).eq("status", "open") : Promise.resolve({ count: null, error: null }),
      can(actor, "servers.view") ? serverList(false) : Promise.resolve([]),
    ]);
    legacyXError(bans.error || mutes.error || appeals.error, "Unable to load dashboard");
    let recent: DbRow[] = [];
    if (can(actor, "audit.view")) {
      const { data, error } = await db().from("admin_audit_logs").select("*").order("created_at", { ascending: false }).limit(8);
      legacyXError(error, "Unable to load recent actions");
      recent = await mapAuditRows((data ?? []) as DbRow[]);
    }
    res.json({
      openReports: can(actor, "reports.view") ? badge.reports : null,
      reviewQueue: can(actor, "bans.review") ? badge.reviewQueue : null,
      openAppeals: appeals.count,
      activeBans: bans.count,
      activeMutes: mutes.count,
      onlinePlayers: servers.reduce((sum, server) => sum + server.players, 0),
      servers,
      recentActions: recent,
    });
  }));

  router.get("/admin/search", adminRoute("players.view", async (req, res) => {
    const q = z.string().trim().min(2).max(64).parse(req.query.q);
    const players: DbRow[] = [];
    if (/^\d{17}$/.test(q)) {
      const cards = await playerCards([q]);
      players.push(cards.get(q)!);
    } else {
      const escaped = q.replace(/[%_\\,()]/g, match => `\\${match}`);
      const [users, names] = await Promise.all([
        db().from("users").select("steam_id").ilike("username", `%${escaped}%`).limit(10),
        db().from("player_name_history").select("steam_id").ilike("name", `%${escaped}%`).order("last_seen_at", { ascending: false }).limit(10),
      ]);
      legacyXError(users.error || names.error, "Unable to search players");
      const ids = [...new Set([...(users.data ?? []), ...(names.data ?? [])].map((row: DbRow) => row.steam_id))].slice(0, 10);
      const cards = await playerCards(ids);
      players.push(...ids.map(id => cards.get(id)!));
    }
    const { data: matches, error } = await db().from("player_sessions").select("match_id,server_id,connected_at").ilike("match_id", `${q.replace(/[%_\\]/g, "")}%`).order("connected_at", { ascending: false }).limit(20);
    legacyXError(error, "Unable to search matches");
    const seen = new Set<string>();
    const matchHits = ((matches ?? []) as DbRow[]).filter(row => row.match_id && !seen.has(row.match_id) && seen.add(row.match_id)).slice(0, 5)
      .map(row => ({ matchId: row.match_id, serverId: row.server_id, lastSeenAt: row.connected_at }));
    res.json({ players, matches: matchHits });
  }));

  router.get("/admin/live", adminRoute("live.view", async (_req, res, actor) => {
    const [servers, current] = await Promise.all([serverList(false), currentServerFor(actor.steamId)]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ servers, current });
  }));

  /* -------------------------------------------------------------------------
   * Servers
   * ---------------------------------------------------------------------- */

  router.get("/admin/servers", adminRoute("servers.view", async (_req, res, actor) => {
    res.json({ servers: await serverList(can(actor, "servers.rotate_key")) });
  }));

  router.post("/admin/servers", adminRoute("servers.create", async (req, res, actor) => {
    const input = z.object({
      name: z.string().trim().min(2).max(64),
      ipAddress: z.string().trim().max(64).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      mode: z.enum(["5vs5", "fun", "proleague", "tournaments"]).default("5vs5"),
      maxPlayers: z.number().int().min(2).max(64).default(10),
    }).strict().parse(req.body);
    const key = newServerKey();
    const { data, error } = await db().from("game_servers").insert({
      name: input.name, map: "de_dust2", mode: input.mode, max_players: input.maxPlayers, current_players: 0, ping: 0, status: "offline",
      ip_address: input.ipAddress ?? null, port: input.port ?? null, api_key_hash: key.hash, api_key_prefix: key.prefix,
      api_key_rotated_at: new Date().toISOString(), created_by: actor.userId,
    }).select("id,name").single();
    legacyXError(error, "Unable to create the server");
    await writeAudit(actor, { action: "servers.create", targetType: "server", targetId: data!.id, serverId: data!.id, after: { name: input.name, keyPrefix: key.prefix } });
    // The key is returned once and never stored in plain text.
    res.status(201).json({ server: { id: data!.id, name: data!.name }, apiKey: key.key });
  }));

  router.post("/admin/servers/:serverId/rotate-key", adminRoute("servers.rotate_key", async (req, res, actor) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const key = newServerKey();
    const { error } = await db().from("game_servers").update({ api_key_hash: key.hash, api_key_prefix: key.prefix, api_key_rotated_at: new Date().toISOString() }).eq("id", server.id);
    legacyXError(error, "Unable to rotate the key");
    await writeAudit(actor, { action: "servers.rotate_key", targetType: "server", targetId: server.id, serverId: server.id, after: { keyPrefix: key.prefix } });
    res.json({ apiKey: key.key });
  }));

  router.post("/admin/servers/:serverId/delete", adminRoute("servers.delete", async (req, res, actor) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
    if (confirm.trim() !== server.name) apiError(400, "Type the server name to confirm");
    const { error } = await db().from("game_servers").update({ deleted_at: new Date().toISOString(), api_key_hash: null, api_key_prefix: null, status: "offline" }).eq("id", server.id);
    legacyXError(error, "Unable to delete the server");
    await writeAudit(actor, { action: "servers.delete", targetType: "server", targetId: server.id, serverId: server.id, before: { name: server.name } });
    res.json({ ok: true });
  }));

  router.get("/admin/servers/:serverId", adminRoute("servers.view", async (req, res) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const { data, error } = await db().from("player_sessions").select("*").eq("server_id", server.id).is("disconnected_at", null).order("connected_at");
    legacyXError(error, "Unable to load live players");
    const players = await sessionRows((data ?? []) as DbRow[], server.id);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      server: { id: server.id, name: server.name, map: server.map, mode: server.mode, maxPlayers: server.max_players, online: Boolean(server.last_seen_at && server.last_seen_at > onlineCutoff()), lastSeenAt: server.last_seen_at },
      matchId: players.find(player => player.matchId)?.matchId ?? null,
      players,
    });
  }));

  router.get("/admin/servers/:serverId/recent", adminRoute(["servers.view", "players.sessions.view"], async (req, res) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const hours = z.coerce.number().int().min(1).max(24).default(5).parse(req.query.hours);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data, error } = await db().from("player_sessions").select("*").eq("server_id", server.id)
      .or(`disconnected_at.is.null,disconnected_at.gte.${since}`).order("connected_at", { ascending: false }).limit(300);
    legacyXError(error, "Unable to load recent players");
    res.json({ hours, rows: await sessionRows((data ?? []) as DbRow[], server.id) });
  }));

  router.get("/admin/servers/:serverId/chat", adminRoute(["servers.view", "players.chat.view"], async (req, res) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const page = pageSchema.parse(req.query);
    let query = db().from("chat_logs").select("*").eq("server_id", server.id).order("sent_at", { ascending: false }).limit(page.limit);
    if (page.before) query = query.lt("sent_at", page.before);
    const { data, error } = await query;
    legacyXError(error, "Unable to load chat");
    res.json({ messages: ((data ?? []) as DbRow[]).map(mapChat) });
  }));

  router.get("/admin/servers/:serverId/actions", adminRoute(["servers.view", "audit.view"], async (req, res) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const [audit, queue] = await Promise.all([
      db().from("admin_audit_logs").select("*").eq("server_id", server.id).order("created_at", { ascending: false }).limit(100),
      db().from("admin_game_actions").select("*").eq("server_id", server.id).order("created_at", { ascending: false }).limit(50),
    ]);
    legacyXError(audit.error || queue.error, "Unable to load server actions");
    res.json({
      audit: await mapAuditRows((audit.data ?? []) as DbRow[]),
      queue: ((queue.data ?? []) as DbRow[]).map(row => ({ id: row.id, action: row.action, targetSteamId: row.target_steam_id, status: row.status, failure: row.failure, createdAt: row.created_at, completedAt: row.completed_at })),
    });
  }));

  router.post("/admin/servers/:serverId/commands", adminAnyRoute(["servers.map_change", "servers.round_restart"], async (req, res, actor) => {
    const server = await loadServer(uuid.parse(req.params.serverId));
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("map_change"), map: z.string().trim().regex(/^[a-z0-9_]{2,48}$/i) }),
      z.object({ action: z.literal("round_restart") }),
    ]).parse(req.body);
    const key = input.action === "map_change" ? "servers.map_change" : "servers.round_restart";
    if (!can(actor, key)) apiError(403, `Missing permission ${key}`);
    const actionId = await queueGameAction(server.id, input.action, null, input.action === "map_change" ? { map: input.map } : {}, actor.userId);
    await writeAudit(actor, { action: key, targetType: "server", targetId: server.id, serverId: server.id, metadata: { source: "panel", actionId, map: "map" in input ? input.map : undefined } });
    res.status(202).json({ ok: true, actionId });
  }));

  router.get("/admin/matches/:matchId", adminRoute(["servers.view", "players.sessions.view"], async (req, res, actor) => {
    const matchId = z.string().trim().min(1).max(80).parse(req.params.matchId);
    const { data, error } = await db().from("player_sessions").select("*").eq("match_id", matchId).order("connected_at").limit(200);
    legacyXError(error, "Unable to load the match");
    const rows = (data ?? []) as DbRow[];
    if (rows.length === 0) apiError(404, "Match was not found");
    const serverId = rows[0]!.server_id as string;
    const [server, chat, reports] = await Promise.all([
      db().from("game_servers").select("id,name,map").eq("id", serverId).maybeSingle(),
      can(actor, "players.chat.view") ? db().from("chat_logs").select("*").eq("match_id", matchId).order("sent_at", { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null }),
      can(actor, "reports.view") ? db().from("reports").select("*").eq("match_id", matchId).order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    ]);
    legacyXError(server.error || chat.error || reports.error, "Unable to load the match");
    res.setHeader("Cache-Control", "no-store");
    res.json({
      matchId,
      server: server.data ? { id: server.data.id, name: server.data.name, map: server.data.map } : null,
      live: rows.some(row => !row.disconnected_at),
      players: await sessionRows(rows, serverId),
      chat: ((chat.data ?? []) as DbRow[]).map(mapChat),
      reports: await mapReports((reports.data ?? []) as DbRow[], actor),
    });
  }));

  /* -------------------------------------------------------------------------
   * Players
   * ---------------------------------------------------------------------- */

  /** Public profile: never includes moderation data. Non-SteamID ids fall through to the existing uuid route. */
  router.get("/players/:steamId", asyncRoute(async (req, res, next) => {
    if (!steamIdPattern.test(req.params.steamId as string)) return next();
    const { data, error } = await db().from("users").select("steam_id,username,avatar,level,rank,created_at").eq("steam_id", req.params.steamId).maybeSingle();
    legacyXError(error, "Unable to load player");
    if (!data) apiError(404, "Player was not found");
    res.json(publicPlayer(data as DbRow));
  }));

  router.get("/players/:steamId/moderation", adminRoute("players.moderation.view", async (req, res, actor) => {
    const steamId = steamIdParam.parse(req.params.steamId);
    const [target, cards, flags, ban, mute, live, counts] = await Promise.all([
      loadPrincipalBySteamId(steamId),
      playerCards([steamId]),
      playerFlags([steamId]),
      activeBan(steamId),
      activeMute(steamId),
      currentServerFor(steamId),
      Promise.all([
        db().from("bans").select("id", { count: "exact", head: true }).eq("steam_id", steamId),
        db().from("mutes").select("id", { count: "exact", head: true }).eq("steam_id", steamId),
        db().from("reports").select("id", { count: "exact", head: true }).eq("target_steam_id", steamId),
        db().from("staff_notes").select("id", { count: "exact", head: true }).eq("target_steam_id", steamId),
      ]),
    ]);
    const [banCount, muteCount, reportCount, noteCount] = counts;
    legacyXError(banCount.error || muteCount.error || reportCount.error || noteCount.error, "Unable to load moderation summary");
    const card = cards.get(steamId)!;
    const above = !outranks(actor, target.immunity);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      player: { ...card, hasAccount: Boolean(target.userId) },
      staffRole: target.roles[0] ? { name: target.roles[0].name, immunity: target.immunity } : null,
      aboveYourRank: above,
      activeBan: ban ? { id: ban.id, reason: ban.reason, permanent: ban.is_permanent, expiresAt: ban.expires_at } : null,
      activeMute: mute ? { id: mute.id, kind: mute.kind, reason: mute.reason, permanent: mute.is_permanent, expiresAt: mute.expires_at } : null,
      live,
      flags: flags.get(steamId),
      counts: { bans: banCount.count ?? 0, mutes: muteCount.count ?? 0, reports: reportCount.count ?? 0, notes: noteCount.count ?? 0 },
      actions: {
        kick: !checkKick(actor, target.immunity) && Boolean(live),
        mute: !checkIssueMute(actor, target.immunity),
        ban: !checkIssueBan(actor, target.immunity, false),
        banPermanent: !checkIssueBan(actor, target.immunity, true),
        note: can(actor, "staff_notes.create"),
      },
      tabs: {
        punishments: can(actor, "bans.view") || can(actor, "mutes.view"),
        sessions: can(actor, "players.sessions.view"),
        reports: can(actor, "reports.view"),
        chat: can(actor, "players.chat.view"),
        names: can(actor, "players.name_history.view"),
        notes: can(actor, "staff_notes.view"),
        audit: can(actor, "audit.view"),
      },
    });
  }));

  router.get("/players/:steamId/moderation/:tab", adminRoute("players.moderation.view", async (req, res, actor) => {
    const steamId = steamIdParam.parse(req.params.steamId);
    const tab = z.enum(["punishments", "sessions", "reports", "chat", "names", "notes", "audit"]).parse(req.params.tab);
    const page = pageSchema.parse(req.query);
    const need = (key: string) => { if (!can(actor, key)) apiError(403, `Missing permission ${key}`); };

    if (tab === "punishments") {
      if (!can(actor, "bans.view") && !can(actor, "mutes.view")) apiError(403, "Missing permission bans.view");
      const [bans, mutes] = await Promise.all([
        can(actor, "bans.view") ? db().from("bans").select("*").eq("steam_id", steamId).order("created_at", { ascending: false }).limit(page.limit) : Promise.resolve({ data: [], error: null }),
        can(actor, "mutes.view") ? db().from("mutes").select("*").eq("steam_id", steamId).order("created_at", { ascending: false }).limit(page.limit) : Promise.resolve({ data: [], error: null }),
      ]);
      legacyXError(bans.error || mutes.error, "Unable to load punishments");
      const rows: DbRow[] = [...((bans.data ?? []) as DbRow[]).map(row => ({ ...row, _type: "ban" })), ...((mutes.data ?? []) as DbRow[]).map(row => ({ ...row, _type: "mute" }))];
      const issuers = await userCards(rows.flatMap(row => [row.issued_by, row.revoked_by]));
      res.json({ items: rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(row => mapPunishment(row, issuers)) });
      return;
    }
    if (tab === "sessions") {
      need("players.sessions.view");
      let query = db().from("player_sessions").select("*,game_servers(name)").eq("steam_id", steamId).order("connected_at", { ascending: false }).limit(page.limit);
      if (page.before) query = query.lt("connected_at", page.before);
      const { data, error } = await query;
      legacyXError(error, "Unable to load sessions");
      res.json({ items: ((data ?? []) as DbRow[]).map(row => ({ id: row.id, serverId: row.server_id, serverName: (Array.isArray(row.game_servers) ? row.game_servers[0] : row.game_servers)?.name ?? "", matchId: row.match_id, name: row.player_name, connectedAt: row.connected_at, disconnectedAt: row.disconnected_at, reason: row.disconnect_reason })) });
      return;
    }
    if (tab === "reports") {
      need("reports.view");
      const { data, error } = await db().from("reports").select("*").eq("target_steam_id", steamId).order("created_at", { ascending: false }).limit(page.limit);
      legacyXError(error, "Unable to load reports");
      res.json({ items: await mapReports((data ?? []) as DbRow[], actor) });
      return;
    }
    if (tab === "chat") {
      need("players.chat.view");
      let query = db().from("chat_logs").select("*").eq("steam_id", steamId).order("sent_at", { ascending: false }).limit(page.limit);
      if (page.before) query = query.lt("sent_at", page.before);
      const { data, error } = await query;
      legacyXError(error, "Unable to load chat");
      res.json({ items: ((data ?? []) as DbRow[]).map(mapChat) });
      return;
    }
    if (tab === "names") {
      need("players.name_history.view");
      const { data, error } = await db().from("player_name_history").select("name,first_seen_at,last_seen_at,times_seen").eq("steam_id", steamId).order("last_seen_at", { ascending: false }).limit(page.limit);
      legacyXError(error, "Unable to load name history");
      res.json({ items: ((data ?? []) as DbRow[]).map(row => ({ name: row.name, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, timesSeen: row.times_seen })) });
      return;
    }
    if (tab === "notes") {
      need("staff_notes.view");
      const { data, error } = await db().from("staff_notes").select("*").eq("target_steam_id", steamId).order("created_at", { ascending: false }).limit(page.limit);
      legacyXError(error, "Unable to load notes");
      const authors = await userCards(((data ?? []) as DbRow[]).map(row => row.author_user_id));
      res.json({ items: ((data ?? []) as DbRow[]).map(row => ({ id: row.id, body: row.body, author: authors.get(row.author_user_id) ?? null, createdAt: row.created_at })) });
      return;
    }
    need("audit.view");
    const { data, error } = await db().from("admin_audit_logs").select("*").eq("target_steam_id", steamId).order("created_at", { ascending: false }).limit(page.limit);
    legacyXError(error, "Unable to load audit");
    res.json({ items: await mapAuditRows((data ?? []) as DbRow[]) });
  }));

  router.post("/players/:steamId/notes", adminRoute("staff_notes.create", async (req, res, actor) => {
    const steamId = steamIdParam.parse(req.params.steamId);
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const { data, error } = await db().from("staff_notes").insert({ target_steam_id: steamId, author_user_id: actor.userId, body }).select("id,created_at").single();
    legacyXError(error, "Unable to save the note");
    await writeAudit(actor, { action: "staff_notes.create", targetType: "staff_note", targetId: data!.id, targetSteamId: steamId });
    res.status(201).json({ id: data!.id, createdAt: data!.created_at });
  }));

  return router;
}

/* ---------------------------------------------------------------------------
 * Shared mappers
 * ------------------------------------------------------------------------ */

type UserCardMap = Awaited<ReturnType<typeof userCards>>;

export function mapPunishment(row: DbRow, people: UserCardMap) {
  const now = Date.now();
  const status = row.revoked_at ? "revoked" : row.is_permanent || (row.expires_at && new Date(row.expires_at).getTime() > now) ? "active" : "expired";
  return {
    id: row.id,
    type: row._type ?? (row.kind ? "mute" : "ban"),
    kind: row.kind ?? null,
    steamId: row.steam_id,
    reason: row.reason,
    permanent: row.is_permanent,
    expiresAt: row.expires_at,
    status,
    reviewStatus: row.review_status ?? null,
    issuer: people.get(row.issued_by) ?? (row.issuer_steam_id ? { userId: null, steamId: row.issuer_steam_id, name: row.issuer_steam_id, avatar: "" } : null),
    issuerImmunity: row.issuer_immunity,
    source: row.source,
    serverId: row.server_id,
    matchId: row.match_id,
    revokedAt: row.revoked_at,
    revokedBy: people.get(row.revoked_by) ?? null,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at,
  };
}

export async function mapReports(rows: DbRow[], actor: Principal) {
  const showReporter = can(actor, "reports.reporter.view");
  const reporterIds = rows.map(row => row.reporter_steam_id);
  const [targets, reporters, accuracy, handlers] = await Promise.all([
    playerCards(rows.map(row => row.target_steam_id)),
    showReporter ? playerCards(reporterIds) : Promise.resolve(new Map()),
    reporterIds.length ? db().from("reporter_accuracy").select("*").in("reporter_steam_id", [...new Set(reporterIds)]) : Promise.resolve({ data: [], error: null }),
    userCards(rows.map(row => row.handled_by)),
  ]);
  legacyXError(accuracy.error, "Unable to load reporter accuracy");
  const accuracyBy = new Map(((accuracy.data ?? []) as DbRow[]).map(row => [row.reporter_steam_id, row]));
  return rows.map(row => {
    const acc = accuracyBy.get(row.reporter_steam_id);
    return {
      id: row.id,
      target: targets.get(row.target_steam_id) ?? { steamId: row.target_steam_id, name: row.target_name ?? row.target_steam_id, avatar: "", userId: null },
      targetName: row.target_name,
      // Reporter identity is withheld unless the actor holds reports.reporter.view.
      reporter: showReporter ? reporters.get(row.reporter_steam_id) ?? null : null,
      reporterAccuracy: acc ? { accuracy: acc.accuracy === null ? null : Number(acc.accuracy), total: acc.total_reports, actioned: acc.actioned_reports } : null,
      reason: row.reason,
      details: row.details,
      status: row.status,
      serverId: row.server_id,
      matchId: row.match_id,
      handledBy: handlers.get(row.handled_by) ?? null,
      handledAt: row.handled_at,
      outcomeNote: row.outcome_note,
      createdAt: row.created_at,
    };
  });
}

export async function mapAuditRows(rows: DbRow[]) {
  const actors = await userCards(rows.map(row => row.actor_user_id));
  return rows.map(row => ({
    id: row.id,
    action: row.action,
    actor: actors.get(row.actor_user_id) ?? (row.actor_steam_id ? { userId: null, steamId: row.actor_steam_id, name: row.actor_steam_id, avatar: "" } : null),
    actorImmunity: row.actor_immunity,
    targetType: row.target_type,
    targetId: row.target_id,
    targetSteamId: row.target_steam_id,
    serverId: row.server_id,
    before: row.before,
    after: row.after,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

