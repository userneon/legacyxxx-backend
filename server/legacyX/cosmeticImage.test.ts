import { describe, expect, it } from "vitest";
import { checkCosmeticImage, cosmeticImageUrl, COSMETIC_IMAGE_MAX_BYTES } from "./cosmeticImage";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

describe("cosmetic pictures", () => {
  it("accepts a PNG, JPEG, WebP or GIF by its bytes", () => {
    expect(checkCosmeticImage(png)).toEqual({ ok: true, mime: "image/png" });
    expect(checkCosmeticImage(webp)).toEqual({ ok: true, mime: "image/webp" });
    expect(checkCosmeticImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, mime: "image/jpeg" });
    expect(checkCosmeticImage(Buffer.from("GIF89a\u0001\u0000"))).toEqual({ ok: true, mime: "image/gif" });
  });
  it("refuses empty, oversized and non-image files (an SVG is never served)", () => {
    expect(checkCosmeticImage(Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 });
    expect(checkCosmeticImage(Buffer.concat([png, Buffer.alloc(COSMETIC_IMAGE_MAX_BYTES)]))).toMatchObject({ ok: false, status: 413 });
    expect(checkCosmeticImage(Buffer.from("<svg onload=alert(1)>"))).toMatchObject({ ok: false, status: 415 });
  });
  it("makes an address only for a real version and a safe id", () => {
    expect(cosmeticImageUrl("katana-miku", 1732100000000)).toBe("/api/v1/cosmetics/katana-miku/image?v=1732100000000");
    expect(cosmeticImageUrl("katana-miku", "1732100000000")).toBe("/api/v1/cosmetics/katana-miku/image?v=1732100000000");
    expect(cosmeticImageUrl("katana-miku", null)).toBeNull();
    expect(cosmeticImageUrl("katana-miku", 0)).toBeNull();
    expect(cosmeticImageUrl("../etc", 5)).toBeNull();
  });
});
