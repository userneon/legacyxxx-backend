#!/usr/bin/env node
// Create a plugin/bot API token. Only its SHA-256 hash is stored (legacy_x.api_tokens); the raw
// token is printed once here, so run this on the VPS and paste it straight into the tool's .env.
//
//   node --env-file=.env scripts/create-api-token.mjs <name> <scope> [scope...]
//   node --env-file=.env scripts/create-api-token.mjs legacyx-discord-bot bans:write
//   node --env-file=.env scripts/create-api-token.mjs legacyx-admin admin:read bans:read

import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

// Every scope a plugin route checks (grep pluginRoute in server/legacyX/routes.ts).
const SCOPES = [
  "admin:read", "bans:read", "bans:write", "community:write", "maps:write", "matches:write",
  "servers:write", "skinchanger:read", "stats:write",
];

const [name, ...scopes] = process.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(name) || scopes.length === 0) {
  console.error("Usage: node --env-file=.env scripts/create-api-token.mjs <name> <scope> [scope...]");
  console.error(`Scopes: ${SCOPES.join(", ")}`);
  process.exit(1);
}
const unknown = scopes.filter((scope) => !SCOPES.includes(scope));
if (unknown.length) {
  console.error(`Unknown scope: ${unknown.join(", ")}. Known: ${SCOPES.join(", ")}`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run with --env-file=.env).");
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, db: { schema: "legacy_x" } });
const { error } = await db.from("api_tokens").insert({ name, token_hash: createHash("sha256").update(token).digest("hex"), scopes: [...new Set(scopes)], is_active: true });
if (error) {
  console.error(`Could not create the token: ${error.message}`);
  process.exit(1);
}

console.log(`Created token "${name}" with ${scopes.join(", ")}.`);
console.log("Copy it now; it is not stored anywhere and cannot be shown again:\n");
console.log(token);
