-- Matchmaking queue (owner decision 2026-11-14: "close the community servers, go to a queue, real fights"). Run once, AFTER the API that knows these tables is deployed
-- (until then the queue routes answer "not set up"). Only the API (service_role) uses the tables. Safe to re-run.
--
--   queue_entries        a player waiting for a match (one row per player; leaving or being matched deletes it)
--   queue_matches        a lobby of ten that must press Accept, then gets a game server (status: accepting, loading, live, finished, cancelled)
--   queue_match_players  the ten, with their team and whether they accepted
CREATE TABLE IF NOT EXISTS legacy_x.queue_entries (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('5x5', 'pro')),
  exp integer NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_entries_mode_idx ON legacy_x.queue_entries (mode, joined_at);

CREATE TABLE IF NOT EXISTS legacy_x.queue_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('5x5', 'pro')),
  map text NOT NULL,
  status text NOT NULL DEFAULT 'accepting' CHECK (status IN ('accepting', 'loading', 'live', 'finished', 'cancelled')),
  server_id text,
  connect_address text,
  accept_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS queue_matches_status_idx ON legacy_x.queue_matches (status, created_at);
CREATE INDEX IF NOT EXISTS queue_matches_server_idx ON legacy_x.queue_matches (server_id) WHERE status IN ('loading', 'live');

CREATE TABLE IF NOT EXISTS legacy_x.queue_match_players (
  match_id uuid NOT NULL REFERENCES legacy_x.queue_matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id text NOT NULL,
  username text NOT NULL,
  team smallint NOT NULL CHECK (team IN (1, 2)),
  exp integer NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL,
  accepted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS queue_match_players_user_idx ON legacy_x.queue_match_players (user_id);

-- Parties (owner request 2026-11-14: "party"): up to five players queue together, land in one lobby and on one team.
CREATE TABLE IF NOT EXISTS legacy_x.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legacy_x.party_members (
  party_id uuid NOT NULL REFERENCES legacy_x.parties(id) ON DELETE CASCADE,
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS party_members_party_idx ON legacy_x.party_members (party_id);
CREATE TABLE IF NOT EXISTS legacy_x.party_invites (
  party_id uuid NOT NULL REFERENCES legacy_x.parties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, user_id)
);
ALTER TABLE legacy_x.queue_entries ADD COLUMN IF NOT EXISTS party_id uuid;
ALTER TABLE legacy_x.queue_match_players ADD COLUMN IF NOT EXISTS party_id uuid;
ALTER TABLE legacy_x.parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.party_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.party_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.parties, legacy_x.party_members, legacy_x.party_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.parties, legacy_x.party_members, legacy_x.party_invites TO service_role;

-- The queued match is handed to the game server as a server action.
ALTER TABLE legacy_x.staff_panel_actions DROP CONSTRAINT IF EXISTS staff_panel_actions_action_type_check;
ALTER TABLE legacy_x.staff_panel_actions ADD CONSTRAINT staff_panel_actions_action_type_check CHECK (action_type IN ('ban','unban','kick','mute','rename','map_change','server_announcement','match_announcement','hud_announcement','player_hud_alert','player_message','restart_all','restart_server','start_server','stop_server','timeout','unpause','round_restart','round_restore','player_ip_lookup','match_set_score','match_end','match_force_start','match_swap_sides','match_move_player','match_load'));

ALTER TABLE legacy_x.queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.queue_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.queue_match_players ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.queue_entries, legacy_x.queue_matches, legacy_x.queue_match_players FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.queue_entries, legacy_x.queue_matches, legacy_x.queue_match_players TO service_role;
