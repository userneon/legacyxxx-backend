import { describe, expect, it } from "vitest";

import { frameLookSchema, readFrameLook } from "./frameLook";

describe("Crystal Orb look", () => {
  it("accepts a partial look and lower-cases the colour", () => {
    expect(frameLookSchema.parse({ preset: "frost", color: "#5CFFC8", strands: 6 })).toEqual({ preset: "frost", color: "#5cffc8", strands: 6 });
  });
  it("refuses unknown fields and values out of range", () => {
    expect(frameLookSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(frameLookSchema.safeParse({ glow: 2 }).success).toBe(false);
    expect(frameLookSchema.safeParse({ particleCount: 8001 }).success).toBe(false);
    expect(frameLookSchema.safeParse({ color: "red" }).success).toBe(false);
    expect(frameLookSchema.safeParse({ preset: "lava" }).success).toBe(false);
  });
  it("drops a stored look that no longer fits", () => {
    expect(readFrameLook({ glow: 5 })).toBeNull();
    expect(readFrameLook({})).toBeNull();
    expect(readFrameLook({ glow: 0.5 })).toEqual({ glow: 0.5 });
    expect(readFrameLook({ particleCount: 15000 })).toEqual({ particleCount: 8000 });
  });
});
