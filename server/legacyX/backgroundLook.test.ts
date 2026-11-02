import { describe, expect, it } from "vitest";

import { backgroundLookSchema, isBackgroundItem, readBackgroundLook } from "./backgroundLook";

describe("profile background look", () => {
  it("accepts numbers, switches, colours and colour lists", () => {
    expect(backgroundLookSchema.safeParse({ speed: 1.5, intro: false, color: "#8b5cf6", colorStops: ["#111111", "#8b5cf6"], direction: "top" }).success).toBe(true);
  });
  it("refuses odd keys, bad colour lists and oversize values", () => {
    expect(backgroundLookSchema.safeParse({ "bad key": 1 }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ colors: ["red"] }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ speed: 1e9 }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ note: "x".repeat(41) }).success).toBe(false);
  });
  it("reads a stored look or drops it", () => {
    expect(readBackgroundLook({ speed: 2 })).toEqual({ speed: 2 });
    expect(readBackgroundLook({})).toBeNull();
    expect(readBackgroundLook("x")).toBeNull();
  });
  it("names background items", () => {
    expect(isBackgroundItem("bg-aurora")).toBe(true);
    expect(isBackgroundItem("crystal-orb")).toBe(false);
  });
});
