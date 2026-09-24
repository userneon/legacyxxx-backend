# Deferred Feature Launch Flags

The public launch policy is **fail closed**. Unless an environment variable is the literal string `true`, the matching feature is hidden from public UI, direct browser routes redirect to the homepage, and matching public API routes return `404`.

| Variable | Scope while `false` | Enablement prerequisite |
|---|---|---|
| `STAFF_PANEL_ENABLED` | Staff Panel route, fresh Steam callback and `/staffpanel` APIs | Staff migration, active staff record, audited executor and staging checks completed |

Shop, Wallet, Credits, Promo codes and Clans were removed from the product (code, API and database), so their
former `SHOP_ENABLED`, `WALLET_ENABLED`, `CREDITS_ENABLED`, `PROMO_CODES_ENABLED` and `CLAN_ENABLED` switches no longer exist.

## Enablement Procedure

Set only the intended feature variable to `true` in the **backend** environment, then reload the backend process. The frontend reads `GET /api/v1/public/features` at runtime, so navigation and direct routes update without embedding a launch decision into the frontend build.

```bash
STAFF_PANEL_ENABLED=true
npm run reload:pm2
```

Never expose secret values, service-role keys, RCON credentials, deployment credentials or database passwords through this endpoint. It returns only public boolean launch state.
