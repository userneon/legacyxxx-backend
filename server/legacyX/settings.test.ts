import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS, mergeSettings, settingDef, validSettingValue } from "./settings";

describe("site settings", () => {
  it("keeps every default inside its own range", () => {
    for (const setting of SETTINGS) expect(setting.def >= setting.min && setting.def <= setting.max).toBe(true);
    expect(new Set(SETTINGS.map((setting) => setting.key)).size).toBe(SETTINGS.length);
  });

  it("accepts whole numbers inside the range only", () => {
    const def = settingDef("checks.code_minutes")!;
    expect(validSettingValue(def, 90)).toBe(90);
    expect(validSettingValue(def, "90")).toBe(90);
    expect(validSettingValue(def, 4)).toBeNull();
    expect(validSettingValue(def, 1441)).toBeNull();
    expect(validSettingValue(def, 60.5)).toBeNull();
    expect(validSettingValue(def, "")).toBeNull();
    expect(validSettingValue(def, null)).toBeNull();
  });

  it("puts stored rows over the defaults and ignores bad ones", () => {
    const merged = mergeSettings([
      { key: "creators.reapply_days", value: 14 },
      { key: "checks.retention_days", value: 9999 },
      { key: "nope.unknown", value: 5 },
    ]);
    expect(merged["creators.reapply_days"]).toBe(14);
    expect(merged["checks.retention_days"]).toBe(DEFAULT_SETTINGS["checks.retention_days"]);
    expect(Object.keys(merged)).toEqual(SETTINGS.map((setting) => setting.key));
  });
});
