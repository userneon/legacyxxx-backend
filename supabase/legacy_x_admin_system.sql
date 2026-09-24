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
