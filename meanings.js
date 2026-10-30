// Plain-language astrology for Luna.
//
// Her rule for the app: explain the sky the way a smart friend would —
// psychology, timing, and feelings, never textbook jargon, never doom.
// Every string here is written for someone who has never read an astrology
// book. The chart math lives in chart.js; this file is only the words.

const PLANET_PLAIN = {
  Sun: 'your core self — who you are and where you want to shine',
  Moon: 'your feelings, and what you need to feel safe and settled',
  Mercury: 'your mind — how you think, talk, and figure things out',
  Venus: 'love, attraction, money, and what you find beautiful',
  Mars: 'your drive and desire — how you go after what you want',
  Jupiter: 'growth and good fortune — where life wants to expand for you',
  Saturn: 'life lessons and slow, steady building — the work that lasts',
};

const SIGN_FLAVOR = {
  Aries: 'bold, direct, and first-to-act',
  Taurus: 'steady, sensual, and quietly stubborn',
  Gemini: 'curious, quick, and talkative',
  Cancer: 'protective and feeling-first',
  Leo: 'warm, expressive, and proud',
  Virgo: 'precise, thoughtful, and detail-driven',
  Libra: 'graceful and always weighing both sides',
  Scorpio: 'intense, private, and all-or-nothing',
  Sagittarius: 'honest, restless, and big-picture',
  Capricorn: 'patient, ambitious, and built for the long game',
  Aquarius: 'original, principled, and happily unconventional',
  Pisces: 'gentle, intuitive, and dream-fed',
};

const HOUSE_ARENA = {
  1: 'how you come across, and how you begin things',
  2: 'money, self-worth, and what you own',
  3: 'everyday conversations, siblings, and getting around',
  4: 'home, family, and your roots',
  5: 'romance, fun, children, and making things',
  6: 'daily work and your health habits',
  7: 'partnerships — love and business alike',
  8: 'shared money, deep intimacy, and big life changes',
  9: 'travel, learning, and your biggest beliefs',
  10: 'career, reputation, and the name you are making',
  11: 'friends, groups, and your plans for the future',
  12: 'rest, dreams, and everything running under the surface',
};

function placementText(planet, sign, house) {
  let text = `${planet} is ${PLANET_PLAIN[planet]}. In ${sign}, that energy runs ${SIGN_FLAVOR[sign]}.`;
  if (house) text += ` In your chart it plays out most around ${HOUSE_ARENA[house]}.`;
  return text;
}

function houseText(house, planetsThere) {
  let text = `Your ${ordinal(house)} house covers ${HOUSE_ARENA[house]}.`;
  text += planetsThere.length
    ? ` With ${planetsThere.join(' and ')} here, this is a busy, important part of your life.`
    : ' No planets sit here, so this area of life tends to run more quietly for you.';
  return text;
}

function risingText(sign) {
  return `Your rising sign is ${sign} — the face the world meets first, and the lens your whole chart is viewed through. ${sign} rising comes across ${SIGN_FLAVOR[sign]}, even on days you feel nothing like it inside. It also sets the order of your houses, which is what makes your chart uniquely yours rather than just your Sun sign's.`;
}

function ordinal(n) {
  return ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'][n - 1];
}

const ASPECT_VERB = {
  conjunction: 'merges with',
  sextile: 'gives a friendly lift to',
  square: 'pushes against',
  trine: 'flows easily with',
  opposition: 'pulls opposite',
};

const ASPECT_FEEL = {
  conjunction: 'The two blend into one loud theme — hard to ignore, in a good or intense way.',
  sextile: 'An easy opening: a small effort here gets a real return.',
  square: 'Expect some friction. It is the productive kind — it shows you exactly what needs adjusting.',
  trine: 'This tends to feel smooth and natural. Use it on purpose before it drifts by.',
  opposition: 'A tug-of-war between two needs. The win is balance, not picking a side.',
};

const TRANSIT_EFFECT = {
  Sun: 'It puts a spotlight on this part of you for a day or two.',
  Moon: 'It colors your mood for a few hours — feelings move fast, so feel them without obeying all of them.',
  Mercury: 'Words, messages, and decisions in this area carry extra weight right now.',
  Venus: 'Warmth and wanting gather here — good for connection; keep an eye on sweet impulse buys.',
  Mars: 'Energy and sparks: great for getting things done, easy to overheat in an argument.',
  Jupiter: 'A door feels wider than usual here. Saying yes to a reasonable stretch tends to pay off.',
  Saturn: 'Slow and serious. Whatever you build under this one is built to last — patience is the price.',
};

// One simple tag per transit so the feed scans at a glance.
function transitTag(transitPlanet, natalName, aspect) {
  const hard = aspect === 'square' || aspect === 'opposition';
  if (transitPlanet === 'Venus' || natalName === 'Venus') return 'Relationship Check';
  if ((transitPlanet === 'Mars' || transitPlanet === 'Saturn' || transitPlanet === 'Moon') &&
      hard && (natalName === 'Moon' || natalName === 'Sun')) return 'Low Energy Day';
  if (transitPlanet === 'Saturn' || transitPlanet === 'Mercury') return 'Career Focus';
  if (natalName === 'Moon' || transitPlanet === 'Moon') return 'Feelings Check';
  if (transitPlanet === 'Jupiter') return 'Growth Window';
  if (transitPlanet === 'Mars') return 'Energy & Drive';
  if (natalName === 'Mercury') return 'Mind & Messages';
  return 'Inner Weather';
}

function transitLine(transitPlanet, natalName, aspect) {
  return `${transitPlanet} ${ASPECT_VERB[aspect]} your ${natalName}. ` +
    `${TRANSIT_EFFECT[transitPlanet]} ${ASPECT_FEEL[aspect]}`;
}

module.exports = {
  PLANET_PLAIN, SIGN_FLAVOR, HOUSE_ARENA,
  placementText, houseText, risingText, transitTag, transitLine,
};
