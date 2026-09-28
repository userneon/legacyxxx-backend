#!/usr/bin/env node
// One command per CS2 server: creates the server's API token (every scope the LEGACY-X plugins use)
// and writes the complete CounterStrikeSharp .env for it. Upload that file as
// game/csgo/addons/counterstrikesharp/.env next to the plugin package; nothing else to fill in.
//
//   node --env-file=.env scripts/create-game-server.mjs <server-id> <host:port> [mode] [name…]
//   node --env-file=.env scripts/create-game-server.mjs srv-1 203.0.113.5:27015 competitive_5v5 "LEGACY-X #1"
//
// mode: competitive_5v5 (5x5 page, default), fun, proleague. Running it again for the same server
// replaces its token (the old one stops working). Only the token's SHA-256 is stored.

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const SCOPES = ["admin:read", "bans:read", "bans:write", "stats:write", "matches:write", "servers:write", "skinchanger:read"];
const MODES = ["competitive_5v5", "fun", "proleague"];

const [serverId, address, mode = "competitive_5v5", ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ").trim();
if (!serverId || !/^[A-Za-z0-9._-]{1,48}$/.test(serverId) || !address || !/^[A-Za-z0-9.-]+:\d{2,5}$/.test(address) || !MODES.some((m) => mode === m || mode.startsWith(`${m}_`) || mode.startsWith(`${m}-`))) {
  console.error("Usage: node --env-file=.env scripts/create-game-server.mjs <server-id> <host:port> [competitive_5v5|fun|proleague] [name…]");
  console.error("  server-id: letters, digits, . _ - (e.g. srv-1)   host:port: what players connect to");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=.env).");
  process.exit(1);
}
const apiBase = (process.env.PUBLIC_API_ORIGIN?.trim() || "https://api.legacyx.cc").replace(/\/$/, "");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "legacy_x" } });
const tokenName = `game-${serverId}`;

// A new token per run; the previous one for this server stops working.
const { error: retireError } = await db.from("api_tokens").update({ is_active: false }).eq("name", tokenName).eq("is_active", true);
if (retireError) {
  console.error(`Could not retire the old token: ${retireError.message}`);
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
const { error } = await db.from("api_tokens").insert({ name: tokenName, token_hash: createHash("sha256").update(token).digest("hex"), scopes: SCOPES, is_active: true });
if (error) {
  console.error(`Could not create the token: ${error.message}`);
  process.exit(1);
}

const env = `# LEGACY-X CounterStrikeSharp environment for ${serverId}, made by scripts/create-game-server.mjs.
# Upload as game/csgo/addons/counterstrikesharp/.env. Contains a secret: never share or commit it.

LEGACYX_API_BASE_URL=${apiBase}
LEGACYX_SERVER_ID=${serverId}
LEGACYX_SERVER_ADDRESS=${address}
LEGACYX_SERVER_MODE=${mode}
LEGACYX_SERVER_NAME=${name}

# One token for every module (scopes: ${SCOPES.join(" ")}).
LEGACYX_PLUGIN_TOKEN=${token}
LEGACYX_ADMIN_PLUGIN_SECRET=${token}

LEGACYX_ADMIN_ENABLED=true
LEGACYX_ADMIN_CENTRAL_BANS_ENABLED=true
LEGACYX_ADMIN_CENTRAL_PENALTIES_ENABLED=true
LEGACYX_AFKMANAGER_ENABLED=true
LEGACYX_COMMUNITY_ENABLED=true
LEGACYX_KILLFEED_ENABLED=true
LEGACYX_MATCHZY_ENABLED=true
LEGACYX_MATCHZY_RANK_ENABLED=true
LEGACYX_MATCHZY_MATCH_CORE_ENABLED=true
LEGACYX_MATCHZY_MATCH_CORE_API_URL=${apiBase}/api/v1/plugin/match-core/events
LEGACYX_SPECTATOR_COMMS_ENABLED=true
LEGACYX_SKINBRIDGE_ENABLED=true
LEGACYX_STATUS_ENABLED=true
`;

const file = `${serverId}.env`;
writeFileSync(file, env, { mode: 0o600 });
console.log(`Server ${serverId} (${mode}) is ready. Its environment is in ./${file} (keep it private).`);
console.log("\nOn the game server:");
console.log("  1. Unzip legacyx-cs2.zip into game/csgo/");
console.log(`  2. Upload ${file} as game/csgo/addons/counterstrikesharp/.env`);
console.log("  3. Restart the server. It appears on the website's Play page within 30 seconds.");
