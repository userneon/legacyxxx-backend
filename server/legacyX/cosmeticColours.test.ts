import { describe, expect, it } from "vitest";
import { PICK_DEFAULT, PICK_DEFAULT_2, isColourable, itemColours } from "./cosmeticColours";

describe("colour it yourself", () => {
  it("lets the player colour bought designs but not fixed or earned ones", () => {
    expect(isColourable({ kind: "grenade_trail", unlock: "coin", fx: "helix" })).toBe(true);
    expect(isColourable({ kind: "grenade_trail", unlock: "coin", fx: "rainbow" })).toBe(false);
    expect(isColourable({ kind: "name_color", unlock: "achievement", fx: "void" })).toBe(false);
    expect(isColourable({ kind: "frame", unlock: "coin" })).toBe(false);
  });
  it("shows grey until a colour is picked, then the pick", () => {
    expect(itemColours({ kind: "smoke_color", unlock: "coin", color: "#123456" })).toEqual({ color: PICK_DEFAULT, color2: null, glow: null });
    expect(itemColours({ kind: "smoke_color", unlock: "coin", fx: "dual" })).toEqual({ color: PICK_DEFAULT, color2: PICK_DEFAULT_2, glow: null });
    expect(itemColours({ kind: "smoke_color", unlock: "coin", fx: "dual" }, { color: "#FF0000", color2: "#00ff00" })).toEqual({ color: "#ff0000", color2: "#00ff00", glow: null });
    expect(itemColours({ kind: "name_glow", unlock: "coin", fx: "neon" }, { color: "#8b5cf6" })).toEqual({ color: null, color2: null, glow: "#8b5cf6" });
    expect(itemColours({ kind: "grenade_trail", unlock: "coin", fx: "rainbow", color: "#ffffff" })).toMatchObject({ color: "#ffffff" });
  });
});
