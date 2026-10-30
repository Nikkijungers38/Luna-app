// Tests for Luna accounts (email + password) and password resets.
//
// Same pattern as test/db.test.js: pg-mem in-memory Postgres, no live
// database or credential needed. Run: npm test
// What is covered:
//   1. registration: email stored normalized, bcrypt hash stored (never the
//      plain password), duplicate email rejected, cookie rows unaffected
//   2. login verification: correct password verifies, wrong password fails,
//      unknown email fails (hash never returned to callers)
//   3. password resets: token stored hashed only, single-use enforced,
//      expired tokens invalid, unknown tokens invalid
//   4. linking/merging: cookie minutes + profile move into the account,
//      fresh cookie rows contribute nothing, account rows are never merged
//      or deleted, same-uid merge is a no-op
//   5. rate limiter: blocks after the max, resets on success, window expiry
//   6. email sender: missing RESEND_API_KEY fails gracefully, no throw
//
// bcrypt cost 4 is used here so the suite stays fast; production uses 12.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { newDb } = require('pg-mem');
const db = require('../db');
const { createLimiter } = require('../login-limits');
const { sendEmail } = require('../email');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function makePool() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

function newTestUser(id, overrides = {}) {
  return {
    id, createdAt: Date.now(), profile: null, history: [],
    trialSeconds: 180, paidSeconds: 0, subSeconds: 0,
    sub: { active: false, customerId: null, subscriptionId: null },
    lastTick: null, chatTimes: [], ...overrides,
  };
}

test('registration stores a normalized email and a bcrypt hash, never plain', async () => {
  const pool = makePool();
  await db.initDb(pool);
  const u = newTestUser('u1');
  await db.createUser(pool, u);
  const hash = await bcrypt.hash('correct horse', 4);
  const result = await db.setAccount(pool, 'u1', '  User@Example.COM ', hash);
  assert.deepEqual(result, { ok: true });
  const got = await db.getUser(pool, 'u1');
  assert.equal(got.email, 'user@example.com');
  const account = await db.getAccountByEmail(pool, 'USER@example.com');
  assert.equal(account.user.id, 'u1');
  assert.ok(account.passwordHash.startsWith('$2b$'));
  assert.notEqual(account.passwordHash, 'correct horse');
  assert.equal(await bcrypt.compare('correct horse', account.passwordHash), true);
  assert.equal(await bcrypt.compare('wrong password', account.passwordHash), false);
  // The plain user object never carries the hash.
  assert.ok(!('passwordHash' in got));
  assert.equal(await db.getUserByEmail(pool, 'nobody@example.com'), null);
  assert.equal(await db.getAccountByEmail(pool, 'nobody@example.com'), null);
});

test('duplicate email is rejected on a second row', async () => {
  const pool = makePool();
  await db.initDb(pool);
  await db.createUser(pool, newTestUser('u1'));
  await db.createUser(pool, newTestUser('u2'));
  const hash = await bcrypt.hash('password123', 4);
  assert.deepEqual(await db.setAccount(pool, 'u1', 'dup@example.com', hash), { ok: true });
  assert.deepEqual(await db.setAccount(pool, 'u2', 'dup@example.com', hash),
    { ok: false, reason: 'email_taken' });
  assert.deepEqual(await db.setAccount(pool, 'missing', 'other@example.com', hash),
    { ok: false, reason: 'not_found' });
  // The first account is untouched.
  assert.equal((await db.getUserByEmail(pool, 'dup@example.com')).id, 'u1');
});

test('password reset tokens are hashed, single-use, and expire', async () => {
  const pool = makePool();
  await db.initDb(pool);
  const raw = 'a'.repeat(64);
  const tokenHash = sha256(raw);
  await db.createPasswordReset(pool, 'user@example.com', tokenHash, new Date(Date.now() + 900000));
  const row = await db.getPasswordReset(pool, tokenHash);
  assert.equal(row.email, 'user@example.com');
  assert.equal(row.used, false);
  assert.equal(row.tokenHash, tokenHash);
  assert.notEqual(row.tokenHash, raw);
  assert.equal(db.isResetTokenValid(row), true);
  // Single-use: only the first caller wins.
  assert.equal(await db.usePasswordReset(pool, tokenHash), true);
  assert.equal(await db.usePasswordReset(pool, tokenHash), false);
  assert.equal(db.isResetTokenValid(await db.getPasswordReset(pool, tokenHash)), false);
  // Unknown token: nothing found, nothing to use.
  assert.equal(await db.getPasswordReset(pool, sha256('nope')), null);
  assert.equal(await db.usePasswordReset(pool, sha256('nope')), false);
  // Expired token is invalid even before use.
  const expiredHash = sha256('expired');
  await db.createPasswordReset(pool, 'user@example.com', expiredHash, new Date(Date.now() - 1000));
  assert.equal(db.isResetTokenValid(await db.getPasswordReset(pool, expiredHash)), false);
  // Invalidation clears every outstanding token for the email.
  const h2 = sha256('second');
  await db.createPasswordReset(pool, 'user@example.com', h2, new Date(Date.now() + 900000));
  await db.invalidatePasswordResetsForEmail(pool, 'user@example.com');
  assert.equal(db.isResetTokenValid(await db.getPasswordReset(pool, h2)), false);
});

