import { describe, expect, it } from "vitest";
import { cleanProfileLook, nameStyleOf, profileLookSchema, readProfileLook } from "./profileLook";

describe("profile look", () => {
  it("keeps a normal name with its colour and font", () => {
    const parsed = profileLookSchema.parse({ mode: "normal", font: "mono", color: "#FFAA00" });
    expect(cleanProfileLook(parsed)).toEqual({ ok: true, look: { mode: "normal", font: "mono", color: "#ffaa00", color2: null, glow: null } });
  });
  it("needs two colours for a gradient and a colour for a glow", () => {
    expect(cleanProfileLook(profileLookSchema.parse({ mode: "gradient", color: "#112233" })).ok).toBe(false);
    expect(cleanProfileLook(profileLookSchema.parse({ mode: "glow" })).ok).toBe(false);
    expect(cleanProfileLook(profileLookSchema.parse({ mode: "gradient", color: "#112233", color2: "#445566" })).ok).toBe(true);
    expect(cleanProfileLook(profileLookSchema.parse({ mode: "glow", glow: "#abcdef" })).ok).toBe(true);
  });
  it("drops what the chosen mode does not use", () => {
    const result = cleanProfileLook(profileLookSchema.parse({ mode: "normal", color: "#111111", color2: "#222222", glow: "#333333" }));
    expect(result.ok && result.look).toMatchObject({ color2: null, glow: null });
  });
  it("rejects unknown modes, fonts and bad colours", () => {
    expect(profileLookSchema.safeParse({ mode: "rainbow" }).success).toBe(false);
    expect(profileLookSchema.safeParse({ mode: "normal", font: "comic" }).success).toBe(false);
    expect(profileLookSchema.safeParse({ mode: "normal", color: "red" }).success).toBe(false);
    expect(profileLookSchema.safeParse({ mode: "normal", extra: 1 }).success).toBe(false);
  });
  it("says nothing for a plain default name and the styles otherwise", () => {
    expect(nameStyleOf({ mode: "normal", font: "default", color: null, color2: null, glow: null })).toBeNull();
    expect(nameStyleOf({ mode: "glow", font: "default", color: null, color2: null, glow: "#abcdef" })).toMatchObject({ glow: "#abcdef", mode: "glow" });
    expect(nameStyleOf({ mode: "gradient", font: "display", color: "#111111", color2: "#222222", glow: null })).toMatchObject({ color2: "#222222", colorFx: "gradient2" });
  });
  it("reads a stored row and ignores a broken one", () => {
    expect(readProfileLook({ name_mode: "glow", name_font: "display", name_color: null, name_color2: null, name_glow: "#ABCDEF" })).toMatchObject({ mode: "glow", glow: "#abcdef" });
    expect(readProfileLook({ name_mode: "x", name_font: "display" })).toBeNull();
    expect(readProfileLook(null)).toBeNull();
  });
});
