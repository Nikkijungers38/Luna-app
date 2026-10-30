// Luna — automated test scenarios (Oct 30, 2026 spec from Nikki).
//
// Runs the REAL app (in-process, pg-mem database, test Stripe keys) and
// exercises the three scenarios end to end:
//   1. Five onboarding sequences with edge-case birth data -> chart
//      computed, placements valid, record persisted to the users table.
//   2. Signed Stripe webhook events (subscription + one-time minutes +
//      duplicate + bad signature) -> entitlements change exactly once.
//   3. Ten chat questions through the CLI harness -> chart answers stay
//      anchored to the chart; high-risk prompts hit the boundary filter.
//
// Writes testing_execution_log.md at the project root and exits non-zero
// if any check fails. No real Stripe calls: webhook payloads are signed
// locally with the test webhook secret and verified by the real handler.

process.env.PORT = '3998';
process.env.DATABASE_URL = 'postgres://scenario-test';
process.env.STRIPE_SECRET_KEY = 'sk_test_scenario_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_scenario_secret';
delete process.env.ANTHROPIC_API_KEY;

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const mem = newDb();
const pgAdapter = mem.adapters.createPg();
const pg = require('pg');
pg.Pool = pgAdapter.Pool;
const dbPool = new pgAdapter.Pool();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const BASE = 'http://localhost:3998';
const log = [];
const failures = [];
function note(line) { log.push(line); console.log(line); }
function check(label, ok, detail = '') {
  note(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function api(jar, method, route, body, rawHeaders) {
  const headers = { ...(rawHeaders || {}) };
  if (jar.cookie) headers.cookie = jar.cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') payload = body;
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(BASE + route, { method, headers, body: payload });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) jar.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw text response */ }
  return { status: res.status, json, text };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/me'); if (r.status) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function scenario1() {
  note('\n## Scenario 1 — Onboarding calculation & database write accuracy');
  const cases = [
    { label: 'Leap-day birth', profile: { name: 'Leap', dob: '2000-02-29', birthTime: '08:15', birthPlace: 'Chicago, Illinois', focus: 'Love' }, expectSun: 'Pisces', expectAsc: true },
    { label: 'International coordinates (southern hemisphere)', profile: { name: 'Sydney', dob: '1995-06-15', birthTime: '22:40', birthPlace: 'Sydney, Australia', focus: 'Career' }, expectSun: 'Gemini', expectAsc: true },
    { label: 'Missing birth time', profile: { name: 'NoTime', dob: '1990-01-15', birthPlace: 'London, United Kingdom', focus: 'Money' }, expectSun: 'Capricorn', expectAsc: false },
    { label: 'Late-night birth near the date line', profile: { name: 'Auckland', dob: '1988-12-31', birthTime: '23:55', birthPlace: 'Auckland, New Zealand', focus: 'Love' }, expectSun: 'Capricorn', expectAsc: true },
    { label: 'Sun-cusp birth date', profile: { name: 'Cusp', dob: '1988-10-24', birthTime: '09:30', birthPlace: 'Ukiah, California', focus: 'Love' }, expectSun: 'Scorpio', expectAsc: true },
  ];
  const jars = [];
  for (const c of cases) {
    const jar = {};
    jars.push(jar);
    const created = await api(jar, 'POST', '/api/profile', c.profile);
    check(`${c.label}: profile accepted`, created.status === 200, `HTTP ${created.status}`);
    const chartRes = await api(jar, 'GET', '/api/chart');
    const chart = chartRes.json && chartRes.json.chart;
    check(`${c.label}: chart computed`, !!chart);
    if (!chart) continue;
    const sun = chart.planets.find((p) => p.name === 'Sun');
    const moon = chart.planets.find((p) => p.name === 'Moon');
    check(`${c.label}: 7 placements returned`, chart.planets.length === 7);
    check(`${c.label}: Sun in ${c.expectSun}`, sun.sign === c.expectSun, `got ${sun.sign}`);
    check(`${c.label}: Moon placement present`, !!moon && !!moon.sign, moon && moon.sign);
    check(`${c.label}: rising ${c.expectAsc ? 'present' : 'absent (no birth time)'}`,
      c.expectAsc ? !!chart.ascendant : !chart.ascendant,
      chart.ascendant ? chart.ascendant.sign : 'none');
    const me = await api(jar, 'GET', '/api/me');
    check(`${c.label}: record persisted (re-read from DB)`,
      !!me.json && me.json.profile && me.json.profile.name === c.profile.name && !!me.json.chart);
  }
  const { rows } = await dbPool.query(
    "SELECT count(*)::int AS n FROM users WHERE profile->>'name' = ANY($1)",
    [['Leap', 'Sydney', 'NoTime', 'Auckland', 'Cusp']]);
  note(`  Database: users table holds ${rows[0].n} rows for the 5 scenario profiles.`);
  check('all 5 onboardings wrote a database row', rows[0].n === 5, `${rows[0].n} rows`);
  return jars[0];
}

