# LEGACY-X Backend & Plugin Integration TODO

- [x] Existing AdminPlus frontend source болон backend/plugin dependency boundary-г audit хийх.
- [x] AdminPlus-ийг frontend-гүй API command bridge гэж README, package scripts, deployment docs дээр цэгцлэх.
- [x] Rank, player season, match result, stat event, leaderboard view-д зориулсан database migration гаргах.
- [x] Server-signed plugin event ingestion API болон idempotency/replay хамгаалалт хэрэгжүүлэх.
- [x] MatchZy result event-ээс player rank/rating update хийх scoring service нэмэх.
- [x] Staff leaderboard болон player rank/history API endpoints нэмэх.
- [x] AdminPlus backend-д secure plugin event API болон server-only configuration нэмэх.
- [x] MatchZy match-end bridge-ээр result/score/player participation event илгээх integration нэмэх.
- [x] Backend, plugin builds, API auth, secret hygiene-г local environment дээр шалгах.
- [ ] Supabase дээр `legacy_x_rank.sql` migration apply хийж service-role grants-ийг live project дээр баталгаажуулах.
- [ ] CS2 MatchZy private rank cfg-г бодит URL/secret-тэй байршуулж 5v5 match-аар end-to-end smoke test хийх.
- [x] GitHub commit болон production integration runbook/changelog бэлдэх.
- [ ] GitHub push хийж remote branch clean эсэхийг баталгаажуулах.

## LEGACY-X Community Progression & Clans

- [x] Existing MatchZy rank payload, backend rank migration болон plugin module ownership-ийг audit хийх.
- [x] EXP/level curve, anti-farm caps, season behavior болон clan permission policy-г тодорхойлох.
- [x] EXP, player level, clan, membership, clan season score, idempotent event receipt schema migration бичих.
- [x] Plugin-signed match result ingestion-д EXP/level болон clan aggregate update нэмэх.
- [x] Player profile, EXP leaderboard, clan leaderboard, clan detail/API endpoints нэмэх.
- [x] LEGACY-X Community CounterStrikeSharp plugin үүсгэж player identity, clan tag, chat/command UX-г нэмэх.
- [x] MatchZy final map result-ээс community event metadata-ийг backend рүү найдвартай илгээх.
- [x] MatchZy, AdminPlus, AFK Manager, Community plugin-ийн config, branding, responsibility boundary-г нэгтгэх.
- [x] Migration/API/plugin build, idempotency болон secret hygiene-г local environment дээр шалгах.
- [ ] Supabase migration apply болон real exact-5v5 CS2 smoke test хийх.
- [x] GitHub commit, deployment guide болон customization changelog бэлдэх.
- [x] GitHub push хийж backend/plugins remote branch clean эсэхийг баталгаажуулах.

## Monthly Rank Season Reset

- [x] Existing rank season, leaderboard, clan score болон MatchZy season configuration-г audit хийх.
- [x] Monthly season boundary, UTC reset policy, archive retention болон XP/level preservation policy-г тодорхойлох.
- [x] Idempotent monthly season rollover/archive database migration болон RPC function бичих.
- [x] Backend scheduler болон staff season status/rollover API нэмэх.
- [x] MatchZy rank season config-ийг active backend season-тэй production-safe синк хийх.
- [x] Duplicate scheduler run, scheduler-disabled runtime болон closed-season event backend binding-г local environment дээр шалгах.
- [x] Build, security test, documentation болон live migration runbook бэлдэх.
- [ ] Intended Supabase project дээр migration apply хийж, real completed 5v5 event болон сарын rollover-ийг end-to-end шалгах.
- [x] GitHub commit болон monthly reset runbook/changelog бэлдэх.
- [x] GitHub push хийж backend/plugins remote clean status-ийг баталгаажуулах.

## LEGACY-X Reconnect & Last Played

- [x] Existing MatchZy player connect/disconnect lifecycle, backend player/session tables болон server connection contract-г audit хийх.
- [x] Reconnect session, last-played retention, privacy and server availability policy-г тодорхойлох.
- [x] Reconnect session migration, plugin event ingestion болон player/profile API endpoints хэрэгжүүлэх.
- [x] LEGACY-X Reconnect CounterStrikeSharp plugin, `css_reconnect` command болон MatchZy-aware state tracking нэмэх.
- [x] Reconnect plugin private config, server address validation, player privacy, README/changelog болон stack ownership-г цэгцлэх.
- [x] Backend/plugin build, API auth/idempotency, secret hygiene болон mismatched server event smoke test хийх.
- [ ] Intended Supabase project migration apply болон real disconnect/server-B-reconnect CS2 end-to-end test хийх.
- [x] GitHub commit болон production deployment runbook бэлдэх.
- [x] GitHub push хийж backend/plugins remote clean status-ийг баталгаажуулах.
