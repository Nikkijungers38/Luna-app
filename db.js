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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY,
      profile JSONB,
      history JSONB NOT NULL DEFAULT '[]'::jsonb,
      chat_times JSONB NOT NULL DEFAULT '[]'::jsonb,
      trial_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      paid_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      sub_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      sub JSONB NOT NULL DEFAULT '{"active":false,"customerId":null,"subscriptionId":null}'::jsonb,
      last_tick BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// pg returns BIGINT as a string, so last_tick is converted back to a number.
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
    lastTick: row.last_tick == null ? null : Number(row.last_tick),
    chatTimes: row.chat_times ?? [],
  };
}

async function getUser(pool, uid) {
  const { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
  return rows.length ? rowToUser(rows[0]) : null;
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
  createUser,
  saveUser,
  clearLastTick,
  deductTick,
  grantPaid,
  setSubscription,
  findUserByCustomer,
  addEvent,
};
