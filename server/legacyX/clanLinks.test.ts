import { describe, expect, it } from "vitest";
import { cleanClanLinks, clanLinksSchema, validClanLink } from "./clanLinks";

describe("clan links", () => {
  it("accepts a link on the platform's own host and turns a bare address into https", () => {
    expect(clanLinksSchema.parse({ discord: "discord.gg/legacyx", youtube: "https://www.youtube.com/@clan" })).toEqual({ discord: "https://discord.gg/legacyx", youtube: "https://www.youtube.com/@clan" });
  });
  it("refuses another host, a login in the address, a look-alike host and an unknown platform", () => {
    expect(clanLinksSchema.safeParse({ discord: "https://evil.example/discord.gg" }).success).toBe(false);
    expect(clanLinksSchema.safeParse({ discord: "https://user:pw@discord.gg/x" }).success).toBe(false);
    expect(validClanLink("discord", "https://notdiscord.gg/x")).toBe(false);
    expect(clanLinksSchema.safeParse({ website: "https://example.com" }).success).toBe(false);
  });
  it("leaves empty ones out, so an empty object clears every link", () => {
    expect(clanLinksSchema.parse({ discord: "", kick: "kick.com/clan" })).toEqual({ kick: "https://kick.com/clan" });
    expect(clanLinksSchema.parse({})).toEqual({});
  });
  it("reads stored links back, dropping anything that no longer passes", () => {
    expect(cleanClanLinks({ discord: "https://discord.gg/a", steam: "http://steamcommunity.com/groups/x", other: "https://x.com" })).toEqual({ discord: "https://discord.gg/a" });
    expect(cleanClanLinks(null)).toEqual({});
  });
});
