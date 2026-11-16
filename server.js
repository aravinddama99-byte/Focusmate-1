// FocusMate server: verifies Google sign-in, stores each user's data in PostgreSQL, friend codes and shared XP.
// Env: DATABASE_URL (required), GOOGLE_CLIENT_ID (required, your Web client ID; comma-separate several),
//      PORT, ALLOWED_DOMAINS="cuchd.in,cumail.in", ALLOWED_EMAILS="a@x.com,b@y.com"  (if both are empty, any Google account may sign in)
const http = require('http');
const db = require('./db');
const { verifyGoogleIdToken } = require('./google');

const PORT = process.env.PORT || 8788;
const list = (v) => (process.env[v] || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const AUDIENCES = (process.env.GOOGLE_CLIENT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
const ALLOWED_DOMAINS = list('ALLOWED_DOMAINS'), ALLOWED_EMAILS = list('ALLOWED_EMAILS');
const allowed = (email) => (!ALLOWED_DOMAINS.length && !ALLOWED_EMAILS.length) || ALLOWED_EMAILS.includes(email) || ALLOWED_DOMAINS.includes(email.split('@')[1]);

if (!AUDIENCES.length) {
  console.error('GOOGLE_CLIENT_ID is not set. Without it anyone could pretend to be any user, so the server will not start.');
  process.exit(1);
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : null);
const MAX_BODY = 4 * 1024 * 1024;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let d = '', big = false;
    req.on('data', (x) => { if (big) return; d += x; if (d.length > MAX_BODY) { big = true; d = ''; } });
    req.on('end', () => { if (big) return resolve(null); try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/') {
    let ok = true; try { await db.ping(); } catch (e) { ok = false; }
    return send(res, ok ? 200 : 503, { ok, name: 'focusmate', db: ok });
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const b = await body(req);
  if (b === null) return send(res, 413, { error: 'Too much data' });

  if (req.url === '/auth') {
    const g = await verifyGoogleIdToken(b.idToken, AUDIENCES);
    if (!g) return send(res, 401, { error: 'Google sign-in could not be verified' });
    if (!allowed(g.email)) return send(res, 403, { error: 'FocusMate is only for CU students. Please sign in with your CU email.' });
    const u = await db.upsertUser(g);
    const token = await db.createSession(u.id);
    return send(res, 200, { token, code: u.friend_code, user: { name: u.name, email: u.email, picture: u.picture }, friends: await db.friendsOf(u.id) });
  }

  const token = bearer(req);
  const u = await db.userForToken(token);
  if (!u) return send(res, 401, { error: 'Please sign in again' });

  switch (req.url) {
    case '/logout':
      await db.deleteSession(token);
      return send(res, 200, { ok: true });

    case '/sync': {
      const p = b.profile || {};
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : null;
      const username = typeof p.username === 'string' && p.username.trim() ? p.username.trim().slice(0, 30) : null;
      await db.saveProfile(u.id, name, username, {
        course: String(p.course || '').slice(0, 60),
        xp: num(p.xp), level: String(p.level || '').slice(0, 20), streak: num(p.streak),
        weeklyMin: num(p.weeklyMin), monthlyMin: num(p.monthlyMin), todayMin: num(p.todayMin),
        tasksDone: num(p.tasksDone), todayGoalMin: num(p.todayGoalMin), focusing: !!p.focusing,
      });
      return send(res, 200, { code: u.friend_code, friends: await db.friendsOf(u.id) });
    }

    case '/connect': {
      const code = String(b.code || '').replace(/\D/g, '');
      if (code.length !== 8) return send(res, 400, { error: 'A friend code has 8 digits' });
      if (code === u.friend_code) return send(res, 400, { error: "That's your own code" });
      const f = await db.userByCode(code);
      if (!f) return send(res, 404, { error: 'No one has that code' });
      if (await db.isFriend(u.id, f.id)) return send(res, 409, { error: 'Already friends' });
      await db.connect(u.id, f.id);
      return send(res, 200, { ok: true, friend: await db.publicFriend(f.id), friends: await db.friendsOf(u.id) });
    }

    case '/unfriend': {
      const f = await db.userByCode(String(b.code || ''));
      if (f) await db.unfriend(u.id, f.id);
      return send(res, 200, { ok: true, friends: await db.friendsOf(u.id) });
    }

    // Everything the app keeps (tasks, sessions, XP, settings, chat...) saved to this Google account.
    case '/state/load':
      return send(res, 200, (await db.loadDoc('app_state', u.id)) || { data: null, updatedAt: 0 });
    case '/state/save': {
      const d = b.data;
      if (!d || typeof d !== 'object' || Array.isArray(d)) return send(res, 400, { error: 'Bad data' });
      const r = await db.saveDoc('app_state', u.id, d, b.base, !!b.force);
      return send(res, r.ok ? 200 : 409, r.ok ? { ok: true, updatedAt: r.updatedAt } : { error: 'Newer data exists', updatedAt: r.updatedAt });
    }

    // Academics (attendance, timetable): last write wins, the app compares its own timestamps.
    case '/acad/save': {
      const d = b.data;
      if (!d || typeof d !== 'object' || !Array.isArray(d.subjects)) return send(res, 400, { error: 'Bad data' });
      await db.saveDoc('academics', u.id, d, 0, true);
      return send(res, 200, { ok: true });
    }
    case '/acad/load': {
      const r = await db.loadDoc('academics', u.id);
      return send(res, 200, { data: r ? r.data : null });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

db.init().then(() => {
  http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(req.url, e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  }).listen(PORT, () => console.log('FocusMate server on :' + PORT));
}).catch((e) => { console.error('Could not start (database?):', e.message); process.exit(1); });
