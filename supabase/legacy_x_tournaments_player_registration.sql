-- LEGACY-X tournaments: player-based registration (clans no longer gate who can play).
--
-- Before: tournament_registrations(tournament_id, clan_id) and tournament_matches(clan_a_id,
-- clan_b_id, scheduled_time text). All three tournament tables held 0 rows when this was
-- written (verified 2026-09-24), so the old columns are dropped instead of migrated.
--
-- After:
--   tournaments               + name, description, starts_at, registration_closes_at,
--                               check_in_opens_at, max_players, team_size, winner_team_id;
--                               next_match_time text -> timestamptz; season optional.
--   tournament_teams          (id, tournament_id, name, captain_user_id, seed)
--   tournament_registrations  (tournament_id, user_id, team_id?, mode solo|team, checked_in_at)
--   tournament_matches        team_a_id / team_b_id -> tournament_teams, server_id,
--                               scheduled_time timestamptz, score_a / score_b.
--   balance_tournament_solo_players(tournament_id): once registration has closed, solo players
--   are put into teams of team_size, balanced by current EXP (snake draft). Idempotent.

BEGIN;

-- ---------------------------------------------------------------- tournaments
ALTER TABLE legacy_x.tournaments
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_in_opens_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_players integer,
  ADD COLUMN IF NOT EXISTS team_size integer NOT NULL DEFAULT 5;

ALTER TABLE legacy_x.tournaments ALTER COLUMN season DROP NOT NULL;
UPDATE legacy_x.tournaments SET name = coalesce(name, season, 'Tournament') WHERE name IS NULL;
ALTER TABLE legacy_x.tournaments ALTER COLUMN name SET NOT NULL;

ALTER TABLE legacy_x.tournaments
  ALTER COLUMN next_match_time TYPE timestamptz USING NULLIF(next_match_time, '')::timestamptz;

ALTER TABLE legacy_x.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_max_players_check,
  ADD CONSTRAINT tournaments_max_players_check CHECK (max_players IS NULL OR max_players > 0),
  DROP CONSTRAINT IF EXISTS tournaments_team_size_check,
  ADD CONSTRAINT tournaments_team_size_check CHECK (team_size BETWEEN 1 AND 5),
  DROP CONSTRAINT IF EXISTS tournaments_schedule_order_check,
  ADD CONSTRAINT tournaments_schedule_order_check CHECK (
    (registration_closes_at IS NULL OR starts_at IS NULL OR registration_closes_at <= starts_at)
    AND (check_in_opens_at IS NULL OR starts_at IS NULL OR check_in_opens_at <= starts_at)
  );

-- ---------------------------------------------------------------- teams
CREATE TABLE IF NOT EXISTS legacy_x.tournament_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES legacy_x.tournaments(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 32),
  captain_user_id uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  -- true for teams built by balance_tournament_solo_players
  auto_balanced boolean NOT NULL DEFAULT false,
  seed integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tournament_teams_name_key ON legacy_x.tournament_teams (tournament_id, lower(name));
CREATE INDEX IF NOT EXISTS tournament_teams_tournament_idx ON legacy_x.tournament_teams (tournament_id);

