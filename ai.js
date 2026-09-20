// ============================================================
// AI PRZECIWNIKA — moduł ES, importowany przez index.html
// (<script type="module" src="ai.js">). Komunikuje się z grą WYŁĄCZNIE
// przez window.GameAPI — te same funkcje-rozkazy, których używa gracz
// (issueMoveOrder/issueRouteOrder/issueFrontOrder/queueProduction/
// upgradeCity/createTradeRoute/setTargetPriority), nigdy bezpośrednio
// nie mutuje stanu silnika poza tym mostkiem.
//
// ZASADA NADRZĘDNA: AI to OSTROŻNY DOWÓDCA, nie bot maksymalizujący
// skuteczność. Priorytetem jest utrzymanie spójnej armii i rozwój
// ekonomii, nie szybkie zwycięstwo. Domyślnym zachowaniem jest
// budowanie przewagi — atak jest wyjątkiem wymagającym uzasadnienia
// (przewaga liczebna/terenowa/świeże zwycięstwo), nigdy regułą. AI
// nigdy nie stawia całej armii na jedną kartę i nigdy nie ryzykuje jej
// dla pojedynczego miasta (łącznie z własnym) — lepiej, żeby grało zbyt
// zachowawczo niż zbyt agresywnie. Myśli grupami, decyduje co kilka
// sekund (nie mikrozarządza), trzyma się raz obranego celu przez dłuższy
// czas (commitmentTime), popełnia okazjonalne, rzadkie błędy.
//
// "AI widzi tylko to, co widziałby gracz" — silnik nie ma fog of war
// (potwierdzone), więc to WYŁĄCZNIE dyscyplina kodu poniżej. Pozycje,
// typ, HP, morale, routed i owner KAŻDEJ jednostki są zawsze widoczne
// na mapie (paski HP/morale rysowane dla wszystkich) — to uczciwa
// wiedza, identyczna z tym, co widzi człowiek grający przeciwko AI, więc
// ocena siły wroga na podstawie getUnits() NIE jest oszustwem. Za to
// AI NIGDY nie czyta gold/kolejki/postępu ulepszenia CUDZYCH miast —
// gracz też tego nie widzi (panel miasta pokazuje wyłącznie własne).
// Progi ekonomiczne (np. wymagany dochód do ofensywy) są więc progami
// na WŁASNĄ kondycję AI, nigdy porównaniem do (niewidocznego) stanu
// przeciwnika.
// ============================================================

'use strict';