async function scenario2(jar) {
  note('\n## Scenario 2 — Stripe paywall webhook & state authorization loop');
  const { rows } = await dbPool.query(
    "SELECT uid FROM users WHERE profile->>'name' = 'Leap'");
  const uid = rows[0].uid;
  const before = await dbPool.query('SELECT sub, sub_seconds, paid_seconds FROM users WHERE uid = $1', [uid]);
  note(`  Target user uid ${uid}; before: sub=${JSON.stringify(before.rows[0].sub)} sub_seconds=${before.rows[0].sub_seconds} paid_seconds=${before.rows[0].paid_seconds}`);

  async function fire(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return api({}, 'POST', '/api/stripe/webhook', payload,
      { 'Content-Type': 'application/json', 'stripe-signature': header });
  }

  const subEvent = {
    id: 'evt_scenario_sub_1', type: 'checkout.session.completed',
    data: { object: { client_reference_id: uid, mode: 'subscription', payment_status: 'paid', customer: 'cus_scenario', subscription: 'sub_scenario' } },
  };
  const r1 = await fire(subEvent);
  check('subscription webhook accepted', r1.status === 200 && r1.json && r1.json.received === true, `HTTP ${r1.status}`);
  const afterSub = await dbPool.query('SELECT sub, sub_seconds FROM users WHERE uid = $1', [uid]);
  check('subscription flips to active (free -> premium)', afterSub.rows[0].sub && afterSub.rows[0].sub.active === true);
  check('membership minutes credited (100 min)', Number(afterSub.rows[0].sub_seconds) === 6000, `${afterSub.rows[0].sub_seconds}s`);

  const r2 = await fire(subEvent);
  check('duplicate event acknowledged without double-credit',
    r2.status === 200 && r2.json && r2.json.duplicate === true);
  const afterDup = await dbPool.query('SELECT sub_seconds FROM users WHERE uid = $1', [uid]);
  check('balance unchanged after duplicate', Number(afterDup.rows[0].sub_seconds) === 6000);

  const payEvent = {
    id: 'evt_scenario_pay_1', type: 'checkout.session.completed',
    data: { object: { client_reference_id: uid, mode: 'payment', payment_status: 'paid', metadata: { minutes: '10' } } },
  };
  const r3 = await fire(payEvent);
  check('one-time minutes webhook accepted', r3.status === 200);
  const afterPay = await dbPool.query('SELECT paid_seconds FROM users WHERE uid = $1', [uid]);
  check('paid minutes credited (10 min)', Number(afterPay.rows[0].paid_seconds) === 600, `${afterPay.rows[0].paid_seconds}s`);

  const payload = JSON.stringify(payEvent);
  const badHeader = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });
  const r4 = await api({}, 'POST', '/api/stripe/webhook', payload,
    { 'Content-Type': 'application/json', 'stripe-signature': badHeader });
  check('bad signature rejected', r4.status === 400, `HTTP ${r4.status}`);
}

function scenario3() {
  note('\n## Scenario 3 — AI chat logic & boundary filter compliance');
  const { answer, PIVOT, CRISIS } = require('../luna-chat');
  const chartQuestions = [
    ['What does my Scorpio rising mean?', /Sagittarius rising|rising sign is Sagittarius/],
    ['How does this full moon look for my 2nd house?', /2nd house|second house/],
    ['How is my love life looking?', /Venus/],
    ['Anything I should know about my career right now?', /Saturn|10th house/],
    ['What is my energy like today?', /transit|Saturn|Jupiter|Venus/i],
  ];
  for (const [q, pattern] of chartQuestions) {
    const { text, anchors } = answer(q);
    check(`chart-anchored: "${q}"`, pattern.test(text) && anchors.length > 0,
      anchors.join(' · ').slice(0, 90));
  }
  const general = [
    'Tell me about my Moon.',
    'Draw my cards',
    'What does my Venus say about me?',
  ];
  for (const q of general) {
    const { text } = answer(q);
    check(`answered: "${q}"`, typeof text === 'string' && text.length > 20);
  }
  const risk = [
    ['What stocks should I invest in right now?', PIVOT],
    ['Can you diagnose what this pain in my side is?', PIVOT],
  ];
  for (const [q, expected] of risk) {
    const { text } = answer(q);
    check(`boundary pivot: "${q}"`, text === expected);
  }
  const crisis = answer('I feel like I want to die');
  check('crisis language gets the crisis response, never a reading', crisis.text === CRISIS);
}

async function main() {
  note('# Luna — Testing Execution Log');
  note(`Run: ${new Date().toISOString()} · Real app in-process (pg-mem DB, Stripe test keys, live geocoding)`);
  require('../server');
  await waitForServer();
  const jar = await scenario1();
  await scenario2(jar);
  scenario3();
  note(`\n## Summary`);
  note(failures.length
    ? `${failures.length} FAILING CHECK(S): ${failures.join('; ')}`
    : 'All checks passed. No runtime errors or database anomalies were caught; database ran on the pg-mem emulator of the real Postgres schema.');
  note('Mapping notes: the app has no Ephemeris API or mock tables — charts are computed by chart.js and stored on the real users table. "subscription_status free->premium" maps to users.sub.active + sub_seconds, verified above.');
  const out = log.join('\n') + '\n';
  fs.writeFileSync(path.join(__dirname, '..', 'testing_execution_log.md'), out);
  console.log(`\nLog written to testing_execution_log.md — ${failures.length} failure(s).`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  note(`\nFATAL: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  try { fs.writeFileSync(path.join(__dirname, '..', 'testing_execution_log.md'), log.join('\n') + '\n'); } catch { /* ignore */ }
  process.exit(1);
});
