import { describe, expect, it } from "vitest";
import { adminBanItem, adminBansQuery, adminLoginItem, banSource, banState, loginOnline } from "./adminPanel";

const NOW = new Date("2026-10-10T12:00:00Z");

describe("banState", () => {
  it("tells active, lifted and expired apart", () => {
    expect(banState({ revoked_at: null, is_permanent: true, expires_at: null }, NOW)).toBe("active");
    expect(banState({ revoked_at: null, is_permanent: false, expires_at: "2026-10-11T00:00:00Z" }, NOW)).toBe("active");
    expect(banState({ revoked_at: null, is_permanent: false, expires_at: "2026-10-09T00:00:00Z" }, NOW)).toBe("expired");
    expect(banState({ revoked_at: "2026-10-09T00:00:00Z", is_permanent: true, expires_at: null }, NOW)).toBe("lifted");
  });
});

describe("banSource", () => {
  it("words the two recorded sources and does not guess a third", () => {
    expect(banSource("game")).toBe("In-game");
    expect(banSource("panel")).toBe("Website");
    expect(banSource(null)).toBe("Unknown");
  });
});

describe("adminBanItem", () => {
  const names = new Map([["u1", "Zaya"], ["u2", "Anu"]]);
  it("names who issued and who lifted a ban", () => {
    const item = adminBanItem({ id: "b1", steam_id: "76561198000000001", user_id: "u1", reason: "Griefing", is_permanent: false, expires_at: "2026-10-20T00:00:00Z", issued_by: "u2", source: "game", revoked_at: "2026-10-10T08:00:00Z", revoked_by: "u2", revoke_reason: "Appeal accepted", created_at: "2026-10-08T19:12:00Z" }, names, NOW);
    expect(item).toMatchObject({ player: "Zaya", issuedBy: "Anu", via: "In-game", state: "lifted", liftedBy: "Anu", liftReason: "Appeal accepted" });
  });
  it("leaves the lift fields empty for a ban that still applies", () => {
    const item = adminBanItem({ id: "b2", steam_id: "76561198000000002", user_id: "gone", reason: "x", is_permanent: true, source: "panel", created_at: "2026-10-01T00:00:00Z" }, names, NOW);
    expect(item).toMatchObject({ player: "Steam 76561198000000002", state: "active", liftedBy: null, liftedAt: null });
  });
});

describe("loginOnline and adminLoginItem", () => {
  it("is online only while the session is open and fresh", () => {
    expect(loginOnline({ disconnected_at: null, updated_at: "2026-10-10T11:55:00Z" }, NOW)).toBe(true);
    expect(loginOnline({ disconnected_at: null, updated_at: "2026-10-10T11:30:00Z" }, NOW)).toBe(false);
    expect(loginOnline({ disconnected_at: "2026-10-10T11:58:00Z", updated_at: "2026-10-10T11:58:00Z" }, NOW)).toBe(false);
  });
  it("shows the server's display name when it has one", () => {
    const item = adminLoginItem({ steam_id: "76561198000000003", player_name: "Anu", server_id: "srv-27015", connected_at: "2026-10-10T11:58:00Z", disconnected_at: null, updated_at: "2026-10-10T11:59:00Z" }, new Map([["srv-27015", "LEGACY-X #1"]]), NOW);
    expect(item).toMatchObject({ player: "Anu", server: "LEGACY-X #1", online: true });
  });
});

describe("adminBansQuery", () => {
  it("needs the viewer's SteamID64 and defaults to active bans", () => {
    expect(adminBansQuery.parse({ steam_id: "76561198000000001" })).toMatchObject({ filter: "active", offset: 0 });
    expect(() => adminBansQuery.parse({ filter: "active", steam_id: "nope" })).toThrow();
  });
});
