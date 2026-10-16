# Cleanup 2026-10-16: unused code and abandoned features

Method: `knip` on the frontend, backend and Discord bot; `tsc --noUnusedLocals` on the backend; every backend route searched for in the website, the
game plugins, the bot and the Workshop addon; CSS classes and layout ids of the addon compared with the plugin; the plugin projects built with warnings on.

## Removed (no caller anywhere)

| Repo | What |
|---|---|
| backend | `adminplus/` (the old Node API with RCON access and its own secrets; nothing called it), its scripts, `docs/ADMINPLUS_API_ONLY.md`, `todo.md` |
| backend | routes `GET/PUT /staffpanel/maintenance`, `GET /staffpanel/health`, `GET /staffpanel/servers/:id/roster`, `GET /staffpanel/players/:steamId/penalties`, `GET/POST /community/content` and their tests |
| backend | unused locals: `refreshTokenFromRequest`, `staffRoute`, `leaderboardHandler`, `readLimit`, five schemas |
| frontend | `src/api/community.ts`, `StatTilesSkeleton`, `RowsSkeleton`, `faceitLevelProgress`, the ID card (`ProfileIds`), the `roster` feature flag, `src/assets/killfeed/` |
| workshop | the announcement banner (`ann`) and the "Hold E" hint, `lx-bar-lost`, `lx-chip`, `lx-delta`, `lx-line`, `lx-text`, `lx-banner` |
| plugins (Hud) | `Announce()`, the E-hold opening code |

## Left for the owner to decide (a feature, not dead code)

1. **Kill feed pipeline**: the plugin `LegacyX-Killfeed` posts every kill to `/plugin/killfeed/events`, the API keeps them in memory, `/public/killfeed` serves
   them and `src/api/killfeed.ts` exists, but no page shows them (the top-bar feed was removed).
2. **`PUT /profile/me/owner`** (owner message and links on the profile): the page reads them, nothing writes them.
3. **MatchZy upstream features**: practice mode (about 1,800 lines), SQLite match stats, demo upload, G5 API, coach, `.tech` (work in progress upstream, returns at once), clan tags (`HandleClanTags` returns at once).
4. **Staff roster of a server** (route removed above) if the Staff → Servers page is to show who is on a server.
