import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { legacyXError } from "./supabase";

/**
 * Game server heartbeat (LegacyX-Status, every 30 seconds): who the server is, what it is playing
 * and who is on it. ingest_server_heartbeat() updates reconnect_servers (Play pages, home tiles,
 * Discord boards) and reconnect_sessions (who is playing where) in one transaction.
 */

type Db = SupabaseClient<any, any, any, any, any>;

export const heartbeatSchema = z.object({
  serverId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "LEGACYX_SERVER_ID is required"),
  name: z.string().trim().max(100).default(""),
  /** host:port players connect to. */
  address: z.string().trim().max(100).default(""),
  gotvAddress: z.string().trim().max(100).nullable().optional(),
  map: z.string().trim().max(64).default(""),
  /** LEGACYX_SERVER_MODE (competitive_5v5, fun, proleague…): picks the Play page. */
  mode: z.string().trim().max(40).default(""),
  maxPlayers: z.number().int().min(1).max(128),
  players: z
    .array(z.object({ steamId: z.string().regex(/^\d{15,20}$/), name: z.string().max(128).default("") }))
    .max(128)
    .default([]),
});

export async function ingestHeartbeat(db: Db, input: z.infer<typeof heartbeatSchema>) {
  const { data, error } = await db.rpc("ingest_server_heartbeat", {
    p_server: { server_id: input.serverId, name: input.name, address: input.address, gotv_address: input.gotvAddress ?? "", map: input.map, mode: input.mode, max_players: input.maxPlayers },
    p_players: input.players.map((player) => ({ steam_id: player.steamId, name: player.name })),
  });
  legacyXError(error, "Unable to record server heartbeat");
  return { players: typeof data === "number" ? data : input.players.length };
}

/** What the website calls a server of each mode until staff rename it ("Fun #2"). Other modes are named after the mode itself. */
const MODE_LABELS: Record<string, string> = { competitive_5v5: "5x5", fun: "Fun", proleague: "Pro League", tournaments: "Tournament" };
export function defaultServerName(mode: string, number: number): string {
  const label = MODE_LABELS[mode] ?? (mode ? mode.replace(/[_-]+/g, " ") : "LEGACY-X");
  return `${label} #${number}`.slice(0, 60);
}

/** A name safe to use as a hostname and to type into a game console: no control characters, quotes, semicolons or backslashes. */
export const serverNameSchema = z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f"';\\$`=]+$/, "Use letters, digits, spaces and - _ . # | only");

/**
 * The name the website gives this server (reconnect_servers.site_name), made on the first heartbeat when it has none. The game server
 * reads it from the heartbeat answer and sets its own hostname, so no name is written in a server's .env, cfg or service file.
 * Null when it cannot be read (the migration supabase/legacy_x_server_site_name.sql is not applied yet): the answer then has no name.
 */
export async function resolveServerName(db: Db, serverId: string, mode: string): Promise<string | null> {
  try {
    const read = async () => {
      const found = await db.from("reconnect_servers").select("site_name").eq("server_id", serverId).maybeSingle();
      if (found.error) return undefined;   // the column is missing or the table cannot be read
      const name = typeof found.data?.site_name === "string" ? found.data.site_name.trim() : "";
      return name || null;
    };
    const existing = await read();
    if (existing === undefined) return null;
    if (existing) return existing;
    const same = await db.from("reconnect_servers").select("server_id", { count: "exact", head: true }).eq("current_mode", mode).not("site_name", "is", null);
    if (same.error) return null;
    const name = defaultServerName(mode, (same.count ?? 0) + 1);
    // Only a row still without a name takes it, so two servers starting together cannot overwrite each other.
    const set = await db.from("reconnect_servers").update({ site_name: name, display_name: name }).eq("server_id", serverId).is("site_name", null).select("site_name");
    if (set.error) return null;
    return set.data?.length ? name : (await read()) ?? null;
  } catch {
    return null;
  }
}
