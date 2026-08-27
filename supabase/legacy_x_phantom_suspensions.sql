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
