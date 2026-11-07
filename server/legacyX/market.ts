import sharp from "sharp";
import { z } from "zod";

import { detectImage } from "./clanArt";

/**
 * The Market (owner request 2026-11-07): a player posts what they like to sell with a title, a description, photos and, if they want, a price, a phone number and an
 * email. Contact details are only given to signed-in players. A listing lasts 45 days; three different reports hide it until staff look at it.
 */
export const MARKET_LIMITS = {
  activeListings: 5,
  newPerDay: 5,
  imagesPerListing: 6,
  sourceImageBytes: 8 * 1024 * 1024,
  /** What a stored picture may be: it is re-encoded to WebP, so this is rarely near. */
  storedImageBytes: 1_572_864,
  imageWidth: 1400,
  keepDays: 45,
  hideAtReports: 3,
  perPage: 24,
} as const;

/** What a person typed, made safe to keep: no control characters or invisible marks, one space between words (a description keeps its line breaks). */
export const cleanLine = (raw: string, max: number) => raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const cleanBlock = (raw: string, max: number) =>
  raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());

export const marketListingSchema = z
  .object({
    title: z.string().transform((value) => cleanLine(value, 80)).pipe(z.string().min(3, "Write a title of at least 3 letters")),
    description: z.string().max(4000).default("").transform((value) => cleanBlock(value, 2000)),
    priceMnt: optional(z.number().int("The price is a whole number").min(0).max(1_000_000_000)),
    phone: optional(z.string().transform((value) => cleanLine(value, 24)).pipe(z.string().regex(/^[+0-9 ()-]{5,24}$/, "A phone number has digits, spaces and + - ( ) only"))),
    email: optional(z.string().transform((value) => cleanLine(value, 120).toLowerCase()).pipe(z.string().email("That email address is not valid"))),
  })
  .strict();
export type MarketListingInput = z.infer<typeof marketListingSchema>;

export const marketStatusSchema = z.object({ status: z.enum(["active", "sold"]) }).strict();
export const marketReportSchema = z.object({ reason: z.string().default("").transform((value) => cleanLine(value, 200)) }).strict();
export const marketQuerySchema = z.object({
  q: z.string().optional().transform((value) => (value ? cleanLine(value, 60) : "")),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

/** A picture as it is kept: turned the way it was taken, no camera or place data, at most 1400 px wide, WebP. Throws a short message when it is not a picture. */
export async function processMarketImage(bytes: Buffer): Promise<{ mime: "image/webp"; data: Buffer }> {
  if (bytes.length === 0) throw new Error("Send the picture as the request body");
  if (bytes.length > MARKET_LIMITS.sourceImageBytes) throw new Error(`The picture is larger than ${MARKET_LIMITS.sourceImageBytes / 1024 / 1024} MB`);
  if (!detectImage(bytes)) throw new Error("The picture must be a PNG, JPEG, GIF or WebP");
  let quality = 82;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const data = await sharp(bytes, { limitInputPixels: 60_000_000, animated: false })
      .rotate()
      .resize({ width: MARKET_LIMITS.imageWidth, height: MARKET_LIMITS.imageWidth, fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (data.length <= MARKET_LIMITS.storedImageBytes) return { mime: "image/webp", data };
    quality -= 14;
  }
  throw new Error("The picture is too detailed to keep. Try a smaller one.");
}

/** Whether a listing may be shown in the public list. */
export const isListed = (row: { status: string; report_count: number; expires_at: string }, now = Date.now()) =>
  row.status === "active" && row.report_count < MARKET_LIMITS.hideAtReports && Date.parse(row.expires_at) > now;

export const imageUrl = (imageId: string) => `/api/v1/public/market/images/${imageId}`;
