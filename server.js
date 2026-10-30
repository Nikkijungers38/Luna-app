require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const path = require('path');
const {
  createPool, initDb, getUser, getUserByEmail, getAccountByEmail, setAccount,
  setPassword, mergeCookieIntoAccount, createPasswordReset, getPasswordReset,
  usePasswordReset, invalidatePasswordResetsForEmail, isResetTokenValid,
  normalizeEmail, createUser, saveUser, clearLastTick,
  deductTick, grantPaid, setSubscription, findUserByCustomer, addEvent,
} = require('./db');
const { sendEmail } = require('./email');
const { createLimiter } = require('./login-limits');
const { computeChart, computeTransits } = require('./chart');
const { placementText, houseText, risingText } = require('./meanings');
const { computeSynastry } = require('./synastry');
const { drawCards, SPREADS } = require('./tarot');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const TRIAL_SECONDS = Number(process.env.TRIAL_MINUTES || 3) * 60;
const PRICE_PER_MIN_CENTS = Number(process.env.PRICE_PER_MINUTE_CENTS || 99);
const SUB_PRICE_CENTS = Number(process.env.SUBSCRIPTION_PRICE_CENTS || 1999);
const SUB_MINUTES = Number(process.env.SUBSCRIPTION_MINUTES || 100);
const WEB_SEARCH = String(process.env.ENABLE_WEB_SEARCH || 'true') === 'true';
const DEMO_AI = !process.env.ANTHROPIC_API_KEY;
const DEV_BILLING = !process.env.STRIPE_SECRET_KEY;
const MINUTE_PACKS = [5, 10, 20, 30];

