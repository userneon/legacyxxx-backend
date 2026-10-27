-- A player's own settings shown on the profile's Configs tab (owner request 2026-10-27): crosshair, mouse, keyboard, monitor, viewmodel, other lines.
-- The player types them; nothing is read from the game. Rules in server/legacyX/playerConfig.ts. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_configs (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.player_configs ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
