-- A refresh token is single use, but a reload that cancels the response, or two tabs refreshing at once, used to lose the new one
-- and sign the player out. rotated_at marks "revoked because it was swapped for a new one": such a token still works for a short grace window.
-- Logout and security revocations leave it empty, so they stay final. Safe to re-run.
ALTER TABLE legacy_x.user_sessions ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
