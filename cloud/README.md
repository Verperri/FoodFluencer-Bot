# Centralized telemetry (Cloudflare Worker + D1)

Stores two things, only from users who opt in via Settings → Diagnostics & Sharing:

- **`image_feedback`** — quality/appeal metrics for photos considered by the photo
  waterfall, plus whether each was kept for the post. Foundation for the future
  engagement-feedback loop (Option 4).
- **`tech_logs`** — the same entries already shown in Settings → Logs & Statistics →
  Technical Log, tagged with an anonymous per-install UUID.

No business names, addresses, or account credentials are sent.

## Deploy (one-time, by the project maintainer)

Requires a free Cloudflare account and `wrangler` (`npm install -g wrangler`).

```bash
cd cloud
wrangler login

# Create the D1 database, then copy the returned database_id into wrangler.toml
wrangler d1 create foodfluencer-telemetry

# Apply the schema
wrangler d1 execute foodfluencer-telemetry --remote --file=schema.sql

# Set the admin token (pick your own long random string — keep it secret)
wrangler secret put ADMIN_TOKEN

# Deploy
wrangler deploy
```

Wrangler prints the Worker URL (e.g. `https://foodfluencer-telemetry.<account>.workers.dev`).
Put that URL in [`config.js`](../config.js) as `CONFIG.TELEMETRY_ENDPOINT`.

## Super-user (admin) access

Regular users only ever hit the write-only `/v1/feedback` and `/v1/logs` routes —
there is no read API exposed by default in the extension itself, and the
`ADMIN_TOKEN` is **never bundled** in the extension code (anything shipped to
users is readable by them).

As the maintainer, query the data three ways:

1. **Cloudflare dashboard / `wrangler d1 execute`** — full SQL access, gated by
   your Cloudflare account login:
   ```bash
   wrangler d1 execute foodfluencer-telemetry --remote \
     --command="SELECT install_id, level, category, action, ts FROM tech_logs ORDER BY created_at DESC LIMIT 50"
   ```

2. **Admin HTTP routes** — for a future admin dashboard, gated by the
   `ADMIN_TOKEN` secret (never shipped in the extension):
   - `GET /admin/installs` — list install IDs with last-seen time and log counts
   - `GET /admin/logs?installId=<uuid>&level=error` — recent logs for one install
   - `GET /admin/feedback?installId=<uuid>` — recent photo feedback for one install

   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     "https://foodfluencer-telemetry.<account>.workers.dev/admin/installs"
   ```

3. **From inside the extension itself** — Settings → Diagnostics & Sharing has
   a hidden "Admin" sub-panel (only visible after entering a valid admin
   token once). The token is typed in by you, stored only in *your*
   `chrome.storage.local`, and sent as the `Authorization: Bearer` header on
   `/admin/*` requests made directly from the popup. It is never written to
   the extension's source/bundle, so other users have no way to discover or
   reuse it — without the token the panel stays hidden and `/admin/*`
   requests are rejected with 401 by the Worker.

## Support workflow

A user with an issue can open Settings → Diagnostics & Sharing and copy their
**Install ID**. With that ID and the admin token, run:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://foodfluencer-telemetry.<account>.workers.dev/admin/logs?installId=<their-id>&level=error"
```
