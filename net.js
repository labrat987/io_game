// net.js — klient sieciowy trybu online (lobby + WebSocket do serwera).
// Ładowany jak ai.js (moduł ES, po pełnym sparsowaniu classic-scriptu),
// komunikuje się z silnikiem WYŁĄCZNIE przez:
// - window.EngineNetAPI (silnik -> sieć: dispatchOrder w trybie CLIENT
//   woła EngineNetAPI.sendOrder; Krok 5 doda sendSnapshot/sampleRenderState)
// - window.startGame/window.applyRemoteOrder (sieć -> silnik, funkcje
//   klasycznego skryptu, dostępne na window jak każda deklaracja
//   `function` na najwyższym poziomie)
// CELOWO osobny most niż window.GameAPI (które czyta ai.js) — zmiana tutaj
// nie może wpłynąć na AI.
//
// Zakres tego pliku (Krok 4 planu): pełny przepływ lobby — lista, tworzenie,
// dołączanie, gotowość, boty (wyłącznie 1v1), start. Po odebraniu STARY
// (żartobliwie: START) plik NIE uruchamia jeszcze rozgrywki (patrz
// enterMatch niżej) — to Krok 5 (broadcast hosta + interpolacja klienta).

// TODO PO WDROŻENIU: podmień na realny adres Workera (patrz CLAUDE.md,
// sekcja "Tryb online" + instrukcje wdrożenia). `?server=` w URL nadpisuje
// to na potrzeby testów lokalnych (patrz plan, lokalny test wieloosobowy).
const DEFAULT_SERVER_URL = 'https://warconvoy-server.TWOJA-NAZWA.workers.dev';
const NET_SERVER_URL = new URLSearchParams(location.search).get('server') || DEFAULT_SERVER_URL;

const PLAYER_COLORS = { P1: '#2f6fed', P2: '#e63946', P3: '#6f42c1', P4: '#ff8c1a' };
const SEAT_ORDER = ['P1', 'P2', 'P3', 'P4'];
const MODE_LABELS = { ONE_V_ONE: '1v1', DEATHMATCH: 'Deathmatch' };
const MODE_MAX_SEATS = { ONE_V_ONE: 2, DEATHMATCH: 4 };

let ws = null;
let mySeat = null;
let isHost = false;
let roomId = null;
let lobbyMode = null;
let lobbyPlayers = {};
let lobbyStatus = 'waiting';
let hostSeat = null;
let pendingMode = 'ONE_V_ONE'; // wybór w formularzu tworzenia lobby, przed wysłaniem

function httpUrl(path) { return NET_SERVER_URL.replace(/^ws/, 'http') + path; }
function socketUrl(path) { return NET_SERVER_URL.replace(/^http/, 'ws') + path; }

const contentEl = () => document.getElementById('onlineContent');
const overlayEl = () => document.getElementById('onlineOverlay');

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

// ============================================================
// Ekran 1: lista lobby
// ============================================================
async function renderLobbyList() {
  const root = contentEl();
  root.innerHTML = '';
  root.appendChild(el('h2', { style: 'text-align:center;' }, ['Gra online']));

  let data;
  try {
    const res = await fetch(httpUrl('/api/lobbies'));
    data = await res.json();
  } catch (e) {
    root.appendChild(el('p', { className: 'lobbyEmptyHint' }, [`Brak połączenia z serwerem (${NET_SERVER_URL}). Sprawdź adres w net.js albo parametr ?server=.`]));
    root.appendChild(backRow());
    return;
  }

  const list = el('div');
  if (data.lobbies.length === 0) {
    list.appendChild(el('p', { className: 'lobbyEmptyHint' }, ['Brak aktywnych lobby — utwórz pierwsze.']));
  } else {
    for (const lobby of data.lobbies) {
      const row = el('div', { className: 'lobbyListRow' }, [
        el('div', {}, [
          el('div', { className: 'lobbyName' }, [lobby.name]),
          el('div', { className: 'lobbyMeta' }, [`${MODE_LABELS[lobby.mode] || lobby.mode} — ${lobby.playerCount}/${lobby.maxSeats} graczy — ${lobby.status === 'waiting' ? 'oczekuje' : lobby.status === 'in_progress' ? 'w grze' : 'zakończone'}`]),
        ]),
      ]);
      if (lobby.status === 'waiting' && lobby.playerCount < lobby.maxSeats) {
        row.onclick = () => joinLobby(lobby.id);
      } else {
        row.style.opacity = '0.5';
        row.style.cursor = 'default';
      }
      list.appendChild(row);
    }
  }
  root.appendChild(list);
  root.appendChild(el('button', { className: 'menuButton', textContent: 'Utwórz lobby', onclick: renderCreateForm }));
  root.appendChild(el('button', { className: 'menuButton', textContent: 'Odśwież', onclick: renderLobbyList }));
  root.appendChild(backRow());
}

