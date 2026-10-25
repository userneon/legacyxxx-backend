-- Match Core takes any ranked lobby the ranking counts (owner decision 2026-10-18, RANK-SYSTEM.md section 3): 2 to 5 human players on each
-- team (2v2, 3v5, 4v5, 5v5 ...), not only exactly ten. Until now a match with fewer than ten players was refused at match_created, so
-- nothing was saved and no EXP was given. "All slots back" now means every slot the match started with, not ten. Safe to re-run.
DO $migration$
DECLARE
  d text;
  patched text;
BEGIN
  d := pg_get_functiondef('legacy_x.ingest_core_match_event(text,text,jsonb)'::regprocedure);
  patched := replace(d,
    $old$jsonb_array_length(COALESCE(p_payload->'participants', '[]'::jsonb)) <> 10$old$,
    $new$((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(p_payload->'participants', '[]'::jsonb)) AS e(value) WHERE e.value->>'team_key' = 'team1') NOT BETWEEN 2 AND 5
       OR (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(p_payload->'participants', '[]'::jsonb)) AS e(value) WHERE e.value->>'team_key' = 'team2') NOT BETWEEN 2 AND 5)$new$);
  patched := replace(patched, 'match_created requires exactly 10 original participants', 'match_created requires 2 to 5 original participants on each team');
  patched := replace(patched, 'cannot resume without exactly ten active slots', 'cannot resume until every slot is filled');
  IF patched = d AND position('2 to 5 original participants' in d) = 0 THEN
    RAISE EXCEPTION 'ingest_core_match_event did not look as expected; not patched';
  END IF;
  IF patched <> d THEN EXECUTE patched; END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION legacy_x.core_match_active_slots_ready(p_match_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'legacy_x', 'public'
AS $function$
  SELECT COUNT(*) >= 4
     AND COUNT(*) FILTER (WHERE active_user_id IS NOT NULL AND active_role IN ('original', 'fill')) = COUNT(*)
  FROM legacy_x.core_match_slots
  WHERE match_id = p_match_id;
$function$;
NOTIFY pgrst, 'reload schema';
