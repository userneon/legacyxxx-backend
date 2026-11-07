import { GAME_COMMANDS } from "./gameRoles";

/**
 * Paid in-game ranks (owner request 2026-11-07): three tiers sold in the Shop for 14, 30 or 90 days, paid straight through Wire (QPay and the bank apps).
 * A tier gives a few commands the buyer picks from a pool of harmless ones: 3, 5 or 10. Names and prices live in `perk_tiers` (the Owner decides them,
 * a tier is not for sale until it is enabled and has a price). The picks live on the player's grant (`perk_grants`).
 *
 * Picking: nothing has to be picked at once (closing the window leaves the picks open); the picks can be changed while they are not full; once all of the
 * tier's commands are picked they are locked until the rank is renewed, and a renewal opens them again.
 */
export const PERK_TIER_KEYS = ["tier1", "tier2", "tier3"] as const;
export type PerkTier = (typeof PERK_TIER_KEYS)[number];
export const PERK_DAYS = [14, 30, 90] as const;
export type PerkDays = (typeof PERK_DAYS)[number];
export const PERK_QUOTAS: Record<PerkTier, number> = { tier1: 3, tier2: 5, tier3: 10 };
export const isPerkTier = (value: unknown): value is PerkTier => typeof value === "string" && (PERK_TIER_KEYS as readonly string[]).includes(value);
export const isPerkDays = (value: unknown): value is PerkDays => typeof value === "number" && (PERK_DAYS as readonly number[]).includes(value);

/** What may be picked: the fun and cheat commands. Nothing that punishes (ban, kick, mute, gag), runs a vote or the server, or opens the admin menu. */
const POOL_GROUPS = new Set(["Fun", "Cheats"]);
const POOL = GAME_COMMANDS.filter((command) => !command.locked && POOL_GROUPS.has(command.group));
const POOL_NAMES = new Set(POOL.map((command) => command.name));
export const perkPool = () => POOL.map(({ name, group, summary }) => ({ name, group, summary }));

export function perkCommandsProblem(quota: number, commands: string[]): string | null {
  if (new Set(commands).size !== commands.length) return "A command is listed twice";
  const unknown = commands.find((name) => !POOL_NAMES.has(name));
  if (unknown) return `${unknown} cannot be picked`;
  if (commands.length > quota) return `This rank has ${quota} commands at most`;
  return null;
}

export type PerkGrant = { tier: PerkTier; endsAt: string; commands: string[]; locked: boolean };

export const perkActive = (grant: { endsAt: string } | null | undefined, now = new Date()) => Boolean(grant) && Date.parse(grant!.endsAt) > now.getTime();

/** Why a purchase is refused for this player (null = fine): one rank at a time, so another tier waits until the current one ends. */
export function perkCheckoutProblem(current: PerkGrant | null, tier: PerkTier, now = new Date()): string | null {
  if (current && perkActive(current, now) && current.tier !== tier) return "You already have another rank running. Renew that one, or wait until it ends.";
  return null;
}

/** The grant after a paid purchase: a new one (nothing picked), or the running one extended and opened for new picks. */
export function grantAfterPurchase(current: PerkGrant | null, tier: PerkTier, days: number, now = new Date()): PerkGrant {
  const running = current && perkActive(current, now) && current.tier === tier ? current : null;
  const from = running ? Date.parse(running.endsAt) : now.getTime();
  return { tier, endsAt: new Date(from + days * 86_400_000).toISOString(), commands: running ? running.commands.slice(0, PERK_QUOTAS[tier]) : [], locked: false };
}

/** Saving the picks: refused while locked; locked once they are all picked. */
export function savePicks(grant: PerkGrant, commands: string[], now = new Date()): { grant: PerkGrant } | { error: string; status: number } {
  if (!perkActive(grant, now)) return { error: "Your rank is not running", status: 409 };
  if (grant.locked) return { error: "Your commands are locked until you renew the rank", status: 409 };
  const quota = PERK_QUOTAS[grant.tier];
  const problem = perkCommandsProblem(quota, commands);
  if (problem) return { error: problem, status: 400 };
  return { grant: { ...grant, commands, locked: commands.length === quota } };
}

/** What the game server is given beyond the role's own commands: the picks, still valid and within the tier's number, while the rank runs. */
export function effectivePerkCommands(grant: { tier: unknown; endsAt: string; commands: unknown } | null | undefined, now = new Date()): string[] {
  if (!grant || !isPerkTier(grant.tier) || !perkActive(grant, now) || !Array.isArray(grant.commands)) return [];
  return Array.from(new Set(grant.commands.filter((name): name is string => typeof name === "string" && POOL_NAMES.has(name)))).slice(0, PERK_QUOTAS[grant.tier]);
}
