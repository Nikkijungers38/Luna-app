// Tarot for Luna: the full 78-card deck and the draw.
//
// Major arcana meanings are the standard Rider-Waite-Smith themes, written
// as one honest line each way. Minor arcana meanings are composed from the
// suit's realm and the rank's theme — the way readers actually learn them —
// which keeps all 56 minors accurate without a wall of hand-typed text.
// A draw is the visitor's moment of choice; randomness comes from the
// server's crypto source, never from anything the client can influence.

const crypto = require('crypto');

const MAJORS = [
  ['The Fool', 'a leap of faith, a beginning taken lightly and bravely', 'hesitation, or a leap taken without looking'],
  ['The Magician', 'skill, willpower, and having every tool you need already in hand', 'scattered focus, or a trick being played'],
  ['The High Priestess', 'intuition and a truth that is known before it is spoken', 'ignoring your inner voice, or a secret kept too long'],
  ['The Empress', 'abundance, comfort, and things growing under your care', 'creative block, or care given to everyone but yourself'],
  ['The Emperor', 'structure, protection, and taking steady charge', 'rigidity, or authority misused'],
  ['The Hierophant', 'tradition, guidance, and doing things the proven way', 'questioning the rules you were handed'],
  ['The Lovers', 'a bond, a union, and a choice made with the whole heart', 'disharmony, or a choice the heart is resisting'],
  ['The Chariot', 'momentum and victory through determination', 'loss of direction, or forcing something that resists'],
  ['Strength', 'quiet courage and patience winning over force', 'self-doubt, or a temper that needs gentling'],
  ['The Hermit', 'solitude that teaches, and wisdom found in the quiet', 'isolation that has gone on too long'],
  ['Wheel of Fortune', 'a turning point, luck shifting, cycles moving again', 'a run of setbacks, or resisting a change that is already here'],
  ['Justice', 'fairness, truth, and consequences arriving exactly as earned', 'an unfairness to name, or a truth being avoided'],
  ['The Hanged Man', 'a needed pause, and seeing everything differently from stillness', 'stalling, or a sacrifice that is no longer serving you'],
  ['Death', 'an ending that clears the ground for a genuine new chapter', 'clinging to what has already ended'],
  ['Temperance', 'balance, patience, and the middle path healing things', 'excess, or pieces of life that will not blend yet'],
  ['The Devil', 'a habit, attachment, or temptation holding more power than it should', 'breaking a pattern, loosening an unhealthy hold'],
  ['The Tower', 'a sudden shake-up that knocks down what was built on shaky ground', 'a collapse delayed, or rebuilding after the storm'],
  ['The Star', 'hope returning, healing, and a wish worth trusting', 'dimmed hope, or faith that needs tending'],
  ['The Moon', 'dreams, uncertainty, and things not yet what they seem', 'confusion lifting, or a fear finally named'],
  ['The Sun', 'joy, clarity, and warmth — a plain good chapter', 'joy delayed, or optimism that needs a reason'],
  ['Judgement', 'a calling, a reckoning, and rising to a truer version of your life', 'self-doubt muffling an important call'],
  ['The World', 'completion, wholeness, and a cycle finished well', 'a chapter nearly closed, one last piece unfinished'],
];

const SUITS = [
  ['Wands', 'fire — passion, ambition, and action', '♣'],
  ['Cups', 'water — love, feeling, and intuition', '♥'],
  ['Swords', 'air — mind, truth, and conflict', '♠'],
  ['Pentacles', 'earth — money, work, and the material world', '♦'],
];

const RANKS = [
  ['Ace', 'a new beginning, a pure gift of'],
  ['Two', 'a choice, a balance, or a partnership within'],
  ['Three', 'first growth and early results in'],
  ['Four', 'stability, rest, and holding steady in'],
  ['Five', 'friction, loss, or a hard test within'],
  ['Six', 'harmony, generosity, and things easing in'],
  ['Seven', 'assessment, patience, or holding your ground in'],
  ['Eight', 'movement, momentum, and swift change in'],
  ['Nine', 'resilience and a goal nearly reached in'],
  ['Ten', 'completion and lasting consequence in'],
  ['Page', 'curiosity, a message, or a fresh start as a beginner in'],
  ['Knight', 'pursuit — energy charging forward through'],
  ['Queen', 'quiet mastery and nurture of'],
  ['King', 'command, leadership, and responsibility over'],
];

function buildDeck() {
  const deck = [];
  MAJORS.forEach(([name, upright, reversed], i) => {
    deck.push({
      id: `major-${i}`, name, arcana: 'major', numeral: i,
      upright, reversed,
    });
  });
  for (const [suit, realm, glyph] of SUITS) {
    for (const [rank, theme] of RANKS) {
      deck.push({
        id: `${suit.toLowerCase()}-${rank.toLowerCase()}`,
        name: `${rank} of ${suit}`, arcana: 'minor', suit, glyph,
        upright: `${theme} ${realm}`,
        reversed: `blocked or turned inward: ${theme} ${realm}`,
      });
    }
  }
  return deck;
}

const DECK = buildDeck();

const SPREADS = {
  one: { label: 'One card', positions: ['Your card'] },
  three: { label: 'Past · Present · Future', positions: ['Past', 'Present', 'Future'] },
};

// Reversed cards appear about a third of the time: enough to matter, not
// so many that every draw reads as blocked.
function drawCards(spreadKey) {
  const spread = SPREADS[spreadKey];
  if (!spread) return null;
  const pool = [...DECK];
  const cards = spread.positions.map((position) => {
    const idx = crypto.randomInt(pool.length);
    const [card] = pool.splice(idx, 1);
    const isReversed = crypto.randomInt(3) === 0;
    // Fields are picked explicitly: the deck's `reversed` is a meaning
    // string, the draw's `reversed` is the orientation flag — spreading
    // the deck card would let the two collide.
    return {
      id: card.id, name: card.name, arcana: card.arcana,
      suit: card.suit || null, glyph: card.glyph || null,
      numeral: card.numeral === undefined ? null : card.numeral,
      position, reversed: isReversed,
      meaning: isReversed ? card.reversed : card.upright,
    };
  });
  return { spread: spreadKey, spreadLabel: spread.label, cards, at: new Date().toISOString() };
}

module.exports = { DECK, SPREADS, drawCards };