// ------------------------------------------------------------
// AI_CONFIG — WSZYSTKIE parametry zachowania w jednym miejscu. Przyszłe
// poziomy trudności = inny zestaw tych wartości (np. niższe progi
// ofensywy i mniejszy mistakeChance dla "trudnego"), bez zmiany logiki.
// ------------------------------------------------------------
const AI_CONFIG = {
  decisionIntervalSeconds: 5, // operacyjne decyzje co kilka sekund, nie co klatkę — tempo jak człowiek, nie bot
  reactionDelaySeconds: 4, // opóźnienie zauważenia zagrożenia (oblężenie własnego miasta)
  commitmentTime: 45, // s trzymania się raz obranego celu natarcia/starcia, zanim AI rozważy inny
  mistakeChance: 0.10, // rzadki, okazjonalny błąd (atak bez pełnej przewagi / słabszy garnizon) — ostrożny dowódca myli się rzadko
  retreatGroupHpFraction: 0.45, // śr. HP% grupy poniżej którego CAŁA grupa wraca do miasta się leczyć
  retreatCombatHpRatio: 0.75, // wycofuje się z aktywnego starcia, jeśli NIE jest wyraźnie górą — "nie podejmuje walki, której nie jest pewne wygrać"
  maxArmyCommitmentFraction: 0.70, // nigdy nie stawia więcej niż tyle % całej swojej siły na jedną akcję — reszta zostaje w odwodzie/garnizonie
  garrisonMinUnits: 2, // pełny garnizon miasta pod bezpośrednim zagrożeniem
  garrisonPerCityMinUnits: 1, // minimalna obecność w KAŻDYM własnym mieście (nie tylko najbardziej zagrożonym)
  rangedBehindOffsetPx: 40, // o ile jednostki dystansowe cofają się za linię melee przy formowaniu pozycji
  flankAttemptChance: 0.3, // szansa, że kawaleria w natarciu spróbuje z boku/tyłu zamiast wprost
  convoyRaidChance: 0.15, // szansa próby rajdu na widoczny konwój wroga, na turę decyzyjną (nie w fazie otwarcia)
  clusterRadius: 100, // px — promień grupowania widocznych jednostek wroga w "armie" (klastry)
  midEngageSuperiorityThreshold: 1.3, // wymagana przewaga siły do starcia w polu (faza środkowa) — cel to ARMIA wroga, nie miasto
  offenseSuperiorityThreshold: 1.6, // wymagana przewaga siły do ataku na miasto (faza ofensywna) — wyżej niż zwykłe starcie, bo stawką jest miasto
  frontCohesionBlockingPowerFraction: 0.5, // jeśli siła wroga "za plecami" (między domem a celem) >= tyle razy CAŁA siła AI, wstrzymaj głębokie natarcie
  openingArmyPowerThreshold: 350, // suma unitPower własnej żywej armii kończąca fazę otwarcia
  midToOffensivePowerRatio: 1.7, // startowy próg przewagi (myPower/enemyPower) do wejścia w fazę ofensywną
  midToOffensivePowerRatioFloor: 1.15, // dolny limit progu po złagodzeniu — zabezpieczenie przed patem, mecz ma się kończyć
  midToOffensiveMinOwnIncome: 1.0, // minimalny WŁASNY dochód (zł/s, GameAPI.goldRate) wymagany do rozważenia ofensywy
  bigVictoryEnemyPowerDrop: 120, // nagły spadek widocznej siły wroga między turami uznawany za "dużą bitwę"
  bigVictoryWindowSeconds: 90, // jak długo "świeże zwycięstwo" liczy się jako samodzielny powód wejścia w ofensywę
  offensiveRetreatPowerFraction: 0.6, // spadek własnej siły poniżej tego ułamka stanu z początku ofensywy -> powrót do fazy środkowej
  regroupDurationSeconds: 25, // po zwycięskim starciu grupa leczy się/przegrupowuje, zanim ruszy dalej — nigdy natychmiast dalej
  stalemateSofteningStartSeconds: 360, // 6 minut bez wejścia w ofensywę -> zacznij łagodzić próg przewagi
  stalemateSofteningRatePerSecond: 0.001, // tempo łagodzenia progu ponad powyższy czas
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
// Poziom trudności — 'normal' (domyślny: dokładnie dotychczasowe
// zachowanie, zero zmian) i 'hard' (sprawniejsze dowodzenie: formacje,
// ochrona artylerii, koncentracja sił przed starciem, kontrowanie
// widocznego składu wroga, większy odwód — BEZ zmiany agresji, progów
// faz, commitmentTime, i BEZ żadnych bonusów/oszustw, patrz AI_HARD_CONFIG
// niżej). Przełączane w dowolnym momencie meczu checkboxem w bocznym
// panelu (patrz window.setAIDifficulty, wołane z index.html).
// ------------------------------------------------------------
let aiDifficulty = 'normal';
function isHard() { return aiDifficulty === 'hard'; }
if (typeof window !== 'undefined') {
  window.setAIDifficulty = (level) => { aiDifficulty = level === 'hard' ? 'hard' : 'normal'; };
}

// Wartości używane WYŁĄCZNIE w trybie 'hard' — albo nowe parametry nowych
// zachowań (bez odpowiednika w AI_CONFIG), albo umiarkowana korekta
// istniejącej wartości (flankAttemptChance, maxArmyCommitmentFraction).
// Reszta reguł gry zostaje identyczna: ten sam GameAPI, ta sama uczciwa
// wiedza (patrz komentarz na górze pliku), te same fazy/progi/
// commitmentTime z AI_CONFIG — hard mode zmienia TYLKO jak sprawnie AI
// realizuje te same decyzje, nie CO lub JAK CZĘSTO atakuje.
const AI_HARD_CONFIG = {
  flankAttemptChance: 0.6, // AI_CONFIG ma 0.3 — flankowanie ma być domyślną taktyką, nie rzadkim wyjątkiem
  maxArmyCommitmentFraction: 0.60, // AI_CONFIG ma 0.70 — większy stały odwód przy miastach
  formationSettleRadiusPx: 15, // jednostka uznana za "już na miejscu" — nie przerywać jej rozkazem od nowa (pozwala dokończyć setupTime)
  cavalryFlankOffsetPx: 60, // odległość skrzydeł kawalerii od reszty formacji
  protectRangedThreatRadiusPx: 90, // wróg bliżej niż to od dystansowej jednostki AI -> cofnij ją za piechotę
  groupConsolidationRadius: 150, // px — rozrzut kandydatów do zaangażowania powyżej tego progu -> najpierw się zbierają, zanim ruszą razem
  counterCompositionThreshold: 0.4, // udział danego typu w WIDOCZNEJ armii wroga uznawany za wyraźny wzorzec do skontrowania
  counterCompositionShift: 0.15, // o ile korygowany jest docelowy skład armii w odpowiedzi na wzorzec wroga
  economySplitByPhase: { OPENING: 0.55, MIDGAME: 0.75, OFFENSIVE: 0.85 }, // ułamek decyzji wydatkowych na produkcję (reszta na ulepszenia), zależny od fazy — w otwarciu priorytet ma rozwój miast
};

// Jedno miejsce odczytu parametru, które samo wybiera właściwe źródło —
// wywołujący nie musi pamiętać, który klucz ma odpowiednik w hard mode.
function cfgVal(key) {
  return isHard() && key in AI_HARD_CONFIG ? AI_HARD_CONFIG[key] : AI_CONFIG[key];
}

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
    // Faza operacyjna — patrz updatePhase. Przejścia oparte o sytuację,
    // nie zegar (poza łagodzeniem progu przy bardzo długim patcie).
    phase: 'OPENING',
    phaseSince: 0,
    gameStartTime: null,
    // Cel natarcia trzymany przez commitmentTime — {point:{x,y}, kind:'ARMY'|'CITY'}
    advanceTarget: null,
    advanceCommittedAt: null,
    // Po dużym zwycięstwie: nie rusza dalej do tego czasu (wraca się leczyć/przegrupować)
    regroupUntil: 0,
    // Wykrywanie "dużej bitwy" — porównanie widocznej siły wroga między turami
    lastEnemyPower: null,
    lastMyPower: null,
    recentVictoryUntil: 0,
    // Do wykrycia "utrata miasta"/"załamanie armii" po wejściu w ofensywę
    myCityCountAtOffenseStart: null,
    offensivePowerAtStart: null,
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

function countUnitsNear(api, state, point, radius) {
  return myAliveUnits(api, state).filter((u) => dist(u, point) <= radius).length;
}

// Odśwież przynależność grup: usuń martwe jednostki, zbierz jednostki
// nienależące do żadnej grupy do REZERWY (nowo wyprodukowane ORAZ te,
// których grupa właśnie się "rozwiązała" po odwrocie/regroupie).
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

// Pod presją militarną — którekolwiek własne miasto akurat oblężone,
// LUB łączna siła AI wyraźnie niższa niż widoczna siła wroga (uczciwe:
// oba porównania patrzą WYŁĄCZNIE na to, co jest widoczne na mapie).
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

function isWaterAt(api, point) {
  const tile = api.worldToTile(point.x, point.y);
  const terrain = api.terrainAt(tile.col, tile.row);
  return !!terrain && terrain.name === 'WATER';
}

// [TRYB HARD] Jak nearbyHillsOrSame, ale dodatkowo unika stawiania
// dystansowych w lesie/wodzie, gdy w pobliżu jest rozsądna alternatywa —
// kolejność preferencji: wzgórza (bonus zasięgu) > zwykłe pole > (brak
// niczego lepszego w promieniu) zostań, gdzie wypadło.
function betterGroundForRanged(api, point) {
  if (isHillsAt(api, point)) return point;
  if (!isForestAt(api, point) && !isWaterAt(api, point)) return point;
  for (let radius = 1; radius <= 3; radius++) {
    for (let dc = -radius; dc <= radius; dc++) {
      for (let dr = -radius; dr <= radius; dr++) {
        const tile = api.worldToTile(point.x, point.y);
        const candidate = api.tileToWorld(tile.col + dc, tile.row + dr);
        if (isHillsAt(api, candidate)) return candidate;
        if (!isForestAt(api, candidate) && !isWaterAt(api, candidate)) return candidate;
      }
    }
  }
  return point;
}

// Odcinek a->b: czy punkt p leży bliżej niego niż maxDist? Używane przez
// frontCohesionOk do wykrycia wrogiej siły "na drodze" między domem a celem.
function isNearSegment(p, a, b, maxDist) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + abx * t, projY = a.y + aby * t;
  return Math.hypot(p.x - projX, p.y - projY) <= maxDist;
}

