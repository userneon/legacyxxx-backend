# LEGACY-X Promotion Codes

## Security model

Promotion code redemption is **Root API only**. Browser, frontend bundle, CounterStrikeSharp plugin and database client do not receive promotion table access. A raw code is normalized and SHA-256 hashed in the API before lookup; only its hash and a masked hint are stored. The full code is returned once to the authorized staff member who issues it.

| Owner | Use | Benefit types allowed |
|---|---|---|
| `legacyx` | Official secret campaigns | Wallet credit, top-up rate/percent/fixed discount, store discount, Admin role entitlement |
| `creator` | Creator attribution code | Wallet credit or checkout discount; must identify the creator owner user |
| `partner` | Partner attribution code | Wallet credit or checkout discount; must identify the partner owner user |

## Benefit types

| Benefit | Example | Redemption point |
|---|---|---|
| `wallet_rate_override` | 1 coin = 500₮ instead of 2,000₮ | Preview only until a verified payment-provider checkout is integrated |
| `wallet_percent` / `wallet_fixed` | 25% off / 5,000₮ off a top-up | Preview only until verified payment checkout |
| `wallet_credit` | Voucher gives 100 coins | Immediate atomic wallet redemption |
| `store_percent` / `store_fixed` | 20% off / 10 coins off a store item | Promo-aware store purchase RPC |
| `admin_role` | Official free Admin access code | Immediate server-side `Player → Admin` entitlement; only Owner/Founder may create/issue it |

## Hard rules

The database transaction locks the code and campaign, checks active/start/expiry/global/per-user limits, writes an immutable redemption, updates the wallet/store/entitlement state, increments counters and writes an audit log in one operation. A client-supplied idempotency key prevents duplicate submit effects. Creator and partner codes can never issue the Admin role. A successful Admin entitlement requires the player to sign in again so the new role enters a fresh access JWT.

> A top-up discount is deliberately **not redeemed** by preview. The current `/wallet/charge` endpoint returns `501` because a verified QPay/card provider flow is not yet integrated. Consuming a money-related promo before confirmed payment would be incorrect.