ALTER TABLE legacy_x.tournaments
  ADD COLUMN IF NOT EXISTS winner_team_id uuid REFERENCES legacy_x.tournament_teams(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- registrations
ALTER TABLE legacy_x.tournament_registrations DROP CONSTRAINT IF EXISTS tournament_reg_clan_key;
ALTER TABLE legacy_x.tournament_registrations DROP CONSTRAINT IF EXISTS tournament_registrations_clan_id_fkey;
ALTER TABLE legacy_x.tournament_registrations DROP COLUMN IF EXISTS clan_id;

ALTER TABLE legacy_x.tournament_registrations
  ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES legacy_x.tournament_teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'solo',
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

ALTER TABLE legacy_x.tournament_registrations
  DROP CONSTRAINT IF EXISTS tournament_registrations_mode_check,
  ADD CONSTRAINT tournament_registrations_mode_check CHECK (mode IN ('solo', 'team')),
  -- a team registration always belongs to a team; a solo one gets a team only when balanced
  DROP CONSTRAINT IF EXISTS tournament_registrations_team_mode_check,
  ADD CONSTRAINT tournament_registrations_team_mode_check CHECK (mode = 'solo' OR team_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS tournament_registrations_user_key ON legacy_x.tournament_registrations (tournament_id, user_id);
CREATE INDEX IF NOT EXISTS tournament_registrations_team_idx ON legacy_x.tournament_registrations (team_id);

-- ---------------------------------------------------------------- matches
ALTER TABLE legacy_x.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_clan_a_id_fkey;
ALTER TABLE legacy_x.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_clan_b_id_fkey;
ALTER TABLE legacy_x.tournament_matches DROP COLUMN IF EXISTS clan_a_id;
ALTER TABLE legacy_x.tournament_matches DROP COLUMN IF EXISTS clan_b_id;
-- team names now come from tournament_teams; a match can exist before its teams are known (TBD)
ALTER TABLE legacy_x.tournament_matches DROP COLUMN IF EXISTS team_a;
ALTER TABLE legacy_x.tournament_matches DROP COLUMN IF EXISTS team_b;
ALTER TABLE legacy_x.tournament_matches DROP COLUMN IF EXISTS score;

ALTER TABLE legacy_x.tournament_matches
  ADD COLUMN IF NOT EXISTS team_a_id uuid REFERENCES legacy_x.tournament_teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS team_b_id uuid REFERENCES legacy_x.tournament_teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS score_a integer,
  ADD COLUMN IF NOT EXISTS score_b integer,
  -- the live server (reconnect plugin heartbeat id), not the retired game_servers table
  ADD COLUMN IF NOT EXISTS server_id text REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE SET NULL;

ALTER TABLE legacy_x.tournament_matches
  ALTER COLUMN scheduled_time DROP NOT NULL,
  ALTER COLUMN scheduled_time TYPE timestamptz USING NULLIF(scheduled_time, '')::timestamptz;

ALTER TABLE legacy_x.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_teams_check,
  ADD CONSTRAINT tournament_matches_teams_check CHECK (team_a_id IS NULL OR team_b_id IS NULL OR team_a_id <> team_b_id),
  DROP CONSTRAINT IF EXISTS tournament_matches_scores_check,
  ADD CONSTRAINT tournament_matches_scores_check CHECK (coalesce(score_a, 0) >= 0 AND coalesce(score_b, 0) >= 0);

CREATE INDEX IF NOT EXISTS tournament_matches_tournament_idx ON legacy_x.tournament_matches (tournament_id, bracket_order);

-- ---------------------------------------------------------------- solo balancing
CREATE OR REPLACE FUNCTION legacy_x.balance_tournament_solo_players(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, pg_temp
AS $$
DECLARE
  v_tournament legacy_x.tournaments%ROWTYPE;
  v_solo_count integer;
  v_team_count integer;
  v_team_ids uuid[] := '{}';
  v_team_id uuid;
  v_existing integer;
  v_index integer := 0;
  v_slot integer;
  r record;
BEGIN
  SELECT * INTO v_tournament FROM legacy_x.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % not found', p_tournament_id USING ERRCODE = 'P0002';
  END IF;
  IF v_tournament.registration_closes_at IS NULL OR v_tournament.registration_closes_at > now() THEN
    RETURN 0; -- registration still open: nothing to balance yet
  END IF;

  SELECT count(*) INTO v_solo_count
  FROM legacy_x.tournament_registrations
  WHERE tournament_id = p_tournament_id AND mode = 'solo' AND team_id IS NULL;
  v_team_count := v_solo_count / v_tournament.team_size;
  IF v_team_count = 0 THEN
    RETURN 0; -- fewer solos than one team: they stay unassigned (shown as "Waiting for a team")
  END IF;

  SELECT count(*) INTO v_existing FROM legacy_x.tournament_teams WHERE tournament_id = p_tournament_id AND auto_balanced;
  FOR i IN 1..v_team_count LOOP
    INSERT INTO legacy_x.tournament_teams (tournament_id, name, auto_balanced)
    VALUES (p_tournament_id, 'Team ' || (v_existing + i), true)
    RETURNING id INTO v_team_id;
    v_team_ids := v_team_ids || v_team_id;
  END LOOP;

  -- Snake draft by EXP (highest first) so every team gets a similar total.
  FOR r IN
    SELECT reg.id, coalesce(p.current_exp, 1000) AS exp
    FROM legacy_x.tournament_registrations reg
    LEFT JOIN legacy_x.competitive_player_progression p ON p.user_id = reg.user_id
    WHERE reg.tournament_id = p_tournament_id AND reg.mode = 'solo' AND reg.team_id IS NULL
    ORDER BY coalesce(p.current_exp, 1000) DESC, reg.created_at
    LIMIT v_team_count * v_tournament.team_size
  LOOP
    v_slot := v_index % (2 * v_team_count);
    IF v_slot >= v_team_count THEN v_slot := 2 * v_team_count - 1 - v_slot; END IF;
    UPDATE legacy_x.tournament_registrations SET team_id = v_team_ids[v_slot + 1] WHERE id = r.id;
    v_index := v_index + 1;
  END LOOP;

  -- The highest-EXP player of each balanced team captains it.
  UPDATE legacy_x.tournament_teams t
  SET captain_user_id = (
    SELECT reg.user_id FROM legacy_x.tournament_registrations reg
    LEFT JOIN legacy_x.competitive_player_progression p ON p.user_id = reg.user_id
    WHERE reg.team_id = t.id ORDER BY coalesce(p.current_exp, 1000) DESC LIMIT 1)
  WHERE t.id = ANY (v_team_ids);

  RETURN v_team_count;
END;
$$;

-- ---------------------------------------------------------------- access
-- Browsers only reach these tables through the Root API (service_role), like the rest of legacy_x.
ALTER TABLE legacy_x.tournament_teams ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.tournament_teams FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE legacy_x.tournament_teams TO service_role;
REVOKE ALL ON FUNCTION legacy_x.balance_tournament_solo_players(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.balance_tournament_solo_players(uuid) TO service_role;

COMMIT;
