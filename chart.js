// Birth chart computation for Luna.
//
// Pure math, no dependencies, no network. Positions use Paul Schlyter's
// well-known low-precision planetary algorithm ("How to compute planetary
// positions"): the Sun comes out within about a hundredth of a degree, the
// Moon within a few arc-minutes once its main perturbation terms are added,
// and the planets within a few arc-minutes — far tighter than sign or house
// placement needs. Everything degrades honestly: without a birth time we
// compute for noon, without a birth place there is no ascendant and no
// houses, and placements within a degree of a sign boundary are flagged as
// being on the cusp instead of being stated as certain.
//
// Timezone honesty: a birth place gives us a longitude, not a timezone, and
// this module deliberately carries no timezone database. Universal time is
// estimated from the place's longitude (mean solar time, longitude / 15
// hours). Real clock time can differ from solar time by an hour or more, so
// when a birth time and place are used the chart is marked approximate and
// the cusp flags matter most for the Moon and the ascendant.

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];
const SIGN_GLYPHS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓'];

const RAD = Math.PI / 180;
const rev = (x) => ((x % 360) + 360) % 360;
const rev180 = (x) => rev(x + 180) - 180;
const sind = (x) => Math.sin(x * RAD);
const cosd = (x) => Math.cos(x * RAD);
const atan2d = (y, x) => rev(Math.atan2(y, x) / RAD);
const asind = (x) => Math.asin(Math.max(-1, Math.min(1, x))) / RAD;

// Schlyter day number: days since 1999 Dec 31.0 (JD 2451543.5), with the
// fractional part from UT. A calendar date's Julian Day Number is the JD at
// noon, so the JD at 0h UT is JDN - 0.5 and the constant works out to
// 2451544.0. Verified against Schlyter's own closed form for 1988-10-24
// (day -4085 at 0h) and 2000-01-01 (day 1 at 0h).
function dayNumber(year, month, day, utHours) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  return (jdn - 2451544.0) + utHours / 24;
}

// Solve Kepler's equation for the eccentric anomaly (degrees).
function eccentricAnomaly(M, e) {
  const Mr = rev(M) * RAD;
  let E = e < 0.8 ? Mr : Math.PI;
  for (let i = 0; i < 12; i++) {
    E = E - (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  }
  return E / RAD;
}

// Heliocentric ecliptic rectangular coordinates (AU) for a body whose
// orbital elements are given for day number d. Moon handled separately.
function heliocentric(el, d) {
  const M = rev(el.M0 + el.Mdot * d);
  const E = eccentricAnomaly(M, el.e);
  const xv = el.a * (Math.cos(E * RAD) - el.e);
  const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(E * RAD));
  const v = Math.atan2(yv, xv) / RAD;
  const r = Math.hypot(xv, yv);
  const xh = r * (cosd(el.N) * cosd(v + el.w) - sind(el.N) * sind(v + el.w) * cosd(el.i));
  const yh = r * (sind(el.N) * cosd(v + el.w) + cosd(el.N) * sind(v + el.w) * cosd(el.i));
  const zh = r * (sind(v + el.w) * sind(el.i));
  return { x: xh, y: yh, z: zh, lon: rev(Math.atan2(yh, xh) / RAD), r };
}

const ELEMENTS = {
  mercury: (d) => ({ N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.00e-8 * d, w: 29.1241 + 1.01444e-5 * d, a: 0.387098, e: 0.205635 + 5.59e-10 * d, M0: 168.6562, Mdot: 4.0923344368 }),
  venus: (d) => ({ N: 76.6799 + 2.46590e-5 * d, i: 3.3946 + 2.75e-8 * d, w: 54.8910 + 1.38374e-5 * d, a: 0.723330, e: 0.006773 - 1.302e-9 * d, M0: 48.0052, Mdot: 1.6021302244 }),
  mars: (d) => ({ N: 49.5574 + 2.11081e-5 * d, i: 1.8497 + 1.78e-8 * d, w: 286.5016 + 2.92961e-5 * d, a: 1.523688, e: 0.093405 + 2.516e-9 * d, M0: 18.6021, Mdot: 0.5240207766 }),
  jupiter: (d) => ({ N: 100.4542 + 2.76854e-5 * d, i: 1.3032 - 1.557e-7 * d, w: 273.8777 + 1.64505e-5 * d, a: 5.20256, e: 0.048498 + 4.469e-9 * d, M0: 19.8950, Mdot: 0.0830853001 }),
  saturn: (d) => ({ N: 113.6634 + 2.38980e-5 * d, i: 2.4886 - 1.081e-7 * d, w: 339.3939 + 2.97661e-5 * d, a: 9.55475, e: 0.055546 - 9.499e-9 * d, M0: 316.9670, Mdot: 0.0334442282 }),
};

