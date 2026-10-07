import { describe, expect, it } from "vitest";
import { CLAN_LIMITS, canManage, canRemove, clanRole, describeClanAction, leaveCooldownLeftMs } from "./clans";

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
    expect(canRemove("co-leader", "co-leader")).toBe(false);
    expect(canRemove("co-leader", "leader")).toBe(false);
    expect(canRemove("leader", "leader")).toBe(false);
    expect(canRemove("member", "member")).toBe(false);
    expect(canRemove(null, "member")).toBe(false);
  });
  it("reads only known roles", () => {
    expect(clanRole("co-leader")).toBe("co-leader");
    expect(clanRole("owner")).toBeNull();
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
