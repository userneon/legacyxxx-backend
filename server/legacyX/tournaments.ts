/**
 * Player-based tournaments: pure mapping from legacy_x.tournaments / tournament_teams /
 * tournament_registrations / tournament_matches rows to the website's tournament contract.
 * Database access lives in routes.ts; everything here is deterministic and unit-tested.
 */

type Row = Record<string, any>;

/** registration → upcoming → live → finished, derived from status + the registration deadline. */
export type TournamentPhase = "registration" | "upcoming" | "live" | "finished";

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const time = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);

export function tournamentPhase(tournament: Row, now = Date.now()): TournamentPhase {
  const status = text(tournament.status);
  if (status === "completed") return "finished";
  if (status === "active") return "live";
  const closes = Date.parse(text(tournament.registration_closes_at) || text(tournament.starts_at));
  // Without any deadline an upcoming tournament keeps registration open.
  return !Number.isFinite(closes) || now < closes ? "registration" : "upcoming";
}

/** Check-in runs from check_in_opens_at until the start, for registered players only. */
export function checkInOpen(tournament: Row, now = Date.now()) {
  const opens = Date.parse(text(tournament.check_in_opens_at));
  const starts = Date.parse(text(tournament.starts_at));
  if (!Number.isFinite(opens)) return false;
  return now >= opens && (!Number.isFinite(starts) || now < starts) && text(tournament.status) === "upcoming";
}

export type TournamentPlayer = { userId: string; steamId: string | null; name: string; avatar: string; checkedIn: boolean; mode: "solo" | "team" };
export type TournamentTeam = { id: string; name: string; captainUserId: string | null; seed: number | null; autoBalanced: boolean; players: TournamentPlayer[] };
export type TournamentTeamRef = { id: string; name: string } | null;
export type TournamentMatch = {
  id: string;
  round: string;
  bracketOrder: number;
  teamA: TournamentTeamRef;
  teamB: TournamentTeamRef;
  scoreA: number | null;
  scoreB: number | null;
  winnerTeamId: string | null;
  status: "live" | "upcoming" | "completed";
  scheduledTime: string | null;
  map: string | null;
  server: { id: string; name: string; connectAddress: string | null } | null;
};

export function mapRegistrationPlayer(registration: Row): TournamentPlayer {
  const user = (Array.isArray(registration.users) ? registration.users[0] : registration.users) ?? {};
  return {
    userId: text(registration.user_id),
    steamId: text(user.steam_id) || null,
    name: text(user.username) || "Player",
    avatar: text(user.avatar),
    checkedIn: Boolean(registration.checked_in_at),
    mode: registration.mode === "team" ? "team" : "solo",
  };
}

/** Teams with their members, plus the solo players who are not in a team yet. */
export function groupTeams(teams: Row[], registrations: Row[]) {
  const byTeam = new Map<string, TournamentPlayer[]>();
  const solo: TournamentPlayer[] = [];
  for (const registration of registrations) {
    const player = mapRegistrationPlayer(registration);
    const teamId = text(registration.team_id);
    if (!teamId) solo.push(player);
    else byTeam.set(teamId, [...(byTeam.get(teamId) ?? []), player]);
  }
  const mapped: TournamentTeam[] = teams
    .map((team) => ({
      id: text(team.id),
      name: text(team.name),
      captainUserId: text(team.captain_user_id) || null,
      seed: int(team.seed),
      autoBalanced: Boolean(team.auto_balanced),
      players: (byTeam.get(text(team.id)) ?? []).sort((a, b) => Number(b.userId === text(team.captain_user_id)) - Number(a.userId === text(team.captain_user_id))),
    }))
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || a.name.localeCompare(b.name));
  return { teams: mapped, soloPlayers: solo };
}


export function mapTournamentMatch(match: Row, teamNames: Map<string, string>): TournamentMatch {
  const ref = (id: unknown): TournamentTeamRef => {
    const key = text(id);
    return key ? { id: key, name: teamNames.get(key) ?? "TBD" } : null;
  };
  const scoreA = int(match.score_a);
  const scoreB = int(match.score_b);
  const status = match.status === "live" || match.status === "completed" ? match.status : "upcoming";
  const winnerTeamId = status === "completed" && scoreA !== null && scoreB !== null && scoreA !== scoreB
    ? text(scoreA > scoreB ? match.team_a_id : match.team_b_id) || null
    : null;
  const server = (Array.isArray(match.reconnect_servers) ? match.reconnect_servers[0] : match.reconnect_servers) as Row | null | undefined;
  const map = (Array.isArray(match.maps) ? match.maps[0] : match.maps) as Row | null | undefined;
  return {
    id: text(match.id),
    round: text(match.round),
    bracketOrder: int(match.bracket_order) ?? 0,
    teamA: ref(match.team_a_id),
    teamB: ref(match.team_b_id),
    scoreA,
    scoreB,
    winnerTeamId,
    status,
    scheduledTime: time(match.scheduled_time),
    map: text(map?.label) || text(match.map) || null,
    server: server && server.server_id ? { id: text(server.server_id), name: text(server.display_name) || text(server.server_id), connectAddress: text(server.connect_address) || null } : null,
  };
}

/** Bracket columns in bracket_order of their first match (Quarterfinals → Semifinals → Final). */
export function bracketRounds(matches: TournamentMatch[]) {
  const rounds = new Map<string, TournamentMatch[]>();
  for (const match of [...matches].sort((a, b) => a.bracketOrder - b.bracketOrder)) rounds.set(match.round, [...(rounds.get(match.round) ?? []), match]);
  return Array.from(rounds.entries()).map(([round, list]) => ({ round, matches: list }));
}

/** The viewer's next unfinished match (live first, then the earliest scheduled one). */
export function nextMatchFor(teamId: string | null, matches: TournamentMatch[]) {
  if (!teamId) return null;
  const mine = matches.filter((match) => match.status !== "completed" && (match.teamA?.id === teamId || match.teamB?.id === teamId));
  mine.sort((a, b) => Number(b.status === "live") - Number(a.status === "live") || (Date.parse(a.scheduledTime ?? "") || Infinity) - (Date.parse(b.scheduledTime ?? "") || Infinity) || a.bracketOrder - b.bracketOrder);
  const next = mine[0];
  if (!next) return null;
  return { ...next, opponent: next.teamA?.id === teamId ? next.teamB : next.teamA };
}

export function mapTournamentSummary(tournament: Row, registeredPlayers: number, now = Date.now()) {
  return {
    id: text(tournament.id),
    name: text(tournament.name) || text(tournament.season) || "Tournament",
    description: text(tournament.description) || null,
    phase: tournamentPhase(tournament, now),
    format: text(tournament.format) || null,
    prizePool: text(tournament.prize_pool) && text(tournament.prize_pool) !== "—" ? text(tournament.prize_pool) : null,
    startsAt: time(tournament.starts_at),
    registrationClosesAt: time(tournament.registration_closes_at),
    checkInOpensAt: time(tournament.check_in_opens_at),
    nextMatchTime: time(tournament.next_match_time),
    maxPlayers: int(tournament.max_players),
    teamSize: int(tournament.team_size) ?? 5,
    registeredPlayers,
  };
}
