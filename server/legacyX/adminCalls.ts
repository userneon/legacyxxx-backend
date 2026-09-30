import { z } from "zod";

/**
 * In-game !calladmin / !callmanager requests. LegacyX-Admin posts each one; the Discord bot polls them and
 * announces them in its calls channel, so a request still reaches the team when no admin is on the server.
 */

/** One caller can raise a request this often; the plugin has its own (longer) cooldown, this is the backstop. */
export const ADMIN_CALL_COOLDOWN_SECONDS = 60;
/** The bot never sees requests older than this, even if it was off for a while. */
export const ADMIN_CALL_MAX_AGE_HOURS = 24;
export const ADMIN_CALL_PAGE = 50;

export const adminCallSchema = z.object({
  callerSteamId: z.string().regex(/^7656119\d{10}$/, "callerSteamId must be a SteamID64"),
  callerName: z.string().trim().min(1).max(64),
  target: z.enum(["admin", "manager"]),
  serverId: z.string().trim().min(1).max(64),
  serverName: z.string().trim().max(96).optional(),
  map: z.string().trim().max(64).optional(),
  players: z.number().int().min(0).max(128).optional(),
  onlineStaff: z.number().int().min(0).max(128),
});

export type AdminCallInput = z.infer<typeof adminCallSchema>;

export function adminCallRow(input: AdminCallInput) {
  return {
    caller_steam_id: input.callerSteamId,
    caller_name: input.callerName,
    target: input.target,
    server_id: input.serverId,
    server_name: input.serverName || null,
    map: input.map || null,
    players: input.players ?? null,
    online_staff: input.onlineStaff,
  };
}

export interface AdminCallRecord {
  id: number;
  caller_steam_id: string;
  caller_name: string;
  target: "admin" | "manager";
  server_id: string;
  server_name: string | null;
  map: string | null;
  players: number | null;
  online_staff: number;
  created_at: string;
}

/** The shape the bot reads. */
export function adminCallView(record: AdminCallRecord) {
  return {
    id: Number(record.id),
    callerSteamId: record.caller_steam_id,
    callerName: record.caller_name,
    target: record.target,
    serverId: record.server_id,
    serverName: record.server_name,
    map: record.map,
    players: record.players,
    onlineStaff: record.online_staff,
    createdAt: record.created_at,
  };
}

/** `after` from the query string: a positive integer id, or null when the bot is only asking where the feed stands. */
export function parseAfter(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
