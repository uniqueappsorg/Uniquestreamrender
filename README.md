# UniqueStream Talk server

Node 18+, Express, SQLite (better-sqlite3), Neon Postgres, WebSocket, and LiveKit token service.

```
npm install
node server.js
```
Set the variables in `.env.example` in the hosting environment (do not commit a `.env`). The supplied
Google Web OAuth JSON may be mounted as a protected server-side file via `GOOGLE_OAUTH_CLIENT_FILE`
(or provide its client ID/secret as environment variables); never package it in the Android app.
Configure
`GOOGLE_REDIRECT_URI` as an exact HTTPS callback in Google Cloud Console. The Web OAuth client
secret and `YOUTUBE_TOKEN_ENCRYPTION_KEY` must stay on the server. The OAuth callback stores only an
AES-256-GCM encrypted refresh token; `/api/youtube/oauth/access-token` returns short-lived access
tokens to an authenticated app session. LiveKit signing credentials also stay server-side.

REST: `POST /api/auth/guest`, `POST /api/auth/google`, `POST /api/youtube/oauth/start`,
`GET /api/youtube/oauth/callback`, `GET /api/youtube/oauth/status`,
`POST /api/youtube/oauth/access-token`, `POST /api/livekit/token`, `GET/POST /api/rooms`,
`GET /api/rooms/:code`, `GET /api/rooms/:code/messages`, `DELETE /api/rooms/:code`, `GET /health`.
WebSocket: `/ws?token=...` - JSON text frames (`join`, `leave`, `chat`, `mute_self`, `raise_hand`, `react`, `host`)
and binary voice frames (client sends ADPCM payload; server forwards `[uid:uint32 BE][payload]`).
Neon is primary when `NEON_DATABASE_URL` is set; otherwise SQLite is used locally. See `.env.example`
and `Dockerfile`. The in-memory room presence and OAuth state require a single server instance (or
sticky routing); persistent room/chat records and encrypted YouTube credentials are in Neon.
