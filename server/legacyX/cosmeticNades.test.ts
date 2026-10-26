import { describe, expect, it } from "vitest";
import { itemsByNade, slotOverrides } from "./cosmeticNades";

describe("grenade slots", () => {
  it("follows the default until a grenade has its own slot", () => {
    const rows = [{ nade: "he", kind: "grenade_trail", item_id: "trail-comet" }, { nade: "flash", kind: "grenade_trail", item_id: null }, { nade: "smoke", kind: "grenade_light", item_id: "light-glow" }];
    expect(itemsByNade("grenade_trail", "trail-line", rows)).toEqual({ he: "trail-comet", flash: null, smoke: "trail-line", fire: "trail-line", decoy: "trail-line" });
    expect(itemsByNade("grenade_light", null, rows)).toEqual({ he: null, flash: null, smoke: "light-glow", fire: null, decoy: null });
  });
  it("ignores slots it does not know", () => {
    const rows = [{ nade: "bomb", kind: "grenade_trail", item_id: "x" }, { nade: "he", kind: "flash_effect", item_id: "y" }];
    expect(itemsByNade("grenade_trail", "trail-line", rows).he).toBe("trail-line");
    expect(slotOverrides(rows)).toEqual({});
  });
  it("lists only what differs, nothing meaning off", () => {
    expect(slotOverrides([{ nade: "fire", kind: "grenade_trail", item_id: null }, { nade: "fire", kind: "grenade_light", item_id: "light-glow" }])).toEqual({ fire: { grenade_trail: null, grenade_light: "light-glow" } });
  });
});