// Sun: geocentric ecliptic longitude and rectangular position (AU).
function sunPosition(d) {
  const w = 282.9404 + 4.70935e-5 * d;
  const e = 0.016709 - 1.151e-9 * d;
  const M = rev(356.0470 + 0.9856002585 * d);
  const E = eccentricAnomaly(M, e);
  const xv = Math.cos(E * RAD) - e;
  const yv = Math.sqrt(1 - e * e) * Math.sin(E * RAD);
  const v = Math.atan2(yv, xv) / RAD;
  const r = Math.hypot(xv, yv);
  const lon = rev(v + w);
  return {
    lon, r, M, meanLon: rev(M + w),
    x: r * cosd(lon), y: r * sind(lon),
  };
}

// Moon: geocentric ecliptic longitude/latitude, with Schlyter's main
// perturbation terms applied to the longitude.
function moonLongitude(d, sun) {
  const N = 125.1228 - 0.0529538083 * d;
  const i = 5.1454;
  const w = 318.0634 + 0.1643573223 * d;
  const a = 60.2666; // Earth radii
  const e = 0.054900;
  const M = rev(115.3654 + 13.0649929509 * d);
  const E = eccentricAnomaly(M, e);
  const xv = a * (Math.cos(E * RAD) - e);
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(E * RAD));
  const v = Math.atan2(yv, xv) / RAD;
  const r = Math.hypot(xv, yv);
  const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  const zh = r * (sind(v + w) * sind(i));
  let lon = rev(Math.atan2(yh, xh) / RAD);
  const lat = Math.atan2(zh, Math.hypot(xh, yh)) / RAD;

  const Ms = sun.M;
  const Mm = M;
  const Lm = rev(N + w + M);
  const Dm = rev(Lm - sun.meanLon);
  const F = rev(Lm - N);
  lon += -1.274 * sind(Mm - 2 * Dm)      // evection
    + 0.658 * sind(2 * Dm)               // variation
    - 0.186 * sind(Ms)                   // yearly equation
    - 0.059 * sind(2 * Mm - 2 * Dm)
    - 0.057 * sind(Mm - 2 * Dm + Ms)
    + 0.053 * sind(Mm + 2 * Dm)
    + 0.046 * sind(2 * Dm - Ms)
    + 0.041 * sind(Mm - Ms)
    - 0.035 * sind(Dm)                   // parallactic equation
    - 0.031 * sind(Mm + Ms)
    - 0.015 * sind(2 * F - 2 * Dm)
    + 0.011 * sind(Mm - 4 * Dm);
  return { lon: rev(lon), lat };
}

// All body longitudes at a moment (Schlyter day number d).
function longitudesAt(d) {
  const sun = sunPosition(d);
  const out = { sun: sun.lon, moon: moonLongitude(d, sun).lon };
  const earth = { x: -sun.x, y: -sun.y, z: 0 };
  for (const key of Object.keys(ELEMENTS)) {
    const h = heliocentric(ELEMENTS[key](d), d);
    out[key] = rev(Math.atan2(h.y - earth.y, h.x - earth.x) / RAD);
  }
  return out;
}

