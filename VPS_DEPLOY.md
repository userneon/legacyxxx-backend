# LEGACY-X API: VPS + Nginx + PM2 Deployment

This repository runs as a single Node.js API process behind Nginx. It does **not** require Manus hosting. Nginx should proxy the `api.legacyx.cc` hostname to the private listener at `127.0.0.1:3000`.

> The repository deliberately contains **no seed data, test users, store items, or plugin tokens**. Create real API tokens and operational content through your administrator workflow after deployment; do not place raw tokens in source control.

## Required environment

Copy `ENVIRONMENT.example` to `.env` on the VPS and replace every placeholder. Keep `.env` private; it is ignored by Git.

| Variable | Required | Purpose |
|---|---:|---|
| `NODE_ENV` | Yes | Set to `production`. |
| `HOST` | Yes | Use `127.0.0.1` behind local Nginx. |
| `PORT` | Yes | API port; use `3000`. |
| `TRUST_PROXY` | Yes | Use `1` for one Nginx proxy hop. |
| `API_RATE_LIMIT_MAX` | Yes | Maximum requests per minute per IP. |
| `SUPABASE_URL` | Yes | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only Supabase service role key. |
| `JWT_SECRET` | Yes | Random secret with at least 32 characters. |
| `PUBLIC_API_ORIGIN` | Yes | `https://api.legacyx.cc`; used in Steam OpenID callback URLs. |
| `FRONTEND_ORIGIN` | Yes | `https://legacyx.cc`; the only credentialed browser CORS origin. |
| `AUTH_COOKIE_DOMAIN` | Yes | `.legacyx.cc` for API/frontend cross-subdomain session cookies. |
| `POST_LOGIN_REDIRECT` | Yes | `https://legacyx.cc/`; destination after a successful Steam callback. |

## First deployment

Run these commands on Ubuntu VPS as the non-root deployment user.

```bash
sudo apt update
sudo apt install -y git curl build-essential

# Install Node.js 22 LTS, then verify.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version

# Install PM2 once for the server user.
sudo npm install -g pm2

# Clone and install.
sudo mkdir -p /var/www
sudo chown "$USER":"$USER" /var/www
git clone <YOUR_GITHUB_REPOSITORY_URL> /var/www/legacy-x-api
cd /var/www/legacy-x-api
npm install

# Configure private production environment.
cp ENVIRONMENT.example .env
nano .env
chmod 600 .env

# Compile and start under PM2.
npm run build
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

Run the final command printed by `pm2 startup` exactly once; it registers PM2 after server reboots.

## Subsequent releases

```bash
cd /var/www/legacy-x-api
git pull --ff-only
npm install
npm run build
pm2 reload ecosystem.config.cjs --env production --update-env
pm2 status
```

## Nginx contract

Your existing site block should proxy only to the private Node listener. Preserve the forwarded host, protocol, and client IP headers.

```nginx
server {
    listen 443 ssl http2;
    server_name api.legacyx.cc;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

After changing Nginx, verify and reload it with `sudo nginx -t && sudo systemctl reload nginx`.

## Verification and operations

```bash
# Local VPS listener
curl -fsS http://127.0.0.1:3000/api/v1/health

# Public HTTPS API
curl -fsS https://api.legacyx.cc/api/v1/health
curl -fsS 'https://api.legacyx.cc/api/v1/leaderboard?sort=rating&limit=5'

# Confirm the Steam OpenID redirect uses the API subdomain callback.
curl -sSI https://api.legacyx.cc/api/v1/auth/steam | grep -i '^location:'

# Process management
pm2 status
pm2 logs legacy-x-api --lines 100
pm2 reload legacy-x-api --update-env
```

The API remains at `https://api.legacyx.cc`, but the Steam consent screen should identify `legacyx.cc`. Set `STEAM_OPENID_ORIGIN=https://legacyx.cc`, so Steam receives `https://legacyx.cc/api/v1/auth/steam/callback` as both realm and callback. Copy `NETLIFY_STEAM_CALLBACK_PROXY.toml` into the Netlify frontend repository's `netlify.toml`; it transparently forwards that one callback path to `https://api.legacyx.cc/api/v1/auth/steam/callback`. Successful login sets secure, HTTP-only cookies for `.legacyx.cc` and redirects the browser to `https://legacyx.cc/`. Browser calls from the frontend to the API must use `credentials: "include"`.

After the Netlify deploy completes, open `https://api.legacyx.cc/api/v1/auth/steam`. The Steam consent page should say **legacyx.cc**. Complete login once and confirm that `https://legacyx.cc/` loads with both `legacyx_access_token` and `legacyx_refresh_token` HTTP-only cookies scoped to `.legacyx.cc`.

The VPS `.env` must include `STEAM_WEB_API_KEY`. The callback uses this key only on the Node server to retrieve Steam `personaname` and avatar URL, then updates the existing `legacy_x.users` row matching the verified `steam_id`. Verify the result after a real login using a database read: `SELECT steam_id, username, avatar, level, rank FROM legacy_x.users WHERE steam_id = '<your-steam-id>' LIMIT 1;`. The expected outcome is the real persona name and a non-empty avatar URL while `level` and `rank` remain unchanged.

## Supabase security boundary

The VPS API is the **only** component that receives `SUPABASE_SERVICE_ROLE_KEY`. Direct browser access to Supabase is intentionally not used. The verified database posture is that `service_role` bypasses RLS and holds the required `legacy_x` grants, while `anon` and `authenticated` have no direct table grants on that schema. Keep the service-role key only in the VPS `.env` file and never return it, log it, or include it in frontend bundles.