const anthropic = DEMO_AI
  ? null
  : new (require('@anthropic-ai/sdk'))({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = DEV_BILLING ? null : require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---------- Accounts (email + password, optional) ----------
// Cookie visitors keep working exactly as before; accounts are additive.
// A signed-in account's minutes live under its user row, so signing in from
// any device restores them. Rate limits: 5 failed sign-ins per email per 15
// minutes, 5 reset requests per email per hour.
// DUMMY_HASH is a timing decoy, not a credential: when no account exists for
// an email, login still runs a bcrypt comparison so a wrong-password reply
// takes about as long as a wrong-email reply.
const loginLimiter = createLimiter({ maxAttempts: 5, windowMs: 15 * 60 * 1000 });
const resetLimiter = createLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000 };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---------- Postgres datastore (see db.js) ----------
// The server refuses to start without DATABASE_URL: there is no file or
// in-memory fallback, so a missing connection string can never silently
// lose user data the way the old JSON file did on redeploys.
let pool;
try {
  pool = createPool();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

function newUser() {
  const id = crypto.randomUUID();
  return {
    id, createdAt: Date.now(), profile: null, history: [],
    trialSeconds: TRIAL_SECONDS, paidSeconds: 0, subSeconds: 0,
    sub: { active: false, customerId: null, subscriptionId: null },
    lastTick: null, chatTimes: [],
  };
}

const balance = (u) => Math.max(0, Math.floor(u.trialSeconds + u.paidSeconds + u.subSeconds));

// Metering: the client sends a heartbeat while the reading tab is visible.
// We bill elapsed time since the last tick, capped so idle gaps are never charged.
// The deduction is one atomic UPDATE (see db.js deductTick).
function tick(u) {
  return deductTick(pool, u, Date.now());
}

// ---------- Astrology helpers ----------
const ZODIAC = [
  ['Aries', 'Fire', 'Cardinal'], ['Taurus', 'Earth', 'Fixed'], ['Gemini', 'Air', 'Mutable'],
  ['Cancer', 'Water', 'Cardinal'], ['Leo', 'Fire', 'Fixed'], ['Virgo', 'Earth', 'Mutable'],
  ['Libra', 'Air', 'Cardinal'], ['Scorpio', 'Water', 'Fixed'], ['Sagittarius', 'Fire', 'Mutable'],
  ['Capricorn', 'Earth', 'Cardinal'], ['Aquarius', 'Air', 'Fixed'], ['Pisces', 'Water', 'Mutable'],
];
// Where the Sun is along the zodiac (0-360 degrees) at a moment in time.
// Standard low-precision formula, accurate to about 0.01 degrees (a few minutes of the Sun's motion).
function sunLongitude(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = 280.460 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * rad;
  const lam = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
  return ((lam % 360) + 360) % 360;
}
const signIndexAt = (ms) => Math.floor(sunLongitude(ms) / 30);
// Sun sign for a birth date. Birth time and place are not used, so if the Sun changes signs
// during that calendar day we report the other sign as "cusp" and Luna mentions both.
function sunSign(year, month, day) {
  const start = Date.UTC(year, month - 1, day, 0, 0, 0);
  const iStart = signIndexAt(start);
  const iMid = signIndexAt(start + 12 * 3600000);
  const iEnd = signIndexAt(start + 24 * 3600000 - 1);
  const main = ZODIAC[iMid];
  let cusp = null;
  if (iStart !== iEnd) cusp = ZODIAC[iMid === iStart ? iEnd : iStart][0];
  return { sign: main[0], element: main[1], modality: main[2], cusp };
}
function lifePath(dob) {
  let n = dob.replace(/-/g, '').split('').reduce((a, d) => a + Number(d), 0);
  while (n > 9 && ![11, 22, 33].includes(n)) n = String(n).split('').reduce((a, d) => a + Number(d), 0);
  return n;
}
// ---------- Birth chart ----------
// The chart itself is pure math (see chart.js); the only network piece is
// turning a free-text birth place ("Ukiah, California") into coordinates,
// via OpenStreetMap's Nominatim. Lookups are cached for the life of the
// process and any failure just means no ascendant/houses — a chart is
// never blocked or faked because geocoding was unavailable.
const geoCache = new Map();
async function geocode(place) {
  const key = String(place || '').trim().toLowerCase();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key);
  let out = null;
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
      + encodeURIComponent(place);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'LunaAstrologyApp/1.0 (birth chart lookup)' },
      signal: AbortSignal.timeout(3500),
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j[0] && Number.isFinite(+j[0].lat) && Number.isFinite(+j[0].lon)) {
        out = { lat: +j[0].lat, lon: +j[0].lon };
      }
    }
  } catch { /* offline or slow geocoder: chart proceeds without a place */ }
  geoCache.set(key, out);
  return out;
}

async function buildChartForProfile(p) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.dob || '');
  if (!m) return null;
  let hour;
  let minute;
  const t = /^(\d{1,2}):(\d{2})/.exec(p.birthTime || '');
  if (t) { hour = +t[1]; minute = +t[2]; }
  const coords = p.birthPlace ? await geocode(p.birthPlace) : null;
  return computeChart({
    year: +m[1], month: +m[2], day: +m[3], hour, minute,
    lat: coords ? coords.lat : undefined, lon: coords ? coords.lon : undefined,
    sunSign: p.sign,
  });
}

function chartPromptBlock(p) {
  const c = p.chart;
  if (!c || !Array.isArray(c.planets)) return '';
  const lines = c.planets.map((pl) =>
    `- ${pl.name} in ${pl.sign} (${pl.degreeInSign}°${pl.house ? `, house ${pl.house}` : ''}${pl.retrograde ? ', retrograde' : ''}${pl.cusp ? ', near a sign cusp' : ''})`);
  const rising = c.ascendant
    ? `\n- Rising sign (ascendant): ${c.ascendant.sign} — the face they show the world` : '';
  const aspects = c.aspects && c.aspects.length
    ? `\nNotable aspects: ${c.aspects.slice(0, 5).map((a) => `${a.a} ${a.type.toLowerCase()} ${a.b}`).join('; ')}.` : '';
  const soft = c.approximate
    ? '\n(The chart is partly approximate — birth time or place was incomplete, or the placement sits near a cusp. Speak of borderline placements as blended energies rather than certainties.)' : '';
  return `\n\nTHEIR BIRTH CHART (computed from their birth details — weave these placements into readings naturally, especially the Moon, Venus and Mars for love, Mercury for work and money, and the rising sign for how others experience them)\n${lines.join('\n')}${rising}${aspects}${soft}`;
}

