import { describe, expect, it } from "vitest";
import { adminCallRow, adminCallSchema, adminCallView, parseAfter } from "./adminCalls";

const valid = { callerSteamId: "76561198000000001", callerName: "Temuulen", target: "admin", serverId: "srv-27015", onlineStaff: 0 };

describe("adminCallSchema", () => {
  it("accepts a request with only the required fields", () => {
    expect(adminCallSchema.parse(valid)).toMatchObject({ target: "admin", onlineStaff: 0 });
  });
  it("rejects a bad SteamID, an unknown target and an empty name", () => {
    expect(adminCallSchema.safeParse({ ...valid, callerSteamId: "STEAM_0:1:123" }).success).toBe(false);
    expect(adminCallSchema.safeParse({ ...valid, target: "owner" }).success).toBe(false);
    expect(adminCallSchema.safeParse({ ...valid, callerName: "   " }).success).toBe(false);
  });
  it("maps optional fields to null for the table", () => {
    expect(adminCallRow(adminCallSchema.parse(valid))).toMatchObject({ server_name: null, map: null, players: null });
    expect(adminCallRow(adminCallSchema.parse({ ...valid, map: "de_mirage", players: 8 }))).toMatchObject({ map: "de_mirage", players: 8 });
  });
});

describe("a report", () => {
  const report = { ...valid, target: "report", reportedSteamId: "76561198000000002", reportedName: "Cheater", reason: "wallhack" };
  it("needs who was reported and why", () => {
    expect(adminCallSchema.safeParse(report).success).toBe(true);
    expect(adminCallSchema.safeParse({ ...valid, target: "report" }).success).toBe(false);
    expect(adminCallSchema.safeParse({ ...report, reason: undefined }).success).toBe(false);
    expect(adminCallSchema.safeParse({ ...report, reportedSteamId: "bot" }).success).toBe(false);
    expect(adminCallSchema.safeParse({ ...report, reason: "x".repeat(301) }).success).toBe(false);
  });
  it("needs no staff count, and maps to the table and back", () => {
    const parsed = adminCallSchema.parse({ ...report, onlineStaff: undefined });
    expect(parsed.onlineStaff).toBe(0);
    expect(adminCallRow(parsed)).toMatchObject({ target: "report", reported_steam_id: "76561198000000002", reported_name: "Cheater", reason: "wallhack" });
    expect(adminCallRow(adminCallSchema.parse(valid))).toMatchObject({ reported_steam_id: null, reason: null });
  });
});

describe("adminCallView", () => {
  it("returns camelCase with a numeric id", () => {
    const view = adminCallView({ id: 7, caller_steam_id: "76561198000000001", caller_name: "T", target: "manager", server_id: "s", server_name: null, map: null, players: null, online_staff: 2, created_at: "2026-09-30T10:00:00Z" });
    expect(view).toMatchObject({ id: 7, callerName: "T", target: "manager", onlineStaff: 2 });
  });
});

describe("parseAfter", () => {
  it("reads a non-negative integer and treats anything else as absent", () => {
    expect(parseAfter("12")).toBe(12);
    expect(parseAfter("0")).toBe(0);
    expect(parseAfter("")).toBeNull();
    expect(parseAfter("-1")).toBeNull();
    expect(parseAfter("1.5")).toBeNull();
    expect(parseAfter(undefined)).toBeNull();
  });
});