function backRow() {
  return el('div', { className: 'menuBackRow' }, [
    el('button', { className: 'menuButton', textContent: 'Wstecz', onclick: () => { window.hideOverlay(overlayEl()); window.showOverlay(document.getElementById('mainMenuOverlay')); } }),
  ]);
}

// ============================================================
// Ekran 2: tworzenie lobby
// ============================================================
function renderCreateForm() {
  const root = contentEl();
  root.innerHTML = '';
  root.appendChild(el('h2', { style: 'text-align:center;' }, ['Nowe lobby']));

  const nameInput = el('input', { className: 'netTextInput', placeholder: 'Nazwa lobby', value: 'Lobby ' + Math.floor(Math.random() * 1000), maxLength: 40 });
  root.appendChild(nameInput);

  const modeRow = el('div', { className: 'modeToggleRow' });
  for (const mode of ['ONE_V_ONE', 'DEATHMATCH']) {
    const btn = el('button', {
      className: 'modeToggleBtn' + (mode === pendingMode ? ' selected' : ''),
      textContent: mode === 'ONE_V_ONE' ? '1v1 (2 graczy)' : 'Deathmatch (2-4 graczy)',
    });
    btn.onclick = () => { pendingMode = mode; renderCreateForm(); };
    modeRow.appendChild(btn);
  }
  root.appendChild(modeRow);

  root.appendChild(el('button', { className: 'menuButton', textContent: 'Utwórz', onclick: () => createLobby(nameInput.value) }));
  root.appendChild(el('div', { className: 'menuBackRow' }, [
    el('button', { className: 'menuButton', textContent: 'Wstecz', onclick: renderLobbyList }),
  ]));
}

async function createLobby(name) {
  try {
    const res = await fetch(httpUrl('/api/lobbies'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Lobby', mode: pendingMode }),
    });
    const data = await res.json();
    if (data.error) { alert('Nie udało się utworzyć lobby: ' + data.error); return; }
    lobbyMode = pendingMode;
    connectRoom(data.roomId, data.token);
  } catch (e) {
    alert('Brak połączenia z serwerem.');
  }
}

