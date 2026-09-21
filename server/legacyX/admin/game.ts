/**
 * Internal endpoints for the CS2 plugin. Every route authenticates the game server by its API key,
 * and every staff action re-checks the actor's permissions here: the plugin's cache only decides what
 * to show in the menu.
 */
import { Router } from "express";
import { z } from "zod";
import { apiError } from "../http";
import { legacyXDb, legacyXError } from "../supabase";
import { loadPrincipalBySteamId, serverRoute, steamIdPattern, writeAudit } from "./context";
import { activeBan, activeMute, issueBan, issueMute, kickPlayer, revokeMute, type Duration } from "./moderation";
import { allowedGameActions, can, isStaff } from "./permissions";
import { checkName, recordName } from "./names";

type DbRow = Record<string, any>;
const db = () => legacyXDb();

const steamId = z.string().regex(steamIdPattern, "SteamID64 is required");
const playerName = z.string().trim().min(1).max(64);
const matchId = z.string().trim().min(1).max(80).nullish();
const reason = z.string().trim().min(1).max(240);

export const permissionCacheSeconds = 45;
export const reportReasons = ["cheating", "griefing", "toxicity", "abuse", "afk", "other"] as const;
export const reportLimit = { perWindow: 3, windowMinutes: 10 };

const durationSchema = z.union([
  z.object({ permanent: z.literal(true) }),
  z.object({ permanent: z.literal(false), minutes: z.number().int().min(1).max(60 * 24 * 365) }),
]);

const gameActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("kick"), actorSteamId: steamId, targetSteamId: steamId, reason, matchId }),
  z.object({ action: z.literal("mute"), actorSteamId: steamId, targetSteamId: steamId, reason, kind: z.enum(["voice", "chat", "all"]).default("all"), duration: durationSchema, matchId }),
  z.object({ action: z.literal("unmute"), actorSteamId: steamId, targetSteamId: steamId, reason: reason.default("Lifted in game"), matchId }),
  z.object({ action: z.literal("ban"), actorSteamId: steamId, targetSteamId: steamId, reason, duration: durationSchema, matchId }),
  z.object({ action: z.literal("map_change"), actorSteamId: steamId, map: z.string().trim().regex(/^[a-z0-9_]{2,48}$/i), matchId }),
  z.object({ action: z.literal("round_restart"), actorSteamId: steamId, matchId }),
]);

function mapEnforcement(row: DbRow | null) {
  return row ? { id: String(row.id), reason: String(row.reason), permanent: row.is_permanent === true, expiresAt: row.expires_at ?? null, kind: row.kind ?? undefined } : null;
}

async function pruneSessionsSometimes() {
  // Without pg_cron the 30-day retention is kept by occasional pruning from connect traffic.
  if (Math.random() < 0.01) await db().rpc("prune_player_sessions");
}

