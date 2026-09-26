# KnowUsBetter Backend

## iOS Push Notification Setup

### 1) Supabase migration

Run:

`migrations/20260429_push_tokens.sql`

This creates `push_tokens` table, trigger, and indexes.

### 2) Apple Developer APNs key (.p8)

1. Open [Apple Developer Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/authkeys/list).
2. Create a new key and enable APNs.
3. Download the `.p8` file once.
4. Save:
   - Key ID -> `APNS_KEY_ID`
   - Team ID -> `APNS_TEAM_ID`
   - App bundle id -> `APNS_BUNDLE_ID`
5. Put `.p8` file content into `APNS_PRIVATE_KEY` as multiline string (or escaped with `\n`).

### 3) Environment variables

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_BUNDLE_ID`
- `APNS_PRIVATE_KEY`
- `APNS_USE_PRODUCTION` (`true` for App Store/TestFlight production APNs, `false` for sandbox)
- `ADMIN_NOTIFICATIONS_SECRET`

Optional:

- `NOTIFICATION_REGISTER_RATE_MAX` (default `120`)
- `NOTIFICATION_REGISTER_RATE_WINDOW_MS` (default `60000`)
- `ADMIN_NOTIFICATION_RATE_MAX` (default `20`)
- `ADMIN_NOTIFICATION_RATE_WINDOW_MS` (default `60000`)

### 4) Endpoints

- `POST /notifications/register-token`
- `POST /admin/notifications/new-content`

### 5) Test steps

1. Apply migration in Supabase SQL editor.
2. Start backend: `npm run dev`
3. Register test iOS token from app/client.
4. Trigger admin endpoint and verify APNs send logs.
5. Invalid tokens are auto-marked `is_active=false`.

### 6) Local commands

- Build: `npm run build`
- Push tests: `npm run test:notifications`

## Question Admin Panel

Mobile web panel to list / add / edit / delete questions and run SQL against the database.
Served by this backend at `https://<render-host>${ADMIN_PATH}/`, protected with a passkey (Face ID).

### Environment variables

- `ADMIN_PATH` – unguessable mount path, e.g. `/q7x2k9-panel` (min 8 chars). Panel is disabled if unset.
- `DATABASE_URL` – Supabase Postgres connection string. Use **Session pooler** from
  Supabase → Connect (IPv4 compatible; the direct connection is IPv6-only and does not work on Render).
- `ADMIN_SETUP_TOKEN` – long random string (min 16 chars), required to register a device.
- `ADMIN_ORIGIN` / `ADMIN_RP_ID` – optional; default to `RENDER_EXTERNAL_URL` and its hostname.
  Changing the domain invalidates registered passkeys.

Passkeys are stored in `admin_panel.passkeys` (created automatically; separate schema so it is not exposed via the Supabase REST API).
Sessions, challenges and the failed-attempt lockout live in Redis.

### First setup

1. Set the env vars on Render and deploy.
2. Open `https://<render-host>${ADMIN_PATH}/` in Safari on the phone.
3. Enter `ADMIN_SETUP_TOKEN`, approve Face ID. Registration closes once a passkey exists;
   adding another device requires being logged in **and** the setup token.
4. Share → Add to Home Screen.

### SQL tab

- **Önizle** runs everything inside `BEGIN … ROLLBACK` (nothing is saved).
- **Uygula** requires a fresh Face ID confirmation and runs inside `BEGIN … COMMIT`.
- Transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SET`, …) is rejected; statement timeout is 15s.
