import { describe, expect, it } from "vitest";
import { customTopUpLx } from "./topup";
describe("custom top-up", () => {
  const base = { priceMnt: 5000, grantsLx: 750 };
  it("pays at the smallest package's rate", () => {
    expect(customTopUpLx(5000, base)).toBe(750);
    expect(customTopUpLx(12000, base)).toBe(1800);
  });
  it("refuses amounts out of range or off the step", () => {
    expect(customTopUpLx(500, base)).toBeNull();
    expect(customTopUpLx(1500, base)).toBeNull();
    expect(customTopUpLx(600_000, base)).toBeNull();
    expect(customTopUpLx(2000.5, base)).toBeNull();
  });
});