test('setPassword replaces the hash', async () => {
  const pool = makePool();
  await db.initDb(pool);
  await db.createUser(pool, newTestUser('u1'));
  const oldHash = await bcrypt.hash('oldpassword', 4);
  const newHash = await bcrypt.hash('newpassword', 4);
  await db.setAccount(pool, 'u1', 'user@example.com', oldHash);
  assert.equal(await db.setPassword(pool, 'u1', newHash), true);
  const account = await db.getAccountByEmail(pool, 'user@example.com');
  assert.equal(await bcrypt.compare('newpassword', account.passwordHash), true);
  assert.equal(await bcrypt.compare('oldpassword', account.passwordHash), false);
  assert.equal(await db.setPassword(pool, 'missing', newHash), false);
});

test('merging moves cookie minutes, sub, and profile into the account', async () => {
  const pool = makePool();
  await db.initDb(pool);
  const cookie = newTestUser('cookie1', {
    trialSeconds: 100, paidSeconds: 300, subSeconds: 600,
    sub: { active: true, customerId: 'cus_x', subscriptionId: 'sub_x' },
    profile: { name: 'Test', sign: 'Capricorn' },
    history: [{ role: 'user', content: 'hi' }],
    chatTimes: [123],
  });
  const account = newTestUser('acct1', { trialSeconds: 50 });
  await db.createUser(pool, cookie);
  await db.createUser(pool, account);
  const merged = await db.mergeCookieIntoAccount(pool, 'cookie1', 'acct1', 180);
  assert.equal(merged.id, 'acct1');
  assert.equal(merged.trialSeconds, 150);
  assert.equal(merged.paidSeconds, 300);
  assert.equal(merged.subSeconds, 600);
  assert.deepEqual(merged.sub, { active: true, customerId: 'cus_x', subscriptionId: 'sub_x' });
  assert.equal(merged.profile.name, 'Test');
  assert.equal(merged.history.length, 1);
  assert.deepEqual(merged.chatTimes, [123]);
  assert.equal(await db.getUser(pool, 'cookie1'), null); // cookie row deleted
});

test('merging a fresh cookie row adds nothing and drops the row', async () => {
  const pool = makePool();
  await db.initDb(pool);
  await db.createUser(pool, newTestUser('cookie1')); // untouched 180s trial, nothing else
  await db.createUser(pool, newTestUser('acct1', { trialSeconds: 50 }));
  const merged = await db.mergeCookieIntoAccount(pool, 'cookie1', 'acct1', 180);
  assert.equal(merged.trialSeconds, 50);
  assert.equal(merged.paidSeconds, 0);
  assert.equal(await db.getUser(pool, 'cookie1'), null);
});

test('merging never touches an existing account profile or sub', async () => {
  const pool = makePool();
  await db.initDb(pool);
  const cookie = newTestUser('cookie1', {
    trialSeconds: 10, paidSeconds: 20,
    sub: { active: true, customerId: 'cus_cookie', subscriptionId: 'sub_cookie' },
    profile: { name: 'Cookie' },
  });
  const account = newTestUser('acct1', {
    trialSeconds: 5,
    sub: { active: true, customerId: 'cus_acct', subscriptionId: 'sub_acct' },
    profile: { name: 'Account' },
  });
  await db.createUser(pool, cookie);
  await db.createUser(pool, account);
  const merged = await db.mergeCookieIntoAccount(pool, 'cookie1', 'acct1', 180);
  assert.equal(merged.trialSeconds, 15); // seconds still merge
  assert.equal(merged.paidSeconds, 20);
  assert.equal(merged.profile.name, 'Account'); // account's own profile kept
  assert.equal(merged.sub.customerId, 'cus_acct'); // account's own sub kept
});

