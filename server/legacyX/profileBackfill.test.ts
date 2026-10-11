import { describe, expect, it } from "vitest";
import { isBare, pickMissing, pickToBackfill } from "./profileBackfill";

describe("isBare", () => {
  it("is an account with no picture or the placeholder name", () => {
    expect(isBare({ username: "Anu", avatar: "" })).toBe(true);
    expect(isBare({ username: "Steam 76561198000000001", avatar: "https://x/a.jpg" })).toBe(true);
    expect(isBare({ username: "Anu", avatar: "https://x/a.jpg" })).toBe(false);
  });
});

describe("pickToBackfill", () => {
  it("takes a few at a time and leaves the rest for the next heartbeat", () => {
    const seen = new Map<string, number>();
    expect(pickToBackfill(["a", "b", "c", "d", "e"], 1_000, 3, seen)).toEqual(["a", "b", "c"]);
    expect(pickToBackfill(["a", "b", "c", "d", "e"], 2_000, 3, seen)).toEqual(["d", "e"]);
  });
  it("tries the same player again only after an hour", () => {
    const seen = new Map<string, number>();
    expect(pickToBackfill(["a"], 0, 3, seen)).toEqual(["a"]);
    expect(pickToBackfill(["a"], 59 * 60_000, 3, seen)).toEqual([]);
    expect(pickToBackfill(["a"], 61 * 60_000, 3, seen)).toEqual(["a"]);
  });
});

describe("pickMissing", () => {
  it("skips known players and tries a new one once an hour", () => {
    const seen = new Map<string, number>();
    const known = new Set(["a"]);
    expect(pickMissing(["a", "b", "c"], known, 0, 10, seen)).toEqual(["b", "c"]);
    expect(pickMissing(["b"], known, 59 * 60_000, 10, seen)).toEqual([]);
    expect(pickMissing(["b"], known, 61 * 60_000, 10, seen)).toEqual(["b"]);
  });
  it("creates at most a handful per heartbeat", () => {
    expect(pickMissing(["a", "b", "c", "d"], new Set(), 0, 2, new Map())).toEqual(["a", "b"]);
  });
});
