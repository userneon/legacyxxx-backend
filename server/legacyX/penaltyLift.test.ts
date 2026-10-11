import { describe, expect, it } from "vitest";
import { liftInfo, liftedByName } from "./penaltyLift";

const names = new Map([["u1", "Anu"]]);

describe("liftedByName", () => {
  it("prefers the staff member recorded by the website", () => {
    expect(liftedByName({ revoked_by: "u1", revoke_reason: "Appeal accepted" }, names)).toBe("Anu");
  });
  it("reads the name the Discord bot and the game servers put in the reason", () => {
    expect(liftedByName({ revoked_by: null, revoke_reason: "Lifted by Dorj" }, names)).toBe("Dorj");
  });
  it("says nothing when nobody is recorded, and never guesses from a free reason", () => {
    expect(liftedByName({ revoked_by: null, revoke_reason: "Appeal accepted" }, names)).toBeNull();
    expect(liftedByName({ revoked_by: "gone", revoke_reason: null }, names)).toBeNull();
  });
});

describe("liftInfo", () => {
  it("carries the time of the lift", () => {
    expect(liftInfo({ revoked_by: "u1", revoked_at: "2026-10-10T08:00:00Z" }, names)).toEqual({ liftedBy: "Anu", liftedAt: "2026-10-10T08:00:00Z" });
  });
});
