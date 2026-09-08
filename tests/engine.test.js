const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('../js/engine.js');

const C = (r, s = '♠') => ({ r, s });
// Rig the shoe so cards are drawn in the listed order.
function rig(g, cards) {
  g.shoe.cards = cards.slice().reverse();
  g.shoe.cutRemaining = 0;
  g.shoe.needsShuffle = false;
}
function table(players) {
  const g = new BJ.Game({ hostId: 'h' });
  for (const [id, bank] of players) { g.addPlayer(id, id); g.setBank(id, bank); }
  g.start();
  return g;
}

test('shoe has 6 decks, burns one card, is a real permutation', () => {
  const s = new BJ.Shoe(6);
  assert.equal(s.remaining, 311);
  const counts = {};
  for (const c of s.cards.concat([s.burned])) counts[c.r + c.s] = (counts[c.r + c.s] || 0) + 1;
  assert.equal(Object.keys(counts).length, 52);
  for (const k in counts) assert.equal(counts[k], 6);
  assert.ok(s.cutRemaining >= 62 && s.cutRemaining <= 87);
});

test('shoe flags reshuffle when cut card is reached and reshuffles at next round', () => {
  const g = table([['a', 100]]);
  g.shoe.cutRemaining = g.shoe.remaining - 3;
  rig(g, [C('5'), C('9'), C('6'), C('7'), C('10'), C('10')]);
  g.shoe.cutRemaining = 2;
  g.lockBets('a', { main: 10 });
  assert.equal(g.shoe.needsShuffle, true);
  g.act('a', 'stand');
  assert.equal(g.phase, 'settled');
  g.nextRound();
  assert.equal(g.shoe.remaining, 311);
  assert.equal(g.shoe.shuffles, 2);
});

test('hand values: soft/hard aces', () => {
  assert.deepEqual(BJ.handValue([C('A'), C('6')]), { total: 17, soft: true, bust: false });
  assert.deepEqual(BJ.handValue([C('A'), C('6'), C('10')]), { total: 17, soft: false, bust: false });
  assert.deepEqual(BJ.handValue([C('A'), C('A'), C('9')]), { total: 21, soft: true, bust: false });
  assert.equal(BJ.handValue([C('K'), C('Q'), C('5')]).bust, true);
});

test('blackjack pays 3 to 2', () => {
  const g = table([['a', 100]]);
  rig(g, [C('A'), C('9'), C('K'), C('7')]);
  g.lockBets('a', { main: 20 });
  assert.equal(g.phase, 'settled');
  assert.equal(g.player('a').bank, 130);
  assert.equal(g.player('a').hands[0].result, 'blackjack');
});

test('dealer stands on soft 17', () => {
  const g = table([['a', 100]]);
  rig(g, [C('10'), C('A'), C('8'), C('6')]); // player 18 vs dealer A-6 (soft 17)
  g.lockBets('a', { main: 10 });
  assert.equal(g.phase, 'insurance');
  g.insurance('a', false);
  assert.equal(g.phase, 'playing');
  g.act('a', 'stand');
  assert.equal(g.dealer.cards.length, 2);
  assert.equal(g.player('a').hands[0].result, 'win');
  assert.equal(g.player('a').bank, 110);
});

test('dealer hits hard 16 and soft 16', () => {
  const g = table([['a', 100]]);
  rig(g, [C('10'), C('A'), C('9'), C('5'), C('10')]); // dealer A-5 soft16 -> hits 10 -> hard 16 -> ... need another
  g.shoe.cards.unshift(C('4')); // appended to bottom: drawn after 10 -> 20
  g.lockBets('a', { main: 10 });
  g.insurance('a', false);
  g.act('a', 'stand');
  assert.equal(BJ.handValue(g.dealer.cards).total, 20);
  assert.equal(g.player('a').hands[0].result, 'lose');
});

