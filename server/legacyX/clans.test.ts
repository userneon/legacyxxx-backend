import { describe, expect, it } from "vitest";
import { CLAN_LIMITS, canManage, canRemove, clanRole, describeClanAction, leaveCooldownLeftMs, verifiedClanIds } from "./clans";

describe("clan permissions", () => {
  it("lets leaders and co-leaders manage, and nobody else", () => {
    expect(canManage("leader")).toBe(true);
    expect(canManage("co-leader")).toBe(true);
    expect(canManage("member")).toBe(false);
    expect(canManage(null)).toBe(false);
  });
  it("lets only the leader remove a co-leader and never the leader", () => {
    expect(canRemove("leader", "member")).toBe(true);
    expect(canRemove("leader", "co-leader")).toBe(true);
    expect(canRemove("co-leader", "member")).toBe(true);
    expect(canRemove("co-leader", "captain")).toBe(true);
    expect(canRemove("captain", "member")).toBe(false);
    expect(canManage("captain")).toBe(false);
    expect(canRemove("co-leader", "co-leader")).toBe(false);
    expect(canRemove("co-leader", "leader")).toBe(false);
    expect(canRemove("leader", "leader")).toBe(false);
    expect(canRemove("member", "member")).toBe(false);
    expect(canRemove(null, "member")).toBe(false);
  });
  it("reads only known roles", () => {
    expect(clanRole("co-leader")).toBe("co-leader");
    expect(clanRole("owner")).toBeNull();
    expect(clanRole("captain")).toBe("captain");
  });
});

describe("leave cooldown", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  it("counts down from the moment a player left", () => {
    expect(leaveCooldownLeftMs("2026-10-07T11:00:00Z", now)).toBe((CLAN_LIMITS.leaveCooldownHours - 1) * 3_600_000);
    expect(leaveCooldownLeftMs("2026-10-05T11:00:00Z", now)).toBe(0);
    expect(leaveCooldownLeftMs(null, now)).toBe(0);
    expect(leaveCooldownLeftMs("not a date", now)).toBe(0);
  });
});

describe("activity text", () => {
  it("describes known and unknown actions", () => {
    expect(describeClanAction("kicked", null)).toBe("was removed");
    expect(describeClanAction("renamed", "Old to New")).toBe("changed the clan name or tag (Old to New)");
    expect(describeClanAction("something_new", null)).toBe("something_new");
  });
});

describe("verified clans", () => {
  const ids = (count: number, prefix = "u") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  it("needs ten members who all linked Discord", () => {
    const all = new Set(ids(12));
    expect([...verifiedClanIds(new Map([["a", ids(10)], ["b", ids(12)]]), all)]).toEqual(["a", "b"]);
  });
  it("is not verified with fewer than ten members, even if they all linked", () => {
    expect(verifiedClanIds(new Map([["a", ids(9)]]), new Set(ids(9))).size).toBe(0);
  });
  it("is not verified when one member has not linked Discord", () => {
    const linked = new Set(ids(10));
    linked.delete("u3");
    expect(verifiedClanIds(new Map([["a", ids(10)]]), linked).size).toBe(0);
  });
});