// Zachłanne grupowanie widocznych żywych jednostek wroga w "armie" —
// wystarczające przybliżenie "gdzie stoi wojsko przeciwnika" bez pełnej
// analizy grafowej. To jest CEL natarcia w fazie środkowej (armia wroga),
// nie miasto.
function clusterEnemyUnits(api, state) {
  const units = enemyAliveUnits(api, state);
  const clusters = [];
  for (const u of units) {
    let found = null;
    for (const c of clusters) {
      if (dist(u, c.centroid) <= AI_CONFIG.clusterRadius) { found = c; break; }
    }
    if (found) {
      found.units.push(u);
      found.centroid = {
        x: found.units.reduce((s, x) => s + x.x, 0) / found.units.length,
        y: found.units.reduce((s, x) => s + x.y, 0) / found.units.length,
      };
    } else {
      clusters.push({ units: [u], centroid: { x: u.x, y: u.y } });
    }
  }
  return clusters;
}

// "Spójna linia": AI nie wysyła grupy w głąb terytorium gracza, jeśli
// niepokonana armia wroga stoi między jej domem a celem i mogłaby
// odciąć drogę powrotu. Sprawdza WSZYSTKIE widoczne klastry wroga —
// jeśli którykolwiek leży na drodze dom->cel i jest wystarczająco silny
// względem CAŁEJ siły AI, wstrzymuje głębokie natarcie.
function frontCohesionOk(api, state, targetPoint) {
  const home = nearestCity(targetPoint, myCities(api, state), api);
  if (!home) return true;
  const homeCenter = api.cityCenter(home);
  const myTotalPower = sumPower(api, myAliveUnits(api, state)) || 1;
  for (const cluster of clusterEnemyUnits(api, state)) {
    if (!isNearSegment(cluster.centroid, homeCenter, targetPoint, AI_CONFIG.clusterRadius * 1.5)) continue;
    const clusterPower = sumPower(api, cluster.units);
    if (clusterPower >= myTotalPower * AI_CONFIG.frontCohesionBlockingPowerFraction) return false;
  }
  return true;
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
  if (isHard()) { issueFormationOrderHard(api, unitSet, targetPoint, homeRefPoint); return; }
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

// [TRYB HARD] Formacja z rolami: piechota na linii (jak dawny
// issueGroupOrder), dystansowi za nią (przez betterGroundForRanged —
// wzgórza > pole, omija las/wodę), kawaleria na obu skrzydłach linii
// (cavalryFlankOffsetPx). Rozkaz ruchu wydawany WYŁĄCZNIE jednostkom,
// które jeszcze nie dotarły na wyliczone miejsce ORAZ nie są akurat
// zaangażowane w walkę (engagedTargetId) — nigdy nie przerywa trwającego
// starcia ani nie przestawia jednostki, która już stoi i się rozstawia.
function issueFormationOrderHard(api, unitSet, targetPoint, homeRefPoint) {
  const list = [...unitSet];
  if (list.length === 0) return;
  const cavalry = list.filter((u) => u.type === 'CAVALRY');
  const ranged = list.filter((u) => api.UNIT_TYPES[u.type].ranged);
  const melee = list.filter((u) => u.type !== 'CAVALRY' && !api.UNIT_TYPES[u.type].ranged);

  const dx = targetPoint.x - homeRefPoint.x, dy = targetPoint.y - homeRefPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  const dirX = dx / len, dirY = dy / len;
  const perpX = -dirY, perpY = dirX;

  const moveIfNeeded = (units, point) => {
    const need = units.filter((u) => u.engagedTargetId == null
      && (u.path.length > 0 || dist(u, point) > AI_HARD_CONFIG.formationSettleRadiusPx));
    if (need.length > 0) api.issueMoveOrder(need, point);
  };

  moveIfNeeded(melee, targetPoint);

  if (ranged.length > 0) {
    let rangedTarget = {
      x: targetPoint.x - dirX * AI_CONFIG.rangedBehindOffsetPx,
      y: targetPoint.y - dirY * AI_CONFIG.rangedBehindOffsetPx,
    };
    rangedTarget = betterGroundForRanged(api, rangedTarget);
    moveIfNeeded(ranged, rangedTarget);
  }

  if (cavalry.length > 0) {
    const half = Math.ceil(cavalry.length / 2);
    const leftFlank = {
      x: targetPoint.x - perpX * AI_HARD_CONFIG.cavalryFlankOffsetPx,
      y: targetPoint.y - perpY * AI_HARD_CONFIG.cavalryFlankOffsetPx,
    };
    const rightFlank = {
      x: targetPoint.x + perpX * AI_HARD_CONFIG.cavalryFlankOffsetPx,
      y: targetPoint.y + perpY * AI_HARD_CONFIG.cavalryFlankOffsetPx,
    };
    moveIfNeeded(cavalry.slice(0, half), leftFlank);
    moveIfNeeded(cavalry.slice(half), rightFlank);
  }
}

// [TRYB HARD] Chroni artylerię/łuczników przed odsłonięciem: gdy jakikolwiek
// wróg zbliży się na protectRangedThreatRadiusPx do dystansowej jednostki
// AI, cofa WSZYSTKICH zagrożonych dystansowych tej grupy za centroid jej
// piechoty (albo do najbliższego miasta, gdy grupa nie ma piechoty),
// przez betterGroundForRanged (omija las/wodę przy okazji odwrotu).
function decideProtectRanged(api, state) {
  const enemies = enemyAliveUnits(api, state);
  if (enemies.length === 0) return;
  for (const key of ['defense', 'offense']) {
    const list = [...state.groups[key]];
    const rangedUnits = list.filter((u) => api.UNIT_TYPES[u.type].ranged);
    if (rangedUnits.length === 0) continue;
    const threatened = rangedUnits.filter((u) => enemies.some((e) => dist(u, e) <= AI_HARD_CONFIG.protectRangedThreatRadiusPx));
    if (threatened.length === 0) continue;

    const meleeUnits = list.filter((u) => !api.UNIT_TYPES[u.type].ranged);
    let shelter;
    if (meleeUnits.length > 0) {
      shelter = { x: meleeUnits.reduce((s, u) => s + u.x, 0) / meleeUnits.length, y: meleeUnits.reduce((s, u) => s + u.y, 0) / meleeUnits.length };
    } else {
      const home = nearestCity(threatened[0], myCities(api, state), api);
      if (!home) continue;
      shelter = api.cityCenter(home);
    }
    const home = nearestCity(shelter, myCities(api, state), api);
    const homeCenter = home ? api.cityCenter(home) : shelter;
    const hdx = homeCenter.x - shelter.x, hdy = homeCenter.y - shelter.y;
    const hlen = Math.hypot(hdx, hdy) || 1;
    let retreatPoint = {
      x: shelter.x + (hdx / hlen) * AI_CONFIG.rangedBehindOffsetPx,
      y: shelter.y + (hdy / hlen) * AI_CONFIG.rangedBehindOffsetPx,
    };
    retreatPoint = betterGroundForRanged(api, retreatPoint);
    api.issueMoveOrder(threatened, retreatPoint);
  }
}

// ------------------------------------------------------------
// Obrona — garnizon minimalny w KAŻDYM własnym mieście (nie tylko
// najbardziej zagrożonym), z priorytetem dla aktualnie oblężonego
// (pełny garrisonMinUnits). Reaguje na oblężenie z opóźnieniem
// (reactionDelaySeconds od PIERWSZEGO zaobserwowania, nie natychmiast).
// Aktywna we WSZYSTKICH fazach — obrona własnych miast nigdy nie jest
// opcjonalna, tylko natarcie jest.
// ------------------------------------------------------------
function decideDefense(api, state, now) {
  const mine = myCities(api, state);
  if (mine.length === 0) return;

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

  let threatenedCity = null;
  for (const c of mine) {
    const rec = state.siegeNoticedAt.get(c.id);
    if (rec && (now - rec.firstSeenAt) / 1000 >= AI_CONFIG.reactionDelaySeconds) {
      threatenedCity = c;
      break;
    }
  }

  // Okazjonalny błąd: czasem AI zostawia miasto słabiej bronione (pomija
  // odświeżenie garnizonu w tej turze), ale TYLKO gdy nic akurat nie
  // jest realnie zagrożone — nigdy w obliczu prawdziwego oblężenia.
  if (!threatenedCity && Math.random() < AI_CONFIG.mistakeChance) return;

  // Każda jednostka garnizonu nosi znacznik __garrisonCityId (na samym
  // obiekcie jednostki — przetrwa między klatkami tak długo, jak żyje) i
  // ZOSTAJE w state.groups.defense na stałe, więc refreshGroups nigdy jej
  // nie zmiecie z powrotem do rezerwy, zanim fizycznie dotrze na miejsce
  // (wcześniejszy błąd: jednostki wysyłane bez śledzenia przydziału
  // wracały do rezerwy po jednej turze i były wysyłane od nowa, w kółko,
  // nigdy nie tworząc stabilnego garnizonu).
  for (const c of mine) {
    const center = api.cityCenter(c);
    const requiredMin = c === threatenedCity ? AI_CONFIG.garrisonMinUnits : AI_CONFIG.garrisonPerCityMinUnits;
    const assignedToThisCity = [...state.groups.defense].filter((u) => u.__garrisonCityId === c.id).length;
    if (assignedToThisCity >= requiredMin) continue;
    let need = requiredMin - assignedToThisCity;
    while (need > 0 && state.groups.reserve.size > 0) {
      const guard = [...state.groups.reserve][0];
      state.groups.reserve.delete(guard);
      guard.__garrisonCityId = c.id;
      state.groups.defense.add(guard);
      api.issueMoveOrder([guard], center);
      need--;
    }
  }
}

// ------------------------------------------------------------
// Natarcie — WSPÓLNA logika dla fazy środkowej (cel to WYŁĄCZNIE
// klastry widocznej armii wroga — teren premiuje/karze wybór) i
// ofensywnej (dodatkowo miasta wroga, próg wyższy niż zwykłe starcie).
// Miasto to nagroda za wygraną bitwę, nigdy cel sam w sobie — dlatego
// ocena miast dzieje się w TEJ SAMEJ puli kandydatów co armie, z wyższym
// wymaganym progiem, nie jako osobny, nadrzędny cel.
// ------------------------------------------------------------
function decideAdvance(api, state, now, allowCityTargets) {
  if (now < state.regroupUntil) return; // przegrupowanie po zwycięstwie — nie rusza dalej

  const homeFor = (point) => {
    const c = nearestCity(point, myCities(api, state), api) || myCities(api, state)[0];
    return c ? api.cityCenter(c) : point;
  };

  // Trzymanie się raz obranego celu (commitmentTime) — ponawia rozkaz do
  // ZAPAMIĘTANEGO punktu, dopóki czas się nie skończy. "Drastyczna zmiana
  // sytuacji" (grupa rozbita/przegrywa) obsługiwana osobno przez
  // decideRetreat/decideHealingRotation, które rozwiązują grupę wcześniej.
  if (state.advanceTarget && state.groups.offense.size > 0 && state.advanceCommittedAt != null) {
    const committedFor = (now - state.advanceCommittedAt) / 1000;
    if (committedFor < AI_CONFIG.commitmentTime) {
      issueGroupOrder(api, state.groups.offense, state.advanceTarget.point, homeFor(state.advanceTarget.point));
      return;
    }
  }
  state.advanceTarget = null;
  state.advanceCommittedAt = null;

  const totalPower = sumPower(api, myAliveUnits(api, state));
  const maxCommitPower = totalPower * cfgVal('maxArmyCommitmentFraction');
  const candidates = [...state.groups.reserve, ...state.groups.offense];
  // [TRYB HARD] zdrowsze jednostki jako pierwsze — ranne, wciąż leczące
  // się w rezerwie, zostają z tyłu dłużej; to realizuje "zastępuje
  // ranne świeżymi z rezerwy" bez osobnego mechanizmu śledzenia rotacji.
  if (isHard()) {
    candidates.sort((a, b) => (b.hp / api.UNIT_TYPES[b.type].maxHp) - (a.hp / api.UNIT_TYPES[a.type].maxHp));
  }
  let committedPower = 0;
  const engageUnits = [];
  for (const u of candidates) {
    const p = unitPower(api, u);
    if (committedPower + p > maxCommitPower && engageUnits.length > 0) break;
    engageUnits.push(u);
    committedPower += p;
  }
  if (engageUnits.length === 0) return;

  // [TRYB HARD] Koncentracja sił przed starciem: jeśli wybrani kandydaci
  // są rozrzuceni dalej niż groupConsolidationRadius (część świeża z
  // rezerwy przy mieście, część już na przedpolu), każ im się najpierw
  // zejść do wspólnego punktu (centroid — obie części idą sobie naprzeciw,
  // szybciej niż zbiórka w jednym punkcie) i dopiero w KOLEJNEJ turze
  // decyzyjnej oceniaj cele. Bez tego oddziały dochodziłyby do walki
  // pojedynczo, w miarę jak każdy dociera własnym tempem.
  if (isHard() && engageUnits.length > 1) {
    const centroid = {
      x: engageUnits.reduce((s, u) => s + u.x, 0) / engageUnits.length,
      y: engageUnits.reduce((s, u) => s + u.y, 0) / engageUnits.length,
    };
    const maxSpread = Math.max(...engageUnits.map((u) => dist(u, centroid)));
    if (maxSpread > AI_HARD_CONFIG.groupConsolidationRadius) {
      issueGroupOrder(api, new Set(engageUnits), centroid, centroid);
      return;
    }
  }

  let bestTarget = null, bestScore = -Infinity, bestKind = null, bestRatio = 0;
  for (const cluster of clusterEnemyUnits(api, state)) {
    const clusterPower = sumPower(api, cluster.units) || 1;
    const ratio = committedPower / clusterPower;
    let terrainScore = 0;
    if (isHillsAt(api, cluster.centroid)) terrainScore += 0.3;
    if (isForestAt(api, cluster.centroid)) terrainScore -= 0.3;
    const score = ratio + terrainScore;
    if (score > bestScore) { bestScore = score; bestTarget = cluster.centroid; bestKind = 'ARMY'; bestRatio = ratio; }
  }
  if (allowCityTargets) {
    for (const city of enemyCities(api, state)) {
      const center = api.cityCenter(city);
      const defenders = enemyAliveUnits(api, state).filter((u) => dist(u, center) <= api.CITY_ZONE_RADIUS + 60);
      const defenderPower = sumPower(api, defenders) || 1;
      const ratio = committedPower / defenderPower;
      if (ratio > bestScore) { bestScore = ratio; bestTarget = center; bestKind = 'CITY'; bestRatio = ratio; }
    }
  }
  if (!bestTarget) {
    // Brak widocznego celu w fazie środkowej: wysuń się na rozsądną
    // pozycję (przełęcz) zamiast stać bezczynnie — "wysuwa siły na
    // front", ale bez atakowania czegokolwiek.
    if (!allowCityTargets) {
      const enemyRef = enemyCities(api, state)[0];
      const homeCity = myCities(api, state)[0];
      if (enemyRef && homeCity) {
        const staging = findChokePoint(api, api.cityCenter(homeCity), api.cityCenter(enemyRef));
        issueGroupOrder(api, new Set(engageUnits), staging, api.cityCenter(homeCity));
      }
    }
    return;
  }

  const threshold = bestKind === 'CITY' ? AI_CONFIG.offenseSuperiorityThreshold : AI_CONFIG.midEngageSuperiorityThreshold;
  const meets = bestRatio >= threshold;
  const mistake = Math.random() < AI_CONFIG.mistakeChance;
  if (!meets && !mistake) return; // ostrożny dowódca — czeka, nie atakuje bez przewagi

  if (!frontCohesionOk(api, state, bestTarget)) return; // wróg mógłby odciąć drogę powrotu — poczekaj, nie idź w głąb

  for (const u of engageUnits) {
    state.groups.reserve.delete(u);
    state.groups.offense.add(u);
  }
  state.advanceTarget = { point: bestTarget, kind: bestKind };
  state.advanceCommittedAt = now;

  const home = homeFor(bestTarget);
  const cavalry = engageUnits.filter((u) => u.type === 'CAVALRY');
  const rest = engageUnits.filter((u) => u.type !== 'CAVALRY');

  if (cavalry.length > 0 && Math.random() < cfgVal('flankAttemptChance')) {
    const dx = bestTarget.x - home.x, dy = bestTarget.y - home.y;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len, perpY = dx / len;
    const side = Math.random() < 0.5 ? 1 : -1;
    const flankTarget = { x: bestTarget.x + perpX * side * 80, y: bestTarget.y + perpY * side * 80 };
    api.issueMoveOrder(cavalry, flankTarget);
    issueGroupOrder(api, new Set(rest), bestTarget, home);
  } else {
    issueGroupOrder(api, new Set(engageUnits), bestTarget, home);
  }
}

// ------------------------------------------------------------
// Odwrót z przegrywanego (albo niepewnego) starcia — ostrożny dowódca
// wycofuje się, jeśli nie jest WYRAŹNIE górą, zamiast walczyć do końca.
// "Rozwiązanie" grupy = wyczyszczenie Setu — ocalali wrócą do REZERWY.
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
      set.clear();
      if (key === 'offense') { state.advanceTarget = null; state.advanceCommittedAt = null; }
    }
  }
}