async function joinLobby(id) {
  try {
    const res = await fetch(httpUrl(`/api/lobbies/${id}/join`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Gracz' }) });
    const data = await res.json();
    if (data.error) { alert('Nie udało się dołączyć: ' + data.error); return; }
    connectRoom(id, data.token);
  } catch (e) {
    alert('Brak połączenia z serwerem.');
  }
}

// ============================================================
// WebSocket — połączenie z pokojem, trwa przez całe lobby I mecz (ten sam
// socket przekazuje potem ORDER/snapshoty, patrz Krok 5).
// ============================================================
function connectRoom(id, token) {
  roomId = id;
  ws = new WebSocket(socketUrl(`/api/room/${id}/ws?token=${token}`));
  ws.onmessage = (event) => handleMessage(event.data);
  ws.onclose = () => {
    if (lobbyStatus !== 'in_progress') {
      alert('Połączenie z lobby przerwane.');
      renderLobbyList();
    }
  };
  ws.onerror = () => { /* onclose i tak posprząta */ };
}

function handleMessage(raw) {
  if (typeof raw === 'string' && raw.startsWith('S|')) {
    if (window.EngineNetAPI && window.EngineNetAPI.onSnapshotFrame) window.EngineNetAPI.onSnapshotFrame(raw);
    return;
  }
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  switch (msg.t) {
    case 'WELCOME':
      mySeat = msg.seat; isHost = msg.isHost; lobbyMode = msg.mode;
      lobbyPlayers = msg.players; lobbyStatus = msg.status;
      hostSeat = isHost ? mySeat : hostSeat;
      renderLobbyRoom();
      break;
    case 'LOBBY_STATE':
      lobbyPlayers = msg.players; lobbyStatus = msg.status; hostSeat = msg.hostSeat;
      if (lobbyStatus === 'waiting') renderLobbyRoom();
      break;
    case 'START':
      lobbyStatus = 'in_progress';
      enterMatch(msg);
      break;
    case 'ORDER':
      // Host odbiera rozkaz zdalnego gracza — stosuje NATYCHMIAST (nie
      // czeka na kolejny tick, silnik i tak liczy to jednorazowo jak
      // każdy inny rozkaz gracza/AI). Pełne działanie od Kroku 5, kiedy
      // rozgrywka faktycznie już trwa.
      if (isHost && window.applyRemoteOrder) window.applyRemoteOrder(msg.seat, msg.order.type, msg.order.payload);
      break;
    case 'PLAYER_DISCONNECTED':
      console.log(`[online] gracz ${msg.seat} rozłączony (${msg.graceMs}ms na powrót)`);
      if (lobbyStatus === 'waiting') renderLobbyRoom();
      break;
    case 'PLAYER_RECONNECTED':
      console.log(`[online] gracz ${msg.seat} wrócił`);
      break;
    case 'PLAYER_TIMED_OUT':
      console.log(`[online] gracz ${msg.seat} nie wrócił — wypadł`);
      // Eliminacja/neutralizacja miast w trakcie meczu — patrz Krok 7.
      if (window.handlePlayerTimeout) window.handlePlayerTimeout(msg.seat);
      break;
    case 'HOST_LEFT':
      alert('Host opuścił grę — mecz zakończony.');
      ws.close(); ws = null;
      location.reload();
      break;
    case 'GAME_OVER':
      // Ekran końca gry dla trybu online — patrz Krok 7.
      console.log('[online] GAME_OVER', msg.result);
      break;
    default:
      break;
  }
}

// ============================================================
// Ekran 3: poczekalnia (lista miejsc, gotowość, boty, start)
// ============================================================
function renderLobbyRoom() {
  const root = contentEl();
  root.innerHTML = '';
  root.appendChild(el('h2', { style: 'text-align:center;' }, [`Lobby — ${MODE_LABELS[lobbyMode] || lobbyMode}`]));

  const maxSeats = MODE_MAX_SEATS[lobbyMode] || 2;
  for (const seat of SEAT_ORDER.slice(0, maxSeats)) {
    const player = lobbyPlayers[seat];
    const dot = el('span', { className: 'seatColorDot', style: `background:${PLAYER_COLORS[seat]}` });
    if (!player) {
      const row = el('div', { className: 'seatRow' }, [
        el('div', {}, [dot, el('span', { className: 'seatEmpty' }, ['(wolne miejsce)'])]),
      ]);
      if (isHost && lobbyMode === 'ONE_V_ONE') {
        const addBotBtn = el('button', { className: 'menuButton', style: 'width:auto; margin:0; padding:6px 12px;', textContent: 'Dodaj bota (Średni)' });
        addBotBtn.onclick = () => ws.send(JSON.stringify({ t: 'ADD_BOT', seat, difficulty: 'MEDIUM' }));
        row.appendChild(addBotBtn);
      }
      root.appendChild(row);
      continue;
    }
    const nameLabel = player.isBot ? `${player.name} (${player.botDifficulty})` : player.name;
    const row = el('div', { className: 'seatRow' }, [
      el('div', {}, [dot, el('span', { className: 'seatName' }, [nameLabel + (seat === hostSeat ? ' [host]' : '')])]),
      el('span', { className: 'seatReady ' + (player.ready ? 'isReady' : 'notReady'), textContent: player.ready ? 'Gotowy' : 'Nie gotowy' }),
    ]);
    if (player.isBot && isHost) {
      const removeBtn = el('button', { className: 'menuButton', style: 'width:auto; margin:0; padding:6px 12px;', textContent: 'Usuń bota' });
      removeBtn.onclick = () => ws.send(JSON.stringify({ t: 'REMOVE_BOT', seat }));
      row.appendChild(removeBtn);
    }
    root.appendChild(row);
  }

  if (mySeat && lobbyPlayers[mySeat] && !lobbyPlayers[mySeat].isBot) {
    const iAmReady = lobbyPlayers[mySeat].ready;
    root.appendChild(el('button', {
      className: 'menuButton', textContent: iAmReady ? 'Nie jestem gotowy' : 'Gotowy',
      onclick: () => ws.send(JSON.stringify({ t: 'READY', ready: !iAmReady })),
    }));
  }

  if (isHost) {
    const present = Object.values(lobbyPlayers);
    const canStart = present.length >= 2 && present.every((p) => p.ready);
    const startBtn = el('button', { className: 'menuButton', textContent: canStart ? 'Rozpocznij' : 'Rozpocznij (czeka na graczy/gotowość)' });
    startBtn.disabled = !canStart;
    if (!canStart) startBtn.style.opacity = '0.5';
    startBtn.onclick = () => ws.send(JSON.stringify({ t: 'START' }));
    root.appendChild(startBtn);
  }

  root.appendChild(el('div', { className: 'menuBackRow' }, [
    el('button', {
      className: 'menuButton', textContent: 'Opuść lobby',
      onclick: () => { if (ws) { ws.send(JSON.stringify({ t: 'LEAVE' })); ws.close(); ws = null; } window.hideOverlay(overlayEl()); window.showOverlay(document.getElementById('mainMenuOverlay')); },
    }),
  ]));
}

// ============================================================
// Przejście do rozgrywki — CELOWO placeholder w tym kroku (Krok 4).
// Krok 5 doda: window.startGame({mode:'ONLINE_HOST'/'ONLINE_CLIENT',
// activePlayers, ownSeat, aiSeat, aiDifficulty}) oraz podłączenie
// broadcastu/interpolacji, zanim rozgrywka realnie ruszy — bez tego
// klient uruchomiłby WŁASNĄ, niezależną symulację zamiast wyświetlać
// tę hosta (patrz plan, sekcja "Kolejność budowy").
// ============================================================
function enterMatch(startMsg) {
  window.hideOverlay(overlayEl());
  const root = contentEl();
  root.innerHTML = '';
  root.appendChild(el('h2', { style: 'text-align:center;' }, ['Mecz się rozpoczyna...']));
  root.appendChild(el('p', { className: 'lobbyEmptyHint' }, [
    `Gracze: ${startMsg.activePlayers.join(', ')}. Właściwa rozgrywka online (Krok 5 planu) jeszcze niepodłączona w tej wersji.`,
  ]));
  window.showOverlay(overlayEl());
  console.log('[online] START', startMsg);
}

// ============================================================
// Most silnik -> sieć. Krok 5 dopełni sendSnapshot/onSnapshotFrame.
// ============================================================
window.EngineNetAPI = {
  sendOrder(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'ORDER', seq: 0, order: { type, payload } }));
  },
};

document.getElementById('menuOnlineBtn').onclick = () => {
  window.hideOverlay(document.getElementById('mainMenuOverlay'));
  window.showOverlay(overlayEl());
  renderLobbyList();
};
