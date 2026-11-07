import { GAME_COMMANDS, defaultGameRole } from "./gameRoles";

/**
 * Admin levels (owner request 2026-11-07). Every Admin keeps the commands of the Admin role as set in Staff → Roles; on top of that the Owner picks a few
 * extra commands for each Admin, as many as their level allows: Admin 3, High Admin 5, +Admin 10. The levels live on the staff row (`admin_level`,
 * `extra_commands`), only for the ADMIN role, and the game servers read the sum with the rest of the role (adminAuthorization.ts).
 */
export const ADMIN_LEVELS = {
  admin: { label: "Admin", quota: 3 },
  high: { label: "High Admin", quota: 5 },
  plus: { label: "+Admin", quota: 10 },
} as const;
export type AdminLevel = keyof typeof ADMIN_LEVELS;
export const ADMIN_LEVEL_KEYS = Object.keys(ADMIN_LEVELS) as [AdminLevel, ...AdminLevel[]];
export const isAdminLevel = (value: unknown): value is AdminLevel => typeof value === "string" && value in ADMIN_LEVELS;

const GRANTABLE = new Set(GAME_COMMANDS.filter((command) => !command.locked).map((command) => command.name));

/** The commands an extra pick can be: the ones a role may be given at all (not the locked server commands), in the catalogue's order. */
export const extraCommandChoices = () => GAME_COMMANDS.filter((command) => !command.locked).map(({ name, group, summary }) => ({ name, group, summary }));

/** Why a pick is refused, or null when it is fine. `base` is what the Admin role already gives (those need no pick). */
export function extraCommandsProblem(level: AdminLevel, extras: string[], base: string[] = defaultGameRole("admin").commands): string | null {
  if (new Set(extras).size !== extras.length) return "A command is listed twice";
  const unknown = extras.filter((name) => !GRANTABLE.has(name));
  if (unknown.length) return `A command is unknown or cannot be granted: ${unknown[0]}`;
  const already = extras.filter((name) => base.includes(name));
  if (already.length) return `${already[0]} is already part of the Admin role`;
  const { label, quota } = ADMIN_LEVELS[level];
  if (extras.length > quota) return `${label} may have ${quota} extra commands at most`;
  return null;
}

/** What the game server is given: only picks that are still valid, the first `quota` of them (a level lowered since never gives more than it allows). */
export function effectiveExtras(level: unknown, extras: unknown, base: string[]): string[] {
  const quota = ADMIN_LEVELS[isAdminLevel(level) ? level : "admin"].quota;
  const list = Array.isArray(extras) ? extras.filter((name): name is string => typeof name === "string") : [];
  return Array.from(new Set(list)).filter((name) => GRANTABLE.has(name) && !base.includes(name)).slice(0, quota);
}
