import { describe, expect, it } from "vitest";
import { cardPrice, cardSellPrice } from "./cards";

describe("card prices", () => {
  it("starts at the base price and rises with every copy held (matches legacy_x.card_price)", () => {
    expect(cardPrice(60, 0)).toBe(60);
    expect(cardPrice(60, 25)).toBe(240);
    expect(cardPrice(1000, 50)).toBe(9000);
    expect(cardPrice(120, 1)).toBeGreaterThan(cardPrice(120, 0));
  });
  it("pays 90% of what the returned copy cost, so a round trip always loses", () => {
    expect(cardSellPrice(1000, 1)).toBe(900);
    for (const held of [1, 5, 40]) expect(cardSellPrice(250, held)).toBeLessThan(cardPrice(250, held - 1));
    expect(cardSellPrice(250, 0)).toBe(0);
  });
});