// ---------- Tarot ----------
// The draw itself is free and instant; Luna's interpretation of the cards
// happens in the ordinary chat, at the ordinary rate. The latest draw is
// stored on the profile so the reading prompt can see it.
function tarotPromptBlock(p) {
  const t = p.tarot;
  if (!t || !Array.isArray(t.cards) || !t.cards.length) return '';
  const lines = t.cards.map((c) =>
    `- ${c.position}: ${c.name}${c.reversed ? ' (reversed)' : ''} — ${c.meaning}`);
  return `\n\nTHEIR LATEST TAROT DRAW (${t.spreadLabel}, drawn just now in the app — if they ask about "the cards", "my draw", or their reading, this is what they mean; interpret the cards together, in conversation with their chart and their question, never as fixed predictions)\n${lines.join('\n')}`;
}

// Today's sky against their chart, in the same plain language the app feed
// uses, so a reading can answer "what's happening for me right now" from
// real computed transits instead of generalities.
function transitsPromptBlock(p) {
  if (!p.chart) return '';
  let transits;
  try { transits = computeTransits(p.chart); } catch { return ''; }
  if (!transits.length) return '';
  const lines = transits.slice(0, 5).map((t) =>
    `- [${t.tag}] ${t.line} (peaks ${t.exact})`);
  return `\n\nTODAY'S TRANSITS OVER THEIR CHART (computed live — anchor answers about today, this week, timing, moods, and "what's going on with me" to these first)\n${lines.join('\n')}`;
}

function compatPromptBlock(p) {
  const c = p.compat;
  if (!c || !c.categories) return '';
  const cats = Object.entries(c.categories)
    .map(([k, v]) => `${k} ${v.score}/100`).join(', ');
  const highs = (c.highlights || []).slice(0, 3)
    .map((h) => `your ${h.a} ${h.type} their ${h.b}`).join('; ');
  return `\n\nTHEIR LATEST COMPATIBILITY CHECK (with ${c.name} — if they ask about "us", this person, or the connection, anchor to this; scores are conversation starters about patterns, never verdicts on a relationship)\nScores: ${cats}.${highs ? `\nStrongest contacts: ${highs}.` : ''}`;
}

function moonPhase(date = new Date()) {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((date.getTime() - ref) / 86400000) % synodic + synodic) % synodic;
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
    'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return names[Math.floor(((age / synodic) * 8 + 0.5) % 8)];
}

// ---------- AI ----------
function systemPrompt(u) {
  const p = u.profile;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `You are Luna, a warm, mystical astrology and intuitive-reading guide inside an entertainment app. Today is ${today}. The moon is currently in its ${moonPhase()} phase.

ABOUT THE PERSON
- Name: ${p.name}
- Date of birth: ${p.dob}
- Sun sign: ${p.sign} (${p.element}, ${p.modality})${p.cuspSign ? `\n- Born on a cusp day when the Sun moved between ${p.sign} and ${p.cuspSign}; you may mention both` : ''}
- Life path number: ${p.lifePath}
${p.birthTime ? `- Birth time: ${p.birthTime}\n` : ''}${p.birthPlace ? `- Birth place: ${p.birthPlace}\n` : ''}- Main interest: ${p.focus}${chartPromptBlock(p)}${tarotPromptBlock(p)}${transitsPromptBlock(p)}${compatPromptBlock(p)}

HOW TO READ
- Speak in short, modern, everyday sentences a non-expert understands. No astrology jargon without a plain-words translation right after it. Short paragraphs and the occasional short list beat walls of text.
- Frame everything as psychology, timing, and emotional patterns — themes and seasons of a life, never fixed fate and never doom.
- Weave their sun sign, element, life path number and the current sky (moon phase, notable planetary transits, retrogrades, eclipses, seasonal events) into vivid, personal stories and scenarios: "picture a moment this week when...".
- You may use web search to look up what is actually happening in the sky and calendar right now, and refer to it naturally. Do not paste long quotes or URLs.
- Be specific and evocative, but frame everything as reflection, possibility and themes, not guaranteed fact. Use phrases like "this energy invites you to..." rather than certainties.
- Keep replies to roughly 120-220 words unless asked for more. End with a gentle question or an invitation to go deeper, so the conversation flows.
- Stay in character as Luna, a warm AI guide. Never claim to be a human or a human psychic. If sincerely asked, say you are an AI guide.

GUARDRAILS
- Never predict death, illness, pregnancy, lawsuits, or specific financial outcomes, and never tell the person to make major medical, legal, or financial decisions based on a reading. If they ask, say a reading cannot guide that and suggest a qualified professional.
- Never use fear, curses, "dark energy", or urgency to push the person to buy anything or keep chatting.
- If the person expresses thoughts of self-harm, suicide, or being in danger, drop the mystical tone, respond with care, and encourage them to reach out to a crisis line (in the US, call or text 988) or local emergency services.`;
}

