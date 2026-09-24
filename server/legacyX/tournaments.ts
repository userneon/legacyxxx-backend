/**
 * Tournaments with player-based registration (supabase/legacy_x_tournaments_player_registration.sql).
 * Players register solo (auto-balanced into teams by EXP when registration closes) or create a team as captain.
 */
import { Router } from "express";
import { z } from "zod";
import { apiError, asyncRoute, hasAccessToken, requireUser, userRoute, type ApiRequest } from "./http";
import { legacyXDb, legacyXError } from "./supabase";
import { STARTING_EXP, rankForExp } from "./rank/ranks";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const one = (value: unknown): Row => (Array.isArray(value) ? ((value[0] ?? {}) as Row) : ((value ?? {}) as Row));

const tournamentColumns = "id,name,description,status,format,prize_pool,starts_at,registration_closes_at,check_in_opens_at,max_players,team_size,winner_team_id,created_at";

export type TournamentPhase = "registration" | "upcoming" | "live" | "finished";

/** Phase shown on the page, from the stored status and the schedule. */
export function tournamentPhase(row: Row, now = Date.now()): TournamentPhase {
  const status = text(row.status);
  if (status === "completed") return "finished";
  if (status === "active") return "live";
  const closes = Date.parse(text(row.registration_closes_at));
  return Number.isFinite(closes) && closes > now ? "registration" : "upcoming";
}

function mapTournament(row: Row, registeredPlayers: number, winner: Row | null) {
  return {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description) || null,
    phase: tournamentPhase(row),
    format: text(row.format),
    prizePool: text(row.prize_pool) || null,
    startsAt: text(row.starts_at) || null,
    registrationClosesAt: text(row.registration_closes_at) || null,
    checkInOpensAt: text(row.check_in_opens_at) || null,
    maxPlayers: numberOrNull(row.max_players),
    teamSize: numberOrNull(row.team_size) ?? 5,
    registeredPlayers,
    winner: winner ? { id: text(winner.id), name: text(winner.name) } : null,
  };
}

const registerSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("solo") }),
  z.object({ mode: z.literal("team"), teamName: z.string().trim().min(2).max(32) }),
]);

