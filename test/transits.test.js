// Tests for the transits engine (chart.js computeTransits) and the
// plain-language layer (meanings.js). No network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeChart, computeTransits } = require('../chart');
const { placementText, transitTag, transitLine } = require('../meanings');

const natal = computeChart({
  year: 1988, month: 10, day: 24, hour: 9, minute: 30, lat: 39.1502, lon: -123.2078,
});

test('transits come back sorted, tagged, and in plain language', () => {
  const list = computeTransits(natal, new Date('2026-10-30T15:00:00Z'));
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.ok(list.length <= 10);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].orb >= list[i - 1].orb);
  for (const t of list) {
    assert.ok(t.tag && t.line && /^\d{4}-\d{2}-\d{2}$/.test(t.exact));
    assert.ok(['conjunction', 'sextile', 'square', 'trine', 'opposition'].includes(t.aspect));
    assert.ok(!/degree|orb|aspect/i.test(t.line), 'feed lines stay jargon-free');
  }
});

test('the May 2000 Jupiter-Saturn conjunction registers against a chart point there', () => {
  // Jupiter and Saturn were both at ~52.6 degrees (22 Taurus) on 2000-05-28.
  const point = { planets: [{ name: 'Sun', longitude: 52.6 }], ascendant: null };
  const list = computeTransits(point, new Date('2000-05-28T12:00:00Z'));
  const hits = list.filter((t) => t.aspect === 'conjunction');
  assert.ok(hits.some((t) => t.transit === 'Jupiter'), JSON.stringify(list));
  assert.ok(hits.some((t) => t.transit === 'Saturn'), JSON.stringify(list));
});

test('bad charts produce an empty feed, never a crash', () => {
  assert.deepEqual(computeTransits(null), []);
  assert.deepEqual(computeTransits({}), []);
  assert.deepEqual(computeTransits({ planets: 'nope' }), []);
});

test('tags follow the simple rules a user would expect', () => {
  assert.equal(transitTag('Venus', 'Moon', 'trine'), 'Relationship Check');
  assert.equal(transitTag('Saturn', 'Sun', 'square'), 'Low Energy Day');
  assert.equal(transitTag('Saturn', 'Moon', 'trine'), 'Career Focus');
  assert.equal(transitTag('Jupiter', 'Mercury', 'sextile'), 'Growth Window');
  assert.match(transitLine('Mars', 'Venus', 'square'), /Mars pushes against your Venus/);
});

test('placement text names the planet, sign, and life area in plain words', () => {
  const text = placementText('Venus', 'Virgo', 10);
  assert.match(text, /Venus/);
  assert.match(text, /Virgo/);
  assert.match(text, /career/i);
});
