import { describe, expect, it } from "vitest";
import { cleanCreatorLinks, creatorApplicationSchema, creatorDecisionSchema, sortCreators, upsertCreatorSchema, validCreatorLink } from "./creators";

describe("content creators", () => {
  it("accepts only https links on each platform's own host", () => {
    expect(validCreatorLink("twitch", "https://www.twitch.tv/legacyx")).toBe(true);
    expect(validCreatorLink("youtube", "https://youtu.be/abc")).toBe(true);
    expect(validCreatorLink("twitch", "http://twitch.tv/legacyx")).toBe(false);
    expect(validCreatorLink("twitch", "https://twitch.tv.evil.com/x")).toBe(false);
    expect(validCreatorLink("tiktok", "https://user:pass@tiktok.com/@x")).toBe(false);
    expect(validCreatorLink("kick", "javascript:alert(1)")).toBe(false);
  });

  it("validates the staff form and drops empty links", () => {
    const parsed = upsertCreatorSchema.parse({ tier: "main", bio: " CS2 streams ", links: { twitch: "https://twitch.tv/a", youtube: "" } });
    expect(parsed).toEqual({ tier: "main", bio: "CS2 streams", links: { twitch: "https://twitch.tv/a" }, sort: 0 });
    expect(() => upsertCreatorSchema.parse({ tier: "main", links: { twitch: "https://evil.com" } })).toThrow();
    expect(() => upsertCreatorSchema.parse({ tier: "boss" })).toThrow();
    expect(() => upsertCreatorSchema.parse({ tier: "creator", links: { myspace: "https://myspace.com" } })).toThrow();
  });

  it("keeps only valid stored links and puts main creators first", () => {
    expect(cleanCreatorLinks({ twitch: "https://twitch.tv/a", youtube: "http://youtube.com/x", other: "https://x.com" })).toEqual({ twitch: "https://twitch.tv/a" });
    const rows = sortCreators([
      { id: "c", tier: "creator" as const, sort: 0, createdAt: "2026-10-01T00:00:00Z" },
      { id: "m2", tier: "main" as const, sort: 1, createdAt: "2026-10-01T00:00:00Z" },
      { id: "m1", tier: "main" as const, sort: 0, createdAt: "2026-10-05T00:00:00Z" },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "c"]);
  });

  it("needs a short line and at least one valid channel link to apply", () => {
    const ok = creatorApplicationSchema.parse({ bio: " I stream CS2 scrims ", links: { twitch: "https://twitch.tv/a", youtube: "" } });
    expect(ok).toEqual({ bio: "I stream CS2 scrims", links: { twitch: "https://twitch.tv/a" } });
    expect(() => creatorApplicationSchema.parse({ bio: "I stream CS2 scrims", links: {} })).toThrow();
    expect(() => creatorApplicationSchema.parse({ bio: "short", links: { twitch: "https://twitch.tv/a" } })).toThrow();
    expect(() => creatorApplicationSchema.parse({ bio: "I stream CS2 scrims", links: { twitch: "https://evil.com/a" } })).toThrow();
  });

  it("reads the staff answer, defaulting to Content Creator", () => {
    expect(creatorDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve", tier: "creator", note: "" });
    expect(creatorDecisionSchema.parse({ decision: "decline", note: " not yet " }).note).toBe("not yet");
    expect(() => creatorDecisionSchema.parse({ decision: "maybe" })).toThrow();
  });
});
