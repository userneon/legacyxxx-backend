import { describe, expect, it } from "vitest";
import { itemsToGrant } from "./qaAccess";

describe("itemsToGrant", () => {
  const now = Date.parse("2026-11-07T00:00:00Z");
  it("grants what is not held", () => expect(itemsToGrant(["a", "b", "c"], [{ item_id: "a", expires_at: null }], now)).toEqual(["b", "c"]));
  it("leaves a rented item that is still running", () => expect(itemsToGrant(["a"], [{ item_id: "a", expires_at: "2026-12-01T00:00:00Z" }], now)).toEqual([]));
  it("replaces an expired row", () => expect(itemsToGrant(["a"], [{ item_id: "a", expires_at: "2026-10-01T00:00:00Z" }], now)).toEqual(["a"]));
  it("grants nothing when all are held for good", () => expect(itemsToGrant(["a", "b"], [{ item_id: "a", expires_at: null }, { item_id: "b", expires_at: null }], now)).toEqual([]));
});
