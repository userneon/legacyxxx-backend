import { describe, expect, it } from "vitest";
import { isMissingTableError, ownerLinks, ownerProfileSchema, ownerTeam, ownerUpdates } from "./ownerProfile";

describe("owner profile input", () => {
  it("accepts https links and a message", () => {
    expect(ownerProfileSchema.parse({ links: [{ url: "https://instagram.com/x", label: "Insta" }], message: "Hi" }).links).toHaveLength(1);
  });
  it("rejects other schemes, credentials, long messages and too many links", () => {
    for (const url of ["javascript:alert(1)", "http://example.com", "data:text/html,x", "https://user:pw@example.com", "https://localhost"]) {
      expect(ownerProfileSchema.safeParse({ links: [{ url }] }).success).toBe(false);
    }
    expect(ownerProfileSchema.safeParse({ message: "x".repeat(281) }).success).toBe(false);
    expect(ownerProfileSchema.safeParse({ links: Array.from({ length: 9 }, () => ({ url: "https://a.com" })) }).success).toBe(false);
    expect(ownerProfileSchema.safeParse({}).success).toBe(false);
  });
  it("drops stored links that are not plain https", () => {
    expect(ownerLinks([{ url: "https://a.com" }, { url: "javascript:1" }, "nope", null])).toEqual([{ url: "https://a.com" }]);
    expect(ownerLinks(null)).toEqual([]);
  });
});

describe("owner profile lists", () => {
  it("lists the team without the Owner, in rank order", () => {
    const user = (name: string) => ({ steam_id: `7656${name}`, username: name, avatar: "" });
    const team = ownerTeam([
      { role: "DESIGNER", users: user("d") }, { role: "OWNER", users: user("o") }, { role: "MANAGER", users: user("m") }, { role: "ADMIN", users: [user("a")] },
    ]);
    expect(team.map((member) => member.role)).toEqual(["Manager", "Admin", "Designer"]);
  });
  it("maps updates and spots a missing table", () => {
    expect(ownerUpdates([{ id: 4, title: "CS2 update", created_at: "2026-10-04T00:00:00Z" }, { id: 5, title: "", created_at: "x" }])).toEqual([{ id: "4", title: "CS2 update", at: "2026-10-04T00:00:00Z" }]);
    expect(isMissingTableError({ code: "42P01" })).toBe(true);
    expect(isMissingTableError({ code: "PGRST205" })).toBe(true);
    expect(isMissingTableError({ code: "23505" })).toBe(false);
  });
});
