/**
 * Who lifted a penalty, for the public penalties list. The ban row carries it: a lift from the website records the
 * staff member (revoked_by), a lift from Discord's /unban or a game server's !unban records "Lifted by <name>" as the
 * revoke reason (revokeBans). A penalty with no ban row (older records, mutes and gags) has no recorded lifter, and the
 * list then says only that it was lifted.
 */

type LiftRow = { revoked_by?: string | null; revoke_reason?: string | null; revoked_at?: string | null };

const DEFAULT_REASON = /^Lifted by (.{1,64})$/i;

export function liftedByName(row: LiftRow, names: Map<string, string>): string | null {
  const fromUser = row.revoked_by ? names.get(row.revoked_by) : undefined;
  if (fromUser) return fromUser;
  const match = DEFAULT_REASON.exec((row.revoke_reason ?? "").trim());
  return match ? match[1].trim() : null;
}

export function liftInfo(row: LiftRow, names: Map<string, string>): { liftedBy: string | null; liftedAt: string | null } {
  return { liftedBy: liftedByName(row, names), liftedAt: row.revoked_at ?? null };
}
