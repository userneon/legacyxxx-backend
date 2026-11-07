import { describe, expect, it } from "vitest";
import { ADMIN_LEVELS, effectiveExtras, extraCommandChoices, extraCommandsProblem } from "./adminLevels";

describe("admin levels", () => {
  it("allow 3, 5 and 10 extra commands", () => {
    expect(Object.entries(ADMIN_LEVELS).map(([key, level]) => [key, level.quota])).toEqual([["admin", 3], ["high", 5], ["plus", 10]]);
  });
  it("accepts picks within the level and refuses the rest", () => {
    const base = ["kick", "ban"];
    expect(extraCommandsProblem("admin", ["unban", "map", "rename"], base)).toBeNull();
    expect(extraCommandsProblem("admin", ["unban", "map", "rename", "bring"], base)).toMatch(/Admin may have 3 extra commands at most/);
    expect(extraCommandsProblem("high", ["unban", "map", "rename", "bring", "goto"], base)).toBeNull();
    expect(extraCommandsProblem("plus", Array.from({ length: 10 }, (_, i) => ["unban", "map", "rename", "bring", "goto", "freeze", "blind", "bury", "drug", "glow"][i]!), base)).toBeNull();
    expect(extraCommandsProblem("plus", ["unban", "unban"], base)).toMatch(/twice/);
    expect(extraCommandsProblem("admin", ["rcon"], base)).toMatch(/cannot be granted/);
    expect(extraCommandsProblem("admin", ["nope"], base)).toMatch(/unknown/);
    expect(extraCommandsProblem("admin", ["kick"], base)).toMatch(/already part of the Admin role/);
  });
  it("gives the game server only valid picks, never more than the level allows", () => {
    const base = ["kick"];
    expect(effectiveExtras("admin", ["unban", "map", "rename", "bring", "goto"], base)).toEqual(["unban", "map", "rename"]);
    expect(effectiveExtras("plus", ["unban", "rcon", "kick", "nope", "unban", "map"], base)).toEqual(["unban", "map"]);
    expect(effectiveExtras("bogus", null, base)).toEqual([]);
  });
  it("offers only commands that can be granted", () => {
    const names = extraCommandChoices().map((choice) => choice.name);
    expect(names).toContain("unban");
    expect(names).not.toContain("rcon");
    expect(names).not.toContain("addadmin");
  });
});
