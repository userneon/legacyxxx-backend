/**
 * A grenade trail or light worn on one kind of grenade only (owner request 2026-10-26). Five slots: HE, flash, smoke, fire (the molotov and
 * the incendiary) and decoy. What a player wears for every grenade stays the default (cosmetic_equipped); a row in cosmetic_nade_slot
 * replaces it for one grenade, and a row with no item means "nothing on this grenade".
 */
export const NADES = ["he", "flash", "smoke", "fire", "decoy"] as const;
export type Nade = (typeof NADES)[number];
export const NADE_KINDS = ["grenade_trail", "grenade_light"] as const;
export type NadeKind = (typeof NADE_KINDS)[number];

export interface SlotRow {
  nade: string;
  kind: string;
  item_id: string | null;
}

export const isNade = (value: unknown): value is Nade => typeof value === "string" && (NADES as readonly string[]).includes(value);
export const isNadeKind = (value: unknown): value is NadeKind => typeof value === "string" && (NADE_KINDS as readonly string[]).includes(value);

/** The item each grenade wears: its own slot when it has one (null = nothing), else the default. */
export function itemsByNade(kind: NadeKind, defaultItem: string | null, rows: readonly SlotRow[]): Record<Nade, string | null> {
  const own = new Map(rows.filter((row) => row.kind === kind && isNade(row.nade)).map((row) => [row.nade, row.item_id]));
  return Object.fromEntries(NADES.map((nade) => [nade, own.has(nade) ? own.get(nade) ?? null : defaultItem])) as Record<Nade, string | null>;
}

/** The slots a player has set, for the Appearance page: only the grenades that differ from the default appear (null = nothing on it). */
export function slotOverrides(rows: readonly SlotRow[]): Partial<Record<Nade, Partial<Record<NadeKind, string | null>>>> {
  const out: Partial<Record<Nade, Partial<Record<NadeKind, string | null>>>> = {};
  for (const row of rows) {
    if (!isNade(row.nade) || !isNadeKind(row.kind)) continue;
    (out[row.nade] ??= {})[row.kind] = row.item_id;
  }
  return out;
}
