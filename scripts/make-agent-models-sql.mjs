// Makes the SQL that puts the agent models in the Shop (owner request 2026-11-08), from a list of the agent models' game paths, one per line:
//
//   agents/models/bluesen/default_agents/ctm_diver/ctm_diver_varianta.vmdl
//
// The side comes from the folder or file name (ctm_* is the CT side, tm_* the T side) and the item name from the file name ("ctm_diver_varianta" -> "CT Diver A").
// A line with neither marker is refused. Every item is added switched OFF with the same default price: change names, prices and the on/off in Staff -> Shop -> Cosmetics.
//
//   Windows (in legacyxxx-workshop):  Get-ChildItem compiled\agents -Recurse -Filter *.vmdl_c | % { $_.FullName.Substring((Resolve-Path compiled).Path.Length+1).Replace('\','/') -replace '_c$','' } > agents.txt
//   node scripts/make-agent-models-sql.mjs agents.txt [price] > supabase/legacy_x_agent_models_items.sql
import { readFileSync } from "node:fs";

const file = process.argv[2];
const price = Number(process.argv[3] ?? 8000);
if (!file || !Number.isInteger(price) || price < 1) { console.error("Usage: node scripts/make-agent-models-sql.mjs <agents.txt> [30-day price in LX]"); process.exit(1); }

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const token = (text, side) => text === side || text.startsWith(`${side}_`) || text.endsWith(`_${side}`) || text.includes(`_${side}_`);

export function agentSide(path) {
  const parts = path.toLowerCase().split("/");
  const name = parts.pop().replace(/\.vmdl$/, "");
  for (const text of [name, ...parts.reverse()]) {
    if (token(text, "ctm")) return "ct";
    if (token(text, "tm")) return "t";
  }
  return null;
}

/** "ctm_diver_varianta" -> "CT Diver A"; "tm_professional_varf5" -> "T Professional F5"; "ctm_fbi" -> "CT Fbi". */
export function agentName(path) {
  const file = path.split("/").pop().replace(/\.vmdl$/, "");
  const side = file.startsWith("ctm") ? "CT" : file.startsWith("tm") ? "T" : agentSide(path) === "ct" ? "CT" : "T";
  const words = file.replace(/^ctm_?|^tm_?/, "").split("_").filter(Boolean).map((word) => {
    const variant = /^variant([a-z0-9]+)$/.exec(word) ?? /^var([a-z0-9]+)$/.exec(word);
    if (variant) return variant[1].toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
  return `${side} ${words.join(" ")}`.trim();
}

export function agentId(path) {
  const base = path.split("/").pop().replace(/\.vmdl$/, "").replace(/_/g, "-");
  return `agent-${base}`.slice(0, 40).replace(/-+$/, "");
}

export function buildSql(lines) {
  const items = [];
  const links = [];
  const problems = [];
  const seen = new Set();
  let sort = 600;
  lines.forEach((raw, index) => {
    const path = raw.trim();
    if (!path || path.startsWith("#")) return;
    const where = `line ${index + 1}`;
    if (!/^[a-z0-9_/.\-]{4,200}\.vmdl$/.test(path)) return problems.push(`${where}: "${path}" must be lower-case, end in .vmdl (not .vmdl_c) and use /`);
    const side = agentSide(path);
    if (!side) return problems.push(`${where}: no ctm or tm in "${path}": the side cannot be told`);
    const id = agentId(path);
    if (seen.has(id)) return problems.push(`${where}: the id ${id} is used twice`);
    seen.add(id);
    const name = agentName(path).slice(0, 40);
    items.push(`  (${quote(id)}, ${quote(`model_agent_${side}`)}, ${quote(name)}, ${quote(name)}, 'coin', ${price}, '', ${sort++}, 3, false, false)`);
    links.push(`  (${quote(id)}, ${quote(`agent_${side}`)}, ${quote(path)}, ${quote(path)}, NULL)`);
  });
  return { items, links, problems };
}

if (process.argv[1] && process.argv[1].endsWith("make-agent-models-sql.mjs")) {
  const { items, links, problems } = buildSql(readFileSync(file, "utf8").split(/\r?\n/));
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  if (!items.length) { console.error("No agent lines found."); process.exit(1); }
  console.log(`-- Made by scripts/make-agent-models-sql.mjs (${items.length} agent model(s), ${price} LX for 30 days). Every item is OFF until it has been checked in game.
-- Run supabase/legacy_x_agent_models.sql first. Safe to re-run: an agent already there keeps the price and on/off staff set, and its path is updated.
BEGIN;
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
${items.join(",\n")}
ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn;
INSERT INTO legacy_x.weapon_models (item_id, weapon, world_model, view_model, anim_base) VALUES
${links.join(",\n")}
ON CONFLICT (item_id) DO UPDATE SET weapon = EXCLUDED.weapon, world_model = EXCLUDED.world_model, view_model = EXCLUDED.view_model, anim_base = EXCLUDED.anim_base;
COMMIT;`);
}
