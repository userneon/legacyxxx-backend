/** Clan rules that do not need a database: who may do what, and the limits the routes enforce. */

export type ClanRole = "leader" | "co-leader" | "member";

export const CLAN_LIMITS = {
  /** Open requests one player may have at the same time. */
  pendingRequests: 3,
  /** After leaving a clan a player waits this long before joining or asking another. */
  leaveCooldownHours: 24,
  /** Invitations a clan may have waiting. */
  pendingInvites: 20,
  /** A clan may change its name or tag once in this many days. */
  renameCooldownDays: 7,
  activityLimit: 40,
} as const;

export function clanRole(value: unknown): ClanRole | null {
  return value === "leader" || value === "co-leader" || value === "member" ? value : null;
}

/** Leaders and co-leaders run the day to day: requests, invitations, removing members. */
export function canManage(role: ClanRole | null) {
  return role === "leader" || role === "co-leader";
}

/** A co-leader removes members; only the leader removes a co-leader; nobody removes the leader. */
export function canRemove(actor: ClanRole | null, target: ClanRole | null) {
  if (!actor || !target || target === "leader") return false;
  if (actor === "leader") return true;
  return actor === "co-leader" && target === "member";
}

/** Milliseconds a player still has to wait after leaving a clan, or 0. */
export function leaveCooldownLeftMs(leftAt: string | null | undefined, now = Date.now()) {
  if (!leftAt) return 0;
  const left = Date.parse(leftAt);
  if (!Number.isFinite(left)) return 0;
  return Math.max(0, left + CLAN_LIMITS.leaveCooldownHours * 3_600_000 - now);
}

/** Turns what a clan did into a short sentence for its activity list. */
export function describeClanAction(action: string, detail: string | null) {
  const text: Record<string, string> = {
    created: "created the clan",
    joined: "joined",
    left: "left",
    kicked: "was removed",
    promoted: "was made a manager",
    demoted: "is a member again",
    transferred: "became the leader",
    accepted: "was accepted",
    declined: "was declined",
    requested: "asked to join",
    invited: "was invited",
    invite_revoked: "had the invitation withdrawn",
    renamed: "changed the clan name or tag",
    settings: "changed the clan settings",
    logo: "changed the logo",
    banner: "changed the banner",
    moderated: "was moderated by staff",
  };
  const base = text[action] ?? action;
  return detail ? `${base} (${detail})` : base;
}
