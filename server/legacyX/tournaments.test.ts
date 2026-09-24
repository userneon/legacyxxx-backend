import { describe, expect, it } from "vitest";
import { bracketRounds, checkInOpen, groupTeams, mapTournamentMatch, mapTournamentSummary, nextMatchFor, tournamentPhase } from "./tournaments";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

describe("tournamentPhase", () => {
  it("keeps registration open until the deadline", () => {
    expect(tournamentPhase({ status: "upcoming", registration_closes_at: at(2), starts_at: at(3) }, NOW)).toBe("registration");
    expect(tournamentPhase({ status: "upcoming", registration_closes_at: at(-1), starts_at: at(3) }, NOW)).toBe("upcoming");
  });
  it("falls back to the start time, and to open registration without any date", () => {
    expect(tournamentPhase({ status: "upcoming", starts_at: at(-1) }, NOW)).toBe("upcoming");
    expect(tournamentPhase({ status: "upcoming" }, NOW)).toBe("registration");
  });
  it("maps active and completed", () => {
    expect(tournamentPhase({ status: "active" }, NOW)).toBe("live");
    expect(tournamentPhase({ status: "completed" }, NOW)).toBe("finished");
  });
});

describe("checkInOpen", () => {
  it("is open between check_in_opens_at and the start", () => {
    const t = { status: "upcoming", check_in_opens_at: at(-0.25), starts_at: at(0.25) };
    expect(checkInOpen(t, NOW)).toBe(true);
    expect(checkInOpen({ ...t, check_in_opens_at: at(0.1) }, NOW)).toBe(false);
    expect(checkInOpen({ ...t, starts_at: at(-0.1) }, NOW)).toBe(false);
    expect(checkInOpen({ ...t, status: "active" }, NOW)).toBe(false);
    expect(checkInOpen({ status: "upcoming", starts_at: at(1) }, NOW)).toBe(false);
  });
});

describe("groupTeams", () => {
  it("puts members under their team (captain first) and keeps unassigned solos apart", () => {
    const { teams, soloPlayers } = groupTeams(
      [{ id: "t1", name: "Alpha", captain_user_id: "u2", seed: 2 }, { id: "t2", name: "Bravo", captain_user_id: "u3", seed: 1 }],
      [
        { user_id: "u1", team_id: "t1", mode: "team", users: { username: "one", steam_id: "7656", avatar: "" } },
        { user_id: "u2", team_id: "t1", mode: "team", checked_in_at: at(-1), users: [{ username: "two" }] },
        { user_id: "u3", team_id: "t2", mode: "solo", users: { username: "three" } },
        { user_id: "u4", team_id: null, mode: "solo", users: { username: "four" } },
      ],
    );
    expect(teams.map((team) => team.name)).toEqual(["Bravo", "Alpha"]);
    expect(teams[1]!.players.map((player) => player.userId)).toEqual(["u2", "u1"]);
    expect(teams[1]!.players[0]!.checkedIn).toBe(true);
    expect(soloPlayers.map((player) => player.name)).toEqual(["four"]);
  });
});

describe("matches", () => {
  const names = new Map([["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"]]);
  const rows = [
    { id: "m3", round: "Final", bracket_order: 3, team_a_id: null, team_b_id: null, status: "upcoming", scheduled_time: at(5) },
    { id: "m1", round: "Semifinals", bracket_order: 1, team_a_id: "a", team_b_id: "b", score_a: 13, score_b: 9, status: "completed", scheduled_time: at(-2) },
    { id: "m2", round: "Semifinals", bracket_order: 2, team_a_id: "c", team_b_id: "a", score_a: 4, score_b: 3, status: "live", scheduled_time: at(-0.5), reconnect_servers: { server_id: "s1", display_name: "LX #1", connect_address: "1.2.3.4:27015" }, maps: { label: "Mirage" } },
  ];
  const matches = rows.map((row) => mapTournamentMatch(row, names));

  it("maps team refs, winner, server and map", () => {
    expect(matches[1]).toMatchObject({ teamA: { id: "a", name: "Alpha" }, winnerTeamId: "a", status: "completed" });
    expect(matches[2]).toMatchObject({ server: { connectAddress: "1.2.3.4:27015" }, map: "Mirage", winnerTeamId: null });
    expect(matches[0]).toMatchObject({ teamA: null, teamB: null });
  });
  it("orders bracket columns by bracket_order", () => {
    expect(bracketRounds(matches).map((round) => [round.round, round.matches.map((match) => match.id)])).toEqual([["Semifinals", ["m1", "m2"]], ["Final", ["m3"]]]);
  });
  it("finds the live match first and names the opponent", () => {
    expect(nextMatchFor("a", matches)).toMatchObject({ id: "m2", opponent: { id: "c", name: "Charlie" } });
    expect(nextMatchFor("b", matches)).toBeNull();
    expect(nextMatchFor(null, matches)).toBeNull();
  });
});

describe("mapTournamentSummary", () => {
  it("hides the placeholder prize and falls back to the season name", () => {
    const summary = mapTournamentSummary({ id: "t", season: "Season 1", prize_pool: "—", status: "upcoming", team_size: 5 }, 12, NOW);
    expect(summary).toMatchObject({ name: "Season 1", prizePool: null, phase: "registration", registeredPlayers: 12, teamSize: 5 });
  });
});
