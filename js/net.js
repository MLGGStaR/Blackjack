/* Networking — PeerJS, host-authoritative.
 * Host registers as `bj21-<CODE>`; guests connect to it. Host owns the engine and
 * broadcasts snapshots; guests send actions. Works fully offline for solo play
 * (the room code just never becomes shareable).
 */
(function (root) {
  'use strict';
  const PREFIX = 'bj21-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[BJ.secureRandomInt(ALPHABET.length)];
    return s;
  }

  class Host {
    constructor({ onGuestJoin, onGuestAction, onGuestLeave, onStatus }) {
      this.code = makeCode();
      this.peer = null;
      this.conns = new Map();
      this.online = false;
      this.cb = { onGuestJoin, onGuestAction, onGuestLeave, onStatus };
      this._open();
    }
    _open() {
      if (typeof Peer === 'undefined') { this._status('offline', 'PeerJS did not load — solo play only'); return; }
      const peer = new Peer(PREFIX + this.code, { debug: 0 });
      this.peer = peer;
      this._status('connecting', 'Opening the room…');
      peer.on('open', () => { this.online = true; this._status('online', 'Room open'); });
      peer.on('connection', (conn) => {
        conn.on('data', (msg) => this._onData(conn, msg));
        conn.on('close', () => this._drop(conn.peer));
        conn.on('error', () => this._drop(conn.peer));
      });
      peer.on('disconnected', () => {
        this._status('reconnecting', 'Reconnecting…');
        try { peer.reconnect(); } catch (e) { /* ignore */ }
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') { this.code = makeCode(); try { peer.destroy(); } catch (e) { /* */ } this._open(); return; }
        this.online = false;
        this._status('offline', 'No connection to the room server — friends can’t join right now');
      });
    }
    _onData(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        this.conns.set(conn.peer, conn);
        this.cb.onGuestJoin(conn.peer, String(msg.name || '').slice(0, 16));
      } else if (msg.type === 'act') {
        if (this.conns.has(conn.peer)) this.cb.onGuestAction(conn.peer, msg.action, msg.payload || {});
      }
    }
    _drop(id) {
      if (!this.conns.has(id)) return;
      this.conns.delete(id);
      this.cb.onGuestLeave(id);
    }
    _status(level, text) { this.cb.onStatus(level, text, this.code); }
    send(id, msg) { const c = this.conns.get(id); if (c && c.open) { try { c.send(msg); } catch (e) { /* */ } } }
    broadcast(msg) { for (const [id] of this.conns) this.send(id, msg); }
    kick(id, reason) { this.send(id, { type: 'kicked', reason }); const c = this.conns.get(id); if (c) setTimeout(() => c.close(), 200); this._drop(id); }
    destroy() { try { this.peer && this.peer.destroy(); } catch (e) { /* */ } this.conns.clear(); }
  }

  class Guest {
    constructor({ code, name, onWelcome, onState, onKicked, onError, onClosed }) {
      this.code = code;
      this.cb = { onWelcome, onState, onKicked, onError, onClosed };
      this.conn = null;
      if (typeof Peer === 'undefined') { onError('PeerJS did not load. Check your connection and refresh.'); return; }
      const peer = new Peer({ debug: 0 });
      this.peer = peer;
      const timer = setTimeout(() => { if (!this.conn || !this.conn.open) { onError('Couldn’t reach that room. Check the code and try again.'); this.destroy(); } }, 12000);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true });
        this.conn = conn;
        conn.on('open', () => { clearTimeout(timer); conn.send({ type: 'hello', name }); });
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'welcome') onWelcome(msg);
          else if (msg.type === 'state') onState(msg.state);
          else if (msg.type === 'kicked') { onKicked(msg.reason); this.destroy(); }
          else if (msg.type === 'toast') document.dispatchEvent(new CustomEvent('bj-toast', { detail: String(msg.msg || '') }));
        });
        conn.on('close', () => { clearTimeout(timer); onClosed(); });
      });
      peer.on('error', (err) => {
        clearTimeout(timer);
        if (err.type === 'peer-unavailable') onError('No room with that code. Ask the host for the code shown on their screen.');
        else onError('Connection problem: ' + (err.type || 'unknown'));
        this.destroy();
      });
    }
    act(action, payload) { if (this.conn && this.conn.open) this.conn.send({ type: 'act', action, payload }); }
    destroy() { try { this.peer && this.peer.destroy(); } catch (e) { /* */ } }
  }

  root.Net = { Host, Guest, makeCode, PREFIX };
})(window);
