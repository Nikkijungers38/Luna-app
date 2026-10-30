// Tests for the synastry engine (synastry.js). No network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSynastry, crossAspects } = require('../synastry');
const { computeChart } = require('../chart');

const mk = (planets, ascLon) => ({
  planets: planets.map(([name, longitude]) => ({ name, longitude })),
  ascendant: ascLon === undefined ? null : { longitude: ascLon, sign: 'Aries' },
});

test('a Venus-Mars conjunction lands in chemistry and lifts it', () => {
  const a = mk([['Sun', 52], ['Moon', 301], ['Mercury', 83], ['Venus', 100], ['Mars', 204], ['Jupiter', 152], ['Saturn', 253]]);
  const b = mk([['Sun', 193], ['Moon', 25], ['Mercury', 262], ['Venus', 333], ['Mars', 100.5], ['Jupiter', 283], ['Saturn', 44]]);
  const s = computeSynastry(a, b);
  assert.ok(s.highlights.some((h) => h.category === 'chemistry' && h.type === 'conjunction'));
  assert.ok(s.categories.chemistry.score > 55, `chemistry ${s.categories.chemistry.score}`);
  for (const v of Object.values(s.categories)) {
    assert.ok(v.score >= 5 && v.score <= 98);
    assert.ok(typeof v.line === 'string' && v.line.length > 10);
  }
});

test('real charts produce all three categories and a big-three table', () => {
  const a = computeChart({ year: 1988, month: 10, day: 24, hour: 9, minute: 30, lat: 39.1502, lon: -123.2078 });
  const b = computeChart({ year: 1990, month: 5, day: 15, hour: 14, minute: 0, lat: 39.7392, lon: -104.9903 });
  const s = computeSynastry(a, b);
  assert.equal(s.bigThree.you.sun, 'Scorpio');
  assert.equal(s.bigThree.them.sun, 'Taurus');
  assert.ok(s.bigThree.you.rising && s.bigThree.them.rising);
  assert.equal(crossAspects(a, b).length > 0, true);
});

test('missing charts return null instead of crashing', () => {
  assert.equal(computeSynastry(null, null), null);
  assert.equal(computeSynastry({ planets: [] }, null), null);
});
