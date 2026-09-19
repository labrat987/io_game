// ============================================================
// AI PRZECIWNIKA — moduł ES, importowany przez index.html
// (<script type="module" src="ai.js">). Komunikuje się z grą WYŁĄCZNIE
// przez window.GameAPI — te same funkcje-rozkazy, których używa gracz
// (issueMoveOrder/issueRouteOrder/issueFrontOrder/queueProduction/
// upgradeCity/createTradeRoute/setTargetPriority), nigdy bezpośrednio
// nie mutuje stanu silnika poza tym mostkiem. Reguła nadrzędna: AI ma
// grać jak człowiek na poziomie operacyjnym — myśli grupami, decyduje
// co kilka sekund, nie mikrozarządza, popełnia okazjonalne błędy.
//
// "AI widzi tylko to, co widziałby gracz" — silnik nie ma fog of war
// (potwierdzone), więc to WYŁĄCZNIE dyscyplina kodu poniżej: AI nigdy
// nie czyta gold/kolejki/postępu ulepszenia CUDZYCH miast (gracz też
// tego nie widzi — panel miasta pokazuje tylko własne). Wolno czytać:
// pozycje/typ/HP/morale/routed/owner każdej jednostki (paski HP/morale
// są rysowane dla wszystkich, widoczne), owner/level/siegeProgress/
// besiegingOwner każdego miasta (kropki poziomu i pasek oblężenia są
// zawsze widoczne dla obu stron) i pozycje konwojów (widoczne na mapie).
// ============================================================

'use strict';

// ------------------------------------------------------------
// AI_CONFIG — WSZYSTKIE parametry zachowania w jednym miejscu. Przyszłe
// poziomy trudności = inny zestaw tych wartości (np. mniejszy
// decisionIntervalSeconds i mistakeChance dla "trudnego"), bez zmiany
// logiki niżej.
// ------------------------------------------------------------
const AI_CONFIG = {
  decisionIntervalSeconds: 4, // operacyjne decyzje co kilka sekund, nie co klatkę
  reactionDelaySeconds: 4, // opóźnienie zauważenia zagrożenia (oblężenie własnego miasta)
  offenseSuperiorityThreshold: 1.4, // wymagana przewaga siły (patrz unitPower), żeby zaatakować miasto wroga
  mistakeChance: 0.15, // szansa błędu: atak bez pełnej przewagi / pominięcie wzmocnienia obrony
  retreatGroupHpFraction: 0.45, // śr. HP% grupy poniżej którego CAŁA grupa wraca do miasta się leczyć
  retreatCombatHpRatio: 0.5, // stosunek siły w aktywnym starciu poniżej którego grupa się wycofuje
  flankAttemptChance: 0.3, // szansa, że kawaleria w natarciu spróbuje z boku/tyłu zamiast wprost
  convoyRaidChance: 0.2, // szansa próby rajdu na widoczny konwój wroga, na turę decyzyjną
  garrisonMinUnits: 2, // minimalny garnizon utrzymywany w najbardziej zagrożonym/frontowym mieście
  rangedBehindOffsetPx: 40, // o ile jednostki dystansowe cofają się za linię melee przy formowaniu pozycji
  economySplitBase: 0.7, // ułamek decyzji wydatkowych na produkcję (reszta na ulepszenia) w spokoju
  economySplitUnderPressure: 0.9, // jw. pod presją militarną
  targetArmyComposition: {
    LIGHT_INFANTRY: 0.3,
    HEAVY_INFANTRY: 0.25,
    ARCHER: 0.2,
    CANNON: 0.1,
    CAVALRY: 0.15,
  },
};

