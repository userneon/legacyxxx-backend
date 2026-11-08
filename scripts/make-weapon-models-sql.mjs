// Makes the SQL that puts the custom weapon models in the Shop, from legacyxxx-workshop/compiled/MODELS.txt (one line per model):
//
//   id | English name | Mongolian name | 30-day price in LX | replaces | world model | view model | anim base | notes
//   katana-1 | Katana One | Катана 1 | 12000 | knife | models/weapons/legacyx/katana_01/katana_01.vmdl | models/weapons/legacyx/katana_01/katana_01_v.vmdl | m9 | uses the M9 animations
//
// "replaces" is knife, deagle or ak47. "anim base" is m9, bayonet, stiletto or default (the plain knife) for a knife and empty for the others. The paths are the game's names (.vmdl, not .vmdl_c).
// Every item is added switched OFF: check each in game, then switch it on in Staff -> Shop -> Cosmetics.
//
//   node scripts/make-weapon-models-sql.mjs ../legacyxxx-workshop/compiled/MODELS.txt > supabase/legacy_x_weapon_models_items.sql
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/make-weapon-models-sql.mjs <MODELS.txt>"); process.exit(1); }

const WEAPONS = { knife: "model_knife", deagle: "model_deagle", ak47: "model_ak47" };
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const items = [];
const links = [];
const problems = [];
let sort = 400;

readFileSync(file, "utf8").split(/\r?\n/).forEach((raw, index) => {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return;
  const [id, nameEn, nameMn, price, weapon, world, view, animBase = ""] = line.split("|").map((part) => part.trim());
  const where = `line ${index + 1}`;
  if (!/^[a-z0-9-]{2,40}$/.test(id ?? "")) return problems.push(`${where}: the id must be lower-case letters, digits and - (2 to 40)`);
  if (!nameEn || nameEn.length < 2 || nameEn.length > 40 || !nameMn || nameMn.length < 2 || nameMn.length > 40) return problems.push(`${where}: both names are 2 to 40 characters`);
  if (!/^\d+$/.test(price ?? "") || Number(price) < 1) return problems.push(`${where}: the price is a whole number of LX`);
  if (!(weapon in WEAPONS)) return problems.push(`${where}: "replaces" is knife, deagle or ak47`);
  for (const [label, path] of [["world model", world], ["view model", view]]) {
    if (!/^[a-z0-9_/.\-]{4,200}\.vmdl$/.test(path ?? "")) return problems.push(`${where}: the ${label} path must be lower-case, end in .vmdl (not .vmdl_c) and use /`);
  }
  if (weapon === "knife" ? !["m9", "bayonet", "stiletto", "default"].includes(animBase) : animBase !== "") return problems.push(`${where}: the anim base is m9, bayonet, stiletto or default for a knife and empty for the others`);
  items.push(`  (${quote(id)}, ${quote(WEAPONS[weapon])}, ${quote(nameEn)}, ${quote(nameMn)}, 'coin', ${Number(price)}, '', ${sort++}, 3, false, false)`);
  links.push(`  (${quote(id)}, ${quote(weapon)}, ${quote(world)}, ${quote(view)}, ${animBase ? quote(animBase) : "NULL"})`);
});

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
if (!items.length) { console.error("No model lines found."); process.exit(1); }
console.log(`-- Made by scripts/make-weapon-models-sql.mjs from MODELS.txt (${items.length} model(s)). Every item is OFF until it has been checked in game.
-- Run supabase/legacy_x_weapon_models.sql first. Safe to re-run: a model already there keeps the price and on/off staff set, and its paths are updated.
BEGIN;
INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, rarity, featured, enabled) VALUES
${items.join(",\n")}
ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, name_en = EXCLUDED.name_en, name_mn = EXCLUDED.name_mn;
INSERT INTO legacy_x.weapon_models (item_id, weapon, world_model, view_model, anim_base) VALUES
${links.join(",\n")}
ON CONFLICT (item_id) DO UPDATE SET weapon = EXCLUDED.weapon, world_model = EXCLUDED.world_model, view_model = EXCLUDED.view_model, anim_base = EXCLUDED.anim_base;
COMMIT;`);
