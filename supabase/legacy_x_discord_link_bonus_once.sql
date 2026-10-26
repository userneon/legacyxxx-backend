-- The 50 LX for linking Discord is paid once per Discord account as well as once per player (owner report 2026-10-26: unlinking and
-- linking the same Discord to another Steam account paid it again). Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.discord_link_bonus (
  discord_id text PRIMARY KEY CHECK (discord_id ~ '^[0-9]{5,25}$'),
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  awarded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.discord_link_bonus ENABLE ROW LEVEL SECURITY;

-- Everyone already paid: their current link.
INSERT INTO legacy_x.discord_link_bonus (discord_id, user_id, awarded_at)
SELECT l.discord_id, l.user_id, t.created_at FROM legacy_x.discord_links l
JOIN legacy_x.wallet_transactions t ON t.user_id = l.user_id AND t.ref = 'bonus:discord-link:' || l.user_id
ON CONFLICT (discord_id) DO NOTHING;

-- Claims the bonus for this Discord account; false when it was paid for it before (to anyone).
CREATE OR REPLACE FUNCTION legacy_x.discord_link_bonus_claim(p_discord_id text, p_user_id uuid) RETURNS boolean
LANGUAGE sql SET search_path TO 'legacy_x', 'pg_temp' AS $$
  WITH claimed AS (INSERT INTO legacy_x.discord_link_bonus (discord_id, user_id) VALUES (p_discord_id, p_user_id) ON CONFLICT (discord_id) DO NOTHING RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION legacy_x.discord_link_bonus_claim(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.discord_link_bonus_claim(text, uuid) TO service_role;
GRANT SELECT, INSERT ON legacy_x.discord_link_bonus TO service_role;
NOTIFY pgrst, 'reload schema';
