# Steam Profile Background Feasibility

## Official API Boundary

Steamworks `ISteamUser/GetPlayerSummaries` is a server-side profile summary endpoint. Its public player summary contract includes avatar URLs and common account fields, but it does **not** expose a selected Steam profile background image URL. The generic Steam Web API documentation similarly describes basic profile summary data rather than a profile-theme/background field.[1][2]

> A Steam-background experience must therefore either use an optional user-provided background URL stored by LEGACY-X, or obtain data only from a public Steam community profile through a non-official scraping path. The latter should not be used as a required identity/data source because it is privacy-dependent and may change without notice.

## Safe LEGACY-X Direction

The recommended production behavior is an optional `steam_profile_background` field, with a dark glass fallback whenever the field is unavailable. A player can only set a public/HTTPS image URL that passes server-side validation. Steam profile data remains sourced from the official summary endpoint; background choice is a presentation preference rather than trusted account data.

## References

[1] [Steamworks ISteamUser Interface](https://partner.steamgames.com/doc/webapi/isteamuser)

[2] [Steam Web API — Valve Developer Community](https://developer.valvesoftware.com/wiki/Steam_Web_API)
