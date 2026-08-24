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
