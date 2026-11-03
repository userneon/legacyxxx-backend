import { describe, expect, it } from "vitest";
import { skinCraftInputSchema } from "./routes";

const id = "11111111-1111-4111-8111-111111111111";
describe("skinCraftInputSchema", () => {
  it("takes a skin with its options", () => {
    const parsed = skinCraftInputSchema.parse({ name: "  Clean AK  ", catalogItemId: id, options: { wear: 0.07, seed: 661, statTrak: true, nameTag: "ace", stickers: [{ catalogItemId: id, slot: 0 }], charm: { catalogItemId: id } } });
    expect(parsed.name).toBe("Clean AK");
    expect(parsed.options.seed).toBe(661);
  });
  it("needs a skin id and keeps the options inside their ranges", () => {
    expect(() => skinCraftInputSchema.parse({ options: {} })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { wear: 2 } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { seed: 1.5 } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { nameTag: "x".repeat(33) } })).toThrow();
  });
  it("refuses a sticker slot used twice, a sixth sticker and extra fields", () => {
    const sticker = (slot: number) => ({ catalogItemId: id, slot });
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { stickers: [sticker(1), sticker(1)] } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { stickers: [0, 1, 2, 3, 4, 0].map(sticker) } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: {}, extra: 1 })).toThrow();
  });
});

describe("skinCraftInputSchema StatTrak count", () => {
  it("takes a kill count inside its range", () => {
    expect(skinCraftInputSchema.parse({ catalogItemId: id, options: { statTrak: true, statTrakCount: 1337 } }).options.statTrakCount).toBe(1337);
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { statTrakCount: -1 } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { statTrakCount: 1_000_000 } })).toThrow();
    expect(() => skinCraftInputSchema.parse({ catalogItemId: id, options: { statTrakCount: 1.5 } })).toThrow();
  });
});
