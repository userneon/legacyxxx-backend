import { describe, expect, it } from "vitest";
import { claimFounder, founderCount, founderLabel, founderNumberOf, founderSalesOpen, productDeadlines } from "./founder";

const rpcDb = (result: { data?: unknown; error?: { message: string } | null }) => ({ rpc: async () => ({ data: result.data ?? null, error: result.error ?? null }) }) as never;

describe("Founder pack", () => {
  it("writes the number with four digits", () => {
    expect(founderLabel(1)).toBe("#0001");
    expect(founderLabel(42)).toBe("#0042");
    expect(founderLabel(1234)).toBe("#1234");
  });

  it("sells until the deadline and never ends without one", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    expect(founderSalesOpen(null, now)).toBe(true);
    expect(founderSalesOpen("2026-11-30T23:59:59+08:00", now)).toBe(true);
    expect(founderSalesOpen("2026-11-01T00:00:00Z", now)).toBe(false);
    expect(founderSalesOpen("not a date", now)).toBe(true);
  });

  it("returns the number the database gives", async () => {
    await expect(claimFounder(rpcDb({ data: 7 }), "u", "o", 500)).resolves.toBe(7);
  });

  it("says so when every pack is taken", async () => {
    await expect(claimFounder(rpcDb({ error: { message: "founder_sold_out" } }), "u", "o", 500)).rejects.toMatchObject({ statusCode: 409, code: "founder_sold_out" });
  });

  it("refuses a missing or invalid number", async () => {
    await expect(claimFounder(rpcDb({ data: null }), "u", "o", 500)).rejects.toMatchObject({ statusCode: 500 });
  });

  it("reads counts, numbers and deadlines without throwing when the table is missing", async () => {
    const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "relation does not exist" } }) }), in: async () => ({ data: null, error: { message: "column does not exist" } }) }) }) } as never;
    await expect(founderNumberOf(missing, "u")).resolves.toBeNull();
    await expect(productDeadlines(missing, ["p"])).resolves.toEqual(new Map());
    const countMissing = { from: () => ({ select: async () => ({ count: null, error: { message: "relation does not exist" } }) }) } as never;
    await expect(founderCount(countMissing)).resolves.toBeNull();
  });
});
