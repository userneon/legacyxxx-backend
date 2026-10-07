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