test('merging refuses account rows and same-uid merges', async () => {
  const pool = makePool();
  await db.initDb(pool);
  await db.createUser(pool, newTestUser('acctA', { trialSeconds: 70 }));
  await db.createUser(pool, newTestUser('acctB', { trialSeconds: 80 }));
  const hash = await bcrypt.hash('password123', 4);
  await db.setAccount(pool, 'acctA', 'a@example.com', hash);
  await db.setAccount(pool, 'acctB', 'b@example.com', hash);
  // "Cookie" row is actually an account: nothing merged, nothing deleted.
  const kept = await db.mergeCookieIntoAccount(pool, 'acctA', 'acctB', 180);
  assert.equal(kept.id, 'acctB');
  assert.equal(kept.trialSeconds, 80);
  assert.notEqual(await db.getUser(pool, 'acctA'), null);
  // Same uid: no-op.
  const same = await db.mergeCookieIntoAccount(pool, 'acctB', 'acctB', 180);
  assert.equal(same.id, 'acctB');
  assert.equal(same.trialSeconds, 80);
  // Missing cookie row: account returned unchanged.
  const missing = await db.mergeCookieIntoAccount(pool, 'ghost', 'acctB', 180);
  assert.equal(missing.trialSeconds, 80);
  assert.equal(await db.mergeCookieIntoAccount(pool, 'ghost', 'ghost-acct', 180), null);
});

test('cookie users without accounts are unaffected', async () => {
  const pool = makePool();
  await db.initDb(pool);
  const u = newTestUser('cookie1');
  await db.createUser(pool, u);
  const got = await db.getUser(pool, 'cookie1');
  assert.equal(got.email, null);
  assert.equal(await db.getUserByEmail(pool, 'any@example.com'), null);
  // Existing flows still work on cookie rows.
  assert.equal(await db.grantPaid(pool, 'cookie1', 300), 300);
  await db.deductTick(pool, { ...got, lastTick: 1000000 }, 1000000 + 10000);
  assert.equal((await db.getUser(pool, 'cookie1')).trialSeconds, 170);
});

test('migration adds account columns to a pre-accounts table without losing rows', async () => {
  const pool = makePool();
  // Simulate the live Neon table from before accounts existed.
  await pool.query(`CREATE TABLE users (
    uid TEXT PRIMARY KEY, profile JSONB,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    chat_times JSONB NOT NULL DEFAULT '[]'::jsonb,
    trial_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    paid_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    sub_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    sub JSONB NOT NULL DEFAULT '{"active":false}'::jsonb,
    last_tick BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`INSERT INTO users (uid, trial_seconds) VALUES ('old1', 42)`);
  await db.initDb(pool); // must add the columns, not wipe the table
  const got = await db.getUser(pool, 'old1');
  assert.equal(got.trialSeconds, 42);
  assert.equal(got.email, null);
  // initDb is safe to run twice.
  await db.initDb(pool);
  assert.equal((await db.getUser(pool, 'old1')).trialSeconds, 42);
});

test('rate limiter blocks after the max, resets, and expires with the window', async () => {
  const limiter = createLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
  const t = 1000000;
  assert.equal(limiter.isBlocked('a@example.com', t), false);
  for (let i = 0; i < 5; i++) limiter.record('a@example.com', t + i * 1000);
  assert.equal(limiter.isBlocked('a@example.com', t + 5000), true);
  assert.equal(limiter.isBlocked('b@example.com', t + 5000), false);
  limiter.reset('a@example.com');
  assert.equal(limiter.isBlocked('a@example.com', t + 5000), false);
  for (let i = 0; i < 5; i++) limiter.record('a@example.com', t + i * 1000);
  assert.equal(limiter.isBlocked('a@example.com', t + 15 * 60 * 1000 + 1), false);
});

test('email sender fails gracefully without RESEND_API_KEY and sends via Resend with one', async () => {
  const savedKey = process.env.RESEND_API_KEY;
  const savedFrom = process.env.EMAIL_FROM;
  try {
    delete process.env.RESEND_API_KEY;
    const missing = await sendEmail({ to: 'u@example.com', subject: 's', text: 't' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /RESEND_API_KEY/);
    // With a key and a fake fetch: posts to Resend with a bearer token.
    process.env.RESEND_API_KEY = 're_test_fake_key';
    let seenUrl = null;
    let seenHeaders = null;
    const fakeFetch = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return { ok: true, json: async () => ({ id: 'fake-id' }) };
    };
    const sent = await sendEmail({ to: 'u@example.com', subject: 's', text: 't' }, fakeFetch);
    assert.equal(sent.ok, true);
    assert.equal(seenUrl, 'https://api.resend.com/emails');
    assert.equal(seenHeaders.Authorization, 'Bearer re_test_fake_key');
    assert.equal(seenHeaders['Content-Type'], 'application/json');
  } finally {
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
    if (savedFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = savedFrom;
  }
});
