// Synastry for Luna: two birth charts laid over each other.
//
// Every planet in chart A is compared with every planet in chart B; the
// cross-aspects that land are sorted into the three stories a relationship
// actually tells — Communication, Romantic Chemistry, and Long-Term
// Growth — and each story gets a 0-100 score built from how many of those
// aspects there are, how harmonious they run, and how tightly they land.
// Scores start at a neutral 50 and move with the evidence; a category with
// no real contacts stays near neutral instead of pretending.

const REV180 = (x) => {
  const r = ((x % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
};

const ASPECTS = [
  ['conjunction', 0, 7], ['sextile', 60, 4], ['square', 90, 5],
  ['trine', 120, 6], ['opposition', 180, 7],
];
const HARMONY = { conjunction: 0.8, sextile: 1, trine: 1, square: -0.8, opposition: -0.5 };

const CATEGORY_OF = (a, b) => {
  const pair = [a, b].sort().join('-');
  if (['Mercury-Mercury', 'Mercury-Moon', 'Mercury-Sun', 'Mercury-Venus', 'Moon-Moon'].includes(pair)) return 'communication';
  if (['Mars-Venus', 'Moon-Sun', 'Venus-Venus', 'Moon-Venus', 'Mars-Moon', 'Mars-Mars'].includes(pair)) return 'chemistry';
  if (a === 'Saturn' || b === 'Saturn' || a === 'Jupiter' || b === 'Jupiter') return 'growth';
  return null;
};

const LINES = {
  communication: {
    good: 'You tend to hear each other the first time — talking things through is a strength here, not a chore.',
    hard: 'You translate each other imperfectly: the same words land differently. Patience and repeating back what you heard go a long way.',
    mixed: 'Some conversations flow and some snag — usually around feelings versus facts.',
  },
  chemistry: {
    good: 'There is an easy, natural pull between you — attraction that does not have to force itself.',
    hard: 'Real heat, but it can flare into friction just as fast. The spark and the argument come from the same place.',
    mixed: 'The pull is there, with a few rough edges that keep it interesting rather than simple.',
  },
  growth: {
    good: 'This connection helps both of you build — it steadies more than it storms.',
    hard: 'This bond will test you both. Handled honestly, the testing is exactly how it makes you grow.',
    mixed: 'Some parts of this bond build you up; others ask hard questions. Both are doing work.',
  },
};

function crossAspects(chartA, chartB) {
  const found = [];
  for (const pa of chartA.planets) {
    for (const pb of chartB.planets) {
      const sep = Math.abs(REV180(pa.longitude - pb.longitude));
      for (const [type, angle, maxOrb] of ASPECTS) {
        const orb = Math.abs(sep - angle);
        if (orb <= maxOrb) {
          found.push({
            a: pa.name, b: pb.name, type, orb: Math.round(orb * 10) / 10,
            category: CATEGORY_OF(pa.name, pb.name),
            weight: (1 - orb / (maxOrb * 2)) * HARMONY[type],
          });
          break;
        }
      }
    }
  }
  return found.sort((x, y) => x.orb - y.orb);
}

function scoreCategory(aspects) {
  if (!aspects.length) return { score: 50, tone: 'quiet' };
  const sum = aspects.reduce((acc, a) => acc + a.weight, 0);
  const score = Math.max(5, Math.min(98, Math.round(58 + sum * 11)));
  const tone = sum > 0.8 ? 'good' : sum < -0.8 ? 'hard' : 'mixed';
  return { score, tone };
}

function computeSynastry(chartA, chartB) {
  if (!chartA || !chartB || !Array.isArray(chartA.planets) || !Array.isArray(chartB.planets)) return null;
  const all = crossAspects(chartA, chartB);
  const categories = {};
  for (const key of ['communication', 'chemistry', 'growth']) {
    const inCat = all.filter((a) => a.category === key);
    const { score, tone } = scoreCategory(inCat);
    categories[key] = {
      score, contacts: inCat.length,
      line: tone === 'quiet'
        ? 'No strong contacts here — this part of the connection is unwritten, for you two to write yourselves.'
        : LINES[key][tone],
    };
  }
  const highlights = all
    .filter((a) => a.category)
    .slice(0, 6)
    .map((a) => ({
      a: a.a, b: a.b, type: a.type, orb: a.orb, category: a.category,
      line: LINES[a.category][a.weight > 0.3 ? 'good' : a.weight < -0.3 ? 'hard' : 'mixed'],
    }));
  const bigThree = (c) => ({
    sun: c.planets.find((p) => p.name === 'Sun')?.sign || null,
    moon: c.planets.find((p) => p.name === 'Moon')?.sign || null,
    rising: c.ascendant ? c.ascendant.sign : null,
  });
  return { categories, highlights, bigThree: { you: bigThree(chartA), them: bigThree(chartB) } };
}

module.exports = { computeSynastry, crossAspects };
