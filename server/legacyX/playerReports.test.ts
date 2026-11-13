import { describe, expect, it } from "vitest";
import { createReportSchema, reportOutcomeMessage, resolveReportSchema } from "./playerReports";

const id = "11111111-1111-4111-8111-111111111111";

describe("player reports", () => {
  it("takes a category, a short reason and an optional https link", () => {
    expect(createReportSchema.parse({ reportedUserId: id, category: "cheating", reason: "Walls in round 4", evidenceUrl: "youtu.be/abc" }).evidenceUrl).toBe("https://youtu.be/abc");
    expect(createReportSchema.parse({ reportedUserId: id, category: "toxic", reason: "Insults in voice" }).evidenceUrl).toBeUndefined();
    expect(createReportSchema.parse({ reportedUserId: id, category: "toxic", reason: "Insults in voice", evidenceUrl: "http://example.com/x" }).evidenceUrl).toBe("https://example.com/x");
  });
  it("refuses an unknown category, a too short reason, a bad link and unknown fields", () => {
    expect(createReportSchema.safeParse({ reportedUserId: id, category: "spam", reason: "Long enough" }).success).toBe(false);
    expect(createReportSchema.safeParse({ reportedUserId: id, category: "other", reason: "no" }).success).toBe(false);
    expect(createReportSchema.safeParse({ reportedUserId: id, category: "other", reason: "Long enough", evidenceUrl: "not a link" }).success).toBe(false);
    expect(createReportSchema.safeParse({ reportedUserId: id, category: "other", reason: "Long enough", status: "actioned" }).success).toBe(false);
  });
  it("lets staff answer with action or none, and a short note", () => {
    expect(resolveReportSchema.parse({ outcome: "dismissed", note: "No proof" })).toEqual({ outcome: "dismissed", note: "No proof" });
    expect(resolveReportSchema.safeParse({ outcome: "banned" }).success).toBe(false);
    expect(resolveReportSchema.safeParse({ outcome: "actioned", note: "x".repeat(201) }).success).toBe(false);
  });
  it("tells the reporter the outcome without naming anyone", () => {
    expect(reportOutcomeMessage("actioned").body).not.toMatch(/banned|muted/);
    expect(reportOutcomeMessage("dismissed").title).toBe("Your report was reviewed");
  });
});
