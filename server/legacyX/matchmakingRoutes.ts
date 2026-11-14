/**
 * The matchmaking queue's routes and its ticker (see matchmaking.ts for the rules). The tables are in supabase/legacy_x_matchmaking.sql.
 *
 *   POST /queue/join {mode}   enter the queue (banned players and players blocked for leaving matches are refused; Pro League needs the rank)
 *   POST /queue/leave         leave the queue, or decline a found match
 *   POST /queue/accept        press Accept on a found match
 *   GET  /queue/status        idle | queued | found | ready, with the numbers the Play page shows
 *
 * A ticker (every 3 s) builds lobbies, cancels matches nobody accepted, hands accepted matches to a free game server as a `match_load` server action
 * (the plugin writes the MatchZy file and loads it) and closes matches that are over. Real rows only: nothing here is invented.
 */
import { randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";

import { activeBannedUserIds } from "./bans";
import { ACCEPT_SECONDS, MATCH_SIZE, buildMatchZyConfig, pickLobby, pickMap, pickServerForMatch, splitTeams, type LobbyPlayer, type QueueEntry, type QueueMode } from "./matchmaking";
import { leaveRulesFrom, leaveStatus, loadLeaves } from "./playAccess";
import type { PlayServer } from "./play";
import { loadSettings } from "./settings";
import { legacyXError } from "./supabase";

type Row = Record<string, any>;

interface Deps {
  router: Router;
  db: () => any;
  userRoute: (handler: (req: any, res: any, user: { id: string; steamId: string; username: string }) => Promise<void>) => any;
  apiError: (status: number, message: string) => never;
  loadPlayServers: () => Promise<Array<PlayServer>>;
  wakeServer: (serverId: string) => void;
}

const MODES: QueueMode[] = ["5x5", "pro"];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const SERVER_WAIT_MS = 120_000;
const LOAD_TIMEOUT_MS = 5 * 60_000;
const MATCH_MAX_MS = 3 * 60 * 60_000;

export function registerMatchmakingRoutes(deps: Deps) {
  const { router, db, userRoute, apiError, loadPlayServers, wakeServer } = deps;
  let ticking = false;

  /** Players in each queue right now. */
  const queueCounts = async () => {
    const { data, error } = await db().from("queue_entries").select("mode");
    legacyXError(error, "Unable to read the queue");
    const counts: Record<string, number> = { "5x5": 0, pro: 0 };
    for (const row of (data ?? []) as Row[]) counts[text(row.mode)] = (counts[text(row.mode)] ?? 0) + 1;
    return counts;
  };

  const cancelMatch = async (matchId: string, requeueAccepted: boolean) => {
    const { data: players } = await db().from("queue_match_players").select("user_id,exp,joined_at,accepted").eq("match_id", matchId);
    const { data: match } = await db().from("queue_matches").select("mode").eq("id", matchId).maybeSingle();
    await db().from("queue_matches").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", matchId);
    if (requeueAccepted && match) {
      const back = ((players ?? []) as Row[]).filter((player) => player.accepted).map((player) => ({ user_id: player.user_id, mode: match.mode, exp: player.exp, joined_at: player.joined_at }));
      if (back.length > 0) await db().from("queue_entries").upsert(back, { onConflict: "user_id" });
    }
  };

  const tickMode = async (mode: QueueMode, servers: PlayServer[], now: number) => {
    // 1. Matches nobody (or not everybody) accepted in time; or all accepted but no server came in time.
    const { data: open } = await db().from("queue_matches").select("id,status,accept_deadline,created_at").eq("mode", mode).in("status", ["accepting", "loading", "live"]);
    const busy = new Set<string>();
    for (const match of (open ?? []) as Row[]) {
      const id = text(match.id);
      const age = now - Date.parse(text(match.created_at));
      if (match.status === "accepting") {
        const { data: players } = await db().from("queue_match_players").select("accepted").eq("match_id", id);
        const accepted = ((players ?? []) as Row[]).filter((player) => player.accepted).length;
        const deadline = Date.parse(text(match.accept_deadline));
        if (accepted < MATCH_SIZE && now >= deadline) await cancelMatch(id, true);
        else if (accepted >= MATCH_SIZE && now >= deadline + SERVER_WAIT_MS) await cancelMatch(id, true);
        else if (accepted >= MATCH_SIZE) await assignServer(id, mode, servers, busy);
      } else {
        const { data: row } = await db().from("queue_matches").select("server_id,started_at").eq("id", id).maybeSingle();
        const serverId = text(row?.server_id);
        const server = servers.find((candidate) => candidate.id === serverId);
        if (serverId) busy.add(serverId);
        if (age > MATCH_MAX_MS) await db().from("queue_matches").update({ status: "finished", finished_at: new Date(now).toISOString() }).eq("id", id);
        else if (match.status === "loading" && server?.status === "live") await db().from("queue_matches").update({ status: "live", started_at: new Date(now).toISOString() }).eq("id", id);
        else if (match.status === "loading" && age > LOAD_TIMEOUT_MS && server?.status !== "live") await cancelMatch(id, false);
        else if (match.status === "live" && server && server.players === 0 && age > 3 * 60_000) await db().from("queue_matches").update({ status: "finished", finished_at: new Date(now).toISOString() }).eq("id", id);
      }
    }
    // 2. A lobby from the queue.
    for (;;) {
      const { data: rows } = await db().from("queue_entries").select("user_id,exp,joined_at").eq("mode", mode);
      const entries = (rows ?? []) as Row[];
      if (entries.length < MATCH_SIZE) return;
      const { data: users } = await db().from("users").select("id,steam_id,username").in("id", entries.map((entry) => entry.user_id));
      const byId = new Map(((users ?? []) as Row[]).map((user) => [text(user.id), user]));
      const queue: QueueEntry[] = entries.flatMap((entry) => {
        const user = byId.get(text(entry.user_id));
        return user ? [{ userId: text(entry.user_id), steamId: text(user.steam_id), username: text(user.username) || "Player", exp: Number(entry.exp) || 0, joinedAt: Date.parse(text(entry.joined_at)) }] : [];
      });
      const lobby = pickLobby(queue, now);
      if (!lobby) return;
      const teams = splitTeams(lobby);
      const matchId = randomUUID();
      const map = pickMap();
      const { error } = await db().from("queue_matches").insert({ id: matchId, mode, map, status: "accepting", accept_deadline: new Date(now + ACCEPT_SECONDS * 1000).toISOString() });
      legacyXError(error, "Unable to create a match");
      await db().from("queue_match_players").insert(teams.map((player) => ({ match_id: matchId, user_id: player.userId, steam_id: player.steamId, username: player.username, team: player.team, exp: player.exp, joined_at: new Date(player.joinedAt).toISOString(), accepted: false })));
      await db().from("queue_entries").delete().in("user_id", teams.map((player) => player.userId));
    }
  };

  /** All ten accepted: give the match an empty server and send it the match file. */
  const assignServer = async (matchId: string, mode: QueueMode, servers: PlayServer[], busy: Set<string>) => {
    const { data: held } = await db().from("queue_matches").select("server_id").in("status", ["loading", "live"]);
    for (const row of (held ?? []) as Row[]) if (row.server_id) busy.add(text(row.server_id));
    const server = pickServerForMatch(servers, mode, busy);
    if (!server) return;
    const { data: match } = await db().from("queue_matches").select("map").eq("id", matchId).maybeSingle();
    const { data: rows } = await db().from("queue_match_players").select("user_id,steam_id,username,team,exp,joined_at").eq("match_id", matchId);
    const players: LobbyPlayer[] = ((rows ?? []) as Row[]).map((row) => ({ userId: text(row.user_id), steamId: text(row.steam_id), username: text(row.username), exp: Number(row.exp) || 0, joinedAt: Date.parse(text(row.joined_at)), team: row.team === 2 ? 2 : 1 }));
    const map = text(match?.map) || pickMap();
    const config = buildMatchZyConfig(matchId, map, players);
    // Claim the match first so a second tick cannot give it a second server.
    const { data: claimed } = await db().from("queue_matches").update({ status: "loading", server_id: server.id, connect_address: server.connectAddress }).eq("id", matchId).eq("status", "accepting").select("id");
    if (!claimed || claimed.length === 0) return;
    busy.add(server.id);
    const { error } = await db().from("staff_panel_actions").insert({ server_id: server.id, requested_by: players[0].userId, action_type: "match_load", payload: { type: "match_load", serverId: server.id, matchId, map, config }, status: "pending" });
    if (error) { await db().from("queue_matches").update({ status: "accepting", server_id: null, connect_address: null }).eq("id", matchId); throw error; }
    wakeServer(server.id);
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const servers = await loadPlayServers();
      const now = Date.now();
      for (const mode of MODES) await tickMode(mode, servers, now);
    } catch (error) {
      console.error("[legacy-x-api] Matchmaking tick failed", error);
    } finally {
      ticking = false;
    }
  };
  setInterval(() => { void tick(); }, 3000).unref();

  const modeSchema = z.object({ mode: z.enum(["5x5", "pro"]) });

  router.post("/queue/join", userRoute(async (req, res, user) => {
    const { mode } = modeSchema.parse(req.body);
    const now = new Date();
    if ((await activeBannedUserIds(db(), [user.id])).has(user.id)) apiError(403, "You are banned and cannot queue.");
    const rules = leaveRulesFrom(await loadSettings(db()));
    const status = leaveStatus((await loadLeaves(db(), [user.id], now, rules.windowMs)).get(user.id) ?? [], now, rules);
    if (status.cooldown) apiError(403, `You left a match too often. You can queue again in ${Math.ceil((Date.parse(status.cooldown.until) - now.getTime()) / 60_000)} minutes.`);
    const { data: open } = await db().from("queue_match_players").select("match_id,queue_matches!inner(status)").eq("user_id", user.id).in("queue_matches.status", ["accepting", "loading", "live"]).limit(1);
    if ((open ?? []).length > 0) apiError(409, "You already have a match.");
    const { data: profile } = await db().from("competitive_player_profiles").select("current_exp,pro_league_unlocked").eq("user_id", user.id).maybeSingle();
    if (mode === "pro" && !profile?.pro_league_unlocked) apiError(403, "Pro League needs a higher rank.");
    const { error } = await db().from("queue_entries").upsert({ user_id: user.id, mode, exp: Number(profile?.current_exp) || 0, joined_at: now.toISOString() }, { onConflict: "user_id" });
    legacyXError(error, "Unable to join the queue");
    void tick();
    res.status(201).json({ ok: true });
  }));

  router.post("/queue/leave", userRoute(async (_req, res, user) => {
    await db().from("queue_entries").delete().eq("user_id", user.id);
    // Declining a found match cancels it; the others who accepted go back in the queue.
    const { data } = await db().from("queue_match_players").select("match_id,queue_matches!inner(status)").eq("user_id", user.id).eq("queue_matches.status", "accepting");
    for (const row of (data ?? []) as Row[]) {
      await db().from("queue_match_players").delete().eq("match_id", row.match_id).eq("user_id", user.id);
      await cancelMatch(text(row.match_id), true);
    }
    res.json({ ok: true });
  }));

  router.post("/queue/accept", userRoute(async (req, res, user) => {
    const { matchId } = z.object({ matchId: z.string().uuid() }).parse(req.body);
    const { data: match } = await db().from("queue_matches").select("id,status,accept_deadline").eq("id", matchId).maybeSingle();
    if (!match || match.status !== "accepting" || Date.parse(text(match.accept_deadline)) < Date.now()) apiError(409, "This match is no longer waiting for you.");
    const { data, error } = await db().from("queue_match_players").update({ accepted: true }).eq("match_id", matchId).eq("user_id", user.id).select("user_id");
    legacyXError(error, "Unable to accept");
    if (!data || data.length === 0) apiError(404, "You are not in this match.");
    void tick();
    res.json({ ok: true });
  }));

  router.get("/queue/status", userRoute(async (_req, res, user) => {
    res.set("Cache-Control", "no-store");
    const counts = await queueCounts();
    const { data: mine } = await db().from("queue_match_players").select("match_id,team,accepted,queue_matches!inner(id,mode,map,status,accept_deadline,server_id,connect_address)").eq("user_id", user.id).in("queue_matches.status", ["accepting", "loading", "live"]).order("joined_at", { ascending: false }).limit(1);
    const row = ((mine ?? []) as Row[])[0];
    if (row) {
      const match = row.queue_matches as Row;
      const { data: players } = await db().from("queue_match_players").select("user_id,username,team,accepted,exp").eq("match_id", match.id);
      const list = (players ?? []) as Row[];
      const base = { id: text(match.id), mode: text(match.mode), map: text(match.map), acceptDeadline: text(match.accept_deadline), accepted: list.filter((player) => player.accepted).length, total: list.length, myAccepted: Boolean(row.accepted) };
      if (match.status === "accepting") {
        res.json({ state: base.accepted >= base.total ? "preparing" : "found", counts, match: base });
        return;
      }
      res.json({ state: "ready", counts, match: { ...base, status: text(match.status), team: row.team === 2 ? 2 : 1, connectAddress: text(match.connect_address) || null, players: list.map((player) => ({ userId: text(player.user_id), username: text(player.username), team: player.team === 2 ? 2 : 1, exp: Number(player.exp) || 0 })) } });
      return;
    }
    const { data: entry } = await db().from("queue_entries").select("mode,joined_at").eq("user_id", user.id).maybeSingle();
    if (entry) {
      res.json({ state: "queued", counts, queue: { mode: text(entry.mode), joinedAt: text(entry.joined_at) } });
      return;
    }
    res.json({ state: "idle", counts });
  }));
}
