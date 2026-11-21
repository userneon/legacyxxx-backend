import { describe, expect, it } from "vitest";
import { CUSTOM_CHANGE_PRICE, isSmokeMotif, pickPrice, vividColour } from "./cosmeticPick";

describe("vivid colours", () => {
  it("keeps a strong colour as it is", () => {
    expect(vividColour("#ff0000")).toBe("#ff0000");
    expect(vividColour("#00ccff")).toBe("#00ccff");
  });
  it("lifts a pale or dark pick to a vivid one of the same hue", () => {
    expect(vividColour("#ffd0d0")).toBe("#ff6666");
    expect(vividColour("#101040")).toBe("#3636d9");
  });
  it("gives a grey a vivid colour too", () => {
    expect(vividColour("#808080")).toBe("#d95757");
  });
  it("leaves something that is not a colour alone", () => {
    expect(vividColour("red")).toBe("red");
  });
});

describe("what a pick costs", () => {
  const pick = { color: "#ff0000", color2: null, fx: "star" };
  it("is free the first time", () => expect(pickPrice(null, pick)).toBe(0));
  it("is free when nothing changed", () => expect(pickPrice(pick, { ...pick })).toBe(0));
  it("costs 500 for a new colour", () => {
    expect(CUSTOM_CHANGE_PRICE).toBe(500);
    expect(pickPrice(pick, { ...pick, color: "#00ff00" })).toBe(500);
    expect(pickPrice(pick, { ...pick, color2: "#0000ff" })).toBe(500);
  });
  it("costs 500 for a new effect", () => expect(pickPrice(pick, { ...pick, fx: "heart" })).toBe(500));
  it("costs 500 for each: a colour and an effect together are 1000", () => expect(pickPrice(pick, { color: "#00ff00", color2: null, fx: "heart" })).toBe(1000));
});

describe("smoke shapes", () => {
  it("knows only its own", () => {
    expect(isSmokeMotif("heart")).toBe(true);
    expect(isSmokeMotif("skull")).toBe(false);
  });
});
