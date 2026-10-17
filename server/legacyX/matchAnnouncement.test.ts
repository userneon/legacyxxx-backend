import { describe, expect, it } from "vitest";
import { matchResultAnnouncement, resultSteamIds } from "./matchAnnouncement";
import { announcementSchema } from "./announcements";

const player = (n: number, team: "team1" | "team2", kills: number, deaths = 5, extra: Record<string, unknown> = {}) => ({
  steam_id: `7656119800000000${n}`.slice(0, 17),
  team,
  rounds_played: 24,
  kills,
  deaths,
  assists: 2,
  ...extra,
});

describe("match result announcement", () => {
  const result = {
    competitive_result: {
      schema_version: 2,
      mode: "pro_league",
      team1: { rounds_won: 13 },
      team2: { rounds_won: 9 },
      players: [player(1, "team1", 25), player(2, "team1", 10), player(3, "team2", 18), player(4, "team2", 3, 9, { is_bot: true }), player(5, "team2", 7, 8, { rounds_played: 0 })],
    },
  };

  it("says who won, the score and each team's best players with their site names", () => {
    const names = new Map([[player(1, "team1", 0).steam_id, "Bat"]]);
    const a = matchResultAnnouncement(result, names)!;
    expect(a.title).toBe("Pro League · Team 1 13–9 Team 2");
    expect(a.banner).toBe("match-result");
    expect(a.lines[0]).toBe("Team 1 won, 13–9");
    expect(a.lines[1]).toBe(`Team 1: Bat 25/5/2 · ${player(2, "team1", 0).steam_id} 10/5/2`);
    expect(a.lines[2]).toBe(`Team 2: ${player(3, "team2", 0).steam_id} 18/5/2`);   // bots and players with no rounds are left out
    expect(announcementSchema.safeParse(a).success).toBe(true);
  });

  it("reads the older payload and a draw", () => {
    const a = matchResultAnnouncement({ team1_rounds: 12, team2_rounds: 12, mode: "5v5" }, new Map())!;
    expect(a.title).toBe("5v5 · Team 1 12–12 Team 2");
    expect(a.lines).toEqual(["Draw, 12–12"]);
  });

  it("makes nothing up when the result has no score", () => {
    expect(matchResultAnnouncement({}, new Map())).toBeNull();
    expect(matchResultAnnouncement({ team1_rounds: 5 }, new Map())).toBeNull();
    expect(matchResultAnnouncement(null, new Map())).toBeNull();
  });

  it("lists the Steam IDs the result names", () => {
    expect(resultSteamIds(result)).toHaveLength(5);
    expect(resultSteamIds({})).toEqual([]);
  });
});