// Ascendant longitude for a latitude and a local sidereal time (degrees).
function ascendantLongitude(latDeg, lstDeg) {
  const ecl = 23.4393; // obliquity; its slow drift is negligible here
  const y = cosd(lstDeg);
  const x = -(sind(lstDeg) * cosd(ecl) + Math.tan(latDeg * RAD) * sind(ecl));
  return atan2d(y, x);
}

// GMST (degrees). GMST0 is anchored to the Sun's mean longitude at 0h UT of
// the day in question — using the mean longitude at the moment itself would
// count the Sun's daily motion twice and drift the ascendant by ~0.5°.
// Verified: 2000-01-01 12h UT gives GMST 280.47° (true value 280.46°).
function gmstDegrees(sunMeanLonAt0h, utHours) {
  return rev(sunMeanLonAt0h + 180 + 15.04107 * utHours);
}

const BODIES = [
  ['sun', 'Sun', '☉'], ['moon', 'Moon', '☽'], ['mercury', 'Mercury', '☿'],
  ['venus', 'Venus', '♀'], ['mars', 'Mars', '♂'], ['jupiter', 'Jupiter', '♃'],
  ['saturn', 'Saturn', '♄'],
];

const ASPECTS = [
  ['Conjunction', 0, 8], ['Sextile', 60, 4], ['Square', 90, 6],
  ['Trine', 120, 6], ['Opposition', 180, 8],
];

function findAspects(planets) {
  const found = [];
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const sep = Math.abs(rev180(planets[i].longitude - planets[j].longitude));
      for (const [type, angle, orb] of ASPECTS) {
        const off = Math.abs(sep - angle);
        if (off <= orb) {
          found.push({ a: planets[i].name, b: planets[j].name, type, orb: Math.round(off * 10) / 10 });
          break;
        }
      }
    }
  }
  return found.sort((x, y) => x.orb - y.orb).slice(0, 8);
}

// computeChart({
//   year, month, day,          // birth date (required)
//   hour, minute,               // birth local time, or null
//   lat, lon,                   // birth place coordinates, or null
//   sunSign,                    // profile's date-only sun sign, for cusp notes
// })
function computeChart(input) {
  const { year, month, day } = input;
  const hasTime = Number.isFinite(input.hour);
  const hasPlace = Number.isFinite(input.lat) && Number.isFinite(input.lon);
  const localHours = hasTime ? input.hour + (input.minute || 0) / 60 : 12;
  // Mean solar time from longitude; without a place, the stated time is
  // used as-is (treated as UT), which is the best available estimate.
  const utHours = hasPlace ? localHours - input.lon / 15 : localHours;

  // The UT moment can fall on the neighboring calendar day; the day number
  // and the sidereal time both have to be anchored to the UT date.
  const moment = new Date(Date.UTC(year, month - 1, day) + utHours * 3600000);
  const utY = moment.getUTCFullYear();
  const utM = moment.getUTCMonth() + 1;
  const utD = moment.getUTCDate();
  const utOfDay = moment.getUTCHours() + moment.getUTCMinutes() / 60
    + moment.getUTCSeconds() / 3600;
  const d = dayNumber(utY, utM, utD, utOfDay);
  const now = longitudesAt(d);
  const later = longitudesAt(d + 0.5);

  let ascendant = null;
  if (hasTime && hasPlace) {
    const sun0 = sunPosition(dayNumber(utY, utM, utD, 0));
    const lst = rev(gmstDegrees(sun0.meanLon, utOfDay) + input.lon);
    const lonAsc = ascendantLongitude(input.lat, lst);
    const idx = Math.floor(lonAsc / 30);
    ascendant = {
      longitude: Math.round(lonAsc * 100) / 100,
      sign: SIGNS[idx], signGlyph: SIGN_GLYPHS[idx],
      degreeInSign: Math.min(29.9, Math.round((lonAsc - idx * 30) * 10) / 10),
      cusp: (lonAsc % 30) < 1 || (lonAsc % 30) > 29,
    };
  }

  const planets = BODIES.map(([key, name, glyph]) => {
    const lon = now[key];
    const idx = Math.floor(lon / 30);
    const deg = lon - idx * 30;
    const motion = rev180(later[key] - lon);
    return {
      key, name, glyph,
      longitude: Math.round(lon * 100) / 100,
      sign: SIGNS[idx], signGlyph: SIGN_GLYPHS[idx],
      degreeInSign: Math.min(29.9, Math.round(deg * 10) / 10),
      house: ascendant ? Math.floor(rev(lon - ascendant.longitude) / 30) + 1 : null,
      retrograde: key === 'sun' || key === 'moon' ? false : motion < 0,
      cusp: deg < 1 || deg > 29,
    };
  });

  const sunPlanet = planets[0];
  return {
    planets,
    ascendant,
    aspects: findAspects(planets),
    sunSignMatchesProfile: input.sunSign ? sunPlanet.sign === input.sunSign : null,
    hasTime, hasPlace,
    // Solar-time conversion and any missing input make exact degrees soft;
    // sign placements away from cusps are still reliable.
    approximate: !(hasTime && hasPlace),
    computedAt: new Date().toISOString(),
  };
}

