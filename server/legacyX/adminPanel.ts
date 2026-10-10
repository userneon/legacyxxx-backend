import { z } from "zod";

/**
 * What the in-game admin panel (LegacyX-Hud's !admin) reads: bans with who lifted them, the latest logins and the
 * staff list. Everything comes from tables that already exist; nothing here writes. Lifting a ban goes through
 * /plugin/bans/revoke like LegacyX-Admin's own !unban.
 */

export const ADMIN_PANEL_PAGE = 8;

export const adminBansQuery = z.object({
  filter: z.enum(["active", "lifted", "expired", "mine"]).default("active"),
  /** The staff member looking: "mine" means the bans they issued. */
  steam_id: z.string().regex(/^7656119\d{10}$/),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const adminLoginsQuery = z.object({
  server_id: z.string().trim().min(1).max(64).optional(),
  online: z.enum(["1"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type BanState = "active" | "lifted" | "expired";

/** A ban is lifted when someone revoked it, expired when its time ran out, active otherwise. */
export function banState(row: { revoked_at?: string | null; is_permanent?: boolean | null; expires_at?: string | null }, now = new Date()): BanState {
  if (row.revoked_at) return "lifted";
  if (!row.is_permanent && row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return "expired";
  return "active";
}

/** Where a ban was issued from, as the panel words it (the bans table records only panel or game). */
export function banSource(source: string | null | undefined): string {
  return source === "game" ? "In-game" : source === "panel" ? "Website" : "Unknown";
}

type BanRow = Record<string, any>;

export function adminBanItem(row: BanRow, names: Map<string, string>, now = new Date()) {
  const state = banState(row, now);
  return {
    id: String(row.id),
    steamId: String(row.steam_id),
    player: names.get(String(row.user_id ?? "")) ?? `Steam ${row.steam_id}`,
    reason: String(row.reason ?? ""),
    permanent: Boolean(row.is_permanent),
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    issuedBy: names.get(String(row.issued_by ?? "")) ?? null,
    via: banSource(row.source),
    state,
    liftedBy: row.revoked_at ? (names.get(String(row.revoked_by ?? "")) ?? "Unknown") : null,
    liftedAt: row.revoked_at ?? null,
    liftReason: row.revoke_reason ?? null,
  };
}

/** A session still counts as online while the server keeps refreshing it (the same 10 minutes the equip check uses). */
export function loginOnline(row: { disconnected_at?: string | null; updated_at?: string | null }, now = new Date()): boolean {
  if (row.disconnected_at) return false;
  const seen = row.updated_at ? Date.parse(row.updated_at) : NaN;
  return Number.isFinite(seen) && now.getTime() - seen <= 10 * 60_000;
}

export function adminLoginItem(row: Record<string, any>, serverNames: Map<string, string>, now = new Date()) {
  return {
    steamId: String(row.steam_id),
    player: String(row.player_name ?? "") || `Steam ${row.steam_id}`,
    serverId: String(row.server_id),
    server: serverNames.get(String(row.server_id)) ?? String(row.server_id),
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at ?? null,
    online: loginOnline(row, now),
  };
}
