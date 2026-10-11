import { describe, expect, it } from "vitest";
import { latestExpChanges } from "./expChange";

const now = Date.parse("2026-10-11T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

describe("latestExpChanges", () => {
  it("takes each player's newest recent match", () => {
    const changes = latestExpChanges([
      { user_id: "a", exp_delta: 12, created_at: hoursAgo(5) },
      { user_id: "a", exp_delta: -30, created_at: hoursAgo(1) },
      { user_id: "b", exp_delta: 9, created_at: hoursAgo(3) },
    ], now);
    expect(changes.get("a")).toBe(-30);
    expect(changes.get("b")).toBe(9);
  });
  it("leaves out matches older than two days", () => {
    expect(latestExpChanges([{ user_id: "a", exp_delta: 20, created_at: hoursAgo(49) }], now).size).toBe(0);
  });
  it("ignores unreadable rows", () => {
    expect(latestExpChanges([{ user_id: "a", exp_delta: 5, created_at: "nope" }], now).size).toBe(0);
  });
});
