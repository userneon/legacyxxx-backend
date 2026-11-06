import { describe, expect, it } from "vitest";

import { GAME_COMMANDS, GAME_ROLES, RETIRED_COMMANDS, defaultGameRole, flagsFor, gameRoleConfigSchema, parseGameRole } from "./gameRoles";

describe("in-game roles you can edit", () => {
  it("every built-in role is valid for the rules it is edited under", () => {
    for (const role of GAME_ROLES) expect(parseGameRole(defaultGameRole(role))).not.toBeNull();
  });

  it("creators start with the fun commands on fun servers, no punishing ones, no rename", () => {
    const creator = defaultGameRole("creator");
    expect(creator.modes).toEqual(["fun"]);
    expect(creator.commands).toEqual(expect.arrayContaining(["noclip", "god", "freeze", "goto", "bring", "slap", "slay"]));
    for (const name of ["ban", "kick", "mute", "gag", "map", "rcon", "rename", "unban", "admin"]) expect(creator.commands).not.toContain(name);
    expect(flagsFor(creator)).toEqual(["@css/cheats", "@css/slay"]);
    expect(defaultGameRole("main_creator").immunity).toBeGreaterThan(creator.immunity);
  });

  it("staff roles start where the plugin's built-in roles are: more commands up the ladder, every kind of server", () => {
    const [staff, admin, manager] = [defaultGameRole("staff"), defaultGameRole("admin"), defaultGameRole("manager")];
    expect(staff.modes).toEqual([]);
    expect(staff.commands).toContain("mute");
    expect(staff.commands).not.toContain("ban");
    expect(admin.commands).toEqual(expect.arrayContaining(["ban", "kick", "slap"]));
    expect(admin.commands).not.toContain("unban");
    expect(manager.commands).toContain("unban");
    expect(manager.extraFlags).toContain("@css/config");
    for (const role of [staff, admin, manager]) for (const name of ["rcon", "cvar", "addadmin"]) expect(role.commands).not.toContain(name);
  });

  it("refuses commands that do not exist or are locked, unknown permissions and out-of-range immunity", () => {
    const base = { commands: ["noclip"], extraFlags: [], modes: ["fun"], immunity: 100 };
    expect(gameRoleConfigSchema.safeParse(base).success).toBe(true);
    expect(gameRoleConfigSchema.safeParse({ ...base, commands: ["nope"] }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, commands: ["rcon"] }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, commands: ["wh"] }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, extraFlags: ["@css/root"] }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, modes: ["ranked"] }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, immunity: 1000 }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("sorts and de-duplicates what is saved, and derives the flags from the commands", () => {
    const saved = gameRoleConfigSchema.parse({ commands: ["slap", "noclip", "slap"], extraFlags: ["@legacyx/match"], modes: ["fun", "fun"], immunity: 50 });
    expect(saved).toEqual({ commands: ["noclip", "slap"], extraFlags: ["@legacyx/match"], modes: ["fun"], immunity: 50, limits: {} });
    expect(flagsFor(saved)).toEqual(["@css/cheats", "@css/slay", "@legacyx/match"]);
  });

  it("keeps the dangerous commands out of reach", () => {
    for (const name of ["rcon", "cvar", "addadmin", "removeadmin", "aimlock", "wh", "bhop", "silentaim", "cleanbans"]) expect(GAME_COMMANDS.find((command) => command.name === name)?.locked).toBe(true);
  });

  it("has one command for an effect and its undoing, and still reads roles saved with the twin", () => {
    for (const twin of Object.keys(RETIRED_COMMANDS)) expect(GAME_COMMANDS.find((command) => command.name === twin)).toBeUndefined();
    const old = gameRoleConfigSchema.parse({ commands: ["unblind", "freeze", "unfreeze"], extraFlags: [], modes: ["fun"], immunity: 100 });
    expect(old.commands).toEqual(["blind", "freeze"]);
    expect(defaultGameRole("creator").commands).toContain("blind");
  });

  it("keeps a limit only on a command the role has, drops empty ones and refuses wild values", () => {
    const base = { commands: ["blind", "freeze"], extraFlags: [], modes: ["fun"], immunity: 100 };
    const saved = gameRoleConfigSchema.parse({ ...base, limits: { blind: { cooldown: 30, perMap: 5 }, freeze: { cooldown: 0, perMap: 0 }, bury: { cooldown: 5, perMap: 0 } } });
    expect(saved.limits).toEqual({ blind: { cooldown: 30, perMap: 5 } });
    expect(gameRoleConfigSchema.safeParse({ ...base, limits: { blind: { cooldown: 3601, perMap: 0 } } }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, limits: { blind: { cooldown: 1, perMap: 1000 } } }).success).toBe(false);
    expect(gameRoleConfigSchema.safeParse({ ...base, limits: { rcon: { cooldown: 1, perMap: 0 } } }).success).toBe(false);
    expect(gameRoleConfigSchema.parse(base).limits).toEqual({});
  });
});
