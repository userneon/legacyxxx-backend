/**
 * Pure permission rules for the admin & moderation system.
 *
 * Every rule checks permission keys and immunity numbers, never role names. Each check returns
 * `null` when the action is allowed, or a short reason when it is refused, so the HTTP layer and the
 * game endpoints give the same answer.
 */

export type RoleSummary = { id: string; name: string; immunity: number; isLocked: boolean };

export type Principal = {
  userId: string;
  steamId: string;
  username: string;
  roles: RoleSummary[];
  permissions: ReadonlySet<string>;
  /** The highest immunity among the principal's roles; 0 without a role. */
  immunity: number;
};

export type Denial = string | null;

export type BanState = {
  issuedBy: string | null;
  issuerImmunity: number;
  isPermanent: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type MuteState = BanState;

export type DurationChange = { isPermanent: boolean; expiresAt: Date | null };

export function can(principal: Principal | null | undefined, key: string) {
  return Boolean(principal?.permissions.has(key));
}

export function isStaff(principal: Principal | null | undefined): principal is Principal {
  return Boolean(principal && principal.roles.length > 0);
}

/** Nobody can act on a target with equal or higher immunity. */
export function outranks(actor: Principal, targetImmunity: number) {
  return actor.immunity > targetImmunity;
}

function requirePermission(actor: Principal, key: string): Denial {
  return can(actor, key) ? null : `Missing permission ${key}`;
}

function requireOutranks(actor: Principal, targetImmunity: number): Denial {
  return outranks(actor, targetImmunity) ? null : "Target is above your rank";
}

export function isActive(state: Pick<BanState, "revokedAt" | "isPermanent" | "expiresAt">, now = new Date()) {
  if (state.revokedAt) return false;
  return state.isPermanent || (state.expiresAt !== null && state.expiresAt.getTime() > now.getTime());
}

/* ---------------------------------------------------------------------------
 * Kick
 * ------------------------------------------------------------------------ */

export function checkKick(actor: Principal, targetImmunity: number): Denial {
  return requirePermission(actor, "players.kick") ?? requireOutranks(actor, targetImmunity);
}

/* ---------------------------------------------------------------------------
 * Bans
 * ------------------------------------------------------------------------ */

export function checkIssueBan(actor: Principal, targetImmunity: number, permanent: boolean): Denial {
  return requirePermission(actor, permanent ? "bans.permanent.issue" : "bans.issue") ?? requireOutranks(actor, targetImmunity);
}

/** A permanent ban from someone who cannot review bans goes to the review queue; it stays active meanwhile. */
export function banNeedsReview(actor: Principal, permanent: boolean) {
  return permanent && !can(actor, "bans.review");
}

/** Revoke: the issuer, or anyone above the issuer's immunity at issue time. Permanent bans also need ban.permanent.revoke. */
export function checkRevokeBan(actor: Principal, ban: BanState): Denial {
  if (ban.revokedAt) return "Ban is already revoked";
  const missing = requirePermission(actor, "bans.revoke");
  if (missing) return missing;
  if (ban.isPermanent) {
    const permanentMissing = requirePermission(actor, "bans.permanent.revoke");
    if (permanentMissing) return permanentMissing;
  }
  if (ban.issuedBy === actor.userId) return null;
  return actor.immunity > ban.issuerImmunity ? null : "Only the issuer or someone above the issuer's rank can change this ban";
}

export function classifyDurationChange(current: DurationChange, next: DurationChange): "shorten" | "extend" | "same" {
  if (current.isPermanent && next.isPermanent) return "same";
  if (current.isPermanent) return "shorten";
  if (next.isPermanent) return "extend";
  const a = current.expiresAt?.getTime() ?? 0;
  const b = next.expiresAt?.getTime() ?? 0;
  return b < a ? "shorten" : b > a ? "extend" : "same";
}

/** Shortening (including permanent→temporary) follows revoke rules; extending follows issue rules. */
export function checkChangeBan(actor: Principal, ban: BanState, next: DurationChange, targetImmunity: number, now = new Date()): Denial {
  if (!isActive(ban, now)) return "Ban is no longer active";
  const kind = classifyDurationChange(ban, next);
  if (kind === "same") return "The ban already has this duration";
  if (kind === "shorten") return checkRevokeBan(actor, ban);
  return checkIssueBan(actor, targetImmunity, next.isPermanent);
}

export function checkReviewBan(actor: Principal): Denial {
  return requirePermission(actor, "bans.review");
}

/* ---------------------------------------------------------------------------
 * Mutes
 * ------------------------------------------------------------------------ */

export function checkIssueMute(actor: Principal, targetImmunity: number): Denial {
  return requirePermission(actor, "mutes.issue") ?? requireOutranks(actor, targetImmunity);
}

export function checkRevokeMute(actor: Principal, mute: MuteState): Denial {
  if (mute.revokedAt) return "Mute is already lifted";
  const missing = requirePermission(actor, "mutes.revoke");
  if (missing) return missing;
  if (mute.issuedBy === actor.userId) return null;
  return actor.immunity > mute.issuerImmunity ? null : "Only the issuer or someone above the issuer's rank can lift this mute";
}

/* ---------------------------------------------------------------------------
 * Roles
 * ------------------------------------------------------------------------ */

export function checkAssignRole(actor: Principal, role: RoleSummary, targetImmunity: number): Denial {
  return requirePermission(actor, "roles.assign")
    ?? (actor.immunity > role.immunity ? null : "You cannot grant a role at or above your own rank")
    ?? requireOutranks(actor, targetImmunity);
}

export function checkRevokeRole(actor: Principal, role: RoleSummary, target: { userId: string; immunity: number }): Denial {
  const missing = requirePermission(actor, "roles.revoke");
  if (missing) return missing;
  if (target.userId === actor.userId) {
    return role.isLocked ? "You cannot remove your own locked role" : null;
  }
  return requireOutranks(actor, target.immunity);
}

/**
 * Role permission edits. A locked role (Owner) can gain permissions but never lose one. Other roles
 * are editable only from above their rank, and never receive owner-only permissions.
 */
export function checkEditRolePermissions(
  actor: Principal,
  role: RoleSummary,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  ownerOnlyKeys: ReadonlySet<string>,
): Denial {
  const missing = requirePermission(actor, "roles.permissions.edit");
  if (missing) return missing;
  if (role.isLocked) {
    if (!actor.roles.some(held => held.id === role.id)) return "Only a holder of a locked role can edit it";
    for (const key of before) if (!after.has(key)) return "A locked role cannot lose permissions";
    return null;
  }
  if (!outranks(actor, role.immunity)) return "You cannot edit a role at or above your own rank";
  for (const key of after) if (ownerOnlyKeys.has(key)) return `Permission ${key} is reserved for the Owner`;
  return null;
}

export function checkEditRoleImmunity(actor: Principal, role: RoleSummary, nextImmunity: number): Denial {
  const missing = requirePermission(actor, "roles.immunity.edit");
  if (missing) return missing;
  if (!Number.isInteger(nextImmunity) || nextImmunity < 0 || nextImmunity > 100) return "Immunity must be between 0 and 100";
  if (role.isLocked) return nextImmunity < role.immunity ? "A locked role cannot lose immunity" : null;
  if (!outranks(actor, role.immunity)) return "You cannot edit a role at or above your own rank";
  if (nextImmunity >= actor.immunity) return "Immunity must stay below your own";
  return null;
}

/* ---------------------------------------------------------------------------
 * In-game menu
 * ------------------------------------------------------------------------ */

export const gameMenuActions = [
  { key: "kick", permission: "players.kick" },
  { key: "mute", permission: "mutes.issue" },
  { key: "unmute", permission: "mutes.revoke" },
  { key: "ban", permission: "bans.issue" },
  { key: "ban_permanent", permission: "bans.permanent.issue" },
  { key: "map_change", permission: "servers.map_change" },
  { key: "round_restart", permission: "servers.round_restart" },
  { key: "reports", permission: "reports.view" },
] as const;

export type GameMenuAction = (typeof gameMenuActions)[number]["key"];

export function allowedGameActions(principal: Principal | null): GameMenuAction[] {
  if (!isStaff(principal)) return [];
  return gameMenuActions.filter(action => can(principal, action.permission)).map(action => action.key);
}
