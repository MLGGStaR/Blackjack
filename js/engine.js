/* Blackjack engine — pure game logic, no DOM.
 * Runs in the browser (global `BJ`) and in Node (module.exports) for tests.
 *
 * Rules implemented:
 *   - 6-deck shoe, Fisher–Yates shuffle with crypto randomness, cut card at ~75% penetration, burn card.
 *   - Blackjack pays 3:2. Dealer stands on all 17s (including soft 17).
 *   - Insurance offered when the dealer shows an Ace, pays 2:1. Dealer peeks for blackjack on A / 10-value.
 *   - Double on any first two cards. Split up to 4 hands; split aces get one card each. A 21 after a split is not a blackjack.
 *   - Dealer Bust side bet: pays 2:1 if the dealer busts with exactly 3 cards, 3:1 with 4 or more cards, otherwise loses.
 *   - Bet Behind: ride on another player's main hand; follows their doubles/splits when the bettor can afford it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BJ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const MAX_HANDS = 4;
  const MAX_SEATS = 7;

  // ---------- randomness ----------
  function secureRandomInt(n) {
    // Unbiased integer in [0, n) using rejection sampling over crypto randomness.
    if (n <= 1) return 0;
    const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    if (cryptoObj && cryptoObj.getRandomValues) {
      const buf = new Uint32Array(1);
      const limit = Math.floor(0x100000000 / n) * n;
      let x;
      do { cryptoObj.getRandomValues(buf); x = buf[0]; } while (x >= limit);
      return x % n;
    }
    return Math.floor(Math.random() * n);
  }

  // ---------- cards ----------
  function cardValue(rank) {
    if (rank === 'A') return 11;
    if (rank === 'K' || rank === 'Q' || rank === 'J') return 10;
    return parseInt(rank, 10);
  }

  function handValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
      total += cardValue(c.r);
      if (c.r === 'A') aces++;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, soft: aces > 0, bust: total > 21 };
  }

  function isNatural(cards) {
    return cards.length === 2 && handValue(cards).total === 21;
  }

  class Shoe {
    constructor(decks = 6, rng = secureRandomInt) {
      this.decks = decks;
      this.rng = rng;
      this.cards = [];
      this.cutRemaining = 0;
      this.needsShuffle = false;
      this.shuffles = 0;
      this.shuffle();
    }
    shuffle() {
      const cards = [];
      for (let d = 0; d < this.decks; d++)
        for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
      for (let i = cards.length - 1; i > 0; i--) {
        const j = this.rng(i + 1);
        const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
      }
      this.cards = cards;
      // Cut card leaves roughly 1.25–1.75 decks behind it (~72–80% penetration on 6 decks).
      const min = Math.floor(this.decks * 52 * 0.2), max = Math.floor(this.decks * 52 * 0.28);
      this.cutRemaining = min + this.rng(max - min + 1);
      this.burned = this.cards.pop();   // burn card
      this.needsShuffle = false;
      this.shuffles++;
    }
    draw() {
      if (this.cards.length === 0) this.shuffle();
      const c = this.cards.pop();
      if (this.cards.length <= this.cutRemaining) this.needsShuffle = true;
      return c;
    }
    get remaining() { return this.cards.length; }
    get total() { return this.decks * 52; }
  }

  // ---------- game ----------
  function makeHand(bet) {
    return { cards: [], bet, doubled: false, split: false, fromAces: false, done: false, natural: false, result: null, payout: 0, behind: {} };
  }

  class Game {
    constructor(opts = {}) {
      this.decks = opts.decks || 6;
      this.rng = opts.rng || secureRandomInt;
      this.shoe = new Shoe(this.decks, this.rng);
      this.phase = 'lobby';   // lobby | betting | insurance | playing | dealer | settled
      this.round = 0;
      this.players = [];      // seat order
      this.dealer = { cards: [], holeHidden: true, bust: false };
      this.turn = null;       // { pid, hand }
      this.log = [];
      this.lastResults = [];
      this.pendingBehind = {}; // pid -> {targetPid: amount}, resolved at deal
      this.hostId = opts.hostId || null;
      this.tableMin = 1;
    }

    // ----- lobby -----
    addPlayer(id, name) {
      if (this.players.find(p => p.id === id)) return this.players.find(p => p.id === id);
      const seated = this.players.filter(p => p.status !== 'spectating' && p.status !== 'left').length;
      const spectating = this.phase !== 'lobby' || seated >= MAX_SEATS;
      const p = {
        id, name: String(name || 'Player').slice(0, 16),
        bank: 1000, start: 1000,
        status: spectating ? 'spectating' : 'seated',   // seated | spectating | broke | left
        locked: false, sitOut: false,
        bets: { main: 0, bust: 0, behind: {} },
        insurance: null,      // null undecided, 0 declined, >0 amount
        hands: [],
        connected: true,
      };
      this.players.push(p);
      this._log(`${p.name} ${spectating ? 'is watching' : 'took a seat'}`);
      return p;
    }
    setBank(pid, amount) {
      const p = this.player(pid);
      if (!p || this.phase !== 'lobby') return false;
      amount = Math.max(1, Math.min(100000000, Math.round(amount)));
      p.bank = amount; p.start = amount;
      return true;
    }
    start() {
      if (this.phase !== 'lobby') return false;
      if (!this.players.some(p => p.status === 'seated')) return false;
      for (const p of this.players) p.start = p.bank;
      this._log('Table opened · 6-deck shoe');
      this._beginBetting();
      return true;
    }

    // ----- helpers -----
    player(pid) { return this.players.find(p => p.id === pid) || null; }
    seatedPlayers() { return this.players.filter(p => p.status === 'seated'); }
    _log(msg) { this.log.push(msg); if (this.log.length > 60) this.log.shift(); }

    // ----- betting -----
    _beginBetting() {
      this.round++;
      this.phase = 'betting';
      this.turn = null;
      this.dealer = { cards: [], holeHidden: true, bust: false };
      this.pendingBehind = {};
      // purge players who left, mark broke players
      this.players = this.players.filter(p => p.status !== 'left');
      for (const p of this.players) {
        p.hands = []; p.bets = { main: 0, bust: 0, behind: {} }; p.insurance = null; p.locked = false; p.sitOut = false;
        if (p.status === 'seated' && p.bank <= 0) { p.status = 'broke'; this._log(`${p.name} is out of chips`); }
      }
      if (this.shoe.needsShuffle) { this.shoe.shuffle(); this._log('Cut card reached · fresh shuffle'); }
    }

    // lock in bets: {main, bust, behind:{pid:amount}}; all optional; empty = sit out
    lockBets(pid, bets) {
      const p = this.player(pid);
      if (!p || this.phase !== 'betting' || p.status !== 'seated' || p.locked) return { ok: false, error: 'Cannot bet now' };
      const main = Math.max(0, Math.floor(bets.main || 0));
      const bust = Math.max(0, Math.floor(bets.bust || 0));
      const behind = {};
      let total = main + bust;
      for (const [tid, amt] of Object.entries(bets.behind || {})) {
        const a = Math.max(0, Math.floor(amt || 0));
        const t = this.player(tid);
        if (a > 0 && t && t.status === 'seated' && tid !== pid) { behind[tid] = a; total += a; }
      }
      if (total > p.bank) return { ok: false, error: 'Not enough chips' };
      p.bank -= total;
      p.bets = { main, bust, behind };
      p.locked = true;
      p.sitOut = total === 0;
      this._log(total === 0 ? `${p.name} sits this one out` : `${p.name} locked in $${fmt(total)}`);
      if (this.allLocked()) this.deal();
      return { ok: true };
    }
    allLocked() {
      const s = this.seatedPlayers();
      return s.length > 0 && s.every(p => p.locked);
    }
    // Host can force the deal; players who haven't locked sit out this round.
    forceDeal() {
      if (this.phase !== 'betting') return false;
      for (const p of this.seatedPlayers()) if (!p.locked) { p.locked = true; p.sitOut = true; }
      return this.deal();
    }

    // ----- deal -----
    deal() {
      if (this.phase !== 'betting') return false;
      const s = this.seatedPlayers();
      // refund behind bets on targets without a main bet
      for (const p of s) {
        for (const tid of Object.keys(p.bets.behind)) {
          const t = this.player(tid);
          if (!t || !t.locked || t.bets.main <= 0) { p.bank += p.bets.behind[tid]; delete p.bets.behind[tid]; }
        }
        p.sitOut = p.bets.main === 0 && p.bets.bust === 0 && Object.keys(p.bets.behind).length === 0;
      }
      const active = s.filter(p => p.bets.main > 0);
      const anyBet = s.some(p => !p.sitOut);
      if (!anyBet) {
        // nothing to deal — everybody sat out; go straight to a new betting round
        this._log('Nobody bet — new round');
        this._beginBetting();
        return false;
      }
      for (const p of active) {
        const h = makeHand(p.bets.main);
        for (const [bid, amt] of Object.entries(p.bets.behind)) void bid; // (behind bets ride on other players' hands)
        p.hands = [h];
      }
      // attach behind bets to target hands
      for (const p of s) for (const [tid, amt] of Object.entries(p.bets.behind)) {
        const t = this.player(tid);
        if (t && t.hands[0]) t.hands[0].behind[p.id] = amt;
      }
      // deal in casino order: one card each, dealer up, second card each, dealer hole
      for (const p of active) p.hands[0].cards.push(this.shoe.draw());
      this.dealer.cards.push(this.shoe.draw());
      for (const p of active) p.hands[0].cards.push(this.shoe.draw());
      this.dealer.cards.push(this.shoe.draw());
      this.dealer.holeHidden = true;
      for (const p of active) {
        const h = p.hands[0];
        if (isNatural(h.cards)) { h.natural = true; h.done = true; }
      }
      const up = this.dealer.cards[0];
      if (up.r === 'A') {
        this.phase = 'insurance';
        for (const p of active) p.insurance = null;
        this._log('Dealer shows an Ace · insurance?');
        this._checkInsuranceDone();
      } else if (cardValue(up.r) === 10) {
        this._peek();
      } else {
        this._startPlay();
      }
      return true;
    }

    // ----- insurance -----
    insurance(pid, take) {
      const p = this.player(pid);
      if (!p || this.phase !== 'insurance' || !p.hands.length || p.insurance !== null) return false;
      const amt = Math.floor(p.hands[0].bet / 2);
      if (take && p.bank >= amt && amt > 0) { p.bank -= amt; p.insurance = amt; this._log(`${p.name} takes insurance`); }
      else p.insurance = 0;
      this._checkInsuranceDone();
      return true;
    }
    _checkInsuranceDone() {
      const active = this.seatedPlayers().filter(p => p.hands.length);
      if (active.every(p => p.insurance !== null)) this._peek();
    }
    _peek() {
      if (isNatural(this.dealer.cards)) {
        this.dealer.holeHidden = false;
        this._log('Dealer has blackjack');
        for (const p of this.seatedPlayers()) for (const h of p.hands) h.done = true;
        this._settle();
      } else {
        for (const p of this.seatedPlayers()) if (p.insurance > 0) { this._log(`${p.name} loses insurance`); }
        this._startPlay();
      }
    }

    // ----- play -----
    _startPlay() {
      this.phase = 'playing';
      this._advance();
    }
    _advance() {
      for (const p of this.seatedPlayers().concat(this.players.filter(p => p.status === 'left'))) {
        for (let i = 0; i < p.hands.length; i++) {
          if (!p.hands[i].done) {
            if (p.status === 'left' || !p.connected) { p.hands[i].done = true; continue; }
            this.turn = { pid: p.id, hand: i };
            return;
          }
        }
      }
      this.turn = null;
      this._dealerPlay();
    }
    currentHand() {
      if (!this.turn) return null;
      const p = this.player(this.turn.pid);
      return p ? p.hands[this.turn.hand] : null;
    }
    canDouble(p, h) { return h.cards.length === 2 && !h.doubled && !h.fromAces && p.bank >= h.bet; }
    canSplit(p, h) {
      if (h.cards.length !== 2 || p.hands.length >= MAX_HANDS || h.fromAces || p.bank < h.bet) return false;
      const [a, b] = h.cards;
      return a.r === b.r || (cardValue(a.r) === 10 && cardValue(b.r) === 10);
    }
    act(pid, action) {
      if (this.phase !== 'playing' || !this.turn || this.turn.pid !== pid) return { ok: false, error: 'Not your turn' };
      const p = this.player(pid);
      const h = p.hands[this.turn.hand];
      if (!h || h.done) return { ok: false, error: 'Hand is finished' };
      switch (action) {
        case 'hit': {
          h.cards.push(this.shoe.draw());
          const v = handValue(h.cards);
          if (v.bust || v.total === 21) h.done = true;
          break;
        }
        case 'stand': h.done = true; break;
        case 'double': {
          if (!this.canDouble(p, h)) return { ok: false, error: 'Cannot double' };
          p.bank -= h.bet;
          // behind bettors double along if they can afford it
          for (const [bid, amt] of Object.entries(h.behind)) {
            const b = this.player(bid);
            if (b && b.bank >= amt) { b.bank -= amt; h.behind[bid] = amt * 2; }
          }
          h.bet *= 2; h.doubled = true;
          h.cards.push(this.shoe.draw());
          h.done = true;
          this._log(`${p.name} doubles down`);
          break;
        }
        case 'split': {
          if (!this.canSplit(p, h)) return { ok: false, error: 'Cannot split' };
          p.bank -= h.bet;
          const aces = h.cards[0].r === 'A';
          const h2 = makeHand(h.bet);
          h2.cards = [h.cards.pop()];
          h.split = true; h2.split = true;
          if (aces) { h.fromAces = true; h2.fromAces = true; }
          for (const [bid, amt] of Object.entries(h.behind)) {
            const b = this.player(bid);
            if (b && b.bank >= amt) { b.bank -= amt; h2.behind[bid] = amt; }
          }
          p.hands.splice(this.turn.hand + 1, 0, h2);
          h.cards.push(this.shoe.draw());
          h2.cards.push(this.shoe.draw());
          if (aces) { h.done = true; h2.done = true; }
          else {
            if (handValue(h.cards).total === 21) h.done = true;
            if (handValue(h2.cards).total === 21) h2.done = true;
          }
          this._log(`${p.name} splits`);
          break;
        }
        default: return { ok: false, error: 'Unknown action' };
      }
      this._advance();
      return { ok: true };
    }

    // ----- dealer -----
    _dealerPlay() {
      this.phase = 'dealer';
      this.dealer.holeHidden = false;
      const all = this.players.filter(p => p.hands.length || p.bets.bust > 0);
      const liveHand = all.some(p => p.hands.some(h => !handValue(h.cards).bust && !h.natural));
      const bustBets = all.some(p => p.bets.bust > 0);
      if (liveHand || bustBets) {
        let v = handValue(this.dealer.cards);
        while (v.total < 17) { this.dealer.cards.push(this.shoe.draw()); v = handValue(this.dealer.cards); }
        this.dealer.bust = v.bust;
      }
      this._settle();
    }

    // ----- settle -----
    _settle() {
      this.phase = 'settled';
      const d = handValue(this.dealer.cards);
      const dealerNatural = isNatural(this.dealer.cards);
      const results = [];
      const pay = (pid, amount, why) => {
        const p = this.player(pid);
        if (!p) return;
        p.bank += amount;
      };
      for (const p of this.players) {
        if (!p.hands.length && !p.bets.bust && !Object.keys(p.bets.behind).length && !p.insurance) continue;
        let net = 0;
        // insurance
        if (p.insurance > 0) {
          if (dealerNatural) { pay(p.id, p.insurance * 3); net += p.insurance * 2; }
          else net -= p.insurance;
        }
        for (const h of p.hands) {
          const v = handValue(h.cards);
          let mult; // multiplier on the bet returned (0 lose, 1 push, 2 win, 2.5 blackjack)
          if (v.bust) { h.result = 'bust'; mult = 0; }
          else if (h.natural && !dealerNatural) { h.result = 'blackjack'; mult = 2.5; }
          else if (dealerNatural) { h.result = h.natural ? 'push' : 'lose'; mult = h.natural ? 1 : 0; }
          else if (d.bust) { h.result = 'win'; mult = 2; }
          else if (v.total > d.total) { h.result = 'win'; mult = 2; }
          else if (v.total === d.total) { h.result = 'push'; mult = 1; }
          else { h.result = 'lose'; mult = 0; }
          h.payout = Math.floor(h.bet * mult);
          pay(p.id, h.payout);
          net += h.payout - h.bet;
          for (const [bid, amt] of Object.entries(h.behind)) {
            const bp = Math.floor(amt * mult);
            pay(bid, bp);
            const b = this.player(bid);
            if (b) { b._behindNet = (b._behindNet || 0) + bp - amt; }
          }
        }
        if (p.bets.bust > 0) {
          const n = this.dealer.cards.length;
          let m = 0;
          if (d.bust) m = n >= 4 ? 4 : 3;
          const bp = p.bets.bust * m;
          pay(p.id, bp);
          net += bp - p.bets.bust;
          p.bustResult = m ? `Dealer bust · ${m - 1} to 1` : 'Dealer stood';
        }
        p._net = net;
      }
      for (const p of this.players) {
        const net = (p._net || 0) + (p._behindNet || 0);
        if (p.hands.length || p.bets.bust || Object.keys(p.bets.behind).length) {
          results.push({ pid: p.id, name: p.name, net });
          this._log(`${p.name}: ${net >= 0 ? '+' : '−'}$${fmt(Math.abs(net))}`);
        }
        p.lastNet = net;
        delete p._net; delete p._behindNet;
      }
      this.lastResults = results;
      this.settledAt = Date.now();
    }

    nextRound() {
      if (this.phase !== 'settled') return false;
      for (const p of this.players) delete p.bustResult;
      this._beginBetting();
      return true;
    }

    // ----- leaving / spectating -----
    spectate(pid) {
      const p = this.player(pid);
      if (!p) return false;
      if (p.status === 'seated' && this.phase !== 'lobby' && this.phase !== 'betting' && p.hands.length) {
        // finish the hand for them first: they'll be moved after settle
        p.status = 'left'; p.leaveTo = 'spectating';
        for (const h of p.hands) h.done = true;
        if (this.turn && this.turn.pid === pid) this._advance();
        return true;
      }
      if (p.status === 'seated' && this.phase === 'betting' && p.locked) this._refundLocked(p);
      p.status = 'spectating'; p.hands = []; p.locked = false;
      this._log(`${p.name} is now watching`);
      if (this.phase === 'betting' && this.allLocked()) this.deal();
      return true;
    }
    rejoinSeat(pid) {
      const p = this.player(pid);
      if (!p || p.status !== 'spectating' || p.bank <= 0) return false;
      if (this.seatedPlayers().length >= MAX_SEATS) return false;
      p.status = 'seated'; p.locked = this.phase !== 'betting' ? true : false; p.sitOut = true;
      if (this.phase === 'betting') { p.locked = false; }
      this._log(`${p.name} takes a seat`);
      return true;
    }
    _refundLocked(p) {
      p.bank += p.bets.main + p.bets.bust + Object.values(p.bets.behind).reduce((a, b) => a + b, 0);
      p.bets = { main: 0, bust: 0, behind: {} };
    }
    leave(pid) {
      const p = this.player(pid);
      if (!p) return false;
      const midRound = this.phase === 'insurance' || this.phase === 'playing' || this.phase === 'dealer';
      if (midRound && (p.hands.length || p.bets.bust || Object.keys(p.bets.behind).length)) {
        p.status = 'left'; p.connected = false;
        for (const h of p.hands) h.done = true;
        if (p.insurance === null) p.insurance = 0;
        this._log(`${p.name} left the table`);
        if (this.phase === 'insurance') this._checkInsuranceDone();
        else if (this.turn && this.turn.pid === pid) this._advance();
        return true;
      }
      if (this.phase === 'betting' && p.locked) this._refundLocked(p);
      this.players = this.players.filter(x => x.id !== pid);
      this._log(`${p.name} left the table`);
      if (this.phase === 'betting' && this.allLocked()) this.deal();
      return true;
    }
    disconnect(pid) { return this.leave(pid); }

    // ----- serialization for clients -----
    snapshot(forPid) {
      void forPid;
      const players = this.players.filter(p => p.status !== 'left' || this.phase === 'settled' || this.phase === 'playing' || this.phase === 'dealer' || this.phase === 'insurance').map(p => ({
        id: p.id, name: p.name, bank: p.bank, start: p.start, status: p.status, locked: p.locked, sitOut: p.sitOut,
        bets: p.bets, insurance: p.insurance, lastNet: p.lastNet, bustResult: p.bustResult, connected: p.connected,
        hands: p.hands.map(h => ({ ...h, value: handValue(h.cards) })),
      }));
      const dealerCards = this.dealer.holeHidden
        ? this.dealer.cards.map((c, i) => (i === 1 ? { hidden: true } : c))
        : this.dealer.cards.slice();
      return {
        phase: this.phase, round: this.round, players, turn: this.turn,
        dealer: { cards: dealerCards, holeHidden: this.dealer.holeHidden, bust: this.dealer.bust,
          value: this.dealer.holeHidden ? handValue(this.dealer.cards.slice(0, 1)) : handValue(this.dealer.cards) },
        shoe: { remaining: this.shoe.remaining, total: this.shoe.total, decks: this.decks, shuffles: this.shoe.shuffles, cutRemaining: this.shoe.cutRemaining },
        log: this.log.slice(-12), lastResults: this.lastResults, hostId: this.hostId, settledAt: this.settledAt || 0,
      };
    }
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

  return { Game, Shoe, handValue, isNatural, cardValue, secureRandomInt, SUITS, RANKS, MAX_HANDS, MAX_SEATS, fmt };
});
