-- A clan's own page background: the leader buys "Custom Background" once, then picks the two colours and the optional effect freely.
-- Only the picked values are stored here; the catalog item lives in server/legacyX/clanLooks.ts. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_custom (
  clan_id uuid PRIMARY KEY REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  from_color text NOT NULL CHECK (from_color ~ '^#[0-9a-f]{6}$'),
  to_color text NOT NULL CHECK (to_color ~ '^#[0-9a-f]{6}$'),
  effect text CHECK (effect IS NULL OR effect IN ('slats', 'waves', 'dots', 'aurora', 'threads', 'particles', 'lightning', 'rays', 'lines', 'plasma')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.clan_look_custom ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_custom FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_custom TO service_role;
NOTIFY pgrst, 'reload schema';
