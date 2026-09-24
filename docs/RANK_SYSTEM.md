# Legacy-X rank system (v1.0) — implementation notes

The specification is the design pack's `RANK-SYSTEM.md` (EXP formula, 18 ranks, Pro League 1400/1350).
This page records where each part lives and the choices the spec leaves open.

| Part | Where |
|---|---|
| Ladder (18 ranks, thresholds, image keys), Pro League rule, progress | `server/legacyX/rank/ranks.ts` (+ `legacy_x.competitive_rank_definitions`) |
| ΔEXP formula, validity, leaver, short-handed, participation, bots, calibration, caps, floor | `server/legacyX/rank/exp.ts` (pure, no I/O) |
| Plugin payload → calculation → apply, retry on concurrent change | `server/legacyX/rank/matchResult.ts` |
| Atomic, idempotent apply (receipt by event id), EXP floor, Pro League flag, history rows | `legacy_x.apply_competitive_match_exp` (`supabase/legacy_x_rank_system_v1.sql`) |
| Tests for every rule in the spec | `server/legacyX/rank/*.test.ts` |

Calculation version: `rank-v1.0` (stored on every `competitive_match_exp` row and receipt).

## Choices not fixed by the spec

- **Rounding** is half away from zero, so a gain and the mirrored loss have the same size (the worked example
  gives the same numbers either way).
- **Lobby deviation** is the population standard deviation over every human with at least one round; the floor
  0.05 applies.
- **MVP** is the highest `score` among players whose EXP is performance-based (not leavers, not <50 % players);
  ties all get the bonus; nobody gets it when all of them share one score.
- **Team rating** is the average EXP (at match start) of the team's starters; fills are excluded from it but
  get EXP normally for the rounds they played.
- **Leaver in an invalid match** still gets −25 (the implementation contract keeps the leaver rule for invalid
  matches). Fun Mode is the exception: it never changes EXP, not even for a leaver.
- **Unregistered humans** (no Legacy-X account yet) count in the lobby at the starting 1000 EXP; only
  registered players get history rows.
- **Short-handed rounds** come from the plugin (`short_handed_rounds`); when absent they are derived from the
  leaver's `left_at_round`, but only if no fill joined that team.

## What players see

`GET /api/v1/public/competitive/players/:userId/matches` returns each ranked match with `expDelta` and the
breakdown (`result`, `margin`, `performance`, `bonus`, `calibration`, `reason`, `omittedTerms`), which the website
shows as `+18 · Win vs stronger team +17 · Margin +2 · Performance −1`.
