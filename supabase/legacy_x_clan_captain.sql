-- A clan role "captain" (owner request 2026-11-02): a title the leader gives to a trusted member, shown on the roster, with no powers of its own.
-- The enum gets one more value; nothing else changes. Safe to re-run.
ALTER TYPE legacy_x.clan_role ADD VALUE IF NOT EXISTS 'captain' AFTER 'co-leader';
