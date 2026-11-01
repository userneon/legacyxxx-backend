import { describe, expect, it } from "vitest";

import { cleanReferralCode, newReferralCode, referralRefusal } from "./referrals";

describe("creator codes", () => {
  it("makes six unambiguous characters", () => {
    for (let i = 0; i < 50; i += 1) expect(newReferralCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  });
  it("cleans what a player typed", () => {
    expect(cleanReferralCode(" k7m-2qx ")).toBe("K7M2QX");
    expect(cleanReferralCode("K7M2Q")).toBeNull();
    expect(cleanReferralCode("K7M2Q0")).toBeNull();
  });
  it("refuses in a fixed order", () => {
    const ok = { isCreator: false, alreadyUsed: false, accountAgeDays: 3, windowDays: 14, rankedMatches: 1 };
    expect(referralRefusal(ok)).toBeNull();
    expect(referralRefusal({ ...ok, isCreator: true })).toBe("creator");
    expect(referralRefusal({ ...ok, alreadyUsed: true })).toBe("already_used");
    expect(referralRefusal({ ...ok, accountAgeDays: 15 })).toBe("too_old");
    expect(referralRefusal({ ...ok, rankedMatches: 0 })).toBe("not_played");
  });
});
