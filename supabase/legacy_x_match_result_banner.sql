-- Finished matches reach the Discord bot as announcements with the "match-result" banner (matchAnnouncement.ts), so the
-- banner column must accept it. Widens the check only: every existing row stays valid.
BEGIN;

ALTER TABLE legacy_x.update_announcements DROP CONSTRAINT IF EXISTS update_announcements_banner_check;
ALTER TABLE legacy_x.update_announcements
  ADD CONSTRAINT update_announcements_banner_check CHECK (banner IS NULL OR banner IN ('cs2-update-finished', 'match-result'));

COMMIT;
