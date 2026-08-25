# LEGACY-X Root API Security Hardening

## Implemented application controls

The Root API binds to loopback by default, keeps the public API under `/api/v1`, requires HTTPS origin configuration in production, accepts a maximum request body configured by `API_BODY_LIMIT_KB`, and now returns a correlation `X-Request-Id` header. The process deliberately records only method, path, status and duration for failed requests; it never logs authorization headers, request bodies, promotion codes, Steam identity or payment data.

| Route class | Control |
|---|---|
| All `/api/v1` routes | Configurable global per-IP rate limit, strict CORS preflight, no-store response policy, safe error boundary |
| `/auth/*` | Additional authentication request rate limit |
| `/staff/*` | Additional sensitive-mutation rate limit plus existing staff role guard |
| `/wallet/promo/*` | Existing narrow promotion rate limit plus authenticated user boundary |
| Plugin routes | Existing scoped plugin-token authentication and strict Zod payload schemas |

The application sends browser-neutral response headers (`nosniff`, clickjacking denial, strict referrer, resource/opener policy, permissions policy and API-only CSP). HSTS is emitted only in production, where HTTPS is already mandatory.

> CORS does not stop direct HTTP clients. It only prevents an unapproved browser origin from reading a credentialed response. The actual boundary is the combination of Nginx, loopback process binding, TLS, JWT/plugin token scope, RLS, validation and rate limits.

## Required Nginx hardening

Create `/etc/nginx/conf.d/legacyx-api-security.conf`. This file is included from Nginx's `http {}` scope on standard Ubuntu installations, so the `limit_req_zone` declarations are valid there.

```nginx
limit_req_zone $binary_remote_addr zone=legacyx_api_ip:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=legacyx_api_conn:10m;
```

Inside the existing `server { server_name api.legacyx.cc; }` block, use the following hardened location configuration. Preserve the existing TLS certificate directives.

```nginx
server_tokens off;
client_max_body_size 1m;

add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

location = /health {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    limit_req zone=legacyx_api_ip burst=10 nodelay;
}

location / {
    limit_except GET POST PUT PATCH DELETE OPTIONS { deny all; }
    limit_req zone=legacyx_api_ip burst=60 nodelay;
    limit_conn legacyx_api_conn 20;

    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;
    proxy_buffering off;
}
```

## Safe VPS rollout and rollback

Deploy the backend first, then validate it before changing Nginx:

```bash
cd ~/legacyxxx-backend
git pull --ff-only origin main
npm install
npm run build
pm2 reload legacy-x-api --update-env
curl -fsS https://api.legacyx.cc/health
```

Back up the active Nginx file before editing it, then validate and reload only after a successful syntax test:

```bash
sudo cp /etc/nginx/sites-available/api.legacyx.cc /etc/nginx/sites-available/api.legacyx.cc.bak.$(date +%F-%H%M%S)
sudo nginx -t && sudo systemctl reload nginx
```

If a public/auth flow is blocked, restore the backup, remove the new include file, run `sudo nginx -t`, and reload Nginx. Do not rotate JWT or plugin secrets during this rollout; secret rotation is a separate, coordinated change because it intentionally terminates active sessions and plugin authentication.

## Monitoring signals

Use `pm2 logs legacy-x-api` to review structured `api_request` warning records. Investigate sustained 401/403/413/429/5xx spikes by request path and request ID. Nginx access/error logs should be retained and fed to the host's existing security monitoring or Fail2ban/WAF process; do not ban IPs automatically until normal Steam/plugin traffic baselines have been observed.
