import { describe, expect, it } from "vitest";
import { mapPlayServer, pickQuickJoin, playModeFromServerMode, sortPlayServers, type PlayServer } from "./play";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const server = (id: string, extra: Record<string, unknown> = {}) => ({ server_id: id, display_name: `LX ${id}`, connect_address: `1.2.3.4:270${id}`, current_map: "de_mirage", current_mode: "competitive_5v5", player_count: 0, last_heartbeat_at: ago(10), ...extra });

describe("playModeFromServerMode", () => {
  it("maps the LEGACYX_SERVER_MODE values", () => {
    expect(playModeFromServerMode("competitive_5v5")).toBe("5x5");
    expect(playModeFromServerMode("5vs5")).toBe("5x5");
    expect(playModeFromServerMode("fun")).toBe("fun");
    expect(playModeFromServerMode("fun_retake")).toBe("fun");
    expect(playModeFromServerMode("proleague")).toBe("pro");
    expect(playModeFromServerMode("surf-community")).toBeNull();
    expect(playModeFromServerMode(null)).toBeNull();
  });
});

describe("mapPlayServer", () => {
  it("derives waiting / warmup / live / full / offline", () => {
    expect(mapPlayServer(server("1"), null, NOW)?.status).toBe("waiting");
    expect(mapPlayServer(server("1", { player_count: 4 }), null, NOW)?.status).toBe("warmup");
    expect(mapPlayServer(server("1", { player_count: 10 }), null, NOW)).toMatchObject({ status: "full", joinable: false });
    expect(mapPlayServer(server("1", { last_heartbeat_at: ago(200) }), null, NOW)).toMatchObject({ status: "offline", joinable: false });
    const live = mapPlayServer(server("1", { player_count: 9 }), { state: "live", score_t: 9, score_ct: 6, round_number: 16, map_name: "de_nuke", reported_at: ago(5) }, NOW);
    expect(live).toMatchObject({ status: "live", score: { t: 9, ct: 6 }, round: 16, map: "de_nuke", joinable: true });
  });
  it("ignores a stale snapshot and unknown modes", () => {
    const stale = mapPlayServer(server("1", { player_count: 3 }), { state: "live", score_t: 1, score_ct: 1, reported_at: ago(500) }, NOW);
    expect(stale).toMatchObject({ status: "warmup", score: null });
    expect(mapPlayServer(server("1", { current_mode: "surf" }), null, NOW)).toBeNull();
  });
  it("uses the reported max players", () => {
    expect(mapPlayServer(server("1", { current_mode: "fun", player_count: 12, max_players: 16 }), null, NOW)).toMatchObject({ maxPlayers: 16, status: "warmup", joinable: true });
  });
});

describe("quick join", () => {
  const list = [
    mapPlayServer(server("1", { player_count: 3 }), null, NOW),
    mapPlayServer(server("2", { player_count: 7, current_map: "de_inferno" }), null, NOW),
    mapPlayServer(server("3", { player_count: 8 }), { state: "live", score_t: 1, score_ct: 0, reported_at: ago(1) }, NOW),
    mapPlayServer(server("4", { player_count: 7, current_map: "de_nuke" }), null, NOW),
    mapPlayServer(server("5", { player_count: 10 }), null, NOW),
  ].filter((entry): entry is PlayServer => Boolean(entry));

  it("5x5 prefers the fullest server that has not started, then favourite maps", () => {
    expect(pickQuickJoin(list, "5x5")?.id).toBe("2");
    expect(pickQuickJoin(list, "5x5", ["de_nuke"])?.id).toBe("4");
  });
  it("fun takes the busiest server with a free slot, live or not", () => {
    const fun = list.map((entry) => ({ ...entry, mode: "fun" as const }));
    expect(pickQuickJoin(fun, "fun")?.id).toBe("3");
  });
  it("returns null when nothing is joinable", () => {
    expect(pickQuickJoin(list, "pro")).toBeNull();
  });
  it("sorts joinable first, then by players", () => {
    expect(sortPlayServers(list).map((entry) => entry.id)).toEqual(["3", "2", "4", "1", "5"]);
  });
});
