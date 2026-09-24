import { describe, expect, it } from "vitest";
import { KillFeed, killEventSchema } from "./killfeed";

const kill = (id: number) => killEventSchema.parse({
  event_id: `kill-event-${id}`,
  server_id: "legacyx-1",
  attacker_name: `A${id}`,
  victim_name: `V${id}`,
  weapon: "weapon_ak47",
  headshot: id % 2 === 0,
  timestamp: "2026-09-24T10:00:00Z",
});

describe("KillFeed", () => {
  it("keeps only the newest entries and returns them after a cursor", () => {
    const feed = new KillFeed(3);
    for (let id = 1; id <= 5; id += 1) feed.add(kill(id));
    const all = feed.since(0);
    expect(all.entries.map(entry => entry.attackerName)).toEqual(["A3", "A4", "A5"]);
    expect(all.entries[0]!.weapon).toBe("ak47");
    expect(feed.since(all.cursor).entries).toEqual([]);
    feed.add(kill(6));
    expect(feed.since(all.cursor).entries.map(entry => entry.attackerName)).toEqual(["A6"]);
  });

  it("ignores a repeated event id", () => {
    const feed = new KillFeed();
    expect(feed.add(kill(1))).toBe(true);
    expect(feed.add(kill(1))).toBe(false);
    expect(feed.since().entries).toHaveLength(1);
  });

  it("rejects unexpected fields and malformed weapons", () => {
    expect(() => killEventSchema.parse({ ...kill(1), extra: true })).toThrow();
    expect(() => killEventSchema.parse({ ...kill(1), weapon: "<script>" })).toThrow();
  });
});
