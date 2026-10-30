// Tests for the birth-chart math (chart.js). No network, no database.
//
// The anchors are chosen so they do not depend on trusting the new code:
//   - the Sun is cross-checked against the low-precision formula Luna has
//     run in production since launch (copied below as the reference),
//   - the Moon is checked against the app's own moon-phase reference moment
//     (new moon 2000-01-06 18:14 UTC) and the full moon that followed it,
//   - Mercury and Venus are checked against an astronomical invariant
//     (they can never be more than ~28 / ~47 degrees from the Sun),
//   - Jupiter and Saturn are checked against their known yearly motion,
//   - the ascendant is checked against horizon geometry at the equator.

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeChart, longitudesAt, ascendantLongitude, dayNumber } = require('../chart');

const rev = (x) => ((x % 360) + 360) % 360;
const sep = (a, b) => Math.abs(rev(a - b + 180) - 180);

// Reference: the production sunLongitude from server.js, unchanged.
function refSunLongitude(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const rad = Math.PI / 180;
  const L = 280.460 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * rad;
  const lam = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
  return ((lam % 360) + 360) % 360;
}

test('day number matches Schlyter closed-form anchors', () => {
  assert.equal(dayNumber(2000, 1, 1, 0), 1);
  assert.equal(dayNumber(1988, 10, 24, 0), -4085);
  assert.equal(dayNumber(2000, 1, 1, 12), 1.5);
});

test('sun agrees with the production formula across 1950-2030', () => {
  for (let i = 0; i < 40; i++) {
    const ms = Date.UTC(1950 + i * 2, (i * 3) % 12, (i * 7) % 28 + 1, 6, 0);
    const dt = new Date(ms);
    const d = dayNumber(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 6);
    const mine = longitudesAt(d).sun;
    const ref = refSunLongitude(ms);
    assert.ok(sep(mine, ref) < 1.0, `sun off by ${sep(mine, ref)} on ${dt.toISOString()}`);
  }
});

test('moon is with the sun at the reference new moon and opposite at full', () => {
  const newMoon = longitudesAt(dayNumber(2000, 1, 6, 18.23));
  assert.ok(sep(newMoon.moon, newMoon.sun) < 5, `new moon separation ${sep(newMoon.moon, newMoon.sun)}`);
  const fullMoon = longitudesAt(dayNumber(2000, 1, 21, 4.67));
  assert.ok(Math.abs(sep(fullMoon.moon, fullMoon.sun) - 180) < 5,
    `full moon separation ${sep(fullMoon.moon, fullMoon.sun)}`);
});

test('mercury and venus never stray far from the sun', () => {
  for (let i = 0; i < 60; i++) {
    const d = dayNumber(1990 + (i % 30), (i * 5) % 12 + 1, (i * 11) % 28 + 1, 12);
    const p = longitudesAt(d);
    assert.ok(sep(p.mercury, p.sun) <= 29, `mercury elongation ${sep(p.mercury, p.sun)}`);
    assert.ok(sep(p.venus, p.sun) <= 48, `venus elongation ${sep(p.venus, p.sun)}`);
  }
});

test('jupiter and saturn meet at the may 2000 great conjunction', () => {
  // The Jupiter-Saturn conjunction of May 28, 2000 sat at ~22.9 Taurus.
  const p = longitudesAt(dayNumber(2000, 5, 28, 12));
  assert.ok(sep(p.jupiter, 52.9) < 1.5, `jupiter at ${p.jupiter}`);
  assert.ok(sep(p.saturn, 52.9) < 1.5, `saturn at ${p.saturn}`);
  assert.ok(sep(p.jupiter, p.saturn) < 1.5, 'planets within orb of each other');
});

test('outer planets come back around on their orbital periods', () => {
  const start = longitudesAt(dayNumber(2000, 1, 1, 12));
  const jupiterReturn = longitudesAt(dayNumber(2011, 11, 20, 12)); // ~11.86 yr
  assert.ok(sep(jupiterReturn.jupiter, start.jupiter) < 15,
    `jupiter ${start.jupiter} -> ${jupiterReturn.jupiter}`);
  const saturnReturn = longitudesAt(dayNumber(2029, 6, 15, 12)); // ~29.46 yr
  assert.ok(sep(saturnReturn.saturn, start.saturn) < 15,
    `saturn ${start.saturn} -> ${saturnReturn.saturn}`);
});

test('ascendant geometry at the equator', () => {
  // At 0h local sidereal time on the equator the ascendant is 0 Cancer.
  assert.ok(sep(ascendantLongitude(0, 0), 90) < 0.5);
  // A quarter-turn of sidereal time later it stands opposite the MC point.
  assert.ok(sep(ascendantLongitude(0, 90), 180) < 0.5);
});

test('sun signs for known birthdays', () => {
  const scorpio = computeChart({ year: 1988, month: 10, day: 24 });
  assert.equal(scorpio.planets[0].sign, 'Scorpio');
  const capricorn = computeChart({ year: 2000, month: 1, day: 1 });
  assert.equal(capricorn.planets[0].sign, 'Capricorn');
});

test('chart degrades honestly without time or place', () => {
  const bare = computeChart({ year: 1990, month: 6, day: 15 });
  assert.equal(bare.ascendant, null);
  assert.equal(bare.approximate, true);
  assert.ok(bare.planets.every((p) => p.house === null));
  assert.equal(bare.planets.length, 7);

  const full = computeChart({
    year: 1988, month: 10, day: 24, hour: 9, minute: 30, lat: 39.15, lon: -123.21,
  });
  assert.ok(full.ascendant, 'ascendant computed with time and place');
  assert.equal(full.approximate, false);
  assert.ok(full.planets.every((p) => p.house >= 1 && p.house <= 12));
});

test('new moon chart shows a sun-moon conjunction', () => {
  const c = computeChart({ year: 2000, month: 1, day: 6, hour: 18, minute: 14 });
  assert.ok(c.aspects.some((a) => a.type === 'Conjunction'
    && ((a.a === 'Sun' && a.b === 'Moon') || (a.a === 'Moon' && a.b === 'Sun'))),
  `aspects: ${JSON.stringify(c.aspects)}`);
});
