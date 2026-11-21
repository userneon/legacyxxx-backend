import { detectImage, type ClanArtMime } from "./clanArt";

/**
 * Pictures of cosmetic items (owner request 2026-11-21: "fetch all the images from one place"): the picture of a weapon model, and any other item, lives in the database next to the item,
 * is put there once by staff (Staff → Shop → Cosmetics) and is served from GET /cosmetics/:id/image. The website draws `image` wherever the item shows; nothing is kept in the website's files.
 */
export const COSMETIC_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const COSMETIC_IMAGE_MIMES: ClanArtMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export type CosmeticImageCheck = { ok: true; mime: ClanArtMime } | { ok: false; status: number; message: string };

/** What the file really is, by its first bytes (never by name or header), and whether it is small enough. */
export function checkCosmeticImage(bytes: Buffer): CosmeticImageCheck {
  if (bytes.length === 0) return { ok: false, status: 400, message: "Send the picture as the request body" };
  if (bytes.length > COSMETIC_IMAGE_MAX_BYTES) return { ok: false, status: 413, message: `The picture is larger than ${Math.round(COSMETIC_IMAGE_MAX_BYTES / 1024 / 1024)} MB` };
  const mime = detectImage(bytes);
  if (!mime || !COSMETIC_IMAGE_MIMES.includes(mime)) return { ok: false, status: 415, message: "The picture must be a PNG, JPEG, WebP or GIF" };
  return { ok: true, mime };
}

/** `image_v` is kept in cosmetic_items while a picture exists (its upload time, so a new picture gets a new address); the API sends this address. */
export function cosmeticImageUrl(itemId: string, version: unknown): string | null {
  const v = typeof version === "number" ? version : typeof version === "string" && /^\d{1,15}$/.test(version) ? Number(version) : NaN;
  return Number.isFinite(v) && v > 0 && /^[a-z0-9-]{2,40}$/.test(itemId) ? `/api/v1/cosmetics/${itemId}/image?v=${v}` : null;
}