const DEMO_LINES = {
  Fire: 'a spark of momentum is building around you, something you have been hesitating on wants to move',
  Earth: 'a steady, grounded chapter is unfolding, and small consistent choices are quietly stacking up',
  Air: 'conversations and fresh ideas are the doorway this week, someone\'s words may shift your perspective',
  Water: 'your intuition is running deep right now, and a feeling you have been brushing aside deserves attention',
};
function demoReply(u, message) {
  if (/suicid|kill myself|self.?harm|end my life/i.test(message)) {
    return 'I am really glad you told me. I am setting the stars aside for a moment: you deserve real support. If you are in the US, you can call or text 988 any time to reach the Suicide & Crisis Lifeline, or call 911 if you are in immediate danger. Is there someone near you who can be with you right now?';
  }
  const p = u.profile;
  return `(Demo mode: add an ANTHROPIC_API_KEY for live readings.)\n\n${p.name}, as a ${p.sign} with a life path ${p.lifePath}, ${DEMO_LINES[p.element]}. With the ${moonPhase()} overhead, picture a quiet moment this week where you pause, breathe, and notice what your ${p.focus.toLowerCase()} life is asking of you.\n\nWhat part of that feels most true right now?`;
}

async function reading(u, message) {
  u.history.push({ role: 'user', content: message });
  u.history = u.history.slice(-20);
  // Messages must start with a user turn
  while (u.history.length && u.history[0].role !== 'user') u.history.shift();

  let text;
  if (DEMO_AI) {
    text = demoReply(u, message);
  } else {
    const params = {
      model: MODEL, max_tokens: 1000, system: systemPrompt(u), messages: u.history,
    };
    let resp;
    try {
      resp = await anthropic.messages.create(
        WEB_SEARCH ? { ...params, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] } : params
      );
    } catch (err) {
      if (!WEB_SEARCH) throw err;
      console.warn('Web search call failed, retrying without it:', err.message);
      resp = await anthropic.messages.create(params);
    }
    text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) text = 'The stars are a little hazy just now. Ask me again?';
  }
  u.history.push({ role: 'assistant', content: text });
  return text;
}

// ---------- App ----------
const app = express();

