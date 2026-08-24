#!/usr/bin/env node
/**
 * LEGACY-X Skinchanger catalog ingest.
 *
 * Operator-only script: it reads public CS2 catalog metadata, converts source
 * item images to WebP, writes assets to API-owned storage, then upserts catalog
 * records into legacy_x.skinchanger_catalog_items. It is never invoked by the
 * browser or a CS2 plugin.
 *
 * Required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   BUILT_IN_FORGE_API_URL, BUILT_IN_FORGE_API_KEY
 *
 * Examples:
 *   node scripts/ingest-skinchanger-catalog.mjs --dry-run
 *   node scripts/ingest-skinchanger-catalog.mjs --category weapon_skin --limit 50
 */
import crypto from "node:crypto";
import process from "node:process";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const SOURCE_BASE = process.env.SKINCHANGER_CATALOG_SOURCE_BASE ?? "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const categories = ["weapon", "weapon_skin", "knife", "glove", "agent", "music_kit", "pin", "sticker", "charm"];
const firearmGroups = new Set(["Pistols", "SMGs", "Rifles", "Heavy"]);
const tOnlyFirearms = new Set(["AK-47", "Galil AR", "SG 553", "G3SG1", "Glock-18", "Tec-9", "MAC-10", "Sawed-Off"]);
const ctOnlyFirearms = new Set(["AUG", "FAMAS", "M4A1-S", "M4A4", "SCAR-20", "USP-S", "P2000", "Five-SeveN", "MP9", "MAG-7"]);
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, raw = "true"] = value.replace(/^--/, "").split("=", 2);
  return [key, raw];
}));
const requestedCategory = args.get("category") ?? null;
const limit = Math.max(0, Number.parseInt(args.get("limit") ?? "0", 10) || 0);
const skipImages = args.has("skip-images");
const dryRun = args.has("dry-run");
const concurrency = Math.max(1, Math.min(8, Number.parseInt(args.get("concurrency") ?? String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY));

if (requestedCategory && !categories.includes(requestedCategory)) {
  throw new Error(`Unsupported category '${requestedCategory}'. Expected one of: ${categories.join(", ")}`);
}

if (!dryRun) {
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"]) {
    if (!process.env[key]?.trim()) throw new Error(`Missing required environment variable: ${key}`);
  }
}

const supabase = dryRun
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "legacy_x" },
      auth: { persistSession: false, autoRefreshToken: false },
    });

const sourceEndpoints = [
  // `skins_not_grouped` preserves the exact item rows needed for weapon/knife/glove normalization.
  { category: "weapon_skin", path: "skins_not_grouped.json" },
  { category: "weapon", path: "base_weapons.json" },
  { category: "agent", path: "agents.json" },
  { category: "music_kit", path: "music_kits.json" },
  { category: "pin", path: "collectibles.json" },
  { category: "sticker", path: "stickers.json" },
  { category: "charm", path: "keychains.json" },
];

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function classify(raw, sourceCategory) {
  const name = text(raw.name).toLowerCase();
  const weaponName = text(raw.weapon?.name).toLowerCase();
  const type = text(raw.type).toLowerCase();
  const sourceGroup = text(raw.category?.name, text(raw.category, ""));
  if (sourceCategory === "weapon") {
    if (sourceGroup === "Knives") return "knife";
    return firearmGroups.has(sourceGroup) ? "weapon" : null;
  }
  if (sourceCategory === "weapon_skin") {
    if (/knife|bayonet|karambit|m9|butterfly|talon|stiletto|ursus|navaja|falchion|bowie|daggers|kukri/.test(weaponName)) return "knife";
    if (/glove|hand wrap|bloodhound|driver|moto|sport|specialist|hydra|broken fang/.test(weaponName)) return "glove";
  }
  if (sourceCategory === "pin" && !/pin|collectible|medal/.test(`${name} ${type}`)) return null;
  return sourceCategory;
}

function canonicalTeam(raw, weaponClass) {
  const declared = text(raw.team?.name, text(raw.team, null));
  const normalized = declared?.toLowerCase();
  if (normalized === "t" || normalized?.includes("terrorist")) return "Terrorist";
  if (normalized === "ct" || normalized?.includes("counter")) return "Counter-Terrorist";
  if (tOnlyFirearms.has(weaponClass ?? "")) return "Terrorist";
  if (ctOnlyFirearms.has(weaponClass ?? "")) return "Counter-Terrorist";
  return null;
}

