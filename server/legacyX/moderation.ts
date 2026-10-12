import { banTerm } from "./bans";

/** Who may manage penalties from the website, and the small rules that go with it. */

export type ModerationCapability = "ban" | "unban" | "mute" | "edit";

const ROLES = new Set(["OWNER", "MANAGER", "ADMIN"]);

/** The capability each kind of change needs; an unlisted permission list (empty or "*") allows all of them. */
export function mayModerate(role: string | null | undefined, permissions: unknown, capability: ModerationCapability) {
  if (!role || !ROLES.has(role)) return false;
  if (role === "OWNER") return true;
  const list = Array.isArray(permissions) ? permissions.filter((entry): entry is string => typeof entry === "string") : [];
  if (list.length === 0 || list.includes("*")) return true;
  // "edit" (new reason or term) is a ban-level change.
  return list.includes(capability === "edit" ? "ban" : capability);
}

/** A staff member may touch a ban when their immunity reaches the issuer's; an Owner always may. */
export function mayTouchBan(role: string | null | undefined, actorImmunity: number | null | undefined, issuerImmunity: number | null | undefined) {
  if (role === "OWNER") return true;
  if (issuerImmunity == null) return true;
  return (actorImmunity ?? 0) >= issuerImmunity;
}

/** The fields a new length of time sets on a penalty. 0 minutes means permanent. */
export function termFields(durationMinutes: number, now = new Date()) {
  const permanent = durationMinutes === 0;
  return {
    term: banTerm(durationMinutes),
    is_permanent: permanent,
    expires_at: permanent ? null : new Date(now.getTime() + durationMinutes * 60_000).toISOString(),
  };
}

/** Permanent bans from anyone below a manager wait for a review. */
export function needsReview(role: string | null | undefined, permanent: boolean) {
  return permanent && role !== "OWNER" && role !== "MANAGER";
}

/** Clans are moderated by Owners and Managers only: an Admin can neither change nor delete a clan. */
export function mayModerateClans(role: string | null | undefined, permissions: unknown) {
  return (role === "OWNER" || role === "MANAGER") && mayModerate(role, permissions, "edit");
}

/** An Admin lifts their own penalties at will; lifting someone else's needs a Manager or Owner to approve. */
export function needsLiftApproval(role: string | null | undefined, isOwn: boolean) {
  return role === "ADMIN" && !isOwn;
}

/** Owners and Managers decide on lift requests. */
export function mayApproveLifts(role: string | null | undefined) {
  return role === "OWNER" || role === "MANAGER";
}

const ROLE_IMMUNITY: Record<string, number> = { OWNER: 1000, MANAGER: 750, ADMIN: 500 };

/**
 * Whether a moderator may penalize this player. Players (no active staff grant) always may be; a staff member only by someone whose
 * immunity reaches theirs, so an Admin cannot ban a Manager and a Main Content Creator (immunity below Admin) cannot touch staff at all.
 * An Owner may penalize anyone but another Owner.
 */
export function mayPenalize(
  actor: { role: string | null | undefined; immunity: number | null | undefined },
  target: { role: string | null | undefined; immunity: number | null | undefined } | null,
) {
  if (!target || !target.role) return true;
  const targetImmunity = target.immunity ?? ROLE_IMMUNITY[target.role] ?? 0;
  if (targetImmunity <= 0) return true;
  if (actor.role === "OWNER") return target.role !== "OWNER";
  return (actor.immunity ?? ROLE_IMMUNITY[actor.role ?? ""] ?? 0) > targetImmunity;
}
