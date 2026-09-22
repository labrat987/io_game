// WarConvoy — serwer trybu online: WYŁĄCZNIE poczekalnia lobby +
// przekaźnik wiadomości. NIGDY nie liczy gry (jednostki/miasta/złoto) —
// to robi przeglądarka hosta (patrz index.html, netRole==='HOST').
//
// Dwie klasy Durable Object:
// - LobbyDirectory: jeden, globalny — lista aktywnych lobby (limit 5).
// - LobbyRoom: jeden na lobby — miejsca, gotowość, WebSockety graczy,
//   Hibernation API. Przekazuje snapshoty hosta do klientów BEZ ich
//   parsowania (patrz webSocketMessage, format "S|...").
//
// Wdrożenie: patrz CLAUDE.md, sekcja "Tryb online" + instrukcje w planie.

const MAX_LOBBIES = 5;
const RECONNECT_GRACE_MS = 30000; // musi być zgodne z NET_RECONNECT_GRACE_MS w index.html
const MODE_MAX_SEATS = { ONE_V_ONE: 2, DEATHMATCH: 4 };
const SEAT_ORDER = ['P1', 'P2', 'P3', 'P4'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
function corsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ============================================================
// LobbyDirectory — singleton (idFromName('global')). Lista lobby ŻYJE
// tutaj (nie w LobbyRoom), żeby limit MAX_LOBBIES i listing były silnie
// spójne bez odpytywania każdego pokoju osobno.
// ============================================================
export class LobbyDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async getLobbies() {
    return (await this.ctx.storage.get('lobbies')) || [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return corsPreflight();

    if (request.method === 'GET' && url.pathname === '/list') {
      return json({ lobbies: await this.getLobbies() });
    }

    if (request.method === 'POST' && url.pathname === '/create') {
      const { name, mode } = await request.json();
      if (mode !== 'ONE_V_ONE' && mode !== 'DEATHMATCH') return json({ error: 'BAD_MODE' }, 400);
      const lobbies = await this.getLobbies();
      if (lobbies.length >= MAX_LOBBIES) return json({ error: 'LOBBY_LIMIT' }, 429);

      const roomId = crypto.randomUUID();
      const roomStub = this.env.LOBBY_ROOM.get(this.env.LOBBY_ROOM.idFromName(roomId));
      // roomId w query string — LobbyRoom zapamiętuje WŁASNE id, żeby móc
      // później powiadamiać LobbyDirectory (notifyDirectory) o zmianach
      // liczby graczy/statusu. Bez tego /update trafiałoby donikąd.
      const initRes = await roomStub.fetch(`https://room/init?roomId=${roomId}`, {
        method: 'POST',
        body: JSON.stringify({ name, mode }),
      });
      const init = await initRes.json();

      lobbies.push({
        id: roomId,
        name: (name || 'Lobby').slice(0, 40),
        mode,
        maxSeats: MODE_MAX_SEATS[mode],
        playerCount: 1,
        status: 'waiting',
      });
      await this.ctx.storage.put('lobbies', lobbies);
      return json({ roomId, token: init.token, seat: init.seat });
    }

    // Wołane WYŁĄCZNIE przez LobbyRoom (aktualizacja liczby graczy/statusu
    // albo usunięcie zakończonego/pustego lobby z listy).
    if (request.method === 'POST' && url.pathname === '/update') {
      const { roomId, playerCount, status } = await request.json();
      const lobbies = await this.getLobbies();
      const entry = lobbies.find((l) => l.id === roomId);
      if (entry) {
        if (playerCount != null) entry.playerCount = playerCount;
        if (status != null) entry.status = status;
        await this.ctx.storage.put('lobbies', lobbies);
      }
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/remove') {
      const { roomId } = await request.json();
      const lobbies = (await this.getLobbies()).filter((l) => l.id !== roomId);
      await this.ctx.storage.put('lobbies', lobbies);
      return json({ ok: true });
    }

    return json({ error: 'NOT_FOUND' }, 404);
  }
}

// ============================================================
// LobbyRoom — jeden na lobby. Przekaźnik WYŁĄCZNIE: nie zna jednostek,
// miast, złota — tylko miejsca (seaty), gotowość, WebSockety.
// ============================================================
export class LobbyRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async getRoomState() {
    const [seats, mode, hostSeat, status, tokens, disconnectDeadlines, roomId] = await Promise.all([
      this.ctx.storage.get('seats'),
      this.ctx.storage.get('mode'),
      this.ctx.storage.get('hostSeat'),
      this.ctx.storage.get('status'),
      this.ctx.storage.get('tokens'),
      this.ctx.storage.get('disconnectDeadlines'),
      this.ctx.storage.get('roomId'),
    ]);
    return {
      seats: seats || {},
      mode: mode || 'ONE_V_ONE',
      hostSeat: hostSeat || 'P1',
      status: status || 'waiting',
      tokens: tokens || {},
      disconnectDeadlines: disconnectDeadlines || {},
      roomId,
    };
  }

  // Rozgłasza obiekt JSON do wszystkich podłączonych socketów (opcjonalnie
  // pomijając jeden seat, np. nadawcę). Wychodzące send() NIE są billowane
  // (patrz CLAUDE.md/plan — rachunek limitów darmowego planu).
  broadcast(obj, excludeSeat = null) {
    const payload = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.seat && att.seat !== excludeSeat) {
        try { ws.send(payload); } catch (e) { /* socket martwy — webSocketClose i tak posprząta */ }
      }
    }
  }

  findSocketForSeat(seat) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.seat === seat) return ws;
    }
    return null;
  }

  async notifyDirectory(patch) {
    const dirStub = this.env.LOBBY_DIRECTORY.get(this.env.LOBBY_DIRECTORY.idFromName('global'));
    await dirStub.fetch('https://directory/update', { method: 'POST', body: JSON.stringify(patch) });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return corsPreflight();

    // Zakłada pokój — wołane WYŁĄCZNIE przez LobbyDirectory przy tworzeniu
    // lobby. Zakładający zawsze zostaje seatem P1 (niezmiennik: host=P1,
    // patrz PLAYERS w index.html i initAI w ai.js).
    if (request.method === 'POST' && url.pathname === '/init') {
      const { name, mode } = await request.json();
      const maxSeats = MODE_MAX_SEATS[mode] || 2;
      const token = crypto.randomUUID();
      const seats = { P1: { name: (name || 'Gracz').slice(0, 24), ready: false, connected: false, isBot: false } };
      await this.ctx.storage.put({
        seats, mode, maxSeats, hostSeat: 'P1', status: 'waiting',
        tokens: { [token]: 'P1' }, disconnectDeadlines: {}, roomId: url.searchParams.get('roomId'),
      });
      return json({ token, seat: 'P1' });
    }

    // Dołączenie do istniejącego lobby — pierwsze wolne miejsce do maxSeats.
    if (request.method === 'POST' && url.pathname === '/join') {
      const { name } = await request.json();
      const state = await this.getRoomState();
      if (state.status !== 'waiting') return json({ error: 'ALREADY_STARTED' }, 409);
      const maxSeats = (await this.ctx.storage.get('maxSeats')) || 2;
      const freeSeat = SEAT_ORDER.slice(0, maxSeats).find((s) => !state.seats[s]);
      if (!freeSeat) return json({ error: 'LOBBY_FULL' }, 409);

      const token = crypto.randomUUID();
      state.seats[freeSeat] = { name: (name || 'Gracz').slice(0, 24), ready: false, connected: false, isBot: false };
      state.tokens[token] = freeSeat;
      await this.ctx.storage.put({ seats: state.seats, tokens: state.tokens });
      await this.notifyDirectory({ roomId: state.roomId, playerCount: Object.keys(state.seats).length });
      return json({ token, seat: freeSeat });
    }

    // Upgrade do WebSocket — tożsamość (seat) znana JUŻ TERAZ, z tokenu w
    // query string (wydanego przez /init lub /join), więc acceptWebSocket
    // może od razu otagować socket właściwym seatem.
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      const state = await this.getRoomState();
      const seat = state.tokens[token];
      if (!seat || !state.seats[seat]) return json({ error: 'BAD_TOKEN' }, 401);

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [seat]);
      server.serializeAttachment({ seat });

      const wasDisconnected = !state.seats[seat].connected;
      state.seats[seat].connected = true;
      delete state.disconnectDeadlines[seat];
      await this.ctx.storage.put({ seats: state.seats, disconnectDeadlines: state.disconnectDeadlines });

      server.send(JSON.stringify({
        t: 'WELCOME', seat, isHost: seat === state.hostSeat, mode: state.mode,
        players: state.seats, status: state.status,
      }));
      this.broadcast({ t: 'LOBBY_STATE', players: state.seats, status: state.status, hostSeat: state.hostSeat }, seat);
      if (wasDisconnected && state.status === 'in_progress') this.broadcast({ t: 'PLAYER_RECONNECTED', seat }, seat);

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: 'NOT_FOUND' }, 404);
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    const seat = att.seat;
    if (!seat) return;

    // Snapshot hosta — format tekstowy "S|<tick>|P2:<len>:<payload>...",
    // CELOWO nie JSON: czytamy WYŁĄCZNIE nagłówek (indexOf/slice), zero
    // parsowania treści, i przekazujemy każdemu graczowi jego fragment.
    if (typeof message === 'string' && message.startsWith('S|')) {
      const state = await this.getRoomState();
      if (seat !== state.hostSeat) return; // tylko host wysyła snapshoty
      const secondBar = message.indexOf('|', 2);
      const tick = message.slice(2, secondBar);
      let rest = message.slice(secondBar + 1);
      while (rest.length > 0) {
        const c1 = rest.indexOf(':');
        const targetSeat = rest.slice(0, c1);
        const c2 = rest.indexOf(':', c1 + 1);
        const len = parseInt(rest.slice(c1 + 1, c2), 10);
        const payload = rest.slice(c2 + 1, c2 + 1 + len);
        const targetWs = this.findSocketForSeat(targetSeat);
        if (targetWs) { try { targetWs.send(`S|${tick}|${payload}`); } catch (e) { /* patrz broadcast */ } }
        rest = rest.slice(c2 + 1 + len);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    const state = await this.getRoomState();

    switch (msg.t) {
      case 'READY': {
        if (state.seats[seat]) state.seats[seat].ready = !!msg.ready;
        await this.ctx.storage.put('seats', state.seats);
        this.broadcast({ t: 'LOBBY_STATE', players: state.seats, status: state.status, hostSeat: state.hostSeat });
        break;
      }
      case 'ADD_BOT': {
        // Boty WYŁĄCZNIE w lobby 1v1 (ai.js zbudowane wokół dokładnie
        // jednego przeciwnika — patrz CLAUDE.md/plan). Tylko host dodaje.
        if (seat !== state.hostSeat || state.mode !== 'ONE_V_ONE') break;
        const targetSeat = msg.seat;
        if (!targetSeat || state.seats[targetSeat]) break;
        state.seats[targetSeat] = { name: 'Bot', ready: true, connected: true, isBot: true, botDifficulty: msg.difficulty || 'MEDIUM' };
        await this.ctx.storage.put('seats', state.seats);
        this.broadcast({ t: 'LOBBY_STATE', players: state.seats, status: state.status, hostSeat: state.hostSeat });
        break;
      }
      case 'REMOVE_BOT': {
        if (seat !== state.hostSeat) break;
        const targetSeat = msg.seat;
        if (targetSeat && state.seats[targetSeat] && state.seats[targetSeat].isBot) {
          delete state.seats[targetSeat];
          await this.ctx.storage.put('seats', state.seats);
          this.broadcast({ t: 'LOBBY_STATE', players: state.seats, status: state.status, hostSeat: state.hostSeat });
        }
        break;
      }
      case 'START': {
        if (seat !== state.hostSeat || state.status !== 'waiting') break;
        const present = Object.entries(state.seats);
        if (present.length < 2) break;
        const allReady = present.every(([, p]) => p.ready);
        if (!allReady) break;
        await this.ctx.storage.put('status', 'in_progress');
        const activePlayers = SEAT_ORDER.filter((s) => state.seats[s]);
        const bots = {};
        for (const [s, p] of present) if (p.isBot) bots[s] = p.botDifficulty;
        this.broadcast({ t: 'START', activePlayers, seats: state.seats, bots, mapId: 'default' });
        await this.notifyDirectory({ roomId: state.roomId, status: 'in_progress' });
        break;
      }
      case 'ORDER': {
        // Klient -> host WYŁĄCZNIE (host nigdy nie wysyła sam do siebie
        // rozkazu tą drogą — swoje rozkazy stosuje lokalnie od razu).
        if (seat === state.hostSeat) break;
        const hostWs = this.findSocketForSeat(state.hostSeat);
        if (hostWs) hostWs.send(JSON.stringify({ t: 'ORDER', seat, seq: msg.seq, order: msg.order }));
        break;
      }
      case 'GAME_OVER': {
        if (seat !== state.hostSeat) break;
        this.broadcast({ t: 'GAME_OVER', result: msg.result });
        await this.ctx.storage.put('status', 'done');
        await this.notifyDirectory({ roomId: state.roomId, status: 'done' });
        break;
      }
      case 'LEAVE': {
        // Wyjście świadome (przycisk, nie zerwanie połączenia) — bez
        // okresu karencji, natychmiastowe powiadomienie.
        if (seat === state.hostSeat) {
          this.broadcast({ t: 'HOST_LEFT' }, seat);
          await this.ctx.storage.put('status', 'done');
          await this.notifyDirectory({ roomId: state.roomId, status: 'done' });
        } else {
          this.broadcast({ t: 'PLAYER_DISCONNECTED', seat, graceMs: 0 }, seat);
          this.broadcast({ t: 'PLAYER_TIMED_OUT', seat }, seat);
        }
        try { ws.close(); } catch (e) { /* ignore */ }
        break;
      }
      default:
        break;
    }
  }

  async handleDisconnect(ws) {
    const att = ws.deserializeAttachment() || {};
    const seat = att.seat;
    if (!seat) return;
    const state = await this.getRoomState();
    if (!state.seats[seat]) return;
    state.seats[seat].connected = false;

    if (seat === state.hostSeat) {
      // Rozłączenie hosta kończy mecz dla wszystkich, bez okresu karencji
      // (patrz CLAUDE.md/plan — brak migracji hosta na tym etapie).
      await this.ctx.storage.put({ seats: state.seats, status: 'done' });
      this.broadcast({ t: 'HOST_LEFT' }, seat);
      await this.notifyDirectory({ roomId: state.roomId, status: 'done' });
      return;
    }

    const deadline = Date.now() + RECONNECT_GRACE_MS;
    state.disconnectDeadlines[seat] = deadline;
    await this.ctx.storage.put({ seats: state.seats, disconnectDeadlines: state.disconnectDeadlines });
    this.broadcast({ t: 'PLAYER_DISCONNECTED', seat, graceMs: RECONNECT_GRACE_MS }, seat);
    await this.scheduleNextAlarm(state.disconnectDeadlines);
  }

  async scheduleNextAlarm(disconnectDeadlines) {
    const deadlines = Object.values(disconnectDeadlines);
    if (deadlines.length === 0) return;
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  async webSocketClose(ws) { await this.handleDisconnect(ws); }
  async webSocketError(ws) { await this.handleDisconnect(ws); }

  // Wygasł okres karencji rozłączenia — gracz wypada (PLAYER_TIMED_OUT).
  // Serwer NIE decyduje, co to znaczy dla gry (eliminacja/neutralizacja
  // miast) — to wyłącznie dane dla hosta, który to interpretuje (patrz
  // handlePlayerTimeout w index.html).
  async alarm() {
    const state = await this.getRoomState();
    const now = Date.now();
    let changed = false;
    for (const [seat, deadline] of Object.entries(state.disconnectDeadlines)) {
      if (deadline > now) continue;
      delete state.disconnectDeadlines[seat];
      changed = true;
      if (state.seats[seat] && !state.seats[seat].connected) {
        this.broadcast({ t: 'PLAYER_TIMED_OUT', seat });
      }
    }
    if (changed) await this.ctx.storage.put('disconnectDeadlines', state.disconnectDeadlines);
    await this.scheduleNextAlarm(state.disconnectDeadlines);
  }
}

// ============================================================
// Worker — routing HTTP. Sam nigdy nie trzyma stanu, wyłącznie kieruje do
// właściwego Durable Object.
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return corsPreflight();

    const directoryStub = () => env.LOBBY_DIRECTORY.get(env.LOBBY_DIRECTORY.idFromName('global'));

    if (url.pathname === '/api/lobbies' && request.method === 'GET') {
      const res = await directoryStub().fetch('https://directory/list');
      return res;
    }
    if (url.pathname === '/api/lobbies' && request.method === 'POST') {
      const res = await directoryStub().fetch('https://directory/create', { method: 'POST', body: request.body });
      return res;
    }
    const joinMatch = url.pathname.match(/^\/api\/lobbies\/([^/]+)\/join$/);
    if (joinMatch && request.method === 'POST') {
      const roomStub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(joinMatch[1]));
      return roomStub.fetch('https://room/join', { method: 'POST', body: request.body });
    }
    const wsMatch = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (wsMatch) {
      const roomStub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(wsMatch[1]));
      const roomUrl = new URL('https://room/ws');
      roomUrl.searchParams.set('token', url.searchParams.get('token') || '');
      return roomStub.fetch(roomUrl.toString(), request);
    }

    return json({ error: 'NOT_FOUND' }, 404);
  },
};