// Rotacja uszkodzonych oddziałów: CAŁA grupa (nie pojedyncze jednostki)
// poniżej progu średniego HP wraca do miasta się leczyć (patrz
// canRegenerateHere w index.html — leczenie działa TYLKO w strefie
// miasta). To decyzja na poziomie grupy — nie mikrozarządzanie pojedynczą
// raną jednostką w środku starcia.
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
    if (key === 'offense') { state.advanceTarget = null; state.advanceCommittedAt = null; }
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
// zróżnicowana armia. Aktywna we WSZYSTKICH fazach.
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

// [TRYB HARD] Koryguje bazowy docelowy skład armii (AI_CONFIG.targetArmyComposition)
// w odpowiedzi na WIDOCZNY skład wroga (pozycje/typy jednostek są zawsze
// widoczne na mapie dla obu stron — to uczciwa wiedza, nie podgląd
// niewidocznych informacji). Reaguje tylko na wyraźny wzorzec
// (counterCompositionThreshold), umiarkowaną korektą (counterCompositionShift),
// nigdy nie zamienia całej armii w jeden typ.
function computeTargetComposition(api, state) {
  if (!isHard()) return AI_CONFIG.targetArmyComposition;
  const enemy = enemyAliveUnits(api, state);
  const total = enemy.length || 1;
  const cavalryShare = enemy.filter((u) => u.type === 'CAVALRY').length / total;
  const infantryShare = enemy.filter((u) => u.type === 'LIGHT_INFANTRY' || u.type === 'HEAVY_INFANTRY').length / total;
  const comp = { ...AI_CONFIG.targetArmyComposition };
  if (cavalryShare >= AI_HARD_CONFIG.counterCompositionThreshold) {
    comp.HEAVY_INFANTRY = (comp.HEAVY_INFANTRY || 0) + AI_HARD_CONFIG.counterCompositionShift;
    comp.CAVALRY = Math.max(0, (comp.CAVALRY || 0) - AI_HARD_CONFIG.counterCompositionShift);
  }
  if (infantryShare >= AI_HARD_CONFIG.counterCompositionThreshold) {
    comp.ARCHER = (comp.ARCHER || 0) + AI_HARD_CONFIG.counterCompositionShift / 2;
    comp.CANNON = (comp.CANNON || 0) + AI_HARD_CONFIG.counterCompositionShift / 2;
    comp.LIGHT_INFANTRY = Math.max(0, (comp.LIGHT_INFANTRY || 0) - AI_HARD_CONFIG.counterCompositionShift);
  }
  return comp;
}

