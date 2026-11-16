// Verifies Google ID tokens locally (RS256 signature against Google's published keys). No dependencies.
const https = require('https'), http = require('http'), crypto = require('crypto');

const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let cache = { keys: {}, expires: 0 };

function getJson(url) {
  return new Promise((resolve, reject) => {
    (url.startsWith('http:') ? http : https).get(url, (r) => {
      let d = '';
      r.on('data', (x) => (d += x));
      r.on('end', () => {
        try {
          if (r.statusCode !== 200) return reject(new Error('certs http ' + r.statusCode));
          const m = /max-age=(\d+)/.exec(r.headers['cache-control'] || '');
          resolve({ json: JSON.parse(d), maxAge: m ? Number(m[1]) : 3600 });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function keyFor(kid) {
  if (Date.now() < cache.expires && cache.keys[kid]) return cache.keys[kid];
  const { json, maxAge } = await getJson(CERTS_URL);
  const keys = {};
  for (const jwk of json.keys || []) keys[jwk.kid] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  cache = { keys, expires: Date.now() + Math.max(60, maxAge) * 1000 };
  return keys[kid] || null;
}

const b64 = (s) => Buffer.from(s, 'base64url');

/**
 * Returns { sub, email, name, picture } for a valid Google ID token, otherwise null.
 * `audiences` is the list of accepted OAuth client IDs (your Web client ID).
 */
async function verifyGoogleIdToken(idToken, audiences) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64(parts[0]).toString());
    if (header.alg !== 'RS256' || !header.kid) return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(key, b64(parts[2]));
    if (!ok) return null;
    const c = JSON.parse(b64(parts[1]).toString());
    const now = Math.floor(Date.now() / 1000);
    if (!ISSUERS.includes(c.iss)) return null;
    if (!audiences.includes(c.aud)) return null;
    if (!(c.exp > now - 60) || (c.iat && c.iat > now + 300)) return null;
    if (!c.sub || !c.email || !(c.email_verified === true || c.email_verified === 'true')) return null;
    return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: c.name || '', picture: c.picture || '' };
  } catch (e) {
    return null;
  }
}

module.exports = { verifyGoogleIdToken };
