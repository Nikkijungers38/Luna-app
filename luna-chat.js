#!/usr/bin/env node
// Luna — command-line chat test harness.
//
// Runs the app's real engines (birth chart, transits, tarot, plain-language
// meanings) in a terminal so readings can be tested live without deploying.
// Answers are composed from the visitor's own computed chart and today's
// computed transits — the same data Luna's AI prompt receives — so a generic
// answer here would mean a generic answer in the app.
//
//   node luna-chat.js           interactive chat (type /help, /quit)
//   node luna-chat.js --demo    scripted simulation run, then exits
//
// No network, no API key, no database: the test profile's birth place is
// given as coordinates (Ukiah, California) so nothing needs geocoding.

const readline = require('node:readline');
const { computeChart, computeTransits, longitudesAt, dayNumber, SIGNS } = require('./chart');
const { placementText, houseText } = require('./meanings');
const { drawCards } = require('./tarot');

const { SIGN_FLAVOR } = require('./meanings');

const rev = (x) => ((x % 360) + 360) % 360;
const signOf = (lon) => SIGNS[Math.floor(rev(lon) / 30)];
const ordinalWord = (n) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'][n - 1] || `${n}th`;

// Test profile: October 24, 1988, 09:30, Ukiah, California.
const chart = computeChart({
  year: 1988, month: 10, day: 24, hour: 9, minute: 30,
  lat: 39.1502, lon: -123.2078,
});
const transits = computeTransits(chart);
const planet = (name) => chart.planets.find((p) => p.name === name);

function moonNow() {
  const n = new Date();
  const d = dayNumber(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(),
    n.getUTCHours() + n.getUTCMinutes() / 60);
  const lons = longitudesAt(d);
  const elong = rev(lons.moon - lons.sun);
  const phase = elong < 22.5 || elong >= 337.5 ? 'New Moon'
    : elong < 112.5 ? (elong < 67.5 ? 'Waxing Crescent' : 'First Quarter')
    : elong < 157.5 ? 'Waxing Gibbous'
    : elong < 202.5 ? 'Full Moon'
    : elong < 247.5 ? 'Waning Gibbous'
    : elong < 292.5 ? 'Last Quarter' : 'Waning Crescent';
  const house = chart.ascendant
    ? Math.floor(rev(lons.moon - chart.ascendant.longitude) / 30) + 1 : null;
  return { sign: signOf(lons.moon), phase, house };
}

function chartSummary() {
  const sun = planet('Sun'), moon = planet('Moon');
  const rising = chart.ascendant ? `${chart.ascendant.sign} rising` : 'rising unknown';
  return `Sun in ${sun.sign} · Moon in ${moon.sign} · ${rising}`;
}

function transitFeed(limit = 5) {
  if (!transits.length) return 'No tight transits today — a quiet sky.';
  return transits.slice(0, limit)
    .map((t) => `[${t.tag}] ${t.line} (peaks ${t.exact})`).join('\n');
}

const PIVOT = 'As your cosmic mentor, I can beautifully map out the energetic timing and emotional themes surrounding your current transits. However, for specialized medical or financial decisions, I highly recommend consulting with a certified professional.';
const CRISIS = 'I am really glad you told me. I am setting the stars aside for a moment: you deserve real support. If you are in the US, you can call or text 988 any time to reach the Suicide & Crisis Lifeline, or call 911 if you are in immediate danger. Is there someone near you who can be with you right now?';

// Boundary filter, checked before any chart routing: crisis language gets
// the crisis response; specific investment picks and medical-diagnosis
// asks get the polite pivot. Neither ever reaches the reading logic.
function safeguard(raw) {
  const q = raw.toLowerCase();
  if (/suicid|kill myself|self.?harm|end my life|want to die/.test(q)) return CRISIS;
  if (/what stocks?|which stocks?|invest in|should i buy (stock|shares|crypto|bitcoin)|stock picks?|crypto should|diagnos|what is this (rash|pain|lump|bump)|symptoms? of|do i have (cancer|diabetes|covid)/.test(q)) return PIVOT;
  return null;
}