export function createGameRouter() {
  const router = Router();

  router.post("/game/heartbeat", serverRoute(async (req, res, server) => {
    const input = z.object({ map: z.string().trim().max(48).optional(), players: z.number().int().min(0).max(128).optional() }).parse(req.body ?? {});
    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString(), status: "online" };
    if (input.map) patch.map = input.map;
    if (input.players !== undefined) patch.current_players = input.players;
    const { error } = await db().from("game_servers").update(patch).eq("id", server.id);
    legacyXError(error, "Unable to record heartbeat");
    res.json({ ok: true, server: server.id });
  }));

  router.get("/game/permissions/:steamId", serverRoute(async (req, res) => {
    const principal = await loadPrincipalBySteamId(steamId.parse(req.params.steamId));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      steamId: principal.steamId,
      isStaff: isStaff(principal),
      role: principal.roles[0]?.name ?? null,
      immunity: principal.immunity,
      actions: allowedGameActions(principal),
      cacheSeconds: permissionCacheSeconds,
    });
  }));

  router.post("/game/actions", serverRoute(async (req, res, server) => {
    const input = gameActionSchema.parse(req.body);
    const actor = await loadPrincipalBySteamId(input.actorSteamId);
    if (!isStaff(actor)) apiError(403, "Staff access is required");
    const context = { source: "game" as const, serverId: server.id, matchId: input.matchId ?? null };

    switch (input.action) {
      case "kick":
        await kickPlayer(actor, input.targetSteamId, input.reason, context);
        res.json({ ok: true, message: "Player kicked" });
        return;
      case "mute": {
        const mute = await issueMute(actor, input.targetSteamId, input.kind, input.reason, input.duration as Duration, context);
        res.json({ ok: true, message: "Player muted", mute: mapEnforcement(mute) });
        return;
      }
      case "unmute": {
        const active = await activeMute(input.targetSteamId);
        if (!active) apiError(404, "The player is not muted");
        await revokeMute(actor, String(active.id), input.reason, context);
        res.json({ ok: true, message: "Mute lifted" });
        return;
      }
      case "ban": {
        const ban = await issueBan(actor, input.targetSteamId, input.reason, input.duration as Duration, context);
        res.json({ ok: true, message: ban.review_status === "pending" ? "Player banned (sent for review)" : "Player banned", ban: mapEnforcement(ban) });
        return;
      }
      case "map_change":
      case "round_restart": {
        const key = input.action === "map_change" ? "servers.map_change" : "servers.round_restart";
        if (!can(actor, key)) apiError(403, `Missing permission ${key}`);
        await writeAudit(actor, { action: key, targetType: "server", targetId: server.id, serverId: server.id, metadata: { source: "game", map: "map" in input ? input.map : undefined, matchId: input.matchId ?? null } });
        res.json({ ok: true, message: input.action === "map_change" ? "Changing map" : "Restarting round" });
        return;
      }
    }
  }));

  /* Actions queued from the web panel. */
  router.get("/game/queue", serverRoute(async (_req, res, server) => {
    const { data, error } = await db().from("admin_game_actions").select("id,action,target_steam_id,payload,created_at")
      .eq("server_id", server.id).eq("status", "queued").order("created_at").limit(25);
    legacyXError(error, "Unable to load queued actions");
    const rows = (data ?? []) as DbRow[];
    if (rows.length > 0) {
      const { error: markError } = await db().from("admin_game_actions").update({ status: "delivered", delivered_at: new Date().toISOString() })
        .in("id", rows.map(row => row.id)).eq("status", "queued");
      legacyXError(markError, "Unable to mark queued actions");
    }
    res.json({ actions: rows.map(row => ({ id: row.id, action: row.action, targetSteamId: row.target_steam_id, payload: row.payload ?? {} })) });
  }));

  router.post("/game/queue/:actionId", serverRoute(async (req, res, server) => {
    const input = z.object({ ok: z.boolean(), failure: z.string().trim().max(240).optional() }).parse(req.body);
    const { data, error } = await db().from("admin_game_actions")
      .update({ status: input.ok ? "done" : "failed", failure: input.ok ? null : input.failure ?? "Failed", completed_at: new Date().toISOString() })
      .eq("id", z.string().uuid().parse(req.params.actionId)).eq("server_id", server.id).select("id").maybeSingle();
    legacyXError(error, "Unable to complete the action");
    if (!data) apiError(404, "Action was not found");
    res.json({ ok: true });
  }));

  /* Sessions and names. */
  router.post("/game/sessions/connect", serverRoute(async (req, res, server) => {
    const input = z.object({ steamId, name: playerName, matchId }).parse(req.body);
    const now = new Date().toISOString();
    const { data: user } = await db().from("users").select("id").eq("steam_id", input.steamId).maybeSingle();
    const { error: closeError } = await db().from("player_sessions").update({ disconnected_at: now, disconnect_reason: "reconnected" })
      .eq("steam_id", input.steamId).is("disconnected_at", null);
    legacyXError(closeError, "Unable to close previous sessions");
    const { error } = await db().from("player_sessions").insert({
      steam_id: input.steamId, user_id: user?.id ?? null, server_id: server.id, match_id: input.matchId ?? null, player_name: input.name,
    });
    legacyXError(error, "Unable to record the session");
    await recordName(input.steamId, input.name, server.id);
    await pruneSessionsSometimes();
    const [ban, mute, principal, name] = await Promise.all([activeBan(input.steamId), activeMute(input.steamId), loadPrincipalBySteamId(input.steamId), checkName(input.name)]);
    res.json({
      ban: mapEnforcement(ban),
      mute: mapEnforcement(mute),
      name,
      staff: isStaff(principal) ? { role: principal.roles[0]?.name ?? null, immunity: principal.immunity, actions: allowedGameActions(principal), cacheSeconds: permissionCacheSeconds } : null,
    });
  }));

  router.post("/game/sessions/disconnect", serverRoute(async (req, res, server) => {
    const input = z.object({ steamId, reason: z.string().trim().max(120).optional() }).parse(req.body);
    const { error } = await db().from("player_sessions").update({ disconnected_at: new Date().toISOString(), disconnect_reason: input.reason ?? null })
      .eq("steam_id", input.steamId).eq("server_id", server.id).is("disconnected_at", null);
    legacyXError(error, "Unable to close the session");
    res.json({ ok: true });
  }));

  /** Name seen on connect or at round start. */
  router.post("/game/names", serverRoute(async (req, res, server) => {
    const input = z.object({ players: z.array(z.object({ steamId, name: playerName })).min(1).max(64) }).parse(req.body);
    const results = [];
    for (const player of input.players) {
      await recordName(player.steamId, player.name, server.id);
      const verdict = await checkName(player.name);
      if (verdict.action !== "allow") results.push({ steamId: player.steamId, ...verdict });
    }
    // Keep the live session name current for the panel.
    for (const player of input.players) {
      await db().from("player_sessions").update({ player_name: player.name }).eq("steam_id", player.steamId).eq("server_id", server.id).is("disconnected_at", null);
    }
    res.json({ flagged: results });
  }));

  router.post("/game/chat", serverRoute(async (req, res, server) => {
    const input = z.object({
      messages: z.array(z.object({
        steamId, name: playerName, message: z.string().trim().min(1).max(512), teamOnly: z.boolean().default(false), matchId, sentAt: z.string().datetime().optional(),
      })).min(1).max(100),
    }).parse(req.body);
    const { error } = await db().from("chat_logs").insert(input.messages.map(message => ({
      steam_id: message.steamId, player_name: message.name, server_id: server.id, match_id: message.matchId ?? null,
      team_only: message.teamOnly, message: message.message, sent_at: message.sentAt ?? new Date().toISOString(),
    })));
    legacyXError(error, "Unable to store chat");
    res.json({ ok: true, stored: input.messages.length });
  }));

  /* Reports from !report. */
  router.post("/game/reports", serverRoute(async (req, res, server) => {
    const input = z.object({
      reporterSteamId: steamId, targetSteamId: steamId, targetName: playerName.optional(), reason: z.enum(reportReasons),
      details: z.string().trim().max(500).optional(), matchId,
    }).parse(req.body);
    if (input.reporterSteamId === input.targetSteamId) apiError(400, "You cannot report yourself");
    const target = await loadPrincipalBySteamId(input.targetSteamId);
    if (isStaff(target)) apiError(400, "Staff members cannot be reported here");

    const windowStart = new Date(Date.now() - reportLimit.windowMinutes * 60_000).toISOString();
    const { count, error: countError } = await db().from("reports").select("id", { count: "exact", head: true })
      .eq("reporter_steam_id", input.reporterSteamId).gte("created_at", windowStart);
    legacyXError(countError, "Unable to check report limits");
    if ((count ?? 0) >= reportLimit.perWindow) apiError(429, "You can send 3 reports every 10 minutes");

    if (!input.matchId) {
      // Without a match id, "once per match" becomes "once per target per server in the last 2 hours".
      const { count: recent } = await db().from("reports").select("id", { count: "exact", head: true })
        .eq("reporter_steam_id", input.reporterSteamId).eq("target_steam_id", input.targetSteamId).eq("server_id", server.id)
        .gte("created_at", new Date(Date.now() - 2 * 3_600_000).toISOString());
      if ((recent ?? 0) > 0) apiError(409, "You already reported this player in this match");
    }

    const [reporterUser, targetUser] = await Promise.all([
      db().from("users").select("id").eq("steam_id", input.reporterSteamId).maybeSingle(),
      db().from("users").select("id").eq("steam_id", input.targetSteamId).maybeSingle(),
    ]);
    const { data, error } = await db().from("reports").insert({
      reporter_steam_id: input.reporterSteamId, reporter_user_id: reporterUser.data?.id ?? null,
      target_steam_id: input.targetSteamId, target_user_id: targetUser.data?.id ?? null, target_name: input.targetName ?? null,
      server_id: server.id, match_id: input.matchId ?? null, reason: input.reason, details: input.details ?? null,
    }).select("id").single();
    if (error?.code === "23505") apiError(409, "You already reported this player in this match");
    legacyXError(error, "Unable to file the report");
    res.status(201).json({ ok: true, id: data!.id });
  }));

  router.get("/game/announcements", serverRoute(async (_req, res) => {
    const now = new Date().toISOString();
    const { data, error } = await db().from("announcements").select("id,title,body,starts_at,ends_at")
      .eq("channel", "ingame").eq("is_active", true).lte("starts_at", now).or(`ends_at.is.null,ends_at.gt.${now}`).order("starts_at", { ascending: false }).limit(10);
    legacyXError(error, "Unable to load announcements");
    res.json({ announcements: data ?? [] });
  }));

  return router;
}
