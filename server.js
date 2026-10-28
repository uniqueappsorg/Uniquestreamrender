/**
 * UniqueStream Talk Room server
 * -----------------------------
 *  - REST API  (auth, rooms, chat history)      -> Express
 *  - Database  (Neon when configured; SQLite local fallback)
 *  - Realtime  (presence, chat, host controls)  -> WebSocket text frames (JSON)
 *  - Voice     (IMA-ADPCM 16 kHz mono frames)   -> WebSocket binary frames, relayed per room
 *
 * Voice frame wire format
 *   client -> server : [ payload ... ]                (server adds the sender uid)
 *   server -> client : [ uid : uint32 BE ][ payload ]
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const { Pool } = require('@neondatabase/serverless');
const { AccessToken, TrackSource } = require('livekit-server-sdk');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || './data/talk.db';
const MAX_VOICE_FRAME = parseInt(process.env.MAX_VOICE_FRAME || '1200', 10);
const MAX_ROOM_MEMBERS = parseInt(process.env.MAX_ROOM_MEMBERS || '12', 10);
const NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || '';
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
let googleOAuthFile = {};
if (process.env.GOOGLE_OAUTH_CLIENT_FILE) {
  try { googleOAuthFile = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE, 'utf8')).web || {}; }
  catch (e) { console.error('Google OAuth client file could not be read:', e.message); }
}
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || googleOAuthFile.client_id || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || googleOAuthFile.client_secret || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_APP_REDIRECT_URI = process.env.GOOGLE_APP_REDIRECT_URI || 'uniquestream://youtube-connected';
const YOUTUBE_TOKEN_ENCRYPTION_KEY = process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY || '';
const neonSql = NEON_DATABASE_URL ? (() => {
  const pool = new Pool({ connectionString: NEON_DATABASE_URL });
  return { query: async (text, params = []) => (await pool.query(text, params)).rows };
})() : null;
let neonReady = Promise.resolve();

// ---------------------------------------------------------------- database
let db = null;
let q = {};
if (!neonSql) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, google_sub TEXT UNIQUE,
  avatar TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT DEFAULT '', host_id TEXT NOT NULL,
  is_public INTEGER DEFAULT 1, open_mic INTEGER DEFAULT 1, locked INTEGER DEFAULT 0,
  max_members INTEGER DEFAULT 8, created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT NOT NULL, user_id TEXT NOT NULL,
  name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS youtube_credentials (
  user_id TEXT PRIMARY KEY, refresh_token TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_code, id);
  `);
  q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  insertUser: db.prepare('INSERT INTO users (id, name, email, google_sub, avatar, created_at) VALUES (?,?,?,?,?,?)'),
  updateUser: db.prepare('UPDATE users SET name = ?, avatar = COALESCE(?, avatar), email = COALESCE(?, email) WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  insertRoom: db.prepare('INSERT INTO rooms (code, name, topic, host_id, is_public, open_mic, max_members, created_at) VALUES (?,?,?,?,?,?,?,?)'),
  roomByCode: db.prepare('SELECT * FROM rooms WHERE code = ? AND closed_at IS NULL'),
  publicRooms: db.prepare('SELECT * FROM rooms WHERE is_public = 1 AND closed_at IS NULL ORDER BY created_at DESC LIMIT 50'),
  closeRoom: db.prepare('UPDATE rooms SET closed_at = ? WHERE code = ?'),
  setLocked: db.prepare('UPDATE rooms SET locked = ? WHERE code = ?'),
  insertMsg: db.prepare('INSERT INTO messages (room_code, user_id, name, text, ts) VALUES (?,?,?,?,?)'),
  recentMsgs: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_code = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  };
}

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const newToken = () => crypto.randomBytes(24).toString('hex');
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
async function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 20; tries++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (!(await roomByCode(c))) return c;
  }
  throw new Error('could not allocate room code');
}
const publicUser = (u) => ({ id: u.id, name: u.name, avatar: u.avatar || '' });

if (neonSql) {
  neonReady = (async () => {
    await neonSql.query(`CREATE TABLE IF NOT EXISTS talk_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, google_sub TEXT UNIQUE,
      avatar TEXT, created_at BIGINT NOT NULL
    )`);
    await neonSql.query(`CREATE TABLE IF NOT EXISTS talk_sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES talk_users(id), created_at BIGINT NOT NULL
    )`);
    await neonSql.query(`CREATE TABLE IF NOT EXISTS talk_rooms (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
    host_id TEXT NOT NULL, is_public BOOLEAN NOT NULL DEFAULT TRUE,
    open_mic BOOLEAN NOT NULL DEFAULT TRUE, locked BOOLEAN NOT NULL DEFAULT FALSE,
    max_members INTEGER NOT NULL, created_at BIGINT NOT NULL, closed_at BIGINT
    )`);
    await neonSql.query(`CREATE TABLE IF NOT EXISTS talk_messages (
    id BIGSERIAL PRIMARY KEY, room_code TEXT NOT NULL, user_id TEXT NOT NULL,
    name TEXT NOT NULL, text TEXT NOT NULL, ts BIGINT NOT NULL
    )`);
    await neonSql.query(`CREATE TABLE IF NOT EXISTS youtube_credentials (
      user_id TEXT PRIMARY KEY REFERENCES talk_users(id), refresh_token TEXT NOT NULL, updated_at BIGINT NOT NULL
    )`);
  })().catch((e) => { console.error('Neon schema init failed:', e.message); throw e; });
}

async function userById(id) {
  if (neonSql) { await neonReady; return (await neonSql.query('SELECT * FROM talk_users WHERE id=$1', [id]))[0] || null; }
  return q.userById.get(id) || null;
}
async function userByGoogle(sub) {
  if (neonSql) { await neonReady; return (await neonSql.query('SELECT * FROM talk_users WHERE google_sub=$1', [sub]))[0] || null; }
  return q.userByGoogle.get(sub) || null;
}
async function saveUser(user) {
  if (neonSql) {
    await neonReady;
    const values = [user.id, user.name, user.email || null, user.google_sub || null, user.avatar || null, user.created_at || now()];
    const conflict = user.google_sub ? 'google_sub' : 'id';
    await neonSql.query(
      `INSERT INTO talk_users (id,name,email,google_sub,avatar,created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (${conflict}) DO UPDATE SET name=EXCLUDED.name, email=COALESCE(EXCLUDED.email,talk_users.email),
       avatar=COALESCE(EXCLUDED.avatar,talk_users.avatar)`, values
    );
    return user.google_sub ? userByGoogle(user.google_sub) : userById(user.id);
  }
  if (q.userById.get(user.id)) {
    q.updateUser.run(user.name, user.avatar || null, user.email || null, user.id);
    return q.userById.get(user.id);
  }
  q.insertUser.run(user.id, user.name, user.email || null, user.google_sub || null, user.avatar || null, user.created_at || now());
  return q.userById.get(user.id);
}
async function sessionUser(token) {
  if (neonSql) { await neonReady; return (await neonSql.query(
    'SELECT u.* FROM talk_sessions s JOIN talk_users u ON u.id=s.user_id WHERE s.token=$1', [token]
  ))[0] || null; }
  return q.sessionUser.get(token) || null;
}

async function roomByCode(code) {
  if (neonSql) { await neonReady; return (await neonSql.query(
    'SELECT * FROM talk_rooms WHERE code = $1 AND closed_at IS NULL', [code]
  ))[0] || null; }
  return q.roomByCode.get(code) || null;
}

async function listPublicRooms() {
  if (neonSql) { await neonReady; return neonSql.query(
    'SELECT * FROM talk_rooms WHERE is_public = TRUE AND closed_at IS NULL ORDER BY created_at DESC LIMIT 50'
  ); }
  return q.publicRooms.all();
}

async function listMessages(code, limit) {
  if (neonSql) { await neonReady; return neonSql.query(
    'SELECT id, room_code, user_id, name, text, ts FROM talk_messages WHERE room_code = $1 ORDER BY id DESC LIMIT $2',
    [code, limit]
  ).then((rows) => rows.reverse()); }
  return q.recentMsgs.all(code, limit);
}

async function insertRoomRecord(room) {
  if (neonSql) {
    await neonReady;
    await neonSql.query(
      `INSERT INTO talk_rooms (code,name,topic,host_id,is_public,open_mic,max_members,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [room.code, room.name, room.topic, room.host_id, !!room.is_public, !!room.open_mic, room.max_members, room.created_at]
    );
    return roomByCode(room.code);
  }
  q.insertRoom.run(room.code, room.name, room.topic, room.host_id, room.is_public, room.open_mic, room.max_members, room.created_at);
  return q.roomByCode.get(room.code);
}

async function updateRoom(code, column, value) {
  if (neonSql) {
    await neonReady;
    if (column === 'closed_at') await neonSql.query('UPDATE talk_rooms SET closed_at=$1 WHERE code=$2', [value, code]);
    else if (column === 'locked') await neonSql.query('UPDATE talk_rooms SET locked=$1 WHERE code=$2', [!!value, code]);
    else if (column === 'host_id') await neonSql.query('UPDATE talk_rooms SET host_id=$1 WHERE code=$2', [value, code]);
    return;
  }
  if (column === 'closed_at') q.closeRoom.run(value, code);
  else if (column === 'locked') q.setLocked.run(value ? 1 : 0, code);
  else if (column === 'host_id') db.prepare('UPDATE rooms SET host_id = ? WHERE code = ?').run(value, code);
}

async function persistSession(token, userId, createdAt) {
  if (neonSql) {
    await neonReady;
    await neonSql.query('INSERT INTO talk_sessions (token,user_id,created_at) VALUES ($1,$2,$3)', [token, userId, createdAt]);
  } else q.insertSession.run(token, userId, createdAt);
}

async function insertMessage(code, user, text, ts) {
  if (neonSql) {
    await neonReady;
    const rows = await neonSql.query(
      'INSERT INTO talk_messages (room_code,user_id,name,text,ts) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [code, user.id, user.name, text, ts]
    );
    return Number(rows[0].id);
  }
  return Number(q.insertMsg.run(code, user.id, user.name, text, ts).lastInsertRowid);
}

// live rooms: code -> { members: Map<userId, Member>, nextUid }
const live = new Map();
const pendingYoutubeOAuth = new Map();
function liveRoom(code) {
  if (!live.has(code)) live.set(code, { members: new Map(), nextUid: 1 });
  return live.get(code);
}
function roomDto(r) {
  const lr = live.get(r.code);
  return {
    code: r.code, name: r.name, topic: r.topic, hostId: r.host_id,
    isPublic: !!r.is_public, openMic: !!r.open_mic, locked: !!r.locked,
    maxMembers: r.max_members, members: lr ? lr.members.size : 0, createdAt: r.created_at,
  };
}
const memberDto = (m) => ({
  id: m.user.id, uid: m.uid, name: m.user.name, avatar: m.user.avatar || '',
  role: m.role, muted: m.muted, hand: m.hand,
});

// ---------------------------------------------------------------- REST
const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: live.size, time: now() }));

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const user = token ? await sessionUser(token) : null;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  } catch (e) {
    console.error('authentication lookup failed:', e);
    res.status(503).json({ error: 'authentication service unavailable' });
  }
}

// Production LiveKit token endpoint. API secrets never leave this backend. Tokens are short-lived
// and publish microphone audio only; camera publishing is intentionally not granted.
app.post('/api/livekit/token', auth, async (req, res) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({ error: 'LiveKit is not configured on the server' });
    }
    const room = clean(req.body.room, 64);
    if (!room || !/^[A-Za-z0-9_-]+$/.test(room)) return res.status(400).json({ error: 'valid room is required' });
    const roomCode = room.toUpperCase();
    const record = await roomByCode(roomCode);
    if (!record) return res.status(404).json({ error: 'room not found' });
    const member = live.get(roomCode)?.members.get(req.user.id);
    if (!member) return res.status(403).json({ error: 'join the room before requesting voice access' });
    const canPublish = member.role === 'host' || member.role === 'speaker';
    const identity = `u_${req.user.id}`;
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity, name: clean(req.user.name, 32), ttl: '10m'
    });
    at.addGrant({
      room: roomCode, roomJoin: true, canSubscribe: true, canPublish,
      canPublishData: true, ...(canPublish ? { canPublishSources: [TrackSource.MICROPHONE] } : {})
    });
    res.json({ url: LIVEKIT_URL, token: await at.toJwt(), identity });
  } catch (e) {
    console.error('LiveKit token failed:', e);
    res.status(500).json({ error: 'could not create LiveKit token' });
  }
});

async function startSession(user) {
  const token = newToken();
  await persistSession(token, user.id, now());
  return { token, user: publicUser(user) };
}

app.post('/api/auth/guest', async (req, res) => {
  const name = clean(req.body.name, 32) || 'Guest';
  const deviceId = clean(req.body.deviceId, 64);
  const id = deviceId ? 'd_' + crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 24) : 'g_' + crypto.randomBytes(8).toString('hex');
  try {
    const current = await userById(id);
    const user = await saveUser({ id, name, email: current?.email || null, google_sub: current?.google_sub || null, avatar: current?.avatar || null, created_at: current?.created_at || now() });
    res.json(await startSession(user));
  } catch (e) { console.error('guest auth failed:', e); res.status(503).json({ error: 'could not start guest session' }); }
});

// Verify a Google OAuth access token by asking Google who it belongs to (no client secret needed).
app.post('/api/auth/google', async (req, res) => {
  try {
    const accessToken = clean(req.body.accessToken, 4096);
    if (!accessToken) return res.status(400).json({ error: 'accessToken required' });
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return res.status(401).json({ error: 'google token rejected' });
    const info = await r.json();
    const name = clean(req.body.name || info.name || info.email, 32) || 'Streamer';
    let user = info.sub ? await userByGoogle(info.sub) : null;
    if (!user) {
      const id = 'u_' + crypto.randomBytes(8).toString('hex');
      user = await saveUser({ id, name, email: info.email || null, google_sub: info.sub || null, avatar: info.picture || null, created_at: now() });
    } else {
      user = await saveUser({ ...user, name, email: info.email || user.email || null, avatar: info.picture || user.avatar || null });
    }
    res.json(await startSession(user));
  } catch (e) {
    res.status(500).json({ error: 'google verification failed' });
  }
});

function encryptRefreshToken(token) {
  if (!/^[a-f0-9]{64}$/i.test(YOUTUBE_TOKEN_ENCRYPTION_KEY)) throw new Error('YOUTUBE_TOKEN_ENCRYPTION_KEY must be 32-byte hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(YOUTUBE_TOKEN_ENCRYPTION_KEY, 'hex'), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decryptRefreshToken(value) {
  const [iv, tag, data] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(YOUTUBE_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
async function saveYoutubeRefreshToken(userId, token) {
  const encrypted = encryptRefreshToken(token);
  if (neonSql) {
    await neonReady;
    await neonSql.query(`INSERT INTO youtube_credentials (user_id,refresh_token,updated_at) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET refresh_token=EXCLUDED.refresh_token,updated_at=EXCLUDED.updated_at`, [userId, encrypted, now()]);
  } else db.prepare(`INSERT INTO youtube_credentials (user_id,refresh_token,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET refresh_token=excluded.refresh_token,updated_at=excluded.updated_at`).run(userId, encrypted, now());
}
async function getYoutubeRefreshToken(userId) {
  let row;
  if (neonSql) {
    await neonReady;
    row = (await neonSql.query('SELECT refresh_token FROM youtube_credentials WHERE user_id=$1', [userId]))[0];
  } else row = db.prepare('SELECT refresh_token FROM youtube_credentials WHERE user_id=?').get(userId);
  return row ? decryptRefreshToken(row.refresh_token) : null;
}

// OAuth web-server flow: refresh tokens stay server-side and are encrypted at rest.
app.post('/api/youtube/oauth/start', auth, async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !YOUTUBE_TOKEN_ENCRYPTION_KEY) {
    return res.status(503).json({ error: 'YouTube server OAuth is not configured' });
  }
  const state = crypto.randomBytes(32).toString('hex');
  pendingYoutubeOAuth.set(state, { userId: req.user.id, expiresAt: now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube', access_type: 'offline',
    prompt: 'consent', include_granted_scopes: 'true', state });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/api/youtube/oauth/callback', async (req, res) => {
  const state = clean(req.query.state, 64);
  const pending = pendingYoutubeOAuth.get(state);
  pendingYoutubeOAuth.delete(state);
  if (!pending || pending.expiresAt < now()) return res.status(400).send('OAuth state expired. Return to UniqueStream and try again.');
  if (req.query.error) return res.redirect(`${GOOGLE_APP_REDIRECT_URI}?ok=0`);
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        code: clean(req.query.code, 4096), client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }) });
    const tokens = await response.json();
    if (!response.ok) throw new Error(tokens.error || 'Google code exchange failed');
    if (tokens.refresh_token) await saveYoutubeRefreshToken(pending.userId, tokens.refresh_token);
    else if (!await getYoutubeRefreshToken(pending.userId)) throw new Error('Google did not return a refresh token; revoke app grant and reconnect');
    return res.redirect(`${GOOGLE_APP_REDIRECT_URI}?ok=1`);
  } catch (e) {
    console.error('YouTube OAuth callback failed:', e.message);
    return res.redirect(`${GOOGLE_APP_REDIRECT_URI}?ok=0`);
  }
});

app.get('/api/youtube/oauth/status', auth, async (req, res) => {
  try { res.json({ connected: !!(await getYoutubeRefreshToken(req.user.id)) }); }
  catch (e) { console.error('YouTube OAuth status failed:', e.message); res.status(503).json({ error: 'YouTube credentials unavailable' }); }
});

app.delete('/api/youtube/oauth', auth, async (req, res) => {
  try {
    const refreshToken = await getYoutubeRefreshToken(req.user.id);
    if (neonSql) {
      await neonReady;
      await neonSql.query('DELETE FROM youtube_credentials WHERE user_id=$1', [req.user.id]);
    } else db.prepare('DELETE FROM youtube_credentials WHERE user_id=?').run(req.user.id);
    if (refreshToken) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      }).catch((e) => console.warn('Google grant revoke request failed:', e.message));
    }
    res.json({ ok: true });
  } catch (e) { console.error('YouTube disconnect failed:', e.message); res.status(503).json({ error: 'Could not disconnect YouTube' }); }
});

app.post('/api/youtube/oauth/access-token', auth, async (req, res) => {
  try {
    const refreshToken = await getYoutubeRefreshToken(req.user.id);
    if (!refreshToken) return res.status(404).json({ error: 'YouTube channel is not connected' });
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refreshToken,
        grant_type: 'refresh_token' }) });
    const body = await response.json();
    if (!response.ok) return res.status(401).json({ error: 'YouTube authorization expired; reconnect your channel' });
    res.json({ accessToken: body.access_token, expiresIn: body.expires_in });
  } catch (e) { console.error('YouTube token refresh failed:', e.message); res.status(503).json({ error: 'Could not refresh YouTube authorization' }); }
});

app.get('/api/rooms', auth, async (_req, res) => {
  try { res.json((await listPublicRooms()).map(roomDto)); }
  catch (e) { console.error('list rooms failed:', e); res.status(503).json({ error: 'room database unavailable' }); }
});

app.post('/api/rooms', auth, async (req, res) => {
  const name = clean(req.body.name, 40) || `${req.user.name}'s room`;
  const topic = clean(req.body.topic, 80);
  const isPublic = req.body.isPublic === false ? 0 : 1;
  const openMic = req.body.openMic === false ? 0 : 1;
  const max = Math.min(Math.max(parseInt(req.body.maxMembers || 8, 10) || 8, 2), MAX_ROOM_MEMBERS);
  try {
    const code = await newRoomCode();
    const record = await insertRoomRecord({
      code, name, topic, host_id: req.user.id, is_public: isPublic,
      open_mic: openMic, locked: false, max_members: max, created_at: now(),
    });
    res.json(roomDto(record));
  } catch (e) { console.error('create room failed:', e); res.status(503).json({ error: 'could not save room' }); }
});

app.get('/api/rooms/:code', auth, async (req, res) => {
  const r = await roomByCode(clean(req.params.code, 8).toUpperCase());
  if (!r) return res.status(404).json({ error: 'room not found' });
  res.json(roomDto(r));
});

app.get('/api/rooms/:code/messages', auth, async (req, res) => {
  const code = clean(req.params.code, 8).toUpperCase();
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  try { res.json(await listMessages(code, limit)); }
  catch (e) { console.error('room history failed:', e); res.status(503).json({ error: 'room history unavailable' }); }
});

app.delete('/api/rooms/:code', auth, async (req, res) => {
  const code = clean(req.params.code, 8).toUpperCase();
  const r = await roomByCode(code);
  if (!r) return res.status(404).json({ error: 'room not found' });
  if (r.host_id !== req.user.id) return res.status(403).json({ error: 'only the host can close the room' });
  await closeRoom(code);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- realtime
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(code, obj, exceptUserId) {
  const lr = live.get(code);
  if (!lr) return;
  const data = JSON.stringify(obj);
  for (const m of lr.members.values()) {
    if (m.user.id !== exceptUserId && m.ws.readyState === 1) m.ws.send(data);
  }
}
async function closeRoom(code) {
  await updateRoom(code, 'closed_at', now());
  broadcast(code, { t: 'room_closed' });
  const lr = live.get(code);
  if (lr) {
    for (const m of lr.members.values()) { try { m.ws.close(1000, 'room closed'); } catch (_) {} }
    live.delete(code);
  }
}
async function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const lr = live.get(code);
  ws.roomCode = null;
  if (!lr) return;
  const m = lr.members.get(ws.user.id);
  if (m && m.ws === ws) {
    lr.members.delete(ws.user.id);
    broadcast(code, { t: 'member_leave', id: ws.user.id });
    const r = await roomByCode(code);
    // host left: promote the longest-present member, or close an empty room
    if (r && r.host_id === ws.user.id) {
      const next = lr.members.values().next().value;
      if (next) {
        await updateRoom(code, 'host_id', next.user.id);
        next.role = 'host';
        broadcast(code, { t: 'host_changed', id: next.user.id });
      }
    }
    if (lr.members.size === 0) { live.delete(code); }
  }
}

async function handleJoin(ws, msg) {
  const code = clean(msg.room, 8).toUpperCase();
  const r = await roomByCode(code);
  if (!r) return send(ws, { t: 'error', code: 'no_room', message: 'Room not found' });
  await leaveRoom(ws);
  const lr = liveRoom(code);
  const existing = lr.members.get(ws.user.id);
  if (!existing) {
    if (r.locked && r.host_id !== ws.user.id) return send(ws, { t: 'error', code: 'locked', message: 'Room is locked' });
    if (lr.members.size >= r.max_members) return send(ws, { t: 'error', code: 'full', message: 'Room is full' });
  } else {
    try { existing.ws.close(4000, 'joined elsewhere'); } catch (_) {}
  }
  const isHost = r.host_id === ws.user.id;
  const member = existing || {
    user: ws.user, uid: lr.nextUid++, muted: false, hand: false,
    role: isHost ? 'host' : (r.open_mic ? 'speaker' : 'listener'),
  };
  member.ws = ws;
  lr.members.set(ws.user.id, member);
  ws.roomCode = code;
  const history = await listMessages(code, 30);
  send(ws, {
    t: 'joined', room: roomDto(r), you: memberDto(member),
    members: [...lr.members.values()].map(memberDto), history,
  });
  broadcast(code, { t: 'member_join', member: memberDto(member) }, ws.user.id);
}

async function handleHost(ws, msg) {
  const code = ws.roomCode;
  const lr = code && live.get(code);
  const r = code && await roomByCode(code);
  if (!lr || !r) return;
  if (r.host_id !== ws.user.id) return send(ws, { t: 'error', code: 'forbidden', message: 'Host only' });
  const target = msg.target ? lr.members.get(String(msg.target)) : null;
  switch (msg.action) {
    case 'mute': case 'unmute':
      if (!target) return;
      target.muted = msg.action === 'mute';
      broadcast(code, { t: 'member_update', id: target.user.id, muted: target.muted });
      break;
    case 'mute_all':
      for (const m of lr.members.values()) if (m.role !== 'host') { m.muted = true; }
      broadcast(code, { t: 'mute_all' });
      break;
    case 'promote': case 'demote':
      if (!target) return;
      target.role = msg.action === 'promote' ? 'speaker' : 'listener';
      target.hand = false;
      broadcast(code, { t: 'member_update', id: target.user.id, role: target.role, hand: false });
      break;
    case 'kick':
      if (!target || target.user.id === ws.user.id) return;
      send(target.ws, { t: 'kicked' });
      lr.members.delete(target.user.id);
      broadcast(code, { t: 'member_leave', id: target.user.id });
      try { target.ws.close(4001, 'kicked'); } catch (_) {}
      break;
    case 'lock': case 'unlock':
      await updateRoom(code, 'locked', msg.action === 'lock');
      broadcast(code, { t: 'room_update', locked: msg.action === 'lock' });
      break;
    case 'close':
      await closeRoom(code);
      break;
    default: break;
  }
}

wss.on('connection', async (ws, req) => {
  const queuedMessages = [];
  const queueMessage = (data, isBinary) => queuedMessages.push([data, isBinary]);
  ws.on('message', queueMessage);
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || '';
  let user = null;
  try { user = token ? await sessionUser(token) : null; }
  catch (e) { console.error('websocket auth lookup failed:', e); ws.close(1013, 'auth service unavailable'); return; }
  if (!user) { ws.close(4401, 'unauthorized'); return; }
  ws.user = user;
  ws.isAlive = true;
  ws.roomCode = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        // voice frame
        const code = ws.roomCode;
        const lr = code && live.get(code);
        if (!lr || data.length > MAX_VOICE_FRAME || data.length < 4) return;
        const me = lr.members.get(ws.user.id);
        if (!me || me.muted || me.role === 'listener') return;
        const out = Buffer.allocUnsafe(4 + data.length);
        out.writeUInt32BE(me.uid, 0);
        data.copy(out, 4);
        for (const m of lr.members.values()) {
          if (m !== me && m.ws.readyState === 1 && m.ws.bufferedAmount < 256 * 1024) m.ws.send(out, { binary: true });
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      switch (msg.t) {
        case 'join': void handleJoin(ws, msg).catch((e) => { console.error('join failed:', e); send(ws, { t: 'error', code: 'join_failed', message: 'Could not join room' }); }); break;
        case 'leave': void leaveRoom(ws).catch((e) => console.error('leave failed:', e)); break;
        case 'chat': {
          const code = ws.roomCode; const text = clean(msg.text, 300);
          if (!code || !text) break;
          const ts = now();
          void insertMessage(code, ws.user, text, ts).then((id) => {
            broadcast(code, { t: 'chat', id, userId: ws.user.id, name: ws.user.name, text, ts });
          }).catch((e) => { console.error('chat persistence failed:', e); send(ws, { t: 'error', code: 'chat_failed', message: 'Message could not be saved' }); });
          break;
        }
        case 'mute_self': {
          const lr = live.get(ws.roomCode); const me = lr && lr.members.get(ws.user.id);
          if (!me) break;
          me.muted = !!msg.muted;
          broadcast(ws.roomCode, { t: 'member_update', id: me.user.id, muted: me.muted });
          break;
        }
        case 'raise_hand': {
          const lr = live.get(ws.roomCode); const me = lr && lr.members.get(ws.user.id);
          if (!me) break;
          me.hand = !!msg.raised;
          broadcast(ws.roomCode, { t: 'member_update', id: me.user.id, hand: me.hand });
          break;
        }
        case 'react':
          if (ws.roomCode) broadcast(ws.roomCode, { t: 'react', id: ws.user.id, name: ws.user.name, emoji: clean(msg.emoji, 8) });
          break;
        case 'host': void handleHost(ws, msg).catch((e) => { console.error('host action failed:', e); send(ws, { t: 'error', code: 'host_failed', message: 'Host action failed' }); }); break;
        default: break;
      }
    } catch (e) {
      send(ws, { t: 'error', code: 'bad_message', message: 'Bad message' });
    }
  });
  ws.off('message', queueMessage);
  ws.on('close', () => { void leaveRoom(ws).catch((e) => console.error('room cleanup failed:', e)); });
  ws.on('error', () => { void leaveRoom(ws).catch((e) => console.error('room cleanup failed:', e)); });
  send(ws, { t: 'hello', user: publicUser(user) });
  queuedMessages.forEach(([data, isBinary]) => ws.emit('message', data, isBinary));
});

setInterval(() => {
  for (const [state, pending] of pendingYoutubeOAuth) if (pending.expiresAt < now()) pendingYoutubeOAuth.delete(state);
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);

server.listen(PORT, () => console.log(`UniqueStream Talk server listening on :${PORT}`));