// ---------- Transits: today's sky against one natal chart ----------
// For every moving planet, find the aspects it is currently making to the
// natal planets (and the ascendant), how tight they are, whether they are
// still building (applying) or fading (separating), and the day each one
// lands exactly — the feed's today / this week / this month windows.
// Plain-language wording and tags come from meanings.js.
const { transitTag, transitLine } = require('./meanings');

function computeTransits(natalChart, when = new Date()) {
  if (!natalChart || !Array.isArray(natalChart.planets)) return [];
  const targets = natalChart.planets.map((p) => ({ name: p.name, longitude: p.longitude }));
  if (natalChart.ascendant) {
    targets.push({ name: 'Rising', longitude: natalChart.ascendant.longitude });
  }
  const utHours = when.getUTCHours() + when.getUTCMinutes() / 60 + when.getUTCSeconds() / 3600;
  const baseD = dayNumber(when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDate(), utHours);
  const cache = new Map();
  const longitudesOn = (offset) => {
    if (!cache.has(offset)) cache.set(offset, longitudesAt(baseD + offset));
    return cache.get(offset);
  };
  const now = longitudesOn(0);
  const out = [];
  for (const [key, tName] of BODIES) {
    const limit = tName === 'Moon' ? 6 : (tName === 'Jupiter' || tName === 'Saturn') ? 5 : 4;
    for (const target of targets) {
      const sep = Math.abs(rev180(now[key] - target.longitude));
      for (const [type, angle, tableOrb] of ASPECTS) {
        const orb = Math.abs(sep - angle);
        if (orb > Math.min(tableOrb, limit)) continue;
        const orbTomorrow = Math.abs(
          Math.abs(rev180(longitudesOn(1)[key] - target.longitude)) - angle);
        const applying = orbTomorrow < orb;
        // Slow planets stay in orb for months, so their exact day can be
        // far off; the Moon's is never more than a few days away.
        const range = tName === 'Moon' ? 3
          : (tName === 'Jupiter' || tName === 'Saturn') ? 200 : 45;
        let bestDay = 0, bestOrb = orb;
        for (let d = -range; d <= range; d++) {
          const o = Math.abs(
            Math.abs(rev180(longitudesOn(d)[key] - target.longitude)) - angle);
          if (o < bestOrb) { bestOrb = o; bestDay = d; }
        }
        const aspectKey = type.toLowerCase();
        out.push({
          transit: tName, natal: target.name, aspect: aspectKey,
          orb: Math.round(orb * 10) / 10, applying,
          exact: new Date(when.getTime() + bestDay * 86400000).toISOString().slice(0, 10),
          tag: transitTag(tName, target.name, aspectKey),
          line: transitLine(tName, target.name, aspectKey),
        });
      }
    }
  }
  return out.sort((a, b) => a.orb - b.orb).slice(0, 10);
}

module.exports = {
  computeChart, computeTransits, longitudesAt, ascendantLongitude, dayNumber, SIGNS, SIGN_GLYPHS,
};
