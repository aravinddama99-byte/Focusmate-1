// PostgreSQL storage for FocusMate. Set DATABASE_URL (Neon, Supabase, Render Postgres, or your own).
// All timestamps are bigint milliseconds since epoch.
const crypto = require('crypto');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Create a free Postgres database (see SETUP.md) and set DATABASE_URL.');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
pool.on('error', (e) => console.error('db pool error', e.message));

const SESSION_DAYS = 90;
const DAY = 86400000;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  google_sub    TEXT   NOT NULL UNIQUE,
  email         TEXT   NOT NULL,
  name          TEXT   NOT NULL DEFAULT '',
  picture       TEXT   NOT NULL DEFAULT '',
  username      TEXT   NOT NULL DEFAULT '',
  friend_code   CHAR(8) NOT NULL UNIQUE,
  created_at    BIGINT NOT NULL,
  last_login_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS profiles (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB  NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS app_state (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB  NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS academics (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB  NOT NULL,
  updated_at BIGINT NOT NULL
);`;

async function init() {
  await q(SCHEMA);
  await q('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
}

const newCode = () => String(crypto.randomInt(10000000, 100000000)); // 8 digits, never starts with 0

/** Create the user on first Google sign-in, otherwise refresh email/picture. Keyed by Google's stable `sub`. */
async function upsertUser(g) {
  const now = Date.now();
  const username = g.email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase();
  for (let i = 0; i < 8; i++) {
    try {
      const r = await q(
        `INSERT INTO users (google_sub, email, name, picture, username, friend_code, created_at, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, picture = EXCLUDED.picture, last_login_at = EXCLUDED.last_login_at
         RETURNING id, email, name, picture, username, friend_code`,
        [g.sub, g.email, (g.name || username).slice(0, 40), g.picture || '', username, newCode(), now]);
      return r.rows[0];
    } catch (e) {
      if (e.code === '23505' && /friend_code/.test(e.constraint || e.detail || '')) continue; // code collision: retry
      throw e;
    }
  }
  throw new Error('could not allocate a friend code');
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  await q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)', [sha(token), userId, now, now + SESSION_DAYS * DAY]);
  return token;
}

/** Look up the user behind a bearer token; extends the session when it is more than a month old. */
async function userForToken(token) {
  if (!token) return null;
  const h = sha(token), now = Date.now();
  const r = await q(
    `SELECT u.id, u.email, u.name, u.picture, u.username, u.friend_code, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > $2`, [h, now]);
  const u = r.rows[0];
  if (!u) return null;
  if (Number(u.expires_at) - now < (SESSION_DAYS - 30) * DAY) await q('UPDATE sessions SET expires_at = $2 WHERE token_hash = $1', [h, now + SESSION_DAYS * DAY]);
  return u;
}
const deleteSession = (token) => q('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);

const friendRow = (r) => ({ id: r.friend_code, code: r.friend_code, name: r.name, username: r.username, ...(r.data || {}), updatedAt: Number(r.updated_at || 0) });
async function friendsOf(userId) {
  const r = await q(
    `SELECT u.friend_code, u.name, u.username, p.data, p.updated_at
       FROM friendships f JOIN users u ON u.id = f.friend_id LEFT JOIN profiles p ON p.user_id = u.id
      WHERE f.user_id = $1 ORDER BY f.created_at`, [userId]);
  return r.rows.map(friendRow);
}

async function saveProfile(userId, name, username, profile) {
  const now = Date.now();
  await q('UPDATE users SET name = COALESCE($2, name), username = COALESCE($3, username) WHERE id = $1', [userId, name, username]);
  await q(`INSERT INTO profiles (user_id, data, updated_at) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`, [userId, JSON.stringify(profile), now]);
}

async function userByCode(code) {
  const r = await q('SELECT id, friend_code, name, username FROM users WHERE friend_code = $1', [code]);
  return r.rows[0] || null;
}
async function isFriend(userId, friendId) {
  return (await q('SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2', [userId, friendId])).rowCount > 0;
}
async function connect(a, b) {
  const now = Date.now();
  await q(`INSERT INTO friendships (user_id, friend_id, created_at) VALUES ($1,$2,$3),($2,$1,$3) ON CONFLICT DO NOTHING`, [a, b, now]);
}
async function unfriend(a, b) {
  await q('DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [a, b]);
}
async function publicFriend(userId) {
  const r = await q(
    `SELECT u.friend_code, u.name, u.username, p.data, p.updated_at FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]);
  return r.rows[0] ? friendRow(r.rows[0]) : null;
}

// ---- JSON documents saved per user (full app state, academics) ----
const DOC_TABLES = { app_state: 'app_state', academics: 'academics' };
async function loadDoc(table, userId) {
  const r = await q(`SELECT data, updated_at FROM ${DOC_TABLES[table]} WHERE user_id = $1`, [userId]);
  return r.rows[0] ? { data: r.rows[0].data, updatedAt: Number(r.rows[0].updated_at) } : null;
}
/**
 * Optimistic save. `base` is the version the client last saw (0 = it has seen nothing).
 * Returns { ok:true, updatedAt } or { ok:false, updatedAt: <server's current version> }.
 */
async function saveDoc(table, userId, data, base, force) {
  const t = DOC_TABLES[table], now = Date.now(), json = JSON.stringify(data);
  const guard = force ? '' : 'WHERE ' + t + '.updated_at = $4';
  const params = force ? [userId, json, now] : [userId, json, now, Number(base) || 0];
  const r = await q(
    `INSERT INTO ${t} (user_id, data, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = GREATEST(EXCLUDED.updated_at, ${t}.updated_at + 1) ${guard}
     RETURNING updated_at`, params);
  if (r.rows[0]) return { ok: true, updatedAt: Number(r.rows[0].updated_at) };
  const cur = await q(`SELECT updated_at FROM ${t} WHERE user_id = $1`, [userId]);
  return { ok: false, updatedAt: cur.rows[0] ? Number(cur.rows[0].updated_at) : 0 };
}

module.exports = { init, upsertUser, createSession, userForToken, deleteSession, friendsOf, saveProfile, userByCode, isFriend, connect, unfriend, publicFriend, loadDoc, saveDoc, ping: () => q('SELECT 1') };
