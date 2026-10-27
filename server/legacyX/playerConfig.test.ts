import { describe, expect, it } from "vitest";
import { cleanPlayerConfig, playerConfigSchema } from "./playerConfig";

describe("player config", () => {
  it("keeps what was typed and drops empty groups", () => {
    expect(cleanPlayerConfig({ crosshair: "CSGO-aB3dE-fG4hI-jK5lM-nO6pQ-rS7tU", mouse: { model: " Viper ", dpi: 800, sensitivity: 1.2 }, keyboard: { model: "" } })).toEqual({ crosshair: "CSGO-aB3dE-fG4hI-jK5lM-nO6pQ-rS7tU", mouse: { model: "Viper", dpi: 800, sensitivity: 1.2 } });
  });
  it("clears everything with an empty object", () => {
    expect(cleanPlayerConfig({})).toBeNull();
    expect(cleanPlayerConfig({ crosshair: "", mouse: {} })).toBeNull();
  });
  it("refuses a bad share code, out-of-range numbers and unknown fields", () => {
    expect(playerConfigSchema.safeParse({ crosshair: "https://evil.example" }).success).toBe(false);
    expect(playerConfigSchema.safeParse({ mouse: { dpi: 5 } }).success).toBe(false);
    expect(playerConfigSchema.safeParse({ viewmodel: { fov: 90 } }).success).toBe(false);
    expect(playerConfigSchema.safeParse({ script: "<b>x</b>" }).success).toBe(false);
    expect(playerConfigSchema.safeParse({ other: Array.from({ length: 11 }, () => ({ label: "a", value: "b" })) }).success).toBe(false);
  });
});
