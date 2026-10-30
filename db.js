// Postgres data layer for Luna.
//
// All reads/writes go through the injected pool so this module is testable
// without a live database (see test/db.test.js, which uses pg-mem).
// Seconds columns are DOUBLE PRECISION, not INT: the old JSON store deducted
// fractional seconds on every tick (elapsed ms / 1000, capped at 15s), so an
// INT column would round and change billing. Money-critical seconds changes
// (tick deductions, webhook/checkout grants) are single atomic UPDATE
// statements; saveUser() deliberately never writes the seconds columns, so a
// stale in-memory copy cannot overwrite a grant that landed in between.

const { Pool } = require('pg');

// Stripe webhook event ids are kept for dedup, capped at the most recent N.
const MAX_EVENTS = 500;

// Neon requires SSL. rejectUnauthorized:false is what Neon documents for
// server-side drivers connecting to its pooled/direct endpoints.
function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Set it to your Postgres connection string ' +
      '(on Render: Luna-app service -> Environment -> Add Environment Variable). ' +
      'Refusing to start without a database.'
    );
  }
  return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function initDb(pool) {
  // pg-mem (the test emulator) cannot run CREATE TABLE IF NOT EXISTS against
  // a table that already exists, so creation is guarded by an existence
  // check instead. Real Postgres would treat IF NOT EXISTS as a no-op, but
  // the check works identically there and keeps the tests honest.
  const found = await pool.query(
    'SELECT table_name FROM information_schema.tables WHERE table_name IN ($1, $2, $3)',
    ['users', 'events', 'password_resets']);
  const have = new Set(found.rows.map((r) => r.table_name));
  if (!have.has('users')) {
    await pool.query(`
      CREATE TABLE users (
        uid TEXT PRIMARY KEY,
        profile JSONB,
        history JSONB NOT NULL DEFAULT '[]'::jsonb,
        chat_times JSONB NOT NULL DEFAULT '[]'::jsonb,
        trial_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        paid_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        sub_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        sub JSONB NOT NULL DEFAULT '{"active":false,"customerId":null,"subscriptionId":null}'::jsonb,
        email TEXT,
        password_hash TEXT,
        last_tick BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  if (!have.has('events')) {
    await pool.query(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        seq BIGSERIAL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  if (!have.has('password_resets')) {
    await pool.query(`
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  // Migration for databases created before accounts existed: add the account
  // columns if they are missing. IF NOT EXISTS keeps this safe to run on
  // every start, and existing rows (and their minutes) are untouched.
  // The unique index allows many NULL emails (cookie-only users) while
  // rejecting a second account with the same email.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
  `);
}

// pg returns BIGINT as a string, so last_tick is converted back to a number.
// password_hash is deliberately NOT included here: it must never be
// serialized to a client. Auth flows that need it use getAccountByEmail().
function rowToUser(row) {
  return {
    id: row.uid,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    profile: row.profile ?? null,
    history: row.history ?? [],
    trialSeconds: row.trial_seconds ?? 0,
    paidSeconds: row.paid_seconds ?? 0,
    subSeconds: row.sub_seconds ?? 0,
    sub: row.sub ?? { active: false, customerId: null, subscriptionId: null },
    email: row.email ?? null,
    lastTick: row.last_tick == null ? null : Number(row.last_tick),
    chatTimes: row.chat_times ?? [],
  };
}

// Emails are stored and looked up lowercase + trimmed, so
// "User@Example.com" and "user@example.com" are the same account.
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const cleaned = email.trim().toLowerCase();
  return cleaned || null;
}

async function getUser(pool, uid) {
  const { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
  return rows.length ? rowToUser(rows[0]) : null;
}

async function getUserByEmail(pool, email) {
  const cleaned = normalizeEmail(email);
  if (!cleaned) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [cleaned]);
  return rows.length ? rowToUser(rows[0]) : null;
}

// Auth-only lookup: returns the user plus the bcrypt hash for verification.
// The hash must never leave the server (never put it in an API response).
async function getAccountByEmail(pool, email) {
  const cleaned = normalizeEmail(email);
  if (!cleaned) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [cleaned]);
  if (!rows.length) return null;
  return { user: rowToUser(rows[0]), passwordHash: rows[0].password_hash };
}

// Turns a cookie user row into an account by attaching an email + bcrypt
// hash. Returns { ok: true } or { ok: false, reason } where reason is
// 'email_taken' (another row already owns the email) or 'not_found'.
async function setAccount(pool, uid, email, passwordHash) {
  const cleaned = normalizeEmail(email);
  if (!cleaned) return { ok: false, reason: 'invalid_email' };
  const clash = await pool.query(
    'SELECT 1 FROM users WHERE email = $1 AND uid <> $2', [cleaned, uid]);
  if (clash.rows.length) return { ok: false, reason: 'email_taken' };
  try {
    const { rowCount } = await pool.query(
      'UPDATE users SET email = $2, password_hash = $3 WHERE uid = $1',
      [uid, cleaned, passwordHash]);
    if (!rowCount) return { ok: false, reason: 'not_found' };
  } catch (err) {
    if (err.code === '23505') return { ok: false, reason: 'email_taken' };
    throw err;
  }
  return { ok: true };
}

async function setPassword(pool, uid, passwordHash) {
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $2 WHERE uid = $1', [uid, passwordHash]);
  return rowCount > 0;
}

// Merges a cookie user into an account row, so nothing is lost when someone
// signs in: trial + paid + subscription seconds are added to the account,
// the subscription object moves over when the account has none active, and
// the profile/chat history move over when the account has none. The cookie
// row is then deleted and the session switches to the account.
// A brand-new cookie row (fresh trial, no profile, no history, no payments)
// contributes nothing, so it is just deleted — this stops a fresh 180-second
// trial from being added to the account on every new-device sign-in.
// SAFETY: if the "cookie" row already has an email it is a real account, not
// a cookie user, so it is never merged and never deleted.
// Runs in one transaction; returns the updated account user, or null when
// the account row is missing.
async function mergeCookieIntoAccount(pool, cookieUid, accountUid, freshTrialSeconds) {
  if (cookieUid === accountUid) return getUser(pool, accountUid);
  const cookie = await getUser(pool, cookieUid);
  if (!cookie) return getUser(pool, accountUid);
  if (cookie.email != null) return getUser(pool, accountUid);
  const account = await getUser(pool, accountUid);
  if (!account) return null;
  const isFresh = cookie.profile == null && cookie.history.length === 0 &&
    cookie.chatTimes.length === 0 && cookie.trialSeconds === freshTrialSeconds &&
    cookie.paidSeconds === 0 && cookie.subSeconds === 0 && !cookie.sub.active;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!isFresh) {
      await client.query(
        `UPDATE users SET
           trial_seconds = trial_seconds + COALESCE((SELECT trial_seconds FROM users WHERE uid = $2), 0),
           paid_seconds = paid_seconds + COALESCE((SELECT paid_seconds FROM users WHERE uid = $2), 0),
           sub_seconds = sub_seconds + COALESCE((SELECT sub_seconds FROM users WHERE uid = $2), 0)
         WHERE uid = $1`,
        [accountUid, cookieUid]);
      if (!account.sub.active && cookie.sub.active) {
        await client.query(
          'UPDATE users SET sub = (SELECT sub FROM users WHERE uid = $2) WHERE uid = $1',
          [accountUid, cookieUid]);
      }
      if (account.profile == null && cookie.profile != null) {
        await client.query(
          `UPDATE users SET profile = (SELECT profile FROM users WHERE uid = $2),
             history = (SELECT history FROM users WHERE uid = $2),
             chat_times = (SELECT chat_times FROM users WHERE uid = $2)
           WHERE uid = $1`,
          [accountUid, cookieUid]);
      }
    }
    await client.query('DELETE FROM users WHERE uid = $1', [cookieUid]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getUser(pool, accountUid);
}

// Password-reset tokens: only the SHA-256 hash of the token is stored, so a
// database read can never be turned into a working reset link. Tokens are
// single-use (used flag, flipped atomically) and expire after 15 minutes
// (the expiry timestamp is set by the caller).
async function createPasswordReset(pool, email, tokenHash, expiresAt) {
  const cleaned = normalizeEmail(email);
  await pool.query(
    'INSERT INTO password_resets (token_hash, email, expires_at) VALUES ($1, $2, $3)',
    [tokenHash, cleaned, expiresAt]);
}

async function getPasswordReset(pool, tokenHash) {
  const { rows } = await pool.query(
    'SELECT * FROM password_resets WHERE token_hash = $1', [tokenHash]);
  if (!rows.length) return null;
  return {
    tokenHash: rows[0].token_hash,
    email: rows[0].email,
    expiresAt: rows[0].expires_at,
    used: rows[0].used,
  };
}

// Atomically marks a token used. Returns true only for the caller that won
// the race; a second attempt (replayed link) gets false.
async function usePasswordReset(pool, tokenHash) {
  const { rowCount } = await pool.query(
    'UPDATE password_resets SET used = true WHERE token_hash = $1 AND used = false',
    [tokenHash]);
  return rowCount > 0;
}

async function invalidatePasswordResetsForEmail(pool, email) {
  const cleaned = normalizeEmail(email);
  await pool.query(
    'UPDATE password_resets SET used = true WHERE email = $1 AND used = false',
    [cleaned]);
}

// Shared validity check for a reset token row: present, unused, unexpired.
function isResetTokenValid(row, now = Date.now()) {
  if (!row || row.used) return false;
  return new Date(row.expiresAt).getTime() > now;
}

async function createUser(pool, user) {
  await pool.query(
    `INSERT INTO users (uid, profile, history, chat_times, trial_seconds, paid_seconds,
       sub_seconds, sub, last_tick, created_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      user.id,
      JSON.stringify(user.profile),
      JSON.stringify(user.history),
      JSON.stringify(user.chatTimes),
      user.trialSeconds,
      user.paidSeconds,
      user.subSeconds,
      JSON.stringify(user.sub),
      user.lastTick,
      new Date(user.createdAt),
    ]
  );
}

// Persists profile/history/chatTimes only. Seconds are written exclusively by
// the atomic statements below, and last_tick exclusively by deductTick() /
// clearLastTick(), so a stale copy can never rewind them.
async function saveUser(pool, user) {
  await pool.query(
    `UPDATE users SET profile = $2::jsonb, history = $3::jsonb, chat_times = $4::jsonb
     WHERE uid = $1`,
    [
      user.id,
      JSON.stringify(user.profile),
      JSON.stringify(user.history),
      JSON.stringify(user.chatTimes),
    ]
  );
}

async function clearLastTick(pool, uid) {
  await pool.query('UPDATE users SET last_tick = NULL WHERE uid = $1', [uid]);
}

// The old tick(): bill elapsed time since the last tick, capped so idle gaps
// are never charged (only gaps under 30s bill, at most 15s), in the order
// free trial, subscription allowance, purchased credits. All SET expressions
// read the old row, so the nested LEAST/GREATEST chain deducts in that order
// in a single atomic UPDATE. The in-memory user is synced from RETURNING.
// NOTE: pg-mem (the test emulator) miscomputes LEAST for fractional inputs
// (LEAST(180.0, 10.5) returns 11 there); real Postgres returns 10.5. The
// fractional-seconds test is therefore skipped under pg-mem and must be
// verified against real Postgres at deploy time (see test/db.test.js).
async function deductTick(pool, user, now) {
  let seconds = 0;
  if (user.lastTick && now - user.lastTick < 30000) {
    seconds = Math.min((now - user.lastTick) / 1000, 15);
  }
  const { rows } = await pool.query(
    `UPDATE users SET
       trial_seconds = trial_seconds - LEAST(trial_seconds, $2::double precision),
       sub_seconds = sub_seconds - LEAST(sub_seconds, GREATEST($2::double precision - LEAST(trial_seconds, $2::double precision), 0)),
       paid_seconds = paid_seconds - LEAST(paid_seconds, GREATEST($2::double precision - LEAST(trial_seconds, $2::double precision) - LEAST(sub_seconds, GREATEST($2::double precision - LEAST(trial_seconds, $2::double precision), 0)), 0)),
       last_tick = $3::bigint
     WHERE uid = $1
     RETURNING trial_seconds, sub_seconds, paid_seconds`,
    [user.id, seconds, now]
  );
  if (rows.length) {
    user.trialSeconds = rows[0].trial_seconds;
    user.subSeconds = rows[0].sub_seconds;
    user.paidSeconds = rows[0].paid_seconds;
  }
  user.lastTick = now;
  return user;
}

// Atomic credit grant (minute packs, via webhook or dev checkout).
// Returns the new paid_seconds, or null if the user row is missing.
async function grantPaid(pool, uid, seconds) {
  const { rows } = await pool.query(
    'UPDATE users SET paid_seconds = paid_seconds + $2 WHERE uid = $1 RETURNING paid_seconds',
    [uid, seconds]
  );
  return rows.length ? rows[0].paid_seconds : null;
}

// Atomic subscription write: sub object + allowance in one UPDATE.
// Callers pass the full sub object (e.g. {...oldSub, active: true}).
async function setSubscription(pool, uid, sub, subSeconds) {
  await pool.query(
    'UPDATE users SET sub = $2::jsonb, sub_seconds = $3 WHERE uid = $1',
    [uid, JSON.stringify(sub), subSeconds]
  );
}

async function findUserByCustomer(pool, customerId) {
  const { rows } = await pool.query(
    "SELECT * FROM users WHERE sub ->> 'customerId' = $1 LIMIT 1",
    [customerId]
  );
  return rows.length ? rowToUser(rows[0]) : null;
}

// Records a Stripe event id for webhook dedup. Returns false when the id was
// already seen (duplicate: caller must ignore the event); on a new id it
// prunes the table back to the most recent maxEvents rows. seq (insertion
// order) is the prune key, since created_at ties are possible.
// The SELECT fast-path exists because pg-mem (used in tests) does not
// emulate ON CONFLICT ... RETURNING correctly — it reports a row even on
// conflict. In production the INSERT ... ON CONFLICT ... RETURNING check is
// still the atomic guard: a webhook that loses a race with an identical
// event gets zero rows back and is treated as a duplicate.
async function addEvent(pool, eventId, maxEvents = MAX_EVENTS) {
  const existing = await pool.query('SELECT 1 FROM events WHERE event_id = $1', [eventId]);
  if (existing.rows.length) return false;
  const { rows } = await pool.query(
    'INSERT INTO events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
    [eventId]
  );
  if (!rows.length) return false;
  await pool.query(
    'DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT $1)',
    [maxEvents]
  );
  return true;
}

module.exports = {
  MAX_EVENTS,
  createPool,
  initDb,
  getUser,
  getUserByEmail,
  getAccountByEmail,
  setAccount,
  setPassword,
  mergeCookieIntoAccount,
  createPasswordReset,
  getPasswordReset,
  usePasswordReset,
  invalidatePasswordResetsForEmail,
  isResetTokenValid,
  normalizeEmail,
  createUser,
  saveUser,
  clearLastTick,
  deductTick,
  grantPaid,
  setSubscription,
  findUserByCustomer,
  addEvent,
};