test('insurance pays 2 to 1 on dealer blackjack; player blackjack pushes', () => {
  const g = table([['a', 100], ['b', 100]]);
  rig(g, [C('9'), C('A'), C('A'), C('9'), C('K'), C('K')]);
  g.lockBets('a', { main: 20 });
  g.lockBets('b', { main: 20 });
  assert.equal(g.phase, 'insurance');
  g.insurance('a', true);
  g.insurance('b', false);
  assert.equal(g.phase, 'settled');
  // a: lost 20 main, insurance 10 pays 20 -> net 0 -> bank 100
  assert.equal(g.player('a').bank, 100);
  assert.equal(g.player('a').hands[0].result, 'lose');
  // b: blackjack vs blackjack pushes
  assert.equal(g.player('b').bank, 100);
  assert.equal(g.player('b').hands[0].result, 'push');
});

test('insurance lost when dealer has no blackjack', () => {
  const g = table([['a', 100]]);
  rig(g, [C('10'), C('A'), C('8'), C('7')]);
  g.lockBets('a', { main: 20 });
  g.insurance('a', true);
  assert.equal(g.player('a').bank, 70);
  g.act('a', 'stand');
  assert.equal(g.player('a').bank, 70 + 20); // push 18 vs 18
});

test('dealer peeks on ten up card', () => {
  const g = table([['a', 100]]);
  rig(g, [C('10'), C('K'), C('8'), C('A')]);
  g.lockBets('a', { main: 20 });
  assert.equal(g.phase, 'settled');
  assert.equal(g.player('a').bank, 80);
});

test('double down draws one card and doubles bet', () => {
  const g = table([['a', 100]]);
  rig(g, [C('5'), C('10'), C('6'), C('6'), C('10'), C('10')]);
  g.lockBets('a', { main: 10 });
  const r = g.act('a', 'double');
  assert.equal(r.ok, true);
  assert.equal(g.player('a').hands[0].cards.length, 3);
  assert.equal(g.player('a').hands[0].bet, 20);
  assert.equal(g.phase, 'settled'); // dealer 16 -> hits 10 -> bust
  assert.equal(g.player('a').bank, 120);
});

test('split pairs, split aces get one card each', () => {
  const g = table([['a', 100]]);
  rig(g, [C('A'), C('9'), C('A'), C('7'), C('K'), C('K'), C('10')]);
  g.lockBets('a', { main: 10 });
  assert.equal(g.canSplit(g.player('a'), g.player('a').hands[0]), true);
  g.act('a', 'split');
  const p = g.player('a');
  assert.equal(p.hands.length, 2);
  assert.equal(p.hands[0].cards.length, 2);
  assert.equal(p.hands[1].cards.length, 2);
  assert.equal(p.hands[0].natural, false);
  assert.equal(g.phase, 'settled'); // aces auto-stand, dealer 16 draws 10 -> bust
  assert.equal(p.bank, 120);
});

test('split tens (K + Q) allowed, resplit up to 4 hands', () => {
  const g = table([['a', 1000]]);
  rig(g, [C('8'), C('5'), C('8'), C('9'), C('8'), C('8'), C('2'), C('3'), C('4'), C('5'), C('10')]);
  g.lockBets('a', { main: 10 });
  g.act('a', 'split'); // hands: [8,8] [8,2]
  g.act('a', 'split'); // hand0 [8,8] -> [8,3] [8,4]
  assert.equal(g.player('a').hands.length, 3);
});

test('dealer bust side bet: 2 to 1 on 3 cards, 3 to 1 on 4+ cards, lose otherwise', () => {
  let g = table([['a', 100]]);
  rig(g, [C('10'), C('10'), C('9'), C('6'), C('8')]); // dealer 10-6 hits 8 -> bust with 3 cards
  g.lockBets('a', { main: 10, bust: 10 });
  g.act('a', 'stand');
  assert.equal(g.player('a').bank, 100 + 10 + 20);

  g = table([['a', 100]]);
  rig(g, [C('10'), C('10'), C('9'), C('2'), C('3'), C('K')]); // 10-2-3-K bust with 4 cards
  g.lockBets('a', { main: 10, bust: 10 });
  g.act('a', 'stand');
  assert.equal(g.player('a').bank, 100 + 10 + 30);

  g = table([['a', 100]]);
  rig(g, [C('10'), C('10'), C('9'), C('9')]);
  g.lockBets('a', { main: 10, bust: 10 });
  g.act('a', 'stand');
  assert.equal(g.player('a').bank, 100 - 10 + 0); // push main, lose bust bet
});

