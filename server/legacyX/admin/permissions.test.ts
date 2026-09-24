import { describe, expect, it } from "vitest";
import {
  allowedGameActions,
  banNeedsReview,
  can,
  checkAssignRole,
  checkChangeBan,
  checkEditRoleImmunity,
  checkEditRolePermissions,
  checkIssueBan,
  checkIssueMute,
  checkKick,
  checkRevokeBan,
  checkRevokeMute,
  checkRevokeRole,
  classifyDurationChange,
  type BanState,
  type Principal,
  type RoleSummary,
} from "./permissions";

const roles: Record<string, RoleSummary> = {
  owner: { id: "owner", name: "Owner", immunity: 100, isLocked: true },
  manager: { id: "manager", name: "Manager", immunity: 80, isLocked: false },
  admin: { id: "admin", name: "Admin", immunity: 50, isLocked: false },
  moderator: { id: "moderator", name: "Moderator", immunity: 20, isLocked: false },
};

const shared = ["players.kick", "mutes.issue", "mutes.revoke", "bans.issue", "bans.permanent.issue", "bans.revoke", "reports.view", "servers.map_change", "servers.round_restart"];
const grants: Record<string, string[]> = {
  owner: [...shared, "bans.permanent.revoke", "bans.review", "roles.assign", "roles.revoke", "roles.permissions.edit", "roles.immunity.edit"],
  manager: [...shared, "bans.permanent.revoke", "bans.review"],
  admin: shared,
  moderator: ["players.kick", "mutes.issue", "mutes.revoke", "reports.view"],
};

function principal(roleId: string, userId = roleId): Principal {
  const role = roles[roleId]!;
  return { userId, steamId: "76561198000000000", username: roleId, roles: [role], permissions: new Set(grants[roleId]), immunity: role.immunity };
}

const owner = principal("owner");
const manager = principal("manager");
const admin = principal("admin");
const otherAdmin = principal("admin", "admin-2");
const moderator = principal("moderator");
const future = (days: number) => new Date(Date.now() + days * 86_400_000);

function ban(overrides: Partial<BanState> = {}): BanState {
  return { issuedBy: "admin", issuerImmunity: 50, isPermanent: false, expiresAt: future(7), revokedAt: null, ...overrides };
}

describe("can", () => {
  it("checks permission keys only", () => {
    expect(can(moderator, "players.kick")).toBe(true);
    expect(can(moderator, "bans.issue")).toBe(false);
    expect(can(null, "players.kick")).toBe(false);
  });
});

describe("immunity", () => {
  it("never allows acting on equal or higher immunity", () => {
    expect(checkKick(admin, 50)).toMatch(/above your rank/);
    expect(checkKick(admin, 80)).toMatch(/above your rank/);
    expect(checkKick(admin, 20)).toBeNull();
    expect(checkIssueMute(moderator, 20)).toMatch(/above your rank/);
    expect(checkIssueBan(owner, 100, true)).toMatch(/above your rank/);
  });
});

describe("ban issue", () => {
  it("lets Owner, Manager and Admin issue temporary and permanent bans, and not Moderator", () => {
    for (const actor of [owner, manager, admin]) {
      expect(checkIssueBan(actor, 0, false)).toBeNull();
      expect(checkIssueBan(actor, 0, true)).toBeNull();
    }
    expect(checkIssueBan(moderator, 0, false)).toMatch(/bans.issue/);
  });

  it("queues Admin permanent bans for review but not Manager or Owner ones", () => {
    expect(banNeedsReview(admin, true)).toBe(true);
    expect(banNeedsReview(admin, false)).toBe(false);
    expect(banNeedsReview(manager, true)).toBe(false);
    expect(banNeedsReview(owner, true)).toBe(false);
  });
});

describe("ban revoke", () => {
  it("allows the issuer", () => {
    expect(checkRevokeBan(admin, ban())).toBeNull();
  });

  it("refuses a peer of the issuer and allows someone above the stored issuer immunity", () => {
    expect(checkRevokeBan(otherAdmin, ban())).toMatch(/issuer/);
    expect(checkRevokeBan(manager, ban())).toBeNull();
  });

  it("uses the immunity stored at issue time", () => {
    // Issued while the issuer was a manager (80), so an admin cannot revoke it even if the issuer was later demoted.
    expect(checkRevokeBan(otherAdmin, ban({ issuedBy: "demoted", issuerImmunity: 80 }))).toMatch(/issuer/);
  });

  it("needs bans.permanent.revoke for permanent bans, even for the issuer", () => {
    const permanent = ban({ isPermanent: true, expiresAt: null });
    expect(checkRevokeBan(admin, permanent)).toMatch(/bans.permanent.revoke/);
    expect(checkRevokeBan(manager, permanent)).toBeNull();
    expect(checkRevokeBan(owner, permanent)).toBeNull();
  });

  it("refuses an already revoked ban", () => {
    expect(checkRevokeBan(owner, ban({ revokedAt: new Date() }))).toMatch(/already/);
  });
});