// Answer one free-text question from the chart + transits, and report which
// placements the answer was anchored to (the Phase 2 parsing check).
function answer(raw) {
  const q = raw.toLowerCase();
  const anchors = [];
  const say = (text, used) => ({ text, anchors: used });

  const blocked = safeguard(raw);
  if (blocked) return say(blocked, ['boundary filter']);

  const houseMatch = q.match(/(\d{1,2})(?:st|nd|rd|th)?\s+house/) || q.match(/house\s+(\d{1,2})/);
  if (houseMatch) {
    const h = Math.min(12, Math.max(1, parseInt(houseMatch[1], 10)));
    const there = chart.planets.filter((p) => p.house === h).map((p) => p.name);
    anchors.push(`natal house ${h}: ${there.join(', ') || 'empty'}`);
    let text = houseText(h, there);
    if (/full moon|moon/.test(q)) {
      const m = moonNow();
      anchors.push(`Moon now: ${m.sign}, ${m.phase}, passing your house ${m.house}`);
      text += m.house === h
        ? ` Right now the Moon is in ${m.sign} (${m.phase}) and passing through this very house, so this area of life is lit up for the next day or so.`
        : ` Right now the Moon is in ${m.sign} (${m.phase}) and passing through your ${ordinalWord(m.house)} house, so tonight's moonlight actually falls there more than here.`;
    }
    const hits = transits.filter((t) => there.includes(t.natal));
    if (hits.length) {
      anchors.push(`transit: ${hits[0].transit} ${hits[0].aspect} ${hits[0].natal}`);
      text += ` Also live here: ${hits[0].line}`;
    }
    return say(text, anchors);
  }
  if (/rising|ascendant/.test(q)) {
    if (!chart.ascendant) return say('Your chart has no rising sign because no birth time was given — the rising sign needs the hour you were born. Your Sun and Moon still say plenty.', anchors);
    anchors.push(`Rising in ${chart.ascendant.sign}`);
    return say(`Your rising sign is ${chart.ascendant.sign} — the face the world meets first, and the lens your whole chart is viewed through. ${chart.ascendant.sign} rising comes across ${SIGN_FLAVOR[chart.ascendant.sign]}, even on days you feel nothing like it inside. It also sets the order of your houses, which is why your chart is uniquely yours and not just your Sun sign's.`, anchors);
  }
  if (/love|relationship|partner|crush|boyfriend|girlfriend|husband|wife|dating/.test(q)) {
    const v = planet('Venus'), m = planet('Moon');
    anchors.push(`Venus in ${v.sign} (house ${v.house})`, `Moon in ${m.sign} (house ${m.house})`);
    let text = `${placementText('Venus', v.sign, v.house)} ${placementText('Moon', m.sign, m.house)}`;
    const hit = transits.find((t) => t.natal === 'Venus' || t.transit === 'Venus');
    if (hit) { anchors.push(`transit: ${hit.transit} ${hit.aspect} ${hit.natal}`); text += ` Today: ${hit.line}`; }
    return say(text, anchors);
  }
  if (/career|work|job|business|boss/.test(q)) {
    const s = planet('Saturn'), me = planet('Mercury');
    const tenth = chart.planets.filter((p) => p.house === 10).map((p) => p.name);
    anchors.push(`Saturn in ${s.sign} (house ${s.house})`, `10th house: ${tenth.join(', ') || 'empty'}`);
    let text = `${placementText('Saturn', s.sign, s.house)} Your 10th house — career and reputation — ${tenth.length ? `holds ${tenth.join(' and ')}` : 'holds no planets, so your work story is written more by choice than by fate'}.`;
    const hit = transits.find((t) => t.natal === 'Saturn' || t.transit === 'Saturn' || t.transit === 'Mercury');
    if (hit) { anchors.push(`transit: ${hit.transit} ${hit.aspect} ${hit.natal}`); text += ` Right now: ${hit.line}`; }
    return say(text, anchors);
  }
  if (/money|financ|cash|debt|pay/.test(q)) {
    const second = chart.planets.filter((p) => p.house === 2).map((p) => p.name);
    const j = planet('Jupiter');
    anchors.push(`2nd house: ${second.join(', ') || 'empty'}`, `Jupiter in ${j.sign} (house ${j.house})`);
    let text = `${houseText(2, second)} ${placementText('Jupiter', j.sign, j.house)}`;
    const hit = transits.find((t) => t.natal === 'Jupiter' || t.transit === 'Jupiter' || t.transit === 'Venus');
    if (hit) { anchors.push(`transit: ${hit.transit} ${hit.aspect} ${hit.natal}`); text += ` Today: ${hit.line}`; }
    return say(text, anchors);
  }
  if (/tarot|cards|card draw/.test(q)) {
    const draw = drawCards('three');
    anchors.push('fresh three-card draw');
    return say(draw.cards.map((c) =>
      `${c.position}: ${c.name}${c.reversed ? ' (reversed)' : ''} — ${c.meaning}`).join('\n'), anchors);
  }
  // Today / energy / feelings / anything else: lead with the live sky.
  const top = transits.slice(0, 3);
  top.forEach((t) => anchors.push(`transit: ${t.transit} ${t.aspect} ${t.natal} [${t.tag}]`));
  const m = planet('Moon');
  anchors.push(`Moon in ${m.sign} (house ${m.house})`);
  const text = (top.length
    ? `Here is what is actually moving over your chart today:\n${top.map((t) => `• [${t.tag}] ${t.line}`).join('\n')}\n`
    : 'The sky is quiet over your chart today. ') +
    `Underneath it all sits your Moon in ${m.sign}${m.house ? ` in your ${ordinalWord(m.house)} house` : ''} — your feelings, and what you need to feel settled — so days like this tend to land there first.`;
  return say(text, anchors);
}

