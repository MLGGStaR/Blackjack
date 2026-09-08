/* App — screens, rendering, and the host/guest glue around the engine. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HOST_ID = 'host';
  const CHIPS = [1, 5, 25, 100, 500, 1000, 5000];
  const NEXT_ROUND_MS = 8000;

  const app = {
    role: null, name: '', myId: null, code: '',
    game: null, host: null, guest: null, state: null,
    status: { level: 'offline', text: '' },
    pending: { main: 0, bust: 0, behind: {} }, slot: 'main', behindTarget: null, undo: [],
    seen: new Set(), nextTimer: null, tick: null, lastRound: 0,
  };
  window.app = app; // for debugging

  const money = (n) => '$' + BJ.fmt(Math.abs(n));
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(n);
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      onState(state) {
        app.state = state;
        if (state.hostId) { /* keep */ }
        render();
      },
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
    Object.assign(app, { role: null, myId: null, game: null, host: null, guest: null, state: null, nextTimer: null, tick: null, seen: new Set(), pending: { main: 0, bust: 0, behind: {} }, undo: [], slot: 'main', behindTarget: null });
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
    const meP = me();
    const root = $('lobby-players');
    const html = s.players.map((p) => {
      const mine = p.id === app.myId;
      const who = `<div class="who">${esc(p.name)}${p.id === s.hostId ? '<small>host</small>' : ''}${mine ? '<small>you</small>' : ''}</div>`;
      const right = mine
        ? `<div class="stepper"><button data-step="-1" aria-label="Less">−</button><input type="text" inputmode="numeric" id="bank-input" value="${BJ.fmt(p.bank)}" aria-label="Your buy-in"><button data-step="1" aria-label="More">+</button></div>`
        : `<div class="amount">${money(p.bank)}</div>`;
      return `<div class="lobby-player${mine ? ' me' : ''}" data-id="${p.id}">${who}${right}</div>`;
    }).join('');
    if (root.dataset.html !== html) { root.innerHTML = html; root.dataset.html = html; }
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = !s.players.some((p) => p.status === 'seated');
    $('lobby-wait').hidden = isHost;
    void meP;
  }
  // stepper handlers (delegated, with press-and-hold)
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

  // ----- table -----
  function cardHTML(c, key) {
    if (!c || c.hidden) return `<div class="card back${isNew(key) ? ' deal' : ''}"></div>`;
    const fresh = isNew(key);
    return `<div class="card${fresh ? ' deal' : ''}" data-suit="${c.s}"><span class="corner">${c.r}<i>${c.s}</i></span><span class="pip">${c.s}</span><span class="corner flip">${c.r}<i>${c.s}</i></span></div>`;
  }
  function isNew(key) {
    if (!key) return false;
    if (app.seen.has(key)) return false;
    app.seen.add(key); return true;
  }
  function valueTag(v, h, phase) {
    if (!v) return '';
    let text = v.total + (v.soft && v.total < 21 && !v.bust ? ' soft' : '');
    let k = '';
    if (h && h.natural) { text = 'Blackjack'; k = 'bj'; }
    if (v.bust) { text = 'Bust'; k = 'bust'; }
    if (h && phase === 'settled' && h.result) {
      k = { win: 'win', blackjack: 'bj', lose: 'lose', push: 'push', bust: 'bust' }[h.result] || '';
      text = { win: 'Win ' + money(h.payout - h.bet), blackjack: 'Blackjack ' + money(h.payout - h.bet), lose: 'Lose', push: 'Push', bust: 'Bust' }[h.result];
    }
    return `<span class="hand-value ${k}">${text}</span>`;
  }
  function chipClass(n) {
    const d = CHIPS.slice().reverse().find((c) => n >= c) || 1;
    return 'd' + d;
  }
  function chip(n, small) { return `<span class="chip ${chipClass(n)}${small ? ' small' : ''}">${n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K' : n}</span>`; }

  function renderTable(s) {
    const meP = me();
    // top bar
    if (meP) {
      const pnl = meP.bank - meP.start;
      const el = $('pnl'); el.textContent = signed(pnl); el.className = 'pnl ' + cls(pnl);
      $('pnl-sub').textContent = `Bankroll ${money(meP.bank)} · buy-in ${money(meP.start)}${meP.status === 'spectating' ? ' · watching' : ''}`;
    }
    const sh = s.shoe;
    const pct = Math.round((sh.remaining / sh.total) * 100);
    $('shoe-pill').innerHTML = `Shoe <span class="bar"><i style="width:${pct}%"></i></span> ${sh.remaining} cards`;

    // dealer
    const dh = $('dealer-hand');
    dh.innerHTML = s.dealer.cards.map((c, i) => cardHTML(c, `${s.round}:D:${i}:${c.hidden ? 'h' : 'v'}`)).join('');
    if (!s.dealer.holeHidden && s.dealer.cards.length >= 2 && !app.seen.has(`${s.round}:D:flip`)) {
      app.seen.add(`${s.round}:D:flip`);
      const second = dh.children[1]; if (second) second.classList.add('flip-in');
    }
    let dv = '';
    if (s.dealer.cards.length) {
      const v = s.dealer.value;
      const bj = !s.dealer.holeHidden && BJ.isNatural(s.dealer.cards);
      dv = `<span class="hand-value ${v.bust ? 'bust' : bj ? 'bj' : ''}">${v.bust ? 'Dealer busts' : bj ? 'Blackjack' : (s.dealer.holeHidden ? 'Showing ' : '') + v.total + (v.soft && v.total < 21 && !s.dealer.holeHidden ? ' soft' : '')}</span>`;
    }
    $('dealer-value').innerHTML = dv;

    // seats
    const seated = s.players.filter((p) => p.status === 'seated' || p.status === 'broke' || (p.status === 'left' && p.hands.length));
    $('seats').innerHTML = seated.map((p) => seatHTML(p, s)).join('') || '<div class="seat"><div class="status-tag">No one at the table</div></div>';

    // sidebar
    $('log').innerHTML = s.log.map((l) => `<li>${esc(l)}</li>`).join('');
    $('log').scrollTop = 1e6;
    const specs = s.players.filter((p) => p.status === 'spectating');
    $('spectators').innerHTML = specs.length ? `<b>Watching:</b> ${specs.map((p) => esc(p.name)).join(', ')}` : '';

    renderActions(s, meP);
    renderOverlay(s, meP);

    // settled countdown ticks
    if (s.phase === 'settled' && !app.tick) app.tick = setInterval(() => { if (app.state && app.state.phase === 'settled') renderActions(app.state, me()); else { clearInterval(app.tick); app.tick = null; } }, 500);
  }

  function seatHTML(p, s) {
    const mine = p.id === app.myId;
    const isTurn = s.turn && s.turn.pid === p.id;
    const pnl = p.bank - p.start;
    let inner = '';
    if (p.hands.length) {
      inner = `<div class="hands">${p.hands.map((h, hi) => {
        const turnHand = isTurn && s.turn.hand === hi;
        const behind = Object.entries(h.behind || {});
        return `<div class="hand-box${turnHand ? ' turn' : ''}">
          <div class="hand">${h.cards.map((c, ci) => cardHTML(c, `${s.round}:${p.id}:${hi}:${ci}:${c.r}${c.s}`)).join('')}</div>
          ${valueTag(h.value, h, s.phase)}
          <div class="bets">${chip(h.bet, true)}${behind.map(([bid, amt]) => `<span class="bet-tag">${chip(amt, true)}<span>${esc(nameOf(bid, s))}</span></span>`).join('')}</div>
        </div>`;
      }).join('')}</div>`;
    } else if (s.phase === 'betting') {
      inner = p.status === 'broke' ? '<div class="status-tag">Out of chips</div>'
        : p.locked ? (p.sitOut ? '<div class="status-tag">Sitting out</div>' : `<div class="status-tag lock">Locked in</div><div class="bets">${p.bets.main ? chip(p.bets.main, true) : ''}${p.bets.bust ? `<span class="bet-tag">${chip(p.bets.bust, true)}<span>Bust</span></span>` : ''}${Object.entries(p.bets.behind).map(([bid, amt]) => `<span class="bet-tag">${chip(amt, true)}<span>${esc(nameOf(bid, s))}</span></span>`).join('')}</div>`)
          : '<div class="status-tag">Placing bets…</div>';
    } else if (p.sitOut) {
      const side = [];
      if (p.bets.bust) side.push(`<span class="bet-tag">${chip(p.bets.bust, true)}<span>${s.phase === 'settled' && p.bustResult ? esc(p.bustResult) : 'Dealer bust'}</span></span>`);
      for (const [bid, amt] of Object.entries(p.bets.behind)) side.push(`<span class="bet-tag">${chip(amt, true)}<span>on ${esc(nameOf(bid, s))}</span></span>`);
      inner = side.length ? `<div class="status-tag">Side bets only</div><div class="bets">${side.join('')}</div>` : '<div class="status-tag">Sitting out</div>';
    } else if (p.status === 'broke') inner = '<div class="status-tag">Out of chips</div>';
    // extra side bets for players who also have hands
    if (p.hands.length && (p.bets.bust || p.insurance > 0)) {
      inner += `<div class="bets">${p.bets.bust ? `<span class="bet-tag">${chip(p.bets.bust, true)}<span>${s.phase === 'settled' && p.bustResult ? esc(p.bustResult) : 'Dealer bust'}</span></span>` : ''}${p.insurance > 0 ? `<span class="bet-tag">${chip(p.insurance, true)}<span>Insurance</span></span>` : ''}</div>`;
    }
    const net = s.phase === 'settled' && typeof p.lastNet === 'number' && (p.hands.length || !p.sitOut) ? ` · <b class="${cls(p.lastNet)}">${signed(p.lastNet)}</b>` : '';
    return `<div class="seat${mine ? ' me' : ''}${isTurn ? ' turn' : ''}${p.status === 'left' || !p.connected ? ' away' : ''}">
      <div class="name">${esc(p.name)}${mine ? '<span class="you">YOU</span>' : ''}</div>
      <div class="money">${money(p.bank)} · <b class="${cls(pnl)}">${signed(pnl)}</b>${net}</div>
      ${inner}
    </div>`;
  }
  function nameOf(pid, s) { const p = s.players.find((x) => x.id === pid); return p ? p.name : '?'; }

  // ----- actions bar -----
  function renderActions(s, meP) {
    const bar = $('actions');
    const isHost = app.role === 'host';
    if (!meP) { bar.innerHTML = '<span class="note">Connecting…</span>'; return; }
    if (meP.status === 'spectating') {
      const seats = s.players.filter((p) => p.status === 'seated').length;
      bar.innerHTML = `<span class="note">You're watching.</span>${meP.bank > 0 && seats < BJ.MAX_SEATS ? '<button class="btn gold" data-act="sit">Take a seat</button>' : ''}`;
      return;
    }
    if (meP.status === 'broke') { bar.innerHTML = '<span class="note">Out of chips.</span>'; return; }

    switch (s.phase) {
      case 'betting': {
        if (meP.status !== 'seated') { bar.innerHTML = '<span class="note">Waiting…</span>'; return; }
        if (meP.locked) {
          const waiting = s.players.filter((p) => p.status === 'seated' && !p.locked).map((p) => p.name);
          bar.innerHTML = `<span class="note">Locked in. Waiting for <b>${esc(waiting.join(', ') || '…')}</b></span>${isHost ? '<button class="btn small" data-act="forceDeal">Deal now</button>' : ''}`;
          return;
        }
        renderBetBuilder(s, meP, bar);
        return;
      }
      case 'insurance': {
        if (meP.hands.length && meP.insurance === null) {
          const amt = Math.floor(meP.hands[0].bet / 2);
          bar.innerHTML = `<span class="note">Dealer shows an Ace. Insurance costs <b>${money(amt)}</b> and pays 2 to 1.</span>
            <div class="act-row"><button class="btn act gold" data-act="ins-yes" ${meP.bank < amt || amt <= 0 ? 'disabled' : ''}>Take insurance</button><button class="btn act" data-act="ins-no">No insurance</button></div>`;
        } else {
          const waiting = s.players.filter((p) => p.hands.length && p.insurance === null).map((p) => p.name);
          bar.innerHTML = `<span class="note">Waiting for <b>${esc(waiting.join(', '))}</b> to decide on insurance…</span>`;
        }
        return;
      }
      case 'playing': {
        if (s.turn && s.turn.pid === meP.id) {
          const h = meP.hands[s.turn.hand];
          const canDouble = h.cards.length === 2 && !h.doubled && !h.fromAces && meP.bank >= h.bet;
          const canSplit = h.cards.length === 2 && meP.hands.length < BJ.MAX_HANDS && !h.fromAces && meP.bank >= h.bet &&
            (h.cards[0].r === h.cards[1].r || (BJ.cardValue(h.cards[0].r) === 10 && BJ.cardValue(h.cards[1].r) === 10));
          bar.innerHTML = `<span class="note">${meP.hands.length > 1 ? `Hand ${s.turn.hand + 1} of ${meP.hands.length} · ` : ''}Your move.</span>
            <div class="act-row">
              <button class="btn act gold" data-act="hit">Hit<kbd>H</kbd></button>
              <button class="btn act" data-act="stand">Stand<kbd>S</kbd></button>
              <button class="btn act" data-act="double" ${canDouble ? '' : 'disabled'}>Double<kbd>D</kbd></button>
              <button class="btn act" data-act="split" ${canSplit ? '' : 'disabled'}>Split<kbd>P</kbd></button>
            </div>`;
        } else {
          const who = s.turn ? nameOf(s.turn.pid, s) : '…';
          bar.innerHTML = `<span class="note"><b>${esc(who)}</b> is playing…</span>`;
        }
        return;
      }
      case 'dealer': bar.innerHTML = '<span class="note">Dealer plays…</span>'; return;
      case 'settled': {
        const left = Math.max(0, Math.ceil((NEXT_ROUND_MS - (Date.now() - (s.settledAt || Date.now()))) / 1000));
        const net = typeof meP.lastNet === 'number' && !(meP.sitOut && !meP.bets.bust && !Object.keys(meP.bets.behind).length) ? meP.lastNet : null;
        const banner = net === null ? '<span class="note">Hand over.</span>' : `<span class="result-banner ${cls(net)}">${net > 0 ? 'You won ' : net < 0 ? 'You lost ' : 'Push · '}${money(net)}</span>`;
        bar.innerHTML = `${banner}<span class="countdown">Next hand in ${left}s</span>${isHost ? '<button class="btn small" data-act="next">Next hand now</button>' : ''}`;
        return;
      }
      default: bar.innerHTML = '';
    }
  }

  function renderBetBuilder(s, meP, bar) {
    const pend = app.pending;
    const total = pend.main + pend.bust + Object.values(pend.behind).reduce((a, b) => a + b, 0);
    const left = meP.bank - total;
    const others = s.players.filter((p) => p.status === 'seated' && p.id !== meP.id);
    if (app.behindTarget && !others.some((p) => p.id === app.behindTarget)) app.behindTarget = null;
    if (!app.behindTarget && others.length) app.behindTarget = others[0].id;
    if (app.slot === 'behind' && !others.length) app.slot = 'main';
    const behindAmt = app.behindTarget ? pend.behind[app.behindTarget] || 0 : 0;
    const behindTotal = Object.values(pend.behind).reduce((a, b) => a + b, 0);
    bar.innerHTML = `<div class="bet-builder">
      <div class="slots">
        <button class="slot${app.slot === 'main' ? ' active' : ''}" data-slot="main"><small>Main bet</small><span class="v">${money(pend.main)}</span></button>
        <button class="slot${app.slot === 'bust' ? ' active' : ''}" data-slot="bust" title="Pays 2 to 1 if the dealer busts with 3 cards, 3 to 1 with 4 or more"><small>Dealer bust</small><span class="v">${money(pend.bust)}</span></button>
        ${others.length ? `<div class="slot${app.slot === 'behind' ? ' active' : ''}" data-slot="behind" role="button" tabindex="0"><small>Bet behind${behindTotal > behindAmt ? ` · ${money(behindTotal)} total` : ''}</small><span class="v">${money(behindAmt)}</span>
          <select id="behind-target" aria-label="Bet behind which player">${others.map((p) => `<option value="${p.id}"${p.id === app.behindTarget ? ' selected' : ''}>${esc(p.name)}${pend.behind[p.id] ? ' · ' + money(pend.behind[p.id]) : ''}</option>`).join('')}</select></div>` : ''}
      </div>
      <div class="rack">
        ${CHIPS.map((c) => `<button class="chip pick ${chipClass(c)}" data-chip="${c}" ${c > left ? 'disabled' : ''} aria-label="Add ${c}">${c >= 1000 ? c / 1000 + 'K' : c}</button>`).join('')}
        <div class="tools"><button class="btn small ghost" data-act="undo" ${app.undo.length ? '' : 'disabled'}>Undo</button><button class="btn small ghost" data-act="clear" ${total ? '' : 'disabled'}>Clear</button><button class="btn small ghost" data-act="allin" ${left > 0 ? '' : 'disabled'}>All in</button></div>
      </div>
      <div class="lock-col">
        <button class="btn gold" data-act="lock" ${total > 0 ? '' : 'disabled'}>Lock in ${money(total)}</button>
        <button class="btn small ghost" data-act="sitout">Sit out</button>
        ${isHostAndOthersLocked(s) ? '<button class="btn small ghost" data-act="forceDeal">Deal now</button>' : ''}
      </div>
    </div>`;
  }
  function isHostAndOthersLocked(s) {
    return app.role === 'host' && s.players.some((p) => p.status === 'seated' && p.locked);
  }
  function addChip(n) {
    const pend = app.pending;
    if (app.slot === 'main') pend.main += n;
    else if (app.slot === 'bust') pend.bust += n;
    else if (app.slot === 'behind' && app.behindTarget) pend.behind[app.behindTarget] = (pend.behind[app.behindTarget] || 0) + n;
    else return;
    app.undo.push({ slot: app.slot, target: app.behindTarget, n });
  }
  function undoChip() {
    const u = app.undo.pop(); if (!u) return;
    const pend = app.pending;
    if (u.slot === 'main') pend.main = Math.max(0, pend.main - u.n);
    else if (u.slot === 'bust') pend.bust = Math.max(0, pend.bust - u.n);
    else if (u.slot === 'behind') { pend.behind[u.target] = Math.max(0, (pend.behind[u.target] || 0) - u.n); if (!pend.behind[u.target]) delete pend.behind[u.target]; }
  }
  function clearPending() { app.pending = { main: 0, bust: 0, behind: {} }; app.undo = []; }

  // ----- overlay (broke / host left) -----
  function renderOverlay(s, meP) {
    const ov = $('overlay');
    if (meP && meP.status === 'broke') {
      ov.hidden = false;
      ov.innerHTML = `<div class="modal"><h2>Out of chips</h2><p>You started with ${money(meP.start)} and it's all gone. Stay and watch, or leave the table.</p>
        <div class="act-row"><button class="btn gold" data-act="spectate">Spectate</button><button class="btn danger" data-act="leave">Leave table</button></div></div>`;
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

  function onAct(act) {
    switch (act) {
      case 'hit': case 'stand': case 'double': case 'split': dispatch('play', { action: act }); break;
      case 'ins-yes': dispatch('insurance', { take: true }); break;
      case 'ins-no': dispatch('insurance', { take: false }); break;
      case 'lock': { const p = app.pending; dispatch('lock', { main: p.main, bust: p.bust, behind: { ...p.behind } }); clearPending(); break; }
      case 'sitout': clearPending(); dispatch('lock', {}); break;
      case 'forceDeal': dispatch('forceDeal'); break;
      case 'next': dispatch('next'); break;
      case 'spectate': dispatch('spectate'); break;
      case 'sit': dispatch('sit'); break;
      case 'leave': dispatch('leave'); goHome(''); break;
      case 'undo': undoChip(); renderActions(app.state, me()); break;
      case 'clear': clearPending(); renderActions(app.state, me()); break;
      case 'allin': {
        const m = me(); if (!m) return;
        const p = app.pending;
        const left = m.bank - (p.main + p.bust + Object.values(p.behind).reduce((a, b) => a + b, 0));
        if (left > 0) addChip(left);
        renderActions(app.state, me());
        break;
      }
      default: break;
    }
  }
  document.addEventListener('click', (e) => {
    const chipBtn = e.target.closest('button[data-chip]');
    if (chipBtn) { addChip(Number(chipBtn.dataset.chip)); renderActions(app.state, me()); return; }
    const slot = e.target.closest('[data-slot]');
    if (slot && !e.target.closest('select')) { app.slot = slot.dataset.slot; renderActions(app.state, me()); return; }
    const b = e.target.closest('[data-act]');
    if (b) onAct(b.dataset.act);
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'behind-target') { app.behindTarget = e.target.value; app.slot = 'behind'; renderActions(app.state, me()); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const s = app.state; if (!s || s.phase !== 'playing' || !s.turn || s.turn.pid !== app.myId) return;
    const k = e.key.toLowerCase();
    const map = { h: 'hit', s: 'stand', d: 'double', p: 'split' };
    if (map[k]) { const btn = document.querySelector(`[data-act="${map[k]}"]`); if (btn && !btn.disabled) onAct(map[k]); }
  });
  window.addEventListener('beforeunload', () => { if (app.role === 'guest') dispatch('leave'); if (app.host) app.host.broadcast({ type: 'kicked', reason: 'closed' }); });

  // errors the host sends back to a guest (e.g. "Not enough chips")
  document.addEventListener('bj-toast', (e) => toast(e.detail));

  // ---------------- boot ----------------
  try { const n = localStorage.getItem('bj-name'); if (n) $('home-name').value = n; } catch (e) { /* */ }
  const params = new URLSearchParams(location.search);
  if (params.get('join')) { $('home-code').value = params.get('join').toUpperCase().slice(0, 5); }
  show('home');
})();