// ------------------------------------------------------------
// Stan AI — WYŁĄCZNIE w tym module, silnik o nim nic nie wie. Trzy
// zgrupowania z zadaniami (obrona/natarcie/rezerwa) — "rozwiązanie"
// grupy to po prostu wyczyszczenie jej Setu: niezrzeszone żywe
// jednostki są co turę decyzyjną zbierane z powrotem do REZERWY.
// ------------------------------------------------------------
function createState() {
  return {
    owner: null,
    enemyOwner: null,
    decisionTimer: 0,
    groups: {
      defense: new Set(),
      offense: new Set(),
      reserve: new Set(),
    },
    offenseTargetCityId: null,
    siegeNoticedAt: new Map(), // cityId -> { besiegingOwner, firstSeenAt (ms) }
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Siła jednostki jako prosty, wytłumaczalny szacunek: koszt produkcji
// (już jest to ustalona miara "ile jest warta" w bilansie gry) skalowany
// aktualnym ułamkiem HP — ranna jednostka liczy się mniej.
function unitPower(api, u) {
  const cfg = api.UNIT_TYPES[u.type];
  return cfg.cost * (u.hp / cfg.maxHp);
}

function sumPower(api, units) {
  return units.reduce((s, u) => s + unitPower(api, u), 0);
}

function isCombatUnit(u) {
  return u.type !== 'CONVOY' && u.hp > 0;
}

function myAliveUnits(api, state) {
  return api.getUnits().filter((u) => u.owner === state.owner && isCombatUnit(u));
}

function enemyAliveUnits(api, state) {
  return api.getUnits().filter((u) => u.owner === state.enemyOwner && isCombatUnit(u));
}

function myCities(api, state) {
  return api.CITIES.filter((c) => c.owner === state.owner);
}

function enemyCities(api, state) {
  return api.CITIES.filter((c) => c.owner === state.enemyOwner);
}

function nearestCity(point, cityList, api) {
  let best = null, bestDist = Infinity;
  for (const c of cityList) {
    const d = dist(point, api.cityCenter(c));
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// Odśwież przynależność grup: usuń martwe/utracone jednostki (zginęły
// albo miasto, które je "urodziło", zostało przejęte — niemożliwe dla
// jednostek, ale zachowujemy spójność), zbierz jednostki nienależące do
// żadnej grupy do REZERWY (nowo wyprodukowane ORAZ te, których grupa
// właśnie się "rozwiązała" po odwrocie).
function refreshGroups(api, state) {
  const alive = new Set(myAliveUnits(api, state));
  for (const key of ['defense', 'offense', 'reserve']) {
    for (const u of state.groups[key]) {
      if (!alive.has(u)) state.groups[key].delete(u);
    }
  }
  const assigned = new Set([...state.groups.defense, ...state.groups.offense, ...state.groups.reserve]);
  for (const u of alive) {
    if (!assigned.has(u)) state.groups.reserve.add(u);
  }
}

function groupHpFraction(api, unitSet) {
  const list = [...unitSet];
  if (list.length === 0) return 1;
  let hp = 0, maxHp = 0;
  for (const u of list) {
    hp += u.hp;
    maxHp += api.UNIT_TYPES[u.type].maxHp;
  }
  return maxHp > 0 ? hp / maxHp : 1;
}

// Czy AI jest pod presją militarną — którekolwiek własne miasto akurat
// oblężone, LUB łączna siła AI wyraźnie niższa niż widoczna siła wroga.
// Wpływa na podział złota (część 2, "Ekonomia i miasta").
function isUnderPressure(api, state) {
  if (myCities(api, state).some((c) => c.besiegingOwner)) return true;
  const myPower = sumPower(api, myAliveUnits(api, state));
  const enemyPower = sumPower(api, enemyAliveUnits(api, state));
  return myPower < enemyPower * 0.8;
}

// ------------------------------------------------------------
// Teren — lekkie heurystyki, NIE pełne planowanie grafowe (zgodnie z
// "bez ML i skomplikowanego planowania").
// ------------------------------------------------------------

// Przybliżenie "wąskiego przejścia": próbkuje kilka punktów na odcinku
// między dwoma punktami i wybiera ten z największą liczbą sąsiednich
// kafli nieprzechodnich (góry) — więcej sąsiadujących gór ~ węższe
// przejście. Nie gwarantuje znalezienia obiektywnie najlepszej
// przełęczy, tylko rozsądny punkt obrony zamiast dokładnie na mieście.
function findChokePoint(api, from, to) {
  const samples = 5;
  let best = null, bestScore = -1;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const px = from.x + (to.x - from.x) * t;
    const py = from.y + (to.y - from.y) * t;
    const tile = api.worldToTile(px, py);
    let score = 0;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const terrain = api.terrainAt(tile.col + dc, tile.row + dr);
        if (terrain && !terrain.passable) score++;
      }
    }
    if (score > bestScore) { bestScore = score; best = { x: px, y: py }; }
  }
  return best || { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

function isForestAt(api, point) {
  const tile = api.worldToTile(point.x, point.y);
  const terrain = api.terrainAt(tile.col, tile.row);
  return !!terrain && terrain.name === 'FOREST';
}
function isHillsAt(api, point) {
  const tile = api.worldToTile(point.x, point.y);
  const terrain = api.terrainAt(tile.col, tile.row);
  return !!terrain && terrain.name === 'HILLS';
}

// Szuka w małym otoczeniu punktu kafla HILLS (bonus zasięgu dla
// dystansowych) — jeśli nie znajdzie w rozsądnym promieniu, zwraca
// oryginalny punkt bez zmian (dystansowi po prostu staną tam, gdzie
// reszta grupy).
function nearbyHillsOrSame(api, point) {
  for (let radius = 0; radius <= 2; radius++) {
    for (let dc = -radius; dc <= radius; dc++) {
      for (let dr = -radius; dr <= radius; dr++) {
        const tile = api.worldToTile(point.x, point.y);
        const candidate = api.tileToWorld(tile.col + dc, tile.row + dr);
        if (isHillsAt(api, candidate)) return candidate;
      }
    }
  }
  return point;
}

// ------------------------------------------------------------
// Wydawanie rozkazów grupie — dystansowi ustawiani ZA linią melee
// (offset w stronę "domu", czyli przeciwnie do kierunku natarcia),
// preferujący wzgórza, jeśli są w pobliżu. Rozkaz wydawany NAJWYŻEJ raz
// na turę decyzyjną tej samej grupie — między turami dystansowi zdążą
// się rozstawić i strzelać (patrz UNIT_TYPES.setupTime/resolveCombat w
// index.html: nowy rozkaz zeruje rozstawienie).
// ------------------------------------------------------------
function issueGroupOrder(api, unitSet, targetPoint, homeRefPoint) {
  const list = [...unitSet];
  if (list.length === 0) return;
  const melee = list.filter((u) => !api.UNIT_TYPES[u.type].ranged);
  const ranged = list.filter((u) => api.UNIT_TYPES[u.type].ranged);
  if (melee.length > 0) api.issueMoveOrder(melee, targetPoint);
  if (ranged.length > 0) {
    const dx = homeRefPoint.x - targetPoint.x, dy = homeRefPoint.y - targetPoint.y;
    const len = Math.hypot(dx, dy) || 1;
    let rangedTarget = {
      x: targetPoint.x + (dx / len) * AI_CONFIG.rangedBehindOffsetPx,
      y: targetPoint.y + (dy / len) * AI_CONFIG.rangedBehindOffsetPx,
    };
    rangedTarget = nearbyHillsOrSame(api, rangedTarget);
    api.issueMoveOrder(ranged, rangedTarget);
  }
}

// ------------------------------------------------------------
// Obrona — utrzymuje garnizon we własnej strefie, reaguje na oblężenie
// z opóźnieniem (reactionDelaySeconds od PIERWSZEGO zaobserwowania, nie
// natychmiast).
// ------------------------------------------------------------
function decideDefense(api, state, now) {
  const mine = myCities(api, state);
  if (mine.length === 0) return;

  // Aktualizuj timery zauważenia oblężenia — jedna z niewielu spraw
  // sprawdzanych KAŻDĄ turę decyzyjną (próg jest sam w sobie opóźnieniem).
  const besiegedNow = new Set();
  for (const c of mine) {
    if (!c.besiegingOwner) continue;
    besiegedNow.add(c.id);
    const rec = state.siegeNoticedAt.get(c.id);
    if (!rec || rec.besiegingOwner !== c.besiegingOwner) {
      state.siegeNoticedAt.set(c.id, { besiegingOwner: c.besiegingOwner, firstSeenAt: now });
    }
  }
  for (const cityId of [...state.siegeNoticedAt.keys()]) {
    if (!besiegedNow.has(cityId)) state.siegeNoticedAt.delete(cityId);
  }

  // Miasto uznane za "zauważone zagrożenie" dopiero po reactionDelaySeconds.
  let threatenedCity = null;
  for (const c of mine) {
    const rec = state.siegeNoticedAt.get(c.id);
    if (rec && (now - rec.firstSeenAt) / 1000 >= AI_CONFIG.reactionDelaySeconds) {
      threatenedCity = c;
      break;
    }
  }

  // Brak realnego zagrożenia: okazjonalny błąd = czasem AI zostawia
  // miasto słabiej bronione (pomija odświeżenie garnizonu w tej turze).
  if (!threatenedCity && Math.random() < AI_CONFIG.mistakeChance) return;

  const focusCity = threatenedCity || nearestCity(
    api.cityCenter(mine[0]),
    mine,
    api,
  ) || mine[0];

  const currentDefenders = groupSizeAt(api, state.groups.defense, focusCity);
  if (currentDefenders < AI_CONFIG.garrisonMinUnits && state.groups.reserve.size > 0) {
    const need = AI_CONFIG.garrisonMinUnits - currentDefenders;
    const reinforcements = [...state.groups.reserve].slice(0, need);
    for (const u of reinforcements) {
      state.groups.reserve.delete(u);
      state.groups.defense.add(u);
    }
  }

  if (state.groups.defense.size === 0) return;
  const target = threatenedCity ? api.cityCenter(threatenedCity) : api.cityCenter(focusCity);
  const home = target;
  issueGroupOrder(api, state.groups.defense, target, home);
}

function groupSizeAt(api, unitSet) {
  return unitSet.size;
}

// ------------------------------------------------------------
// Natarcie — cel to miasto gracza, gdzie lokalna siła AI wyraźnie
// przewyższa siłę obrońcy widoczną w jego strefie. Pamięta, że
// przejęcie wymaga PUSTEJ strefy: jeśli obrońca tam wciąż stoi, cel
// ruchu to i tak strefa miasta — walka o jej oczyszczenie idzie sama,
// automatyczną walką silnika.
// ------------------------------------------------------------
function decideOffense(api, state) {
  const targets = enemyCities(api, state);
  if (targets.length === 0) return;

  const reserveList = [...state.groups.reserve];
  const spareForOffense = reserveList.slice(AI_CONFIG.garrisonMinUnits); // zostaw trochę na obronę
  if (spareForOffense.length === 0 && state.groups.offense.size === 0) return;

  const myPower = sumPower(api, spareForOffense.length > 0 ? spareForOffense : [...state.groups.offense]);
  if (myPower <= 0) return;

  let bestCity = null, bestRatio = -Infinity;
  for (const city of targets) {
    const center = api.cityCenter(city);
    const defenders = enemyAliveUnits(api, state).filter((u) => dist(u, center) <= api.CITY_ZONE_RADIUS + 60);
    const defenderPower = sumPower(api, defenders) || 1;
    const ratio = myPower / defenderPower;
    if (ratio > bestRatio) { bestRatio = ratio; bestCity = city; }
  }
  if (!bestCity) return;

  const meetsThreshold = bestRatio >= AI_CONFIG.offenseSuperiorityThreshold;
  const mistake = Math.random() < AI_CONFIG.mistakeChance; // czasem atakuje bez pełnej przewagi
  if (!meetsThreshold && !mistake) return;

  for (const u of spareForOffense) {
    state.groups.reserve.delete(u);
    state.groups.offense.add(u);
  }
  state.offenseTargetCityId = bestCity.id;

  const homeCity = nearestCity(api.cityCenter(bestCity), myCities(api, state), api) || myCities(api, state)[0];
  const home = homeCity ? api.cityCenter(homeCity) : api.cityCenter(bestCity);
  const target = api.cityCenter(bestCity);

  const cavalry = [...state.groups.offense].filter((u) => u.type === 'CAVALRY');
  const rest = [...state.groups.offense].filter((u) => u.type !== 'CAVALRY');

  if (cavalry.length > 0 && Math.random() < AI_CONFIG.flankAttemptChance) {
    // Podejście z boku/tyłu: przesunięcie prostopadłe do osi dom->cel.
    const dx = target.x - home.x, dy = target.y - home.y;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len, perpY = dx / len;
    const side = Math.random() < 0.5 ? 1 : -1;
    const flankTarget = { x: target.x + perpX * side * 80, y: target.y + perpY * side * 80 };
    api.issueMoveOrder(cavalry, flankTarget);
    issueGroupOrder(api, new Set(rest), target, home);
  } else {
    issueGroupOrder(api, new Set(state.groups.offense), target, home);
  }
}

// ------------------------------------------------------------
// Odwrót z przegrywanego starcia — grupa aktywnie zaangażowana, której
// siła wyraźnie ustępuje widocznym wrogom w pobliżu, wraca do
// najbliższego miasta zamiast walczyć do końca. "Rozwiązanie" grupy =
// wyczyszczenie Setu — ocalali wrócą do REZERWY w kolejnej turze.
// ------------------------------------------------------------
function decideRetreat(api, state) {
  for (const key of ['offense', 'defense']) {
    const set = state.groups[key];
    if (set.size === 0) continue;
    const list = [...set];
    const engaged = list.some((u) => u.engagedTargetId != null);
    if (!engaged) continue;

    const centroid = { x: list.reduce((s, u) => s + u.x, 0) / list.length, y: list.reduce((s, u) => s + u.y, 0) / list.length };
    const nearbyEnemies = enemyAliveUnits(api, state).filter((u) => dist(u, centroid) <= 120);
    const myPower = sumPower(api, list);
    const enemyPower = sumPower(api, nearbyEnemies);
    if (enemyPower <= 0) continue;

    if (myPower / enemyPower < AI_CONFIG.retreatCombatHpRatio) {
      const home = nearestCity(centroid, myCities(api, state), api);
      if (home) api.issueMoveOrder(list, api.cityCenter(home));
      set.clear(); // rozwiązanie grupy — ocalali wrócą do rezerwy
    }
  }
}

// Rotacja uszkodzonych oddziałów: CAŁA grupa (nie pojedyncze jednostki)
// poniżej progu średniego HP wraca do miasta się leczyć (patrz
// canRegenerateHere w index.html — leczenie działa TYLKO w strefie
// miasta). To decyzja na poziomie grupy, podejmowana co turę decyzyjną
// — nie mikrozarządzanie pojedynczą raną jednostką w środku starcia.
function decideHealingRotation(api, state) {
  for (const key of ['defense', 'offense']) {
    const set = state.groups[key];
    if (set.size === 0) continue;
    if (groupHpFraction(api, set) >= AI_CONFIG.retreatGroupHpFraction) continue;
    const list = [...set];
    const centroid = { x: list.reduce((s, u) => s + u.x, 0) / list.length, y: list.reduce((s, u) => s + u.y, 0) / list.length };
    const home = nearestCity(centroid, myCities(api, state), api);
    if (home) api.issueMoveOrder(list, api.cityCenter(home));
    set.clear();
  }
}

// ------------------------------------------------------------
// Rajd na konwój — okazjonalny, NIE za każdym razem: tylko gdy akurat
// wypadnie rzut i akurat jest wolna (rezerwowa) grupa. To realizuje
// "niepełną uwagę" — AI nie priorytetyzuje tego nad obroną/natarciem.
// ------------------------------------------------------------
function decideConvoyRaid(api, state) {
  if (Math.random() >= AI_CONFIG.convoyRaidChance) return;
  const spareReserve = [...state.groups.reserve];
  if (spareReserve.length === 0) return;
  const enemyConvoys = api.getUnits().filter((u) => u.type === 'CONVOY' && u.owner === state.enemyOwner && u.hp > 0);
  if (enemyConvoys.length === 0) return;
  const raiders = spareReserve.slice(0, Math.min(2, spareReserve.length));
  const convoy = enemyConvoys[Math.floor(Math.random() * enemyConvoys.length)];
  api.issueMoveOrder(raiders, { x: convoy.x, y: convoy.y });
  // Celowo NIE usuwamy z rezerwy — to jednorazowe "spojrzenie w tamtą
  // stronę", nie trwałe przeznaczenie grupy do rajdów.
}

// ------------------------------------------------------------
// Ekonomia — szlaki przez zaplecze, podział złota produkcja/ulepszenia,
// zróżnicowana armia.
// ------------------------------------------------------------
function bentTradeCurve(api, cityA, cityB, awayFromPoint) {
  const a = api.cityCenter(cityA), b = api.cityCenter(cityB);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (awayFromPoint) {
    const awayX = mid.x - awayFromPoint.x, awayY = mid.y - awayFromPoint.y;
    const len = Math.hypot(awayX, awayY) || 1;
    const bendDist = 60;
    mid.x = Math.max(api.TILE_SIZE, Math.min(api.MAP_WIDTH_PX - api.TILE_SIZE, mid.x + (awayX / len) * bendDist));
    mid.y = Math.max(api.TILE_SIZE, Math.min(api.MAP_HEIGHT_PX - api.TILE_SIZE, mid.y + (awayY / len) * bendDist));
  }
  return api.simplifyCurve([a, mid, b], 6);
}

function decideTradeRoutes(api, state) {
  const mine = myCities(api, state);
  if (mine.length < 2) return;
  const enemyRef = enemyCities(api, state)[0] ? api.cityCenter(enemyCities(api, state)[0]) : null;
  const routes = api.getTradeRoutes();
  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i], b = mine[j];
      const exists = routes.some((r) =>
        (r.cityAId === a.id && r.cityBId === b.id) || (r.cityAId === b.id && r.cityBId === a.id));
      if (exists) continue;
      const curve = bentTradeCurve(api, a, b, enemyRef);
      api.createTradeRoute(a, b, state.owner, curve);
      return; // jeden nowy szlak na turę decyzyjną — bez zalewania mapy naraz
    }
  }
}

