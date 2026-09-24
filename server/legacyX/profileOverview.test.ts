import { describe, expect, it } from "vitest";
import { hiddenForViewer, loadoutShowcase, mapWinRates, normalizeHiddenSections, profileStats, staffCard } from "./profileOverview";

describe("profile visibility", () => {
  it("normalizes new and legacy section names", () => {
    expect(normalizeHiddenSections(["faceit", "kd", "recent_matches", "bogus", 3])).toEqual(["stats", "matches", "faceit"]);
    expect(normalizeHiddenSections(null)).toEqual([]);
  });
  it("owner and staff always see everything", () => {
    expect(hiddenForViewer(["stats"], { isOwner: true, isStaff: false })).toEqual([]);
    expect(hiddenForViewer(["stats"], { isOwner: false, isStaff: true })).toEqual([]);
    expect(hiddenForViewer(["stats"], { isOwner: false, isStaff: false })).toEqual(["stats"]);
  });
});

describe("profileStats", () => {
  it("builds tiles from progression and drops the ones without data", () => {
    expect(profileStats({ matches_completed: 20, wins: 11, kills: 300, deaths: 250, headshot_kills: 150 })?.map((tile) => [tile.key, tile.value])).toEqual([
      ["matches", 20], ["winRate", 55], ["kd", 1.2], ["hs", 50], ["avgKills", 15],
    ]);
    expect(profileStats({ matches_completed: 4, wins: 1, kills: null, deaths: 0 })?.map((tile) => tile.key)).toEqual(["matches", "winRate"]);
    expect(profileStats({ matches_completed: 0 })).toBeNull();
    expect(profileStats(null)).toBeNull();
  });
});

describe("mapWinRates", () => {
  it("needs 3 matches per map and sorts by win rate", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ outcome: i < 2 ? "win" : "loss", core_matches: { map_name: "de_mirage" } })),
      ...Array.from({ length: 4 }, (_, i) => ({ outcome: i < 3 ? "win" : "loss", core_matches: [{ map_name: "de_nuke" }] })),
      { outcome: "win", core_matches: { map_name: "de_inferno" } },
    ];
    expect(mapWinRates(rows)).toEqual([
      { map: "de_nuke", matches: 4, wins: 3, winRate: 75 },
      { map: "de_mirage", matches: 3, wins: 2, winRate: 67 },
    ]);
  });
});

describe("loadoutShowcase", () => {
  const item = (display_name: string, weapon_class = "") => ({ display_name, weapon_class, image_url: `/img/${display_name}.png` });
  it("picks the side with more equipped skins and prefers exact-side looks", () => {
    const showcase = loadoutShowcase([
      { slot: "knife", team_scope: "all", skinchanger_catalog_items: item("Karambit | Fade") },
      { slot: "knife", team_scope: "ct", skinchanger_catalog_items: item("M9 | Doppler") },
      { slot: "weapon", team_scope: "ct", skinchanger_catalog_items: item("AWP | Asiimov", "AWP") },
      { slot: "weapon", team_scope: "t", skinchanger_catalog_items: item("AK-47 | Redline", "AK-47") },
    ]);
    expect(showcase?.side).toBe("ct");
    expect(showcase?.items.map((entry) => entry.name)).toEqual(["M9 | Doppler", null, null, "AWP | Asiimov"]);
  });
  it("is null when nothing is equipped", () => {
    expect(loadoutShowcase([])).toBeNull();
    expect(loadoutShowcase([{ slot: "pin", team_scope: "t", skinchanger_catalog_items: item("Pin") }])).toBeNull();
  });
});

describe("staffCard", () => {
  it("only exists for staff roles", () => {
    expect(staffCard("Player", 0)).toBeNull();
    expect(staffCard("Owner", 12)).toMatchObject({ role: "Owner", penaltiesIssued: 12 });
  });
});
