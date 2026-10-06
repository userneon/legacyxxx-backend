/** Clan pictures: what may be uploaded, how big, and how to tell what a file really is (never by its name or header). */

export type ClanArtKind = "logo" | "banner";
export type ClanArtMime = "image/png" | "image/jpeg" | "image/gif";

/** nginx in front of the API must allow bodies of at least 6 MB (client_max_body_size 6m) for these to arrive. */
export const CLAN_ART_LIMITS: Record<ClanArtKind, { maxBytes: number; mimes: ClanArtMime[] }> = {
  logo: { maxBytes: 1024 * 1024, mimes: ["image/png"] },
  banner: { maxBytes: 5 * 1024 * 1024, mimes: ["image/png", "image/jpeg", "image/gif"] },
};

/** The picture's real type from its first bytes, or null when it is not a PNG, JPEG or GIF. */
export function detectImage(bytes: Buffer): ClanArtMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}

export type ClanArtCheck = { ok: true; mime: ClanArtMime } | { ok: false; status: number; message: string };

export function checkClanArt(kind: ClanArtKind, bytes: Buffer): ClanArtCheck {
  const rule = CLAN_ART_LIMITS[kind];
  if (bytes.length === 0) return { ok: false, status: 400, message: "Send the picture as the request body" };
  if (bytes.length > rule.maxBytes) return { ok: false, status: 413, message: `The ${kind} is larger than ${Math.round(rule.maxBytes / 1024 / 1024)} MB` };
  const mime = detectImage(bytes);
  if (!mime || !rule.mimes.includes(mime)) return { ok: false, status: 415, message: kind === "logo" ? "The logo must be a PNG" : "The banner must be a PNG, JPEG or GIF" };
  return { ok: true, mime };
}

/** Marker kept in clans.logo / clans.thumbnail while a picture exists; the number changes with every upload. */
export function artMarker(version: number) {
  return `upload:${version}`;
}

export function artUrl(clanId: string, kind: ClanArtKind, marker: unknown): string | null {
  const match = typeof marker === "string" ? /^upload:(\d{1,15})$/.exec(marker) : null;
  return match ? `/api/v1/clans/${clanId}/${kind}?v=${match[1]}` : null;
}