function pickProductionType(api, state) {
  const alive = myAliveUnits(api, state);
  const total = alive.length || 1;
  let bestType = null, bestGap = -Infinity;
  for (const [type, targetRatio] of Object.entries(AI_CONFIG.targetArmyComposition)) {
    const cfg = api.UNIT_TYPES[type];
    if (api.gold[state.owner] < cfg.cost) continue;
    const current = alive.filter((u) => u.type === type).length / total;
    const gap = targetRatio - current;
    if (gap > bestGap) { bestGap = gap; bestType = type; }
  }
  return bestType;
}

function decideEconomy(api, state) {
  decideTradeRoutes(api, state);

  const mine = myCities(api, state);
  if (mine.length === 0) return;
  const underPressure = isUnderPressure(api, state);
  const productionShare = underPressure ? AI_CONFIG.economySplitUnderPressure : AI_CONFIG.economySplitBase;
  const spendOnProduction = Math.random() < productionShare;

  if (spendOnProduction) {
    const type = pickProductionType(api, state);
    if (type) {
      // Miasto z najkrótszą kolejką produkuje dalej — rozkłada produkcję.
      const city = [...mine].sort((a, b) => a.queue.length - b.queue.length)[0];
      api.queueProduction(city, type);
    }
  } else {
    const upgradable = mine.filter((c) => c.level < 5 && c.upgradeRemaining === 0);
    if (upgradable.length > 0) {
      const weakest = upgradable.sort((a, b) => a.level - b.level)[0];
      api.upgradeCity(weakest);
    }
  }
}

