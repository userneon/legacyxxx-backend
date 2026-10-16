import { describe, expect, it } from "vitest";
import { communityInputSchema, mergeCommunity } from "./discordCommunity";

const A = "100000000000000001";
const B = "100000000000000002";
const parse = (value: unknown) => communityInputSchema.parse(value);

describe("mergeCommunity", () => {
  it("gives a current booster at least one boost and keeps the earliest start", () => {
    const rows = mergeCommunity([{ discordId: A, boosts: 0, boostingSince: "2026-05-01T00:00:00.000Z", invites: 0 }], parse({ boosters: [{ discordId: A, since: "2026-06-01T00:00:00.000Z" }, { discordId: B, since: "2026-04-01T00:00:00.000Z" }] }));
    expect(rows.find((row) => row.discordId === A)).toMatchObject({ boosts: 1, boostingSince: "2026-05-01T00:00:00.000Z" });
    expect(rows.find((row) => row.discordId === B)).toMatchObject({ boosts: 1, boostingSince: "2026-04-01T00:00:00.000Z" });
  });
  it("adds witnessed boosts on top of the count", () => {
    const rows = mergeCommunity([{ discordId: A, boosts: 2, boostingSince: null, invites: 0 }], parse({ boostEvents: [{ discordId: A, count: 2 }, { discordId: A }] }));
    expect(rows).toEqual([{ discordId: A, boosts: 5, boostingSince: null, invites: 0 }]);
  });
  it("never lowers invites when an invite is deleted", () => {
    const rows = mergeCommunity([{ discordId: A, boosts: 0, boostingSince: null, invites: 9 }], parse({ inviters: [{ discordId: A, uses: 4 }] }));
    expect(rows[0].invites).toBe(9);
    expect(mergeCommunity(rows, parse({ inviters: [{ discordId: A, uses: 12 }] }))[0].invites).toBe(12);
  });
  it("returns only the members a report mentions and rejects bad ids", () => {
    expect(mergeCommunity([{ discordId: B, boosts: 3, boostingSince: null, invites: 0 }], parse({ inviters: [{ discordId: A, uses: 1 }] })).map((row) => row.discordId)).toEqual([A]);
    expect(() => parse({ boosters: [{ discordId: "abc" }] })).toThrow();
  });
});
