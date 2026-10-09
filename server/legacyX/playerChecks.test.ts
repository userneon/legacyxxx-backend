import { describe, expect, it } from "vitest";
import { checkReportSchema, createCheckSchema, generateCheckCode, hashCheckCode, normalizeCheckCode, summarizeReport } from "./playerChecks";

const STEAM = "76561198000000001";
const report = { consent: true as const, checkerVersion: "1.0.0", steamIds: [STEAM], filesScanned: 1000, durationSeconds: 90, findings: [{ name: "cheat.exe", kind: "file" as const, confidence: "detection" as const, path: "C:\\Users\\***\\cheat.exe" }, { name: "loader", kind: "trace" as const, confidence: "suspicion" as const }] };

describe("check codes", () => {
  it("makes a code that reads back the same way it was made", () => {
    for (let index = 0; index < 50; index += 1) {
      const code = generateCheckCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01OIL]/);
      expect(normalizeCheckCode(code)).toBe(code.replace("-", ""));
    }
  });
  it("accepts a code typed in lower case or with spaces, and nothing else", () => {
    expect(normalizeCheckCode("k7f2 9qx4")).toBe("K7F29QX4");
    expect(normalizeCheckCode("K7F2-9QX")).toBeNull();
    expect(normalizeCheckCode("K7F2-9QX0")).toBeNull();
    expect(normalizeCheckCode("")).toBeNull();
  });
  it("stores a hash, the same for the same code", () => {
    expect(hashCheckCode("K7F29QX4")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCheckCode("K7F29QX4")).toBe(hashCheckCode("K7F29QX4"));
    expect(hashCheckCode("K7F29QX4")).not.toBe(hashCheckCode("K7F29QX5"));
  });
});

describe("check input", () => {
  it("needs a 17 digit Steam ID and nothing else", () => {
    expect(createCheckSchema.safeParse({ steamId: STEAM }).success).toBe(true);
    expect(createCheckSchema.safeParse({ steamId: "123" }).success).toBe(false);
    expect(createCheckSchema.safeParse({ steamId: STEAM, extra: 1 }).success).toBe(false);
  });
});

describe("check report", () => {
  it("is only accepted with the player's consent", () => {
    expect(checkReportSchema.safeParse(report).success).toBe(true);
    expect(checkReportSchema.safeParse({ ...report, consent: false }).success).toBe(false);
  });
  it("refuses fields it does not know, so nothing extra is smuggled in", () => {
    expect(checkReportSchema.safeParse({ ...report, screenshot: "data:..." }).success).toBe(false);
    expect(checkReportSchema.safeParse({ ...report, findings: [{ name: "x", kind: "file", confidence: "detection", contents: "..." }] }).success).toBe(false);
  });
  it("takes what Steam's files say about each account, and nothing it does not know", () => {
    const withSteam = { ...report, steamAccounts: [{ steamId: STEAM, accountName: "login", personaName: "Nick", lastLogin: "2026-10-01T10:00:00Z", mostRecent: true, cs2LastPlayed: "2026-10-08T20:00:00Z", cs2Hours: 812.5, launchOptions: "-novid -insecure" }], cs2: { installed: true, lastUpdated: "2026-10-05T00:00:00Z" } };
    expect(checkReportSchema.safeParse(withSteam).success).toBe(true);
    expect(checkReportSchema.safeParse({ ...withSteam, steamAccounts: [{ steamId: STEAM, password: "x" }] }).success).toBe(false);
    expect(checkReportSchema.safeParse({ ...withSteam, steamAccounts: [{ steamId: STEAM, lastLogin: "yesterday" }] }).success).toBe(false);
  });
  it("keeps what the server learned from Steam next to the report", () => {
    const parsed = checkReportSchema.parse(report);
    expect(summarizeReport(parsed, STEAM, [{ steamId: STEAM, vacBanned: true }])).toMatchObject({ steamBans: [{ steamId: STEAM, vacBanned: true }] });
    expect(summarizeReport(parsed, STEAM).steamBans).toEqual([]);
  });
  it("counts detections and suspicions and says whether the asked player was on the PC", () => {
    const parsed = checkReportSchema.parse(report);
    expect(summarizeReport(parsed, STEAM)).toMatchObject({ detections: 1, suspicions: 1, matchesTarget: true });
    expect(summarizeReport(parsed, "76561198000000002").matchesTarget).toBe(false);
  });
});
