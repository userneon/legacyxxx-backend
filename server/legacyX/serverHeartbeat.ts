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