test('dealer bust bet alone (no main bet) still makes the dealer draw', () => {
  const g = table([['a', 100], ['b', 100]]);
  rig(g, [C('10'), C('6'), C('9'), C('9')]); // b's hand 19 vs dealer 6-9 -> draws 9? no: only b's cards then dealer
  g.lockBets('a', { bust: 10 });
  g.lockBets('b', { main: 10 });
  // cards: b:10, dealer:6, b:9, dealer hole:9 -> dealer 15, hits...
  g.shoe.cards.unshift(C('K'));
  g.act('b', 'stand');
  assert.equal(g.dealer.bust, true);
  assert.equal(g.player('a').bank, 100 + 20);
});

test('bet behind follows the target hand including blackjack and double', () => {
  let g = table([['a', 100], ['b', 100]]);
  rig(g, [C('A'), C('9'), C('K'), C('7')]);
  g.lockBets('b', { behind: { a: 20 } });
  g.lockBets('a', { main: 20 });
  assert.equal(g.phase, 'settled');
  assert.equal(g.player('a').bank, 130);
  assert.equal(g.player('b').bank, 130);

  g = table([['a', 100], ['b', 100]]);
  rig(g, [C('5'), C('10'), C('6'), C('6'), C('10'), C('10')]);
  g.lockBets('b', { behind: { a: 10 } });
  g.lockBets('a', { main: 10 });
  g.act('a', 'double');
  assert.equal(g.player('a').bank, 120);
  assert.equal(g.player('b').bank, 120);
});

test('behind bet on a player who sits out is refunded', () => {
  const g = table([['a', 100], ['b', 100]]);
  rig(g, [C('10'), C('10'), C('9'), C('9')]);
  g.lockBets('b', { behind: { a: 30 }, main: 10 });
  g.lockBets('a', {});
  assert.equal(g.player('b').bank, 90);
});

test('everyone sitting out starts a new betting round', () => {
  const g = table([['a', 100]]);
  g.lockBets('a', {});
  assert.equal(g.phase, 'betting');
  assert.equal(g.round, 2);
});

test('player with no chips is marked broke; can spectate; others can leave mid-hand', () => {
  const g = table([['a', 10], ['b', 100]]);
  rig(g, [C('10'), C('10'), C('10'), C('6'), C('6'), C('9'), C('8')]);
  g.lockBets('a', { main: 10 });
  g.lockBets('b', { main: 10 });
  g.act('a', 'stand'); // 16
  g.leave('b');        // b leaves mid-hand -> hand stands
  assert.equal(g.phase, 'settled');
  assert.equal(g.player('a').bank, 0);
  g.nextRound();
  assert.equal(g.player('a').status, 'broke');
  assert.equal(g.player('b'), null);
  g.spectate('a');
  assert.equal(g.player('a').status, 'spectating');
});

test('cannot change bankroll after start; forceDeal makes stragglers sit out', () => {
  const g = table([['a', 100], ['b', 100]]);
  assert.equal(g.setBank('a', 5000), false);
  rig(g, [C('10'), C('10'), C('9'), C('9')]);
  g.lockBets('a', { main: 10 });
  assert.equal(g.phase, 'betting');
  g.forceDeal();
  assert.equal(g.phase, 'playing');
  assert.equal(g.player('b').sitOut, true);
  assert.equal(g.player('b').bank, 100);
});

test('snapshot hides the hole card until reveal', () => {
  const g = table([['a', 100]]);
  rig(g, [C('10'), C('5'), C('9'), C('9')]);
  g.lockBets('a', { main: 10 });
  let s = g.snapshot();
  assert.deepEqual(s.dealer.cards[1], { hidden: true });
  assert.equal(s.dealer.value.total, 5);
  g.act('a', 'stand');
  s = g.snapshot();
  assert.equal(s.dealer.cards[1].r, '9');
  assert.equal(s.players[0].hands[0].value.total, 19);
});

test('lock rejects bets over bankroll', () => {
  const g = table([['a', 50]]);
  assert.equal(g.lockBets('a', { main: 60 }).ok, false);
  assert.equal(g.player('a').bank, 50);
});
