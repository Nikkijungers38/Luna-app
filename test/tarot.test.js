// Tests for the tarot deck and draw (tarot.js). No network, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DECK, SPREADS, drawCards } = require('../tarot');

test('deck is a complete, unique 78-card tarot deck', () => {
  assert.equal(DECK.length, 78);
  assert.equal(new Set(DECK.map((c) => c.id)).size, 78);
  assert.equal(DECK.filter((c) => c.arcana === 'major').length, 22);
  assert.equal(DECK.filter((c) => c.arcana === 'minor').length, 56);
  for (const suit of ['Wands', 'Cups', 'Swords', 'Pentacles']) {
    assert.equal(DECK.filter((c) => c.suit === suit).length, 14, suit);
  }
  assert.ok(DECK.every((c) => c.name && c.upright && c.reversed));
});

test('major arcana run from The Fool to The World', () => {
  const majors = DECK.filter((c) => c.arcana === 'major');
  assert.equal(majors[0].name, 'The Fool');
  assert.equal(majors[21].name, 'The World');
});

test('draws return the spread positions with no duplicate cards', () => {
  for (let i = 0; i < 40; i++) {
    const three = drawCards('three');
    assert.deepEqual(three.cards.map((c) => c.position), SPREADS.three.positions);
    assert.equal(new Set(three.cards.map((c) => c.id)).size, 3);
    const one = drawCards('one');
    assert.equal(one.cards.length, 1);
    assert.equal(one.cards[0].position, 'Your card');
  }
});

test('each drawn card carries the meaning for its orientation', () => {
  const byId = new Map(DECK.map((c) => [c.id, c]));
  for (let i = 0; i < 40; i++) {
    for (const c of drawCards('three').cards) {
      const deckCard = byId.get(c.id);
      assert.equal(typeof c.reversed, 'boolean');
      assert.equal(c.meaning, c.reversed ? deckCard.reversed : deckCard.upright);
    }
  }
});

test('unknown spreads are rejected', () => {
  assert.equal(drawCards('celtic-cross'), null);
});
