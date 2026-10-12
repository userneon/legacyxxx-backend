-- Staff for a set time (owner request 2026-10-12): an optional end date on a staff grant. The API turns an expired grant into
-- "suspended" (at most once a minute, before staff, moderation and game-server checks), so every reader sees it end on time.
-- Additive and safe to re-run.
ALTER TABLE legacy_x.staff ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL;
