import { describe, expect, it } from "vitest";

import { ACCEPT_SECONDS, BASE_EXP_WINDOW, MATCH_SIZE, buildMatchZyConfig, expWindow, pickLobby, pickMap, pickServerForMatch, splitTeams, type QueueEntry } from "./matchmaking";
import type { PlayServer } from "./play";

const entry = (n: number, exp: number, joinedAt = 0): QueueEntry => ({ userId: `u${n}`, steamId: `7656119800000${String(1000 + n)}`, username: `Player ${n}`, exp, joinedAt });
const crowd = (count: number, exp = 1000) => Array.from({ length: count }, (_, index) => entry(index, exp + index * 10, index));

describe("pickLobby", () => {
  it("waits for ten players", () => {
    expect(pickLobby(crowd(9), 1000)).toBeNull();
    expect(pickLobby(crowd(10), 1000)).toHaveLength(MATCH_SIZE);
  });
  it("builds the lobby round the longest-waiting player and keeps to the EXP window", () => {
    const queue = [entry(0, 1000, 0), ...Array.from({ length: 12 }, (_, index) => entry(index + 1, 1000 + (index + 1) * 20, 100 + index))];
    const lobby = pickLobby(queue, 5000)!;
    expect(lobby[0].userId).toBe("u0");
    expect(lobby.every((player) => Math.abs(player.exp - 1000) <= expWindow(5))).toBe(true);
  });
  it("does not match players that are too far apart until they have waited", () => {
    const far = [...crowd(5, 1000).map((p, i) => ({ ...p, joinedAt: 0 + i })), ...Array.from({ length: 5 }, (_, index) => entry(50 + index, 3000 + index, 1))];
    expect(pickLobby(far, 1000)).toBeNull();
    expect(pickLobby(far, (3000 / 8 + 5) * 1000)).not.toBeNull();
  });
  it("the window starts at the base and grows with waiting", () => {
    expect(expWindow(0)).toBe(BASE_EXP_WINDOW);
    expect(expWindow(60)).toBeGreaterThan(expWindow(10));
  });
});

describe("splitTeams", () => {
  it("makes two teams of five with near-equal EXP", () => {
    const teams = splitTeams(crowd(10, 500).map((p, i) => ({ ...p, exp: 500 + i * 100 })));
    const sum = (side: 1 | 2) => teams.filter((p) => p.team === side).reduce((total, p) => total + p.exp, 0);
    expect(teams.filter((p) => p.team === 1)).toHaveLength(5);
    expect(teams.filter((p) => p.team === 2)).toHaveLength(5);
    expect(Math.abs(sum(1) - sum(2))).toBeLessThanOrEqual(100);
  });
});

describe("pickMap and pickServerForMatch", () => {
  it("avoids the last map", () => {
    for (let i = 0; i < 50; i += 1) expect(pickMap(Math.random, "de_mirage")).not.toBe("de_mirage");
  });
  const server = (id: string, over: Partial<PlayServer> = {}): PlayServer => ({ id, name: id, map: "de_dust2", mode: "5x5", modeLabel: "5x5", players: 0, maxPlayers: 10, status: "waiting", round: null, score: null, teams: null, connectAddress: "1.2.3.4:27015", gotvAddress: null, joinable: true, ...over });
  it("takes an empty waiting server that is not promised", () => {
    const chosen = pickServerForMatch([server("a", { players: 3 }), server("b"), server("c")], "5x5", new Set(["b"]));
    expect(chosen?.id).toBe("c");
    expect(pickServerForMatch([server("a", { status: "live", players: 10 })], "5x5", new Set())).toBeNull();
    expect(pickServerForMatch([server("a", { mode: "pro" })], "5x5", new Set())).toBeNull();
  });
});

describe("buildMatchZyConfig", () => {
  it("lists both teams by SteamID and one map", () => {
    const lobby = splitTeams(crowd(10));
    const config = buildMatchZyConfig("m1", "de_inferno", lobby);
    expect(Object.keys(config.team1.players)).toHaveLength(5);
    expect(Object.keys(config.team2.players)).toHaveLength(5);
    expect(config.maplist).toEqual(["de_inferno"]);
    expect(config.players_per_team).toBe(5);
  });
  it("strips quotes from names", () => {
    const config = buildMatchZyConfig("m", "de_dust2", splitTeams(crowd(10)).map((p, i) => (i === 0 ? { ...p, username: 'Bad"Name\\' } : p)));
    expect(JSON.stringify(config)).not.toContain('Bad"');
  });
  it("accept window is thirty seconds", () => expect(ACCEPT_SECONDS).toBe(30));
});
