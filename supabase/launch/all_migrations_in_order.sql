-- LEGACY-X: every migration in the order it was first added (oldest first), in one file. Built 2026-10-10.
--
-- READ FIRST
--  * Do NOT run this on the production database: it is already up to date (checked table by table on 2026-10-10), and some of these files retire or
--    drop things (cleanup, retire_*, drop_*). Running them again on live data is not what you want.
--  * It is a runbook for a NEW, empty database, and only after the base schema (users, penalties, matches, clans, tournaments ... the tables that
--    no file here creates) has been restored from a dump of production: see supabase/launch/README.md.
--  * Each section starts with the file name; the files are unchanged.

-- ======================================================================
-- legacy_x_adminplus.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.adminplus_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type TEXT NOT NULL DEFAULT 'adminplus',
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'server',
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adminplus_audit_logs_created_at_idx
  ON legacy_x.adminplus_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS adminplus_audit_logs_action_idx
  ON legacy_x.adminplus_audit_logs (action);

ALTER TABLE legacy_x.adminplus_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.adminplus_audit_logs FROM anon, authenticated;
GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT INSERT, SELECT ON legacy_x.adminplus_audit_logs TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_api_functions.sql
-- ======================================================================
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.ensure_steam_user(
  p_steam_id TEXT,
  p_username TEXT,
  p_avatar TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  INSERT INTO legacy_x.users (steam_id, username, avatar)
  VALUES (
    p_steam_id,
    COALESCE(NULLIF(p_username, ''), 'Steam ' || p_steam_id),
    COALESCE(p_avatar, '')
  )
  ON CONFLICT (steam_id) DO UPDATE
  SET avatar = CASE
    WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar
    ELSE legacy_x.users.avatar
  END
  RETURNING id INTO v_user_id;

  INSERT INTO legacy_x.player_stats (user_id)
  VALUES (v_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.create_clan_with_leader(
  p_owner_id UUID,
  p_name TEXT,
  p_tag TEXT,
  p_logo TEXT,
  p_thumbnail TEXT,
  p_description TEXT,
  p_region TEXT,
  p_max_players INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_clan_id UUID;
BEGIN
  INSERT INTO legacy_x.clans (name, tag, logo, thumbnail, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, p_logo, p_thumbnail, p_description, p_region, p_max_players, p_owner_id)
  RETURNING id INTO v_clan_id;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (v_clan_id, p_owner_id, 'leader');

  RETURN v_clan_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.purchase_store_item(
  p_user_id UUID,
  p_item_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_price INTEGER;
  v_wallet_transaction_id UUID;
  v_purchase_id UUID;
BEGIN
  SELECT price INTO v_price
  FROM legacy_x.store_items
  WHERE id = p_item_id;

  IF v_price IS NULL THEN
    RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE legacy_x.users
  SET balance = balance - v_price
  WHERE id = p_user_id AND balance >= v_price;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient wallet balance or user not found' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type)
  VALUES (p_user_id, 'Purchase', v_price, '', 'store_purchase')
  RETURNING id INTO v_wallet_transaction_id;

  INSERT INTO legacy_x.store_purchases (user_id, item_id, price_at_purchase, wallet_transaction_id)
  VALUES (p_user_id, p_item_id, v_price, v_wallet_transaction_id)
  RETURNING id INTO v_purchase_id;

  UPDATE legacy_x.wallet_transactions
  SET reference_id = v_purchase_id
  WHERE id = v_wallet_transaction_id;

  RETURN v_purchase_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.credit_wallet(
  p_user_id UUID,
  p_amount INTEGER,
  p_method TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_transaction_id UUID;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Charge amount must be positive' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.users
  SET balance = balance + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet owner was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type)
  VALUES (p_user_id, 'Charge', p_amount, p_method, 'wallet_charge')
  RETURNING id INTO v_transaction_id;

  RETURN v_transaction_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.plugin_write_community_content(
  p_plugin_id UUID,
  p_kind TEXT,
  p_name TEXT,
  p_handle TEXT,
  p_description TEXT,
  p_partner_type TEXT,
  p_url TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_content_id UUID;
  v_action TEXT;
BEGIN
  IF p_kind = 'creator' THEN
    INSERT INTO legacy_x.community_creators (name, handle, url, created_by, created_by_id)
    VALUES (p_name, COALESCE(p_handle, ''), p_url, 'plugin', p_plugin_id)
    ON CONFLICT (url) DO UPDATE
    SET name = EXCLUDED.name,
        handle = EXCLUDED.handle,
        created_by = 'plugin',
        created_by_id = p_plugin_id
    RETURNING id INTO v_content_id;
    v_action := 'community.creator.upsert';
  ELSIF p_kind = 'partner' THEN
    INSERT INTO legacy_x.community_partners (name, description, type, url, created_by, created_by_id)
    VALUES (p_name, COALESCE(p_description, ''), p_partner_type::legacy_x.community_partner_type, p_url, 'plugin', p_plugin_id)
    ON CONFLICT (url) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        created_by = 'plugin',
        created_by_id = p_plugin_id
    RETURNING id INTO v_content_id;
    v_action := 'community.partner.upsert';
  ELSE
    RAISE EXCEPTION 'Unsupported community content kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, v_action, p_kind, v_content_id, jsonb_build_object('url', p_url));

  RETURN v_content_id;
END;
$$;

COMMIT;

-- ======================================================================
-- legacy_x_api_transactions.sql
-- ======================================================================
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.replace_user_links(
  p_user_id UUID,
  p_links TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  DELETE FROM legacy_x.user_links
  WHERE user_id = p_user_id;

  IF cardinality(p_links) > 0 THEN
    INSERT INTO legacy_x.user_links (user_id, url)
    SELECT p_user_id, link
    FROM unnest(p_links) AS link;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_player_match_result(
  p_plugin_id UUID,
  p_user_id UUID,
  p_match_id UUID,
  p_map TEXT,
  p_result legacy_x.match_result,
  p_score TEXT,
  p_kd TEXT,
  p_stats JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_history_id UUID;
BEGIN
  INSERT INTO legacy_x.player_match_history (user_id, match_id, map, result, score, kd)
  VALUES (p_user_id, p_match_id, p_map, p_result, p_score, p_kd)
  RETURNING id INTO v_history_id;

  IF p_stats IS NOT NULL THEN
    INSERT INTO legacy_x.player_stats (
      user_id, matches, wins, kills, deaths, headshots, kd_ratio, rating, experience, played_hours, last_played_at
    )
    VALUES (
      p_user_id,
      (p_stats->>'matches')::INTEGER,
      (p_stats->>'wins')::INTEGER,
      (p_stats->>'kills')::INTEGER,
      (p_stats->>'deaths')::INTEGER,
      (p_stats->>'headshots')::INTEGER,
      (p_stats->>'kd_ratio')::NUMERIC,
      (p_stats->>'rating')::NUMERIC,
      (p_stats->>'experience')::INTEGER,
      (p_stats->>'played_hours')::NUMERIC,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      matches = EXCLUDED.matches,
      wins = EXCLUDED.wins,
      kills = EXCLUDED.kills,
      deaths = EXCLUDED.deaths,
      headshots = EXCLUDED.headshots,
      kd_ratio = EXCLUDED.kd_ratio,
      rating = EXCLUDED.rating,
      experience = EXCLUDED.experience,
      played_hours = EXCLUDED.played_hours,
      last_played_at = EXCLUDED.last_played_at;
  END IF;

  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES (
    'plugin',
    p_plugin_id,
    'player_match_history.create',
    'player_match_history',
    v_history_id,
    jsonb_build_object('userId', p_user_id, 'matchId', p_match_id)
  );

  RETURN v_history_id;
END;
$$;

COMMIT;

-- ======================================================================
-- legacy_x_competitive_rank_exp.sql
-- ======================================================================
-- LEGACY-X competitive 18-rank EXP authority.
-- Additive rollout: legacy seasonal rating and community progression stay readable
-- but are not mutated by this function.

CREATE TABLE IF NOT EXISTS legacy_x.competitive_rank_definitions (
  rank_id SMALLINT PRIMARY KEY CHECK (rank_id BETWEEN 1 AND 18),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  display_name TEXT NOT NULL UNIQUE,
  minimum_exp INTEGER NOT NULL UNIQUE CHECK (minimum_exp >= 0),
  image_key TEXT NOT NULL UNIQUE,
  pro_league_eligible BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO legacy_x.competitive_rank_definitions (rank_id, slug, display_name, minimum_exp, image_key, pro_league_eligible)
VALUES
  (1, 'silver-i', 'Silver I', 0, 'rank-01', false),
  (2, 'silver-ii', 'Silver II', 1000, 'rank-02', false),
  (3, 'silver-iii', 'Silver III', 2200, 'rank-03', false),
  (4, 'silver-iv', 'Silver IV', 3600, 'rank-04', false),
  (5, 'silver-elite', 'Silver Elite', 5200, 'rank-05', false),
  (6, 'silver-elite-master', 'Silver Elite Master', 7000, 'rank-06', false),
  (7, 'gold-nova-i', 'Gold Nova I', 9000, 'rank-07', false),
  (8, 'gold-nova-ii', 'Gold Nova II', 11500, 'rank-08', false),
  (9, 'gold-nova-iii', 'Gold Nova III', 14500, 'rank-09', false),
  (10, 'gold-nova-master', 'Gold Nova Master', 18000, 'rank-10', false),
  (11, 'master-guardian-i', 'Master Guardian I', 22000, 'rank-11', true),
  (12, 'master-guardian-ii', 'Master Guardian II', 26500, 'rank-12', true),
  (13, 'master-guardian-elite', 'Master Guardian Elite', 31500, 'rank-13', true),
  (14, 'distinguished-master-guardian', 'Distinguished Master Guardian', 37000, 'rank-14', true),
  (15, 'legendary-eagle', 'Legendary Eagle', 43000, 'rank-15', true),
  (16, 'legendary-eagle-master', 'Legendary Eagle Master', 50000, 'rank-16', true),
  (17, 'supreme-master-first-class', 'Supreme Master First Class', 58000, 'rank-17', true),
  (18, 'global-elite', 'Global Elite', 67000, 'rank-18', true)
ON CONFLICT (rank_id) DO UPDATE SET
  slug = EXCLUDED.slug,
  display_name = EXCLUDED.display_name,
  minimum_exp = EXCLUDED.minimum_exp,
  image_key = EXCLUDED.image_key,
  pro_league_eligible = EXCLUDED.pro_league_eligible;

CREATE TABLE IF NOT EXISTS legacy_x.competitive_player_progression (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  current_exp INTEGER NOT NULL DEFAULT 0 CHECK (current_exp >= 0),
  current_rank_id SMALLINT NOT NULL DEFAULT 1 REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  pro_league_unlocked BOOLEAN NOT NULL DEFAULT false,
  matches_completed INTEGER NOT NULL DEFAULT 0 CHECK (matches_completed >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  assists INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
  headshot_kills INTEGER NOT NULL DEFAULT 0 CHECK (headshot_kills >= 0),
  last_match_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.competitive_event_receipts (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 220),
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 3 AND 120),
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS legacy_x.competitive_exp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.competitive_event_receipts(event_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'match_win', 'match_loss', 'round_win', 'kill', 'assist', 'headshot_kill',
    'mvp', 'bomb_plant', 'bomb_defuse', 'bomb_explode', 'hostage_rescue',
    'clutch', 'first_kill', 'multi_kill_3plus', 'ace'
  )),
  exp_amount INTEGER NOT NULL CHECK (exp_amount > 0 AND exp_amount <= 20000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id, action)
);

CREATE INDEX IF NOT EXISTS competitive_progression_exp_idx
  ON legacy_x.competitive_player_progression (current_exp DESC, updated_at ASC);
CREATE INDEX IF NOT EXISTS competitive_exp_ledger_user_idx
  ON legacy_x.competitive_exp_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS competitive_exp_ledger_match_idx
  ON legacy_x.competitive_exp_ledger (match_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.competitive_metric(p_stats JSONB, p_key TEXT, p_cap INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw TEXT;
  v_value INTEGER;
BEGIN
  v_raw := NULLIF(COALESCE(p_stats ->> p_key, ''), '');
  IF v_raw IS NULL THEN RETURN 0; END IF;
  IF v_raw !~ '^\d+$' THEN
    RAISE EXCEPTION 'competitive stat % must be a non-negative integer', p_key USING ERRCODE = '22023';
  END IF;
  v_value := v_raw::INTEGER;
  IF v_value > p_cap THEN
    RAISE EXCEPTION 'competitive stat % exceeds validated cap', p_key USING ERRCODE = '22023';
  END IF;
  RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.competitive_rank_for_exp(p_exp INTEGER)
RETURNS TABLE (rank_id SMALLINT, display_name TEXT, image_key TEXT, pro_league_eligible BOOLEAN)
LANGUAGE sql
STABLE
AS $$
  SELECT d.rank_id, d.display_name, d.image_key, d.pro_league_eligible
  FROM legacy_x.competitive_rank_definitions d
  WHERE d.minimum_exp <= GREATEST(p_exp, 0)
  ORDER BY d.minimum_exp DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_competitive_match_result(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_competitive JSONB;
  v_team_key TEXT;
  v_team JSONB;
  v_player JSONB;
  v_stats JSONB;
  v_user_id UUID;
  v_role TEXT;
  v_player_team TEXT;
  v_steam_id TEXT;
  v_winner TEXT;
  v_round_wins INTEGER;
  v_total_rounds INTEGER := 0;
  v_kills INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_mvps INTEGER;
  v_bomb_plants INTEGER;
  v_bomb_defuses INTEGER;
  v_bomb_explodes INTEGER;
  v_hostage_rescues INTEGER;
  v_clutches INTEGER;
  v_first_kills INTEGER;
  v_multi_kills INTEGER;
  v_aces INTEGER;
  v_total_exp INTEGER;
  v_current_exp INTEGER;
  v_rank_id SMALLINT;
  v_rank_name TEXT;
  v_pro BOOLEAN;
  v_action TEXT;
  v_amount INTEGER;
  v_rewarded_players INTEGER := 0;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Only legacyx-match-core may award competitive EXP' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload ->> 'event_id', '') <> p_event_id OR COALESCE(p_payload ->> 'event_type', '') <> 'result_final' THEN
    RAISE EXCEPTION 'competitive EXP requires a matching Match Core result_final event' USING ERRCODE = '22023';
  END IF;

  v_match_id := (p_payload ->> 'match_id')::UUID;
  v_competitive := p_payload #> '{result,competitive_result}';
  IF v_competitive IS NULL OR jsonb_typeof(v_competitive) <> 'object' THEN
    RAISE EXCEPTION 'competitive_result is required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE((v_competitive ->> 'schema_version')::INTEGER, 0) <> 1
     OR COALESCE((v_competitive ->> 'reward_eligible')::BOOLEAN, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'competitive_result is not eligible' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.competitive_event_receipts (event_id, plugin_id, match_id, payload)
  VALUES (p_event_id, p_plugin_id, v_match_id, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  SELECT * INTO v_match
  FROM legacy_x.core_matches
  WHERE id = v_match_id
  FOR UPDATE;
  IF NOT FOUND OR v_match.state <> 'FINISHED' OR v_match.final_event_id <> p_event_id THEN
    RAISE EXCEPTION 'competitive EXP requires the stored final Match Core event' USING ERRCODE = '22023';
  END IF;
  IF (SELECT COUNT(*) FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND eligible_for_rewards) <> 10
     OR EXISTS (SELECT 1 FROM legacy_x.core_match_slots WHERE match_id = v_match_id AND active_role = 'fill') THEN
    RAISE EXCEPTION 'competitive EXP requires ten original eligible players and no fill player' USING ERRCODE = '22023';
  END IF;

  v_winner := COALESCE(v_competitive ->> 'winner_team', '');
  IF v_winner NOT IN ('team1', 'team2') THEN
    RAISE EXCEPTION 'competitive result requires one winning team' USING ERRCODE = '22023';
  END IF;

  FOR v_team_key IN SELECT unnest(ARRAY['team1', 'team2']) LOOP
    v_team := v_competitive -> v_team_key;
    IF v_team IS NULL OR jsonb_typeof(v_team -> 'players') <> 'array' OR jsonb_array_length(v_team -> 'players') <> 5 THEN
      RAISE EXCEPTION 'competitive result requires exactly five players per team' USING ERRCODE = '22023';
    END IF;
    v_round_wins := legacy_x.competitive_metric(v_team, 'round_wins', 32);
    v_total_rounds := v_total_rounds + v_round_wins;

    FOR v_player IN SELECT value FROM jsonb_array_elements(v_team -> 'players') LOOP
      v_steam_id := COALESCE(v_player ->> 'steam_id', v_player ->> 'steamid');
      IF v_steam_id !~ '^\d{15,20}$' THEN
        RAISE EXCEPTION 'competitive player SteamID is invalid' USING ERRCODE = '22023';
      END IF;
      SELECT cmp.user_id, cmp.team_key, u.role INTO v_user_id, v_player_team, v_role
      FROM legacy_x.core_match_participants cmp
      JOIN legacy_x.users u ON u.id = cmp.user_id
      WHERE cmp.match_id = v_match_id AND cmp.steam_id = v_steam_id AND cmp.eligible_for_rewards
      FOR UPDATE;
      IF NOT FOUND OR v_player_team <> v_team_key THEN
        RAISE EXCEPTION 'competitive payload roster does not match Match Core roster' USING ERRCODE = '22023';
      END IF;
      -- Owner accounts never receive competitive state, history, or rewards.
      IF v_role = 'Owner' THEN CONTINUE; END IF;

      v_stats := COALESCE(v_player -> 'stats', '{}'::JSONB);
      v_kills := legacy_x.competitive_metric(v_stats, 'kills', 120);
      v_assists := legacy_x.competitive_metric(v_stats, 'assists', 100);
      v_headshots := legacy_x.competitive_metric(v_stats, 'headshot_kills', v_kills);
      v_mvps := legacy_x.competitive_metric(v_stats, 'mvps', 32);
      v_bomb_plants := legacy_x.competitive_metric(v_stats, 'bomb_plants', 32);
      v_bomb_defuses := legacy_x.competitive_metric(v_stats, 'bomb_defuses', 32);
      v_bomb_explodes := legacy_x.competitive_metric(v_stats, 'bomb_explodes', 32);
      v_hostage_rescues := legacy_x.competitive_metric(v_stats, 'hostage_rescues', 32);
      v_clutches := legacy_x.competitive_metric(v_stats, 'clutches', 32);
      v_first_kills := legacy_x.competitive_metric(v_stats, 'first_kills', 32);
      v_multi_kills := legacy_x.competitive_metric(v_stats, 'multi_kills_3plus', 32);
      v_aces := legacy_x.competitive_metric(v_stats, 'aces', 32);

      v_total_exp := 0;
      FOR v_action, v_amount IN
        SELECT * FROM (VALUES
          (CASE WHEN v_team_key = v_winner THEN 'match_win' ELSE 'match_loss' END, CASE WHEN v_team_key = v_winner THEN 500 ELSE 200 END),
          ('round_win', v_round_wins * 25),
          ('kill', v_kills * 20),
          ('assist', v_assists * 10),
          ('headshot_kill', v_headshots * 10),
          ('mvp', v_mvps * 50),
          ('bomb_plant', v_bomb_plants * 20),
          ('bomb_defuse', v_bomb_defuses * 30),
          ('bomb_explode', v_bomb_explodes * 30),
          ('hostage_rescue', v_hostage_rescues * 30),
          ('clutch', v_clutches * 50),
          ('first_kill', v_first_kills * 15),
          ('multi_kill_3plus', v_multi_kills * 30),
          ('ace', v_aces * 100)
        ) AS rewards(action, amount)
      LOOP
        IF v_amount > 0 THEN
          INSERT INTO legacy_x.competitive_exp_ledger (event_id, user_id, match_id, action, exp_amount, metadata)
          VALUES (p_event_id, v_user_id, v_match_id, v_action, v_amount, jsonb_build_object('team', v_team_key, 'winner', v_winner, 'stats', v_stats));
          v_total_exp := v_total_exp + v_amount;
        END IF;
      END LOOP;

      SELECT current_exp INTO v_current_exp
      FROM legacy_x.competitive_player_progression
      WHERE user_id = v_user_id
      FOR UPDATE;
      v_current_exp := GREATEST(0, COALESCE(v_current_exp, 0) + v_total_exp);
      SELECT rank_id, display_name, pro_league_eligible
      INTO v_rank_id, v_rank_name, v_pro
      FROM legacy_x.competitive_rank_for_exp(v_current_exp);

      INSERT INTO legacy_x.competitive_player_progression (
        user_id, current_exp, current_rank_id, pro_league_unlocked, matches_completed, wins, losses,
        kills, assists, headshot_kills, last_match_at
      ) VALUES (
        v_user_id, v_current_exp, v_rank_id, v_pro, 1,
        CASE WHEN v_team_key = v_winner THEN 1 ELSE 0 END,
        CASE WHEN v_team_key = v_winner THEN 0 ELSE 1 END,
        v_kills, v_assists, v_headshots, now()
      ) ON CONFLICT (user_id) DO UPDATE SET
        current_exp = EXCLUDED.current_exp,
        current_rank_id = EXCLUDED.current_rank_id,
        pro_league_unlocked = EXCLUDED.pro_league_unlocked,
        matches_completed = legacy_x.competitive_player_progression.matches_completed + 1,
        wins = legacy_x.competitive_player_progression.wins + EXCLUDED.wins,
        losses = legacy_x.competitive_player_progression.losses + EXCLUDED.losses,
        kills = legacy_x.competitive_player_progression.kills + EXCLUDED.kills,
        assists = legacy_x.competitive_player_progression.assists + EXCLUDED.assists,
        headshot_kills = legacy_x.competitive_player_progression.headshot_kills + EXCLUDED.headshot_kills,
        last_match_at = now(),
        updated_at = now();

      -- Compatibility field only. Canonical EXP/rank remains the competitive tables above.
      UPDATE legacy_x.users SET rank = v_rank_name, updated_at = now() WHERE id = v_user_id;
      v_rewarded_players := v_rewarded_players + 1;
    END LOOP;
  END LOOP;

  IF v_total_rounds < 13 THEN
    RAISE EXCEPTION 'competitive result is too short for rewards' USING ERRCODE = '22023';
  END IF;
  UPDATE legacy_x.competitive_event_receipts SET processed_at = now() WHERE event_id = p_event_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'competitive.exp.match.ingest', 'competitive_match', v_match_id, jsonb_build_object('eventId', p_event_id, 'playersRewarded', v_rewarded_players));
  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'match_id', v_match_id, 'players_rewarded', v_rewarded_players);
END;
$$;

CREATE OR REPLACE VIEW legacy_x.competitive_player_profiles AS
SELECT
  cpp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cpp.current_exp,
  d.rank_id,
  d.slug AS rank_slug,
  d.display_name AS rank_name,
  d.image_key AS rank_image_key,
  cpp.pro_league_unlocked,
  cpp.matches_completed,
  cpp.wins,
  cpp.losses,
  cpp.kills,
  cpp.assists,
  cpp.headshot_kills,
  cpp.last_match_at
FROM legacy_x.competitive_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id;

CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cp.current_exp DESC, cp.wins DESC, cp.kills DESC, cp.updated_at ASC) AS position,
  cp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cp.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  cp.pro_league_unlocked,
  cp.matches_completed,
  cp.wins,
  cp.losses,
  cp.kills,
  cp.assists,
  cp.headshot_kills,
  cp.last_match_at,
  COALESCE(ps.deaths, 0) AS deaths,
  COALESCE(ps.kd_ratio, 0) AS kd_ratio,
  COALESCE(ps.played_hours, 0) AS played_hours
FROM legacy_x.competitive_player_progression cp
JOIN legacy_x.users u ON u.id = cp.user_id
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = cp.current_rank_id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = cp.user_id;

ALTER TABLE legacy_x.competitive_rank_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.competitive_player_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.competitive_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.competitive_exp_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts, legacy_x.competitive_exp_ledger FROM anon, authenticated;
REVOKE ALL ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard FROM anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.competitive_rank_definitions, legacy_x.competitive_player_progression, legacy_x.competitive_event_receipts, legacy_x.competitive_exp_ledger TO service_role;
GRANT SELECT ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) TO service_role;

-- ======================================================================
-- legacy_x_competitive_rank_exp_function_privileges.sql
-- ======================================================================
REVOKE ALL ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.competitive_metric(JSONB, TEXT, INTEGER), legacy_x.competitive_rank_for_exp(INTEGER), legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) TO service_role;

-- ======================================================================
-- legacy_x_competitive_rank_exp_leaderboard_fields.sql
-- ======================================================================
CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cp.current_exp DESC, cp.wins DESC, cp.kills DESC, cp.updated_at ASC) AS position,
  cp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cp.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  cp.pro_league_unlocked,
  cp.matches_completed,
  cp.wins,
  cp.losses,
  cp.kills,
  cp.assists,
  cp.headshot_kills,
  cp.last_match_at,
  COALESCE(ps.deaths, 0) AS deaths,
  COALESCE(ps.kd_ratio, 0) AS kd_ratio,
  COALESCE(ps.played_hours, 0) AS played_hours
FROM legacy_x.competitive_player_progression cp
JOIN legacy_x.users u ON u.id = cp.user_id
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = cp.current_rank_id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = cp.user_id;

-- ======================================================================
-- legacy_x_competitive_rank_progress_fields.sql
-- ======================================================================
CREATE OR REPLACE VIEW legacy_x.competitive_player_profiles AS
SELECT
  cpp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cpp.current_exp,
  d.rank_id,
  d.slug AS rank_slug,
  d.display_name AS rank_name,
  d.image_key AS rank_image_key,
  cpp.pro_league_unlocked,
  cpp.matches_completed,
  cpp.wins,
  cpp.losses,
  cpp.kills,
  cpp.assists,
  cpp.headshot_kills,
  cpp.last_match_at,
  d.minimum_exp AS current_rank_min_exp,
  next_d.rank_id AS next_rank_id,
  next_d.display_name AS next_rank_name,
  next_d.minimum_exp AS next_rank_min_exp
FROM legacy_x.competitive_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;

-- ======================================================================
-- legacy_x_drop_users_staff_fields.sql
-- ======================================================================
-- LEGACY-X canonical staff model cleanup.
-- Prerequisite: deploy the role-free backend/frontend revision before executing.
-- This is intentionally destructive only for legacy users.role and users.is_staff.
-- A one-time backup is retained in legacy_x.users_staff_fields_backup_20260826.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.users_staff_fields_backup_20260826 (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  legacy_role text,
  legacy_is_staff boolean,
  captured_at timestamptz NOT NULL DEFAULT now()
);

-- to_jsonb keeps this statement re-runnable even if either legacy column is already absent.
INSERT INTO legacy_x.users_staff_fields_backup_20260826 (user_id, legacy_role, legacy_is_staff)
SELECT
  u.id,
  to_jsonb(u) ->> 'role',
  CASE
    WHEN to_jsonb(u) ->> 'is_staff' IN ('true', 'false')
      THEN (to_jsonb(u) ->> 'is_staff')::boolean
    ELSE NULL
  END
FROM legacy_x.users AS u
ON CONFLICT (user_id) DO NOTHING;

-- Rebuild the latest public competitive projections without users.role.
-- This must happen before DROP COLUMN because these views otherwise depend on it.
CREATE OR REPLACE VIEW legacy_x.competitive_player_profiles AS
SELECT
  cpp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cpp.current_exp,
  d.rank_id,
  d.slug AS rank_slug,
  d.display_name AS rank_name,
  d.image_key AS rank_image_key,
  cpp.pro_league_unlocked,
  cpp.matches_completed,
  cpp.wins,
  cpp.losses,
  cpp.kills,
  cpp.assists,
  cpp.headshot_kills,
  cpp.last_match_at,
  d.minimum_exp AS current_rank_min_exp,
  next_d.rank_id AS next_rank_id,
  next_d.display_name AS next_rank_name,
  next_d.minimum_exp AS next_rank_min_exp
FROM legacy_x.competitive_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = cpp.current_rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;

CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cp.current_exp DESC, cp.wins DESC, cp.kills DESC, cp.updated_at ASC) AS position,
  cp.user_id,
  u.steam_id,
  u.username,
  u.avatar,
  cp.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  cp.pro_league_unlocked,
  cp.matches_completed,
  cp.wins,
  cp.losses,
  cp.kills,
  cp.assists,
  cp.headshot_kills,
  cp.last_match_at,
  COALESCE(ps.deaths, 0) AS deaths,
  COALESCE(ps.kd_ratio, 0) AS kd_ratio,
  COALESCE(ps.played_hours, 0) AS played_hours
FROM legacy_x.competitive_player_progression cp
JOIN legacy_x.users u ON u.id = cp.user_id
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = cp.current_rank_id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = cp.user_id;

REVOKE ALL ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard FROM anon, authenticated;
GRANT SELECT ON legacy_x.competitive_player_profiles, legacy_x.competitive_leaderboard TO service_role;

DROP TRIGGER IF EXISTS users_sync_staff_from_role ON legacy_x.users;
DROP FUNCTION IF EXISTS legacy_x.sync_users_staff_from_role();
DROP INDEX IF EXISTS legacy_x.users_role_idx;
ALTER TABLE legacy_x.users DROP CONSTRAINT IF EXISTS users_role_allowed;
ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS is_staff;
ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS role;

COMMIT;

-- Non-sensitive verification.
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'legacy_x'
--   AND table_name = 'users'
--   AND column_name IN ('role', 'is_staff');
-- Expected: zero rows.

-- Rollback only if the deployed role-free code has not yet been restarted.
-- ALTER TABLE legacy_x.users ADD COLUMN IF NOT EXISTS role text;
-- ALTER TABLE legacy_x.users ADD COLUMN IF NOT EXISTS is_staff boolean;
-- UPDATE legacy_x.users AS u
-- SET role = b.legacy_role,
--     is_staff = b.legacy_is_staff
-- FROM legacy_x.users_staff_fields_backup_20260826 AS b
-- WHERE b.user_id = u.id;

-- ======================================================================
-- legacy_x_feedback_weekly_cooldown.sql
-- ======================================================================
-- Enforce the LEGACY-X rule: one feedback review per user every seven days.
-- The advisory transaction lock makes simultaneous requests from the same user atomic.
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.submit_feedback_weekly(
  p_user_id uuid,
  p_name text,
  p_rating integer,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_last_created_at timestamptz;
  v_feedback legacy_x.feedback%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT created_at
  INTO v_last_created_at
  FROM legacy_x.feedback
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_last_created_at IS NOT NULL
     AND v_last_created_at > now() - interval '7 days' THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'next_eligible_at', v_last_created_at + interval '7 days'
    );
  END IF;

  INSERT INTO legacy_x.feedback (user_id, name, rating, message)
  VALUES (p_user_id, p_name, p_rating, p_message)
  RETURNING * INTO v_feedback;

  RETURN jsonb_build_object(
    'accepted', true,
    'feedback', jsonb_build_object(
      'id', v_feedback.id,
      'user_id', v_feedback.user_id,
      'name', v_feedback.name,
      'rating', v_feedback.rating,
      'message', v_feedback.message,
      'created_at', v_feedback.created_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.submit_feedback_weekly(uuid, text, integer, text) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_legacy_rls_hardening.sql
-- ======================================================================
BEGIN;

-- LEGACY-X browser clients call the Root API only. They never need direct
-- PostgREST access to legacy business tables. The Root API uses service_role,
-- which was verified to have BYPASSRLS and retains its explicit table grants.
-- Do not add permissive anon/authenticated policies here.

REVOKE ALL ON TABLE
  legacy_x.users,
  legacy_x.user_sessions,
  legacy_x.user_links,
  legacy_x.player_stats,
  legacy_x.maps,
  legacy_x.game_servers,
  legacy_x.matches,
  legacy_x.player_match_history,
  legacy_x.match_favorites,
  legacy_x.clans,
  legacy_x.clan_members,
  legacy_x.staff_team,
  legacy_x.tournaments,
  legacy_x.tournament_registrations,
  legacy_x.tournament_matches,
  legacy_x.store_items,
  legacy_x.wallet_transactions,
  legacy_x.store_purchases,
  legacy_x.penalties,
  legacy_x.feedback,
  legacy_x.api_tokens,
  legacy_x.community_creators,
  legacy_x.community_partners,
  legacy_x.audit_logs
FROM anon, authenticated;

ALTER TABLE legacy_x.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.user_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.player_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.game_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.player_match_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.match_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clans ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.staff_team ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.tournament_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.tournament_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.store_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.store_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.penalties ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_creators ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.audit_logs ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  legacy_x.users,
  legacy_x.user_sessions,
  legacy_x.user_links,
  legacy_x.player_stats,
  legacy_x.maps,
  legacy_x.game_servers,
  legacy_x.matches,
  legacy_x.player_match_history,
  legacy_x.match_favorites,
  legacy_x.clans,
  legacy_x.clan_members,
  legacy_x.staff_team,
  legacy_x.tournaments,
  legacy_x.tournament_registrations,
  legacy_x.tournament_matches,
  legacy_x.store_items,
  legacy_x.wallet_transactions,
  legacy_x.store_purchases,
  legacy_x.penalties,
  legacy_x.feedback,
  legacy_x.api_tokens,
  legacy_x.community_creators,
  legacy_x.community_partners,
  legacy_x.audit_logs
TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_match_core.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.core_matches (
  id UUID PRIMARY KEY,
  server_id TEXT NOT NULL,
  matchzy_local_id TEXT,
  season_id UUID REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('WAITING', 'LIVE', 'PAUSED', 'FINISHED', 'CANCELLED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  map_name TEXT NOT NULL,
  map_number INTEGER NOT NULL DEFAULT 0 CHECK (map_number >= 0),
  pause_reason TEXT,
  paused_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  final_event_id TEXT UNIQUE,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_participants (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 1 AND 5),
  original_name TEXT NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT true,
  disconnected_at TIMESTAMPTZ,
  reconnect_deadline TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  eligible_for_rewards BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, steam_id),
  UNIQUE (match_id, team_key, slot_index)
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_slots (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 1 AND 5),
  original_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  active_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  active_role TEXT CHECK (active_role IN ('original', 'fill')),
  fill_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, team_key, slot_index),
  CHECK ((active_user_id IS NULL AND active_role IS NULL) OR (active_user_id IS NOT NULL AND active_role IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_player_snapshots (
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, snapshot_revision)
);

CREATE TABLE IF NOT EXISTS legacy_x.core_match_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('match_created', 'state_transition', 'player_disconnected', 'player_returned', 'fill_assigned', 'fill_removed', 'snapshot_saved', 'result_final', 'match_cancelled')),
  expected_revision INTEGER,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS core_matches_state_idx ON legacy_x.core_matches (state, updated_at DESC);
CREATE INDEX IF NOT EXISTS core_participants_steam_idx ON legacy_x.core_match_participants (steam_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS core_events_match_idx ON legacy_x.core_match_events (match_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.core_match_active_slots_ready(p_match_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT COUNT(*) = 10
  FROM legacy_x.core_match_slots
  WHERE match_id = p_match_id
    AND active_user_id IS NOT NULL
    AND active_role IN ('original', 'fill');
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_core_match_event(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_type TEXT := COALESCE(p_payload->>'event_type', '');
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_team JSONB;
  v_player JSONB;
  v_user_id UUID;
  v_steam_id TEXT;
  v_team_key TEXT;
  v_slot INTEGER;
  v_expected INTEGER;
  v_new_state TEXT;
  v_participant legacy_x.core_match_participants%ROWTYPE;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Unsupported Match Core plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_type = 'match_created' THEN
    v_match_id := (p_payload->>'match_id')::UUID;
    IF jsonb_array_length(COALESCE(p_payload->'participants', '[]'::jsonb)) <> 10 THEN
      RAISE EXCEPTION 'match_created requires exactly 10 original participants' USING ERRCODE = '22023';
    END IF;
    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, season_id, state, map_name, map_number)
    SELECT v_match_id,
           p_payload->>'server_id',
           NULLIF(p_payload->>'matchzy_local_id', ''),
           rs.id,
           'WAITING',
           p_payload->>'map_name',
           COALESCE((p_payload->>'map_number')::INTEGER, 0)
      FROM legacy_x.rank_seasons rs
     WHERE rs.is_active
     ORDER BY rs.created_at DESC
     LIMIT 1
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    FOR v_player IN SELECT value FROM jsonb_array_elements(p_payload->'participants') LOOP
      v_steam_id := v_player->>'steam_id';
      v_team_key := v_player->>'team_key';
      v_slot := (v_player->>'slot_index')::INTEGER;
      IF v_steam_id !~ '^\d{15,20}$' OR v_team_key NOT IN ('team1', 'team2') OR v_slot NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'invalid original participant' USING ERRCODE = '22023';
      END IF;
      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;
      INSERT INTO legacy_x.core_match_participants (match_id, user_id, steam_id, team_key, slot_index, original_name)
      VALUES (v_match_id, v_user_id, v_steam_id, v_team_key, v_slot, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id));
      INSERT INTO legacy_x.core_match_slots (match_id, team_key, slot_index, original_user_id, active_user_id, active_role)
      VALUES (v_match_id, v_team_key, v_slot, v_user_id, v_user_id, 'original');
    END LOOP;
    RETURN jsonb_build_object('status', 'created', 'match_id', v_match_id, 'state', 'WAITING', 'revision', 1);
  END IF;

  v_match_id := (p_payload->>'match_id')::UUID;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = v_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  v_expected := COALESCE((p_payload->>'expected_revision')::INTEGER, -1);
  IF v_expected <> v_match.revision THEN
    RETURN jsonb_build_object('status', 'stale', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, v_match_id, v_type, v_expected, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  IF v_type = 'state_transition' THEN
    v_new_state := p_payload->>'state';
    IF (v_match.state = 'WAITING' AND v_new_state = 'LIVE') OR
       (v_match.state = 'LIVE' AND v_new_state = 'PAUSED') OR
       (v_match.state = 'PAUSED' AND v_new_state = 'LIVE') OR
       (v_match.state IN ('LIVE', 'PAUSED') AND v_new_state IN ('FINISHED', 'CANCELLED')) THEN
      IF v_new_state = 'LIVE' AND NOT legacy_x.core_match_active_slots_ready(v_match_id) THEN
        RAISE EXCEPTION 'cannot resume without exactly ten active slots' USING ERRCODE = '22023';
      END IF;
      UPDATE legacy_x.core_matches SET
        state = v_new_state,
        revision = revision + 1,
        pause_reason = CASE WHEN v_new_state = 'PAUSED' THEN COALESCE(p_payload->>'reason', 'unspecified') ELSE NULL END,
        paused_at = CASE WHEN v_new_state = 'PAUSED' THEN now() ELSE paused_at END,
        started_at = CASE WHEN v_new_state = 'LIVE' AND started_at IS NULL THEN now() ELSE started_at END,
        finished_at = CASE WHEN v_new_state = 'FINISHED' THEN now() ELSE finished_at END,
        cancelled_at = CASE WHEN v_new_state = 'CANCELLED' THEN now() ELSE cancelled_at END,
        updated_at = now()
      WHERE id = v_match_id
      RETURNING * INTO v_match;
    ELSE
      RAISE EXCEPTION 'invalid state transition % -> %', v_match.state, v_new_state USING ERRCODE = '22023';
    END IF;
  ELSIF v_type IN ('player_disconnected', 'player_returned') THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT * INTO v_participant FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'player is not an original participant' USING ERRCODE = '22023'; END IF;
    IF v_type = 'player_disconnected' THEN
      UPDATE legacy_x.core_match_participants SET connected = false, disconnected_at = now(), reconnect_deadline = now() + make_interval(secs => COALESCE((p_payload->>'reconnect_window_seconds')::INTEGER, 300)), updated_at = now()
      WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = NULL, active_role = NULL, updated_at = now()
      WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      IF v_match.state = 'LIVE' THEN
        UPDATE legacy_x.core_matches SET state = 'PAUSED', pause_reason = 'original_participant_disconnected', paused_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      ELSE
        UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      END IF;
    ELSE
      IF v_participant.reconnect_deadline IS NOT NULL AND v_participant.reconnect_deadline < now() THEN RAISE EXCEPTION 'reconnect window expired' USING ERRCODE = '22023'; END IF;
      UPDATE legacy_x.core_match_participants SET connected = true, returned_at = now(), updated_at = now() WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = v_participant.user_id, active_role = 'original', fill_user_id = NULL, updated_at = now() WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
    END IF;
  ELSIF v_type = 'fill_assigned' THEN
    v_team_key := p_payload->>'team_key'; v_slot := (p_payload->>'slot_index')::INTEGER; v_steam_id := p_payload->>'steam_id';
    INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (v_steam_id, COALESCE(NULLIF(p_payload->>'name', ''), 'Steam ' || v_steam_id), '') ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username RETURNING id INTO v_user_id;
    UPDATE legacy_x.core_match_slots SET active_user_id = v_user_id, active_role = 'fill', fill_user_id = v_user_id, updated_at = now()
    WHERE match_id = v_match_id AND team_key = v_team_key AND slot_index = v_slot AND active_user_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'requested fill slot is not empty' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'snapshot_saved' THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT user_id INTO v_user_id FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'snapshot player is not an original participant' USING ERRCODE = '22023'; END IF;
    INSERT INTO legacy_x.core_match_player_snapshots (match_id, user_id, snapshot_revision, snapshot)
    VALUES (v_match_id, v_user_id, v_match.revision, p_payload->'snapshot');
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'result_final' THEN
    IF v_match.state NOT IN ('LIVE', 'PAUSED') THEN RAISE EXCEPTION 'result only valid from LIVE or PAUSED' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET state = 'FINISHED', final_event_id = p_event_id, result = p_payload->'result', finished_at = now(), revision = revision + 1, updated_at = now()
    WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'match_cancelled' THEN
    UPDATE legacy_x.core_matches SET state = 'CANCELLED', cancelled_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSE
    RAISE EXCEPTION 'unsupported Match Core event type %', v_type USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('status', 'processed', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(v_match_id));
END;
$$;

CREATE OR REPLACE VIEW legacy_x.core_match_history AS
SELECT
  cm.id AS match_id,
  cm.server_id,
  cm.matchzy_local_id,
  cm.state,
  cm.map_name,
  cm.map_number,
  cm.started_at,
  cm.finished_at,
  cm.result,
  rs.slug AS season_slug,
  COUNT(cmp.user_id) AS original_participant_count
FROM legacy_x.core_matches cm
LEFT JOIN legacy_x.rank_seasons rs ON rs.id = cm.season_id
LEFT JOIN legacy_x.core_match_participants cmp ON cmp.match_id = cm.id
GROUP BY cm.id, rs.slug;

ALTER TABLE legacy_x.core_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_player_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.core_match_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.core_matches, legacy_x.core_match_participants, legacy_x.core_match_slots, legacy_x.core_match_player_snapshots, legacy_x.core_match_events FROM anon, authenticated;
REVOKE ALL ON legacy_x.core_match_history FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.core_matches, legacy_x.core_match_participants, legacy_x.core_match_slots, legacy_x.core_match_player_snapshots, legacy_x.core_match_events TO service_role;
GRANT SELECT ON legacy_x.core_match_history TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB), legacy_x.core_match_active_slots_ready(UUID) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_match_core_fill_lifecycle.sql
-- ======================================================================
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.core_match_slot_fill_reward_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  IF NEW.active_role = 'fill' AND COALESCE(OLD.active_role, '') <> 'fill' THEN
    UPDATE legacy_x.core_match_participants
    SET eligible_for_rewards = false, updated_at = now()
    WHERE match_id = NEW.match_id AND user_id = NEW.original_user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS core_match_slot_fill_reward_policy_trigger ON legacy_x.core_match_slots;
CREATE TRIGGER core_match_slot_fill_reward_policy_trigger
AFTER UPDATE OF active_role ON legacy_x.core_match_slots
FOR EACH ROW EXECUTE FUNCTION legacy_x.core_match_slot_fill_reward_policy();

CREATE OR REPLACE FUNCTION legacy_x.remove_core_match_fill(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_match_id UUID,
  p_expected_revision INTEGER,
  p_steam_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_match legacy_x.core_matches%ROWTYPE;
  v_fill_user_id UUID;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN RAISE EXCEPTION 'Unsupported Match Core plugin' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  IF p_expected_revision <> v_match.revision THEN RETURN jsonb_build_object('status', 'stale', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision); END IF;
  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, p_match_id, 'fill_removed', p_expected_revision, jsonb_build_object('steam_id', p_steam_id))
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'duplicate', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision); END IF;
  SELECT id INTO v_fill_user_id FROM legacy_x.users WHERE steam_id = p_steam_id;
  UPDATE legacy_x.core_match_slots
  SET active_user_id = NULL, active_role = NULL, fill_user_id = NULL, updated_at = now()
  WHERE match_id = p_match_id AND active_user_id = v_fill_user_id AND active_role = 'fill';
  IF NOT FOUND THEN RAISE EXCEPTION 'active temporary fill not found' USING ERRCODE = '22023'; END IF;
  UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = p_match_id RETURNING * INTO v_match;
  RETURN jsonb_build_object('status', 'processed', 'match_id', p_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(p_match_id));
END;
$$;

GRANT EXECUTE ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_match_core_security_hardening.sql
-- ======================================================================
BEGIN;

REVOKE ALL ON FUNCTION legacy_x.core_match_active_slots_ready(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.core_match_slot_fill_reward_policy() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION legacy_x.core_match_active_slots_ready(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_core_match_event(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.remove_core_match_fill(TEXT, TEXT, UUID, INTEGER, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_membership_safety.sql
-- ======================================================================
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.create_clan_with_leader(
  p_owner_id UUID,
  p_name TEXT,
  p_tag TEXT,
  p_logo TEXT,
  p_thumbnail TEXT,
  p_description TEXT,
  p_region TEXT,
  p_max_players INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_clan_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_owner_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.clans (name, tag, logo, thumbnail, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, p_logo, p_thumbnail, p_description, p_region, p_max_players, p_owner_id)
  RETURNING id INTO v_clan_id;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (v_clan_id, p_owner_id, 'leader');

  RETURN v_clan_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.join_clan(
  p_user_id UUID,
  p_clan_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_max_players INTEGER;
  v_member_count INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;

  SELECT max_players INTO v_max_players
  FROM legacy_x.clans
  WHERE id = p_clan_id
  FOR UPDATE;

  IF v_max_players IS NULL THEN
    RAISE EXCEPTION 'Clan was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_member_count
  FROM legacy_x.clan_members
  WHERE clan_id = p_clan_id;

  IF v_member_count >= v_max_players THEN
    RAISE EXCEPTION 'Clan is full' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO legacy_x.clan_members (clan_id, user_id, role)
  VALUES (p_clan_id, p_user_id, 'member');
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.delete_owned_clan(
  p_owner_id UUID,
  p_clan_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  DELETE FROM legacy_x.clans
  WHERE id = p_clan_id AND owner_id = p_owner_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clan was not found or is not owned by this user' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMIT;

-- ======================================================================
-- legacy_x_monthly_rank_reset.sql
-- ======================================================================
BEGIN;

ALTER TABLE legacy_x.rank_seasons ADD COLUMN IF NOT EXISTS period_start DATE;
ALTER TABLE legacy_x.rank_seasons ADD COLUMN IF NOT EXISTS period_end DATE;

UPDATE legacy_x.rank_seasons
SET period_start = COALESCE(period_start, date_trunc('month', now() AT TIME ZONE 'UTC')::DATE)
WHERE is_active AND period_start IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rank_seasons_active_singleton_idx
  ON legacy_x.rank_seasons ((is_active))
  WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS rank_seasons_period_start_idx
  ON legacy_x.rank_seasons (period_start)
  WHERE period_start IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_x.rank_season_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL UNIQUE REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  season_slug TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  closed_at TIMESTAMPTZ NOT NULL,
  leaderboard_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  clan_leaderboard_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_season_rollovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL UNIQUE,
  previous_season_id UUID REFERENCES legacy_x.rank_seasons(id) ON DELETE SET NULL,
  new_season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_source TEXT NOT NULL CHECK (execution_source IN ('scheduler', 'manual', 'migration'))
);

CREATE OR REPLACE FUNCTION legacy_x.active_rank_season()
RETURNS TABLE (id UUID, slug TEXT, name TEXT, period_start DATE, period_end DATE, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT rs.id, rs.slug, rs.name, rs.period_start, rs.period_end, rs.created_at
  FROM legacy_x.rank_seasons rs
  WHERE rs.is_active
  ORDER BY rs.created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION legacy_x.rollover_monthly_rank_season(
  p_now TIMESTAMPTZ DEFAULT now(),
  p_source TEXT DEFAULT 'scheduler'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_period_start DATE := date_trunc('month', p_now AT TIME ZONE 'UTC')::DATE;
  v_previous legacy_x.rank_seasons%ROWTYPE;
  v_new legacy_x.rank_seasons%ROWTYPE;
  v_slug TEXT := 'season-' || to_char(date_trunc('month', p_now AT TIME ZONE 'UTC'), 'YYYY-MM');
  v_leaderboard JSONB;
  v_clans JSONB;
BEGIN
  IF p_source NOT IN ('scheduler', 'manual', 'migration') THEN
    RAISE EXCEPTION 'Unsupported rollover source' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('legacy_x.monthly_rank_rollover'));

  SELECT * INTO v_previous
  FROM legacy_x.rank_seasons
  WHERE is_active
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND v_previous.period_start = v_period_start THEN
    RETURN jsonb_build_object('status', 'noop', 'season', v_previous.slug, 'period_start', v_period_start);
  END IF;

  INSERT INTO legacy_x.rank_seasons (slug, name, is_active, period_start)
  VALUES (v_slug, 'LEGACY-X ' || to_char(v_period_start, 'FMMonth YYYY'), false, v_period_start)
  ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
  RETURNING * INTO v_new;

  IF FOUND AND v_previous.id IS NOT NULL AND v_previous.id <> v_new.id THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(board)), '[]'::jsonb) INTO v_leaderboard
    FROM (
      SELECT rank, steam_id, username, rating, tier, matches_played, wins, losses, kills, deaths, assists, last_match_at
      FROM legacy_x.rank_leaderboard
      WHERE season_slug = v_previous.slug
      ORDER BY rank ASC
      LIMIT 500
    ) board;

    SELECT COALESCE(jsonb_agg(to_jsonb(board)), '[]'::jsonb) INTO v_clans
    FROM (
      SELECT rank, clan_id, name, tag, region, points, experience, matches_played, wins, updated_at
      FROM legacy_x.community_clan_leaderboard
      WHERE season_slug = v_previous.slug
      ORDER BY rank ASC
      LIMIT 500
    ) board;

    INSERT INTO legacy_x.rank_season_archives (
      season_id, season_slug, period_start, period_end, closed_at, leaderboard_snapshot, clan_leaderboard_snapshot
    ) VALUES (
      v_previous.id, v_previous.slug, v_previous.period_start, v_period_start - 1, p_now, v_leaderboard, v_clans
    ) ON CONFLICT (season_id) DO NOTHING;

    UPDATE legacy_x.rank_seasons
    SET is_active = false, closed_at = COALESCE(closed_at, p_now), period_end = COALESCE(period_end, v_period_start - 1)
    WHERE id = v_previous.id;
  END IF;

  UPDATE legacy_x.rank_seasons SET is_active = false WHERE is_active AND id <> v_new.id;
  UPDATE legacy_x.rank_seasons SET is_active = true, period_start = COALESCE(period_start, v_period_start), period_end = NULL, closed_at = NULL WHERE id = v_new.id;

  INSERT INTO legacy_x.rank_season_rollovers (period_start, previous_season_id, new_season_id, execution_source)
  VALUES (v_period_start, NULLIF(v_previous.id, v_new.id), v_new.id, p_source)
  ON CONFLICT (period_start) DO NOTHING;

  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('system', 'rank-season', 'rank.season.rollover', 'rank_season', v_new.id, jsonb_build_object('slug', v_new.slug, 'periodStart', v_period_start, 'source', p_source));

  RETURN jsonb_build_object('status', 'rolled_over', 'previous_season', v_previous.slug, 'season', v_new.slug, 'period_start', v_period_start);
END;
$$;

SELECT legacy_x.rollover_monthly_rank_season(now(), 'migration');

ALTER TABLE legacy_x.rank_season_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_season_rollovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.rank_season_archives, legacy_x.rank_season_rollovers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.rank_season_archives, legacy_x.rank_season_rollovers TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.active_rank_season(), legacy_x.rollover_monthly_rank_season(TIMESTAMPTZ, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_plugin_ready_contracts.sql
-- ======================================================================
BEGIN;

-- Additive v1 live snapshot contract. Existing snapshots remain readable and
-- are treated as legacy revision 0 until a plugin sends a v1 update.
ALTER TABLE legacy_x.server_live_match_snapshots
  ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  ADD COLUMN IF NOT EXISTS snapshot_revision INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_revision >= 0),
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS spectator_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(spectator_players) = 'array'),
  ADD COLUMN IF NOT EXISTS source_plugin_id TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS server_live_match_snapshots_revision_idx
  ON legacy_x.server_live_match_snapshots (server_id, snapshot_revision DESC);

CREATE TABLE IF NOT EXISTS legacy_x.server_live_match_snapshot_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_live_match_snapshot_receipts_server_idx
  ON legacy_x.server_live_match_snapshot_receipts (server_id, received_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.ingest_server_live_match_snapshot(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_server_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
  v_existing_revision INTEGER;
  v_revision INTEGER := COALESCE((p_payload->>'snapshot_revision')::INTEGER, -1);
  v_schema_version INTEGER := COALESCE((p_payload->>'schema_version')::INTEGER, -1);
  v_captured_at TIMESTAMPTZ;
BEGIN
  IF p_plugin_id NOT IN ('legacyx-reconnect', 'legacyx-live-snapshot') THEN
    RAISE EXCEPTION 'Unsupported live snapshot plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF v_schema_version <> 1 OR v_revision < 0 THEN
    RAISE EXCEPTION 'Unsupported live snapshot contract' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_captured_at := (p_payload->>'captured_at')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid captured_at' USING ERRCODE = '22023';
  END;
  IF v_captured_at > now() + interval '60 seconds' OR v_captured_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'Live snapshot captured_at is outside the accepted window' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM legacy_x.reconnect_servers WHERE server_id = p_server_id) THEN
    RAISE EXCEPTION 'Live snapshot requires a prior server heartbeat' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.server_live_match_snapshot_receipts (event_id, plugin_id, server_id, snapshot_revision)
  VALUES (p_event_id, p_plugin_id, p_server_id, v_revision)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate', 'server_id', p_server_id, 'snapshot_revision', v_revision);
  END IF;

  SELECT snapshot_revision INTO v_existing_revision
  FROM legacy_x.server_live_match_snapshots
  WHERE server_id = p_server_id
  FOR UPDATE;
  IF FOUND AND v_revision <= v_existing_revision THEN
    RETURN jsonb_build_object('status', 'stale', 'server_id', p_server_id, 'snapshot_revision', v_revision, 'current_revision', v_existing_revision);
  END IF;

  INSERT INTO legacy_x.server_live_match_snapshots (
    server_id, source_event_id, source_plugin_id, schema_version, snapshot_revision,
    state, map_name, round_number, score_t, score_ct, terrorist_players,
    counter_terrorist_players, spectator_players, captured_at, reported_at, updated_at
  ) VALUES (
    p_server_id, p_event_id, p_plugin_id, v_schema_version, v_revision,
    p_payload->>'state', COALESCE(p_payload->>'map_name', ''),
    NULLIF(p_payload->>'round_number', '')::INTEGER, NULLIF(p_payload->>'score_t', '')::INTEGER,
    NULLIF(p_payload->>'score_ct', '')::INTEGER, COALESCE(p_payload->'terrorist_players', '[]'::JSONB),
    COALESCE(p_payload->'counter_terrorist_players', '[]'::JSONB), COALESCE(p_payload->'spectator_players', '[]'::JSONB),
    v_captured_at, now(), now()
  ) ON CONFLICT (server_id) DO UPDATE SET
    source_event_id = EXCLUDED.source_event_id,
    source_plugin_id = EXCLUDED.source_plugin_id,
    schema_version = EXCLUDED.schema_version,
    snapshot_revision = EXCLUDED.snapshot_revision,
    state = EXCLUDED.state,
    map_name = EXCLUDED.map_name,
    round_number = EXCLUDED.round_number,
    score_t = EXCLUDED.score_t,
    score_ct = EXCLUDED.score_ct,
    terrorist_players = EXCLUDED.terrorist_players,
    counter_terrorist_players = EXCLUDED.counter_terrorist_players,
    spectator_players = EXCLUDED.spectator_players,
    captured_at = EXCLUDED.captured_at,
    reported_at = EXCLUDED.reported_at,
    updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('status', 'processed', 'server_id', p_server_id, 'snapshot_revision', v_revision, 'captured_at', v_captured_at);
END;
$$;

ALTER TABLE legacy_x.server_live_match_snapshot_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.server_live_match_snapshot_receipts FROM anon, authenticated;
GRANT SELECT, INSERT ON legacy_x.server_live_match_snapshot_receipts TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_server_live_match_snapshot(TEXT, TEXT, TEXT, JSONB) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_progression_clans.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.community_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS legacy_x.community_player_progression (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.community_match_experience (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.community_event_receipts(event_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  clan_id UUID REFERENCES legacy_x.clans(id) ON DELETE SET NULL,
  xp_delta INTEGER NOT NULL CHECK (xp_delta >= 0),
  level_after INTEGER NOT NULL CHECK (level_after >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.clan_season_scores (
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  clan_id UUID NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, clan_id)
);

CREATE INDEX IF NOT EXISTS community_progression_experience_idx
  ON legacy_x.community_player_progression (experience DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS community_match_experience_user_idx
  ON legacy_x.community_match_experience (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clan_season_scores_points_idx
  ON legacy_x.clan_season_scores (season_id, points DESC, experience DESC);

CREATE OR REPLACE FUNCTION legacy_x.community_level_from_experience(p_experience INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(1, FLOOR(SQRT(GREATEST(p_experience, 0) / 150.0))::INTEGER + 1);
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_community_map_result(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_receipt_id UUID;
  v_season_id UUID;
  v_team_key TEXT;
  v_team JSONB;
  v_player JSONB;
  v_stats JSONB;
  v_user_id UUID;
  v_clan_id UUID;
  v_outcome TEXT;
  v_kills INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_xp INTEGER;
  v_experience INTEGER;
  v_level INTEGER;
BEGIN
  IF p_plugin_id <> 'matchzy' THEN
    RAISE EXCEPTION 'Unsupported plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event', '') <> 'map_result' OR COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'Only matching map_result events may change community progression' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.community_event_receipts (plugin_id, event_id, event_type, payload)
  VALUES (p_plugin_id, p_event_id, 'map_result', p_payload)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING id INTO v_receipt_id;

  IF v_receipt_id IS NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  SELECT id INTO v_season_id
  FROM legacy_x.rank_seasons
  WHERE slug = COALESCE(NULLIF(p_payload->>'season', ''), 'season-1');
  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'Unknown rank season' USING ERRCODE = '22023';
  END IF;

  FOREACH v_team_key IN ARRAY ARRAY['team1', 'team2'] LOOP
    v_team := p_payload -> v_team_key;
    v_outcome := CASE WHEN p_payload #>> '{winner,team}' = v_team_key THEN 'win' ELSE 'loss' END;

    FOR v_player IN SELECT value FROM jsonb_array_elements(COALESCE(v_team->'players', '[]'::jsonb)) LOOP
      v_stats := COALESCE(v_player->'stats', '{}'::jsonb);
      v_kills := COALESCE(NULLIF(v_stats->>'kills', '')::INTEGER, 0);
      v_assists := COALESCE(NULLIF(v_stats->>'assists', '')::INTEGER, 0);
      v_headshots := COALESCE(NULLIF(v_stats->>'headshot_kills', '')::INTEGER, 0);
      v_xp := LEAST(350, 100
        + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END
        + LEAST(120, GREATEST(0, v_kills) * 4)
        + LEAST(50, GREATEST(0, v_assists) * 2)
        + LEAST(30, GREATEST(0, v_headshots)));

      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_player->>'steamid', COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_player->>'steamid'), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;

      INSERT INTO legacy_x.player_stats (user_id, experience, last_played_at)
      VALUES (v_user_id, v_xp, now())
      ON CONFLICT (user_id) DO UPDATE SET
        experience = COALESCE(legacy_x.player_stats.experience, 0) + v_xp,
        last_played_at = now();

      INSERT INTO legacy_x.community_player_progression (user_id, experience, level, matches_played, last_match_at)
      VALUES (v_user_id, v_xp, legacy_x.community_level_from_experience(v_xp), 1, now())
      ON CONFLICT (user_id) DO UPDATE SET
        experience = legacy_x.community_player_progression.experience + v_xp,
        level = legacy_x.community_level_from_experience(legacy_x.community_player_progression.experience + v_xp),
        matches_played = legacy_x.community_player_progression.matches_played + 1,
        last_match_at = now(),
        updated_at = now()
      RETURNING experience, level INTO v_experience, v_level;

      UPDATE legacy_x.users SET level = v_level WHERE id = v_user_id;

      SELECT clan_id INTO v_clan_id FROM legacy_x.clan_members WHERE user_id = v_user_id LIMIT 1;
      IF v_clan_id IS NOT NULL THEN
        INSERT INTO legacy_x.clan_season_scores (season_id, clan_id, experience, points, matches_played, wins)
        VALUES (v_season_id, v_clan_id, v_xp, v_xp + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END, 1, CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END)
        ON CONFLICT (season_id, clan_id) DO UPDATE SET
          experience = legacy_x.clan_season_scores.experience + v_xp,
          points = legacy_x.clan_season_scores.points + v_xp + CASE WHEN v_outcome = 'win' THEN 50 ELSE 0 END,
          matches_played = legacy_x.clan_season_scores.matches_played + 1,
          wins = legacy_x.clan_season_scores.wins + CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
          updated_at = now();
      END IF;

      INSERT INTO legacy_x.community_match_experience (event_id, user_id, season_id, clan_id, xp_delta, level_after)
      VALUES (p_event_id, v_user_id, v_season_id, v_clan_id, v_xp, v_level);
    END LOOP;
  END LOOP;

  UPDATE legacy_x.community_event_receipts SET processed_at = now() WHERE id = v_receipt_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'community.map_result.ingest', 'community_event', p_event_id, jsonb_build_object('seasonId', v_season_id));

  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'season_id', v_season_id);
END;
$$;

CREATE OR REPLACE VIEW legacy_x.community_experience_leaderboard AS
SELECT
  DENSE_RANK() OVER (ORDER BY cpp.experience DESC, cpp.matches_played DESC, cpp.updated_at ASC) AS rank,
  u.steam_id,
  u.username,
  cpp.level,
  cpp.experience,
  cpp.matches_played,
  cpp.last_match_at
FROM legacy_x.community_player_progression cpp
JOIN legacy_x.users u ON u.id = cpp.user_id;

CREATE OR REPLACE VIEW legacy_x.community_clan_leaderboard AS
SELECT
  rs.slug AS season_slug,
  DENSE_RANK() OVER (PARTITION BY css.season_id ORDER BY css.points DESC, css.experience DESC, css.wins DESC, css.updated_at ASC) AS rank,
  c.id AS clan_id,
  c.name,
  c.tag,
  c.region,
  css.points,
  css.experience,
  css.matches_played,
  css.wins,
  css.updated_at
FROM legacy_x.clan_season_scores css
JOIN legacy_x.rank_seasons rs ON rs.id = css.season_id
JOIN legacy_x.clans c ON c.id = css.clan_id;

CREATE OR REPLACE VIEW legacy_x.community_player_profiles AS
SELECT
  u.steam_id,
  u.username,
  u.avatar,
  COALESCE(cpp.level, u.level, 1) AS level,
  COALESCE(cpp.experience, ps.experience, 0) AS experience,
  COALESCE(rps.rating, 1000) AS rating,
  CASE WHEN rps.rating >= 1800 THEN 'legend' WHEN rps.rating >= 1500 THEN 'elite' WHEN rps.rating >= 1250 THEN 'veteran' WHEN rps.rating >= 1000 THEN 'contender' ELSE 'rookie' END AS rank_tier,
  c.id AS clan_id,
  c.name AS clan_name,
  c.tag AS clan_tag,
  cm.role AS clan_role
FROM legacy_x.users u
LEFT JOIN legacy_x.community_player_progression cpp ON cpp.user_id = u.id
LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
LEFT JOIN LATERAL (SELECT id FROM legacy_x.rank_seasons WHERE is_active ORDER BY created_at DESC LIMIT 1) active_season ON true
LEFT JOIN legacy_x.rank_player_seasons rps ON rps.user_id = u.id AND rps.season_id = active_season.id
LEFT JOIN LATERAL (SELECT clan_id, role FROM legacy_x.clan_members WHERE user_id = u.id LIMIT 1) cm ON true
LEFT JOIN legacy_x.clans c ON c.id = cm.clan_id;

ALTER TABLE legacy_x.community_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_player_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.community_match_experience ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_season_scores ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.community_event_receipts, legacy_x.community_player_progression, legacy_x.community_match_experience, legacy_x.clan_season_scores FROM anon, authenticated;
REVOKE ALL ON legacy_x.community_experience_leaderboard, legacy_x.community_clan_leaderboard, legacy_x.community_player_profiles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.community_event_receipts, legacy_x.community_player_progression, legacy_x.community_match_experience, legacy_x.clan_season_scores TO service_role;
GRANT SELECT ON legacy_x.community_experience_leaderboard, legacy_x.community_clan_leaderboard, legacy_x.community_player_profiles TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.community_level_from_experience(INTEGER), legacy_x.ingest_community_map_result(TEXT, TEXT, JSONB) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_promotions.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.promotion_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 3 AND 96),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('legacyx', 'creator', 'partner')),
  owner_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  benefit_type TEXT NOT NULL CHECK (benefit_type IN ('wallet_credit', 'wallet_rate_override', 'wallet_percent', 'wallet_fixed', 'store_percent', 'store_fixed', 'admin_role')),
  benefit_value INTEGER NOT NULL CHECK (benefit_value >= 0 AND benefit_value <= 1000000),
  starts_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  max_redemptions INTEGER NULL CHECK (max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0 AND per_user_limit <= 100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((owner_kind = 'legacyx') OR owner_user_id IS NOT NULL),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at),
  CHECK ((benefit_type <> 'admin_role') OR owner_kind = 'legacyx'),
  CHECK ((benefit_type NOT IN ('wallet_percent', 'store_percent')) OR benefit_value BETWEEN 0 AND 100),
  CHECK ((benefit_type <> 'wallet_rate_override') OR benefit_value >= 1)
);

CREATE TABLE IF NOT EXISTS legacy_x.promotion_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES legacy_x.promotion_campaigns(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
  code_hint TEXT NOT NULL CHECK (char_length(code_hint) BETWEEN 3 AND 32),
  max_redemptions INTEGER NULL CHECK (max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  per_user_limit INTEGER NULL CHECK (per_user_limit > 0 AND per_user_limit <= 100),
  starts_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NULL REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS legacy_x.promotion_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES legacy_x.promotion_campaigns(id) ON DELETE RESTRICT,
  code_id UUID NOT NULL REFERENCES legacy_x.promotion_codes(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  context TEXT NOT NULL CHECK (context IN ('wallet_redeem', 'store_purchase')),
  status TEXT NOT NULL DEFAULT 'redeemed' CHECK (status IN ('redeemed', 'revoked')),
  benefit_type TEXT NOT NULL,
  benefit_value INTEGER NOT NULL,
  code_hint TEXT NOT NULL,
  idempotency_key TEXT NULL CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 96),
  wallet_transaction_id UUID NULL REFERENCES legacy_x.wallet_transactions(id) ON DELETE SET NULL,
  store_purchase_id UUID NULL REFERENCES legacy_x.store_purchases(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS legacy_x.user_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('admin_role')),
  promotion_redemption_id UUID NOT NULL UNIQUE REFERENCES legacy_x.promotion_redemptions(id) ON DELETE RESTRICT,
  granted_role TEXT NULL CHECK (granted_role IN ('Admin')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotion_campaigns_active_idx ON legacy_x.promotion_campaigns (is_active, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS promotion_codes_campaign_idx ON legacy_x.promotion_codes (campaign_id, is_active);
CREATE INDEX IF NOT EXISTS promotion_redemptions_user_created_idx ON legacy_x.promotion_redemptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS promotion_redemptions_code_user_idx ON legacy_x.promotion_redemptions (code_id, user_id) WHERE status = 'redeemed';
CREATE INDEX IF NOT EXISTS user_entitlements_user_active_idx ON legacy_x.user_entitlements (user_id, kind) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION legacy_x.quote_promotion_code(
  p_user_id UUID,
  p_code_hash TEXT,
  p_context TEXT,
  p_coin_amount INTEGER DEFAULT NULL,
  p_item_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_used INTEGER;
  v_limit INTEGER;
  v_base INTEGER;
  v_final INTEGER;
  v_message TEXT;
BEGIN
  SELECT c.* INTO v_code FROM legacy_x.promotion_codes c WHERE c.code_hash = p_code_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id;
  IF NOT v_code.is_active OR NOT v_campaign.is_active THEN RAISE EXCEPTION 'Promotion code is inactive' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) THEN RAISE EXCEPTION 'Promotion code is not active yet' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code has expired' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;

  IF p_context = 'wallet_topup' THEN
    IF p_coin_amount IS NULL OR p_coin_amount <= 0 THEN RAISE EXCEPTION 'Coin amount is required' USING ERRCODE = '22023'; END IF;
    v_base := p_coin_amount * 2000;
    IF v_campaign.benefit_type = 'wallet_rate_override' THEN v_final := p_coin_amount * v_campaign.benefit_value;
    ELSIF v_campaign.benefit_type = 'wallet_percent' THEN v_final := ceil(v_base * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0);
    ELSIF v_campaign.benefit_type = 'wallet_fixed' THEN v_final := GREATEST(0, v_base - v_campaign.benefit_value);
    ELSE RAISE EXCEPTION 'Promotion code does not apply to wallet top-up' USING ERRCODE = 'P0001'; END IF;
    v_message := 'Promotion is ready for verified payment checkout';
  ELSIF p_context = 'store_purchase' THEN
    SELECT price INTO v_base FROM legacy_x.store_items WHERE id = p_item_id;
    IF v_base IS NULL THEN RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002'; END IF;
    IF v_campaign.benefit_type = 'store_percent' THEN v_final := ceil(v_base * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0);
    ELSIF v_campaign.benefit_type = 'store_fixed' THEN v_final := GREATEST(0, v_base - v_campaign.benefit_value);
    ELSE RAISE EXCEPTION 'Promotion code does not apply to store purchase' USING ERRCODE = 'P0001'; END IF;
    v_message := 'Promotion is ready for store checkout';
  ELSIF p_context = 'wallet_redeem' THEN
    IF v_campaign.benefit_type NOT IN ('wallet_credit', 'admin_role') THEN RAISE EXCEPTION 'Promotion code needs a purchase or top-up context' USING ERRCODE = 'P0001'; END IF;
    v_base := v_campaign.benefit_value;
    v_final := v_campaign.benefit_value;
    v_message := CASE WHEN v_campaign.benefit_type = 'admin_role' THEN 'LEGACY-X Admin entitlement will be granted' ELSE 'Wallet coins will be granted' END;
  ELSE
    RAISE EXCEPTION 'Unsupported promotion context' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('codeHint', v_code.code_hint, 'campaignName', v_campaign.name, 'ownerKind', v_campaign.owner_kind, 'benefitType', v_campaign.benefit_type, 'context', p_context, 'baseAmount', v_base, 'finalAmount', v_final, 'discountAmount', GREATEST(0, v_base - v_final), 'currency', CASE WHEN p_context = 'wallet_topup' THEN 'MNT' ELSE 'coins' END, 'redeemable', p_context = 'wallet_redeem', 'message', v_message);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.redeem_promotion_code(
  p_user_id UUID,
  p_code_hash TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_redemption legacy_x.promotion_redemptions%ROWTYPE;
  v_existing legacy_x.promotion_redemptions%ROWTYPE;
  v_transaction_id UUID;
  v_entitlement_id UUID;
  v_used INTEGER;
  v_limit INTEGER;
  v_balance INTEGER;
  v_role TEXT;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM legacy_x.promotion_redemptions WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT balance, role INTO v_balance, v_role FROM legacy_x.users WHERE id = p_user_id;
      RETURN jsonb_build_object('redemptionId', v_existing.id, 'alreadyRedeemed', true, 'benefitType', v_existing.benefit_type, 'benefitValue', v_existing.benefit_value, 'balance', v_balance, 'role', v_role);
    END IF;
  END IF;
  SELECT * INTO v_code FROM legacy_x.promotion_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id FOR UPDATE;
  IF NOT v_code.is_active OR NOT v_campaign.is_active THEN RAISE EXCEPTION 'Promotion code is inactive' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) OR (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code is unavailable' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;
  IF v_campaign.benefit_type NOT IN ('wallet_credit', 'admin_role') THEN RAISE EXCEPTION 'This promotion must be redeemed during verified checkout' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO legacy_x.promotion_redemptions (campaign_id, code_id, user_id, context, benefit_type, benefit_value, code_hint, idempotency_key, metadata)
  VALUES (v_campaign.id, v_code.id, p_user_id, 'wallet_redeem', v_campaign.benefit_type, v_campaign.benefit_value, v_code.code_hint, p_idempotency_key, jsonb_build_object('ownerKind', v_campaign.owner_kind))
  RETURNING * INTO v_redemption;
  IF v_campaign.benefit_type = 'wallet_credit' THEN
    UPDATE legacy_x.users SET balance = balance + v_campaign.benefit_value WHERE id = p_user_id RETURNING balance, role INTO v_balance, v_role;
    IF NOT FOUND THEN RAISE EXCEPTION 'Wallet owner was not found' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type, reference_id)
    VALUES (p_user_id, 'Charge', v_campaign.benefit_value, 'promo:' || v_code.code_hint, 'promotion_redemption', v_redemption.id)
    RETURNING id INTO v_transaction_id;
    UPDATE legacy_x.promotion_redemptions SET wallet_transaction_id = v_transaction_id WHERE id = v_redemption.id;
  ELSE
    UPDATE legacy_x.users SET role = CASE WHEN role = 'Player' THEN 'Admin' ELSE role END WHERE id = p_user_id RETURNING balance, role INTO v_balance, v_role;
    INSERT INTO legacy_x.user_entitlements (user_id, kind, promotion_redemption_id, granted_role, metadata)
    VALUES (p_user_id, 'admin_role', v_redemption.id, 'Admin', jsonb_build_object('campaignId', v_campaign.id, 'codeHint', v_code.code_hint))
    RETURNING id INTO v_entitlement_id;
  END IF;
  UPDATE legacy_x.promotion_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;
  UPDATE legacy_x.promotion_campaigns SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = v_campaign.id;
  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('user', p_user_id, 'promotion.redeem', 'promotion_redemption', v_redemption.id, jsonb_build_object('campaignId', v_campaign.id, 'benefitType', v_campaign.benefit_type, 'benefitValue', v_campaign.benefit_value, 'codeHint', v_code.code_hint));
  RETURN jsonb_build_object('redemptionId', v_redemption.id, 'alreadyRedeemed', false, 'benefitType', v_campaign.benefit_type, 'benefitValue', v_campaign.benefit_value, 'balance', v_balance, 'role', v_role, 'entitlementId', v_entitlement_id);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.purchase_store_item_with_promotion(
  p_user_id UUID,
  p_item_id UUID,
  p_code_hash TEXT,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_code legacy_x.promotion_codes%ROWTYPE;
  v_campaign legacy_x.promotion_campaigns%ROWTYPE;
  v_price INTEGER;
  v_final_price INTEGER;
  v_used INTEGER;
  v_limit INTEGER;
  v_transaction_id UUID;
  v_purchase_id UUID;
  v_redemption_id UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT store_purchase_id INTO v_purchase_id FROM legacy_x.promotion_redemptions WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF v_purchase_id IS NOT NULL THEN RETURN v_purchase_id; END IF;
  END IF;
  SELECT * INTO v_code FROM legacy_x.promotion_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Promotion code is invalid' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_campaign FROM legacy_x.promotion_campaigns WHERE id = v_code.campaign_id FOR UPDATE;
  IF NOT v_code.is_active OR NOT v_campaign.is_active OR (v_code.starts_at IS NOT NULL AND v_code.starts_at > now()) OR (v_campaign.starts_at IS NOT NULL AND v_campaign.starts_at > now()) OR (v_code.expires_at IS NOT NULL AND v_code.expires_at <= now()) OR (v_campaign.expires_at IS NOT NULL AND v_campaign.expires_at <= now()) THEN RAISE EXCEPTION 'Promotion code is unavailable' USING ERRCODE = 'P0001'; END IF;
  IF v_campaign.benefit_type NOT IN ('store_percent', 'store_fixed') THEN RAISE EXCEPTION 'Promotion code does not apply to store purchases' USING ERRCODE = 'P0001'; END IF;
  IF (v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions) OR (v_campaign.max_redemptions IS NOT NULL AND v_campaign.redemption_count >= v_campaign.max_redemptions) THEN RAISE EXCEPTION 'Promotion code usage limit has been reached' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*) INTO v_used FROM legacy_x.promotion_redemptions WHERE code_id = v_code.id AND user_id = p_user_id AND status = 'redeemed';
  v_limit := COALESCE(v_code.per_user_limit, v_campaign.per_user_limit);
  IF v_used >= v_limit THEN RAISE EXCEPTION 'You have already used this promotion code' USING ERRCODE = 'P0001'; END IF;
  SELECT price INTO v_price FROM legacy_x.store_items WHERE id = p_item_id;
  IF v_price IS NULL THEN RAISE EXCEPTION 'Store item was not found' USING ERRCODE = 'P0002'; END IF;
  v_final_price := CASE WHEN v_campaign.benefit_type = 'store_percent' THEN ceil(v_price * GREATEST(0, 100 - v_campaign.benefit_value) / 100.0)::INTEGER ELSE GREATEST(0, v_price - v_campaign.benefit_value) END;
  UPDATE legacy_x.users SET balance = balance - v_final_price WHERE id = p_user_id AND balance >= v_final_price;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insufficient wallet balance or user not found' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO legacy_x.wallet_transactions (user_id, type, amount, method, reference_type) VALUES (p_user_id, 'Purchase', v_final_price, 'promo:' || v_code.code_hint, 'store_purchase') RETURNING id INTO v_transaction_id;
  INSERT INTO legacy_x.store_purchases (user_id, item_id, price_at_purchase, wallet_transaction_id) VALUES (p_user_id, p_item_id, v_final_price, v_transaction_id) RETURNING id INTO v_purchase_id;
  UPDATE legacy_x.wallet_transactions SET reference_id = v_purchase_id WHERE id = v_transaction_id;
  INSERT INTO legacy_x.promotion_redemptions (campaign_id, code_id, user_id, context, benefit_type, benefit_value, code_hint, idempotency_key, store_purchase_id, metadata)
  VALUES (v_campaign.id, v_code.id, p_user_id, 'store_purchase', v_campaign.benefit_type, v_campaign.benefit_value, v_code.code_hint, p_idempotency_key, v_purchase_id, jsonb_build_object('originalPrice', v_price, 'finalPrice', v_final_price)) RETURNING id INTO v_redemption_id;
  UPDATE legacy_x.promotion_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;
  UPDATE legacy_x.promotion_campaigns SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = v_campaign.id;
  INSERT INTO legacy_x.audit_logs (actor_type, actor_id, action, target_type, target_id, metadata) VALUES ('user', p_user_id, 'promotion.store_purchase', 'promotion_redemption', v_redemption_id, jsonb_build_object('campaignId', v_campaign.id, 'codeHint', v_code.code_hint, 'discountCoins', v_price - v_final_price));
  RETURN v_purchase_id;
END;
$$;

ALTER TABLE legacy_x.promotion_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.promotion_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.promotion_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.user_entitlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.promotion_campaigns, legacy_x.promotion_codes, legacy_x.promotion_redemptions, legacy_x.user_entitlements FROM anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.quote_promotion_code(UUID, TEXT, TEXT, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION legacy_x.redeem_promotion_code(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION legacy_x.purchase_store_item_with_promotion(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.promotion_campaigns, legacy_x.promotion_codes, legacy_x.promotion_redemptions, legacy_x.user_entitlements TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.quote_promotion_code(UUID, TEXT, TEXT, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.redeem_promotion_code(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.purchase_store_item_with_promotion(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_rank.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.rank_seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,64}$'),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

INSERT INTO legacy_x.rank_seasons (slug, name, is_active)
VALUES ('season-1', 'LEGACY-X Season 1', true)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS legacy_x.plugin_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_player_seasons (
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  kills INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  deaths INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  assists INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.rank_match_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES legacy_x.plugin_event_receipts(event_id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES legacy_x.rank_seasons(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  match_external_id TEXT NOT NULL,
  map_number INTEGER NOT NULL CHECK (map_number >= 0),
  map_name TEXT NOT NULL,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss')),
  score_for INTEGER NOT NULL CHECK (score_for >= 0),
  score_against INTEGER NOT NULL CHECK (score_against >= 0),
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  headshot_kills INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  rating_delta INTEGER NOT NULL,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS rank_player_seasons_rating_idx
  ON legacy_x.rank_player_seasons (season_id, rating DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS rank_match_results_user_idx
  ON legacy_x.rank_match_results (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plugin_event_receipts_plugin_received_idx
  ON legacy_x.plugin_event_receipts (plugin_id, received_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.ingest_rank_map_result(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_receipt_id UUID;
  v_season_id UUID;
  v_team_key TEXT;
  v_team JSONB;
  v_player JSONB;
  v_stats JSONB;
  v_user_id UUID;
  v_steam_id TEXT;
  v_name TEXT;
  v_kills INTEGER;
  v_deaths INTEGER;
  v_assists INTEGER;
  v_headshots INTEGER;
  v_score INTEGER;
  v_delta INTEGER;
  v_rating INTEGER;
  v_outcome TEXT;
  v_score_for INTEGER;
  v_score_against INTEGER;
BEGIN
  IF p_plugin_id <> 'matchzy' THEN
    RAISE EXCEPTION 'Unsupported plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event', '') <> 'map_result' THEN
    RAISE EXCEPTION 'Only map_result events may change rank' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.plugin_event_receipts (plugin_id, event_id, event_type, payload)
  VALUES (p_plugin_id, p_event_id, 'map_result', p_payload)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING id INTO v_receipt_id;

  IF v_receipt_id IS NULL THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  SELECT id INTO v_season_id
  FROM legacy_x.rank_seasons
  WHERE slug = COALESCE(NULLIF(p_payload->>'season', ''), 'season-1');

  IF v_season_id IS NULL THEN
    RAISE EXCEPTION 'Unknown rank season' USING ERRCODE = '22023';
  END IF;

  FOREACH v_team_key IN ARRAY ARRAY['team1', 'team2'] LOOP
    v_team := p_payload -> v_team_key;
    v_outcome := CASE WHEN p_payload #>> '{winner,team}' = v_team_key THEN 'win' ELSE 'loss' END;
    v_score_for := COALESCE((v_team->>'score')::INTEGER, 0);
    v_score_against := COALESCE(((p_payload -> (CASE WHEN v_team_key = 'team1' THEN 'team2' ELSE 'team1' END))->>'score')::INTEGER, 0);

    FOR v_player IN SELECT value FROM jsonb_array_elements(COALESCE(v_team->'players', '[]'::jsonb)) LOOP
      v_steam_id := v_player->>'steamid';
      v_name := COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id);
      v_stats := COALESCE(v_player->'stats', '{}'::jsonb);
      v_kills := COALESCE(NULLIF(v_stats->>'kills', '')::INTEGER, 0);
      v_deaths := COALESCE(NULLIF(v_stats->>'deaths', '')::INTEGER, 0);
      v_assists := COALESCE(NULLIF(v_stats->>'assists', '')::INTEGER, 0);
      v_headshots := COALESCE(NULLIF(v_stats->>'headshot_kills', '')::INTEGER, 0);
      v_score := COALESCE(NULLIF(v_stats->>'score', '')::INTEGER, 0);
      v_delta := CASE WHEN v_outcome = 'win' THEN 25 ELSE -20 END
        + LEAST(12, GREATEST(-12, v_kills - v_deaths))
        + LEAST(4, FLOOR(v_assists / 2.0)::INTEGER)
        + LEAST(3, FLOOR(v_headshots / 3.0)::INTEGER);

      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, v_name, '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;

      INSERT INTO legacy_x.rank_player_seasons (
        season_id, user_id, rating, matches_played, wins, losses, kills, deaths, assists, last_match_at
      ) VALUES (
        v_season_id, v_user_id, GREATEST(0, 1000 + v_delta), 1,
        CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
        CASE WHEN v_outcome = 'loss' THEN 1 ELSE 0 END,
        v_kills, v_deaths, v_assists, now()
      )
      ON CONFLICT (season_id, user_id) DO UPDATE SET
        rating = GREATEST(0, legacy_x.rank_player_seasons.rating + v_delta),
        matches_played = legacy_x.rank_player_seasons.matches_played + 1,
        wins = legacy_x.rank_player_seasons.wins + CASE WHEN v_outcome = 'win' THEN 1 ELSE 0 END,
        losses = legacy_x.rank_player_seasons.losses + CASE WHEN v_outcome = 'loss' THEN 1 ELSE 0 END,
        kills = legacy_x.rank_player_seasons.kills + v_kills,
        deaths = legacy_x.rank_player_seasons.deaths + v_deaths,
        assists = legacy_x.rank_player_seasons.assists + v_assists,
        last_match_at = now(),
        updated_at = now()
      RETURNING rating INTO v_rating;

      INSERT INTO legacy_x.rank_match_results (
        event_id, season_id, user_id, match_external_id, map_number, map_name, team_key, outcome,
        score_for, score_against, kills, deaths, assists, headshot_kills, score, rating_delta, stats
      ) VALUES (
        p_event_id, v_season_id, v_user_id, p_payload->>'match_id',
        COALESCE((p_payload->>'map_number')::INTEGER, 0), p_payload->>'map_name', v_team_key, v_outcome,
        v_score_for, v_score_against, v_kills, v_deaths, v_assists, v_headshots, v_score, v_delta, v_stats
      );
    END LOOP;
  END LOOP;

  UPDATE legacy_x.plugin_event_receipts SET processed_at = now() WHERE id = v_receipt_id;

  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'rank.map_result.ingest', 'rank_event', p_event_id, jsonb_build_object('seasonId', v_season_id, 'eventId', p_event_id));

  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'season_id', v_season_id);
END;
$$;

CREATE OR REPLACE VIEW legacy_x.rank_leaderboard AS
SELECT
  rs.slug AS season_slug,
  rs.name AS season_name,
  DENSE_RANK() OVER (PARTITION BY rps.season_id ORDER BY rps.rating DESC, rps.wins DESC, rps.kills DESC, rps.updated_at ASC) AS rank,
  u.steam_id,
  u.username,
  rps.rating,
  CASE
    WHEN rps.rating >= 1800 THEN 'legend'
    WHEN rps.rating >= 1500 THEN 'elite'
    WHEN rps.rating >= 1250 THEN 'veteran'
    WHEN rps.rating >= 1000 THEN 'contender'
    ELSE 'rookie'
  END AS tier,
  rps.matches_played,
  rps.wins,
  rps.losses,
  rps.kills,
  rps.deaths,
  rps.assists,
  ROUND(rps.kills::NUMERIC / NULLIF(rps.deaths, 0), 2) AS kd_ratio,
  rps.last_match_at
FROM legacy_x.rank_player_seasons rps
JOIN legacy_x.rank_seasons rs ON rs.id = rps.season_id
JOIN legacy_x.users u ON u.id = rps.user_id;

ALTER TABLE legacy_x.rank_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.plugin_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_player_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.rank_match_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.rank_seasons, legacy_x.plugin_event_receipts, legacy_x.rank_player_seasons, legacy_x.rank_match_results FROM anon, authenticated;
REVOKE ALL ON legacy_x.rank_leaderboard FROM anon, authenticated;
GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT SELECT, INSERT, UPDATE ON legacy_x.rank_seasons, legacy_x.plugin_event_receipts, legacy_x.rank_player_seasons, legacy_x.rank_match_results TO service_role;
GRANT SELECT ON legacy_x.rank_leaderboard TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_rank_map_result(TEXT, TEXT, JSONB) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_reconnect.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_event_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('player_connected', 'player_disconnected', 'server_heartbeat')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_servers (
  server_id TEXT PRIMARY KEY,
  connect_address TEXT NOT NULL,
  display_name TEXT,
  current_map TEXT,
  current_mode TEXT,
  player_count INTEGER NOT NULL DEFAULT 0 CHECK (player_count >= 0),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.reconnect_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  player_name TEXT NOT NULL DEFAULT '',
  server_id TEXT NOT NULL REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  map_name TEXT,
  mode TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,
  reconnectable_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE INDEX IF NOT EXISTS reconnect_sessions_player_recent_idx ON legacy_x.reconnect_sessions (steam_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS reconnect_sessions_active_idx ON legacy_x.reconnect_sessions (server_id, reconnectable_until DESC);

CREATE OR REPLACE VIEW legacy_x.reconnect_last_played AS
SELECT
  rs.session_id,
  rs.steam_id,
  rs.player_name,
  rs.server_id,
  srv.connect_address,
  COALESCE(srv.display_name, rs.server_id) AS server_name,
  COALESCE(rs.map_name, srv.current_map) AS map_name,
  COALESCE(rs.mode, srv.current_mode) AS mode,
  rs.connected_at,
  rs.disconnected_at,
  rs.disconnect_reason,
  rs.reconnectable_until,
  srv.player_count,
  srv.last_heartbeat_at,
  srv.last_heartbeat_at >= now() - interval '90 seconds' AS server_online
FROM legacy_x.reconnect_sessions rs
JOIN legacy_x.reconnect_servers srv ON srv.server_id = rs.server_id;

CREATE OR REPLACE FUNCTION legacy_x.ingest_reconnect_event(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_event_type TEXT,
  p_session_id UUID,
  p_steam_id TEXT,
  p_player_name TEXT,
  p_server_id TEXT,
  p_server_address TEXT,
  p_map_name TEXT,
  p_mode TEXT,
  p_disconnect_reason TEXT DEFAULT NULL,
  p_reconnect_window_minutes INTEGER DEFAULT 720
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  IF p_event_type NOT IN ('player_connected', 'player_disconnected') THEN
    RAISE EXCEPTION 'Unsupported reconnect event type' USING ERRCODE = '22023';
  END IF;
  IF p_reconnect_window_minutes < 5 OR p_reconnect_window_minutes > 1440 THEN
    RAISE EXCEPTION 'Reconnect window must be between 5 and 1440 minutes' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.reconnect_event_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, current_map, current_mode)
  VALUES (p_server_id, p_server_address, NULLIF(p_map_name, ''), NULLIF(p_mode, ''))
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    current_map = COALESCE(EXCLUDED.current_map, legacy_x.reconnect_servers.current_map),
    current_mode = COALESCE(EXCLUDED.current_mode, legacy_x.reconnect_servers.current_mode),
    last_heartbeat_at = now(),
    updated_at = now();

  IF p_event_type = 'player_connected' THEN
    INSERT INTO legacy_x.reconnect_sessions (
      session_id, steam_id, player_name, server_id, map_name, mode, reconnectable_until
    ) VALUES (
      p_session_id, p_steam_id, left(COALESCE(p_player_name, ''), 128), p_server_id,
      NULLIF(p_map_name, ''), NULLIF(p_mode, ''), now() + make_interval(mins => p_reconnect_window_minutes)
    ) ON CONFLICT (session_id) DO UPDATE SET
      player_name = EXCLUDED.player_name,
      map_name = COALESCE(EXCLUDED.map_name, legacy_x.reconnect_sessions.map_name),
      mode = COALESCE(EXCLUDED.mode, legacy_x.reconnect_sessions.mode),
      updated_at = now();
  ELSE
    UPDATE legacy_x.reconnect_sessions
    SET disconnected_at = COALESCE(disconnected_at, now()),
        disconnect_reason = left(COALESCE(p_disconnect_reason, ''), 96),
        map_name = COALESCE(NULLIF(p_map_name, ''), map_name),
        mode = COALESCE(NULLIF(p_mode, ''), mode),
        updated_at = now()
    WHERE session_id = p_session_id AND steam_id = p_steam_id AND server_id = p_server_id;
  END IF;

  RETURN jsonb_build_object('status', 'accepted', 'event', p_event_type, 'session_id', p_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_reconnect_heartbeat(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_server_id TEXT,
  p_server_address TEXT,
  p_map_name TEXT,
  p_mode TEXT,
  p_player_count INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  IF p_player_count < 0 OR p_player_count > 128 THEN
    RAISE EXCEPTION 'Invalid player count' USING ERRCODE = '22023';
  END IF;
  INSERT INTO legacy_x.reconnect_event_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, 'server_heartbeat')
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;
  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, current_map, current_mode, player_count)
  VALUES (p_server_id, p_server_address, NULLIF(p_map_name, ''), NULLIF(p_mode, ''), p_player_count)
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    current_map = EXCLUDED.current_map,
    current_mode = EXCLUDED.current_mode,
    player_count = EXCLUDED.player_count,
    last_heartbeat_at = now(),
    updated_at = now();
  RETURN jsonb_build_object('status', 'accepted', 'server_id', p_server_id);
END;
$$;

ALTER TABLE legacy_x.reconnect_event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.reconnect_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.reconnect_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.reconnect_event_receipts, legacy_x.reconnect_servers, legacy_x.reconnect_sessions, legacy_x.reconnect_last_played FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.reconnect_event_receipts, legacy_x.reconnect_servers, legacy_x.reconnect_sessions, legacy_x.reconnect_last_played TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_reconnect_event(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_reconnect_heartbeat(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_retire_users_is_staff.sql
-- ======================================================================
-- DEPRECATED — superseded by legacy_x_drop_users_staff_fields.sql.
-- The canonical cleanup retires both users.is_staff and users.role only after
-- the role-free backend/frontend revision is deployed.

-- ======================================================================
-- legacy_x_server_live_match.sql
-- ======================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.server_live_match_snapshots (
  server_id TEXT PRIMARY KEY REFERENCES legacy_x.reconnect_servers(server_id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'live', 'paused', 'ended')),
  map_name TEXT NOT NULL DEFAULT '',
  round_number INTEGER CHECK (round_number IS NULL OR round_number >= 0),
  score_t INTEGER CHECK (score_t IS NULL OR score_t >= 0),
  score_ct INTEGER CHECK (score_ct IS NULL OR score_ct >= 0),
  terrorist_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(terrorist_players) = 'array'),
  counter_terrorist_players JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(counter_terrorist_players) = 'array'),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_live_match_snapshots_reported_at_idx
  ON legacy_x.server_live_match_snapshots (reported_at DESC);

ALTER TABLE legacy_x.server_live_match_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.server_live_match_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.server_live_match_snapshots TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_service_role_grants.sql
-- ======================================================================
BEGIN;

GRANT USAGE ON SCHEMA legacy_x TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA legacy_x TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA legacy_x TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA legacy_x TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA legacy_x GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA legacy_x GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA legacy_x GRANT EXECUTE ON FUNCTIONS TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_skinchanger.sql
-- ======================================================================
BEGIN;

CREATE SCHEMA IF NOT EXISTS legacy_x;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('weapon', 'weapon_skin', 'knife', 'glove', 'agent', 'music_kit', 'pin', 'sticker', 'charm')),
  weapon_class TEXT,
  display_name TEXT NOT NULL,
  weapon_defindex INTEGER,
  paint_id INTEGER,
  model TEXT,
  image_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skinchanger_catalog_browse_idx
  ON legacy_x.skinchanger_catalog_items (category, weapon_class, display_name)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION legacy_x.skinchanger_catalog_browse_key(
  p_category TEXT,
  p_weapon_class TEXT,
  p_display_name TEXT,
  p_external_key TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_category IN ('weapon_skin', 'knife', 'glove') THEN
      COALESCE(p_weapon_class, '') || ':' || regexp_replace(
        regexp_replace(regexp_replace(p_display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
        ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
      )
    ELSE p_external_key
  END
$$;

DROP FUNCTION IF EXISTS legacy_x.get_skinchanger_catalog_page(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS legacy_x.get_skinchanger_catalog_page(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_page(
  p_category TEXT DEFAULT NULL,
  p_weapon_class TEXT DEFAULT NULL,
  p_weapon_group TEXT DEFAULT NULL,
  p_team TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 36,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  external_key TEXT,
  category TEXT,
  weapon_class TEXT,
  display_name TEXT,
  weapon_defindex INTEGER,
  paint_id INTEGER,
  model TEXT,
  image_key TEXT,
  metadata JSONB,
  total_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  WITH filtered AS (
    SELECT item.*,
      CASE
        WHEN p_category IN ('glove', 'knife') AND p_weapon_class IS NULL THEN p_category || '-type:' || COALESCE(item.weapon_class, item.external_key)
        ELSE legacy_x.skinchanger_catalog_browse_key(item.category, item.weapon_class, item.display_name, item.external_key)
      END AS browse_key,
      (p_category IN ('glove', 'knife') AND p_weapon_class IS NULL) AS model_type_browse
    FROM legacy_x.skinchanger_catalog_items item
    WHERE item.is_active = true
      AND (p_category IS NULL OR item.category = p_category)
      AND (p_weapon_class IS NULL OR item.weapon_class = p_weapon_class)
      AND (
        p_weapon_group IS NULL
        OR item.metadata ->> 'weaponGroup' = p_weapon_group
        OR (p_weapon_group = 'Mid Tier' AND item.metadata ->> 'weaponGroup' IN ('SMGs', 'Heavy'))
      )
      AND (p_category IS DISTINCT FROM 'weapon' OR COALESCE(item.metadata ->> 'weaponGroup', '') IN ('Pistols', 'SMGs', 'Rifles', 'Heavy'))
      AND (p_weapon_class IS NULL OR COALESCE((item.metadata ->> 'baseModel')::BOOLEAN, false) = false)
      AND (p_team IS NULL OR item.metadata ->> 'team' = p_team)
      AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%' OR item.weapon_class ILIKE '%' || p_query || '%')
  ),
  ranges AS (
    SELECT browse_key,
      min(NULLIF(metadata ->> 'minWear', '')::NUMERIC) AS min_wear,
      max(NULLIF(metadata ->> 'maxWear', '')::NUMERIC) AS max_wear
    FROM filtered
    GROUP BY browse_key
  ),
  grouped AS (
    SELECT DISTINCT ON (browse_key)
      filtered.*, ranges.min_wear, ranges.max_wear
    FROM filtered
    JOIN ranges USING (browse_key)
    ORDER BY browse_key,
      CASE WHEN COALESCE((filtered.metadata ->> 'baseModel')::BOOLEAN, false) THEN 0 ELSE 1 END,
      CASE regexp_replace(display_name, '^.* \(([^)]*)\)$', '\1')
        WHEN 'Factory New' THEN 0
        WHEN 'Minimal Wear' THEN 1
        WHEN 'Field-Tested' THEN 2
        WHEN 'Well-Worn' THEN 3
        WHEN 'Battle-Scarred' THEN 4
        ELSE 5
      END,
      CASE
        WHEN display_name ~* '^★?[[:space:]]*StatTrak™[[:space:]]+' THEN 1
        WHEN display_name ~* '^★?[[:space:]]*Souvenir[[:space:]]+' THEN 2
        ELSE 0
      END,
      display_name
  ),
  paged AS (
    SELECT
      id,
      external_key,
      category,
      weapon_class,
      CASE
        WHEN model_type_browse THEN weapon_class
        ELSE regexp_replace(
          regexp_replace(regexp_replace(display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
          ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
        )
      END AS display_name,
      weapon_defindex,
      paint_id,
      model,
      image_key,
      jsonb_set(
        jsonb_set(
          jsonb_set(metadata, '{minWear}', to_jsonb(COALESCE(min_wear, 0.0001)::DOUBLE PRECISION), true),
          '{maxWear}', to_jsonb(COALESCE(max_wear, 1)::DOUBLE PRECISION), true
        ),
        '{baseSkinKey}', to_jsonb(browse_key), true
      ) AS metadata,
      count(*) OVER () AS total_count
    FROM grouped
  )
  SELECT *
  FROM paged
  ORDER BY
    CASE metadata ->> 'rarity'
      WHEN 'Covert' THEN 1
      WHEN 'Classified' THEN 2
      WHEN 'Restricted' THEN 3
      WHEN 'Mil-Spec Grade' THEN 4
      WHEN 'Industrial Grade' THEN 5
      WHEN 'Consumer Grade' THEN 6
      WHEN 'Contraband' THEN 7
      WHEN 'Extraordinary' THEN 8
      ELSE 99
    END,
    display_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0)
$$;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_loadouts (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_loadout_entries (
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')),
  slot_key TEXT NOT NULL CHECK (slot_key ~ '^[a-z0-9:_-]{1,96}$'),
  team_scope TEXT NOT NULL DEFAULT 'all' CHECK (team_scope IN ('all', 't', 'ct')),
  catalog_item_id UUID NOT NULL REFERENCES legacy_x.skinchanger_catalog_items(id) ON DELETE RESTRICT,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot_key, team_scope)
);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_server_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id TEXT NOT NULL,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS skinchanger_active_session_idx
  ON legacy_x.skinchanger_server_sessions (server_id, steam_id)
  WHERE disconnected_at IS NULL;
CREATE INDEX IF NOT EXISTS skinchanger_active_user_idx
  ON legacy_x.skinchanger_server_sessions (user_id, last_seen_at DESC)
  WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_apply_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  server_id TEXT NOT NULL,
  loadout_version BIGINT NOT NULL CHECK (loadout_version >= 0),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'applied', 'failed', 'cancelled')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code TEXT,
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skinchanger_jobs_queue_idx
  ON legacy_x.skinchanger_apply_jobs (server_id, status, created_at)
  WHERE status IN ('queued', 'leased');
CREATE INDEX IF NOT EXISTS skinchanger_jobs_user_idx
  ON legacy_x.skinchanger_apply_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.skinchanger_plugin_receipts (
  event_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('session_connected', 'session_heartbeat', 'session_disconnected', 'job_ack')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION legacy_x.save_skinchanger_loadout(
  p_user_id UUID,
  p_entries JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_version BIGINT;
BEGIN
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 128 THEN
    RAISE EXCEPTION 'Invalid skinchanger loadout entry count' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_entries) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB)
    LEFT JOIN legacy_x.skinchanger_catalog_items item ON item.id = entry.catalog_item_id AND item.is_active = true
    WHERE entry.slot NOT IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')
      OR entry.slot_key !~ '^[a-z0-9:_-]{1,96}$'
      OR (entry.slot = 'weapon' AND entry.slot_key !~ '^weapon:[a-z0-9_-]+$')
      OR (entry.slot <> 'weapon' AND entry.slot_key <> entry.slot)
      OR entry.team_scope NOT IN ('all', 't', 'ct')
      OR item.id IS NULL
      OR (entry.slot = 'weapon' AND item.category NOT IN ('weapon', 'weapon_skin'))
      OR (entry.slot <> 'weapon' AND item.category <> entry.slot)
  ) THEN
    RAISE EXCEPTION 'Loadout contains an unsupported catalog item' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.skinchanger_loadouts (user_id, version, updated_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET version = legacy_x.skinchanger_loadouts.version + 1,
        updated_at = now()
  RETURNING version INTO v_version;

  DELETE FROM legacy_x.skinchanger_loadout_entries WHERE user_id = p_user_id;

  INSERT INTO legacy_x.skinchanger_loadout_entries (user_id, slot, slot_key, team_scope, catalog_item_id, options, updated_at)
  SELECT
    p_user_id,
    entry.slot,
    entry.slot_key,
    entry.team_scope,
    entry.catalog_item_id,
    COALESCE(entry.options, '{}'::jsonb),
    now()
  FROM jsonb_to_recordset(p_entries) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB);

  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_facets(
  p_category TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
  SELECT jsonb_build_object(
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('category', category, 'count', item_count) ORDER BY category)
      FROM (
        SELECT category,
          CASE WHEN category IN ('glove', 'knife') THEN count(DISTINCT COALESCE(weapon_class, external_key))::INTEGER
          ELSE count(DISTINCT legacy_x.skinchanger_catalog_browse_key(category, weapon_class, display_name, external_key))::INTEGER END AS item_count
        FROM legacy_x.skinchanger_catalog_items
        WHERE is_active = true
        GROUP BY category
      ) category_counts
    ), '[]'::jsonb),
    'weaponClasses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('weaponClass', weapon_class, 'count', item_count) ORDER BY weapon_class)
      FROM (
        SELECT weapon_class, count(DISTINCT legacy_x.skinchanger_catalog_browse_key(category, weapon_class, display_name, external_key))::INTEGER AS item_count
        FROM legacy_x.skinchanger_catalog_items
        WHERE is_active = true
          AND weapon_class IS NOT NULL
          AND weapon_class <> ''
          AND (p_category IS NULL OR category = p_category)
        GROUP BY weapon_class
      ) class_counts
    ), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION legacy_x.queue_skinchanger_apply(
  p_user_id UUID,
  p_server_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_steam_id TEXT;
  v_version BIGINT;
  v_payload JSONB;
  v_job_id UUID;
BEGIN
  SELECT steam_id INTO v_steam_id FROM legacy_x.users WHERE id = p_user_id;
  SELECT version INTO v_version FROM legacy_x.skinchanger_loadouts WHERE user_id = p_user_id;
  IF v_steam_id IS NULL OR v_version IS NULL THEN
    RAISE EXCEPTION 'Skinchanger loadout is not available' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM legacy_x.skinchanger_server_sessions
    WHERE user_id = p_user_id AND server_id = p_server_id AND disconnected_at IS NULL
      AND last_seen_at >= now() - interval '90 seconds'
  ) THEN
    RAISE EXCEPTION 'Player is not active on the selected server' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_build_object(
    'version', v_version,
    'entries', COALESCE(jsonb_agg(jsonb_build_object(
      'slot', entry.slot,
      'slotKey', entry.slot_key,
      'teamScope', entry.team_scope,
      'catalogItemId', item.id,
      'category', item.category,
      'weaponDefindex', item.weapon_defindex,
      'paintId', item.paint_id,
      'model', item.model,
      'options', entry.options
    ) ORDER BY entry.slot, entry.slot_key, entry.team_scope), '[]'::jsonb)
  )
  INTO v_payload
  FROM legacy_x.skinchanger_loadout_entries entry
  JOIN legacy_x.skinchanger_catalog_items item ON item.id = entry.catalog_item_id
  WHERE entry.user_id = p_user_id;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = 'cancelled', updated_at = now()
  WHERE user_id = p_user_id AND server_id = p_server_id AND status IN ('queued', 'leased');

  INSERT INTO legacy_x.skinchanger_apply_jobs (user_id, steam_id, server_id, loadout_version, payload)
  VALUES (p_user_id, v_steam_id, p_server_id, v_version, COALESCE(v_payload, jsonb_build_object('version', v_version, 'entries', '[]'::jsonb)))
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.claim_skinchanger_apply_jobs(
  p_server_id TEXT,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  steam_id TEXT,
  loadout_version BIGINT,
  payload JSONB,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE server_id = p_server_id AND status = 'leased' AND lease_expires_at <= now();

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM legacy_x.skinchanger_apply_jobs job
    WHERE job.server_id = p_server_id AND job.status = 'queued'
    ORDER BY job.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE legacy_x.skinchanger_apply_jobs job
  SET status = 'leased',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '30 seconds',
      attempts = job.attempts + 1,
      updated_at = now()
  FROM candidates
  WHERE job.id = candidates.id
  RETURNING job.id, job.steam_id, job.loadout_version, job.payload, job.lease_token, job.lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ack_skinchanger_apply(
  p_job_id UUID,
  p_lease_token UUID,
  p_status TEXT,
  p_failure_code TEXT DEFAULT NULL,
  p_failure_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_updated UUID;
BEGIN
  IF p_status NOT IN ('applied', 'failed') THEN
    RAISE EXCEPTION 'Invalid job acknowledgement status' USING ERRCODE = '22023';
  END IF;

  UPDATE legacy_x.skinchanger_apply_jobs
  SET status = p_status,
      lease_expires_at = NULL,
      failure_code = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_failure_code, 'apply_failed'), 64) ELSE NULL END,
      failure_detail = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_failure_detail, ''), 256) ELSE NULL END,
      applied_at = CASE WHEN p_status = 'applied' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_job_id AND status = 'leased' AND lease_token = p_lease_token
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'Job lease is invalid or expired' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('status', p_status, 'jobId', v_updated);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.ingest_skinchanger_session(
  p_event_id TEXT,
  p_plugin_id TEXT,
  p_event_type TEXT,
  p_server_id TEXT,
  p_steam_id TEXT,
  p_player_name TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_user_id UUID;
  v_inserted BOOLEAN;
BEGIN
  IF p_event_type NOT IN ('session_connected', 'session_heartbeat', 'session_disconnected') THEN
    RAISE EXCEPTION 'Unsupported skinchanger session event' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.skinchanger_plugin_receipts (event_id, plugin_id, event_type)
  VALUES (p_event_id, p_plugin_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO v_inserted;
  IF NOT COALESCE(v_inserted, false) THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END IF;

  SELECT id INTO v_user_id FROM legacy_x.users WHERE steam_id = p_steam_id;
  IF p_event_type = 'session_disconnected' THEN
    UPDATE legacy_x.skinchanger_server_sessions
    SET disconnected_at = COALESCE(disconnected_at, now()), updated_at = now()
    WHERE server_id = p_server_id AND steam_id = p_steam_id AND disconnected_at IS NULL;
  ELSE
    INSERT INTO legacy_x.skinchanger_server_sessions (server_id, steam_id, user_id, player_name, last_seen_at)
    VALUES (p_server_id, p_steam_id, v_user_id, left(COALESCE(p_player_name, ''), 128), now())
    ON CONFLICT (server_id, steam_id) WHERE disconnected_at IS NULL DO UPDATE
    SET user_id = EXCLUDED.user_id,
        player_name = EXCLUDED.player_name,
        last_seen_at = now(),
        updated_at = now();
  END IF;

  RETURN jsonb_build_object('status', 'accepted', 'userId', v_user_id);
END;
$$;

ALTER TABLE legacy_x.skinchanger_catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_loadouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_loadout_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_server_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_apply_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skinchanger_plugin_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON legacy_x.skinchanger_catalog_items, legacy_x.skinchanger_loadouts, legacy_x.skinchanger_loadout_entries, legacy_x.skinchanger_server_sessions, legacy_x.skinchanger_apply_jobs, legacy_x.skinchanger_plugin_receipts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.skinchanger_catalog_items, legacy_x.skinchanger_loadouts, legacy_x.skinchanger_loadout_entries, legacy_x.skinchanger_server_sessions, legacy_x.skinchanger_apply_jobs, legacy_x.skinchanger_plugin_receipts TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.save_skinchanger_loadout(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.get_skinchanger_catalog_facets(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.queue_skinchanger_apply(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.claim_skinchanger_apply_jobs(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ack_skinchanger_apply(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_skinchanger_session(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_skinchanger_entry_mutations.sql
-- ======================================================================
-- Additive, data-preserving Skinchanger entry mutations.
-- Deploy the matching Root API and frontend before any optional legacy-key rekey.
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.upsert_skinchanger_loadout_entry(
  p_user_id UUID,
  p_expected_version BIGINT,
  p_entry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_current_version BIGINT;
  v_next_version BIGINT;
  v_slot TEXT;
  v_slot_key TEXT;
  v_team_scope TEXT;
  v_catalog_item_id UUID;
  v_options JSONB;
  v_category TEXT;
  v_weapon_class TEXT;
  v_weapon_defindex INTEGER;
  v_model_defindex INTEGER;
  v_display_name TEXT;
  v_metadata JSONB;
  v_required_scope TEXT := 'all';
  v_model_key TEXT;
  v_existing_shared_entry legacy_x.skinchanger_loadout_entries%ROWTYPE;
  v_opposite_scope TEXT;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry mutation' USING ERRCODE = '22023';
  END IF;

  SELECT entry.slot, entry.slot_key, entry.team_scope, entry.catalog_item_id, COALESCE(entry.options, '{}'::JSONB)
    INTO v_slot, v_slot_key, v_team_scope, v_catalog_item_id, v_options
  FROM jsonb_to_record(p_entry) AS entry(slot TEXT, slot_key TEXT, team_scope TEXT, catalog_item_id UUID, options JSONB);

  IF v_slot NOT IN ('weapon', 'knife', 'glove', 'agent', 'music_kit', 'pin')
     OR v_slot_key !~ '^[a-z0-9:_-]{1,96}$'
     OR v_team_scope NOT IN ('all', 't', 'ct')
     OR jsonb_typeof(v_options) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry shape' USING ERRCODE = '22023';
  END IF;

  SELECT category, weapon_class, weapon_defindex, display_name, metadata
    INTO v_category, v_weapon_class, v_weapon_defindex, v_display_name, v_metadata
  FROM legacy_x.skinchanger_catalog_items
  WHERE id = v_catalog_item_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected Skinchanger item is unavailable' USING ERRCODE = 'P0002';
  END IF;

  IF (v_slot = 'weapon' AND v_category NOT IN ('weapon', 'weapon_skin'))
     OR (v_slot <> 'weapon' AND v_category <> v_slot) THEN
    RAISE EXCEPTION 'Selected Skinchanger item does not match slot' USING ERRCODE = '22023';
  END IF;

  v_model_defindex := v_weapon_defindex;
  -- Weapon and knife skin rows deliberately retain their paint identity and
  -- have no own defindex. Resolve their stable slot model from the matching
  -- base item so client keys such as `weapon:7` and `knife:500` remain valid.
  IF v_slot IN ('weapon', 'knife') AND v_model_defindex IS NULL THEN
    SELECT base_item.weapon_defindex
      INTO v_model_defindex
    FROM legacy_x.skinchanger_catalog_items base_item
    WHERE base_item.category = v_slot
      AND base_item.weapon_class = v_weapon_class
      AND base_item.weapon_defindex IS NOT NULL
      AND base_item.is_active = true
    ORDER BY base_item.id
    LIMIT 1;
  END IF;
  v_model_key := regexp_replace(lower(COALESCE(v_model_defindex::TEXT, v_weapon_class, v_display_name, v_catalog_item_id::TEXT)), '[^a-z0-9_-]+', '-', 'g');
  IF (v_slot = 'weapon' AND v_slot_key <> ('weapon:' || v_model_key))
     OR (v_slot IN ('knife', 'glove') AND v_slot_key <> (v_slot || ':' || v_model_key))
     OR (v_slot NOT IN ('weapon', 'knife', 'glove') AND v_slot_key <> v_slot) THEN
    RAISE EXCEPTION 'Skinchanger slot key does not match selected model' USING ERRCODE = '22023';
  END IF;

  IF lower(COALESCE(v_metadata ->> 'team', '')) = 'terrorist'
     OR (v_slot = 'weapon' AND v_weapon_class IN ('AK-47', 'Galil AR', 'SG 553', 'G3SG1', 'Glock-18', 'Tec-9', 'MAC-10', 'Sawed-Off')) THEN
    v_required_scope := 't';
  ELSIF lower(COALESCE(v_metadata ->> 'team', '')) = 'counter-terrorist'
     OR (v_slot = 'weapon' AND v_weapon_class IN ('AUG', 'FAMAS', 'M4A1-S', 'M4A4', 'SCAR-20', 'USP-S', 'P2000', 'Five-SeveN', 'MP9', 'MAG-7')) THEN
    v_required_scope := 'ct';
  END IF;
  IF v_required_scope <> 'all' AND v_team_scope <> v_required_scope THEN
    RAISE EXCEPTION 'Selected Skinchanger item is limited to one team' USING ERRCODE = '22023';
  END IF;

  IF v_slot <> 'weapon' AND ((v_options ? 'stickers' AND COALESCE(jsonb_array_length(v_options -> 'stickers'), 0) > 0) OR v_options ? 'charm') THEN
    RAISE EXCEPTION 'Only weapon entries may include stickers or a charm' USING ERRCODE = '22023';
  END IF;
  IF v_options ? 'stickers' THEN
    IF jsonb_typeof(v_options -> 'stickers') <> 'array' OR jsonb_array_length(v_options -> 'stickers') > 5 THEN
      RAISE EXCEPTION 'Invalid Skinchanger sticker list' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_options -> 'stickers') AS sticker(value)
      LEFT JOIN legacy_x.skinchanger_catalog_items item ON item.id = NULLIF(sticker.value ->> 'catalogItemId', '')::UUID AND item.is_active = true
      WHERE jsonb_typeof(sticker.value) <> 'object'
         OR item.id IS NULL
         OR item.category <> 'sticker'
         OR item.weapon_defindex IS NULL
         OR NULLIF(sticker.value ->> 'slot', '')::INTEGER NOT BETWEEN 0 AND 4
    ) THEN
      RAISE EXCEPTION 'Invalid Skinchanger sticker selection' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_options -> 'stickers') AS sticker(value)
      GROUP BY sticker.value ->> 'slot' HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Skinchanger sticker slots must be unique' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_options ? 'charm' THEN
    IF jsonb_typeof(v_options -> 'charm') <> 'object' OR NOT EXISTS (
      SELECT 1 FROM legacy_x.skinchanger_catalog_items item
      WHERE item.id = NULLIF(v_options -> 'charm' ->> 'catalogItemId', '')::UUID
        AND item.is_active = true AND item.category = 'charm' AND item.weapon_defindex IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Invalid Skinchanger charm selection' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO legacy_x.skinchanger_loadouts (user_id, version, updated_at)
  VALUES (p_user_id, 0, now())
  ON CONFLICT (user_id) DO NOTHING;
  SELECT version INTO v_current_version
  FROM legacy_x.skinchanger_loadouts
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Skinchanger loadout version conflict' USING ERRCODE = 'P0001';
  END IF;

  -- A CS2 player can only have one active knife/glove per team. Preserve a
  -- pre-existing Both look by moving it to the opposite team when a distinct
  -- new look is equipped to T or CT; never allow two different Both looks.
  IF v_slot IN ('knife', 'glove') THEN
    IF v_team_scope = 'all' THEN
      IF EXISTS (
        SELECT 1
        FROM legacy_x.skinchanger_loadout_entries entry
        WHERE entry.user_id = p_user_id
          AND entry.slot = v_slot
          AND entry.team_scope IN ('all', 't', 'ct')
          AND NOT (entry.slot_key = v_slot_key AND entry.catalog_item_id = v_catalog_item_id)
      ) THEN
        RAISE EXCEPTION 'Choose T or CT because another % look is already equipped' , v_slot USING ERRCODE = '22023';
      END IF;
    ELSE
      SELECT entry.*
        INTO v_existing_shared_entry
      FROM legacy_x.skinchanger_loadout_entries entry
      WHERE entry.user_id = p_user_id
        AND entry.slot = v_slot
        AND entry.team_scope = 'all'
      ORDER BY entry.updated_at DESC
      LIMIT 1;

      IF FOUND THEN
        IF v_existing_shared_entry.catalog_item_id = v_catalog_item_id THEN
          DELETE FROM legacy_x.skinchanger_loadout_entries
          WHERE user_id = p_user_id
            AND slot_key = v_existing_shared_entry.slot_key
            AND team_scope = 'all';
        ELSE
          v_opposite_scope := CASE v_team_scope WHEN 't' THEN 'ct' ELSE 't' END;
          IF EXISTS (
            SELECT 1
            FROM legacy_x.skinchanger_loadout_entries entry
            WHERE entry.user_id = p_user_id
              AND entry.slot = v_slot
              AND entry.team_scope = v_opposite_scope
          ) THEN
            RAISE EXCEPTION 'Remove the existing % % look before changing Both' , v_opposite_scope, v_slot USING ERRCODE = '22023';
          END IF;
          UPDATE legacy_x.skinchanger_loadout_entries
          SET team_scope = v_opposite_scope, updated_at = now()
          WHERE user_id = p_user_id
            AND slot_key = v_existing_shared_entry.slot_key
            AND team_scope = 'all';
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM legacy_x.skinchanger_loadout_entries entry
        WHERE entry.user_id = p_user_id
          AND entry.slot = v_slot
          AND entry.team_scope = v_team_scope
          AND NOT (entry.slot_key = v_slot_key AND entry.catalog_item_id = v_catalog_item_id)
      ) THEN
        RAISE EXCEPTION 'A % % look is already equipped' , v_team_scope, v_slot USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  -- Preserve old generic keys during the staged rollout, but replace the old
  -- record for this exact knife/glove type to prevent duplicate application.
  IF v_slot IN ('knife', 'glove') THEN
    DELETE FROM legacy_x.skinchanger_loadout_entries entry
    USING legacy_x.skinchanger_catalog_items existing_item
    WHERE entry.user_id = p_user_id
      AND entry.slot = v_slot
      AND entry.slot_key = v_slot
      AND entry.team_scope = v_team_scope
      AND existing_item.id = entry.catalog_item_id
      AND existing_item.weapon_class = v_weapon_class;
  END IF;

  INSERT INTO legacy_x.skinchanger_loadout_entries (user_id, slot, slot_key, team_scope, catalog_item_id, options, updated_at)
  VALUES (p_user_id, v_slot, v_slot_key, v_team_scope, v_catalog_item_id, v_options, now())
  ON CONFLICT (user_id, slot_key, team_scope) DO UPDATE
    SET slot = EXCLUDED.slot,
        catalog_item_id = EXCLUDED.catalog_item_id,
        options = EXCLUDED.options,
        updated_at = now();

  UPDATE legacy_x.skinchanger_loadouts
  SET version = v_current_version + 1, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING version INTO v_next_version;
  RETURN jsonb_build_object('version', v_next_version);
END;
$$;

CREATE OR REPLACE FUNCTION legacy_x.delete_skinchanger_loadout_entry(
  p_user_id UUID,
  p_expected_version BIGINT,
  p_slot_key TEXT,
  p_team_scope TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  v_current_version BIGINT;
  v_next_version BIGINT;
  v_removed INTEGER;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_slot_key !~ '^[a-z0-9:_-]{1,96}$' OR p_team_scope NOT IN ('all', 't', 'ct') THEN
    RAISE EXCEPTION 'Invalid Skinchanger entry deletion' USING ERRCODE = '22023';
  END IF;
  SELECT version INTO v_current_version
  FROM legacy_x.skinchanger_loadouts
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Skinchanger loadout is unavailable' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Skinchanger loadout version conflict' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM legacy_x.skinchanger_loadout_entries
  WHERE user_id = p_user_id AND slot_key = p_slot_key AND team_scope = p_team_scope;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  IF v_removed <> 1 THEN
    RAISE EXCEPTION 'Skinchanger loadout entry was not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE legacy_x.skinchanger_loadouts
  SET version = v_current_version + 1, updated_at = now()
  WHERE user_id = p_user_id
  RETURNING version INTO v_next_version;
  RETURN jsonb_build_object('version', v_next_version, 'removed', true);
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.upsert_skinchanger_loadout_entry(UUID, BIGINT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.delete_skinchanger_loadout_entry(UUID, BIGINT, TEXT, TEXT) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_skinchanger_remove_external_asset_keys.sql
-- ======================================================================
-- LEGACY-X Skinchanger static asset origin cleanup.
-- Run only after the latest backend source is deployed. Existing external URLs
-- are retired so browsers never request Akamai/third-party image hosts.
-- Re-run scripts/ingest-skinchanger-catalog.mjs afterwards to repopulate these
-- records with API-owned `skinchanger/catalog/*.webp` object-storage keys.

BEGIN;

UPDATE legacy_x.skinchanger_catalog_items
SET image_key = NULL,
    metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{asset_reingest_required}',
      'true'::jsonb,
      true
    ),
    updated_at = now()
WHERE image_key ~* '^[a-z][a-z0-9+.-]*://';

COMMIT;

-- Verification: must return 0 after cleanup.
-- SELECT id, image_key
-- FROM legacy_x.skinchanger_catalog_items
-- WHERE image_key ~* '^[a-z][a-z0-9+.-]*://'
-- LIMIT 20;

-- ======================================================================
-- legacy_x_staff_panel.sql
-- ======================================================================
-- LEGACY-X staff panel: additive, audited server action queue and non-destructive product archival.
ALTER TABLE legacy_x.store_items ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS store_items_active_created_idx ON legacy_x.store_items (is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('OWNER','MANAGER','ADMIN','DEVELOPER','DESIGNER')),
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_status_role_idx ON legacy_x.staff (status, role);
ALTER TABLE legacy_x.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES legacy_x.staff(id) ON DELETE CASCADE,
  session_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS staff_sessions_active_idx ON legacy_x.staff_sessions (staff_id, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE legacy_x.staff_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_sessions TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES legacy_x.staff(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_logs_staff_created_idx ON legacy_x.staff_audit_logs (staff_id, created_at DESC);
ALTER TABLE legacy_x.staff_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_audit_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_audit_logs TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.staff_panel_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id text NOT NULL CHECK (server_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE RESTRICT,
  action_type text NOT NULL CHECK (action_type IN ('ban','unban','kick','mute','rename','map_change','server_announcement','match_announcement','hud_announcement','player_hud_alert','player_message','restart_all','restart_server','start_server','stop_server','timeout','unpause','round_restart','round_restore','player_ip_lookup')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed','cancelled')),
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_panel_actions_server_status_created_idx ON legacy_x.staff_panel_actions (server_id, status, created_at);
CREATE INDEX IF NOT EXISTS staff_panel_actions_requester_created_idx ON legacy_x.staff_panel_actions (requested_by, created_at DESC);
ALTER TABLE legacy_x.staff_panel_actions ADD COLUMN IF NOT EXISTS requested_by_staff_id uuid REFERENCES legacy_x.staff(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS staff_panel_actions_staff_created_idx ON legacy_x.staff_panel_actions (requested_by_staff_id, created_at DESC);
ALTER TABLE legacy_x.staff_panel_actions DROP CONSTRAINT IF EXISTS staff_panel_actions_action_type_check;
ALTER TABLE legacy_x.staff_panel_actions ADD CONSTRAINT staff_panel_actions_action_type_check CHECK (action_type IN ('ban','unban','kick','mute','rename','map_change','server_announcement','match_announcement','hud_announcement','player_hud_alert','player_message','restart_all','restart_server','start_server','stop_server','timeout','unpause','round_restart','round_restore','player_ip_lookup'));

CREATE TABLE IF NOT EXISTS legacy_x.staff_panel_settings (
  setting_key text PRIMARY KEY CHECK (setting_key IN ('maintenance:legacyx.cc')),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_staff_id uuid REFERENCES legacy_x.staff(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.staff_panel_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_panel_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_panel_settings TO service_role;

CREATE TABLE IF NOT EXISTS legacy_x.server_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cpu_percent numeric CHECK (cpu_percent >= 0 AND cpu_percent <= 100),
  memory_percent numeric CHECK (memory_percent >= 0 AND memory_percent <= 100),
  disk_percent numeric CHECK (disk_percent >= 0 AND disk_percent <= 100),
  load_average numeric CHECK (load_average >= 0),
  healthy boolean NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_health_snapshots_reported_idx ON legacy_x.server_health_snapshots (reported_at DESC);
ALTER TABLE legacy_x.server_health_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.server_health_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.server_health_snapshots TO service_role;
ALTER TABLE legacy_x.staff_panel_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_panel_actions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_panel_actions TO service_role;

-- ======================================================================
-- legacy_x_user_roles.sql
-- ======================================================================
-- DEPRECATED — do not execute.
-- Staff authorization now lives exclusively in legacy_x.staff.
-- legacy_x.users is identity-only and must not recreate role or is_staff columns.
-- Use legacy_x_drop_users_staff_fields.sql after deploying the role-free code.

-- ======================================================================
-- legacy_x_user_roles_player_default.sql
-- ======================================================================
-- User decision: every Steam-authenticated account is a Player by default.
-- Elevated roles remain available only through an explicit manual update.
BEGIN;

UPDATE legacy_x.users
SET role = 'Player'
WHERE role IS DISTINCT FROM 'Player';

ALTER TABLE legacy_x.users
  ALTER COLUMN role SET DEFAULT 'Player',
  ALTER COLUMN role SET NOT NULL;

COMMIT;

-- ======================================================================
-- legacy_x_player_telemetry.sql
-- ======================================================================
-- Additive, idempotent player performance and disconnect telemetry contract.
-- Run only after Supabase MCP OAuth is restored; do not apply from browser code.

CREATE TABLE IF NOT EXISTS legacy_x.player_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('round_snapshot', 'player_disconnected')),
  server_id text NOT NULL,
  server_mode text NOT NULL DEFAULT '',
  match_reference text NOT NULL,
  map_name text NOT NULL DEFAULT '',
  steam_id text NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  player_name text NOT NULL DEFAULT '',
  round_number integer NOT NULL DEFAULT 0 CHECK (round_number >= 0),
  match_state text NOT NULL DEFAULT 'live' CHECK (match_state IN ('waiting', 'live', 'paused', 'ended')),
  active_seconds integer NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  disconnect_method text NULL CHECK (disconnect_method IN ('client_disconnect', 'admin_kick', 'admin_ban', 'server_shutdown', 'unknown')),
  disconnect_reason text NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, event_id)
);

CREATE INDEX IF NOT EXISTS player_telemetry_events_player_match_idx
  ON legacy_x.player_telemetry_events (steam_id, match_reference, occurred_at DESC);
CREATE INDEX IF NOT EXISTS player_telemetry_events_disconnect_idx
  ON legacy_x.player_telemetry_events (event_type, occurred_at DESC)
  WHERE event_type = 'player_disconnected';

ALTER TABLE legacy_x.player_telemetry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.player_telemetry_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE legacy_x.player_telemetry_events TO service_role;

CREATE OR REPLACE FUNCTION legacy_x.ingest_player_telemetry_event(
  p_plugin_id text,
  p_event_id text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = legacy_x, public
AS $$
DECLARE
  inserted_id uuid;
BEGIN
  INSERT INTO legacy_x.player_telemetry_events (
    plugin_id, event_id, event_type, server_id, server_mode, match_reference, map_name,
    steam_id, player_name, round_number, match_state, active_seconds,
    disconnect_method, disconnect_reason, metrics
  ) VALUES (
    p_plugin_id, p_event_id, p_payload->>'event_type', p_payload->>'server_id',
    COALESCE(p_payload->>'server_mode', ''), p_payload->>'match_reference',
    COALESCE(p_payload->>'map_name', ''), p_payload->>'steam_id',
    COALESCE(p_payload->>'player_name', ''), COALESCE((p_payload->>'round_number')::integer, 0),
    COALESCE(p_payload->>'match_state', 'live'), COALESCE((p_payload->>'active_seconds')::integer, 0),
    NULLIF(p_payload->>'disconnect_method', ''), NULLIF(p_payload->>'disconnect_reason', ''),
    COALESCE(p_payload->'metrics', '{}'::jsonb)
  )
  ON CONFLICT (plugin_id, event_id) DO NOTHING
  RETURNING id INTO inserted_id;

  RETURN jsonb_build_object('status', CASE WHEN inserted_id IS NULL THEN 'duplicate' ELSE 'accepted' END, 'id', inserted_id);
END;
$$;

REVOKE ALL ON FUNCTION legacy_x.ingest_player_telemetry_event(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_player_telemetry_event(text, text, jsonb) TO service_role;

CREATE OR REPLACE VIEW legacy_x.player_telemetry_match_latest AS
SELECT DISTINCT ON (steam_id, match_reference)
  steam_id, player_name, match_reference, server_id, server_mode, map_name,
  round_number, active_seconds, metrics, event_type, disconnect_method,
  disconnect_reason, occurred_at
FROM legacy_x.player_telemetry_events
ORDER BY steam_id, match_reference, occurred_at DESC;

CREATE OR REPLACE VIEW legacy_x.player_telemetry_profile_summary AS
SELECT
  steam_id,
  max(player_name) AS player_name,
  count(*) AS observed_matches,
  round(avg(active_seconds))::integer AS average_active_seconds_per_match,
  round(avg(round_number), 2) AS average_round_reached,
  count(*) FILTER (WHERE event_type = 'player_disconnected') AS disconnect_count,
  round(avg(round_number) FILTER (WHERE event_type = 'player_disconnected'), 2) AS average_disconnect_round,
  sum(COALESCE((metrics->>'kills')::integer, 0)) AS total_kills,
  sum(COALESCE((metrics->>'deaths')::integer, 0)) AS total_deaths,
  sum(COALESCE((metrics->>'damage_dealt')::integer, 0)) AS total_damage_dealt,
  sum(COALESCE((metrics->>'damage_taken')::integer, 0)) AS total_damage_taken,
  CASE
    WHEN sum(COALESCE((metrics->>'deaths')::integer, 0)) = 0 THEN NULL
    ELSE round(sum(COALESCE((metrics->>'kills')::numeric, 0)) / sum(COALESCE((metrics->>'deaths')::numeric, 0)), 2)
  END AS kill_death_ratio,
  CASE
    WHEN sum(COALESCE((metrics->>'damage_taken')::integer, 0)) = 0 THEN NULL
    ELSE round(sum(COALESCE((metrics->>'damage_dealt')::numeric, 0)) / sum(COALESCE((metrics->>'damage_taken')::numeric, 0)), 2)
  END AS damage_exchange_ratio
FROM legacy_x.player_telemetry_match_latest
GROUP BY steam_id;

REVOKE ALL ON legacy_x.player_telemetry_match_latest, legacy_x.player_telemetry_profile_summary FROM anon, authenticated;
GRANT SELECT ON legacy_x.player_telemetry_match_latest, legacy_x.player_telemetry_profile_summary TO service_role;

-- ======================================================================
-- legacy_x_staff_game_permissions.sql
-- ======================================================================
-- LEGACY-X canonical in-game admin policy.
-- Apply only after legacy_x_staff_panel.sql. Users remain identity-only.
ALTER TABLE legacy_x.staff
  ADD COLUMN IF NOT EXISTS game_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stamina smallint NOT NULL DEFAULT 0 CHECK (stamina >= 0 AND stamina <= 1000),
  ADD COLUMN IF NOT EXISTS immunity smallint NOT NULL DEFAULT 0 CHECK (immunity >= 0 AND immunity <= 1000);

ALTER TABLE legacy_x.staff
  DROP CONSTRAINT IF EXISTS staff_immunity_check;
ALTER TABLE legacy_x.staff
  ADD CONSTRAINT staff_immunity_check CHECK (immunity >= 0 AND immunity <= 1000);

ALTER TABLE legacy_x.staff
  DROP CONSTRAINT IF EXISTS staff_game_permissions_array;
ALTER TABLE legacy_x.staff
  ADD CONSTRAINT staff_game_permissions_array CHECK (jsonb_typeof(game_permissions) = 'array');

CREATE INDEX IF NOT EXISTS staff_active_game_policy_idx
  ON legacy_x.staff (status, updated_at DESC)
  WHERE status = 'active';

-- The Root API service role is the only database principal that reads or writes this policy.
ALTER TABLE legacy_x.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff TO service_role;

-- ======================================================================
-- legacy_x_phantom_evidence.sql
-- ======================================================================
-- LEGACY-X Phantom: server-side anti-cheat evidence only.
-- Apply only through the restored controlled Supabase migration path.
CREATE TABLE IF NOT EXISTS legacy_x.phantom_evidence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'legacyx-phantom'),
  event_id TEXT NOT NULL CHECK (event_id ~ '^[A-Za-z0-9:_-]{8,220}$'),
  match_reference TEXT NOT NULL CHECK (char_length(match_reference) <= 255),
  server_id TEXT NOT NULL CHECK (char_length(server_id) <= 120),
  server_mode TEXT NOT NULL CHECK (char_length(server_mode) <= 64),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  phantom_id UUID NOT NULL,
  mapped_steam_id TEXT NOT NULL CHECK (mapped_steam_id ~ '^\d{15,20}$'),
  phantom_position JSONB NOT NULL,
  player_position JSONB NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 0 AND 500),
  tick BIGINT NOT NULL CHECK (tick >= 0),
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('aim_correlation', 'shot_correlation')),
  interaction_count INTEGER NOT NULL CHECK (interaction_count BETWEEN 1 AND 1000),
  aim_correlation NUMERIC(4,3) NOT NULL CHECK (aim_correlation BETWEEN 0 AND 1),
  movement_correlation NUMERIC(4,3) NOT NULL CHECK (movement_correlation BETWEEN 0 AND 1),
  wall_interaction NUMERIC(4,3) NOT NULL CHECK (wall_interaction BETWEEN 0 AND 1),
  shot_interaction NUMERIC(4,3) NOT NULL CHECK (shot_interaction BETWEEN 0 AND 1),
  suspicion_score NUMERIC(6,2) NOT NULL CHECK (suspicion_score BETWEEN 0 AND 100),
  evidence_confidence NUMERIC(4,3) NOT NULL CHECK (evidence_confidence BETWEEN 0 AND 1),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, event_id)
);

CREATE INDEX IF NOT EXISTS phantom_evidence_staff_review_idx ON legacy_x.phantom_evidence_events (occurred_at DESC, suspicion_score DESC);
CREATE INDEX IF NOT EXISTS phantom_evidence_player_idx ON legacy_x.phantom_evidence_events (steam_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.ingest_phantom_evidence(p_plugin_id TEXT, p_event_id TEXT, p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE inserted_id UUID;
BEGIN
  INSERT INTO legacy_x.phantom_evidence_events (
    plugin_id,event_id,match_reference,server_id,server_mode,steam_id,phantom_id,mapped_steam_id,phantom_position,player_position,round_number,tick,interaction_type,interaction_count,aim_correlation,movement_correlation,wall_interaction,shot_interaction,suspicion_score,evidence_confidence,occurred_at
  ) VALUES (
    p_plugin_id,p_event_id,p_payload->>'match_reference',p_payload->>'server_id',p_payload->>'server_mode',p_payload->>'steam_id',(p_payload->>'phantom_id')::uuid,p_payload->>'mapped_steam_id',p_payload->'phantom_position',p_payload->'player_position',(p_payload->>'round_number')::integer,(p_payload->>'tick')::bigint,p_payload->>'interaction_type',(p_payload->>'interaction_count')::integer,(p_payload->>'aim_correlation')::numeric,(p_payload->>'movement_correlation')::numeric,(p_payload->>'wall_interaction')::numeric,(p_payload->>'shot_interaction')::numeric,(p_payload->>'suspicion_score')::numeric,(p_payload->>'evidence_confidence')::numeric,(p_payload->>'occurred_at')::timestamptz
  ) ON CONFLICT (plugin_id,event_id) DO NOTHING RETURNING id INTO inserted_id;
  RETURN jsonb_build_object('status', CASE WHEN inserted_id IS NULL THEN 'duplicate' ELSE 'accepted' END, 'id', inserted_id);
END;
$$;

ALTER TABLE legacy_x.phantom_evidence_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.phantom_evidence_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_phantom_evidence(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE legacy_x.phantom_evidence_events TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_phantom_evidence(TEXT, TEXT, JSONB) TO service_role;

-- ======================================================================
-- legacy_x_phantom_suspensions.sql
-- ======================================================================
-- LEGACY-X Phantom suspension is an evidence-preserving temporary restriction.
-- Apply only through the controlled Supabase MCP migration flow.
CREATE TABLE IF NOT EXISTS legacy_x.phantom_suspension_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_reference TEXT NOT NULL CHECK (char_length(match_reference) <= 255),
  server_id TEXT NOT NULL CHECK (char_length(server_id) <= 120),
  server_mode TEXT NOT NULL CHECK (char_length(server_mode) <= 64),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^\d{15,20}$'),
  status TEXT NOT NULL DEFAULT 'SUSPENDED' CHECK (status IN ('ACTIVE','SUSPICIOUS','HIGH_CONFIDENCE','SUSPENDED','CLEARED','CONFIRMED')),
  suspicion_score NUMERIC(6,2) NOT NULL CHECK (suspicion_score BETWEEN 0 AND 100),
  evidence_count INTEGER NOT NULL CHECK (evidence_count BETWEEN 1 AND 10000),
  evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_manager_review BOOLEAN NOT NULL DEFAULT true,
  suspended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_staff_id UUID REFERENCES legacy_x.staff(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, match_reference, steam_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.phantom_suspension_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES legacy_x.phantom_suspension_cases(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'legacyx-phantom'),
  event_id TEXT NOT NULL CHECK (event_id ~ '^[A-Za-z0-9:_-]{8,220}$'),
  event_type TEXT NOT NULL CHECK (event_type IN ('suspended','suspended_disconnect','restored')),
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 0 AND 500),
  suspicion_score NUMERIC(6,2) NOT NULL CHECK (suspicion_score BETWEEN 0 AND 100),
  evidence_count INTEGER NOT NULL CHECK (evidence_count BETWEEN 1 AND 10000),
  evidence_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plugin_id, event_id)
);

CREATE INDEX IF NOT EXISTS phantom_suspension_active_idx ON legacy_x.phantom_suspension_cases (server_id, steam_id, updated_at DESC) WHERE status = 'SUSPENDED';
CREATE INDEX IF NOT EXISTS phantom_suspension_review_idx ON legacy_x.phantom_suspension_cases (requires_manager_review, updated_at DESC) WHERE status = 'SUSPENDED';

CREATE OR REPLACE FUNCTION legacy_x.ingest_phantom_suspension_signal(p_plugin_id TEXT, p_event_id TEXT, p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_case legacy_x.phantom_suspension_cases%ROWTYPE; v_event_id UUID;
BEGIN
  INSERT INTO legacy_x.phantom_suspension_cases (match_reference,server_id,server_mode,steam_id,status,suspicion_score,evidence_count,evidence_summary,requires_manager_review,suspended_at,updated_at)
  VALUES (p_payload->>'match_reference',p_payload->>'server_id',p_payload->>'server_mode',p_payload->>'steam_id','SUSPENDED',(p_payload->>'suspicion_score')::numeric,(p_payload->>'evidence_count')::integer,p_payload->'evidence_summary',true,(p_payload->>'occurred_at')::timestamptz,now())
  ON CONFLICT (server_id,match_reference,steam_id) DO UPDATE SET
    suspicion_score = GREATEST(legacy_x.phantom_suspension_cases.suspicion_score, EXCLUDED.suspicion_score),
    evidence_count = GREATEST(legacy_x.phantom_suspension_cases.evidence_count, EXCLUDED.evidence_count),
    evidence_summary = EXCLUDED.evidence_summary,
    status = CASE WHEN legacy_x.phantom_suspension_cases.status IN ('CLEARED','CONFIRMED') THEN legacy_x.phantom_suspension_cases.status ELSE 'SUSPENDED' END,
    requires_manager_review = CASE WHEN legacy_x.phantom_suspension_cases.status IN ('CLEARED','CONFIRMED') THEN false ELSE true END,
    updated_at = now()
  RETURNING * INTO v_case;
  INSERT INTO legacy_x.phantom_suspension_events (case_id,plugin_id,event_id,event_type,round_number,suspicion_score,evidence_count,evidence_summary,occurred_at)
  VALUES (v_case.id,p_plugin_id,p_event_id,p_payload->>'event_type',(p_payload->>'round_number')::integer,(p_payload->>'suspicion_score')::numeric,(p_payload->>'evidence_count')::integer,p_payload->'evidence_summary',(p_payload->>'occurred_at')::timestamptz)
  ON CONFLICT (plugin_id,event_id) DO NOTHING RETURNING id INTO v_event_id;
  RETURN jsonb_build_object('status', CASE WHEN v_event_id IS NULL THEN 'duplicate' ELSE 'accepted' END, 'case_id', v_case.id, 'case_status', v_case.status);
END;
$$;

ALTER TABLE legacy_x.phantom_suspension_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.phantom_suspension_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.phantom_suspension_cases, legacy_x.phantom_suspension_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION legacy_x.ingest_phantom_suspension_signal(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE legacy_x.phantom_suspension_cases, legacy_x.phantom_suspension_events TO service_role;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_phantom_suspension_signal(TEXT, TEXT, JSONB) TO service_role;

-- ======================================================================
-- legacy_x_phantom_history.sql
-- ======================================================================
-- Standalone LegacyX Phantom History. No PlayerTelemetry tables or player identity data are reused.
-- Apply only through the restored controlled Supabase MCP migration path.
CREATE TABLE IF NOT EXISTS legacy_x.phantom_history_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'legacyx-phantom'),
  source_ref UUID NOT NULL,
  match_reference TEXT NOT NULL CHECK (char_length(match_reference) <= 255),
  server_id TEXT NOT NULL CHECK (char_length(server_id) <= 120),
  server_mode TEXT NOT NULL CHECK (char_length(server_mode) <= 64),
  map_name TEXT NOT NULL CHECK (char_length(map_name) <= 128),
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 500),
  sample_count INTEGER NOT NULL CHECK (sample_count BETWEEN 3 AND 600),
  samples JSONB NOT NULL CHECK (jsonb_typeof(samples) = 'array' AND jsonb_array_length(samples) BETWEEN 3 AND 600),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, match_reference, round_number, source_ref)
);

CREATE INDEX IF NOT EXISTS phantom_history_replay_idx ON legacy_x.phantom_history_rounds (server_id, map_name, completed_at DESC) WHERE sample_count >= 12;

ALTER TABLE legacy_x.phantom_history_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE legacy_x.phantom_history_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE legacy_x.phantom_history_rounds TO service_role;

-- ======================================================================
-- legacy_x_match_rounds.sql
-- ======================================================================
-- LEGACY-X match rounds: per-round results from MatchZy `round_end` remote-log events.
-- Profile match details read these to draw the round timeline. Apply after legacy_x_rank.sql.
--
-- MatchZy quirks handled by the API layer rather than stored:
--   * `winner.team` in round_end is the team *leading* the map, not the round winner, so the round winner
--     is derived from the team score change between consecutive rounds.
--   * `winner.side` is the CS team number as text ("2" = T, "3" = CT) and is normalised to 't' / 'ct' on ingest.

CREATE TABLE IF NOT EXISTS legacy_x.match_rounds (
  match_external_id TEXT NOT NULL,
  map_number INTEGER NOT NULL CHECK (map_number >= 0),
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  winner_side TEXT CHECK (winner_side IN ('t', 'ct')),
  reason INTEGER,
  team1_score INTEGER NOT NULL CHECK (team1_score >= 0),
  team2_score INTEGER NOT NULL CHECK (team2_score >= 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_external_id, map_number, round_number)
);

-- Server-only table: the API reads it with the service role; browsers never query Supabase directly.
ALTER TABLE legacy_x.match_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.match_rounds FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.match_rounds TO service_role;

-- Match details look rank results up by match and map.
CREATE INDEX IF NOT EXISTS rank_match_results_match_map_idx
  ON legacy_x.rank_match_results (match_external_id, map_number);

-- ======================================================================
-- legacy_x_notifications.sql
-- ======================================================================
-- LEGACY-X player notifications: the feed behind the header bell.
--
-- Rows are written by the platform (today: a trigger on penalties), read by the owning player
-- through the API, and cleared by them. Safe to re-run.

CREATE TABLE IF NOT EXISTS legacy_x.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('penalty', 'match', 'system')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body TEXT CHECK (body IS NULL OR char_length(body) <= 500),
  /** Free-form context for the client, e.g. the penalty this notification came from. */
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed is always read newest-first for one player, and unread counts filter on read_at.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON legacy_x.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON legacy_x.notifications (user_id) WHERE read_at IS NULL;

-- Server-only table: the API reads it with the service role; browsers never query Supabase directly.
ALTER TABLE legacy_x.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.notifications TO service_role;

/**
 * A punishment is something the player must be told about, and the penalty row already carries
 * everything the message needs, so the feed is filled at the source rather than by a separate job.
 */
CREATE OR REPLACE FUNCTION legacy_x.notify_penalty_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE
  v_label TEXT;
  v_duration TEXT;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_label := CASE NEW.type WHEN 'ban' THEN 'banned' WHEN 'comm' THEN 'muted' WHEN 'gag' THEN 'gagged' ELSE 'penalised' END;
  v_duration := CASE
    WHEN COALESCE(NEW.is_permanent, false) THEN 'Permanent'
    WHEN NULLIF(btrim(COALESCE(NEW.term, '')), '') IS NOT NULL THEN NEW.term
    ELSE NULL
  END;

  INSERT INTO legacy_x.notifications (user_id, kind, title, body, metadata)
  VALUES (
    NEW.user_id,
    'penalty',
    'You were ' || v_label,
    left(
      COALESCE(NULLIF(btrim(COALESCE(NEW.reason, '')), ''), 'No reason given')
        || COALESCE(' · ' || v_duration, ''),
      500
    ),
    jsonb_build_object('penaltyId', NEW.id, 'type', NEW.type, 'isPermanent', COALESCE(NEW.is_permanent, false))
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS notify_penalty_issued ON legacy_x.penalties;
CREATE TRIGGER notify_penalty_issued
AFTER INSERT ON legacy_x.penalties
FOR EACH ROW EXECUTE FUNCTION legacy_x.notify_penalty_issued();

-- Verification:
-- SELECT kind, title, body, read_at, created_at FROM legacy_x.notifications ORDER BY created_at DESC LIMIT 10;

-- ======================================================================
-- legacy_x_competitive_leaderboard_all_players.sql
-- ======================================================================
-- Leaders lists every registered player, ordered by experience.
--
-- The view was built from competitive_player_progression, so a player only appeared once the game
-- servers had written progression for them. With no progression rows at all the leaderboard was
-- empty even though the community had registered accounts. It now starts from users and treats a
-- missing progression row as a real zero: 0 EXP, no matches, and the first rank.
--
-- Position is row_number so every player holds one place on the ladder; ties fall back to wins,
-- kills and the older account.

CREATE OR REPLACE VIEW legacy_x.competitive_leaderboard AS
WITH base AS (
  SELECT
    u.id AS user_id,
    u.steam_id,
    u.username,
    u.avatar,
    u.created_at,
    COALESCE(cp.current_exp, 0) AS current_exp,
    COALESCE(cp.pro_league_unlocked, false) AS pro_league_unlocked,
    COALESCE(cp.matches_completed, 0) AS matches_completed,
    COALESCE(cp.wins, 0) AS wins,
    COALESCE(cp.losses, 0) AS losses,
    COALESCE(cp.kills, 0) AS kills,
    COALESCE(cp.assists, 0) AS assists,
    COALESCE(cp.headshot_kills, 0) AS headshot_kills,
    cp.last_match_at,
    cp.current_rank_id,
    COALESCE(ps.deaths, 0) AS deaths,
    COALESCE(ps.kd_ratio, 0::numeric) AS kd_ratio,
    COALESCE(ps.played_hours, 0::numeric) AS played_hours
  FROM legacy_x.users u
  LEFT JOIN legacy_x.competitive_player_progression cp ON cp.user_id = u.id
  LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
)
SELECT
  row_number() OVER (ORDER BY b.current_exp DESC, b.wins DESC, b.kills DESC, b.created_at, b.user_id) AS "position",
  b.user_id,
  b.steam_id,
  b.username,
  b.avatar,
  b.current_exp,
  rd.rank_id,
  rd.slug AS rank_slug,
  rd.display_name AS rank_name,
  rd.image_key AS rank_image_key,
  b.pro_league_unlocked,
  b.matches_completed,
  b.wins,
  b.losses,
  b.kills,
  b.assists,
  b.headshot_kills,
  b.last_match_at,
  b.deaths,
  b.kd_ratio,
  b.played_hours
FROM base b
-- A player with progression keeps the rank the server gave them; everyone else gets the rank their
-- experience earns, which for a new account is the first one.
JOIN LATERAL (
  SELECT d.*
  FROM legacy_x.competitive_rank_definitions d
  WHERE d.rank_id = COALESCE(
    b.current_rank_id,
    (
      SELECT dd.rank_id
      FROM legacy_x.competitive_rank_definitions dd
      WHERE dd.minimum_exp <= b.current_exp
      ORDER BY dd.minimum_exp DESC
      LIMIT 1
    )
  )
) rd ON true;

-- Verification: must return one row per registered player.
-- SELECT count(*) FROM legacy_x.competitive_leaderboard;
-- SELECT "position", username, current_exp, rank_name FROM legacy_x.competitive_leaderboard ORDER BY "position" LIMIT 20;

-- ======================================================================
-- legacy_x_cleanup.sql
-- ======================================================================
-- Database cleanup, 2026-09-20.
--
-- An audit compared every table, view and function in legacy_x against the Root API, AdminPlus and
-- the CS2 plugins. Exactly one object was reachable from nothing at all; everything else that looked
-- unused from the API is written or read by an ingest function, so it stays.
--
-- Run the statements you want; each one is independent.

/* ---------------------------------------------------------------------------
 * 1. Leftover migration backup (0 rows, referenced by no code, view or function)
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.users_staff_fields_backup_20260826;

/* ---------------------------------------------------------------------------
 * 2. Session hygiene
 *
 * legacy_x.user_sessions holds 811 rows for 7 players: every refresh writes a row and nothing ever
 * removes one. Expired rows carry a refresh-token hash, so keeping them is a liability as well as
 * clutter. This deletes what has already expired; schedule it (pg_cron, or the API on boot) so it
 * keeps holding.
 * ------------------------------------------------------------------------ */

DELETE FROM legacy_x.user_sessions
WHERE expires_at < now() - interval '7 days';

-- Optional, if pg_cron is enabled on the project:
-- SELECT cron.schedule('legacyx-prune-sessions', '0 4 * * *',
--   $$DELETE FROM legacy_x.user_sessions WHERE expires_at < now() - interval '7 days'$$);

/* ---------------------------------------------------------------------------
 * 3. Verification
 * ------------------------------------------------------------------------ */

-- SELECT count(*) AS sessions_left FROM legacy_x.user_sessions;
-- SELECT to_regclass('legacy_x.users_staff_fields_backup_20260826') AS should_be_null;

-- ======================================================================
-- legacy_x_drop_shop_wallet.sql
-- ======================================================================
-- Removes the store, the wallet and the promotion system from the database.
--
-- The website, the API and the staff panel no longer contain any of it. Every table below held 0
-- rows at the time of writing, and every function below exists only to move coins between them.
--
-- Promotions go too: each of their contexts was a wallet top-up, a wallet redemption or a store
-- purchase, so with both features gone a promotion code has nothing to apply to.
--
-- Irreversible. Take a snapshot first if there is any chance of wanting this back.

BEGIN;

/* ---------------------------------------------------------------------------
 * Functions first: they depend on the tables.
 * ------------------------------------------------------------------------ */

DROP FUNCTION IF EXISTS legacy_x.purchase_store_item_with_promotion(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS legacy_x.purchase_store_item(uuid, uuid);
DROP FUNCTION IF EXISTS legacy_x.redeem_promotion_code(uuid, text, text);
DROP FUNCTION IF EXISTS legacy_x.quote_promotion_code(uuid, text, text, integer, uuid);
DROP FUNCTION IF EXISTS legacy_x.credit_wallet(uuid, integer, text);

-- Any overload the signatures above missed.
DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x'
      AND p.proname IN ('credit_wallet', 'purchase_store_item', 'purchase_store_item_with_promotion',
                        'quote_promotion_code', 'redeem_promotion_code')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', fn.signature);
  END LOOP;
END $$;

/* ---------------------------------------------------------------------------
 * Tables
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.store_purchases;
DROP TABLE IF EXISTS legacy_x.store_items;
DROP TABLE IF EXISTS legacy_x.wallet_transactions;
DROP TABLE IF EXISTS legacy_x.promotion_redemptions;
DROP TABLE IF EXISTS legacy_x.promotion_codes;
DROP TABLE IF EXISTS legacy_x.promotion_campaigns;
-- Entitlements only ever came from a redeemed promotion code.
DROP TABLE IF EXISTS legacy_x.user_entitlements;

/* ---------------------------------------------------------------------------
 * The coin balance on a player
 * ------------------------------------------------------------------------ */

ALTER TABLE legacy_x.users DROP COLUMN IF EXISTS balance;

COMMIT;

-- Verification: all of these must come back NULL / 0.
-- SELECT to_regclass('legacy_x.store_items'), to_regclass('legacy_x.wallet_transactions'),
--        to_regclass('legacy_x.promotion_campaigns'), to_regclass('legacy_x.user_entitlements');
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema = 'legacy_x' AND table_name = 'users' AND column_name = 'balance';

-- ======================================================================
-- legacy_x_admin_system.sql
-- ======================================================================
-- LEGACY-X admin & moderation system.
--
-- Permission-based roles with immunity, SteamID64 bans and mutes (with issuer immunity and a review
-- queue), player reports with reporter accuracy, sessions, name history, chat, staff notes, an
-- insert-only audit log, per-server API keys, and the Owner's management data (products,
-- announcements, name filters, versioned site config).
--
-- Every table is server-only: RLS on, nothing granted to anon/authenticated. The Root API reads and
-- writes with the service role and performs every permission check itself.
--
-- Builds on existing objects instead of duplicating them:
--   * legacy_x.users            identity (steam_id is the SteamID64)
--   * legacy_x.game_servers     extended with a hashed API key
--   * legacy_x.penalties        stays the public record; new bans/mutes link to their public row
--   * legacy_x.staff            active OWNER/MANAGER/ADMIN rows seed user_roles once
--   * legacy_x.set_updated_at() reused for updated_at columns
--
-- Safe to re-run.

BEGIN;

/* ===========================================================================
 * Roles & permissions
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.roles (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,31}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
  immunity SMALLINT NOT NULL CHECK (immunity BETWEEN 0 AND 100),
  -- A locked role's permissions and immunity cannot be reduced (the Owner role).
  is_locked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.permissions (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  description TEXT NOT NULL,
  -- Owner-only permissions may only ever be attached to a locked role.
  owner_only BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS legacy_x.role_permissions (
  role_id TEXT NOT NULL REFERENCES legacy_x.roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES legacy_x.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS legacy_x.user_roles (
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES legacy_x.roles(id) ON DELETE RESTRICT,
  granted_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON legacy_x.user_roles (role_id);

/* ===========================================================================
 * Game servers: extend the existing registry with a hashed API key
 * ======================================================================== */

ALTER TABLE legacy_x.game_servers
  ADD COLUMN IF NOT EXISTS api_key_hash TEXT,
  ADD COLUMN IF NOT EXISTS api_key_prefix TEXT,
  ADD COLUMN IF NOT EXISTS api_key_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS game_servers_api_key_hash_idx
  ON legacy_x.game_servers (api_key_hash) WHERE api_key_hash IS NOT NULL;

/* ===========================================================================
 * Bans & mutes (SteamID64 only)
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.bans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 240),
  is_permanent BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ,
  issued_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  issuer_steam_id TEXT,
  -- Captured at issue time: revoke rules compare against it even if the issuer's role changes later.
  issuer_immunity SMALLINT NOT NULL CHECK (issuer_immunity BETWEEN 0 AND 100),
  server_id UUID REFERENCES legacy_x.game_servers(id) ON DELETE SET NULL,
  match_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('panel', 'game')),
  -- Permanent bans issued below manager rank wait here for review; the ban is active meanwhile.
  review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 240),
  penalty_id UUID REFERENCES legacy_x.penalties(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bans_duration_shape CHECK ((is_permanent AND expires_at IS NULL) OR (NOT is_permanent AND expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bans_active_steam_idx ON legacy_x.bans (steam_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS bans_created_idx ON legacy_x.bans (created_at DESC);
CREATE INDEX IF NOT EXISTS bans_review_queue_idx ON legacy_x.bans (created_at) WHERE review_status = 'pending';

CREATE TABLE IF NOT EXISTS legacy_x.mutes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'all' CHECK (kind IN ('voice', 'chat', 'all')),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 240),
  is_permanent BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  issued_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  issuer_steam_id TEXT,
  issuer_immunity SMALLINT NOT NULL CHECK (issuer_immunity BETWEEN 0 AND 100),
  server_id UUID REFERENCES legacy_x.game_servers(id) ON DELETE SET NULL,
  match_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('panel', 'game')),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 240),
  penalty_id UUID REFERENCES legacy_x.penalties(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mutes_duration_shape CHECK ((is_permanent AND expires_at IS NULL) OR (NOT is_permanent AND expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mutes_active_steam_idx ON legacy_x.mutes (steam_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mutes_created_idx ON legacy_x.mutes (created_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.ban_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ban_id UUID NOT NULL REFERENCES legacy_x.bans(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 10 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  handled_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  response TEXT CHECK (response IS NULL OR char_length(response) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open appeal per ban at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_one_open_idx ON legacy_x.ban_appeals (ban_id) WHERE status = 'open';

/* ===========================================================================
 * Reports
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_steam_id TEXT NOT NULL CHECK (reporter_steam_id ~ '^7656\d{13}$'),
  reporter_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  target_steam_id TEXT NOT NULL CHECK (target_steam_id ~ '^7656\d{13}$'),
  target_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  target_name TEXT CHECK (target_name IS NULL OR char_length(target_name) <= 64),
  server_id UUID REFERENCES legacy_x.game_servers(id) ON DELETE SET NULL,
  match_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('cheating', 'griefing', 'toxicity', 'abuse', 'afk', 'other')),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  handled_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  outcome_note TEXT CHECK (outcome_note IS NULL OR char_length(outcome_note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reports_not_self CHECK (reporter_steam_id <> target_steam_id)
);
-- One report per target per match for a given reporter.
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_per_target_match_idx
  ON legacy_x.reports (reporter_steam_id, target_steam_id, match_id) WHERE match_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_open_idx ON legacy_x.reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_reporter_recent_idx ON legacy_x.reports (reporter_steam_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_target_idx ON legacy_x.reports (target_steam_id, created_at DESC);

-- Reporter accuracy: share of a reporter's resolved reports that led to action.
CREATE OR REPLACE VIEW legacy_x.reporter_accuracy
WITH (security_invoker = true) AS
SELECT
  reporter_steam_id,
  count(*)::INTEGER AS total_reports,
  count(*) FILTER (WHERE status = 'actioned')::INTEGER AS actioned_reports,
  count(*) FILTER (WHERE status = 'dismissed')::INTEGER AS dismissed_reports,
  CASE
    WHEN count(*) FILTER (WHERE status IN ('actioned', 'dismissed')) = 0 THEN NULL
    ELSE round(
      count(*) FILTER (WHERE status = 'actioned')::NUMERIC
        / count(*) FILTER (WHERE status IN ('actioned', 'dismissed')),
      3)
  END AS accuracy
FROM legacy_x.reports
GROUP BY reporter_steam_id;

/* ===========================================================================
 * Sessions, names, chat, notes
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.player_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  server_id UUID NOT NULL REFERENCES legacy_x.game_servers(id) ON DELETE CASCADE,
  match_id TEXT,
  player_name TEXT NOT NULL CHECK (char_length(player_name) BETWEEN 1 AND 64),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT CHECK (disconnect_reason IS NULL OR char_length(disconnect_reason) <= 120)
);
CREATE INDEX IF NOT EXISTS player_sessions_server_idx ON legacy_x.player_sessions (server_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_steam_idx ON legacy_x.player_sessions (steam_id, connected_at DESC);
CREATE INDEX IF NOT EXISTS player_sessions_open_idx ON legacy_x.player_sessions (steam_id) WHERE disconnected_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_x.player_name_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  times_seen INTEGER NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  last_server_id UUID REFERENCES legacy_x.game_servers(id) ON DELETE SET NULL,
  UNIQUE (steam_id, name)
);
CREATE INDEX IF NOT EXISTS player_name_history_steam_idx ON legacy_x.player_name_history (steam_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.chat_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  steam_id TEXT NOT NULL CHECK (steam_id ~ '^7656\d{13}$'),
  player_name TEXT NOT NULL CHECK (char_length(player_name) BETWEEN 1 AND 64),
  server_id UUID NOT NULL REFERENCES legacy_x.game_servers(id) ON DELETE CASCADE,
  match_id TEXT,
  team_only BOOLEAN NOT NULL DEFAULT false,
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 512),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_logs_server_idx ON legacy_x.chat_logs (server_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS chat_logs_steam_idx ON legacy_x.chat_logs (steam_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS legacy_x.staff_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_steam_id TEXT NOT NULL CHECK (target_steam_id ~ '^7656\d{13}$'),
  author_user_id UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_notes_target_idx ON legacy_x.staff_notes (target_steam_id, created_at DESC);

/* ===========================================================================
 * Game action queue: panel → game server (kick, ban enforcement, map change, …)
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.admin_game_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES legacy_x.game_servers(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('kick', 'ban', 'mute', 'unmute', 'map_change', 'round_restart', 'announce')),
  target_steam_id TEXT CHECK (target_steam_id IS NULL OR target_steam_id ~ '^7656\d{13}$'),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'done', 'failed', 'cancelled')),
  failure TEXT CHECK (failure IS NULL OR char_length(failure) <= 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS admin_game_actions_queue_idx ON legacy_x.admin_game_actions (server_id, created_at) WHERE status = 'queued';

/* ===========================================================================
 * Audit log: INSERT-only for everyone, including the Owner
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.admin_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id UUID,
  actor_steam_id TEXT,
  actor_immunity SMALLINT,
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  target_type TEXT,
  target_id TEXT,
  target_steam_id TEXT,
  server_id UUID,
  before JSONB,
  after JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON legacy_x.admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_target_steam_idx ON legacy_x.admin_audit_logs (target_steam_id, created_at DESC) WHERE target_steam_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON legacy_x.admin_audit_logs (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION legacy_x.admin_audit_logs_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'admin_audit_logs is insert-only' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS admin_audit_logs_no_update ON legacy_x.admin_audit_logs;
CREATE TRIGGER admin_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON legacy_x.admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION legacy_x.admin_audit_logs_insert_only();

DROP TRIGGER IF EXISTS admin_audit_logs_no_truncate ON legacy_x.admin_audit_logs;
CREATE TRIGGER admin_audit_logs_no_truncate
  BEFORE TRUNCATE ON legacy_x.admin_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_x.admin_audit_logs_insert_only();

/* ===========================================================================
 * Owner management data
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS legacy_x.name_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL CHECK (char_length(pattern) BETWEEN 1 AND 120),
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact', 'contains', 'regex')),
  action TEXT NOT NULL DEFAULT 'flag' CHECK (action IN ('flag', 'block')),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 240),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owner-managed catalogue records only: there is no store, wallet or purchase flow behind them.
CREATE TABLE IF NOT EXISTS legacy_x.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  price_mnt INTEGER NOT NULL DEFAULT 0 CHECK (price_mnt >= 0),
  is_active BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'ingame')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcements_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- Versioned, append-only: the active config is the highest version, and a rollback appends a copy.
CREATE TABLE IF NOT EXISTS legacy_x.site_config (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 240),
  rolled_back_from INTEGER REFERENCES legacy_x.site_config(version),
  created_by UUID REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION legacy_x.site_config_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'site_config versions are immutable; append a new version instead' USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS site_config_no_update ON legacy_x.site_config;
CREATE TRIGGER site_config_no_update
  BEFORE UPDATE OR DELETE ON legacy_x.site_config
  FOR EACH ROW EXECUTE FUNCTION legacy_x.site_config_append_only();

/* ===========================================================================
 * updated_at maintenance (reuses the existing helper)
 * ======================================================================== */

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'bans', 'mutes', 'name_filters', 'products', 'announcements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON legacy_x.%I', t, t);
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON legacy_x.%I FOR EACH ROW EXECUTE FUNCTION legacy_x.set_updated_at()', t, t);
  END LOOP;
END $$;

/* ===========================================================================
 * Owner lock, enforced in the database as well as the API
 * ======================================================================== */

CREATE OR REPLACE FUNCTION legacy_x.guard_locked_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    IF OLD.is_locked AND (NEW.immunity < OLD.immunity OR NOT NEW.is_locked OR NEW.id <> OLD.id) THEN
      RAISE EXCEPTION 'A locked role cannot be weakened' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- role_permissions: a locked role never loses a permission.
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM legacy_x.roles r WHERE r.id = OLD.role_id AND r.is_locked) THEN
    RAISE EXCEPTION 'A locked role cannot lose permissions' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS roles_guard_locked ON legacy_x.roles;
CREATE TRIGGER roles_guard_locked
  BEFORE UPDATE ON legacy_x.roles
  FOR EACH ROW EXECUTE FUNCTION legacy_x.guard_locked_roles();

DROP TRIGGER IF EXISTS role_permissions_guard_locked ON legacy_x.role_permissions;
CREATE TRIGGER role_permissions_guard_locked
  BEFORE DELETE ON legacy_x.role_permissions
  FOR EACH ROW EXECUTE FUNCTION legacy_x.guard_locked_roles();

CREATE OR REPLACE FUNCTION legacy_x.guard_owner_only_permissions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.permissions p WHERE p.key = NEW.permission_key AND p.owner_only)
     AND NOT EXISTS (SELECT 1 FROM legacy_x.roles r WHERE r.id = NEW.role_id AND r.is_locked) THEN
    RAISE EXCEPTION 'Owner-only permission % cannot be granted to role %', NEW.permission_key, NEW.role_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS role_permissions_owner_only ON legacy_x.role_permissions;
CREATE TRIGGER role_permissions_owner_only
  BEFORE INSERT OR UPDATE ON legacy_x.role_permissions
  FOR EACH ROW EXECUTE FUNCTION legacy_x.guard_owner_only_permissions();

-- The last holder of a locked role can never be removed.
CREATE OR REPLACE FUNCTION legacy_x.guard_last_locked_holder()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.roles r WHERE r.id = OLD.role_id AND r.is_locked)
     AND NOT EXISTS (SELECT 1 FROM legacy_x.user_roles ur WHERE ur.role_id = OLD.role_id AND ur.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'The last holder of role % cannot be removed', OLD.role_id USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS user_roles_guard_last_locked ON legacy_x.user_roles;
CREATE TRIGGER user_roles_guard_last_locked
  BEFORE DELETE ON legacy_x.user_roles
  FOR EACH ROW EXECUTE FUNCTION legacy_x.guard_last_locked_holder();

/* ===========================================================================
 * Session retention: 30 days
 * ======================================================================== */

CREATE OR REPLACE FUNCTION legacy_x.prune_player_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE v_removed INTEGER;
BEGIN
  DELETE FROM legacy_x.player_sessions WHERE connected_at < now() - interval '30 days';
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$function$;

-- Scheduled daily when pg_cron is available; the API also prunes opportunistically otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $cron$SELECT cron.schedule('legacyx-prune-player-sessions', '15 4 * * *', 'SELECT legacy_x.prune_player_sessions()')$cron$;
  END IF;
END $$;

/* ===========================================================================
 * Seed: roles, permissions and their grants
 * ======================================================================== */

INSERT INTO legacy_x.roles (id, name, immunity, is_locked) VALUES
  ('owner', 'Owner', 100, true),
  ('manager', 'Manager', 80, false),
  ('admin', 'Admin', 50, false),
  ('moderator', 'Moderator', 20, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO legacy_x.permissions (key, description, owner_only) VALUES
  ('panel.access', 'Open the staff panel', false),
  ('live.view', 'See live servers and the staff member''s current match', false),
  ('players.view', 'Search players and open their staff profile', false),
  ('players.moderation.view', 'Read a player''s moderation header and punishments', false),
  ('players.sessions.view', 'Read a player''s session history', false),
  ('players.chat.view', 'Read chat logs', false),
  ('players.name_history.view', 'Read a player''s name history', true),
  ('players.kick', 'Kick a player from a server', false),
  ('staff_notes.view', 'Read staff notes', false),
  ('staff_notes.create', 'Write staff notes', false),
  ('mutes.view', 'List mutes', false),
  ('mutes.issue', 'Mute a player', false),
  ('mutes.revoke', 'Lift a mute', false),
  ('bans.view', 'List bans', false),
  ('bans.issue', 'Issue a temporary ban', false),
  ('bans.permanent.issue', 'Issue a permanent ban', false),
  ('bans.revoke', 'Lift or shorten a ban', false),
  ('bans.permanent.revoke', 'Lift or shorten a permanent ban', false),
  ('bans.review', 'Review permanent bans issued below manager rank', false),
  ('appeals.view', 'Read ban appeals', false),
  ('appeals.handle', 'Accept or reject ban appeals', false),
  ('reports.view', 'Read player reports', false),
  ('reports.handle', 'Resolve player reports', false),
  ('reports.reporter.view', 'See who filed a report', false),
  ('audit.view', 'Read the admin audit log', false),
  ('servers.view', 'See game servers', false),
  ('servers.map_change', 'Change the map on a server', false),
  ('servers.round_restart', 'Restart the round on a server', false),
  ('servers.create', 'Register a game server', true),
  ('servers.delete', 'Remove a game server', true),
  ('servers.rotate_key', 'Rotate a game server API key', true),
  ('roles.assign', 'Give a player a staff role', true),
  ('roles.revoke', 'Take a staff role away', true),
  ('roles.permissions.edit', 'Change what a role can do', true),
  ('roles.immunity.edit', 'Change a role''s immunity', true),
  ('products.view', 'See products', true),
  ('products.create', 'Create products', true),
  ('products.update', 'Edit products', true),
  ('products.delete', 'Delete products', true),
  ('announce.web', 'Publish website announcements', true),
  ('announce.ingame', 'Publish in-game announcements', true),
  ('site.customize', 'Edit and roll back the site configuration', true),
  ('name_filter.manage', 'Manage the player name filter', true)
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, owner_only = EXCLUDED.owner_only;

-- Owner: everything.
INSERT INTO legacy_x.role_permissions (role_id, permission_key)
SELECT 'owner', key FROM legacy_x.permissions
ON CONFLICT DO NOTHING;

-- Manager and Admin share one set; Manager adds permanent-ban revoke, the review queue and reporter identity.
INSERT INTO legacy_x.role_permissions (role_id, permission_key)
SELECT r.role_id, p.key
FROM (VALUES ('manager'), ('admin')) AS r(role_id)
CROSS JOIN (VALUES
  ('panel.access'), ('live.view'), ('players.view'), ('players.moderation.view'), ('players.sessions.view'),
  ('players.chat.view'), ('players.kick'), ('staff_notes.view'), ('staff_notes.create'), ('mutes.view'),
  ('mutes.issue'), ('mutes.revoke'), ('bans.view'), ('bans.issue'), ('bans.permanent.issue'), ('bans.revoke'),
  ('appeals.view'), ('appeals.handle'), ('reports.view'), ('reports.handle'), ('audit.view'), ('servers.view'),
  ('servers.map_change'), ('servers.round_restart')
) AS p(key)
ON CONFLICT DO NOTHING;

INSERT INTO legacy_x.role_permissions (role_id, permission_key) VALUES
  ('manager', 'bans.permanent.revoke'),
  ('manager', 'bans.review'),
  ('manager', 'reports.reporter.view')
ON CONFLICT DO NOTHING;

-- Moderator: kick, mute, view reports (plus what it takes to reach those screens).
INSERT INTO legacy_x.role_permissions (role_id, permission_key) VALUES
  ('moderator', 'panel.access'),
  ('moderator', 'live.view'),
  ('moderator', 'players.view'),
  ('moderator', 'players.moderation.view'),
  ('moderator', 'players.kick'),
  ('moderator', 'mutes.view'),
  ('moderator', 'mutes.issue'),
  ('moderator', 'mutes.revoke'),
  ('moderator', 'reports.view'),
  ('moderator', 'servers.view')
ON CONFLICT DO NOTHING;

-- Carry the existing staff directory over once.
DO $$
BEGIN
  IF to_regclass('legacy_x.staff') IS NOT NULL THEN
    INSERT INTO legacy_x.user_roles (user_id, role_id)
    SELECT s.user_id,
           CASE s.role WHEN 'OWNER' THEN 'owner' WHEN 'MANAGER' THEN 'manager' ELSE 'admin' END
    FROM legacy_x.staff s
    WHERE s.status = 'active' AND s.role IN ('OWNER', 'MANAGER', 'ADMIN')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

/* ===========================================================================
 * Access: server-only
 * ======================================================================== */

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles', 'permissions', 'role_permissions', 'user_roles', 'bans', 'mutes', 'ban_appeals', 'reports',
    'player_sessions', 'player_name_history', 'chat_logs', 'staff_notes', 'admin_game_actions',
    'admin_audit_logs', 'name_filters', 'products', 'announcements', 'site_config'
  ] LOOP
    EXECUTE format('ALTER TABLE legacy_x.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON legacy_x.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON legacy_x.reporter_accuracy FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  legacy_x.roles, legacy_x.permissions, legacy_x.role_permissions, legacy_x.user_roles,
  legacy_x.bans, legacy_x.mutes, legacy_x.ban_appeals, legacy_x.reports,
  legacy_x.player_sessions, legacy_x.player_name_history, legacy_x.chat_logs, legacy_x.staff_notes,
  legacy_x.admin_game_actions, legacy_x.name_filters, legacy_x.products, legacy_x.announcements
TO service_role;
GRANT SELECT ON legacy_x.reporter_accuracy TO service_role;

-- The two append-only tables: read and insert, never change.
GRANT SELECT, INSERT ON legacy_x.admin_audit_logs, legacy_x.site_config TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON legacy_x.admin_audit_logs, legacy_x.site_config FROM service_role;

GRANT EXECUTE ON FUNCTION legacy_x.prune_player_sessions() TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_skinchanger_stateless_pull.sql
-- ======================================================================
-- Skinchanger: from a queue to a stateless pull.
--
-- Before: the website queued an apply job, the plugin tracked server sessions, claimed jobs,
-- applied them and acknowledged each one. After: the plugin reads the player's saved loadout on
-- demand (GET /plugin/skinchanger/loadout, when the player types !rs). Nothing is queued and no
-- session is tracked, so the queue, the session table and the plugin receipts go.
--
-- Kept untouched: skinchanger_catalog_items, skinchanger_loadouts, skinchanger_loadout_entries and
-- the catalog / loadout functions.
--
-- At the time of writing all three dropped tables held 0 rows, nothing else referenced them (their
-- only foreign keys point out to legacy_x.users), and only the four functions below touched them.
--
-- Irreversible. Apply only after the backend without the queue routes is deployed, and after the
-- SkinBridge plugin has moved to the pull route — the current plugin still calls the session and job
-- endpoints.

BEGIN;

/* ---------------------------------------------------------------------------
 * Functions first: they depend on the tables.
 * ------------------------------------------------------------------------ */

DROP FUNCTION IF EXISTS legacy_x.queue_skinchanger_apply(uuid, text);
DROP FUNCTION IF EXISTS legacy_x.claim_skinchanger_apply_jobs(text, integer);
DROP FUNCTION IF EXISTS legacy_x.ack_skinchanger_apply(uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS legacy_x.ingest_skinchanger_session(text, text, text, text, text, text);

-- Any overload the signatures above missed.
DO $$
DECLARE fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x'
      AND p.proname IN ('queue_skinchanger_apply', 'claim_skinchanger_apply_jobs', 'ack_skinchanger_apply', 'ingest_skinchanger_session')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', fn.signature);
  END LOOP;
END $$;

/* ---------------------------------------------------------------------------
 * Tables (no CASCADE: if anything still depends on them, stop instead)
 * ------------------------------------------------------------------------ */

DROP TABLE IF EXISTS legacy_x.skinchanger_apply_jobs;
DROP TABLE IF EXISTS legacy_x.skinchanger_server_sessions;
DROP TABLE IF EXISTS legacy_x.skinchanger_plugin_receipts;

COMMIT;

-- Verification: every value must come back NULL / 0.
-- SELECT to_regclass('legacy_x.skinchanger_apply_jobs'), to_regclass('legacy_x.skinchanger_server_sessions'),
--        to_regclass('legacy_x.skinchanger_plugin_receipts');
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x'
--    AND p.proname IN ('queue_skinchanger_apply', 'claim_skinchanger_apply_jobs', 'ack_skinchanger_apply', 'ingest_skinchanger_session');

-- ======================================================================
-- legacy_x_profile_privacy.sql
-- ======================================================================
-- LEGACY-X profile privacy: boxes a player chose to hide from other players on their profile.
-- Additive only: a new column with an empty default, so existing profiles show everything as before.
-- Penalty history, SteamID, Steam link and rank are never hideable and have no entry here.

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS hidden_profile_sections TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['kd', 'matches', 'kills', 'faceit', 'recent_matches']::TEXT[]);

COMMENT ON COLUMN legacy_x.users.hidden_profile_sections IS
  'Profile boxes hidden from other players: kd, matches, kills, faceit, recent_matches.';

-- ======================================================================
-- legacy_x_rank_system_v1.sql
-- ======================================================================
-- Legacy-X rank system v1.0 (docs/design/RANK-SYSTEM.md).
--
-- One number per player — EXP — that goes up and down after each ranked match.
-- The formula lives in TypeScript (server/legacyX/ranking.ts); this migration gives it:
--   * the new 18-rank ladder (Recruit I … Legacy, 0 … 2300),
--   * a per-player, per-match EXP snapshot (exp_before / exp_delta / exp_after / exp_breakdown),
--   * one SQL function that applies every delta of a match atomically and idempotently,
--   * everyone starting at 1000 EXP (Operator I).
-- It retires the old "+500 per win, never lose EXP" ingestion and its action ledger.

BEGIN;

-- ── 1. Rank ladder ────────────────────────────────────────────────────────────
-- Two passes because slug, display_name and minimum_exp are each UNIQUE.
UPDATE legacy_x.competitive_rank_definitions
SET slug = 'tmp-' || rank_id, display_name = 'tmp ' || rank_id, minimum_exp = 100000 + rank_id;

UPDATE legacy_x.competitive_rank_definitions d
SET slug = v.slug,
    display_name = v.display_name,
    minimum_exp = v.minimum_exp,
    image_key = v.image_key,
    pro_league_eligible = v.rank_id >= 11
FROM (VALUES
  (1,  'recruit-i',    'Recruit I',    0,    'rank-01'),
  (2,  'recruit-ii',   'Recruit II',   600,  'rank-02'),
  (3,  'recruit-iii',  'Recruit III',  700,  'rank-03'),
  (4,  'recruit-iv',   'Recruit IV',   800,  'rank-04'),
  (5,  'recruit-v',    'Recruit V',    900,  'rank-05'),
  (6,  'recruit-vi',   'Recruit VI',   950,  'rank-06'),
  (7,  'operator-i',   'Operator I',   1000, 'rank-07'),
  (8,  'operator-ii',  'Operator II',  1100, 'rank-08'),
  (9,  'operator-iii', 'Operator III', 1200, 'rank-09'),
  (10, 'operator-iv',  'Operator IV',  1300, 'rank-10'),
  (11, 'vanguard-i',   'Vanguard I',   1400, 'rank-11'),
  (12, 'vanguard-ii',  'Vanguard II',  1500, 'rank-12'),
  (13, 'vanguard-iii', 'Vanguard III', 1600, 'rank-13'),
  (14, 'vanguard-iv',  'Vanguard IV',  1700, 'rank-14'),
  (15, 'ace-i',        'Ace I',        1800, 'rank-15'),
  (16, 'ace-ii',       'Ace II',       1950, 'rank-16'),
  (17, 'apex',         'Apex',         2100, 'rank-17'),
  (18, 'legacy',       'Legacy',       2300, 'rank-18')
) AS v(rank_id, slug, display_name, minimum_exp, image_key)
WHERE d.rank_id = v.rank_id;

-- ── 2. Progression: start at 1000, keep deaths for K/D ranking ───────────────
ALTER TABLE legacy_x.competitive_player_progression
  ALTER COLUMN current_exp SET DEFAULT 1000,
  ALTER COLUMN current_rank_id SET DEFAULT 7,
  ADD COLUMN IF NOT EXISTS deaths INTEGER NOT NULL DEFAULT 0 CHECK (deaths >= 0),
  ADD COLUMN IF NOT EXISTS draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0);

-- Launch: every player starts at 1000 EXP / Operator I (progression was empty, nothing is lost).
UPDATE legacy_x.competitive_player_progression
SET current_exp = 1000, current_rank_id = 7, pro_league_unlocked = false, updated_at = now();
INSERT INTO legacy_x.competitive_player_progression (user_id, current_exp, current_rank_id)
SELECT u.id, 1000, 7 FROM legacy_x.users u
ON CONFLICT (user_id) DO NOTHING;
UPDATE legacy_x.users SET rank = 'Operator I', updated_at = now();

-- ── 3. Per-player EXP snapshot of each ranked match ──────────────────────────
CREATE TABLE IF NOT EXISTS legacy_x.competitive_match_exp (
  event_id TEXT NOT NULL REFERENCES legacy_x.competitive_event_receipts(event_id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES legacy_x.core_matches(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  team_key TEXT NOT NULL CHECK (team_key IN ('team1', 'team2')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'loss')),
  exp_before INTEGER NOT NULL CHECK (exp_before >= 0),
  exp_delta INTEGER NOT NULL CHECK (exp_delta BETWEEN -90 AND 90),
  exp_after INTEGER NOT NULL CHECK (exp_after >= 0),
  rank_before SMALLINT NOT NULL REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  rank_after SMALLINT NOT NULL REFERENCES legacy_x.competitive_rank_definitions(rank_id),
  exp_breakdown JSONB NOT NULL,
  counts_as_ranked BOOLEAN NOT NULL,
  calculation_version TEXT NOT NULL CHECK (length(calculation_version) BETWEEN 3 AND 40),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id),
  CHECK (exp_after = exp_before + exp_delta)
);
CREATE INDEX IF NOT EXISTS competitive_match_exp_user_created_idx ON legacy_x.competitive_match_exp (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS competitive_match_exp_match_idx ON legacy_x.competitive_match_exp (match_id);
ALTER TABLE legacy_x.competitive_match_exp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.competitive_match_exp FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON legacy_x.competitive_match_exp TO service_role;

ALTER TABLE legacy_x.competitive_event_receipts
  ADD COLUMN IF NOT EXISTS calculation_version TEXT,
  ADD COLUMN IF NOT EXISTS summary JSONB;

-- ── 4. Apply one match: receipt + every player's delta, atomically, once ─────
-- p_players: [{ user_id, team_key, outcome, exp_before, exp_delta, exp_breakdown, counts_as_ranked,
--              pro_league_unlocked, kills, deaths, assists, headshot_kills, stats }]
-- The EXP was computed from exp_before; if any player's EXP moved since, the call fails with
-- 40001 so the caller recalculates instead of applying a stale delta.
CREATE OR REPLACE FUNCTION legacy_x.apply_competitive_match_exp(
  p_plugin_id TEXT,
  p_event_id TEXT,
  p_match_id UUID,
  p_calculation_version TEXT,
  p_summary JSONB,
  p_players JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $$
DECLARE
  v_player JSONB;
  v_user_id UUID;
  v_before INTEGER;
  v_delta INTEGER;
  v_after INTEGER;
  v_current INTEGER;
  v_prev_unlocked BOOLEAN;
  v_rank_before SMALLINT;
  v_rank_after SMALLINT;
  v_rank_name TEXT;
  v_counts BOOLEAN;
  v_outcome TEXT;
  v_unlocked BOOLEAN;
  v_applied INTEGER := 0;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Only legacyx-match-core may apply competitive EXP' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_players) <> 'array' THEN
    RAISE EXCEPTION 'players must be an array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.competitive_event_receipts (event_id, plugin_id, match_id, payload, calculation_version, summary)
  VALUES (p_event_id, p_plugin_id, p_match_id, jsonb_build_object('players', p_players), p_calculation_version, p_summary)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'event_id', p_event_id);
  END IF;

  PERFORM 1 FROM legacy_x.core_matches WHERE id = p_match_id AND state = 'FINISHED' AND final_event_id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'competitive EXP requires the stored final Match Core event' USING ERRCODE = '22023';
  END IF;

  FOR v_player IN SELECT value FROM jsonb_array_elements(p_players) ORDER BY value ->> 'user_id' LOOP
    v_user_id := (v_player ->> 'user_id')::UUID;
    v_before := (v_player ->> 'exp_before')::INTEGER;
    v_delta := (v_player ->> 'exp_delta')::INTEGER;
    v_counts := COALESCE((v_player ->> 'counts_as_ranked')::BOOLEAN, false);
    v_outcome := v_player ->> 'outcome';

    INSERT INTO legacy_x.competitive_player_progression (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
    SELECT current_exp, pro_league_unlocked INTO v_current, v_prev_unlocked
    FROM legacy_x.competitive_player_progression WHERE user_id = v_user_id FOR UPDATE;
    IF v_current <> v_before THEN
      RAISE EXCEPTION 'EXP for % changed since the calculation', v_user_id USING ERRCODE = '40001';
    END IF;

    v_after := GREATEST(0, v_before + v_delta);
    SELECT rank_id INTO v_rank_before FROM legacy_x.competitive_rank_for_exp(v_before);
    SELECT rank_id, display_name INTO v_rank_after, v_rank_name FROM legacy_x.competitive_rank_for_exp(v_after);
    -- Pro League opens at 1400 and is only taken away below 1350.
    v_unlocked := v_after >= 1400 OR (v_prev_unlocked AND v_after >= 1350);

    INSERT INTO legacy_x.competitive_match_exp (
      event_id, match_id, user_id, team_key, outcome, exp_before, exp_delta, exp_after,
      rank_before, rank_after, exp_breakdown, counts_as_ranked, calculation_version, stats
    ) VALUES (
      p_event_id, p_match_id, v_user_id, v_player ->> 'team_key', v_outcome, v_before, v_after - v_before, v_after,
      v_rank_before, v_rank_after, COALESCE(v_player -> 'exp_breakdown', '{}'::jsonb), v_counts, p_calculation_version,
      COALESCE(v_player -> 'stats', '{}'::jsonb)
    );

    UPDATE legacy_x.competitive_player_progression SET
      current_exp = v_after,
      current_rank_id = v_rank_after,
      pro_league_unlocked = v_unlocked,
      matches_completed = matches_completed + CASE WHEN v_counts THEN 1 ELSE 0 END,
      wins = wins + CASE WHEN v_counts AND v_outcome = 'win' THEN 1 ELSE 0 END,
      losses = losses + CASE WHEN v_counts AND v_outcome = 'loss' THEN 1 ELSE 0 END,
      draws = draws + CASE WHEN v_counts AND v_outcome = 'draw' THEN 1 ELSE 0 END,
      kills = kills + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'kills')::INTEGER, 0)) ELSE 0 END,
      deaths = deaths + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'deaths')::INTEGER, 0)) ELSE 0 END,
      assists = assists + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'assists')::INTEGER, 0)) ELSE 0 END,
      headshot_kills = headshot_kills + CASE WHEN v_counts THEN GREATEST(0, COALESCE((v_player ->> 'headshot_kills')::INTEGER, 0)) ELSE 0 END,
      last_match_at = now(),
      updated_at = now()
    WHERE user_id = v_user_id;

    -- Display-only copy of the rank name on the user row.
    UPDATE legacy_x.users SET rank = v_rank_name, updated_at = now() WHERE id = v_user_id;
    v_applied := v_applied + 1;
  END LOOP;

  UPDATE legacy_x.competitive_event_receipts SET processed_at = now() WHERE event_id = p_event_id;
  INSERT INTO legacy_x.adminplus_audit_logs (actor_type, actor_id, action, target_type, target_id, metadata)
  VALUES ('plugin', p_plugin_id, 'competitive.exp.match.apply', 'competitive_match', p_match_id,
          jsonb_build_object('eventId', p_event_id, 'players', v_applied, 'version', p_calculation_version, 'summary', p_summary));
  RETURN jsonb_build_object('status', 'processed', 'event_id', p_event_id, 'match_id', p_match_id, 'players', v_applied);
END;
$$;
REVOKE ALL ON FUNCTION legacy_x.apply_competitive_match_exp(TEXT, TEXT, UUID, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.apply_competitive_match_exp(TEXT, TEXT, UUID, TEXT, JSONB, JSONB) TO service_role;

-- ── 5. Read models: players without a row still show as 1000 / Operator I ────
DROP VIEW IF EXISTS legacy_x.competitive_leaderboard;
CREATE VIEW legacy_x.competitive_leaderboard WITH (security_invoker = true) AS
WITH base AS (
  SELECT u.id AS user_id, u.steam_id, u.username, u.avatar, u.created_at,
         COALESCE(cp.current_exp, 1000) AS current_exp,
         COALESCE(cp.pro_league_unlocked, false) AS pro_league_unlocked,
         COALESCE(cp.matches_completed, 0) AS matches_completed,
         COALESCE(cp.wins, 0) AS wins,
         COALESCE(cp.losses, 0) AS losses,
         COALESCE(cp.kills, 0) AS kills,
         COALESCE(cp.deaths, 0) AS deaths,
         COALESCE(cp.assists, 0) AS assists,
         COALESCE(cp.headshot_kills, 0) AS headshot_kills,
         cp.last_match_at,
         COALESCE(ps.played_hours, 0::numeric) AS played_hours
  FROM legacy_x.users u
  LEFT JOIN legacy_x.competitive_player_progression cp ON cp.user_id = u.id
  LEFT JOIN legacy_x.player_stats ps ON ps.user_id = u.id
)
SELECT row_number() OVER (ORDER BY b.current_exp DESC, b.wins DESC, b.kills DESC, b.created_at, b.user_id) AS position,
       b.user_id, b.steam_id, b.username, b.avatar, b.current_exp,
       rd.rank_id, rd.slug AS rank_slug, rd.display_name AS rank_name, rd.image_key AS rank_image_key,
       b.pro_league_unlocked, b.matches_completed, b.wins, b.losses, b.kills, b.assists, b.headshot_kills,
       b.last_match_at, b.deaths,
       CASE WHEN b.deaths > 0 THEN round(b.kills::numeric / b.deaths, 2) ELSE b.kills::numeric END AS kd_ratio,
       CASE WHEN b.matches_completed > 0 THEN round(b.wins::numeric / b.matches_completed, 4) ELSE 0 END AS win_rate,
       b.played_hours
FROM base b
CROSS JOIN LATERAL legacy_x.competitive_rank_for_exp(b.current_exp) r
JOIN legacy_x.competitive_rank_definitions rd ON rd.rank_id = r.rank_id;

DROP VIEW IF EXISTS legacy_x.competitive_player_profiles;
CREATE VIEW legacy_x.competitive_player_profiles WITH (security_invoker = true) AS
SELECT u.id AS user_id, u.steam_id, u.username, u.avatar,
       COALESCE(cpp.current_exp, 1000) AS current_exp,
       d.rank_id, d.slug AS rank_slug, d.display_name AS rank_name, d.image_key AS rank_image_key,
       COALESCE(cpp.pro_league_unlocked, false) AS pro_league_unlocked,
       COALESCE(cpp.matches_completed, 0) AS matches_completed,
       COALESCE(cpp.wins, 0) AS wins,
       COALESCE(cpp.losses, 0) AS losses,
       COALESCE(cpp.kills, 0) AS kills,
       COALESCE(cpp.deaths, 0) AS deaths,
       COALESCE(cpp.assists, 0) AS assists,
       COALESCE(cpp.headshot_kills, 0) AS headshot_kills,
       cpp.last_match_at,
       d.minimum_exp AS current_rank_min_exp,
       next_d.rank_id AS next_rank_id,
       next_d.display_name AS next_rank_name,
       next_d.minimum_exp AS next_rank_min_exp
FROM legacy_x.users u
LEFT JOIN legacy_x.competitive_player_progression cpp ON cpp.user_id = u.id
CROSS JOIN LATERAL legacy_x.competitive_rank_for_exp(COALESCE(cpp.current_exp, 1000)) r
JOIN legacy_x.competitive_rank_definitions d ON d.rank_id = r.rank_id
LEFT JOIN legacy_x.competitive_rank_definitions next_d ON next_d.rank_id = d.rank_id + 1;

GRANT SELECT ON legacy_x.competitive_leaderboard, legacy_x.competitive_player_profiles TO service_role;

-- ── 6. Retire the old ingestion ──────────────────────────────────────────────
DROP FUNCTION IF EXISTS legacy_x.ingest_competitive_match_result(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS legacy_x.competitive_metric(JSONB, TEXT, INTEGER);
DROP TABLE IF EXISTS legacy_x.competitive_exp_ledger;

COMMIT;

-- ======================================================================
-- legacy_x_reconnect_server_capacity.sql
-- ======================================================================
-- Play pages: real slot counts and optional GOTV address per server, reported by the
-- LegacyX-Reconnect heartbeat (max_players = Server.MaxPlayers, gotv_address = LEGACYX_GOTV_ADDRESS).
-- Both are nullable: older plugins keep working and the site falls back to 10 slots / no Spectate.
BEGIN;

ALTER TABLE legacy_x.reconnect_servers
  ADD COLUMN IF NOT EXISTS max_players integer CHECK (max_players IS NULL OR max_players BETWEEN 1 AND 128),
  ADD COLUMN IF NOT EXISTS gotv_address text CHECK (gotv_address IS NULL OR char_length(gotv_address) <= 255);
COMMENT ON COLUMN legacy_x.reconnect_servers.max_players IS 'Server slot count from the reconnect plugin heartbeat (Server.MaxPlayers).';
COMMENT ON COLUMN legacy_x.reconnect_servers.gotv_address IS 'Optional GOTV address (LEGACYX_GOTV_ADDRESS) for Spectate on the Play page.';

COMMIT;

-- ======================================================================
-- legacy_x_tournaments_player_registration.sql
-- ======================================================================
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

-- ======================================================================
-- legacy_x_v1_cleanup.sql
-- ======================================================================
-- Legacy-X v1 cleanup: one ranking source of truth (competitive EXP), no clans, no seasonal rank, no dead match tables.
--
-- Every object dropped here was checked against the frontend, the root API, AdminPlus, the CS2 plugins, SQL
-- functions/views and the deploy config (see docs/V1_CLEANUP_AUDIT.md). All of them hold 0 rows except
-- rank_seasons (the single "season-1" definition that only the seasonal rank used).
--
-- Deploy order: ship the API that no longer reads these objects FIRST, then run this file once.
BEGIN;

-- 1. Match Core no longer needs an active rank season to create a match, and match_created inserts the match
--    before its event row (the previous order violated core_match_events_match_id_fkey on every new match).
CREATE OR REPLACE FUNCTION legacy_x.ingest_core_match_event(p_plugin_id text, p_event_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE
  v_type TEXT := COALESCE(p_payload->>'event_type', '');
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_team JSONB;
  v_player JSONB;
  v_user_id UUID;
  v_steam_id TEXT;
  v_team_key TEXT;
  v_slot INTEGER;
  v_expected INTEGER;
  v_new_state TEXT;
  v_participant legacy_x.core_match_participants%ROWTYPE;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Unsupported Match Core plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_type = 'match_created' THEN
    v_match_id := (p_payload->>'match_id')::UUID;
    IF jsonb_array_length(COALESCE(p_payload->'participants', '[]'::jsonb)) <> 10 THEN
      RAISE EXCEPTION 'match_created requires exactly 10 original participants' USING ERRCODE = '22023';
    END IF;
    -- The match row must exist before its first event row (core_match_events.match_id references it).
    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, state, map_name, map_number)
    VALUES (v_match_id,
            p_payload->>'server_id',
            NULLIF(p_payload->>'matchzy_local_id', ''),
            'WAITING',
            p_payload->>'map_name',
            COALESCE((p_payload->>'map_number')::INTEGER, 0))
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'event_id % was already used for another match', p_event_id USING ERRCODE = '22023';
    END IF;

    FOR v_player IN SELECT value FROM jsonb_array_elements(p_payload->'participants') LOOP
      v_steam_id := v_player->>'steam_id';
      v_team_key := v_player->>'team_key';
      v_slot := (v_player->>'slot_index')::INTEGER;
      IF v_steam_id !~ '^\d{15,20}$' OR v_team_key NOT IN ('team1', 'team2') OR v_slot NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'invalid original participant' USING ERRCODE = '22023';
      END IF;
      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;
      INSERT INTO legacy_x.core_match_participants (match_id, user_id, steam_id, team_key, slot_index, original_name)
      VALUES (v_match_id, v_user_id, v_steam_id, v_team_key, v_slot, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id));
      INSERT INTO legacy_x.core_match_slots (match_id, team_key, slot_index, original_user_id, active_user_id, active_role)
      VALUES (v_match_id, v_team_key, v_slot, v_user_id, v_user_id, 'original');
    END LOOP;
    RETURN jsonb_build_object('status', 'created', 'match_id', v_match_id, 'state', 'WAITING', 'revision', 1);
  END IF;

  v_match_id := (p_payload->>'match_id')::UUID;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = v_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  v_expected := COALESCE((p_payload->>'expected_revision')::INTEGER, -1);
  IF v_expected <> v_match.revision THEN
    RETURN jsonb_build_object('status', 'stale', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, v_match_id, v_type, v_expected, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  IF v_type = 'state_transition' THEN
    v_new_state := p_payload->>'state';
    IF (v_match.state = 'WAITING' AND v_new_state = 'LIVE') OR
       (v_match.state = 'LIVE' AND v_new_state = 'PAUSED') OR
       (v_match.state = 'PAUSED' AND v_new_state = 'LIVE') OR
       (v_match.state IN ('LIVE', 'PAUSED') AND v_new_state IN ('FINISHED', 'CANCELLED')) THEN
      IF v_new_state = 'LIVE' AND NOT legacy_x.core_match_active_slots_ready(v_match_id) THEN
        RAISE EXCEPTION 'cannot resume without exactly ten active slots' USING ERRCODE = '22023';
      END IF;
      UPDATE legacy_x.core_matches SET
        state = v_new_state,
        revision = revision + 1,
        pause_reason = CASE WHEN v_new_state = 'PAUSED' THEN COALESCE(p_payload->>'reason', 'unspecified') ELSE NULL END,
        paused_at = CASE WHEN v_new_state = 'PAUSED' THEN now() ELSE paused_at END,
        started_at = CASE WHEN v_new_state = 'LIVE' AND started_at IS NULL THEN now() ELSE started_at END,
        finished_at = CASE WHEN v_new_state = 'FINISHED' THEN now() ELSE finished_at END,
        cancelled_at = CASE WHEN v_new_state = 'CANCELLED' THEN now() ELSE cancelled_at END,
        updated_at = now()
      WHERE id = v_match_id
      RETURNING * INTO v_match;
    ELSE
      RAISE EXCEPTION 'invalid state transition % -> %', v_match.state, v_new_state USING ERRCODE = '22023';
    END IF;
  ELSIF v_type IN ('player_disconnected', 'player_returned') THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT * INTO v_participant FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'player is not an original participant' USING ERRCODE = '22023'; END IF;
    IF v_type = 'player_disconnected' THEN
      UPDATE legacy_x.core_match_participants SET connected = false, disconnected_at = now(), reconnect_deadline = now() + make_interval(secs => COALESCE((p_payload->>'reconnect_window_seconds')::INTEGER, 300)), updated_at = now()
      WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = NULL, active_role = NULL, updated_at = now()
      WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      IF v_match.state = 'LIVE' THEN
        UPDATE legacy_x.core_matches SET state = 'PAUSED', pause_reason = 'original_participant_disconnected', paused_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      ELSE
        UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      END IF;
    ELSE
      IF v_participant.reconnect_deadline IS NOT NULL AND v_participant.reconnect_deadline < now() THEN RAISE EXCEPTION 'reconnect window expired' USING ERRCODE = '22023'; END IF;
      UPDATE legacy_x.core_match_participants SET connected = true, returned_at = now(), updated_at = now() WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = v_participant.user_id, active_role = 'original', fill_user_id = NULL, updated_at = now() WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
    END IF;
  ELSIF v_type = 'fill_assigned' THEN
    v_team_key := p_payload->>'team_key'; v_slot := (p_payload->>'slot_index')::INTEGER; v_steam_id := p_payload->>'steam_id';
    INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (v_steam_id, COALESCE(NULLIF(p_payload->>'name', ''), 'Steam ' || v_steam_id), '') ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username RETURNING id INTO v_user_id;
    UPDATE legacy_x.core_match_slots SET active_user_id = v_user_id, active_role = 'fill', fill_user_id = v_user_id, updated_at = now()
    WHERE match_id = v_match_id AND team_key = v_team_key AND slot_index = v_slot AND active_user_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'requested fill slot is not empty' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'snapshot_saved' THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT user_id INTO v_user_id FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'snapshot player is not an original participant' USING ERRCODE = '22023'; END IF;
    INSERT INTO legacy_x.core_match_player_snapshots (match_id, user_id, snapshot_revision, snapshot)
    VALUES (v_match_id, v_user_id, v_match.revision, p_payload->'snapshot');
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'result_final' THEN
    IF v_match.state NOT IN ('LIVE', 'PAUSED') THEN RAISE EXCEPTION 'result only valid from LIVE or PAUSED' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET state = 'FINISHED', final_event_id = p_event_id, result = p_payload->'result', finished_at = now(), revision = revision + 1, updated_at = now()
    WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'match_cancelled' THEN
    UPDATE legacy_x.core_matches SET state = 'CANCELLED', cancelled_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSE
    RAISE EXCEPTION 'unsupported Match Core event type %', v_type USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('status', 'processed', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(v_match_id));
END;
$function$;

DROP VIEW IF EXISTS legacy_x.core_match_history;
CREATE VIEW legacy_x.core_match_history WITH (security_invoker = true) AS
SELECT cm.id AS match_id,
       cm.server_id,
       cm.matchzy_local_id,
       cm.state,
       cm.map_name,
       cm.map_number,
       cm.started_at,
       cm.finished_at,
       cm.result,
       count(cmp.user_id) AS original_participant_count
FROM legacy_x.core_matches cm
LEFT JOIN legacy_x.core_match_participants cmp ON cmp.match_id = cm.id
GROUP BY cm.id;
REVOKE ALL ON legacy_x.core_match_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON legacy_x.core_match_history TO service_role;

ALTER TABLE legacy_x.core_matches DROP COLUMN IF EXISTS season_id;

-- 2. Seasonal monthly rank (replaced by lifetime competitive EXP).
DROP VIEW IF EXISTS legacy_x.rank_leaderboard;
DROP VIEW IF EXISTS legacy_x.community_player_profiles;
DROP VIEW IF EXISTS legacy_x.community_clan_leaderboard;
DROP VIEW IF EXISTS legacy_x.community_experience_leaderboard;
DROP FUNCTION IF EXISTS legacy_x.ingest_rank_map_result(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.rollover_monthly_rank_season(timestamptz, text);
DROP FUNCTION IF EXISTS legacy_x.active_rank_season();
DROP TABLE IF EXISTS legacy_x.rank_match_results;
DROP TABLE IF EXISTS legacy_x.rank_player_seasons;
DROP TABLE IF EXISTS legacy_x.rank_season_archives;
DROP TABLE IF EXISTS legacy_x.rank_season_rollovers;

-- 3. Community XP levels and clans (clans are removed from the product; levels duplicated the rank).
DROP FUNCTION IF EXISTS legacy_x.ingest_community_map_result(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.community_level_from_experience(integer);
DROP FUNCTION IF EXISTS legacy_x.create_clan_with_leader(uuid, text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS legacy_x.delete_owned_clan(uuid, uuid);
DROP FUNCTION IF EXISTS legacy_x.join_clan(uuid, uuid);
DROP TABLE IF EXISTS legacy_x.community_match_experience;
DROP TABLE IF EXISTS legacy_x.community_event_receipts;
DROP TABLE IF EXISTS legacy_x.community_player_progression;
DROP TABLE IF EXISTS legacy_x.clan_season_scores;
DROP TABLE IF EXISTS legacy_x.clan_members;
DROP TABLE IF EXISTS legacy_x.clans;
DROP TYPE IF EXISTS legacy_x.clan_role;
-- Referenced by the clan/community tables above, so it goes last.
DROP TABLE IF EXISTS legacy_x.rank_seasons;
DROP TABLE IF EXISTS legacy_x.staff_team;

-- 4. Plugin match rows nothing writes: the Play page reads live reconnect heartbeats, history reads Match Core.
DROP FUNCTION IF EXISTS legacy_x.ingest_player_match_result(uuid, uuid, uuid, text, legacy_x.match_result, text, text, jsonb);
DROP TABLE IF EXISTS legacy_x.player_match_history;
DROP TABLE IF EXISTS legacy_x.match_favorites;
DROP TABLE IF EXISTS legacy_x.matches;
DROP TYPE IF EXISTS legacy_x.match_result;
DROP TYPE IF EXISTS legacy_x.match_status;
DROP TYPE IF EXISTS legacy_x.play_mode;

-- 5. Enum types left behind by the Shop/Wallet/Promo removal (no column uses them).
DROP TYPE IF EXISTS legacy_x.payment_method;
DROP TYPE IF EXISTS legacy_x.shop_rarity;
DROP TYPE IF EXISTS legacy_x.wallet_tx_type;

-- 6. Account-level notification switches for Settings (penalty notices are always on).
ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

-- 7. Profile privacy gains the Loadout showcase ("What others can see" → Loadout).
ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['kd', 'matches', 'kills', 'faceit', 'recent_matches', 'loadout']::TEXT[]);

COMMIT;

-- ======================================================================
-- legacy_x_v1_safe_fixes.sql
-- ======================================================================
-- Legacy-X v1: fixes that are safe while the previous API is still live (apply before legacy_x_v1_cleanup.sql).
--
-- 1. ingest_core_match_event wrote the core_match_events row before its core_matches row, so every
--    match_created failed core_match_events_match_id_fkey and no Match Core match was ever stored. The match
--    row now comes first; season_id is still filled from the active season when one exists (NULL otherwise),
--    so the previous API keeps working. Every other event type is unchanged.
-- 2. users.notification_prefs for Settings → Notifications.
-- 3. Profile privacy accepts 'loadout'.

BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.ingest_core_match_event(p_plugin_id text, p_event_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'legacy_x', 'public'
AS $function$
DECLARE
  v_type TEXT := COALESCE(p_payload->>'event_type', '');
  v_match_id UUID;
  v_match legacy_x.core_matches%ROWTYPE;
  v_team JSONB;
  v_player JSONB;
  v_user_id UUID;
  v_steam_id TEXT;
  v_team_key TEXT;
  v_slot INTEGER;
  v_expected INTEGER;
  v_new_state TEXT;
  v_participant legacy_x.core_match_participants%ROWTYPE;
BEGIN
  IF p_plugin_id <> 'legacyx-match-core' THEN
    RAISE EXCEPTION 'Unsupported Match Core plugin %', p_plugin_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_payload->>'event_id', '') <> p_event_id THEN
    RAISE EXCEPTION 'event_id mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_type = 'match_created' THEN
    v_match_id := (p_payload->>'match_id')::UUID;
    IF jsonb_array_length(COALESCE(p_payload->'participants', '[]'::jsonb)) <> 10 THEN
      RAISE EXCEPTION 'match_created requires exactly 10 original participants' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM legacy_x.core_match_events WHERE event_id = p_event_id) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    -- The match row first: core_match_events.match_id references it.
    INSERT INTO legacy_x.core_matches (id, server_id, matchzy_local_id, season_id, state, map_name, map_number)
    VALUES (
      v_match_id,
      p_payload->>'server_id',
      NULLIF(p_payload->>'matchzy_local_id', ''),
      (SELECT rs.id FROM legacy_x.rank_seasons rs WHERE rs.is_active ORDER BY rs.created_at DESC LIMIT 1),
      'WAITING',
      p_payload->>'map_name',
      COALESCE((p_payload->>'map_number')::INTEGER, 0)
    )
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id);
    END IF;

    INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, payload)
    VALUES (p_event_id, v_match_id, v_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING;

    FOR v_player IN SELECT value FROM jsonb_array_elements(p_payload->'participants') LOOP
      v_steam_id := v_player->>'steam_id';
      v_team_key := v_player->>'team_key';
      v_slot := (v_player->>'slot_index')::INTEGER;
      IF v_steam_id !~ '^\d{15,20}$' OR v_team_key NOT IN ('team1', 'team2') OR v_slot NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'invalid original participant' USING ERRCODE = '22023';
      END IF;
      INSERT INTO legacy_x.users (steam_id, username, avatar)
      VALUES (v_steam_id, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id), '')
      ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username
      RETURNING id INTO v_user_id;
      INSERT INTO legacy_x.core_match_participants (match_id, user_id, steam_id, team_key, slot_index, original_name)
      VALUES (v_match_id, v_user_id, v_steam_id, v_team_key, v_slot, COALESCE(NULLIF(v_player->>'name', ''), 'Steam ' || v_steam_id));
      INSERT INTO legacy_x.core_match_slots (match_id, team_key, slot_index, original_user_id, active_user_id, active_role)
      VALUES (v_match_id, v_team_key, v_slot, v_user_id, v_user_id, 'original');
    END LOOP;
    RETURN jsonb_build_object('status', 'created', 'match_id', v_match_id, 'state', 'WAITING', 'revision', 1);
  END IF;

  v_match_id := (p_payload->>'match_id')::UUID;
  SELECT * INTO v_match FROM legacy_x.core_matches WHERE id = v_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown match_id' USING ERRCODE = '22023'; END IF;
  v_expected := COALESCE((p_payload->>'expected_revision')::INTEGER, -1);
  IF v_expected <> v_match.revision THEN
    RETURN jsonb_build_object('status', 'stale', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  INSERT INTO legacy_x.core_match_events (event_id, match_id, event_type, expected_revision, payload)
  VALUES (p_event_id, v_match_id, v_type, v_expected, p_payload)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision);
  END IF;

  IF v_type = 'state_transition' THEN
    v_new_state := p_payload->>'state';
    IF (v_match.state = 'WAITING' AND v_new_state = 'LIVE') OR
       (v_match.state = 'LIVE' AND v_new_state = 'PAUSED') OR
       (v_match.state = 'PAUSED' AND v_new_state = 'LIVE') OR
       (v_match.state IN ('LIVE', 'PAUSED') AND v_new_state IN ('FINISHED', 'CANCELLED')) THEN
      IF v_new_state = 'LIVE' AND NOT legacy_x.core_match_active_slots_ready(v_match_id) THEN
        RAISE EXCEPTION 'cannot resume without exactly ten active slots' USING ERRCODE = '22023';
      END IF;
      UPDATE legacy_x.core_matches SET
        state = v_new_state,
        revision = revision + 1,
        pause_reason = CASE WHEN v_new_state = 'PAUSED' THEN COALESCE(p_payload->>'reason', 'unspecified') ELSE NULL END,
        paused_at = CASE WHEN v_new_state = 'PAUSED' THEN now() ELSE paused_at END,
        started_at = CASE WHEN v_new_state = 'LIVE' AND started_at IS NULL THEN now() ELSE started_at END,
        finished_at = CASE WHEN v_new_state = 'FINISHED' THEN now() ELSE finished_at END,
        cancelled_at = CASE WHEN v_new_state = 'CANCELLED' THEN now() ELSE cancelled_at END,
        updated_at = now()
      WHERE id = v_match_id
      RETURNING * INTO v_match;
    ELSE
      RAISE EXCEPTION 'invalid state transition % -> %', v_match.state, v_new_state USING ERRCODE = '22023';
    END IF;
  ELSIF v_type IN ('player_disconnected', 'player_returned') THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT * INTO v_participant FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'player is not an original participant' USING ERRCODE = '22023'; END IF;
    IF v_type = 'player_disconnected' THEN
      UPDATE legacy_x.core_match_participants SET connected = false, disconnected_at = now(), reconnect_deadline = now() + make_interval(secs => COALESCE((p_payload->>'reconnect_window_seconds')::INTEGER, 300)), updated_at = now()
      WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = NULL, active_role = NULL, updated_at = now()
      WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      IF v_match.state = 'LIVE' THEN
        UPDATE legacy_x.core_matches SET state = 'PAUSED', pause_reason = 'original_participant_disconnected', paused_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      ELSE
        UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
      END IF;
    ELSE
      IF v_participant.reconnect_deadline IS NOT NULL AND v_participant.reconnect_deadline < now() THEN RAISE EXCEPTION 'reconnect window expired' USING ERRCODE = '22023'; END IF;
      UPDATE legacy_x.core_match_participants SET connected = true, returned_at = now(), updated_at = now() WHERE match_id = v_match_id AND user_id = v_participant.user_id;
      UPDATE legacy_x.core_match_slots SET active_user_id = v_participant.user_id, active_role = 'original', fill_user_id = NULL, updated_at = now() WHERE match_id = v_match_id AND original_user_id = v_participant.user_id;
      UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
    END IF;
  ELSIF v_type = 'fill_assigned' THEN
    v_team_key := p_payload->>'team_key'; v_slot := (p_payload->>'slot_index')::INTEGER; v_steam_id := p_payload->>'steam_id';
    INSERT INTO legacy_x.users (steam_id, username, avatar) VALUES (v_steam_id, COALESCE(NULLIF(p_payload->>'name', ''), 'Steam ' || v_steam_id), '') ON CONFLICT (steam_id) DO UPDATE SET username = EXCLUDED.username RETURNING id INTO v_user_id;
    UPDATE legacy_x.core_match_slots SET active_user_id = v_user_id, active_role = 'fill', fill_user_id = v_user_id, updated_at = now()
    WHERE match_id = v_match_id AND team_key = v_team_key AND slot_index = v_slot AND active_user_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'requested fill slot is not empty' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'snapshot_saved' THEN
    v_steam_id := p_payload->>'steam_id';
    SELECT user_id INTO v_user_id FROM legacy_x.core_match_participants WHERE match_id = v_match_id AND steam_id = v_steam_id;
    IF v_user_id IS NULL THEN RAISE EXCEPTION 'snapshot player is not an original participant' USING ERRCODE = '22023'; END IF;
    INSERT INTO legacy_x.core_match_player_snapshots (match_id, user_id, snapshot_revision, snapshot)
    VALUES (v_match_id, v_user_id, v_match.revision, p_payload->'snapshot');
    UPDATE legacy_x.core_matches SET revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'result_final' THEN
    IF v_match.state NOT IN ('LIVE', 'PAUSED') THEN RAISE EXCEPTION 'result only valid from LIVE or PAUSED' USING ERRCODE = '22023'; END IF;
    UPDATE legacy_x.core_matches SET state = 'FINISHED', final_event_id = p_event_id, result = p_payload->'result', finished_at = now(), revision = revision + 1, updated_at = now()
    WHERE id = v_match_id RETURNING * INTO v_match;
  ELSIF v_type = 'match_cancelled' THEN
    UPDATE legacy_x.core_matches SET state = 'CANCELLED', cancelled_at = now(), revision = revision + 1, updated_at = now() WHERE id = v_match_id RETURNING * INTO v_match;
  ELSE
    RAISE EXCEPTION 'unsupported Match Core event type %', v_type USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('status', 'processed', 'match_id', v_match_id, 'state', v_match.state, 'revision', v_match.revision, 'slots_ready', legacy_x.core_match_active_slots_ready(v_match_id));
END;
$function$;

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

ALTER TABLE legacy_x.users
  DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['kd', 'matches', 'kills', 'faceit', 'recent_matches', 'loadout']::TEXT[]);

COMMIT;

-- ======================================================================
-- legacy_x_notification_prefs.sql
-- ======================================================================
-- Settings → Notifications: per-account switches for the bell (penalty notices are always on and
-- are not stored). The column already exists on the live project; this file keeps the repo
-- reproducible and is safe to re-run.
BEGIN;

ALTER TABLE legacy_x.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{"tournaments": true, "rank_changes": true}'::jsonb;

COMMIT;

-- ======================================================================
-- legacy_x_profile_privacy_sections_v2.sql
-- ======================================================================
-- Profile "What others can see": the four sections are stats / matches / faceit / loadout.
-- The older per-stat values (kd, kills, recent_matches) stay allowed; the API maps them onto the
-- four sections when it reads them (server/legacyX/profileOverview.ts). Safe to re-run.
BEGIN;

ALTER TABLE legacy_x.users DROP CONSTRAINT IF EXISTS users_hidden_profile_sections_known;
ALTER TABLE legacy_x.users
  ADD CONSTRAINT users_hidden_profile_sections_known
  CHECK (hidden_profile_sections <@ ARRAY['stats', 'matches', 'faceit', 'loadout', 'kd', 'kills', 'recent_matches']::TEXT[]);

COMMIT;

-- ======================================================================
-- legacy_x_game_staff_authorization.sql
-- ======================================================================
-- In-game staff authorization for LegacyX-Admin.
--
-- The CS2 plugin no longer keeps a local admins.json; it asks the Root API about each connected
-- player (POST /api/v1/plugin/admin/authorizations) and grants CounterStrikeSharp permissions from
-- the answer. This file adds per-server staff assignments and the function that resolves a
-- player's in-game role for one server.
--
-- Resolution for (steam_id, server_id), first match wins:
--   1. A staff_server_assignments row for that exact server. It decides for that server: the role
--      applies only while status = 'active' and expires_at is unset or in the future; otherwise the
--      player has no in-game authority there (even if they hold a global staff role).
--   2. The global legacy_x.staff row of the user with that SteamID. Global staff already applied to
--      every server (GET /plugin/admin-policy); that stays the case. OWNER/MANAGER/ADMIN map to
--      owner/manager/admin while status = 'active'. DEVELOPER/DESIGNER are website roles and get no
--      in-game authority.
--   3. Otherwise: player (no authority).
--
-- Additive and safe to re-run. Existing tables and data are untouched.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.staff_server_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id text NOT NULL CHECK (steam_id ~ '^7656119[0-9]{10}$'),
  -- The LEGACYX_SERVER_ID configured on the game server.
  server_id text NOT NULL CHECK (server_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'admin', 'staff')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at timestamptz,
  granted_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (steam_id, server_id)
);

CREATE INDEX IF NOT EXISTS staff_server_assignments_server_idx ON legacy_x.staff_server_assignments (server_id);

-- Only the Root API (service role) reads or writes assignments.
ALTER TABLE legacy_x.staff_server_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.staff_server_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.staff_server_assignments TO service_role;

CREATE OR REPLACE FUNCTION legacy_x.resolve_game_staff(p_server_id text, p_steam_ids text[])
RETURNS TABLE (steam_id text, role text, status text, source text, expires_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = legacy_x, pg_temp
AS $$
  WITH ids AS (
    SELECT DISTINCT requested AS steam_id FROM unnest(p_steam_ids) AS requested
  ),
  server_row AS (
    SELECT a.steam_id, a.role, a.status, a.expires_at
    FROM legacy_x.staff_server_assignments a
    WHERE a.server_id = p_server_id AND a.steam_id = ANY (p_steam_ids)
  ),
  global_row AS (
    SELECT u.steam_id, s.role AS staff_role, s.status
    FROM legacy_x.staff s
    JOIN legacy_x.users u ON u.id = s.user_id
    WHERE u.steam_id = ANY (p_steam_ids)
  )
  SELECT
    ids.steam_id,
    CASE
      WHEN sr.steam_id IS NOT NULL THEN
        CASE WHEN sr.status = 'active' AND (sr.expires_at IS NULL OR sr.expires_at > now()) THEN sr.role ELSE 'player' END
      WHEN gr.steam_id IS NOT NULL AND gr.status = 'active' THEN
        CASE gr.staff_role WHEN 'OWNER' THEN 'owner' WHEN 'MANAGER' THEN 'manager' WHEN 'ADMIN' THEN 'admin' ELSE 'player' END
      ELSE 'player'
    END,
    CASE
      WHEN sr.steam_id IS NOT NULL THEN
        CASE
          WHEN sr.status <> 'active' THEN sr.status
          WHEN sr.expires_at IS NOT NULL AND sr.expires_at <= now() THEN 'expired'
          ELSE 'active'
        END
      WHEN gr.steam_id IS NOT NULL THEN gr.status
      ELSE 'none'
    END,
    CASE WHEN sr.steam_id IS NOT NULL THEN 'server' WHEN gr.steam_id IS NOT NULL THEN 'global' ELSE 'none' END,
    sr.expires_at
  FROM ids
  LEFT JOIN server_row sr ON sr.steam_id = ids.steam_id
  LEFT JOIN global_row gr ON gr.steam_id = ids.steam_id;
$$;

REVOKE ALL ON FUNCTION legacy_x.resolve_game_staff(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.resolve_game_staff(text, text[]) TO service_role;

COMMIT;

-- Verification:
-- SELECT * FROM legacy_x.resolve_game_staff('some-server', ARRAY['76561190000000001']);
--   → one row: role 'player', status 'none', source 'none'.

-- ======================================================================
-- legacy_x_retire_unused_staff_and_plugin_tables.sql
-- ======================================================================
-- Retire unused database objects.
--
-- 1. The LegacyX-Phantom and LegacyX-PlayerTelemetry CS2 plugins were removed (plugins repo
--    da67540), together with every route that used their tables (backend 4a8a152). The
--    LegacyX-Reconnect ingest functions went with the Reconnect plugin.
-- 2. The old website role system (roles, permissions, role_permissions, user_roles), staff_notes
--    and staff_team: no backend or frontend code reads or writes them. Staff authority lives in
--    legacy_x.staff (global) and legacy_x.staff_server_assignments (per game server).
--
-- At the time of writing: the Phantom/Telemetry tables, staff_team and staff_notes held 0 rows;
-- roles 4, role_permissions 104, user_roles 1 (seed data only). Nothing outside these objects
-- referenced them: no views besides the two telemetry views, no policies, no foreign keys in
-- from other tables, and the guard functions below serve only these tables' triggers.
--
-- Kept: staff, staff_server_assignments, users, the Staff Panel tables (staff_sessions,
-- staff_audit_logs, staff_panel_actions, staff_panel_settings), the reconnect tables (read by the
-- Play page, GET /reconnect/me, ranked matches, tournaments) and legacy_x.set_updated_at (shared).
--
-- Irreversible. No CASCADE: if anything new depends on these objects, this stops instead.

BEGIN;

-- Phantom / PlayerTelemetry / Reconnect ingest
DROP VIEW IF EXISTS legacy_x.player_telemetry_profile_summary;
DROP VIEW IF EXISTS legacy_x.player_telemetry_match_latest;

DROP FUNCTION IF EXISTS legacy_x.ingest_player_telemetry_event(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_phantom_evidence(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_phantom_suspension_signal(text, text, jsonb);
DROP FUNCTION IF EXISTS legacy_x.ingest_reconnect_event(text, text, text, uuid, text, text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS legacy_x.ingest_reconnect_heartbeat(text, text, text, text, text, text, integer);

DROP TABLE IF EXISTS legacy_x.phantom_suspension_events;
DROP TABLE IF EXISTS legacy_x.phantom_suspension_cases;
DROP TABLE IF EXISTS legacy_x.phantom_evidence_events;
DROP TABLE IF EXISTS legacy_x.phantom_history_rounds;
DROP TABLE IF EXISTS legacy_x.player_telemetry_events;

-- Unused role system and staff side tables (their triggers go with the tables)
DROP TABLE IF EXISTS legacy_x.user_roles;
DROP TABLE IF EXISTS legacy_x.role_permissions;
DROP TABLE IF EXISTS legacy_x.permissions;
DROP TABLE IF EXISTS legacy_x.roles;
DROP TABLE IF EXISTS legacy_x.staff_team;
DROP TABLE IF EXISTS legacy_x.staff_notes;

DROP FUNCTION IF EXISTS legacy_x.guard_last_locked_holder();
DROP FUNCTION IF EXISTS legacy_x.guard_locked_roles();
DROP FUNCTION IF EXISTS legacy_x.guard_owner_only_permissions();

COMMIT;

-- Verification: every value must come back NULL / 0.
-- SELECT to_regclass('legacy_x.roles'), to_regclass('legacy_x.user_roles'), to_regclass('legacy_x.staff_team'),
--        to_regclass('legacy_x.phantom_evidence_events'), to_regclass('legacy_x.player_telemetry_events');
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x' AND p.proname ~ '(phantom|telemetry|ingest_reconnect|guard_locked|guard_last_locked|guard_owner_only)';

-- ======================================================================
-- legacy_x_revoke_public_definer_functions.sql
-- ======================================================================
-- Only the Root API (service_role) may run the SECURITY DEFINER functions in legacy_x.
--
-- These functions run as their owner (postgres) and were executable by PUBLIC, i.e. by anon and
-- authenticated too (Supabase advisor lints 0028/0029). anon/authenticated have no USAGE on the
-- legacy_x schema, so they could not reach them today; this removes the grant itself so a later
-- schema exposure cannot turn them into public RPC endpoints (ensure_steam_user,
-- save_skinchanger_loadout, rollover_monthly_rank_season, …).
--
-- service_role keeps its explicit EXECUTE grant. notify_penalty_issued is a trigger function;
-- triggers fire regardless of EXECUTE grants. Safe to re-run.

BEGIN;

DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'legacy_x' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;

-- Verification: must return 0.
-- SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'legacy_x' AND p.prosecdef
--    AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'));

-- ======================================================================
-- legacy_x_discord_links.sql
-- ======================================================================
-- Discord ↔ Steam account links for the Discord bot's /link command and rank roles.
--
-- Flow: the bot (plugin token with discord:link) asks for a one-time link request; the player opens
-- the returned URL, signs in with Steam, and complete_discord_link() binds the Discord ID to their
-- legacy_x user. Only the SHA-256 of the request token is stored. One Discord account per user and
-- one user per Discord account; relinking replaces the old link.
--
-- Only the Root API (service_role) reads or writes these tables. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.discord_links (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  discord_id text NOT NULL UNIQUE CHECK (discord_id ~ '^[0-9]{17,20}$'),
  discord_name text NOT NULL DEFAULT '' CHECK (char_length(discord_name) <= 64),
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.discord_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  discord_id text NOT NULL CHECK (discord_id ~ '^[0-9]{17,20}$'),
  discord_name text NOT NULL DEFAULT '' CHECK (char_length(discord_name) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS discord_link_requests_expires_at_idx ON legacy_x.discord_link_requests (expires_at);

ALTER TABLE legacy_x.discord_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.discord_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_links, legacy_x.discord_link_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.discord_links, legacy_x.discord_link_requests TO service_role;

-- Consumes a valid, unused, unexpired request and links its Discord ID to p_user_id in one
-- transaction. Returns the linked Discord ID, or NULL when the request is invalid, used or expired.
CREATE OR REPLACE FUNCTION legacy_x.complete_discord_link(p_token_hash text, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = legacy_x, pg_temp
AS $$
DECLARE
  request legacy_x.discord_link_requests;
BEGIN
  UPDATE legacy_x.discord_link_requests
     SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING * INTO request;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  DELETE FROM legacy_x.discord_links l WHERE l.discord_id = request.discord_id OR l.user_id = p_user_id;
  INSERT INTO legacy_x.discord_links (user_id, discord_id, discord_name)
  VALUES (p_user_id, request.discord_id, request.discord_name);
  -- Other pending links for this Discord account are now stale.
  DELETE FROM legacy_x.discord_link_requests r
   WHERE r.discord_id = request.discord_id AND r.id <> request.id AND r.used_at IS NULL;
  RETURN request.discord_id;
END $$;

REVOKE EXECUTE ON FUNCTION legacy_x.complete_discord_link(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.complete_discord_link(text, uuid) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_server_heartbeat.sql
-- ======================================================================
-- Game server heartbeat: every CS2 server (LegacyX-Status plugin) reports itself every 30 seconds
-- through POST /api/v1/plugin/servers/heartbeat. One transaction updates the server row the Play
-- pages, home tiles and Discord boards read (reconnect_servers) and the "who is on which server"
-- sessions profiles read (reconnect_sessions): players who left are closed, new ones are opened,
-- and a player seen here is closed on any other server.
--
-- Only the Root API (service_role) runs it. Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.reconnect_servers ADD COLUMN IF NOT EXISTS max_players INTEGER;
ALTER TABLE legacy_x.reconnect_servers ADD COLUMN IF NOT EXISTS gotv_address TEXT;

CREATE OR REPLACE FUNCTION legacy_x.ingest_server_heartbeat(p_server jsonb, p_players jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = legacy_x, pg_temp
AS $$
DECLARE
  v_server_id text := p_server->>'server_id';
  v_map text := NULLIF(p_server->>'map', '');
  v_mode text := NULLIF(p_server->>'mode', '');
  v_ids text[];
BEGIN
  IF v_server_id IS NULL OR v_server_id !~ '^[A-Za-z0-9._:-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid server id';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT p->>'steam_id'), '{}') INTO v_ids
  FROM jsonb_array_elements(p_players) p
  WHERE p->>'steam_id' ~ '^\d{15,20}$';

  INSERT INTO legacy_x.reconnect_servers (server_id, connect_address, display_name, current_map, current_mode, player_count, max_players, gotv_address, last_heartbeat_at, updated_at)
  VALUES (v_server_id, COALESCE(p_server->>'address', ''), NULLIF(p_server->>'name', ''), v_map, v_mode,
          cardinality(v_ids), (p_server->>'max_players')::int, NULLIF(p_server->>'gotv_address', ''), now(), now())
  ON CONFLICT (server_id) DO UPDATE SET
    connect_address = EXCLUDED.connect_address,
    display_name = EXCLUDED.display_name,
    current_map = EXCLUDED.current_map,
    current_mode = EXCLUDED.current_mode,
    player_count = EXCLUDED.player_count,
    max_players = EXCLUDED.max_players,
    gotv_address = EXCLUDED.gotv_address,
    last_heartbeat_at = now(),
    updated_at = now();

  -- Left this server, or now playing here after another one.
  UPDATE legacy_x.reconnect_sessions s
     SET disconnected_at = GREATEST(now(), s.connected_at),
         disconnect_reason = CASE WHEN s.server_id = v_server_id THEN 'left' ELSE 'moved' END,
         updated_at = now()
   WHERE s.disconnected_at IS NULL
     AND ((s.server_id = v_server_id AND NOT (s.steam_id = ANY (v_ids)))
       OR (s.server_id <> v_server_id AND s.steam_id = ANY (v_ids)));

  -- Still here: keep the name and map current.
  UPDATE legacy_x.reconnect_sessions s
     SET player_name = COALESCE(NULLIF(p->>'name', ''), s.player_name), map_name = v_map, mode = v_mode,
         reconnectable_until = now() + interval '5 minutes', updated_at = now()
    FROM jsonb_array_elements(p_players) p
   WHERE s.server_id = v_server_id AND s.disconnected_at IS NULL AND s.steam_id = p->>'steam_id';

  -- Joined.
  INSERT INTO legacy_x.reconnect_sessions (session_id, steam_id, player_name, server_id, map_name, mode, reconnectable_until)
  SELECT gen_random_uuid(), p->>'steam_id', left(COALESCE(p->>'name', ''), 128), v_server_id, v_map, v_mode, now() + interval '5 minutes'
    FROM (SELECT DISTINCT ON (p->>'steam_id') p FROM jsonb_array_elements(p_players) p WHERE p->>'steam_id' ~ '^\d{15,20}$') players
   WHERE NOT EXISTS (
     SELECT 1 FROM legacy_x.reconnect_sessions s
      WHERE s.server_id = v_server_id AND s.disconnected_at IS NULL AND s.steam_id = players.p->>'steam_id'
   );

  RETURN cardinality(v_ids);
END $$;

REVOKE EXECUTE ON FUNCTION legacy_x.ingest_server_heartbeat(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.ingest_server_heartbeat(jsonb, jsonb) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_admin_calls.sql
-- ======================================================================
-- In-game !calladmin / !callmanager requests, for the Discord bot to announce.
-- LegacyX-Admin posts one row per request (POST /plugin/admin-calls); the Discord bot polls
-- GET /plugin/admin-calls and posts new rows in the channel chosen with /admincalls.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.admin_calls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caller_steam_id TEXT NOT NULL CHECK (caller_steam_id ~ '^7656119[0-9]{10}$'),
  caller_name TEXT NOT NULL CHECK (char_length(caller_name) BETWEEN 1 AND 64),
  target TEXT NOT NULL CHECK (target IN ('admin', 'manager')),
  server_id TEXT NOT NULL CHECK (char_length(server_id) BETWEEN 1 AND 64),
  server_name TEXT CHECK (server_name IS NULL OR char_length(server_name) <= 96),
  map TEXT CHECK (map IS NULL OR char_length(map) <= 64),
  players SMALLINT CHECK (players IS NULL OR players BETWEEN 0 AND 128),
  online_staff SMALLINT NOT NULL CHECK (online_staff BETWEEN 0 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_calls_created_idx ON legacy_x.admin_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_calls_caller_idx ON legacy_x.admin_calls (caller_steam_id, created_at DESC);

-- Same as every other table: browsers never read it, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.admin_calls FROM anon, authenticated;
ALTER TABLE legacy_x.admin_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE legacy_x.admin_calls TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_admin_calls_reports.sql
-- ======================================================================
-- !report joins !calladmin / !callmanager in legacy_x.admin_calls, so the Discord bot announces both in one feed.
-- A report is a row with target = 'report' plus who was reported and why.
BEGIN;

ALTER TABLE legacy_x.admin_calls DROP CONSTRAINT IF EXISTS admin_calls_target_check;
ALTER TABLE legacy_x.admin_calls ADD CONSTRAINT admin_calls_target_check CHECK (target IN ('admin', 'manager', 'report'));

ALTER TABLE legacy_x.admin_calls
  ADD COLUMN IF NOT EXISTS reported_steam_id TEXT CHECK (reported_steam_id IS NULL OR reported_steam_id ~ '^7656119[0-9]{10}$'),
  ADD COLUMN IF NOT EXISTS reported_name TEXT CHECK (reported_name IS NULL OR char_length(reported_name) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300);

COMMIT;

-- ======================================================================
-- legacy_x_skinchanger_catalog_fast_path.sql
-- ======================================================================
-- Sticker, charm, pin and music kit pages were taking 12+ seconds on production (11k stickers): the catalogue page
-- function groups every item by its "browse key" to fold wear variants of one skin together, which for these
-- categories is just the item's own unique external_key, so the grouping (a DISTINCT ON over a regexp-heavy sort
-- that spills to disk) changes nothing. This adds a fast path for them: same columns, same names, same order,
-- same total_count, without the grouping. Every other category runs the original query untouched.
--
-- Rollback: re-apply the previous definition (the body after the fast-path IF block, as a plain LANGUAGE sql function).
BEGIN;

CREATE OR REPLACE FUNCTION legacy_x.get_skinchanger_catalog_page(
  p_category text DEFAULT NULL::text,
  p_weapon_class text DEFAULT NULL::text,
  p_weapon_group text DEFAULT NULL::text,
  p_team text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 36,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid, external_key text, category text, weapon_class text, display_name text, weapon_defindex integer, paint_id integer, model text, image_key text, metadata jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'legacy_x', 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF p_category IN ('sticker', 'charm', 'pin', 'music_kit') AND p_weapon_class IS NULL AND p_weapon_group IS NULL AND p_team IS NULL THEN
    RETURN QUERY
    WITH paged AS (
      SELECT
        item.id,
        item.external_key,
        item.category,
        item.weapon_class,
        regexp_replace(
          regexp_replace(regexp_replace(item.display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
          ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
        ) AS display_name,
        item.weapon_defindex,
        item.paint_id,
        item.model,
        item.image_key,
        jsonb_set(
          jsonb_set(
            jsonb_set(item.metadata, '{minWear}', to_jsonb(COALESCE(NULLIF(item.metadata ->> 'minWear', '')::NUMERIC, 0.0001)::DOUBLE PRECISION), true),
            '{maxWear}', to_jsonb(COALESCE(NULLIF(item.metadata ->> 'maxWear', '')::NUMERIC, 1)::DOUBLE PRECISION), true
          ),
          '{baseSkinKey}', to_jsonb(item.external_key), true
        ) AS metadata,
        count(*) OVER () AS total_count
      FROM legacy_x.skinchanger_catalog_items item
      WHERE item.is_active = true
        AND item.category = p_category
        AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%' OR item.weapon_class ILIKE '%' || p_query || '%')
    )
    SELECT *
    FROM paged
    ORDER BY
      CASE paged.metadata ->> 'rarity'
        WHEN 'Covert' THEN 1
        WHEN 'Classified' THEN 2
        WHEN 'Restricted' THEN 3
        WHEN 'Mil-Spec Grade' THEN 4
        WHEN 'Industrial Grade' THEN 5
        WHEN 'Consumer Grade' THEN 6
        WHEN 'Contraband' THEN 7
        WHEN 'Extraordinary' THEN 8
        ELSE 99
      END,
      paged.display_name,
      -- Many pins and music kits share a name; a fixed last key keeps page 2 from repeating or skipping page 1's ties.
      paged.external_key
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    OFFSET GREATEST(p_offset, 0);
    RETURN;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT item.*,
      CASE
        WHEN p_category IN ('glove', 'knife') AND p_weapon_class IS NULL THEN p_category || '-type:' || COALESCE(item.weapon_class, item.external_key)
        ELSE legacy_x.skinchanger_catalog_browse_key(item.category, item.weapon_class, item.display_name, item.external_key)
      END AS browse_key,
      (p_category IN ('glove', 'knife') AND p_weapon_class IS NULL) AS model_type_browse
    FROM legacy_x.skinchanger_catalog_items item
    WHERE item.is_active = true
      AND (p_category IS NULL OR item.category = p_category)
      AND (p_weapon_class IS NULL OR item.weapon_class = p_weapon_class)
      AND (
        p_weapon_group IS NULL
        OR item.metadata ->> 'weaponGroup' = p_weapon_group
        OR (p_weapon_group = 'Mid Tier' AND item.metadata ->> 'weaponGroup' IN ('SMGs', 'Heavy'))
      )
      AND (p_category IS DISTINCT FROM 'weapon' OR COALESCE(item.metadata ->> 'weaponGroup', '') IN ('Pistols', 'SMGs', 'Rifles', 'Heavy'))
      AND (p_weapon_class IS NULL OR COALESCE((item.metadata ->> 'baseModel')::BOOLEAN, false) = false)
      AND (p_team IS NULL OR item.metadata ->> 'team' = p_team)
      AND (p_query IS NULL OR item.display_name ILIKE '%' || p_query || '%' OR item.weapon_class ILIKE '%' || p_query || '%')
  ),
  ranges AS (
    SELECT filtered.browse_key,
      min(NULLIF(filtered.metadata ->> 'minWear', '')::NUMERIC) AS min_wear,
      max(NULLIF(filtered.metadata ->> 'maxWear', '')::NUMERIC) AS max_wear
    FROM filtered
    GROUP BY filtered.browse_key
  ),
  grouped AS (
    SELECT DISTINCT ON (filtered.browse_key)
      filtered.*, ranges.min_wear, ranges.max_wear
    FROM filtered
    JOIN ranges USING (browse_key)
    ORDER BY filtered.browse_key,
      CASE WHEN COALESCE((filtered.metadata ->> 'baseModel')::BOOLEAN, false) THEN 0 ELSE 1 END,
      CASE regexp_replace(filtered.display_name, '^.* \(([^)]*)\)$', '\1')
        WHEN 'Factory New' THEN 0
        WHEN 'Minimal Wear' THEN 1
        WHEN 'Field-Tested' THEN 2
        WHEN 'Well-Worn' THEN 3
        WHEN 'Battle-Scarred' THEN 4
        ELSE 5
      END,
      CASE
        WHEN filtered.display_name ~* '^★?[[:space:]]*StatTrak™[[:space:]]+' THEN 1
        WHEN filtered.display_name ~* '^★?[[:space:]]*Souvenir[[:space:]]+' THEN 2
        ELSE 0
      END,
      filtered.display_name
  ),
  paged AS (
    SELECT
      grouped.id,
      grouped.external_key,
      grouped.category,
      grouped.weapon_class,
      CASE
        WHEN grouped.model_type_browse THEN grouped.weapon_class
        ELSE regexp_replace(
          regexp_replace(regexp_replace(grouped.display_name, '^★[[:space:]]*', '', 'i'), '^(StatTrak™\s+|Souvenir\s+)', '', 'i'),
          ' \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$', '', 'i'
        )
      END AS display_name,
      grouped.weapon_defindex,
      grouped.paint_id,
      grouped.model,
      grouped.image_key,
      jsonb_set(
        jsonb_set(
          jsonb_set(grouped.metadata, '{minWear}', to_jsonb(COALESCE(grouped.min_wear, 0.0001)::DOUBLE PRECISION), true),
          '{maxWear}', to_jsonb(COALESCE(grouped.max_wear, 1)::DOUBLE PRECISION), true
        ),
        '{baseSkinKey}', to_jsonb(grouped.browse_key), true
      ) AS metadata,
      count(*) OVER () AS total_count
    FROM grouped
  )
  SELECT *
  FROM paged
  ORDER BY
    CASE paged.metadata ->> 'rarity'
      WHEN 'Covert' THEN 1
      WHEN 'Classified' THEN 2
      WHEN 'Restricted' THEN 3
      WHEN 'Mil-Spec Grade' THEN 4
      WHEN 'Industrial Grade' THEN 5
      WHEN 'Consumer Grade' THEN 6
      WHEN 'Contraband' THEN 7
      WHEN 'Extraordinary' THEN 8
      ELSE 99
    END,
    paged.display_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
END;
$function$;

COMMIT;

-- ======================================================================
-- legacy_x_announcements.sql
-- ======================================================================
-- Update announcements for Discord. The deploy scripts (website, API, bot, game servers) post one row per update
-- (POST /plugin/announcements); the Discord bot polls GET /plugin/announcements and posts new rows in the
-- channel chosen with /updates. (Not the website's `announcements` table from legacy_x_admin_system.sql: that one has uuid ids and other columns.)
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.update_announcements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 30),
  footer TEXT CHECK (footer IS NULL OR char_length(footer) <= 200),
  banner TEXT CHECK (banner IS NULL OR banner IN ('cs2-update-finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS update_announcements_created_idx ON legacy_x.update_announcements (created_at DESC);

-- Same as every other table: browsers never read it, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.update_announcements FROM anon, authenticated;
ALTER TABLE legacy_x.update_announcements ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE legacy_x.update_announcements TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_owner_profile.sql
-- ======================================================================
-- Owner profile: Respect given by players, and the Owner's own links and message.
-- Team and updates on that page come from the existing staff and announcements tables, so they need nothing new.
BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.profile_respect (
  target_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  giver_user_id UUID NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_user_id, giver_user_id),
  CHECK (target_user_id <> giver_user_id)
);

CREATE TABLE IF NOT EXISTS legacy_x.owner_profile (
  user_id UUID PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  links JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 8),
  message TEXT CHECK (message IS NULL OR char_length(message) <= 280),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same as every other table: browsers never read them, only the Root API (service_role) does.
REVOKE ALL ON TABLE legacy_x.profile_respect, legacy_x.owner_profile FROM anon, authenticated;
ALTER TABLE legacy_x.profile_respect ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.owner_profile ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON TABLE legacy_x.profile_respect TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE legacy_x.owner_profile TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_wallet.sql
-- ======================================================================
-- Coin wallet: one balance per player and an append-only ledger behind it.
--
-- Every change goes through wallet_apply(): it locks the player's wallet row, refuses to go below zero, writes the
-- ledger line and returns the new balance in one transaction. An optional `ref` makes a change idempotent: asking
-- again with the same ref changes nothing and returns the balance from the first time (safe to retry a grant or a
-- clan fee). The ledger is never updated or deleted. Only the Root API (service_role) reads or writes these tables.
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS legacy_x.wallets (
  user_id uuid PRIMARY KEY REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_x.wallet_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount <> 0),
  kind text NOT NULL CHECK (kind IN ('grant', 'spend', 'refund', 'adjust')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  ref text CHECK (ref IS NULL OR char_length(ref) BETWEEN 1 AND 120),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  created_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('grant', 'refund') AND amount > 0) OR (kind = 'spend' AND amount < 0) OR kind = 'adjust')
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_user_ref_idx ON legacy_x.wallet_transactions (user_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx ON legacy_x.wallet_transactions (user_id, created_at DESC);

ALTER TABLE legacy_x.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.wallet_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.wallets, legacy_x.wallet_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON legacy_x.wallets, legacy_x.wallet_transactions TO service_role;

-- The ledger cannot be edited or removed, whoever asks.
CREATE OR REPLACE FUNCTION legacy_x.wallet_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only' USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS wallet_transactions_no_change ON legacy_x.wallet_transactions;
CREATE TRIGGER wallet_transactions_no_change BEFORE UPDATE OR DELETE ON legacy_x.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION legacy_x.wallet_transactions_append_only();

-- Applies one change. Returns the balance after it and whether it was applied (false = this ref was already used).
CREATE OR REPLACE FUNCTION legacy_x.wallet_apply(
  p_user_id uuid, p_amount integer, p_kind text, p_reason text, p_ref text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS TABLE (new_balance integer, applied boolean)
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  current_balance integer;
  earlier integer;
BEGIN
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'amount must not be zero' USING ERRCODE = '22023';
  END IF;
  IF (p_kind IN ('grant', 'refund') AND p_amount < 0) OR (p_kind = 'spend' AND p_amount > 0) OR p_kind NOT IN ('grant', 'spend', 'refund', 'adjust') THEN
    RAISE EXCEPTION 'amount does not fit the kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO legacy_x.wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
  -- The lock comes first, so two requests with the same ref cannot both pass the check below.
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id FOR UPDATE;

  IF p_ref IS NOT NULL THEN
    SELECT t.balance_after INTO earlier FROM legacy_x.wallet_transactions t WHERE t.user_id = p_user_id AND t.ref = p_ref;
    IF FOUND THEN
      RETURN QUERY SELECT earlier, false;
      RETURN;
    END IF;
  END IF;

  IF current_balance + p_amount < 0 THEN
    RAISE EXCEPTION 'insufficient coins' USING ERRCODE = 'P0001';
  END IF;

  UPDATE legacy_x.wallets SET balance = current_balance + p_amount, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after, created_by)
  VALUES (p_user_id, p_amount, p_kind, p_reason, p_ref, current_balance + p_amount, p_actor);
  RETURN QUERY SELECT current_balance + p_amount, true;
END $$;

REVOKE ALL ON FUNCTION legacy_x.wallet_apply(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_apply(uuid, integer, text, text, text, uuid) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_wallet_welcome_penalty.sql
-- ======================================================================
-- Wallet, part 2: a welcome bonus for every new wallet and a "penalty" that takes coins away.
--
-- wallet_ensure() opens a player's wallet the first time anything touches it and, in that same step, writes the
-- welcome bonus into the ledger (ref 'welcome', so it can only happen once). wallet_penalize() takes up to the
-- given amount (never more than the balance, so a wallet never goes below zero) and records what it actually took
-- as a 'penalty' line; a repeated ref takes nothing twice. Safe to re-run.

BEGIN;

ALTER TABLE legacy_x.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_kind_check;
ALTER TABLE legacy_x.wallet_transactions ADD CONSTRAINT wallet_transactions_kind_check CHECK (kind IN ('grant', 'spend', 'refund', 'adjust', 'penalty'));
ALTER TABLE legacy_x.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_check;
ALTER TABLE legacy_x.wallet_transactions ADD CONSTRAINT wallet_transactions_check CHECK (
  (kind IN ('grant', 'refund') AND amount > 0) OR (kind IN ('spend', 'penalty') AND amount < 0) OR kind = 'adjust'
);

CREATE OR REPLACE FUNCTION legacy_x.wallet_ensure(p_user_id uuid, p_welcome integer DEFAULT 0)
RETURNS integer
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  created integer;
  current_balance integer;
BEGIN
  INSERT INTO legacy_x.wallets (user_id, balance) VALUES (p_user_id, GREATEST(p_welcome, 0)) ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS created = ROW_COUNT;
  IF created = 1 AND p_welcome > 0 THEN
    INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after)
    VALUES (p_user_id, p_welcome, 'grant', 'Welcome bonus', 'welcome', p_welcome);
  END IF;
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id;
  RETURN current_balance;
END $$;

CREATE OR REPLACE FUNCTION legacy_x.wallet_penalize(
  p_user_id uuid, p_amount integer, p_reason text, p_ref text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS TABLE (new_balance integer, taken integer, applied boolean)
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  current_balance integer;
  earlier_amount integer;
  earlier_balance integer;
  take integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;
  SELECT w.balance INTO current_balance FROM legacy_x.wallets w WHERE w.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF p_ref IS NOT NULL THEN
    SELECT -t.amount, t.balance_after INTO earlier_amount, earlier_balance
      FROM legacy_x.wallet_transactions t WHERE t.user_id = p_user_id AND t.ref = p_ref;
    IF FOUND THEN
      RETURN QUERY SELECT earlier_balance, earlier_amount, false;
      RETURN;
    END IF;
  END IF;
  take := LEAST(p_amount, current_balance);
  IF take = 0 THEN
    RETURN QUERY SELECT current_balance, 0, false;
    RETURN;
  END IF;
  UPDATE legacy_x.wallets SET balance = current_balance - take, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO legacy_x.wallet_transactions (user_id, amount, kind, reason, ref, balance_after, created_by)
  VALUES (p_user_id, -take, 'penalty', p_reason, p_ref, current_balance - take, p_actor);
  RETURN QUERY SELECT current_balance - take, take, true;
END $$;

REVOKE ALL ON FUNCTION legacy_x.wallet_ensure(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_ensure(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION legacy_x.wallet_penalize(uuid, integer, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.wallet_penalize(uuid, integer, text, text, uuid) TO service_role;

COMMIT;

-- ======================================================================
-- legacy_x_clan_paid.sql
-- ======================================================================
-- Clans, part 2: creating a clan costs coins and needs some ranked matches played. The fee, the clan row and the
-- leader's membership happen in one transaction, so a taken name or tag never costs anything. Safe to re-run.

CREATE OR REPLACE FUNCTION legacy_x.create_clan_paid(
  p_owner_id uuid, p_name text, p_tag text, p_region text, p_fee integer, p_min_matches integer, p_welcome integer DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
DECLARE
  v_matches integer;
  v_clan_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_x.clan_members WHERE user_id = p_owner_id) THEN
    RAISE EXCEPTION 'User already belongs to a clan' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(max(matches_completed), 0) INTO v_matches FROM legacy_x.competitive_player_progression WHERE user_id = p_owner_id;
  IF v_matches < p_min_matches THEN
    RAISE EXCEPTION 'Play % more ranked matches to create a clan', p_min_matches - v_matches USING ERRCODE = 'P0001';
  END IF;
  PERFORM legacy_x.wallet_ensure(p_owner_id, p_welcome);
  PERFORM legacy_x.wallet_apply(p_owner_id, -p_fee, 'spend', 'Clan created: ' || p_name, NULL, p_owner_id);
  INSERT INTO legacy_x.clans (name, tag, logo, description, region, max_players, owner_id)
  VALUES (p_name, p_tag, '', NULL, p_region, 10, p_owner_id) RETURNING id INTO v_clan_id;
  INSERT INTO legacy_x.clan_members (clan_id, user_id, role) VALUES (v_clan_id, p_owner_id, 'leader');
  RETURN v_clan_id;
END $$;

REVOKE ALL ON FUNCTION legacy_x.create_clan_paid(uuid, text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.create_clan_paid(uuid, text, text, text, integer, integer, integer) TO service_role;

-- ======================================================================
-- legacy_x_clan_images.sql
-- ======================================================================
-- Clan pictures: one logo (PNG) and one banner (PNG, JPEG or GIF) per clan. The bytes live here, are checked by the API
-- before they are stored, and are served back by GET /clans/:id/logo|banner. Only the API (service_role) touches the table.

CREATE TABLE IF NOT EXISTS legacy_x.clan_images (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('logo', 'banner')),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 6291456),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, kind)
);
ALTER TABLE legacy_x.clan_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_images TO service_role;
-- Raising the limit on an existing table (banners up to 5 MB, logos up to 1 MB):
ALTER TABLE legacy_x.clan_images DROP CONSTRAINT IF EXISTS clan_images_data_check;
ALTER TABLE legacy_x.clan_images ADD CONSTRAINT clan_images_data_check CHECK (octet_length(data) BETWEEN 1 AND 6291456);

-- ======================================================================
-- legacy_x_clan_join_modes.sql
-- ======================================================================
-- Clans, part 3: a clan is open (anyone joins at once) or by request (the leader accepts or declines). Safe to re-run.
ALTER TABLE legacy_x.clans ADD COLUMN IF NOT EXISTS join_mode text NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open', 'request'));

CREATE TABLE IF NOT EXISTS legacy_x.clan_join_requests (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id)
);
ALTER TABLE legacy_x.clan_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_join_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON legacy_x.clan_join_requests TO service_role;

-- ======================================================================
-- legacy_x_clan_features.sql
-- ======================================================================
-- Clans, part 4: case-insensitive unique names and tags, invitations, an audit trail, clan notifications and handing the
-- clan over to another member. The co-leader role (an officer) already exists in the clan_role enum. Safe to re-run.

CREATE UNIQUE INDEX IF NOT EXISTS clans_name_lower_key ON legacy_x.clans (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS clans_tag_lower_key ON legacy_x.clans (lower(tag));

CREATE TABLE IF NOT EXISTS legacy_x.clan_invites (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  invited_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id)
);

-- Who did what in a clan. It outlives the clan (clan_id has no foreign key), so a deleted clan still leaves a trace.
CREATE TABLE IF NOT EXISTS legacy_x.clan_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id uuid,
  clan_name text NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 40),
  target_id uuid,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clan_audit_clan_idx ON legacy_x.clan_audit (clan_id, created_at DESC);

ALTER TABLE legacy_x.clan_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_invites, legacy_x.clan_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON legacy_x.clan_invites TO service_role;
GRANT SELECT, INSERT ON legacy_x.clan_audit TO service_role;

ALTER TABLE legacy_x.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE legacy_x.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('penalty', 'match', 'system', 'clan'));

-- The leader hands the clan to a member and becomes a co-leader, in one transaction.
CREATE OR REPLACE FUNCTION legacy_x.transfer_clan_leader(p_clan_id uuid, p_from uuid, p_to uuid) RETURNS void
LANGUAGE plpgsql SET search_path = legacy_x, pg_temp AS $$
BEGIN
  PERFORM 1 FROM legacy_x.clans WHERE id = p_clan_id AND owner_id = p_from FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only the leader can hand over the clan' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM legacy_x.clan_members WHERE clan_id = p_clan_id AND user_id = p_to;
  IF NOT FOUND THEN RAISE EXCEPTION 'That player is not in the clan' USING ERRCODE = 'P0001'; END IF;
  UPDATE legacy_x.clans SET owner_id = p_to, updated_at = now() WHERE id = p_clan_id;
  UPDATE legacy_x.clan_members SET role = 'leader', updated_at = now() WHERE clan_id = p_clan_id AND user_id = p_to;
  UPDATE legacy_x.clan_members SET role = 'co-leader', updated_at = now() WHERE clan_id = p_clan_id AND user_id = p_from;
END $$;
REVOKE ALL ON FUNCTION legacy_x.transfer_clan_leader(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.transfer_clan_leader(uuid, uuid, uuid) TO service_role;

-- ======================================================================
-- legacy_x_penalty_lift_requests.sql
-- ======================================================================
-- An Admin lifts their own penalties at will; lifting someone else's is a request that an Owner or Manager approves.
-- One open request per penalty. Only the API (service_role) reads or writes the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.penalty_lift_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  penalty_id uuid NOT NULL REFERENCES legacy_x.penalties(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS penalty_lift_requests_pending_key ON legacy_x.penalty_lift_requests (penalty_id) WHERE status = 'pending';
ALTER TABLE legacy_x.penalty_lift_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.penalty_lift_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON legacy_x.penalty_lift_requests TO service_role;

-- ======================================================================
-- legacy_x_feedback_reactions.sql
-- ======================================================================
-- Reactions on reviews: like, love or funny, one per player per review. Only the API (service_role) touches the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.feedback_reactions (
  feedback_id uuid NOT NULL REFERENCES legacy_x.feedback(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('like', 'love', 'funny')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feedback_id, user_id)
);
CREATE INDEX IF NOT EXISTS feedback_reactions_feedback_idx ON legacy_x.feedback_reactions (feedback_id);
ALTER TABLE legacy_x.feedback_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.feedback_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.feedback_reactions TO service_role;

-- ======================================================================
-- legacy_x_discord_oauth.sql
-- ======================================================================
-- Linking Discord from the website: a one-time state ties the Discord consent back to the signed-in player. Only the
-- state's hash is stored. Only the API (service_role) uses the table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.discord_oauth_states (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE legacy_x.discord_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.discord_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.discord_oauth_states TO service_role;

-- ======================================================================
-- legacy_x_skin_collections.sql
-- ======================================================================
-- Community skin collections: a player shares a snapshot of their loadout, anyone can apply it.
-- Likes and applies count once per account, and never for the collection's own creator. Only the API (service_role) touches these tables. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.skin_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 40),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) BETWEEN 1 AND 128),
  item_count integer NOT NULL CHECK (item_count > 0),
  likes_count integer NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  applies_count integer NOT NULL DEFAULT 0 CHECK (applies_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS skin_collections_owner_idx ON legacy_x.skin_collections (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS skin_collections_new_idx ON legacy_x.skin_collections (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS skin_collections_popular_idx ON legacy_x.skin_collections (applies_count DESC, likes_count DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_x.skin_collection_likes (
  collection_id uuid NOT NULL REFERENCES legacy_x.skin_collections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.skin_collection_applies (
  collection_id uuid NOT NULL REFERENCES legacy_x.skin_collections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);

ALTER TABLE legacy_x.skin_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skin_collection_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.skin_collection_applies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.skin_collections, legacy_x.skin_collection_likes, legacy_x.skin_collection_applies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.skin_collections, legacy_x.skin_collection_likes, legacy_x.skin_collection_applies TO service_role;

-- Sets or takes back a like and keeps the counter in step; returns the new like count. The creator's own like is ignored.
CREATE OR REPLACE FUNCTION legacy_x.skin_collection_set_like(p_collection_id uuid, p_user_id uuid, p_liked boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_count integer; v_changed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_x.skin_collections WHERE id = p_collection_id AND deleted_at IS NULL AND owner_user_id <> p_user_id) THEN
    RAISE EXCEPTION 'Collection is not available to like' USING ERRCODE = 'P0002';
  END IF;
  IF p_liked THEN
    INSERT INTO legacy_x.skin_collection_likes (collection_id, user_id) VALUES (p_collection_id, p_user_id) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM legacy_x.skin_collection_likes WHERE collection_id = p_collection_id AND user_id = p_user_id;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  UPDATE legacy_x.skin_collections
     SET likes_count = (SELECT count(*) FROM legacy_x.skin_collection_likes WHERE collection_id = p_collection_id)
   WHERE id = p_collection_id
   RETURNING likes_count INTO v_count;
  RETURN v_count;
END $$;

-- Counts an apply once per account; the creator's own applies never count. Returns whether it counted.
CREATE OR REPLACE FUNCTION legacy_x.skin_collection_mark_applied(p_collection_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = legacy_x, public AS $$
DECLARE v_inserted integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_x.skin_collections WHERE id = p_collection_id AND deleted_at IS NULL AND owner_user_id <> p_user_id) THEN
    RETURN false;
  END IF;
  INSERT INTO legacy_x.skin_collection_applies (collection_id, user_id) VALUES (p_collection_id, p_user_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    UPDATE legacy_x.skin_collections SET applies_count = applies_count + 1 WHERE id = p_collection_id;
  END IF;
  RETURN v_inserted = 1;
END $$;

REVOKE ALL ON FUNCTION legacy_x.skin_collection_set_like(uuid, uuid, boolean), legacy_x.skin_collection_mark_applied(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legacy_x.skin_collection_set_like(uuid, uuid, boolean), legacy_x.skin_collection_mark_applied(uuid, uuid) TO service_role;

-- ======================================================================
-- legacy_x_cosmetics.sql
-- ======================================================================
-- Cosmetics (avatar frames first). Purely visual: nothing here changes gameplay, EXP or ranks.
-- Unlock: free (everyone), coin (bought once with wallet coins), achievement (granted by staff/automation, never sold).
-- Only the API (service_role) touches these tables. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_items (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  kind text NOT NULL CHECK (kind IN ('frame')),
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 2 AND 40),
  name_mn text NOT NULL CHECK (char_length(name_mn) BETWEEN 2 AND 40),
  unlock text NOT NULL CHECK (unlock IN ('free', 'coin', 'achievement')),
  price integer NOT NULL DEFAULT 0 CHECK (price >= 0 AND (unlock = 'coin') = (price > 0)),
  requirement text NOT NULL DEFAULT '' CHECK (char_length(requirement) <= 80),
  sort integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_owned (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('coin', 'achievement', 'staff')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.cosmetic_equipped (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('frame')),
  item_id text NOT NULL REFERENCES legacy_x.cosmetic_items(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE legacy_x.cosmetic_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.cosmetic_owned ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.cosmetic_equipped ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.cosmetic_items, legacy_x.cosmetic_owned, legacy_x.cosmetic_equipped FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.cosmetic_items, legacy_x.cosmetic_owned, legacy_x.cosmetic_equipped TO service_role;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort) VALUES
  ('red-dragon', 'frame', 'Red Dragon', 'Улаан луу', 'free', 0, '', 1),
  ('crimson-thorns', 'frame', 'Crimson Thorns', 'Цусан өргөс', 'free', 0, '', 2),
  ('shattered-glass', 'frame', 'Shattered Glass', 'Хагарсан шил', 'free', 0, '', 3),
  ('frost-ring', 'frame', 'Frost Ring', 'Мөсөн цагираг', 'coin', 200, '', 4),
  ('white-lily', 'frame', 'White Lily', 'Цагаан сараана', 'coin', 200, '', 5),
  ('inferno', 'frame', 'Inferno', 'Галт цагираг', 'coin', 250, '', 6),
  ('blood-moon', 'frame', 'Blood Moon', 'Цус сар', 'coin', 300, '', 7),
  ('violet-moon', 'frame', 'Violet Moon', 'Нил сар', 'coin', 300, '', 8),
  ('sakura-silk', 'frame', 'Sakura Silk', 'Сакура торго', 'coin', 300, '', 9),
  ('cyber-violet', 'frame', 'Cyber Violet', 'Кибер нил', 'coin', 350, '', 10),
  ('oni-samurai', 'frame', 'Oni Samurai', 'Они ба сакура', 'coin', 450, '', 11),
  ('emerald-dragon', 'frame', 'Emerald Dragon', 'Ногоон луу', 'coin', 450, '', 12),
  ('golden-crown', 'frame', 'Golden Crown', 'Алтан титэм', 'achievement', 0, 'Reach the Legacy rank', 13),
  ('raven-wing', 'frame', 'Raven Wing', 'Хэрээний жигүүр', 'achievement', 0, 'Reach the Apex rank', 14),
  ('ghost-skull', 'frame', 'Ghost Skull', 'Мөсөн гавлын яс', 'achievement', 0, 'Season 1 winner', 15),
  ('eclipse', 'frame', 'Eclipse', 'Хиртэлт', 'achievement', 0, 'Clan tournament winner', 16)
ON CONFLICT (id) DO NOTHING;

-- ======================================================================
-- legacy_x_session_rotation_grace.sql
-- ======================================================================
-- A refresh token is single use, but a reload that cancels the response, or two tabs refreshing at once, used to lose the new one
-- and sign the player out. rotated_at marks "revoked because it was swapped for a new one": such a token still works for a short grace window.
-- Logout and security revocations leave it empty, so they stay final. Safe to re-run.
ALTER TABLE legacy_x.user_sessions ADD COLUMN IF NOT EXISTS rotated_at timestamptz;

-- ======================================================================
-- legacy_x_clan_numbers.sql
-- ======================================================================
-- Every clan gets a short number in the order clans were opened (the first clan is 1), so its page address is /clans/1.
-- The long id stays the key everywhere else; both work in the API. Safe to re-run.
ALTER TABLE legacy_x.clans ADD COLUMN IF NOT EXISTS number integer;

UPDATE legacy_x.clans c
   SET number = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM legacy_x.clans) n
 WHERE c.id = n.id AND c.number IS NULL;

CREATE SEQUENCE IF NOT EXISTS legacy_x.clans_number_seq OWNED BY legacy_x.clans.number;
SELECT setval('legacy_x.clans_number_seq', COALESCE((SELECT max(number) FROM legacy_x.clans), 0) + 1, false);
ALTER TABLE legacy_x.clans ALTER COLUMN number SET DEFAULT nextval('legacy_x.clans_number_seq');
ALTER TABLE legacy_x.clans ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clans_number_key ON legacy_x.clans (number);
GRANT USAGE, SELECT ON SEQUENCE legacy_x.clans_number_seq TO service_role;

-- ======================================================================
-- legacy_x_cosmetics_names.sql
-- ======================================================================
-- Name colour and name glow cosmetics, next to avatar frames. Purely visual, same rules: free / coin (bought once) / achievement (earned).
-- `color` and `glow` are plain #rrggbb values the website paints the player's name with; nothing else is ever sent to the page as a style.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS glow text CHECK (glow IS NULL OR glow ~ '^#[0-9a-f]{6}$');
ALTER TABLE legacy_x.cosmetic_items DROP CONSTRAINT IF EXISTS cosmetic_items_kind_check;
ALTER TABLE legacy_x.cosmetic_items ADD CONSTRAINT cosmetic_items_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow'));
ALTER TABLE legacy_x.cosmetic_equipped DROP CONSTRAINT IF EXISTS cosmetic_equipped_kind_check;
ALTER TABLE legacy_x.cosmetic_equipped ADD CONSTRAINT cosmetic_equipped_kind_check CHECK (kind IN ('frame', 'name_color', 'name_glow'));

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, glow) VALUES
  ('color-silver', 'name_color', 'Silver', 'Мөнгөн', 'free', 0, '', 1, '#cbd5e1', NULL),
  ('color-ice', 'name_color', 'Ice', 'Мөс', 'coin', 150, '', 2, '#7dd3fc', NULL),
  ('color-mint', 'name_color', 'Mint', 'Гүйлс', 'coin', 150, '', 3, '#86efac', NULL),
  ('color-rose', 'name_color', 'Rose', 'Сарнай', 'coin', 150, '', 4, '#fda4af', NULL),
  ('color-violet', 'name_color', 'Violet', 'Нил', 'coin', 200, '', 5, '#c4b5fd', NULL),
  ('color-sunset', 'name_color', 'Sunset', 'Жаргал', 'coin', 200, '', 6, '#fdba74', NULL),
  ('color-gold', 'name_color', 'Gold', 'Алт', 'coin', 300, '', 7, '#fcd34d', NULL),
  ('color-ember', 'name_color', 'Ember', 'Гал', 'achievement', 0, 'Season 1 winner', 8, '#ff6b4a', NULL),
  ('glow-white', 'name_glow', 'Soft White', 'Цагаан гэрэл', 'coin', 250, '', 1, NULL, '#ffffff'),
  ('glow-ice', 'name_glow', 'Ice', 'Мөсөн гэрэл', 'coin', 250, '', 2, NULL, '#38bdf8'),
  ('glow-mint', 'name_glow', 'Mint', 'Гүйлс гэрэл', 'coin', 250, '', 3, NULL, '#4ade80'),
  ('glow-crimson', 'name_glow', 'Crimson', 'Час улаан', 'coin', 300, '', 4, NULL, '#f43f5e'),
  ('glow-violet', 'name_glow', 'Violet', 'Нил гэрэл', 'coin', 300, '', 5, NULL, '#a78bfa'),
  ('glow-gold', 'name_glow', 'Gold', 'Алтан гэрэл', 'coin', 350, '', 6, NULL, '#fbbf24'),
  ('glow-aurora', 'name_glow', 'Aurora', 'Туяа', 'achievement', 0, 'Clan tournament winner', 7, NULL, '#2dd4bf')
ON CONFLICT (id) DO NOTHING;

-- ======================================================================
-- legacy_x_cosmetics_name_effects.sql
-- ======================================================================
-- Premium name looks: `fx` names a finished effect (chrome, gold foil, neon, flame ...) the website draws with its own CSS.
-- Only a short lowercase key is stored and sent; the page ignores any key it does not know. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS fx text CHECK (fx IS NULL OR fx ~ '^[a-z]{2,20}$');

UPDATE legacy_x.cosmetic_items SET fx = 'neon' WHERE kind = 'name_glow' AND fx IS NULL;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort, color, glow, fx) VALUES
  ('color-chrome', 'name_color', 'Chrome', 'Хром', 'coin', 400, '', 20, '#cbd5e1', NULL, 'chrome'),
  ('color-goldfoil', 'name_color', 'Gold Foil', 'Алтан бүрээс', 'coin', 500, '', 21, '#f5c542', NULL, 'gold'),
  ('color-glacier', 'name_color', 'Glacier', 'Мөсөн уул', 'coin', 450, '', 22, '#7dd3fc', NULL, 'ice'),
  ('color-sakura', 'name_color', 'Sakura', 'Сакура', 'coin', 400, '', 23, '#ff9cbc', NULL, 'sakura'),
  ('color-emerald', 'name_color', 'Emerald', 'Маргад', 'coin', 400, '', 24, '#34d399', NULL, 'emerald'),
  ('color-aurora', 'name_color', 'Aurora', 'Туяа', 'coin', 450, '', 25, '#22d3ee', NULL, 'aurora'),
  ('color-holo', 'name_color', 'Hologram', 'Голограмм', 'coin', 600, '', 26, '#a5f3fc', NULL, 'holo'),
  ('color-inferno', 'name_color', 'Inferno', 'Галт', 'coin', 500, '', 27, '#ff9100', NULL, 'fire'),
  ('color-void', 'name_color', 'Void', 'Хоосон', 'achievement', 0, 'Reach the Apex rank', 28, '#a855f7', NULL, 'void'),
  ('glow-pulse', 'name_glow', 'Crimson Pulse', 'Цохилт', 'coin', 400, '', 20, NULL, '#f43f5e', 'pulse'),
  ('glow-flame', 'name_glow', 'Flame', 'Дөл', 'coin', 450, '', 21, NULL, '#fb923c', 'flame'),
  ('glow-electric', 'name_glow', 'Electric', 'Цахилгаан', 'coin', 450, '', 22, NULL, '#60a5fa', 'electric'),
  ('glow-royal', 'name_glow', 'Royal Aura', 'Хааны туяа', 'coin', 500, '', 23, NULL, '#fbbf24', 'aura')
ON CONFLICT (id) DO NOTHING;

-- ======================================================================
-- legacy_x_cosmetics_frames_2.sql
-- ======================================================================
-- Second set of avatar frames (24). The first set is switched off (kept, so nothing that points at it breaks) and nobody wears it any more.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame' AND id IN ('red-dragon','crimson-thorns','shattered-glass','frost-ring','white-lily','inferno','blood-moon','violet-moon','sakura-silk','cyber-violet','oni-samurai','emerald-dragon','golden-crown','raven-wing','ghost-skull','eclipse');
-- Worn or owned rows that still point at a switched-off frame are ignored by the API, so nothing has to be deleted.
-- Anyone who paid coins for a frame of the first set gets those coins back (once: the ref is per player and frame).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT o.user_id, o.item_id, i.price, i.name_en
      FROM legacy_x.cosmetic_owned o JOIN legacy_x.cosmetic_items i ON i.id = o.item_id
     WHERE i.kind = 'frame' AND i.enabled = false AND o.source = 'coin' AND i.price > 0
  LOOP
    PERFORM legacy_x.wallet_apply(r.user_id, r.price, 'refund', 'Frame replaced by the new set: ' || r.name_en, 'cosmetic:' || r.item_id || ':replaced', NULL);
  END LOOP;
END $$;

INSERT INTO legacy_x.cosmetic_items (id, kind, name_en, name_mn, unlock, price, requirement, sort) VALUES
  ('starlight-corners', 'frame', 'Starlight Corners', 'Одны булан', 'free', 0, '', 1),
  ('torn-tape', 'frame', 'Torn Tape', 'Урагдсан тууз', 'free', 0, '', 2),
  ('red-circuit', 'frame', 'Red Circuit', 'Улаан хэлхээ', 'free', 0, '', 3),
  ('shattered-crystal', 'frame', 'Shattered Crystal', 'Хагарсан болор', 'free', 0, '', 4),
  ('charcoal-ring', 'frame', 'Charcoal Ring', 'Нүүрсэн цагираг', 'coin', 200, '', 5),
  ('barbed-wire', 'frame', 'Barbed Wire', 'Өргөст утас', 'coin', 200, '', 6),
  ('silent-waves', 'frame', 'Silent Waves', 'Чимээгүй давалгаа', 'coin', 200, '', 7),
  ('neon-violet', 'frame', 'Neon Violet', 'Нил неон', 'coin', 250, '', 8),
  ('graffiti', 'frame', 'Graffiti', 'Граффити', 'coin', 250, '', 9),
  ('liquid-metal', 'frame', 'Liquid Metal', 'Шингэн металл', 'coin', 300, '', 10),
  ('chain-and-tag', 'frame', 'Chain and Tag', 'Гинж ба тэмдэг', 'coin', 300, '', 11),
  ('sakura-blossom', 'frame', 'Sakura Blossom', 'Сакура цэцэг', 'coin', 350, '', 12),
  ('blue-lightning', 'frame', 'Blue Lightning', 'Хөх аянга', 'coin', 350, '', 13),
  ('crimson-lightning', 'frame', 'Crimson Lightning', 'Улаан аянга', 'coin', 350, '', 14),
  ('toxic-lightning', 'frame', 'Toxic Lightning', 'Хортой аянга', 'coin', 350, '', 15),
  ('prism-glass', 'frame', 'Prism Glass', 'Призм шил', 'coin', 400, '', 16),
  ('blood-vine', 'frame', 'Blood Vine', 'Цусан ороонго', 'coin', 400, '', 17),
  ('film-and-butterflies', 'frame', 'Film and Butterflies', 'Хальс ба эрвээхэй', 'coin', 400, '', 18),
  ('planet-orbit', 'frame', 'Planet Orbit', 'Гараг тойрог', 'coin', 450, '', 19),
  ('ice-crystals', 'frame', 'Ice Crystals', 'Мөсөн болор', 'coin', 450, '', 20),
  ('golden-moon', 'frame', 'Golden Moon', 'Алтан сар', 'achievement', 0, 'Reach the Legacy rank', 21),
  ('angel-wings', 'frame', 'Angel Wings', 'Сахиусны жигүүр', 'achievement', 0, 'Reach the Apex rank', 22),
  ('eclipse-clouds', 'frame', 'Eclipse Clouds', 'Хиртэлтийн үүл', 'achievement', 0, 'Clan tournament winner', 23),
  ('glitch', 'frame', 'Glitch', 'Глич', 'achievement', 0, 'Season 1 winner', 24)
ON CONFLICT (id) DO NOTHING;

-- ======================================================================
-- legacy_x_shop.sql
-- ======================================================================
-- Shop: every item has a rarity (1 common ... 4 legendary) and may be featured. Achievement items are the hardest to get,
-- so they are legendary. A few top items cost more so the higher tiers exist. Safe to re-run.
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS rarity smallint NOT NULL DEFAULT 1 CHECK (rarity BETWEEN 1 AND 4);
ALTER TABLE legacy_x.cosmetic_items ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

UPDATE legacy_x.cosmetic_items SET price = 700 WHERE id IN ('planet-orbit', 'ice-crystals') AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 650 WHERE id = 'prism-glass' AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 900 WHERE id = 'color-holo' AND unlock = 'coin';
UPDATE legacy_x.cosmetic_items SET price = 600 WHERE id = 'color-goldfoil' AND unlock = 'coin';

UPDATE legacy_x.cosmetic_items SET rarity = CASE
  WHEN unlock = 'achievement' THEN 4
  WHEN unlock = 'free' OR price <= 250 THEN 1
  WHEN price <= 500 THEN 2
  ELSE 3 END;

UPDATE legacy_x.cosmetic_items SET featured = id IN ('planet-orbit', 'color-holo', 'glow-royal', 'ice-crystals');

-- ======================================================================
-- legacy_x_clan_looks.sql
-- ======================================================================
-- Clan appearance: a clan (bought by its leader with coins) owns tag colours, tag glows and backdrops, and wears one of each.
-- The catalog lives in the API code (server/legacyX/clanLooks.ts); only ownership and what is worn is stored. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_owned (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  bought_by uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, item_id)
);
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_equipped (
  clan_id uuid NOT NULL REFERENCES legacy_x.clans(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tag_color', 'tag_glow', 'backdrop', 'page')),
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, kind)
);
ALTER TABLE legacy_x.clan_look_owned ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_x.clan_look_equipped ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_owned, legacy_x.clan_look_equipped FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_owned, legacy_x.clan_look_equipped TO service_role;
NOTIFY pgrst, 'reload schema';
-- Added later: the whole-page background. Safe to re-run.
ALTER TABLE legacy_x.clan_look_equipped DROP CONSTRAINT IF EXISTS clan_look_equipped_kind_check;
ALTER TABLE legacy_x.clan_look_equipped ADD CONSTRAINT clan_look_equipped_kind_check CHECK (kind IN ('tag_color', 'tag_glow', 'backdrop', 'page'));

-- Appearance belongs to the player who bought it (the leader), not to the clan: it stays theirs when a clan is deleted. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.clan_look_owned_player (
  user_id uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (item_id ~ '^[a-z0-9-]{2,40}$'),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
ALTER TABLE legacy_x.clan_look_owned_player ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.clan_look_owned_player FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.clan_look_owned_player TO service_role;
INSERT INTO legacy_x.clan_look_owned_player (user_id, item_id, acquired_at)
  SELECT bought_by, item_id, acquired_at FROM legacy_x.clan_look_owned WHERE bought_by IS NOT NULL
  ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';

-- ======================================================================
-- legacy_x_player_checks.sql
-- ======================================================================
-- Player checks: a staff member (Admin, Manager or Owner) asks a player to run the checker program with a one-time code.
-- The program sends back what it found; staff read it and decide. Nothing here bans anyone by itself.
-- Only the API (service_role) touches this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text NOT NULL CHECK (char_length(code_hint) = 4),
  target_steam_id text NOT NULL CHECK (target_steam_id ~ '^[0-9]{17}$'),
  target_user_id uuid REFERENCES legacy_x.users(id) ON DELETE SET NULL,
  requested_by uuid NOT NULL REFERENCES legacy_x.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  checker_version text CHECK (checker_version IS NULL OR char_length(checker_version) <= 20),
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_checks_created_idx ON legacy_x.player_checks (created_at DESC);
CREATE INDEX IF NOT EXISTS player_checks_target_idx ON legacy_x.player_checks (target_steam_id, status);
ALTER TABLE legacy_x.player_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.player_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.player_checks TO service_role;
NOTIFY pgrst, 'reload schema';

-- A personal download: each check can give out its checker zip a few times (the zip carries the check's code). Safe to re-run.
ALTER TABLE legacy_x.player_checks ADD COLUMN IF NOT EXISTS download_count integer NOT NULL DEFAULT 0 CHECK (download_count BETWEEN 0 AND 100);
NOTIFY pgrst, 'reload schema';

-- ======================================================================
-- legacy_x_player_hwids.sql
-- ======================================================================
-- Hardware fingerprint of the PC a player ran the checker on. Only hashes: the program hashes each serial number on the PC and sends the hashes,
-- never the numbers. One row per player and part, so two accounts that played on the same PC (same board, CPU, disk ...) can be told apart from
-- two that did not. verified = the player's Steam account was found on that PC. Only the API (service_role) touches this table. Safe to re-run.
CREATE TABLE IF NOT EXISTS legacy_x.player_hwids (
  steam_id text NOT NULL CHECK (steam_id ~ '^[0-9]{17}$'),
  kind text NOT NULL CHECK (kind IN ('id', 'uuid', 'board', 'bios', 'cpu', 'disk', 'machine')),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  verified boolean NOT NULL DEFAULT false,
  check_id uuid REFERENCES legacy_x.player_checks(id) ON DELETE SET NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS player_hwids_hash_idx ON legacy_x.player_hwids (kind, hash);
ALTER TABLE legacy_x.player_hwids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legacy_x.player_hwids FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_x.player_hwids TO service_role;
NOTIFY pgrst, 'reload schema';

-- ======================================================================
-- legacy_x_cosmetics_frame_prices.sql
-- ======================================================================
-- Frames: no free frames, and the cheapest frame bought with LX costs 500 (owner's decision, 2026-10-10). Safe to re-run.
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE kind = 'frame' AND unlock = 'free';
UPDATE legacy_x.cosmetic_items SET price = 500 WHERE kind = 'frame' AND unlock = 'coin' AND price < 500;

-- The same for name colours and glows: nothing is free, and nothing bought with LX costs less than 500. Safe to re-run.
UPDATE legacy_x.cosmetic_items SET price = 500 WHERE unlock = 'coin' AND price < 500 AND kind IN ('name_color', 'name_glow');
UPDATE legacy_x.cosmetic_items SET enabled = false WHERE unlock = 'free';