export function createTournamentRouter() {
  const router = Router();
  const db = () => legacyXDb();

  const registrationCounts = async (ids: string[]) => {
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;
    const { data, error } = await db().from("tournament_registrations").select("tournament_id").in("tournament_id", ids);
    legacyXError(error, "Unable to count tournament registrations");
    for (const row of (data ?? []) as Row[]) counts.set(text(row.tournament_id), (counts.get(text(row.tournament_id)) ?? 0) + 1);
    return counts;
  };
  const loadTournament = async (id: string) => {
    const { data, error } = await db().from("tournaments").select(tournamentColumns).eq("id", id).maybeSingle();
    legacyXError(error, "Unable to load tournament");
    if (!data) apiError(404, "Tournament was not found");
    return data as Row;
  };

  /** The current tournament (registration, upcoming or live) and the finished ones. */
  router.get("/tournaments", asyncRoute(async (_req, res) => {
    const { data, error } = await db().from("tournaments").select(`${tournamentColumns},winner:tournament_teams!tournaments_winner_team_id_fkey(id,name)`).order("starts_at", { ascending: false, nullsFirst: false }).limit(50);
    legacyXError(error, "Unable to load tournaments");
    const rows = (data ?? []) as Row[];
    const counts = await registrationCounts(rows.map(row => text(row.id)));
    const mapped = rows.map(row => mapTournament(row, counts.get(text(row.id)) ?? 0, row.winner ? one(row.winner) : null));
    const open = mapped.filter(entry => entry.phase !== "finished").sort((a, b) => Date.parse(a.startsAt ?? "") - Date.parse(b.startsAt ?? ""));
    res.json({ current: open[0] ?? null, past: mapped.filter(entry => entry.phase === "finished") });
  }));

  router.get("/tournaments/:tournamentId", asyncRoute(async (req: ApiRequest, res) => {
    const tournamentId = z.string().uuid().parse(req.params.tournamentId);
    const viewer = hasAccessToken(req) ? await requireUser(req) : null;
    const tournament = await loadTournament(tournamentId);
    const [teamsResult, registrationsResult, matchesResult] = await Promise.all([
      db().from("tournament_teams").select("id,name,captain_user_id,auto_balanced,seed").eq("tournament_id", tournamentId).order("seed", { nullsFirst: false }).order("created_at"),
      db().from("tournament_registrations").select("user_id,team_id,mode,checked_in_at,created_at,users(id,steam_id,username,avatar,competitive_player_progression(current_exp))").eq("tournament_id", tournamentId).order("created_at"),
      db().from("tournament_matches").select("id,round,bracket_order,status,map,scheduled_time,team_a_id,team_b_id,score_a,score_b,server_id,game_servers(name,ip_address,port)").eq("tournament_id", tournamentId).order("bracket_order"),
    ]);
    legacyXError(teamsResult.error || registrationsResult.error || matchesResult.error, "Unable to load tournament");
    const registrations = (registrationsResult.data ?? []) as Row[];
    const player = (row: Row) => {
      const user = one(row.users);
      const exp = numberOrNull(one(user.competitive_player_progression).current_exp) ?? STARTING_EXP;
      const rank = rankForExp(exp);
      return { userId: text(user.id), steamId: text(user.steam_id), name: text(user.username), avatar: text(user.avatar), exp, rankId: rank.id, checkedIn: Boolean(row.checked_in_at) };
    };
    const teams = ((teamsResult.data ?? []) as Row[]).map(team => ({
      id: text(team.id),
      name: text(team.name),
      captainUserId: text(team.captain_user_id) || null,
      autoBalanced: team.auto_balanced === true,
      players: registrations.filter(row => text(row.team_id) === text(team.id)).map(player),
    }));
    const teamName = new Map(teams.map(team => [team.id, team.name]));
    const side = (id: unknown) => (text(id) ? { id: text(id), name: teamName.get(text(id)) ?? "TBD" } : null);
    const matches = ((matchesResult.data ?? []) as Row[]).map(match => {
      const server = one(match.game_servers);
      const address = text(server.ip_address) && numberOrNull(server.port) ? `${text(server.ip_address)}:${numberOrNull(server.port)}` : null;
      return {
      id: text(match.id),
      round: text(match.round),
      order: numberOrNull(match.bracket_order) ?? 0,
      status: text(match.status),
      map: text(match.map) || null,
      scheduledAt: text(match.scheduled_time) || null,
      teamA: side(match.team_a_id),
      teamB: side(match.team_b_id),
      scoreA: numberOrNull(match.score_a),
      scoreB: numberOrNull(match.score_b),
      serverId: text(match.server_id) || null,
      serverName: text(server.name) || null,
      connectAddress: address,
    };
    });
    const own = viewer ? registrations.find(row => text(row.user_id) === viewer.id) : undefined;
    res.json({
      tournament: mapTournament(tournament, registrations.length, tournament.winner_team_id ? { id: text(tournament.winner_team_id), name: teamName.get(text(tournament.winner_team_id)) ?? "" } : null),
      teams,
      soloPlayers: registrations.filter(row => text(row.mode) === "solo" && !row.team_id).map(player),
      matches,
      viewer: viewer ? {
        registered: Boolean(own),
        mode: own ? text(own.mode) : null,
        teamId: own ? text(own.team_id) || null : null,
        checkedIn: Boolean(own?.checked_in_at),
      } : null,
    });
  }));

  router.post("/tournaments/:tournamentId/register", userRoute(async (req, res, user) => {
    const tournamentId = z.string().uuid().parse(req.params.tournamentId);
    const input = registerSchema.parse(req.body);
    const tournament = await loadTournament(tournamentId);
    if (tournamentPhase(tournament) !== "registration") apiError(409, "Registration is closed");
    const maxPlayers = numberOrNull(tournament.max_players);
    if (maxPlayers !== null) {
      const { count, error } = await db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("tournament_id", tournamentId);
      legacyXError(error, "Unable to count tournament registrations");
      if ((count ?? 0) >= maxPlayers) apiError(409, "The tournament is full");
    }
    let teamId: string | null = null;
    if (input.mode === "team") {
      const team = await db().from("tournament_teams").insert({ tournament_id: tournamentId, name: input.teamName, captain_user_id: user.id }).select("id").single();
      legacyXError(team.error, "Unable to create the team");
      teamId = text((team.data as Row).id);
    }
    const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournamentId, user_id: user.id, mode: input.mode, team_id: teamId });
    if (error && teamId) await db().from("tournament_teams").delete().eq("id", teamId);
    legacyXError(error, "Unable to register for the tournament");
    res.status(201).json({ registered: true, mode: input.mode, teamId });
  }));

  router.post("/tournaments/:tournamentId/check-in", userRoute(async (req, res, user) => {
    const tournamentId = z.string().uuid().parse(req.params.tournamentId);
    const tournament = await loadTournament(tournamentId);
    const opens = Date.parse(text(tournament.check_in_opens_at));
    const starts = Date.parse(text(tournament.starts_at));
    const now = Date.now();
    if (!Number.isFinite(opens) || now < opens || (Number.isFinite(starts) && now >= starts)) apiError(409, "Check-in is not open");
    const { data, error } = await db().from("tournament_registrations").update({ checked_in_at: new Date(now).toISOString() }).eq("tournament_id", tournamentId).eq("user_id", user.id).is("checked_in_at", null).select("id");
    legacyXError(error, "Unable to check in");
    if ((data ?? []).length === 0) {
      const existing = await db().from("tournament_registrations").select("id").eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
      legacyXError(existing.error, "Unable to check in");
      if (!existing.data) apiError(404, "You are not registered for this tournament");
    }
    res.json({ checkedIn: true });
  }));

  router.post("/tournaments/:tournamentId/teams/:teamId/join", userRoute(async (req, res, user) => {
    const tournamentId = z.string().uuid().parse(req.params.tournamentId);
    const teamId = z.string().uuid().parse(req.params.teamId);
    const tournament = await loadTournament(tournamentId);
    if (tournamentPhase(tournament) !== "registration") apiError(409, "Registration is closed");
    const [team, members] = await Promise.all([
      db().from("tournament_teams").select("id,auto_balanced").eq("id", teamId).eq("tournament_id", tournamentId).maybeSingle(),
      db().from("tournament_registrations").select("id", { count: "exact", head: true }).eq("team_id", teamId),
    ]);
    legacyXError(team.error || members.error, "Unable to load the team");
    if (!team.data || (team.data as Row).auto_balanced === true) apiError(404, "Team was not found");
    if ((members.count ?? 0) >= (numberOrNull(tournament.team_size) ?? 5)) apiError(409, "The team is full");
    const { error } = await db().from("tournament_registrations").insert({ tournament_id: tournamentId, user_id: user.id, mode: "team", team_id: teamId });
    legacyXError(error, "Unable to join the team");
    res.status(201).json({ registered: true, mode: "team", teamId });
  }));

  router.delete("/tournaments/:tournamentId/registration", userRoute(async (req, res, user) => {
    const tournamentId = z.string().uuid().parse(req.params.tournamentId);
    const tournament = await loadTournament(tournamentId);
    if (tournamentPhase(tournament) !== "registration") apiError(409, "Registration is closed");
    const own = await db().from("tournament_registrations").select("id,team_id").eq("tournament_id", tournamentId).eq("user_id", user.id).maybeSingle();
    legacyXError(own.error, "Unable to load your registration");
    if (!own.data) apiError(404, "You are not registered for this tournament");
    const { error } = await db().from("tournament_registrations").delete().eq("id", text((own.data as Row).id));
    legacyXError(error, "Unable to leave the tournament");
    const teamId = text((own.data as Row).team_id);
    if (teamId) {
      // The next member becomes captain; a team nobody is left in is removed.
      const next = await db().from("tournament_registrations").select("user_id").eq("team_id", teamId).order("created_at").limit(1).maybeSingle();
      legacyXError(next.error, "Unable to update the team");
      const update = next.data
        ? await db().from("tournament_teams").update({ captain_user_id: text((next.data as Row).user_id) }).eq("id", teamId).eq("captain_user_id", user.id)
        : await db().from("tournament_teams").delete().eq("id", teamId);
      legacyXError(update.error, "Unable to update the team");
    }
    res.status(204).end();
  }));

  return router;
}