describe("ban duration changes", () => {
  it("classifies shorten, extend and same", () => {
    const temp = { isPermanent: false, expiresAt: future(7) };
    expect(classifyDurationChange(temp, { isPermanent: false, expiresAt: future(1) })).toBe("shorten");
    expect(classifyDurationChange(temp, { isPermanent: false, expiresAt: future(30) })).toBe("extend");
    expect(classifyDurationChange(temp, { isPermanent: true, expiresAt: null })).toBe("extend");
    expect(classifyDurationChange({ isPermanent: true, expiresAt: null }, temp)).toBe("shorten");
    expect(classifyDurationChange({ isPermanent: true, expiresAt: null }, { isPermanent: true, expiresAt: null })).toBe("same");
  });

  it("shortening follows revoke rules", () => {
    expect(checkChangeBan(otherAdmin, ban(), { isPermanent: false, expiresAt: future(1) }, 0)).toMatch(/issuer/);
    expect(checkChangeBan(admin, ban(), { isPermanent: false, expiresAt: future(1) }, 0)).toBeNull();
  });

  it("permanent to temporary needs bans.permanent.revoke", () => {
    const permanent = ban({ isPermanent: true, expiresAt: null });
    expect(checkChangeBan(admin, permanent, { isPermanent: false, expiresAt: future(3) }, 0)).toMatch(/bans.permanent.revoke/);
    expect(checkChangeBan(manager, permanent, { isPermanent: false, expiresAt: future(3) }, 0)).toBeNull();
  });

  it("extending follows issue rules", () => {
    expect(checkChangeBan(otherAdmin, ban(), { isPermanent: false, expiresAt: future(30) }, 0)).toBeNull();
    expect(checkChangeBan(otherAdmin, ban(), { isPermanent: false, expiresAt: future(30) }, 50)).toMatch(/above your rank/);
    expect(checkChangeBan(moderator, ban(), { isPermanent: true, expiresAt: null }, 0)).toMatch(/bans.permanent.issue/);
  });

  it("refuses changes to inactive bans", () => {
    expect(checkChangeBan(owner, ban({ expiresAt: new Date(Date.now() - 1000) }), { isPermanent: true, expiresAt: null }, 0)).toMatch(/no longer active/);
  });
});

describe("mutes", () => {
  it("lets Moderators mute and lift their own mutes but not an Admin's", () => {
    expect(checkIssueMute(moderator, 0)).toBeNull();
    expect(checkRevokeMute(moderator, ban({ issuedBy: "moderator", issuerImmunity: 20 }))).toBeNull();
    expect(checkRevokeMute(moderator, ban())).toMatch(/issuer/);
  });
});

describe("roles", () => {
  it("only the Owner assigns roles, never at or above their own rank", () => {
    expect(checkAssignRole(owner, roles.manager!, 0)).toBeNull();
    expect(checkAssignRole(owner, roles.owner!, 0)).toMatch(/at or above/);
    expect(checkAssignRole(manager, roles.admin!, 0)).toMatch(/roles.assign/);
  });

  it("the Owner cannot remove their own locked role", () => {
    expect(checkRevokeRole(owner, roles.owner!, { userId: "owner", immunity: 100 })).toMatch(/own locked role/);
    expect(checkRevokeRole(owner, roles.manager!, { userId: "m", immunity: 80 })).toBeNull();
  });

  it("the Owner role can gain permissions but never lose any", () => {
    const ownerOnly = new Set(["roles.assign"]);
    const before = new Set(["a.b", "c.d"]);
    expect(checkEditRolePermissions(owner, roles.owner!, before, new Set(["a.b", "c.d", "e.f"]), ownerOnly)).toBeNull();
    expect(checkEditRolePermissions(owner, roles.owner!, before, new Set(["a.b"]), ownerOnly)).toMatch(/cannot lose/);
  });

  it("owner-only permissions cannot go to another role", () => {
    const ownerOnly = new Set(["roles.assign"]);
    expect(checkEditRolePermissions(owner, roles.admin!, new Set(), new Set(["roles.assign"]), ownerOnly)).toMatch(/reserved/);
    expect(checkEditRolePermissions(owner, roles.admin!, new Set(), new Set(["bans.issue"]), ownerOnly)).toBeNull();
  });

  it("Owner immunity cannot drop, other roles stay below the editor", () => {
    expect(checkEditRoleImmunity(owner, roles.owner!, 90)).toMatch(/cannot lose/);
    expect(checkEditRoleImmunity(owner, roles.manager!, 100)).toMatch(/below your own/);
    expect(checkEditRoleImmunity(owner, roles.manager!, 85)).toBeNull();
    expect(checkEditRoleImmunity(manager, roles.admin!, 60)).toMatch(/roles.immunity.edit/);
  });
});

describe("game menu", () => {
  it("lists only backend-allowed actions", () => {
    expect(allowedGameActions(moderator)).toEqual(["kick", "mute", "unmute", "reports"]);
    expect(allowedGameActions(admin)).toContain("ban_permanent");
    expect(allowedGameActions(null)).toEqual([]);
  });
});
