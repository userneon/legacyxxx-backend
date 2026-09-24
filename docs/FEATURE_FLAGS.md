# Deferred Feature Launch Flags

The public launch policy is **fail closed**. Unless an environment variable is the literal string `true`, the matching feature is hidden from public UI, direct browser routes redirect to the homepage, and matching public API routes return `404`. The implementation does not remove components, tables, schemas, or route definitions.

| Variable | Scope while `false` | Enablement prerequisite |
|---|---|---|
| `SHOP_ENABLED` | Shop/Marketplace UI and `/store`, `/shop` APIs | Catalog, purchase executor, payment and refund controls validated |
| `WALLET_ENABLED` | Wallet UI and `/wallet` APIs | Ledger, payment reconciliation and operator controls validated |
| `CREDITS_ENABLED` | Credit-dependent Wallet UI | Credit pricing and transaction rules validated |
| `PROMO_CODES_ENABLED` | Promo preview/redeem and staff promotion APIs | Code limits, entitlement policy and audit validation completed |
| `CLAN_ENABLED` | Clan UI, clan search and `/clans` APIs | Clan moderation and membership flows validated |
| `STAFF_PANEL_ENABLED` | Staff Panel route, fresh Steam callback and `/staffpanel` APIs | Staff migration, active staff record, audited executor and staging checks completed |

## Enablement Procedure

Set only the intended feature variable to `true` in the **backend** environment, then reload the backend process. The frontend reads `GET /api/v1/public/features` at runtime, so navigation and direct routes update without embedding a launch decision into the frontend build.

```bash
# Example: launch Clan after its own readiness checks are complete.
CLAN_ENABLED=true
npm run reload:pm2
```

Never expose secret values, service-role keys, RCON credentials, deployment credentials or database passwords through this endpoint. It returns only public boolean launch state.