// ------------------------------------------------------------
// Pętla decyzyjna — wołana z gameLoop (index.html) przez GameAPI.onTick,
// raz na klatkę, ale WEWNĘTRZNIE działa co decisionIntervalSeconds.
// ------------------------------------------------------------
function runDecisionCycle(api, state, now) {
  refreshGroups(api, state);
  decideHealingRotation(api, state);
  decideRetreat(api, state);
  decideDefense(api, state, now);
  decideOffense(api, state);
  decideConvoyRaid(api, state);
  decideEconomy(api, state);
}

function makeTick(api, state) {
  return function tick(dt, now) {
    if (api.isGameOver()) return;
    state.decisionTimer += dt;
    if (state.decisionTimer < AI_CONFIG.decisionIntervalSeconds) return;
    state.decisionTimer = 0;
    runDecisionCycle(api, state, now);
  };
}

export function initAI(api) {
  const owners = Object.keys(api.PLAYERS);
  const enemyOwner = owners.find((p) => p !== api.OWNED_PLAYER);
  if (!enemyOwner) return; // brak drugiego gracza do przejęcia przez AI — nic do zrobienia
  const state = createState();
  state.owner = enemyOwner;
  state.enemyOwner = api.OWNED_PLAYER;
  api.onTick(makeTick(api, state));
}

if (typeof window !== 'undefined') {
  if (window.GameAPI) {
    initAI(window.GameAPI);
  } else {
    // Skrypty modułowe wykonują się dopiero po sparsowaniu całego
    // dokumentu, czyli zawsze PO synchronicznym classic-scripcie w
    // index.html, który buduje window.GameAPI jako ostatni krok — ta
    // gałąź jest wyłącznie zabezpieczeniem na wypadek zmiany kolejności.
    window.addEventListener('DOMContentLoaded', () => {
      if (window.GameAPI) initAI(window.GameAPI);
    });
  }
}