function pickProductionType(api, state) {
  const alive = myAliveUnits(api, state);
  const total = alive.length || 1;
  const targetComposition = computeTargetComposition(api, state);
  let bestType = null, bestGap = -Infinity;
  for (const [type, targetRatio] of Object.entries(targetComposition)) {
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
  // [TRYB HARD] Podział zależny od FAZY, nie tylko presji — w otwarciu
  // priorytet ma rozwój miast, w środkowej/ofensywnej coraz mocniej
  // produkcja. Presja militarna nadal ma pierwszeństwo nad fazą (pod
  // atakiem trzeba jednostek NATYCHMIAST, niezależnie od tego, co
  // sugerowałaby faza).
  let productionShare;
  if (underPressure) {
    productionShare = AI_CONFIG.economySplitUnderPressure;
  } else if (isHard()) {
    productionShare = AI_HARD_CONFIG.economySplitByPhase[state.phase] ?? AI_CONFIG.economySplitBase;
  } else {
    productionShare = AI_CONFIG.economySplitBase;
  }
  const spendOnProduction = Math.random() < productionShare;

  if (spendOnProduction) {
    const type = pickProductionType(api, state);
    if (type) {
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
// Maszyna stanów faz — przejścia oparte o SYTUACJĘ, nie zegar (poza
// łagodzeniem progu przy bardzo długim patcie, żeby mecz się kończył).
// ------------------------------------------------------------
function updatePhase(api, state, now) {
  const myPower = sumPower(api, myAliveUnits(api, state));
  const enemyPower = sumPower(api, enemyAliveUnits(api, state));

  // Wykrycie "świeżo wygranej dużej bitwy": nagły spadek widocznej siły
  // wroga bez porównywalnego spadku siły własnej między turami decyzyjnymi.
  // Po wygranej bitwie grupa natarcia NIE rusza dalej — wraca się leczyć
  // i przegrupować (regroupUntil), zgodnie z zasadą nadrzędną.
  if (state.lastEnemyPower != null) {
    const enemyDrop = state.lastEnemyPower - enemyPower;
    const myDrop = state.lastMyPower - myPower;
    if (enemyDrop >= AI_CONFIG.bigVictoryEnemyPowerDrop && myDrop < enemyDrop * 0.5) {
      state.recentVictoryUntil = now + AI_CONFIG.bigVictoryWindowSeconds * 1000;
      if (state.groups.offense.size > 0) {
        const list = [...state.groups.offense];
        const centroid = { x: list.reduce((s, u) => s + u.x, 0) / list.length, y: list.reduce((s, u) => s + u.y, 0) / list.length };
        const home = nearestCity(centroid, myCities(api, state), api);
        if (home) api.issueMoveOrder(list, api.cityCenter(home));
        state.groups.offense.clear();
        state.advanceTarget = null;
        state.advanceCommittedAt = null;
      }
      state.regroupUntil = now + AI_CONFIG.regroupDurationSeconds * 1000;
    }
  }
  state.lastEnemyPower = enemyPower;
  state.lastMyPower = myPower;

  if (state.gameStartTime == null) state.gameStartTime = now;
  const stalledSeconds = Math.max(0, (now - state.gameStartTime) / 1000 - AI_CONFIG.stalemateSofteningStartSeconds);
  const effectiveOffenseRatio = Math.max(
    AI_CONFIG.midToOffensivePowerRatioFloor,
    AI_CONFIG.midToOffensivePowerRatio - stalledSeconds * AI_CONFIG.stalemateSofteningRatePerSecond,
  );

  if (state.phase === 'OPENING') {
    // Tolerancja jednego miasta wciąż "w drodze" (garnizon wysłany, ale
    // jeszcze nie dotarł, np. wolna jednostka przecinająca wodę) — bez
    // tego jeden pechowy przydział mógłby blokować przejście w
    // nieskończoność, mimo że reszta armii jest gotowa.
    const mineCities = myCities(api, state);
    const securedCount = mineCities.filter(
      (c) => countUnitsNear(api, state, api.cityCenter(c), api.CITY_ZONE_RADIUS) >= AI_CONFIG.garrisonPerCityMinUnits,
    ).length;
    const citiesSecured = securedCount >= mineCities.length - 1;
    if (myPower >= AI_CONFIG.openingArmyPowerThreshold && citiesSecured) {
      state.phase = 'MIDGAME';
      state.phaseSince = now;
    }
    return;
  }

  if (state.phase === 'MIDGAME') {
    const incomeOk = (api.goldRate[state.owner] || 0) >= AI_CONFIG.midToOffensiveMinOwnIncome;
    // enemyPower===0 (żaden wróg widoczny na mapie) samo w sobie spełnia
    // warunek przewagi — nie ma czego się bać, próg przewagi jest wtedy bez znaczenia.
    const powerOk = myPower > 0 && (enemyPower === 0 || myPower / enemyPower >= effectiveOffenseRatio);
    const victoryOk = now < state.recentVictoryUntil;
    if ((powerOk && incomeOk) || victoryOk) {
      state.phase = 'OFFENSIVE';
      state.phaseSince = now;
      state.offensivePowerAtStart = myPower;
      state.myCityCountAtOffenseStart = myCities(api, state).length;
      state.advanceTarget = null;
      state.advanceCommittedAt = null;
    }
    return;
  }

  if (state.phase === 'OFFENSIVE') {
    const lostCity = state.myCityCountAtOffenseStart != null && myCities(api, state).length < state.myCityCountAtOffenseStart;
    const armyCrashed = state.offensivePowerAtStart && myPower < state.offensivePowerAtStart * AI_CONFIG.offensiveRetreatPowerFraction;
    if (lostCity || armyCrashed) {
      state.phase = 'MIDGAME';
      state.phaseSince = now;
      state.advanceTarget = null;
      state.advanceCommittedAt = null;
    }
  }
}

// ------------------------------------------------------------
// Pętla decyzyjna — wołana z gameLoop (index.html) przez GameAPI.onTick,
// raz na klatkę, ale WEWNĘTRZNIE działa co decisionIntervalSeconds.
// ------------------------------------------------------------
function runDecisionCycle(api, state, now) {
  refreshGroups(api, state);
  updatePhase(api, state, now);
  decideHealingRotation(api, state);
  decideRetreat(api, state);
  decideDefense(api, state, now);
  if (state.phase === 'MIDGAME') decideAdvance(api, state, now, false);
  else if (state.phase === 'OFFENSIVE') decideAdvance(api, state, now, true);
  if (isHard()) decideProtectRanged(api, state); // [TRYB HARD] korekta PO głównych rozkazach tej tury — reaguje na zagrożenie w tej samej turze, nie dopiero w następnej
  if (state.phase !== 'OPENING') decideConvoyRaid(api, state);
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