// Stripe webhook needs the raw body, so register it before express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (DEV_BILLING) return res.status(400).send('Stripe is not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (!(await addEvent(pool, event.id))) return res.json({ received: true, duplicate: true });

  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const u = await getUser(pool, obj.client_reference_id);
    if (u) {
      if (obj.mode === 'payment' && obj.payment_status === 'paid') {
        await grantPaid(pool, u.id, Number(obj.metadata?.minutes || 0) * 60);
      } else if (obj.mode === 'subscription') {
        await setSubscription(pool, u.id,
          { active: true, customerId: obj.customer, subscriptionId: obj.subscription },
          SUB_MINUTES * 60);
      }
    }
  } else if (event.type === 'invoice.paid' && obj.billing_reason === 'subscription_cycle') {
    const u = await findUserByCustomer(pool, obj.customer);
    if (u) { await setSubscription(pool, u.id, { ...u.sub, active: true }, SUB_MINUTES * 60); } // monthly reset, no rollover
  } else if (event.type === 'customer.subscription.deleted') {
    const u = await findUserByCustomer(pool, obj.customer);
    if (u) { await setSubscription(pool, u.id, { ...u.sub, active: false }, 0); }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Identify the visitor by a cookie. Cookie visitors keep working exactly as
// before (no account needed); when someone signs in, the session cookie is
// switched to their account row, so their minutes follow them across devices.
app.use('/api', async (req, res, next) => {
  try {
    let u = await getUser(pool, req.cookies.uid);
    if (!u) {
      u = newUser();
      await createUser(pool, u);
      res.cookie('uid', u.id, SESSION_COOKIE);
    }
    req.user = u;
    next();
  } catch (err) {
    console.error('Database error:', err.message);
    res.status(503).json({ error: 'The database is unavailable right now. Please try again.' });
  }
});

const pricing = () => ({
  trialMinutes: TRIAL_SECONDS / 60,
  perMinuteCents: PRICE_PER_MIN_CENTS,
  packs: MINUTE_PACKS,
  subscriptionCents: SUB_PRICE_CENTS,
  subscriptionMinutes: SUB_MINUTES,
});
const me = (u) => ({
  profile: u.profile,
  chart: u.profile ? (u.profile.chart || null) : null,
  tarot: u.profile ? (u.profile.tarot || null) : null,
  history: u.history,
  balanceSeconds: balance(u),
  subscribed: u.sub.active,
  email: u.email || null,
  pricing: pricing(),
  modes: { demoAI: DEMO_AI, devBilling: DEV_BILLING },
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => res.json(me(req.user)));

app.post('/api/profile', async (req, res) => {
  const { name, dob, birthTime, birthPlace, focus } = req.body || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCMonth() !== +m[2] - 1 || +m[1] < 1900 || d > new Date()) {
    return res.status(400).json({ error: 'Please enter a valid date of birth.' });
  }
  if (!name || String(name).trim().length < 1) return res.status(400).json({ error: 'Please enter your name.' });
  const s = sunSign(+m[1], +m[2], +m[3]);
  req.user.profile = {
    name: String(name).trim().slice(0, 40), dob,
    birthTime: String(birthTime || '').slice(0, 10), birthPlace: String(birthPlace || '').slice(0, 80),
    focus: ['Love', 'Career', 'Personal growth', 'Money', 'Friends & family'].includes(focus) ? focus : 'Personal growth',
    sign: s.sign, cuspSign: s.cusp, element: s.element, modality: s.modality, lifePath: lifePath(dob),
  };
  // The birth chart is computed once, at profile time, and stored with the
  // profile. A geocoding hiccup must never block sign-up: chart stays null
  // and /api/chart retries lazily.
  try {
    req.user.profile.chart = await buildChartForProfile(req.user.profile);
  } catch { req.user.profile.chart = null; }
  req.user.history = [];
  await saveUser(pool, req.user);
  res.json(me(req.user));
});

// The visitor's birth chart. Viewing your own chart is free — it is built
// from the details already on the profile and never touches the meter.
// Profiles created before the chart existed get theirs computed on first
// ask and stored for next time.
app.get('/api/chart', async (req, res) => {
  const u = req.user;
  if (!u.profile) return res.status(400).json({ error: 'Tell me about yourself first.' });
  if (!u.profile.chart) {
    try {
      u.profile.chart = await buildChartForProfile(u.profile);
      if (u.profile.chart) await saveUser(pool, u);
    } catch { /* leave null; a later ask retries */ }
  }
  res.json({ chart: u.profile.chart || null, describe: chartDescriptions(u.profile.chart) });
});

// Plain-language descriptions for every tappable point on the wheel:
// each planet placement, each house, and the rising sign. One source of
// wording (meanings.js) for the app, the CLI harness, and the prompt.
function chartDescriptions(c) {
  if (!c || !Array.isArray(c.planets)) return null;
  const planets = {};
  for (const p of c.planets) planets[p.name] = placementText(p.name, p.sign, p.house);
  const houses = {};
  if (c.ascendant) {
    for (let h = 1; h <= 12; h++) {
      houses[h] = houseText(h, c.planets.filter((p) => p.house === h).map((p) => p.name));
    }
  }
  return { planets, houses, rising: c.ascendant ? risingText(c.ascendant.sign) : null };
}

// Today's transits over the visitor's own chart — the feed. Free, like the
// chart itself: it is computed from data already on the profile.
app.get('/api/transits', async (req, res) => {
  const u = req.user;
  if (!u.profile) return res.status(400).json({ error: 'Tell me about yourself first.' });
  if (!u.profile.chart) {
    try {
      u.profile.chart = await buildChartForProfile(u.profile);
      if (u.profile.chart) await saveUser(pool, u);
    } catch { /* leave null; a later ask retries */ }
  }
  if (!u.profile.chart) return res.json({ transits: [] });
  res.json({ transits: computeTransits(u.profile.chart) });
});

// Compatibility with one other person, from their birth details. Free to
// compute, like the chart itself; the result is kept on the profile so
// Luna can talk about the connection in the reading that follows.
app.post('/api/compatibility', async (req, res) => {
  const u = req.user;
  if (!u.profile) return res.status(400).json({ error: 'Tell me about yourself first.' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  const dob = String(b.dob || '');
  if (!name) return res.status(400).json({ error: 'Their first name helps Luna keep it personal.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ error: 'I need their date of birth.' });
  if (!u.profile.chart) {
    try {
      u.profile.chart = await buildChartForProfile(u.profile);
      if (u.profile.chart) await saveUser(pool, u);
    } catch { /* handled below */ }
  }
  if (!u.profile.chart) return res.status(400).json({ error: 'Your own chart is not ready yet — open your birth chart first.' });
  const theirProfile = {
    dob, birthTime: String(b.birthTime || ''), birthPlace: String(b.birthPlace || '').slice(0, 80),
  };
  let theirChart = null;
  try { theirChart = await buildChartForProfile(theirProfile); } catch { /* null below */ }
  if (!theirChart) return res.status(400).json({ error: 'I could not compute their chart from those details.' });
  const synastry = computeSynastry(u.profile.chart, theirChart);
  const compat = { name, at: new Date().toISOString(), ...synastry };
  u.profile.compat = compat;
  await saveUser(pool, u);
  res.json({ compat });
});

// A tarot draw. Free: drawing cards never touches the meter. The draw is
// stored on the profile so Luna can interpret it in the chat that follows.
app.post('/api/tarot', async (req, res) => {
  const u = req.user;
  if (!u.profile) return res.status(400).json({ error: 'Tell me about yourself first.' });
  const spread = String(req.body?.spread || 'three');
  if (!SPREADS[spread]) return res.status(400).json({ error: 'Unknown spread.' });
  const draw = drawCards(spread);
  u.profile.tarot = draw;
  await saveUser(pool, u);
  res.json({ tarot: draw });
});

// Lets someone re-enter their birth details. Their remaining time is kept.
app.post('/api/reset', async (req, res) => {
  req.user.profile = null;
  req.user.history = [];
  req.user.lastTick = null;
  await saveUser(pool, req.user);
  await clearLastTick(pool, req.user.id);
  res.json(me(req.user));
});

// ---------- Accounts ----------
// Registration turns the current cookie user into an account: same row, same
// minutes, now with an email + bcrypt hash. Passwords are hashed, never
// stored or logged in plain text.
app.post('/api/register', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (req.user.email) {
    return res.status(400).json({ error: 'You are already signed in.' });
  }
  if (await getUserByEmail(pool, email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Try signing in instead.' });
  }
  const hash = await bcrypt.hash(password, 12);
  const result = await setAccount(pool, req.user.id, email, hash);
  if (!result.ok) {
    if (result.reason === 'email_taken') {
      return res.status(409).json({ error: 'An account with this email already exists. Try signing in instead.' });
    }
    return res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
  req.user.email = email;
  res.json(me(req.user));
});

// Sign-in. Wrong-email and wrong-password replies are identical, so an
// attacker cannot probe which emails have accounts. On success the session
// switches to the account row, merging in any cookie minutes first (a
// brand-new cookie row contributes nothing and is just dropped). An
// already-signed-in account row is never merged into another account.
app.post('/api/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }
  if (loginLimiter.isBlocked(email)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again in a few minutes.' });
  }
  const account = await getAccountByEmail(pool, email);
  const hash = account ? account.passwordHash : DUMMY_HASH;
  const ok = account && (await bcrypt.compare(password, hash));
  if (!ok) {
    loginLimiter.record(email);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  loginLimiter.reset(email);
  let user = account.user;
  if (req.user.id !== user.id) {
    if (req.user.email) {
      // Signed into a different account: switch sessions only. Account rows
      // are never merged into each other or deleted by sign-in.
      res.cookie('uid', user.id, SESSION_COOKIE);
    } else {
      const merged = await mergeCookieIntoAccount(pool, req.user.id, user.id, TRIAL_SECONDS);
      if (merged) user = merged;
      res.cookie('uid', user.id, SESSION_COOKIE);
    }
  }
  res.json(me(user));
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('uid');
  res.json({ ok: true });
});

// Password reset, step 1. The reply is always the same generic message,
// whether or not an account exists for the email, so it cannot be used to
// probe for accounts. When email sending is not configured, the request
// still gets the generic reply and the failure is logged server-side.
app.post('/api/reset-request', async (req, res) => {
  const generic = { ok: true, message: 'If an account exists for that email, a password reset link has been sent.' };
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.json(generic);
  if (resetLimiter.isBlocked(email)) return res.json(generic);
  resetLimiter.record(email);
  const account = await getUserByEmail(pool, email);
  if (!account) return res.json(generic);
  // A token-hash collision is near-impossible, but if it happens, retry with
  // a fresh token instead of reusing the colliding one.
  let raw = null;
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  for (let attempt = 0; attempt < 3 && !raw; attempt++) {
    const candidate = crypto.randomBytes(32).toString('hex');
    try {
      await createPasswordReset(pool, email, sha256(candidate), expiresAt);
      raw = candidate;
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  if (!raw) return res.json(generic);
  const link = `${BASE_URL}/?reset=${raw}`;
  const sent = await sendEmail({
    to: email,
    subject: 'Reset your Luna password',
    text: `You asked to reset your Luna password. Use this link within 15 minutes:\n\n${link}\n\nIf you did not ask for this, just ignore this email — your password stays the same.`,
    html: `<p>You asked to reset your Luna password. Use this link within 15 minutes:</p><p><a href="${link}">${link}</a></p><p>If you did not ask for this, just ignore this email — your password stays the same.</p>`,
  });
  if (!sent.ok) console.error('Password reset email failed:', sent.error);
  res.json(generic);
});

// Password reset, step 2. The token is single-use (flipped atomically) and
// expires after 15 minutes; invalid, used, and expired links all get the
// same reply. After a successful reset, every other reset link for the
// email is invalidated too.
app.post('/api/reset-confirm', async (req, res) => {
  const invalid = { error: 'Reset link is invalid or has expired.' };
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!token) return res.status(400).json(invalid);
  const row = await getPasswordReset(pool, sha256(token));
  if (!isResetTokenValid(row)) return res.status(400).json(invalid);
  if (!(await usePasswordReset(pool, sha256(token)))) return res.status(400).json(invalid);
  const account = await getUserByEmail(pool, row.email);
  if (!account) return res.status(400).json(invalid);
  await setPassword(pool, account.id, await bcrypt.hash(password, 12));
  await invalidatePasswordResetsForEmail(pool, row.email);
  loginLimiter.reset(row.email);
  res.json({ ok: true });
});

// Heartbeat: called every ~10s while the reading is open and visible
app.post('/api/tick', async (req, res) => {
  await tick(req.user);
  res.json({ balanceSeconds: balance(req.user) });
});

app.post('/api/chat', async (req, res) => {
  const u = req.user;
  if (!u.profile) return res.status(400).json({ error: 'Tell me about yourself first.' });
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Say something to begin.' });

  const now = Date.now();
  u.chatTimes = (u.chatTimes || []).filter((t) => now - t < 60000);
  if (u.chatTimes.length >= 12) return res.status(429).json({ error: 'Slow down a little, the stars need a moment.' });

  await tick(u);
  if (balance(u) <= 0) { return res.status(402).json({ error: 'paywall', balanceSeconds: 0 }); }
  u.chatTimes.push(now);

  try {
    const reply = await reading(u, message);
    await saveUser(pool, u);
    res.json({ reply, balanceSeconds: balance(u) });
  } catch (err) {
    console.error('Reading failed:', err.message);
    u.history.pop(); // drop the unanswered user turn
    await saveUser(pool, u);
    res.status(502).json({ error: 'The connection to the stars flickered. Please try again.' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const u = req.user;
  const { plan, minutes } = req.body || {};
  if (plan === 'minutes' && !MINUTE_PACKS.includes(Number(minutes))) {
    return res.status(400).json({ error: 'Invalid pack.' });
  }
  if (!['minutes', 'subscription'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });

  if (DEV_BILLING) { // no Stripe keys: grant instantly so you can test the whole flow
    if (plan === 'minutes') {
      const paid = await grantPaid(pool, u.id, Number(minutes) * 60);
      if (paid != null) u.paidSeconds = paid;
    } else {
      u.sub = { active: true, customerId: 'dev', subscriptionId: 'dev' };
      u.subSeconds = SUB_MINUTES * 60;
      await setSubscription(pool, u.id, u.sub, u.subSeconds);
    }
    return res.json({ granted: true, ...me(u) });
  }

  try {
    const base = { client_reference_id: u.id, success_url: `${BASE_URL}/?paid=1`, cancel_url: `${BASE_URL}/` };
    const session = plan === 'minutes'
      ? await stripe.checkout.sessions.create({
          ...base, mode: 'payment',
          line_items: [{ quantity: Number(minutes), price_data: {
            currency: 'usd', unit_amount: PRICE_PER_MIN_CENTS,
            product_data: { name: 'Reading time (1 minute)' } } }],
          metadata: { userId: u.id, minutes: String(minutes) },
        })
      : await stripe.checkout.sessions.create({
          ...base, mode: 'subscription',
          line_items: [{ quantity: 1, price_data: {
            currency: 'usd', unit_amount: SUB_PRICE_CENTS, recurring: { interval: 'month' },
            product_data: { name: `Monthly membership (${SUB_MINUTES} minutes)` } } }],
          metadata: { userId: u.id },
        });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout failed:', err.message);
    res.status(502).json({ error: 'Could not start checkout.' });
  }
});

app.post('/api/portal', async (req, res) => {
  const u = req.user;
  if (DEV_BILLING || !u.sub.customerId) return res.status(400).json({ error: 'No subscription to manage.' });
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: u.sub.customerId, return_url: BASE_URL });
    res.json({ url: s.url });
  } catch (err) {
    res.status(502).json({ error: 'Could not open the billing portal.' });
  }
});

(async () => {
  try {
    await initDb(pool);
  } catch (err) {
    console.error('Failed to initialize the database:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Astro app on ${BASE_URL}`);
    console.log(`  AI: ${DEMO_AI ? 'DEMO mode (no ANTHROPIC_API_KEY)' : `live (${MODEL}${WEB_SEARCH ? ' + web search' : ''})`}`);
    console.log(`  Billing: ${DEV_BILLING ? 'DEV mode (no real charges)' : 'Stripe'}`);
  });
})();
