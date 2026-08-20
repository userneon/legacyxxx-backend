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
