import { describe, expect, it } from "vitest";
import { cosmeticEditSchema } from "./cosmeticAdmin";

const ok = { nameEn: " Frost Ring ", nameMn: "Мөсөн цагираг", unlock: "coin", price: 200, requirement: "", sort: 4, enabled: true };

describe("cosmetic edits", () => {
  it("accepts a coin item with a price and trims names", () => {
    expect(cosmeticEditSchema.parse(ok).nameEn).toBe("Frost Ring");
  });
  it("ties the price to the coin unlock", () => {
    expect(() => cosmeticEditSchema.parse({ ...ok, price: 0 })).toThrow();
    expect(() => cosmeticEditSchema.parse({ ...ok, unlock: "free", price: 100 })).toThrow();
    expect(cosmeticEditSchema.parse({ ...ok, unlock: "achievement", price: 0, requirement: "Season 1 winner" }).unlock).toBe("achievement");
  });
  it("refuses unknown fields and bad numbers", () => {
    expect(() => cosmeticEditSchema.parse({ ...ok, color: "#ffffff" })).toThrow();
    expect(() => cosmeticEditSchema.parse({ ...ok, price: 1.5 })).toThrow();
    expect(() => cosmeticEditSchema.parse({ ...ok, nameEn: "x" })).toThrow();
  });
});
