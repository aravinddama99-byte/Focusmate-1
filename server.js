// FocusMate friends server: Google sign-in check, unique 8-digit friend codes, shared XP/stats.
// No dependencies. Run: node server.js   (PORT, DATA_FILE, GOOGLE_CLIENT_ID are optional env vars)
const http = require('http'), https = require('https'), fs = require('fs'), crypto = require('crypto');
const PORT = process.env.PORT || 8788;
const DATA_FILE = process.env.DATA_FILE || './data.json';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';   // your Web client ID; when set, Google ID tokens are verified

let db = { users: {}, byEmail: {}, byCode: {}, byToken: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); dirty = false; } catch (e) {} } }, 3000);
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });

function newCode() {
  for (;;) {
    const c = String(crypto.randomInt(10000000, 100000000));   // 8 digits, never starts with 0
    if (!db.byCode[c]) return c;
  }
}
function verifyGoogle(idToken) {
  return new Promise((resolve) => {
    https.get('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), (r) => {
      let d = ''; r.on('data', (x) => d += x);
      r.on('end', () => { try { const j = JSON.parse(d); resolve(r.statusCode === 200 && j.aud === GOOGLE_CLIENT_ID && j.email ? j : null); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}
const pub = (u) => ({ id: u.code, code: u.code, name: u.name, username: u.username, ...u.profile, updatedAt: u.updatedAt });
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.round(v)) : null);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (x) => { d += x; if (d.length > 50000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
}
function authed(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const email = db.byToken[t];
  return email ? db.users[email] : null;
}
function friendsOf(u) { return (u.friends || []).map((c) => db.users[db.byCode[c]]).filter(Boolean).map(pub); }

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/') return send(res, 200, { ok: true, name: 'focusmate-friends' });
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const b = await body(req);

  if (req.url === '/auth') {
    let email = String(b.email || '').toLowerCase().trim(), name = String(b.name || '').trim();
    if (GOOGLE_CLIENT_ID) {
      const g = b.idToken ? await verifyGoogle(b.idToken) : null;
      if (!g) return send(res, 401, { error: 'Google sign-in could not be verified' });
      email = g.email.toLowerCase(); name = name || g.name || '';
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return send(res, 400, { error: 'Email required' });
    let u = db.users[email];
    if (!u) {
      u = db.users[email] = { email, name: name || email.split('@')[0], username: email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase(), code: newCode(), friends: [], profile: {}, updatedAt: Date.now() };
      db.byEmail[email] = email; db.byCode[u.code] = email;
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.byToken[token] = email; dirty = true;
    return send(res, 200, { token, code: u.code, friends: friendsOf(u) });
  }

  const u = authed(req);
  if (!u) return send(res, 401, { error: 'Please sign in again' });

  if (req.url === '/sync') {
    const p = b.profile || {};
    if (typeof p.name === 'string' && p.name.trim()) u.name = p.name.trim().slice(0, 40);
    if (typeof p.username === 'string' && p.username.trim()) u.username = p.username.trim().slice(0, 30);
    u.profile = {
      course: String(p.course || '').slice(0, 60),
      xp: num(p.xp), level: String(p.level || '').slice(0, 20), streak: num(p.streak),
      weeklyMin: num(p.weeklyMin), monthlyMin: num(p.monthlyMin), todayMin: num(p.todayMin),
      tasksDone: num(p.tasksDone), todayGoalMin: num(p.todayGoalMin), focusing: !!p.focusing,
    };
    u.updatedAt = Date.now(); dirty = true;
    return send(res, 200, { code: u.code, friends: friendsOf(u) });
  }
  if (req.url === '/connect') {
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length !== 8) return send(res, 400, { error: 'A friend code has 8 digits' });
    if (code === u.code) return send(res, 400, { error: "That's your own code" });
    const em = db.byCode[code];
    if (!em) return send(res, 404, { error: 'No one has that code' });
    const f = db.users[em];
    if ((u.friends || []).includes(code)) return send(res, 409, { error: 'Already friends' });
    u.friends = [...(u.friends || []), code];
    f.friends = [...(f.friends || []), u.code];
    dirty = true;
    return send(res, 200, { ok: true, friend: pub(f), friends: friendsOf(u) });
  }
  if (req.url === '/unfriend') {
    const code = String(b.code || '');
    const em = db.byCode[code];
    u.friends = (u.friends || []).filter((c) => c !== code);
    if (em) db.users[em].friends = (db.users[em].friends || []).filter((c) => c !== u.code);
    dirty = true;
    return send(res, 200, { ok: true, friends: friendsOf(u) });
  }
  return send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('FocusMate friends server on :' + PORT));
