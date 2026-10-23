import type { SupabaseClient } from "@supabase/supabase-js";

import { cachedFor, forgetCached } from "./responseCache";

/**
 * Numbers an Owner can change from the staff site instead of the code (owner request 2026-10-23). Each one has a default (what the
 * code used before), a safe range and a short explanation; a stored value outside the range is ignored. The ranking spec (EXP, caps)
 * is deliberately not here: it is one coherent formula (docs/design/RANK-SYSTEM.md) and changes with a code review.
 */
export interface SettingDef {
  key: string;
  group: "Play" | "Checks" | "Creators" | "Chat";
  label: string;
  hint: string;
  unit: string;
  def: number;
  min: number;
  max: number;
}

export const SETTINGS = [
  { key: "play.leave_window_hours", group: "Play", label: "Leave counting window", hint: "Leaves of ranked matches are counted over this many hours.", unit: "hours", def: 24, min: 1, max: 168 },
  { key: "play.leave_block_from", group: "Play", label: "Block from the Nth leave", hint: "Earlier leaves only cost EXP; this one and later ones also block playing.", unit: "leaves", def: 3, min: 1, max: 20 },
  { key: "play.leave_block_step_minutes", group: "Play", label: "Block length per leave", hint: "The block starts at this many minutes and grows by it with every further leave.", unit: "minutes", def: 30, min: 1, max: 1440 },
  { key: "checks.code_minutes", group: "Checks", label: "Check code lifetime", hint: "How long the one-time code works after staff ask for a check.", unit: "minutes", def: 60, min: 5, max: 1440 },
  { key: "checks.retention_days", group: "Checks", label: "Keep checks for", hint: "Finished checks and their results are removed after this long.", unit: "days", def: 30, min: 1, max: 365 },
  { key: "checks.max_downloads", group: "Checks", label: "Downloads per check", hint: "How many times one code may download the checker.", unit: "times", def: 3, min: 1, max: 20 },
  { key: "chat.cooldown_seconds", group: "Chat", label: "Seconds between messages", hint: "A player may write one public chat message per this many seconds. 0 turns the wait off.", unit: "seconds", def: 3, min: 0, max: 60 },
  { key: "chat.keep_hours", group: "Chat", label: "Keep chat messages for", hint: "Older public chat messages are removed. 0 keeps them for ever. The default is 30 days.", unit: "hours", def: 720, min: 0, max: 8760 },
  { key: "creators.reapply_days", group: "Creators", label: "Apply again after a decline", hint: "A player whose creator application was declined may ask again after this long.", unit: "days", def: 7, min: 0, max: 365 },
] as const satisfies readonly SettingDef[];

export type SettingKey = (typeof SETTINGS)[number]["key"];
export type SettingValues = Record<SettingKey, number>;

export const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS.map((setting) => [setting.key, setting.def])) as SettingValues;

export const settingDef = (key: string): SettingDef | undefined => SETTINGS.find((setting) => setting.key === key);

/** A whole number inside the setting's range, or null. */
export function validSettingValue(def: SettingDef, value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= def.min && number <= def.max ? number : null;
}

/** The defaults with the stored rows on top; a row for an unknown key, or a value outside its range, is ignored. */
export function mergeSettings(rows: ReadonlyArray<{ key: string; value: unknown }>): SettingValues {
  const merged: SettingValues = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const def = settingDef(row.key);
    const value = def ? validSettingValue(def, row.value) : null;
    if (def && value !== null) merged[def.key as SettingKey] = value;
  }
  return merged;
}

const CACHE_KEY = "site-settings";
const CACHE_MS = 30_000;

type Db = SupabaseClient<any, any, any, any, any>;

/** The current settings (kept for 30 seconds). If the table cannot be read the defaults apply, so a missing SQL file never breaks the site. */
export async function loadSettings(db: Db): Promise<SettingValues> {
  return cachedFor(CACHE_KEY, CACHE_MS, async () => {
    const { data, error } = await db.from("site_settings").select("key,value");
    if (error) {
      console.warn("[legacy-x-api] site settings not read, using the defaults", error.message);
      return { ...DEFAULT_SETTINGS };
    }
    return mergeSettings((data ?? []) as Array<{ key: string; value: unknown }>);
  });
}

/** Forget the kept settings so a change shows at once. */
export const forgetSettings = () => forgetCached(CACHE_KEY);

