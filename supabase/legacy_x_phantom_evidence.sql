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
