/**
 * Passwordless email auth — send a 6-digit code, verify it, issue a signed
 * session cookie. Ported from the birdle Flask project.
 *
 * Session: HMAC-signed stateless cookie. No DB table for sessions.
 *   cookie format: "<userId>.<expEpoch>.<hmac>"
 *
 * Email: Gmail REST API with OAuth2 refresh token. Falls back to printing
 * the code in the console when GMAIL_* env vars aren't set (dev mode).
 *
 * Env vars (see .env.example):
 *   SESSION_SECRET       — HMAC key for signing session cookies
 *   GMAIL_CLIENT_ID      — OAuth client ID for Gmail API
 *   GMAIL_CLIENT_SECRET  — OAuth client secret
 *   GMAIL_REFRESH_TOKEN  — long-lived refresh token
 *   GMAIL_SENDER         — from-address on outgoing mail
 */

import crypto from 'crypto';
import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bootstrapTeamForUser } from './teams.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Tiny .env loader. Stdlib only — no dotenv dep.
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip wrapping quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ------ tuning ------

const CODE_EXPIRY_MINUTES = 10;
const MAX_CODES_PER_WINDOW = 3;
const SESSION_TTL_DAYS = 30;

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s === 'dev-insecure-change-me') {
    console.warn('[auth] WARNING: SESSION_SECRET not set; using an insecure dev default');
    return 'dev-insecure-change-me';
  }
  return s;
}

// ------ helpers ------

function nowSqlite() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
}
function minutesAgoSqlite(m) {
  return new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').replace(/\..+$/, '');
}
function minutesFromNowSqlite(m) {
  return new Date(Date.now() + m * 60_000).toISOString().replace('T', ' ').replace(/\..+$/, '');
}

// ------ signed-cookie session ------

export function makeSessionCookie(userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifySessionCookie(cookie) {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [userIdStr, expStr, sig] = parts;
  const payload = `${userIdStr}.${expStr}`;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  // constant-time compare
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  if (Math.floor(Date.now() / 1000) > Number(expStr)) return null;
  return { userId: Number(userIdStr) };
}

// ------ DB-backed code issue + verify ------

export function sendCode(db, email) {
  email = (email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { status: 400, body: { error: 'Valid email required' } };
  }

  const windowStart = minutesAgoSqlite(CODE_EXPIRY_MINUTES);
  const count = db
    .prepare('SELECT COUNT(*) AS c FROM auth_code WHERE email = ? AND created_at > ?')
    .get(email, windowStart).c;
  if (count >= MAX_CODES_PER_WINDOW) {
    return { status: 429, body: { error: 'Too many requests. Try again in a few minutes.' } };
  }

  db.prepare('DELETE FROM auth_code WHERE expires_at < ?').run(minutesAgoSqlite(60));

  const code = String(crypto.randomInt(100000, 1_000_000));
  const expiresAt = minutesFromNowSqlite(CODE_EXPIRY_MINUTES);
  db.prepare('INSERT INTO auth_code (email, code, expires_at) VALUES (?, ?, ?)').run(email, code, expiresAt);

  // Send email — fire-and-forget but catch errors so we can report them
  return sendGmailCode(email, code).then(
    () => ({ status: 200, body: { ok: true } }),
    (e) => {
      console.error('[auth] email send failed:', e.message);
      // In dev we already logged the code to the console, so still OK
      if (isDev()) return { status: 200, body: { ok: true, dev_code_logged: true } };
      return { status: 500, body: { error: 'Failed to send code. Please try again.' } };
    }
  );
}

export function verifyCode(db, email, code) {
  email = (email || '').trim().toLowerCase();
  code = (code || '').trim();
  if (!email || !code) {
    return { status: 400, body: { error: 'Email and code required' } };
  }

  const now = nowSqlite();
  const row = db
    .prepare('SELECT id FROM auth_code WHERE email = ? AND code = ? AND used = 0 AND expires_at > ? LIMIT 1')
    .get(email, code, now);
  if (!row) {
    return { status: 401, body: { error: 'Invalid or expired code' } };
  }

  db.prepare('UPDATE auth_code SET used = 1 WHERE id = ?').run(row.id);

  let user = db.prepare('SELECT id, email, username FROM user_account WHERE email = ?').get(email);
  if (!user) {
    const r = db.prepare('INSERT INTO user_account (email) VALUES (?)').run(email);
    user = { id: r.lastInsertRowid, email, username: null };
  }

  return {
    status: 200,
    body: {
      ok: true,
      user: { username: user.username },
      needs_username: !user.username,
    },
    cookie: makeSessionCookie(user.id),
  };
}

export function setUsername(db, userId, username) {
  username = (username || '').trim();
  // 3-20 chars, alphanumeric + underscore
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return { status: 400, body: { error: 'Username must be 3–20 characters, letters/numbers/underscore only' } };
  }
  // Case-insensitive uniqueness (index enforces, but give a nicer error)
  const clash = db
    .prepare('SELECT id FROM user_account WHERE lower(username) = lower(?) AND id != ?')
    .get(username, userId);
  if (clash) {
    return { status: 409, body: { error: 'That username is taken' } };
  }

  // Setting username completes signup → create team + 5 starter fighters in
  // the same transaction so we never have a half-setup user.
  let teamId;
  try {
    const txn = db.transaction(() => {
      db.prepare('UPDATE user_account SET username = ? WHERE id = ?').run(username, userId);
      teamId = bootstrapTeamForUser(db, userId, username + "'s Team");
    });
    txn();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return { status: 409, body: { error: 'That username is taken' } };
    }
    throw e;
  }
  return { status: 200, body: { ok: true, username, team_id: teamId } };
}

export function currentUser(db, req) {
  const raw = parseCookies(req.headers.cookie || '')['mb_session'];
  const sess = verifySessionCookie(raw);
  if (!sess) return null;
  return db.prepare('SELECT id, email, username FROM user_account WHERE id = ?').get(sess.userId) || null;
}

// ------ cookie helpers ------

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    out[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
  }
  return out;
}

export function sessionCookieHeader(value, { clear = false } = {}) {
  const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  if (clear) {
    return `mb_session=; ${attrs.join('; ')}; Max-Age=0`;
  }
  attrs.push(`Max-Age=${SESSION_TTL_DAYS * 86400}`);
  return `mb_session=${value}; ${attrs.join('; ')}`;
}

// ------ Gmail OAuth2 send ------

function isDev() {
  return process.env.NODE_ENV !== 'production';
}

function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getGmailToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  const data = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return JSON.parse(data).access_token;
}

export async function sendGmailCode(email, code) {
  const token = await getGmailToken();
  if (!token) {
    if (isDev()) {
      console.log(`[auth DEV] Login code for ${email}: ${code}`);
      return;
    }
    throw new Error('Gmail OAuth credentials not configured');
  }

  const sender = process.env.GMAIL_SENDER || 'noreply@mugenbattle.local';
  const subject = `MugenBattle login code: ${code}`;
  const body = [
    `Your MugenBattle login code is: ${code}`,
    '',
    'This code expires in 10 minutes.',
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\r\n');
  const mime = [
    `From: ${sender}`,
    `To: ${email}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');

  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = JSON.stringify({ raw });

  await httpsRequest({
    hostname: 'gmail.googleapis.com',
    path: '/gmail/v1/users/me/messages/send',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);

  if (isDev()) console.log(`[auth] Login code sent to ${email} via Gmail`);
}
