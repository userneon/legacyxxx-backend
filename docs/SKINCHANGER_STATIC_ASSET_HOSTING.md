# Skinchanger Static Asset Hosting

Skinchanger catalog images are delivered only through the API-owned static origin:

```dotenv
STATIC_ASSET_BASE_URL=https://static.legacyx.cc
```

The catalog database stores an object key such as:

```text
skinchanger/catalog/weapon/6f9b7fd6a40b8c5a9d2e2c3f.webp
```

It never stores a public third-party URL. The operator-only catalog ingest script downloads public source artwork, converts it to WebP, uploads the generated asset to API-owned storage, and persists only this key. Browsers therefore request `static.legacyx.cc`, not Akamai, Steam CDN, GitHub, a catalog source, Supabase or the Root API.

## Existing external catalog rows

1. Deploy the latest Root API source.
2. Run `supabase/legacy_x_skinchanger_remove_external_asset_keys.sql` in the Supabase SQL Editor.
3. Run the operator-only ingest script with real server-side credentials. Do not use `--skip-images` for the final ingest.
4. Confirm every active catalog row has an `image_key` matching `skinchanger/catalog/...webp`.
5. In a browser Network panel, verify catalog thumbnails use only `https://static.legacyx.cc/...`.

The browser cannot hide a resource origin that it actually requests. This design avoids third-party origins rather than attempting to conceal them.