function normalize(raw, sourceCategory) {
  const category = classify(raw, sourceCategory);
  if (!category) return null;
  const externalKey = text(raw.id, text(raw.name)).toLowerCase();
  const imageUrl = text(raw.image, text(raw.image_url));
  const weaponClass = sourceCategory === "weapon"
    ? text(raw.name)
    : text(raw.weapon?.name, text(raw.category?.name, null));
  if (!externalKey || !text(raw.name)) return null;
  return {
    external_key: `cs2:${category}:${externalKey}`,
    category,
    // Base rows use the canonical weapon name so AK-47 → AK-47 finishes
    // shares the exact same server-side filter as weapon skin rows.
    weapon_class: weaponClass || null,
    display_name: text(raw.name),
    weapon_defindex: numeric(raw.weapon?.id) ?? numeric(raw.def_index) ?? numeric(raw.defindex) ?? numeric(raw.id),
    paint_id: numeric(raw.paint_index) ?? numeric(raw.paint_id),
    model: text(raw.model_player, text(raw.model, null)) || null,
    source_image_url: imageUrl || null,
    metadata: {
      source: "bymykel-csgo-api",
      sourceId: raw.id ?? null,
      weaponGroup: text(raw.category?.name, null),
      baseModel: sourceCategory === "weapon" && category === "knife",
      rarity: raw.rarity?.name ?? raw.rarity ?? null,
      minWear: raw.min_float ?? null,
      maxWear: raw.max_float ?? null,
      team: canonicalTeam(raw, weaponClass),
    },
  };
}

function assetKey(item) {
  const hash = crypto.createHash("sha256").update(item.external_key).digest("hex").slice(0, 24);
  return `skinchanger/catalog/${item.category}/${hash}.webp`;
}

async function fetchJson(path) {
  const url = `${SOURCE_BASE.replace(/\/$/, "")}/${path}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Catalog source ${path} returned ${response.status}`);
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [];
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Catalog source ${path} failed`);
}

async function putWebp(key, bytes) {
  const forgeBase = process.env.BUILT_IN_FORGE_API_URL.replace(/\/$/, "");
  const presignUrl = new URL("v1/storage/presign/put", `${forgeBase}/`);
  presignUrl.searchParams.set("path", key);
  const presign = await fetch(presignUrl, {
    headers: { Authorization: `Bearer ${process.env.BUILT_IN_FORGE_API_KEY}` },
  });
  if (!presign.ok) throw new Error(`Storage presign failed: ${presign.status}`);
  const { url } = await presign.json();
  const upload = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/webp" }, body: bytes });
  if (!upload.ok) throw new Error(`Storage upload failed: ${upload.status}`);
}

async function convertAndStore(item) {
  if (skipImages || !item.source_image_url) return null;
  const response = await fetch(item.source_image_url);
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds maximum allowed size");
  const webp = await sharp(bytes, { failOn: "none", limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: 640, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  const key = assetKey(item);
  await putWebp(key, webp);
  return key;
}

async function inPool(items, worker) {
  const output = [];
  let index = 0;
  async function consume() {
    while (index < items.length) {
      const current = items[index++];
      output.push(await worker(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return output;
}

const rawSets = await Promise.all(sourceEndpoints
  .filter((endpoint) => !requestedCategory || endpoint.category === requestedCategory || endpoint.category === "weapon_skin")
  .map(async (endpoint) => ({ endpoint, rows: await fetchJson(endpoint.path) })));

let items = rawSets.flatMap(({ endpoint, rows }) => rows.map((raw) => normalize(raw, endpoint.category)).filter(Boolean));
if (requestedCategory) items = items.filter((item) => item.category === requestedCategory);
if (limit > 0) items = items.slice(0, limit);

const categoryCounts = Object.fromEntries(categories.map((category) => [
  category,
  items.filter((item) => item.category === category).length,
]));

if (dryRun) {
  console.log(JSON.stringify({
    mode: "dry-run",
    sourceBase: SOURCE_BASE,
    total: items.length,
    categoryCounts,
    sourceRows: Object.fromEntries(rawSets.map(({ endpoint, rows }) => [endpoint.path, rows.length])),
  }, null, 2));
  process.exit(0);
}

const results = await inPool(items, async (item) => {
  try {
    const image_key = await convertAndStore(item);
    return { ...item, image_key };
  } catch (error) {
    console.warn(`[skinchanger] asset skipped for ${item.display_name}: ${error instanceof Error ? error.message : String(error)}`);
    return { ...item, image_key: null };
  }
});

const records = results.map(({ source_image_url: _source, ...record }) => record);
for (let offset = 0; offset < records.length; offset += 200) {
  const chunk = records.slice(offset, offset + 200);
  const { error } = await supabase.from("skinchanger_catalog_items").upsert(chunk, { onConflict: "external_key" });
  if (error) throw new Error(`Catalog upsert failed: ${error.message}`);
}

console.log(JSON.stringify({
  ingested: records.length,
  category: requestedCategory ?? "all",
  categoryCounts,
  imagesSkipped: records.filter((item) => !item.image_key).length,
}, null, 2));
