#!/usr/bin/env node
// One command per game machine: creates its API token (every scope the LEGACY-X plugins use) and
// writes the one CounterStrikeSharp .env that all its CS2 servers share. Each server tells itself
// apart by its port (-port 27016): id srv-27016, address <host>:27016, and the mode and name given
// here for that port. Upload the file as game/csgo/addons/counterstrikesharp/.env; nothing else to fill in.
//
//   node --env-file=.env scripts/create-game-server.mjs <host> <port>[:mode[:name]] [<port>[:mode[:name]] …] [--prefix <id-prefix>]
//   node --env-file=.env scripts/create-game-server.mjs 203.0.113.5 "27015:competitive_5v5:LEGACY-X #1" "27016:fun:Fun #1" 27017:proleague
//
// mode: competitive_5v5 (5x5 page, default), fun, proleague. A server on a port not listed still
// works (5x5, its hostname). Running it again for the same host replaces the token; upload the new
// file. --prefix is only for a second machine, so its ports don't collide with the first one's ids.
// Only the token's SHA-256 is stored.

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const SCOPES = ["admin:read", "bans:read", "bans:write", "stats:write", "matches:write", "servers:write", "skinchanger:read", "skinchanger:write"];
const MODES = ["competitive_5v5", "fun", "proleague"];
const usage = () => {
  console.error('Usage: node --env-file=.env scripts/create-game-server.mjs <host> <port>[:mode[:name]] [...] [--prefix <id-prefix>]');
  console.error('  e.g. 203.0.113.5 "27015:competitive_5v5:LEGACY-X #1" "27016:fun:Fun #1"   (modes: competitive_5v5, fun, proleague)');
  process.exit(1);
};

const args = process.argv.slice(2);
let prefix = "srv";
const prefixAt = args.indexOf("--prefix");
if (prefixAt !== -1) {
  prefix = args[prefixAt + 1] ?? "";
  args.splice(prefixAt, 2);
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(prefix)) usage();
}
const [host, ...portArgs] = args;
if (!host || !/^[A-Za-z0-9.-]{1,100}$/.test(host) || portArgs.length === 0) usage();

const servers = portArgs.map((arg) => {
  const [port, mode = "competitive_5v5", ...nameParts] = arg.split(":");
  const name = nameParts.join(":").trim();
  const known = MODES.some((m) => mode === m || mode.startsWith(`${m}_`) || mode.startsWith(`${m}-`));
  if (!/^\d{2,5}$/.test(port) || Number(port) > 65535 || !known || name.length > 100 || /[\r\n]/.test(name)) usage();
  return { port: Number(port), mode, name };
});
if (new Set(servers.map((s) => s.port)).size !== servers.length) usage();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=.env).");
  process.exit(1);
}
const apiBase = (process.env.PUBLIC_API_ORIGIN?.trim() || "https://api.legacyx.cc").replace(/\/$/, "");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "legacy_x" } });
const tokenName = `game-${prefix}-${host}`.slice(0, 64);

// A new token per run; the previous one for this machine stops working.
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

const perServer = servers
  .map(({ port, mode, name }) => [`LEGACYX_${port}_SERVER_MODE=${mode}`, name ? `LEGACYX_${port}_SERVER_NAME=${name}` : null].filter(Boolean).join("\n"))
  .join("\n");

const env = `# LEGACY-X CounterStrikeSharp environment for ${host}, made by scripts/create-game-server.mjs.
# Shared by every CS2 server on this machine; each one is told apart by its port.
# Upload as game/csgo/addons/counterstrikesharp/.env. Contains a secret: never share or commit it.

LEGACYX_API_BASE_URL=${apiBase}
LEGACYX_SERVER_HOST=${host}
LEGACYX_SERVER_ID_PREFIX=${prefix}
LEGACYX_SERVER_MODE=competitive_5v5

# Per server (by port). Server id: ${prefix}-<port>, address: ${host}:<port>.
${perServer}

# One token for every module and every server here (scopes: ${SCOPES.join(" ")}).
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
LEGACYX_SPECTATOR_COMMS_ENABLED=true
LEGACYX_SKINBRIDGE_ENABLED=true
LEGACYX_STATUS_ENABLED=true
`;

const file = `legacyx-${prefix}-${host}.env`;
writeFileSync(file, env, { mode: 0o600 });
console.log(`Ready: ${servers.map((s) => `${prefix}-${s.port} (${s.mode}${s.name ? `, ${s.name}` : ""})`).join(", ")}.`);
console.log(`The shared environment is in ./${file} (keep it private).`);
console.log("\nOn the game machine:");
console.log("  1. Unzip legacyx-cs2.zip into game/csgo/");
console.log(`  2. Upload ${file} as game/csgo/addons/counterstrikesharp/.env`);
console.log("  3. Restart the servers (each started with its own -port). They appear on the Play page within 30 seconds.");
