import { describe, expect, it } from "vitest";
import { artMarker, artUrl, checkClanArt, detectImage } from "./clanArt";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = Buffer.from("GIF89a\u0001\u0000");

describe("clan pictures", () => {
  it("tells types from the bytes, not the name", () => {
    expect(detectImage(png)).toBe("image/png");
    expect(detectImage(jpeg)).toBe("image/jpeg");
    expect(detectImage(gif)).toBe("image/gif");
    expect(detectImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
  });
  it("accepts PNG only for a logo and PNG, JPEG or GIF for a banner", () => {
    expect(checkClanArt("logo", png).ok).toBe(true);
    expect(checkClanArt("logo", jpeg)).toMatchObject({ ok: false, status: 415 });
    expect(checkClanArt("logo", gif)).toMatchObject({ ok: false, status: 415 });
    for (const file of [png, jpeg, gif]) expect(checkClanArt("banner", file).ok).toBe(true);
    expect(checkClanArt("banner", Buffer.from("not an image"))).toMatchObject({ ok: false, status: 415 });
  });
  it("refuses empty and oversized files", () => {
    expect(checkClanArt("logo", Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 });
    expect(checkClanArt("logo", Buffer.concat([png, Buffer.alloc(1100 * 1024)]))).toMatchObject({ ok: false, status: 413 });
  });
  it("only turns our own marker into a picture address", () => {
    expect(artUrl("c1", "logo", artMarker(42))).toBe("/api/v1/clans/c1/logo?v=42");
    expect(artUrl("c1", "banner", "https://evil.example/x.png")).toBeNull();
    expect(artUrl("c1", "banner", "swords")).toBeNull();
    expect(artUrl("c1", "banner", null)).toBeNull();
  });
});
