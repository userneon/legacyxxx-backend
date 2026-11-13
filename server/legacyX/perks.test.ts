import { describe, expect, it } from "vitest";
import { PERK_QUOTAS, effectivePerkCommands, grantAfterPurchase, perkCheckoutProblem, perkCommandsProblem, perkPool, savePicks, type PerkGrant } from "./perks";

const now = new Date("2026-11-07T00:00:00Z");
const day = 86_400_000;
const running = (extra: Partial<PerkGrant> = {}): PerkGrant => ({ tier: "tier1", endsAt: new Date(now.getTime() + 5 * day).toISOString(), commands: [], locked: false, ...extra });

describe("paid ranks", () => {
  it("allow 3, 5 and 10 commands", () => {
    expect(PERK_QUOTAS).toEqual({ tier1: 3, tier2: 5, tier3: 10, tier4: 1, tier5: 15 });
  });
  it("offer only fun commands, nothing that punishes or runs the server", () => {
    const names = perkPool().map((command) => command.name);
    expect(names).toContain("freeze");
    expect(names).toContain("noclip");
    for (const banned of ["ban", "kick", "mute", "gag", "rcon", "map", "admin", "unban", "vote"]) expect(names).not.toContain(banned);
  });
  it("checks picks against the pool and the number", () => {
    expect(perkCommandsProblem(3, ["freeze", "blind", "bury"])).toBeNull();
    expect(perkCommandsProblem(3, ["freeze", "blind", "bury", "drug"])).toMatch(/3 commands at most/);
    expect(perkCommandsProblem(3, ["ban"])).toMatch(/cannot be picked/);
    expect(perkCommandsProblem(3, ["freeze", "freeze"])).toMatch(/twice/);
  });
  it("sells one rank at a time; the same tier renews", () => {
    expect(perkCheckoutProblem(null, "tier2", now)).toBeNull();
    expect(perkCheckoutProblem(running(), "tier1", now)).toBeNull();
    expect(perkCheckoutProblem(running(), "tier2", now)).toMatch(/another rank/);
    expect(perkCheckoutProblem(running({ endsAt: new Date(now.getTime() - day).toISOString() }), "tier2", now)).toBeNull();
  });
  it("starts a new grant from now, or extends the running one and opens its picks", () => {
    const fresh = grantAfterPurchase(null, "tier1", 14, now);
    expect(fresh).toEqual({ tier: "tier1", endsAt: new Date(now.getTime() + 14 * day).toISOString(), commands: [], locked: false });
    const renewed = grantAfterPurchase(running({ commands: ["freeze", "blind", "bury"], locked: true }), "tier1", 30, now);
    expect(Date.parse(renewed.endsAt)).toBe(now.getTime() + 35 * day);
    expect(renewed.commands).toEqual(["freeze", "blind", "bury"]);
    expect(renewed.locked).toBe(false);
    const afterEnd = grantAfterPurchase(running({ endsAt: new Date(now.getTime() - day).toISOString(), commands: ["freeze"], locked: true }), "tier1", 30, now);
    expect(afterEnd.commands).toEqual([]);
  });
  it("lets the picks be saved until they are all picked, then locks them until a renewal", () => {
    const partial = savePicks(running(), ["freeze"], now);
    expect(partial).toEqual({ grant: expect.objectContaining({ commands: ["freeze"], locked: false }) });
    const again = savePicks((partial as { grant: PerkGrant }).grant, ["blind", "bury"], now);
    expect(again).toEqual({ grant: expect.objectContaining({ commands: ["blind", "bury"], locked: false }) });
    const full = savePicks(running(), ["freeze", "blind", "bury"], now) as { grant: PerkGrant };
    expect(full.grant.locked).toBe(true);
    expect(savePicks(full.grant, ["freeze"], now)).toMatchObject({ status: 409 });
    expect(savePicks(running({ endsAt: new Date(now.getTime() - 1).toISOString() }), ["freeze"], now)).toMatchObject({ status: 409 });
    expect(savePicks(running(), ["ban"], now)).toMatchObject({ status: 400 });
  });
  it("gives the game server only valid picks while the rank runs", () => {
    expect(effectivePerkCommands(running({ commands: ["freeze", "ban", "freeze", "blind"] }), now)).toEqual(["freeze", "blind"]);
    expect(effectivePerkCommands(running({ tier: "tier1", commands: ["freeze", "blind", "bury", "drug", "glow"] }), now)).toHaveLength(3);
    expect(effectivePerkCommands(running({ endsAt: new Date(now.getTime() - 1).toISOString(), commands: ["freeze"] }), now)).toEqual([]);
    expect(effectivePerkCommands({ tier: "nope", endsAt: running().endsAt, commands: ["freeze"] }, now)).toEqual([]);
    expect(effectivePerkCommands(null, now)).toEqual([]);
  });
});

import { GAME_COMMANDS as ALL_COMMANDS } from "./gameRoles";
import { PERK_BLOCKED, PERK_DEFAULT_LIMITS, perkPool as pool } from "./perks";
describe("what a paid rank can pick", () => {
  it("leaves out the commands that change the whole server, a player's name or what others hold", () => {
    const names = pool().map((command) => command.name);
    for (const blocked of PERK_BLOCKED) expect(names).not.toContain(blocked);
  });
  it("only limits commands that exist and can be picked", () => {
    const names = new Set(pool().map((command) => command.name));
    for (const name of Object.keys(PERK_DEFAULT_LIMITS)) { expect(ALL_COMMANDS.some((command) => command.name === name)).toBe(true); expect(names.has(name)).toBe(true); }
  });
  it("describes every command a buyer can pick", () => {
    for (const command of pool()) expect(command.summary.length).toBeGreaterThan(3);
  });
});
