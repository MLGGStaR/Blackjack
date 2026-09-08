/* App — screens, rendering, and the host/guest glue around the engine. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HOST_ID = 'host';
  const CHIPS = [1, 5, 25, 100, 500, 1000, 5000];
  const NEXT_ROUND_MS = 8000;
  // Animation timing: cards go out one at a time in casino order, the hole card flips,
  // dealer draws follow, then results pop.
  const DEAL_STEP = 420, DRAW_STEP = 900, FLIP_MS = 800;

  const app = {
    role: null, name: '', myId: null, code: '',
    game: null, host: null, guest: null, state: null,
    status: { level: 'offline', text: '' },
    pending: { main: 0, bust: 0, behind: {} }, chipSel: 25, undo: [], lastBets: null,
    seen: new Set(), nextTimer: null, tick: null, lastRound: 0, pnlShown: null, bankShown: null,
  };
  window.app = app; // for debugging

  const money = (n) => '$' + BJ.fmt(Math.abs(n));
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(n);
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

  function show(screen) {
    for (const id of ['screen-home', 'screen-lobby', 'screen-table']) $(id).hidden = id !== 'screen-' + screen;
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function setStatus(level, text) {
    app.status = { level, text };
    const line = $('lobby-status');
    line.querySelector('.dot').className = 'dot ' + level;
    line.lastElementChild.textContent = text;
    $('table-dot').className = 'dot ' + level;
  }

  // ---------------- host ----------------
  function startHost(name) {
    app.role = 'host'; app.name = name; app.myId = HOST_ID;
    app.game = new BJ.Game({ hostId: HOST_ID });
    app.game.addPlayer(HOST_ID, name);
    app.host = new Net.Host({
      onGuestJoin(id, guestName) {
        const p = app.game.addPlayer(id, guestName || 'Guest');
        app.host.send(id, { type: 'welcome', id, code: app.host.code, name: p.name });
        pushState();
      },
      onGuestAction(id, action, payload) { applyAction(id, action, payload); pushState(); },
      onGuestLeave(id) { app.game.disconnect(id); pushState(); },
      onStatus(level, text, code) { setStatus(level, text); app.code = code; $('lobby-code').textContent = code; $('table-code').textContent = code; },
    });
    app.code = app.host.code;
    $('lobby-code').textContent = app.code; $('table-code').textContent = app.code;
    pushState();
  }
  function pushState() {
    app.state = app.game.snapshot();
    if (app.host) app.host.broadcast({ type: 'state', state: app.state });
    scheduleNextRound();
    render();
  }
  function scheduleNextRound() {
    if (!app.game) return;
    if (app.game.phase === 'settled' && !app.nextTimer) {
      app.nextTimer = setTimeout(() => { app.nextTimer = null; app.game.nextRound(); pushState(); }, NEXT_ROUND_MS);
    } else if (app.game.phase !== 'settled' && app.nextTimer) { clearTimeout(app.nextTimer); app.nextTimer = null; }
  }
  function applyAction(pid, action, payload) {
    const g = app.game; payload = payload || {};
    const isHost = pid === HOST_ID;
    let r;
    switch (action) {
      case 'setBank': g.setBank(pid, Number(payload.amount)); break;
      case 'start': if (isHost) g.start(); break;
      case 'lock': r = g.lockBets(pid, payload); break;
      case 'forceDeal': if (isHost) g.forceDeal(); break;
      case 'insurance': g.insurance(pid, !!payload.take); break;
      case 'play': r = g.act(pid, payload.action); break;
      case 'next': if (isHost && g.phase === 'settled') { clearTimeout(app.nextTimer); app.nextTimer = null; g.nextRound(); } break;
      case 'spectate': g.spectate(pid); break;
      case 'sit': g.rejoinSeat(pid); break;
      case 'leave': g.leave(pid); if (!isHost && app.host) app.host.kick(pid, 'left'); break;
      default: break;
    }
    if (r && r.ok === false) {
      if (isHost) toast(r.error); else if (app.host) app.host.send(pid, { type: 'toast', msg: r.error });
    }
  }

  // ---------------- guest ----------------
  function joinGame(name, code) {
    app.role = 'guest'; app.name = name; app.code = code;
    $('home-error').hidden = true;
    $('btn-join').disabled = true; $('btn-join').textContent = 'Connecting…';
    app.guest = new Net.Guest({
      code, name,
      onWelcome(msg) {
        app.myId = msg.id;
        $('lobby-code').textContent = code; $('table-code').textContent = code;
        setStatus('online', 'Connected to ' + code);
        $('btn-join').disabled = false; $('btn-join').textContent = 'Join friends';
      },
      onState(state) { app.state = state; render(); },
      onKicked(reason) { goHome(reason === 'left' ? '' : 'The host closed the table.'); },
      onError(msg) { $('btn-join').disabled = false; $('btn-join').textContent = 'Join friends'; $('home-error').textContent = msg; $('home-error').hidden = false; app.guest = null; },
      onClosed() { if (app.role === 'guest') goHome('Connection to the table was lost.'); },
    });
    if (app.guest && app.guest.conn === null && typeof Peer !== 'undefined') setStatus('connecting', 'Connecting…');
  }

  function dispatch(action, payload) {
    if (app.role === 'host') { applyAction(HOST_ID, action, payload); pushState(); }
    else if (app.guest) app.guest.act(action, payload);
  }

  function goHome(message) {
    if (app.host) { app.host.broadcast({ type: 'kicked', reason: 'closed' }); app.host.destroy(); }
    if (app.guest) app.guest.destroy();
    clearTimeout(app.nextTimer); clearInterval(app.tick);
    Object.assign(app, { role: null, myId: null, game: null, host: null, guest: null, state: null, nextTimer: null, tick: null, seen: new Set(), pending: { main: 0, bust: 0, behind: {} }, undo: [], lastBets: null, pnlShown: null, bankShown: null });
    show('home');
    if (message) { $('home-error').textContent = message; $('home-error').hidden = false; }
  }

  // ---------------- render ----------------
  function me() { return app.state ? app.state.players.find((p) => p.id === app.myId) : null; }

  function render() {
    const s = app.state; if (!s) return;
    if (s.phase === 'lobby') { show('lobby'); renderLobby(s); return; }
    if (s.round !== app.lastRound) { app.lastRound = s.round; clearPending(); }
    show('table');
    renderTable(s);
  }

  // ----- lobby -----
  function stepFor(amount, dir) {
    const a = amount;
    let step;
    if (dir < 0) step = a <= 1000 ? 100 : a <= 10000 ? 500 : a <= 100000 ? 1000 : 10000;
    else step = a < 1000 ? 100 : a < 10000 ? 500 : a < 100000 ? 1000 : 10000;
    const next = dir < 0 ? Math.max(100, Math.ceil((a - step) / step) * step) : Math.floor((a + step) / step) * step;
    return Math.max(1, next);
  }
  function renderLobby(s) {
    const isHost = app.role === 'host';
    const root = $('lobby-players');
    const html = s.players.map((p) => {
      const mine = p.id === app.myId;
      const who = `<div class="who">${esc(p.name)}${p.id === s.hostId ? '<small>host</small>' : ''}${mine ? '<small>you</small>' : ''}</div>`;
      const right = mine
        ? `<div class="stepper"><button data-step="-1" aria-label="Less">−</button><input type="text" inputmode="numeric" id="bank-input" value="${BJ.fmt(p.bank)}" aria-label="Your buy-in"><button data-step="1" aria-label="More">+</button></div>`
        : `<div class="amount">${money(p.bank)}</div>`;
      return `<div class="lobby-player${mine ? ' me' : ''}" data-id="${p.id}">${who}${right}</div>`;
    }).join('');
    if (root.dataset.html !== html) {
      // keep the input's value if the user is typing
      const focused = document.activeElement && document.activeElement.id === 'bank-input' ? document.activeElement.value : null;
      root.innerHTML = html; root.dataset.html = html;
      if (focused !== null) { const i = $('bank-input'); if (i) { i.value = focused; i.focus(); } }
    }
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = !s.players.some((p) => p.status === 'seated');
    $('lobby-wait').hidden = isHost;
  }
  (function bindStepper() {
    const root = $('lobby-players');
    let holdTimer = null, repeat = null;
    function apply(dir) {
      const m = me(); if (!m) return;
      const input = $('bank-input');
      const cur = parseInt((input && input.value || '').replace(/[^0-9]/g, ''), 10) || m.bank;
      const next = stepFor(cur, dir);
      if (input) input.value = BJ.fmt(next);
      dispatch('setBank', { amount: next });
    }
    root.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button[data-step]'); if (!b) return;
      const dir = Number(b.dataset.step);
      apply(dir);
      holdTimer = setTimeout(() => { repeat = setInterval(() => apply(dir), 90); }, 450);
    });
    const stop = () => { clearTimeout(holdTimer); clearInterval(repeat); holdTimer = repeat = null; };
    root.addEventListener('pointerup', stop); root.addEventListener('pointerleave', stop); root.addEventListener('pointercancel', stop);
    root.addEventListener('change', (e) => {
      if (e.target.id !== 'bank-input') return;
      const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10);
      if (v > 0) dispatch('setBank', { amount: v }); else e.target.value = BJ.fmt((me() || {}).bank || 1000);
    });
  })();

  // ----- table pieces -----
  function isNew(key) {
    if (!key) return false;
    if (app.seen.has(key)) return false;
    app.seen.add(key); return true;
  }
  const SUIT_NAME = { '♠': 'spade', '♥': 'heart', '♦': 'diamond', '♣': 'club' };
  function cardHTML(c, key, delay) {
    const fresh = isNew(key);
    const style = fresh && delay ? ` style="--delay:${delay}ms"` : '';
    if (!c || c.hidden) return `<div class="card back${fresh ? ' deal' : ''}"${style}></div>`;
    const face = c.r === 'K' || c.r === 'Q' || c.r === 'J' || c.r === 'A';
    return `<div class="card${fresh ? ' deal' : ''} ${SUIT_NAME[c.s]}" data-suit="${c.s}"${style}>
      <span class="corner"><b>${c.r}</b><i>${c.s}</i></span>
      <span class="pip${face ? ' face' : ''}">${face ? c.r : c.s}</span>
      <span class="corner flip"><b>${c.r}</b><i>${c.s}</i></span>
    </div>`;
  }
  function valueTag(v, h, phase, key, delay) {
    if (!v) return '';
    let text = v.total + (v.soft && v.total < 21 && !v.bust ? ' soft' : '');
    let k = '';
    if (h && h.natural) { text = 'Blackjack'; k = 'bj'; }
    if (v.bust) { text = 'Bust'; k = 'bust'; }
    if (h && phase === 'settled' && h.result) {
      k = { win: 'win', blackjack: 'bj', lose: 'lose', push: 'push', bust: 'bust' }[h.result] || '';
      text = { win: 'Win ' + money(h.payout - h.bet), blackjack: 'Blackjack ' + money(h.payout - h.bet), lose: 'Lose', push: 'Push', bust: 'Bust' }[h.result];
    }
    const fresh = isNew(key + ':' + text);
    return `<span class="hand-value ${k}${fresh ? ' anim' : ''}"${fresh && delay ? ` style="--tag-delay:${delay}ms"` : ''}>${text}</span>`;
  }
  function chipClass(n) { return 'd' + (CHIPS.slice().reverse().find((c) => n >= c) || 1); }
  function chipLabel(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K' : String(n); }
  // A stack of chips for an amount: greedy split into denominations, top chip shows the total.
  function stack(amount, extraClass) {
    if (!amount) return '';
    const parts = [];
    let left = amount;
    for (const d of CHIPS.slice().reverse()) while (left >= d && parts.length < 8) { parts.push(d); left -= d; }
    parts.reverse();
    return `<span class="stack${extraClass ? ' ' + extraClass : ''}" style="--n:${parts.length}">${parts.map((d, i) => `<span class="chip ${chipClass(d)}" style="--i:${i}">${i === parts.length - 1 ? chipLabel(amount) : ''}</span>`).join('')}</span>`;
  }
  // Cards fly in from the shoe: measure once per fresh card, then restart its animation.
  function aimCardsFromShoe() {
    const shoe = $('shoe-box'); if (!shoe) return;
    const cards = document.querySelectorAll('.card.deal:not([data-aimed])');
    if (!cards.length) return;
    const sr = shoe.getBoundingClientRect();
    for (const el of cards) {
      el.dataset.aimed = '1';
      el.style.animation = 'none';
      const r = el.getBoundingClientRect();
      el.style.setProperty('--dx', (sr.left + sr.width / 2 - r.left - r.width / 2) + 'px');
      el.style.setProperty('--dy', (sr.top + sr.height / 2 - r.top - r.height / 2) + 'px');
      el.style.animation = '';
    }
  }
  // Counters tick toward their new value instead of jumping.
  const rafs = {};
  function tickNumber(id, key, target, format, className) {
    const el = $(id);
    if (typeof app[key] !== 'number') { app[key] = target; el.textContent = format(target); if (className) el.className = className(target); return; }
    if (app[key] === target) { if (className) el.className = className(target); return; }
    cancelAnimationFrame(rafs[id]);
    const from = app[key], t0 = performance.now(), dur = 700;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(from + (target - from) * e);
      el.textContent = format(v); if (className) el.className = className(v) + ' bump';
      app[key] = v;
      if (k < 1) rafs[id] = requestAnimationFrame(step); else app[key] = target;
    };
    rafs[id] = requestAnimationFrame(step);
  }

  // ----- table -----
  function renderTable(s) {
    const meP = me();
    const seated = s.players.filter((p) => p.status === 'seated' || p.status === 'broke' || (p.status === 'left' && p.hands.length));
    const active = seated.filter((p) => p.hands.length);
    const n = active.length;

    // --- timing plan for this render ---
    const dealNew = n > 0 && isNew(`${s.round}:deal`);
    const dealBase = dealNew ? (2 * n + 2) * DEAL_STEP + 420 : 0;
    const flipNew = !s.dealer.holeHidden && s.dealer.cards.length >= 2 && isNew(`${s.round}:D:flip`);
    const flipAt = dealBase;
    const drawsStart = flipAt + (flipNew ? FLIP_MS : 0);
    const newDraws = s.dealer.cards.slice(2).filter((c, i) => !app.seen.has(`${s.round}:D:${i + 2}:v`)).length;
    const settleAt = drawsStart + newDraws * DRAW_STEP + (newDraws ? 200 : 0);
    const t = { dealBase, flipAt, drawsStart, settleAt, n, seatIndex: (pid) => active.findIndex((p) => p.id === pid) };

    // bank panel (top-left)
    if (meP) {
      const pnl = meP.bank - meP.start;
      const delay = s.phase === 'settled' && isNew(`${s.round}:pnl`) ? settleAt : 0;
      clearTimeout(app.pnlTimer);
      const apply = () => {
        tickNumber('bank', 'bankShown', meP.bank, money, null);
        tickNumber('pnl', 'pnlShown', pnl, signed, (v) => 'pnl ' + cls(v));
      };
      if (delay) app.pnlTimer = setTimeout(apply, delay); else apply();
      $('bank-sub').textContent = `Buy-in ${money(meP.start)}${meP.status === 'spectating' ? ' · watching' : ''}`;
    }
    $('shoe-box').title = `${s.shoe.remaining} cards left in the shoe`;

    // dealer
    const dh = $('dealer-hand');
    dh.classList.toggle('many', s.dealer.cards.length > 4);
    dh.innerHTML = s.dealer.cards.map((c, i) => {
      const key = `${s.round}:D:${i}:${c.hidden ? 'h' : 'v'}`;
      let delay = 0;
      if (i === 0) delay = n * DEAL_STEP;
      else if (i === 1) delay = c.hidden ? (2 * n + 1) * DEAL_STEP : flipAt;
      else delay = drawsStart + (i - 2) * DRAW_STEP;
      return cardHTML(c, key, delay);
    }).join('');
    if (flipNew) { const second = dh.children[1]; if (second) { second.classList.remove('deal'); second.classList.add('flip-in'); second.dataset.aimed = '1'; second.style.setProperty('--delay', flipAt + 'ms'); } }
    let dv = '';
    if (s.dealer.cards.length && !s.dealer.holeHidden) {
      const v = s.dealer.value;
      const bj = BJ.isNatural(s.dealer.cards);
      const text = v.bust ? 'Bust' : bj ? 'Blackjack' : String(v.total);
      const fresh = isNew(`${s.round}:D:v:${text}`);
      dv = `<span class="hand-value ${v.bust ? 'bust' : bj ? 'bj' : ''}${fresh ? ' anim' : ''}"${fresh ? ` style="--tag-delay:${settleAt}ms"` : ''}>${text}</span>`;
    }
    $('dealer-value').innerHTML = dv;

    // seats
    const betting = s.phase === 'betting' && meP && meP.status === 'seated' && !meP.locked;
    $('seats').innerHTML = seated.map((p) => seatHTML(p, s, t, betting)).join('') || '<div class="seat empty"><div class="status-tag">No one at the table</div></div>';
    $('seats').classList.toggle('betting', !!betting);
    aimCardsFromShoe();

    // sidebar
    $('log').innerHTML = s.log.map((l) => `<li>${esc(l)}</li>`).join('');
    $('log').scrollTop = 1e6;
    const specs = s.players.filter((p) => p.status === 'spectating');
    $('spectators').innerHTML = specs.length ? `<b>Watching:</b> ${specs.map((p) => esc(p.name)).join(', ')}` : '';

    app.barDelay = s.phase === 'settled' && isNew(`${s.round}:settle-bar`) ? settleAt : (dealNew ? dealBase : 0);
    renderFeltActions(s, meP);
    renderActions(s, meP);
    renderOverlay(s, meP);

    if (s.phase === 'settled' && !app.tick) app.tick = setInterval(() => {
      const st = app.state;
      if (!st || st.phase !== 'settled') { clearInterval(app.tick); app.tick = null; return; }
      const el = document.querySelector('#actions .countdown');
      if (el) el.textContent = `Next hand in ${Math.max(0, Math.ceil((NEXT_ROUND_MS - (Date.now() - (st.settledAt || Date.now()))) / 1000))}s`;
    }, 500);
  }

  function seatHTML(p, s, t, betting) {
    const mine = p.id === app.myId;
    const isTurn = s.turn && s.turn.pid === p.id;
    const pnl = p.bank - p.start;
    const si = t.seatIndex(p.id);
    const anim = (key) => (isNew(`${s.round}:${p.id}:${key}`) ? ' anim' : '');
    const pend = app.pending;

    // ----- hands -----
    let hands = '';
    if (p.hands.length) {
      hands = `<div class="hands">${p.hands.map((h, hi) => {
        const turnHand = isTurn && s.turn.hand === hi;
        const cards = h.cards.map((c, ci) => {
          const initial = hi === 0 && !h.split && ci < 2;
          const delay = initial ? (ci * (t.n + 1) + si) * DEAL_STEP : 0;
          return cardHTML(c, `${s.round}:${p.id}:${hi}:${ci}:${c.r}${c.s}`, delay);
        }).join('');
        const tagDelay = s.phase === 'settled' ? t.settleAt : (h.cards.length <= 2 && !h.split ? t.dealBase : 0);
        const behind = Object.entries(h.behind || {});
        return `<div class="hand-box${turnHand ? ' turn' : ''}">
          <div class="hand${h.cards.length > 3 ? ' many' : ''}">${cards}</div>
          ${valueTag(h.value, h, s.phase, `${s.round}:v:${p.id}:${hi}`, tagDelay)}
          ${p.hands.length > 1 ? `<div class="hand-bet${anim('hb' + hi)}">${stack(h.bet)}${behind.map(([bid, amt]) => `<span class="behind-tag">${stack(amt)}<span>${esc(nameOf(bid, s))}</span></span>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div>`;
    } else {
      let msg = '';
      if (p.status === 'broke') msg = 'Out of chips';
      else if (s.phase === 'betting') msg = p.locked ? (p.sitOut ? 'Sitting out' : 'Locked in') : 'Placing bets…';
      else if (p.sitOut) msg = (p.bets.bust || Object.keys(p.bets.behind).length) ? 'Side bets only' : 'Sitting out';
      hands = `<div class="hands"><div class="status-tag${p.locked && !p.sitOut ? ' lock' : ''}${anim('st:' + msg)}">${msg}</div></div>`;
    }

    // ----- betting spots -----
    const single = p.hands.length === 1 ? p.hands[0] : null;
    const mainAmt = betting && mine ? pend.main : (single ? single.bet : p.bets.main);
    const bustAmt = betting && mine ? pend.bust : p.bets.bust;
    const myBehindHere = betting && !mine ? (pend.behind[p.id] || 0) : 0;
    const behindOn = single ? Object.entries(single.behind || {}) : Object.entries(p.bets.behind ? {} : {});
    // behind bets others locked on this player (before deal they live on the bettor)
    const lockedBehind = s.phase === 'betting' ? s.players.filter((q) => q.locked && q.bets.behind && q.bets.behind[p.id]).map((q) => [q.id, q.bets.behind[p.id]]) : behindOn;
    const clickable = betting && p.status === 'seated' && (mine || !p.locked || true);
    const mainSpot = `<div class="spot main${mainAmt ? ' has' : ''}${clickable ? ' click' : ''}" data-spot="${mine ? 'main' : 'behind:' + p.id}" role="button" tabindex="0" aria-label="${mine ? 'Your bet' : 'Bet behind ' + esc(p.name)}">
        <span class="spot-label">${mine ? 'BET' : 'BEHIND'}</span>${stack(mainAmt, 'anim')}
        ${myBehindHere ? `<span class="behind-mine">${stack(myBehindHere)}<span>YOU</span></span>` : ''}
      </div>`;
    const bustSpot = mine || bustAmt ? `<div class="spot side${bustAmt ? ' has' : ''}${clickable && mine ? ' click' : ''}" data-spot="${mine ? 'bust' : ''}" role="button" tabindex="0" aria-label="Dealer bust bet">
        <span class="spot-label">DEALER<br>BUST</span>${stack(bustAmt, 'anim')}
      </div>` : '<div class="spot side ghost"></div>';
    const tags = [];
    for (const [bid, amt] of lockedBehind) if (bid !== app.myId || !betting) tags.push(`<span class="behind-tag">${stack(amt)}<span>${bid === app.myId ? 'YOU' : esc(nameOf(bid, s))}</span></span>`);
    if (p.insurance > 0) tags.push(`<span class="behind-tag ins">${stack(p.insurance)}<span>INS</span></span>`);
    if (p.bets.bust && s.phase === 'settled' && p.bustResult) tags.push(`<span class="behind-tag result">${esc(p.bustResult)}</span>`);
    if (!mine && s.phase === 'betting' && !p.hands.length && Object.keys(p.bets.behind || {}).length && p.locked) {
      for (const [bid, amt] of Object.entries(p.bets.behind)) tags.push(`<span class="behind-tag">${stack(amt)}<span>on ${esc(nameOf(bid, s))}</span></span>`);
    }
    if (mine && s.phase !== 'betting' && Object.keys(p.bets.behind || {}).length) {
      for (const [bid, amt] of Object.entries(p.bets.behind)) tags.push(`<span class="behind-tag">${stack(amt)}<span>on ${esc(nameOf(bid, s))}</span></span>`);
    }

    const showNet = !mine && s.phase === 'settled' && typeof p.lastNet === 'number' && (p.hands.length || !p.sitOut);
    const net = showNet ? `<b class="net ${cls(p.lastNet)}${anim('net')}" style="--tag-delay:${t.settleAt}ms">${signed(p.lastNet)}</b>` : '';
    const total = pendingTotal();
    const dealBtn = betting && mine ? `<button class="btn gold deal-btn${isNew(`${s.round}:dealbtn`) ? ' anim' : ''}" data-act="lock" ${total > 0 ? '' : 'disabled'}>${total > 0 ? 'Deal · ' + money(total) : 'Place a bet'}</button>` : '';
    return `<div class="seat${mine ? ' me' : ''}${isTurn ? ' turn' : ''}${p.status === 'left' || !p.connected ? ' away' : ''}${anim('seat')}">
      ${hands}
      <div class="spots">${mainSpot}${bustSpot}</div>
      <div class="tags">${tags.join('')}</div>
      <div class="plate">
        <div class="name">${esc(p.name)}${mine ? '<span class="you">YOU</span>' : ''}</div>
        <div class="money"><span>${money(p.bank)}</span>${mine ? '' : `<b class="${cls(pnl)}">${signed(pnl)}</b>`}${net}</div>
      </div>
      ${dealBtn}
    </div>`;
  }
  function nameOf(pid, s) { const p = s.players.find((x) => x.id === pid); return p ? p.name : '?'; }

  // ----- actions bar -----
  function setBar(html) {
    const bar = $('actions');
    if (bar.dataset.html === html) return;
    bar.style.setProperty('--bar-delay', (app.barDelay || 0) + 'ms');
    bar.innerHTML = html; bar.dataset.html = html;
  }
  function renderActions(s, meP) {
    const isHost = app.role === 'host';
    if (!meP) { setBar('<span class="note">Connecting…</span>'); return; }
    if (meP.status === 'spectating') {
      const seats = s.players.filter((p) => p.status === 'seated').length;
      setBar(`<span class="note">You're watching.${meP.bank > 0 && seats < BJ.MAX_SEATS ? ' Tap SIT on the table to play.' : ''}</span>`);
      return;
    }
    if (meP.status === 'broke') { setBar('<span class="note">Out of chips.</span>'); return; }

    switch (s.phase) {
      case 'betting': {
        if (meP.status !== 'seated') { setBar('<span class="note">Waiting…</span>'); return; }
        if (meP.locked) {
          const waiting = s.players.filter((p) => p.status === 'seated' && !p.locked).map((p) => p.name);
          setBar(`<span class="note">Locked in. Waiting for <b>${esc(waiting.join(', ') || '…')}</b></span>${isHost ? '<button class="btn" data-act="forceDeal">Deal now</button>' : ''}`);
          return;
        }
        setBar(betBuilderHTML(s, meP));
        return;
      }
      case 'insurance': {
        if (meP.hands.length && meP.insurance === null) {
          const amt = Math.floor(meP.hands[0].bet / 2);
          setBar(`<span class="note">Dealer shows an Ace. Insurance costs <b>${money(amt)}</b> and pays 2 to 1.</span>`);
        } else {
          const waiting = s.players.filter((p) => p.hands.length && p.insurance === null).map((p) => p.name);
          setBar(`<span class="note">Waiting for <b>${esc(waiting.join(', '))}</b> to decide on insurance…</span>`);
        }
        return;
      }
      case 'playing': {
        if (s.turn && s.turn.pid === meP.id) {
          const h = meP.hands[s.turn.hand];
          const canDouble = h.cards.length === 2 && !h.doubled && !h.fromAces && meP.bank >= h.bet;
          const canSplit = h.cards.length === 2 && meP.hands.length < BJ.MAX_HANDS && !h.fromAces && meP.bank >= h.bet &&
            (h.cards[0].r === h.cards[1].r || (BJ.cardValue(h.cards[0].r) === 10 && BJ.cardValue(h.cards[1].r) === 10));
          void canDouble; void canSplit;
          setBar(`<span class="note">${meP.hands.length > 1 ? `Hand ${s.turn.hand + 1} of ${meP.hands.length} · ` : ''}Your move <small>H · S · D · P</small></span>`);
        } else {
          const who = s.turn ? nameOf(s.turn.pid, s) : '…';
          setBar(`<span class="note"><b>${esc(who)}</b> is playing…</span>`);
        }
        return;
      }
      case 'dealer': setBar('<span class="note">Dealer plays…</span>'); return;
      case 'settled': {
        const left = Math.max(0, Math.ceil((NEXT_ROUND_MS - (Date.now() - (s.settledAt || Date.now()))) / 1000));
        const net = typeof meP.lastNet === 'number' && !(meP.sitOut && !meP.bets.bust && !Object.keys(meP.bets.behind).length) ? meP.lastNet : null;
        const banner = net === null ? '<span class="note">Hand over.</span>' : `<span class="result-banner ${cls(net)}">${net > 0 ? 'You won ' : net < 0 ? 'You lost ' : 'Push · '}${money(net)}</span>`;
        setBar(`${banner}<span class="countdown">Next hand in ${left}s</span>`);
        void isHost;
        return;
      }
      default: setBar('');
    }
  }

  // Round buttons at the bottom of the felt: play actions, insurance, next hand, take a seat.
  function renderFeltActions(s, meP) {
    const el = $('felt-actions');
    let html = '';
    if (meP && meP.status === 'spectating') {
      const seats = s.players.filter((p) => p.status === 'seated').length;
      if (meP.bank > 0 && seats < BJ.MAX_SEATS) html = '<button class="rbtn gold" data-act="sit">SIT</button>';
    } else if (meP && meP.status === 'seated') {
      if (s.phase === 'insurance' && meP.hands.length && meP.insurance === null) {
        const amt = Math.floor(meP.hands[0].bet / 2);
        html = `<button class="rbtn gold" data-act="ins-yes" ${meP.bank < amt || amt <= 0 ? 'disabled' : ''}>INSURE<small>${money(amt)}</small></button><button class="rbtn red" data-act="ins-no">NO</button>`;
      } else if (s.phase === 'playing' && s.turn && s.turn.pid === meP.id) {
        const h = meP.hands[s.turn.hand];
        const canDouble = h.cards.length === 2 && !h.doubled && !h.fromAces && meP.bank >= h.bet;
        const canSplit = h.cards.length === 2 && meP.hands.length < BJ.MAX_HANDS && !h.fromAces && meP.bank >= h.bet &&
          (h.cards[0].r === h.cards[1].r || (BJ.cardValue(h.cards[0].r) === 10 && BJ.cardValue(h.cards[1].r) === 10));
        html = `<button class="rbtn gold" data-act="hit">HIT</button>
          <button class="rbtn red" data-act="stand">STAND</button>
          <button class="rbtn blue" data-act="double" ${canDouble ? '' : 'disabled'}>2×</button>
          <button class="rbtn purple" data-act="split" ${canSplit ? '' : 'disabled'}>SPLIT</button>`;
      } else if (s.phase === 'settled' && app.role === 'host') {
        html = '<button class="rbtn gold next" data-act="next">NEXT</button>';
      }
    }
    if (el.dataset.html === html) return;
    el.style.setProperty('--bar-delay', (app.barDelay || 0) + 'ms');
    el.innerHTML = html; el.dataset.html = html;
    el.classList.toggle('empty', !html);
  }

  function pendingTotal() { return app.pending.main + app.pending.bust + sum(app.pending.behind); }
  function betBuilderHTML(s, meP) {
    const total = pendingTotal();
    const left = meP.bank - total;
    if (!CHIPS.includes(app.chipSel) || app.chipSel > left) {
      const best = CHIPS.filter((c) => c <= left).pop();
      if (best) app.chipSel = Math.min(app.chipSel, best);
    }
    const canRepeat = !!app.lastBets && (app.lastBets.main + app.lastBets.bust + sum(app.lastBets.behind)) <= meP.bank && (app.lastBets.main + app.lastBets.bust + sum(app.lastBets.behind)) > 0;
    const canDouble = total > 0 && total * 2 <= meP.bank;
    return `<div class="bet-builder${isNew(`${s.round}:builder`) ? ' enter' : ''}">
      <div class="rack" role="radiogroup" aria-label="Chip">
        ${CHIPS.map((c) => `<button class="chip pick ${chipClass(c)}${c === app.chipSel ? ' sel' : ''}" data-chip="${c}" ${c > left ? 'disabled' : ''} role="radio" aria-checked="${c === app.chipSel}" aria-label="${c} chip">${chipLabel(c)}</button>`).join('')}
      </div>
      <div class="tools">
        <button class="tool-btn" data-act="undo" ${app.undo.length ? '' : 'disabled'} title="Take back the last chip"><span class="ico">↶</span><span class="lbl">Undo</span></button>
        <button class="tool-btn" data-act="clear" ${total ? '' : 'disabled'} title="Clear all bets"><span class="ico">✕</span><span class="lbl">Clear</span></button>
        <button class="tool-btn" data-act="repeat" ${canRepeat ? '' : 'disabled'} title="Same bets as last hand"><span class="ico">↻</span><span class="lbl">Rebet</span></button>
        <button class="tool-btn" data-act="double-bet" ${canDouble ? '' : 'disabled'} title="Double every bet"><span class="ico">2×</span><span class="lbl">Double</span></button>
        <button class="tool-btn" data-act="allin" ${left > 0 ? '' : 'disabled'} title="Everything on the main bet"><span class="ico">MAX</span><span class="lbl">All in</span></button>
        <button class="tool-btn quiet" data-act="sitout" title="Skip this hand"><span class="ico">—</span><span class="lbl">Sit out</span></button>
        ${app.role === 'host' && s.players.some((p) => p.status === 'seated' && p.locked) ? '<button class="tool-btn quiet" data-act="forceDeal" title="Deal now, stragglers sit out"><span class="ico">▶</span><span class="lbl">Deal now</span></button>' : ''}
      </div>
      <div class="hint">${total ? 'Tap a circle to add more chips, then press Deal under your seat.' : 'Pick a chip, then tap your BET circle. Tap DEALER BUST for the side bet, or a friend’s circle to bet behind them.'}</div>
    </div>`;
  }
  function placeChip(spot, n) {
    const m = me(); if (!m) return false;
    if (n > m.bank - pendingTotal()) { toast('Not enough chips'); return false; }
    const pend = app.pending;
    if (spot === 'main') pend.main += n;
    else if (spot === 'bust') pend.bust += n;
    else if (spot.startsWith('behind:')) { const pid = spot.slice(7); pend.behind[pid] = (pend.behind[pid] || 0) + n; }
    else return false;
    app.undo.push({ spot, n });
    return true;
  }
  function undoChip() {
    const u = app.undo.pop(); if (!u) return;
    const pend = app.pending;
    if (u.spot === 'main') pend.main = Math.max(0, pend.main - u.n);
    else if (u.spot === 'bust') pend.bust = Math.max(0, pend.bust - u.n);
    else { const pid = u.spot.slice(7); pend.behind[pid] = Math.max(0, (pend.behind[pid] || 0) - u.n); if (!pend.behind[pid]) delete pend.behind[pid]; }
  }
  function clearPending() { app.pending = { main: 0, bust: 0, behind: {} }; app.undo = []; }
  function setPending(b) {
    const s = app.state;
    const behind = {};
    for (const [pid, amt] of Object.entries(b.behind || {})) { const q = s && s.players.find((x) => x.id === pid); if (q && q.status === 'seated' && amt > 0) behind[pid] = amt; }
    app.pending = { main: b.main || 0, bust: b.bust || 0, behind };
    app.undo = [];
  }
  function refreshBetting() { if (app.state) renderTable(app.state); }

  // ----- overlay (broke) -----
  function renderOverlay(s, meP) {
    const ov = $('overlay');
    if (meP && meP.status === 'broke') {
      if (ov.hidden) {
        ov.innerHTML = `<div class="modal"><h2>Out of chips</h2><p>You started with ${money(meP.start)} and it's all gone. Stay and watch, or leave the table.</p>
          <div class="act-row"><button class="btn gold big" data-act="spectate">Spectate</button><button class="btn danger" data-act="leave">Leave table</button></div></div>`;
        ov.hidden = false;
      }
    } else ov.hidden = true;
  }

  // ---------------- events ----------------
  $('btn-host').addEventListener('click', () => {
    const name = $('home-name').value.trim();
    if (!name) { $('home-error').textContent = 'Enter your name first.'; $('home-error').hidden = false; $('home-name').focus(); return; }
    $('home-error').hidden = true;
    try { localStorage.setItem('bj-name', name); } catch (e) { /* */ }
    startHost(name);
  });
  $('btn-join').addEventListener('click', () => {
    const name = $('home-name').value.trim();
    const code = $('home-code').value.trim().toUpperCase();
    if (!name) { $('home-error').textContent = 'Enter your name first.'; $('home-error').hidden = false; $('home-name').focus(); return; }
    if (code.length !== 5) { $('home-error').textContent = 'Room codes are 5 characters.'; $('home-error').hidden = false; $('home-code').focus(); return; }
    try { localStorage.setItem('bj-name', name); } catch (e) { /* */ }
    joinGame(name, code);
  });
  $('home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('home-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('home-code').value ? $('btn-join') : $('btn-host')).click(); });
  $('btn-copy').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '?join=' + app.code;
    try { await navigator.clipboard.writeText(url); $('btn-copy').textContent = 'Copied'; setTimeout(() => { $('btn-copy').textContent = 'Copy'; }, 1500); } catch (e) { prompt('Share this link', url); }
  });
  $('btn-start').addEventListener('click', () => dispatch('start'));
  $('btn-lobby-leave').addEventListener('click', () => { if (app.role === 'guest') dispatch('leave'); goHome(''); });
  $('btn-leave').addEventListener('click', () => { if (app.role === 'guest') dispatch('leave'); goHome(''); });

  function onAct(act, el) {
    switch (act) {
      case 'hit': case 'stand': case 'double': case 'split': dispatch('play', { action: act }); break;
      case 'ins-yes': dispatch('insurance', { take: true }); break;
      case 'ins-no': dispatch('insurance', { take: false }); break;
      case 'lock': {
        const p = app.pending;
        app.lastBets = { main: p.main, bust: p.bust, behind: { ...p.behind } };
        dispatch('lock', { main: p.main, bust: p.bust, behind: { ...p.behind } });
        clearPending(); break;
      }
      case 'sitout': clearPending(); dispatch('lock', {}); break;
      case 'forceDeal': dispatch('forceDeal'); break;
      case 'next': dispatch('next'); break;
      case 'spectate': dispatch('spectate'); break;
      case 'sit': dispatch('sit'); break;
      case 'leave': dispatch('leave'); goHome(''); break;
      case 'undo': undoChip(); refreshBetting(); break;
      case 'clear': clearPending(); refreshBetting(); break;
      case 'repeat': if (app.lastBets) { setPending(app.lastBets); refreshBetting(); } break;
      case 'double-bet': {
        const p = app.pending; const m = me();
        if (m && pendingTotal() * 2 <= m.bank) { setPending({ main: p.main * 2, bust: p.bust * 2, behind: Object.fromEntries(Object.entries(p.behind).map(([k, v]) => [k, v * 2])) }); refreshBetting(); }
        break;
      }
      case 'allin': {
        const m = me(); if (!m) return;
        const left = m.bank - pendingTotal();
        if (left > 0) placeChip('main', left);
        refreshBetting();
        break;
      }
      default: break;
    }
    void el;
  }
  document.addEventListener('click', (e) => {
    const chipBtn = e.target.closest('button[data-chip]');
    if (chipBtn) { app.chipSel = Number(chipBtn.dataset.chip); refreshBetting(); return; }
    const spot = e.target.closest('[data-spot]');
    if (spot && spot.dataset.spot && spot.classList.contains('click')) {
      const s = app.state, m = me();
      if (!s || s.phase !== 'betting' || !m || m.locked) return;
      if (placeChip(spot.dataset.spot, app.chipSel)) {
        refreshBetting();
        const fresh = document.querySelector(`[data-spot="${spot.dataset.spot}"]`);
        if (fresh) { fresh.classList.add('bump'); setTimeout(() => fresh.classList.remove('bump'), 350); }
      } else { spot.classList.add('shake'); setTimeout(() => spot.classList.remove('shake'), 350); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled) onAct(b.dataset.act, b);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const s = app.state; if (!s) return;
    const k = e.key.toLowerCase();
    if (s.phase === 'playing' && s.turn && s.turn.pid === app.myId) {
      const map = { h: 'hit', s: 'stand', d: 'double', p: 'split' };
      if (map[k]) { const btn = document.querySelector(`[data-act="${map[k]}"]`); if (btn && !btn.disabled) onAct(map[k]); }
    } else if (s.phase === 'betting') {
      if (e.key === 'Enter') { const btn = document.querySelector('[data-act="lock"]'); if (btn && !btn.disabled) onAct('lock'); }
      if (k === 'r') { const btn = document.querySelector('[data-act="repeat"]'); if (btn && !btn.disabled) onAct('repeat'); }
      if (k === 'z' || e.key === 'Backspace') { const btn = document.querySelector('[data-act="undo"]'); if (btn && !btn.disabled) onAct('undo'); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-spot]')) { e.preventDefault(); e.target.click(); }
  });
  window.addEventListener('beforeunload', () => { if (app.role === 'guest') dispatch('leave'); if (app.host) app.host.broadcast({ type: 'kicked', reason: 'closed' }); });
  document.addEventListener('bj-toast', (e) => toast(e.detail));

  // ---------------- boot ----------------
  try { const n = localStorage.getItem('bj-name'); if (n) $('home-name').value = n; } catch (e) { /* */ }
  const params = new URLSearchParams(location.search);
  if (params.get('join')) { $('home-code').value = params.get('join').toUpperCase().slice(0, 5); }
  show('home');
})();
