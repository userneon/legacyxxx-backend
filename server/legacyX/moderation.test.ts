import { describe, expect, it } from "vitest";
import { mayModerate, mayTouchBan, needsReview, termFields } from "./moderation";

describe("website moderation rules", () => {
  it("lets Owners, Managers and Admins in, and nobody else", () => {
    for (const role of ["OWNER", "MANAGER", "ADMIN"]) expect(mayModerate(role, [], "unban")).toBe(true);
    for (const role of ["DEVELOPER", "DESIGNER", "", null, undefined]) expect(mayModerate(role, [], "unban")).toBe(false);
  });
  it("narrows a non-owner to their permission list when they have one", () => {
    expect(mayModerate("ADMIN", ["unban"], "unban")).toBe(true);
    expect(mayModerate("ADMIN", ["unban"], "ban")).toBe(false);
    expect(mayModerate("ADMIN", ["ban"], "edit")).toBe(true);
    expect(mayModerate("MANAGER", ["*"], "ban")).toBe(true);
    expect(mayModerate("OWNER", ["unban"], "ban")).toBe(true);
  });
  it("respects immunity except for Owners", () => {
    expect(mayTouchBan("ADMIN", 20, 20)).toBe(true);
    expect(mayTouchBan("ADMIN", 20, 500)).toBe(false);
    expect(mayTouchBan("ADMIN", null, 20)).toBe(false);
    expect(mayTouchBan("OWNER", 0, 1000)).toBe(true);
    expect(mayTouchBan("ADMIN", 0, null)).toBe(true);
  });
  it("turns a length of time into the stored fields", () => {
    const now = new Date("2026-10-07T00:00:00Z");
    expect(termFields(0, now)).toEqual({ term: "Permanent", is_permanent: true, expires_at: null });
    expect(termFields(1440, now)).toEqual({ term: "1 day", is_permanent: false, expires_at: "2026-10-08T00:00:00.000Z" });
  });
  it("sends permanent penalties from admins to review", () => {
    expect(needsReview("ADMIN", true)).toBe(true);
    expect(needsReview("MANAGER", true)).toBe(false);
    expect(needsReview("ADMIN", false)).toBe(false);
  });
});