function showAnswer(raw) {
  try {
    const { text, anchors } = answer(raw);
    console.log(`\nLuna: ${text}`);
    if (anchors.length) console.log(`  (anchored to: ${anchors.join(' · ')})`);
  } catch {
    console.log('\nLuna: Something snagged on my side — try asking that another way?');
  }
}

function banner() {
  console.log('✦ Luna — chat test harness');
  console.log(`Test chart: ${chartSummary()}`);
  console.log('\nToday\'s active transits:');
  console.log(transitFeed());
  console.log('\nAsk me something, or try /chart, /transits, /tarot, /help, /quit.');
}

const DEMO_QUESTIONS = [
  'How does this full moon look for my 2nd house?',
  'What is my energy like today?',
  'How is my love life looking?',
  'Anything I should know about my career right now?',
  'Draw my cards',
];

async function main() {
  banner();
  if (process.argv.includes('--demo')) {
    for (const q of DEMO_QUESTIONS) {
      console.log(`\nYou: ${q}`);
      showAnswer(q);
    }
    console.log('\nDemo complete.');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\nYou: ' });
  rl.prompt();
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) { rl.prompt(); return; }
    if (raw === '/quit' || raw === '/exit') { rl.close(); return; }
    if (raw === '/help') {
      console.log('Commands: /chart (your placements), /transits (today\'s sky), /tarot (three-card draw), /quit. Or just ask a question.');
    } else if (raw === '/chart') {
      console.log('\n' + chart.planets.map((p) => placementText(p.name, p.sign, p.house)).join('\n'));
    } else if (raw === '/transits') {
      console.log('\n' + transitFeed(10));
    } else if (raw === '/tarot') {
      showAnswer('draw my cards');
    } else if (raw.startsWith('/')) {
      console.log('Unknown command — /help lists what I know.');
    } else {
      showAnswer(raw);
    }
    rl.prompt();
  });
  rl.on('close', () => { console.log('\n✦ Until next time.'); });
}

if (require.main === module) {
  main().catch(() => { console.error('Luna failed to start.'); process.exit(1); });
}

module.exports = { answer, safeguard, chart, transits, moonNow, PIVOT, CRISIS };
