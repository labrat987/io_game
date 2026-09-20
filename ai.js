// ============================================================
// AI PRZECIWNIKA — moduł ES, importowany przez index.html
// (<script type="module" src="ai.js">). Komunikuje się z grą WYŁĄCZNIE
// przez window.GameAPI — te same funkcje-rozkazy, których używa gracz
// (issueMoveOrder/issueRouteOrder/issueFrontOrder/queueProduction/
// upgradeCity/createTradeRoute/setTargetPriority), nigdy bezpośrednio
// nie mutuje stanu silnika poza tym mostkiem.
//
// ZASADA NADRZĘDNA: AI to AKTYWNY DOWÓDCA planowy, nie bierny obserwator
// i nie bot maksymalizujący skuteczność za wszelką cenę. Domyślnym stanem
// jest WYWIERANIE PRESJI — kontrola terenu, blokowanie dojść do własnych
// miast, sondowanie obrony przeciwnika, nękanie jego szlaków handlowych —
// nie stanie bezczynnie w oczekiwaniu na miażdżącą przewagę. AI szuka
// starć, w których jest choćby lekko korzystniejsze, i wycofuje się
// WYŁĄCZNIE z WYRAŹNIE przegranych starć, nie przy pierwszych stratach.
// Wciąż myśli grupami (nie mikrozarządza), decyduje co kilka sekund
// (tempo ZALEŻNE od poziomu — patrz AI_LEVELS), trzyma się raz obranego
// celu przez pewien czas (commitmentTime, też zależne od poziomu), nigdy
// nie stawia całej armii na jedną kartę i nigdy nie ryzykuje jej dla
// pojedynczego miasta (łącznie z własnym).
//
// CZTERY POZIOMY TRUDNOŚCI, JEDNA LOGIKA: cała logika decyzyjna poniżej
// jest identyczna na każdym poziomie. Poziomy (AI_LEVELS, EASY/MEDIUM/
// HARD/EXPERT) różnią się WYŁĄCZNIE parametrami czytanymi przez cfgVal()
// — szybkością reakcji I TEMPEM decyzji (decisionIntervalSeconds/
// commitmentTime — dawniej błędnie wspólne dla wszystkich poziomów),
// dokładnością wykonania (tacticalSkill: formacje, wykorzystanie terenu,
// konsolidacja sił, ochrona artylerii, dobór składu — wszystko gated
// jednym rzutem "czy dowódca wykonał to dobrze"), szansą na aktywny błąd
// (mistakeChance), progami podjęcia walki i intensywnością presji (sondy,
// rajdy, stała obecność do przodu). Żaden poziom nie dostaje bonusów do
// złota/produkcji/prędkości/obrażeń ani wiedzy o niewidocznych jednostkach
// — różnica to WYŁĄCZNIE jakość i szybkość tych samych decyzji.
//
// "AI widzi tylko to, co widziałby gracz" — silnik nie ma fog of war
// (potwierdzone), więc to WYŁĄCZNIE dyscyplina kodu poniżej. Pozycje,
// typ, HP, morale, routed i owner KAŻDEJ jednostki są zawsze widoczne
// na mapie (paski HP/morale rysowane dla wszystkich) — to uczciwa
// wiedza, identyczna z tym, co widzi człowiek grający przeciwko AI, więc
// ocena siły wroga na podstawie getUnits() NIE jest oszustwem. Za to
// AI NIGDY nie czyta gold/kolejki/postępu ulepszenia CUDZYCH miast —
// gracz też tego nie widzi (panel miasta pokazuje wyłącznie własne).
// AI podlega tym samym mechanikom co gracz bez wyjątków: morale,
// leczenie wyłącznie w strefie miasta, bonus "ostatniej szansy".
// ============================================================

'use strict';

// ------------------------------------------------------------
// AI_CONFIG — parametry WSPÓLNE dla wszystkich poziomów trudności (nie
// różnicują trudności, patrz AI_LEVELS niżej dla tego, co się różni).
// ------------------------------------------------------------
const AI_CONFIG = {
  clusterRadius: 100, // px — promień grupowania widocznych jednostek wroga w "armie" (klastry)
  frontCohesionBlockingPowerFraction: 0.5, // jeśli siła wroga "za plecami" (między domem a celem) >= tyle razy CAŁA siła AI, wstrzymaj głębokie natarcie
  midToOffensivePowerRatioFloor: 1.15, // dolny limit progu po złagodzeniu przy patcie — mecz ma się kończyć, niezależnie od poziomu
  // Minimalny WŁASNY dochód (zł/s) wymagany do rozważenia ofensywy.
  // BŁĄD naprawiony tu: GameAPI.goldRate to WYŁĄCZNIE wygładzone tempo
  // płaskiego dochodu z miast (index.html/updateEconomy) — konwoje
  // (dominujące, skokowe źródło zysku) NIGDY go nie zasilają
  // (updateConvoys dopisuje do gold[], nie do goldRate[]). Przy
  // CITY_BASE_INCOME_PER_SECOND=0.11 i realistycznych 2-3 miastach
  // osiągalne goldRate to ~0.22-0.33 zł/s — próg 1.0 był NIEOSIĄGALNY
  // bez desperackiego bonusu "ostatniego miasta", więc AI praktycznie
  // nigdy nie wchodziło w fazę OFFENSIVE (potwierdzone empirycznie: 12
  // minut realnej walki, zero przejść do OFFENSIVE na żadnym poziomie).
  // 0.15 jest osiągalne już przy 2 miastach (0.22 zł/s), wciąż wymaga
  // rzeczywistej, nie tylko chwilowej, gospodarki.
  midToOffensiveMinOwnIncome: 0.15,
  bigVictoryEnemyPowerDrop: 120, // nagły spadek widocznej siły wroga między turami uznawany za "dużą bitwę"
  bigVictoryWindowSeconds: 90, // jak długo "świeże zwycięstwo" liczy się jako samodzielny powód wejścia w ofensywę
  offensiveRetreatPowerFraction: 0.6, // spadek własnej siły poniżej tego ułamka stanu z początku ofensywy -> powrót do fazy środkowej
  stalemateSofteningStartSeconds: 360, // 6 minut bez wejścia w ofensywę -> zacznij łagodzić próg przewagi
  stalemateSofteningRatePerSecond: 0.001, // tempo łagodzenia progu ponad powyższy czas
  garrisonMinUnits: 2, // pełny garnizon miasta pod bezpośrednim zagrożeniem
  garrisonPerCityMinUnits: 1, // minimalna obecność w KAŻDYM własnym mieście (nie tylko najbardziej zagrożonym)
  cavalryFlankOffsetPx: 60, // odległość skrzydeł kawalerii od reszty formacji (rajd flankujący w decideAdvance)
  groupConsolidationRadius: 150, // px — rozrzut kandydatów do zaangażowania powyżej tego progu -> najpierw się zbierają, zanim ruszą razem
  counterCompositionThreshold: 0.4, // udział danego typu w WIDOCZNEJ armii wroga uznawany za wyraźny wzorzec do skontrowania
  counterCompositionShift: 0.15, // o ile korygowany jest docelowy skład armii w odpowiedzi na wzorzec wroga
  protectRangedThreatRadiusPx: 90, // wróg bliżej niż to od dystansowej jednostki AI -> cofnij ją za piechotę
  targetArmyComposition: {
    LIGHT_INFANTRY: 0.3,
    HEAVY_INFANTRY: 0.25,
    ARCHER: 0.2,
    CANNON: 0.1,
    CAVALRY: 0.15,
  },
};

// ------------------------------------------------------------
// AI_LEVELS — JEDYNE miejsce różnicujące poziomy trudności. Cała logika
// poniżej jest wspólna; te liczby to WSZYSTKO, co się zmienia.
//
// tacticalSkill (0–1): rzut wykonywany RAZ na każdą decyzję wykonawczą
// (formacja vs. naiwny "clump", konsolidacja sił przed starciem, ochrona
// artylerii, dobór składu produkcji pod przeciwnika) — sukces = pełna
// jakość wykonania, porażka = wersja uproszczona/pominięta. mistakeChance
// to odrębny, rzadszy rzut na AKTYWNY błąd (atak bez przewagi, pominięcie
// odświeżenia garnizonu, zapomnienie o rotacji rannych) — koncepcyjnie
// inne niż "wykonanie nieidealne".
//
// decisionIntervalSeconds/commitmentTime/regroupDurationSeconds/
// retreatCooldownSeconds — DAWNIEJ błędnie wspólne dla wszystkich
// poziomów (AI_CONFIG), co oznaczało, że Ekspert w ogóle nie myślał
// szybciej ani nie reagował częściej niż Łatwy poza reakcją na oblężenie
// (patrz diagnoza). Teraz to GŁÓWNA oś różnicowania tempa gry.
// ------------------------------------------------------------
const AI_LEVELS = {
  EASY: {
    decisionIntervalSeconds: 6,
    commitmentTime: 60,
    regroupDurationSeconds: 40,
    retreatCooldownSeconds: 20,
    reactionDelaySeconds: 15,
    mistakeChance: 0.35,
    tacticalSkill: 0.25,
    flankAttemptChance: 0.15,
    midEngageSuperiorityThreshold: 1.15,
    offenseSuperiorityThreshold: 1.4,
    retreatCombatHpRatio: 0.65,
    retreatGroupHpFraction: 0.35,
    maxArmyCommitmentFraction: 0.75,
    probeChance: 0.05,
    convoyRaidChance: 0.10,
    openingArmyPowerThreshold: 400,
    midToOffensivePowerRatio: 2.0,
    forwardDefenseFraction: 0,
    maxForwardPositions: 1,
    economySplitByPhase: { OPENING: 0.65, MIDGAME: 0.70, OFFENSIVE: 0.80 },
    economySplitUnderPressure: 0.85,
  },
  MEDIUM: {
    decisionIntervalSeconds: 4,
    commitmentTime: 40,
    regroupDurationSeconds: 30,
    retreatCooldownSeconds: 15,
    reactionDelaySeconds: 6,
    mistakeChance: 0.15,
    tacticalSkill: 0.75,
    flankAttemptChance: 0.4,
    midEngageSuperiorityThreshold: 1.08,
    offenseSuperiorityThreshold: 1.25,
    retreatCombatHpRatio: 0.55,
    retreatGroupHpFraction: 0.40,
    maxArmyCommitmentFraction: 0.65,
    probeChance: 0.15,
    convoyRaidChance: 0.20,
    openingArmyPowerThreshold: 300,
    midToOffensivePowerRatio: 1.6,
    forwardDefenseFraction: 0.10,
    maxForwardPositions: 1,
    economySplitByPhase: { OPENING: 0.55, MIDGAME: 0.75, OFFENSIVE: 0.85 },
    economySplitUnderPressure: 0.90,
  },
  HARD: {
    decisionIntervalSeconds: 2.5,
    commitmentTime: 25,
    regroupDurationSeconds: 20,
    retreatCooldownSeconds: 10,
    reactionDelaySeconds: 2.5,
    mistakeChance: 0.06,
    tacticalSkill: 0.95,
    flankAttemptChance: 0.7,
    midEngageSuperiorityThreshold: 0.95,
    offenseSuperiorityThreshold: 1.1,
    retreatCombatHpRatio: 0.45,
    retreatGroupHpFraction: 0.50,
    maxArmyCommitmentFraction: 0.60,
    probeChance: 0.30,
    convoyRaidChance: 0.30,
    openingArmyPowerThreshold: 220,
    midToOffensivePowerRatio: 1.3,
    forwardDefenseFraction: 0.20,
    maxForwardPositions: 2,
    economySplitByPhase: { OPENING: 0.50, MIDGAME: 0.78, OFFENSIVE: 0.88 },
    economySplitUnderPressure: 0.93,
  },
  EXPERT: {
    decisionIntervalSeconds: 1.5,
    commitmentTime: 15,
    regroupDurationSeconds: 12,
    retreatCooldownSeconds: 6,
    reactionDelaySeconds: 1.2,
    mistakeChance: 0.03,
    tacticalSkill: 0.99,
    flankAttemptChance: 0.85,
    midEngageSuperiorityThreshold: 0.85,
    offenseSuperiorityThreshold: 1.0,
    retreatCombatHpRatio: 0.40,
    retreatGroupHpFraction: 0.55,
    maxArmyCommitmentFraction: 0.55,
    probeChance: 0.45,
    convoyRaidChance: 0.45,
    openingArmyPowerThreshold: 180,
    midToOffensivePowerRatio: 1.15,
    forwardDefenseFraction: 0.35,
    maxForwardPositions: 3,
    economySplitByPhase: { OPENING: 0.45, MIDGAME: 0.80, OFFENSIVE: 0.90 },
    economySplitUnderPressure: 0.95,
  },
};

let aiLevel = 'MEDIUM'; // domyślny poziom startowy — przełączany checkboxem/radio w panelu bocznym
if (typeof window !== 'undefined') {
  window.setAIDifficulty = (level) => { if (AI_LEVELS[level]) aiLevel = level; };
}

// Jedno miejsce odczytu parametru: jeśli klucz różni poziomy (AI_LEVELS),
// czyta stamtąd; inaczej to wspólna wartość z AI_CONFIG. Wywołujący nie
// musi pamiętać, który klucz gdzie mieszka.
function cfgVal(key) {
  const levelCfg = AI_LEVELS[aiLevel];
  return key in levelCfg ? levelCfg[key] : AI_CONFIG[key];
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
    // Po WYRAŹNIE przegranym starciu: symetryczne schłodzenie — nie
    // rzuca świeżo cofniętych/rezerwowych jednostek z powrotem w TĘ SAMĄ
    // walkę, zanim minie retreatCooldownSeconds (patrz diagnoza, brak
    // tego mechanizmu powodował oscylację atak/odwrót).
    retreatCooldownUntil: 0,
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
function isWaterAt(api, point) {
  const tile = api.worldToTile(point.x, point.y);
  const terrain = api.terrainAt(tile.col, tile.row);
  return !!terrain && terrain.name === 'WATER';
}

// Poprawia DOWOLNY punkt docelowy pod kątem terenu, dla DOWOLNEGO typu
// jednostki (nie tylko dystansowych, jak dawny betterGroundForRanged) —
// woda NIGDY nie jest akceptowalnym miejscem postoju, jeśli w pobliżu
// jest cokolwiek innego (jednostka na wodzie jest mocno spowolniona, nie
// strzela, nie regeneruje się — patrz diagnoza, to był najpoważniejszy
// pojedynczy błąd). opts.avoidForest dodatkowo odrzuca las (dystansowi:
// osłabiony ostrzał i skrócony zasięg); opts.preferHills nagradza wzgórza
// (dystansowi: bonus zasięgu). Zwraca NAJBLIŻSZY dopuszczalny punkt w
// promieniu 3 kafli; brak alternatywy -> zostaje przy oryginalnym
// punkcie (silnik i tak ma zabezpieczenie "zejścia" z nieprzechodniego
// kafla, woda jest tylko KARANA, nie blokująca).
function findAcceptableGround(api, point, opts) {
  const avoidForest = !!(opts && opts.avoidForest);
  const preferHills = !!(opts && opts.preferHills);
  const isGood = (p) => {
    if (isWaterAt(api, p)) return false;
    if (avoidForest && isForestAt(api, p)) return false;
    return true;
  };
  if (preferHills && isHillsAt(api, point)) return point;
  if (isGood(point)) return point;
  for (let radius = 1; radius <= 3; radius++) {
    for (let dc = -radius; dc <= radius; dc++) {
      for (let dr = -radius; dr <= radius; dr++) {
        const tile = api.worldToTile(point.x, point.y);
        const candidate = api.tileToWorld(tile.col + dc, tile.row + dr);
        if (preferHills && isHillsAt(api, candidate)) return candidate;
        if (isGood(candidate)) return candidate;
      }
    }
  }
  return point;
}

// Przybliżenie "wąskiego przejścia": próbkuje kilka punktów na odcinku
// między dwoma punktami i wybiera ten z największą liczbą sąsiednich
// kafli nieprzechodnich (góry) — więcej sąsiadujących gór ~ węższe
// przejście. Próbki leżące NA WODZIE są całkowicie wykluczone — nigdy
// nie wybieraj wody jako pozycji obronnej, choćby sąsiadowała z górami
// (most/bród to nie miejsce do stania). Nie gwarantuje znalezienia
// obiektywnie najlepszej przełęczy, tylko rozsądny punkt obrony zamiast
// dokładnie na mieście.
function findChokePoint(api, from, to) {
  const samples = 5;
  let best = null, bestScore = -1;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const px = from.x + (to.x - from.x) * t;
    const py = from.y + (to.y - from.y) * t;
    const point = { x: px, y: py };
    if (isWaterAt(api, point)) continue;
    const tile = api.worldToTile(px, py);
    let score = 0;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (dc === 0 && dr === 0) continue;
        const terrain = api.terrainAt(tile.col + dc, tile.row + dr);
        if (terrain && !terrain.passable) score++;
      }
    }
    if (score > bestScore) { bestScore = score; best = point; }
  }
  if (best) return best;
  // Wszystkie próbki na wodzie (rzadki przypadek, np. przeprawa) —
  // środek odcinka, ale wciąż poprawiony pod kątem terenu.
  return findAcceptableGround(api, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, {});
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
// analizy grafowej. To jest CEL natarcia (armia wroga), nie miasto.
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
// Wydawanie rozkazów grupie — JEDNA wersja dla wszystkich poziomów.
// Sukces tacticalSkill: PRAWDZIWY tryb FRONT (api.issueFrontOrder) — ten
// sam mechanizm, którego gracz używa do ręcznego rozstawienia linii.
// Silnik SAM rozstawia piechotę na linii, dystansowych za nią, kawalerię
// na skrzydłach (assignFrontFormation) — AI dostaje dokładnie tę samą
// jakość formacji co gracz, bez potrzeby duplikować tę logikę tutaj.
// Porażka: cała grupa w jedno miejsce, bez podziału na role — "atakuje
// czołowo, niedokładnie". Cel jest najpierw poprawiany pod kątem terenu
// (nigdy woda — patrz findAcceptableGround, główna przyczyna jednostek
// stojących w wodzie).
//
// STABILNOŚĆ (patrz diagnoza — "jednostka wraca po wypchnięciu"): ta
// funkcja jest wołana WIELOKROTNIE dla tego samego zaangażowania (co
// decisionIntervalSeconds, przez cały commitmentTime). Za KAŻDYM razem
// dostaje TĘ SAMĄ pełną listę i TĘ SAMĄ krzywą — issueFrontOrder/
// assignFrontTargets są funkcjami czystymi (te same wejścia = te same
// sloty), więc powtórne wydanie rozkazu jest idempotentne i NIE przelicza
// geometrii od nowa na kurczącej się liście (to właśnie robił dawny
// filtr "moveIfNeeded" oparty o promień osiedlenia — usunięty). Jedyny
// filtr to jednostki aktualnie W WALCE — te nigdy nie są przerywane.
// ------------------------------------------------------------
function issueFormationOrder(api, unitSet, targetPoint, homeRefPoint) {
  const list = [...unitSet].filter((u) => u.engagedTargetId == null);
  if (list.length === 0) return;

  if (Math.random() >= cfgVal('tacticalSkill')) {
    api.issueMoveOrder(list, targetPoint);
    return;
  }

  const safeTarget = findAcceptableGround(api, targetPoint, {});
  const dx = safeTarget.x - homeRefPoint.x, dy = safeTarget.y - homeRefPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  const perpX = -dy / len, perpY = dx / len;
  const halfWidth = Math.max(30, list.length * 9);
  const curve = [
    { x: safeTarget.x - perpX * halfWidth, y: safeTarget.y - perpY * halfWidth },
    { x: safeTarget.x + perpX * halfWidth, y: safeTarget.y + perpY * halfWidth },
  ];
  api.issueFrontOrder(list, curve);
}

// Rozstawia PACZKĘ jednostek (np. świeżo przydzielony garnizon/obecność
// wysunięta) krótką linią wokół punktu, zamiast wysyłać każdą osobno do
// tego samego piksela (dawny błąd — patrz diagnoza, pkt 3). Gated
// tacticalSkill jak każde inne rozstawienie; pojedyncza jednostka albo
// porażka rzutu -> zwykły wspólny punkt. refPoint (opcjonalny) ustala
// orientację linii (np. w stronę wroga) — bez niego orientacja losowa
// (dla garnizonu miasta, gdzie nie ma jednego "kierunku zagrożenia").
function issueLineOrder(api, units, centerPoint, refPoint) {
  if (units.length <= 1 || Math.random() >= cfgVal('tacticalSkill')) {
    api.issueMoveOrder(units, centerPoint);
    return;
  }
  let perpX, perpY;
  if (refPoint) {
    const dx = centerPoint.x - refPoint.x, dy = centerPoint.y - refPoint.y;
    const len = Math.hypot(dx, dy) || 1;
    perpX = -dy / len; perpY = dx / len;
  } else {
    const angle = Math.random() * Math.PI;
    perpX = Math.cos(angle); perpY = Math.sin(angle);
  }
  const halfWidth = Math.max(20, units.length * 8);
  const curve = [
    { x: centerPoint.x - perpX * halfWidth, y: centerPoint.y - perpY * halfWidth },
    { x: centerPoint.x + perpX * halfWidth, y: centerPoint.y + perpY * halfWidth },
  ];
  api.issueFrontOrder(units, curve);
}

// Chroni artylerię/łuczników przed odsłonięciem: gdy jakikolwiek wróg
// zbliży się na protectRangedThreatRadiusPx do dystansowej jednostki AI,
// cofa WSZYSTKICH zagrożonych dystansowych tej grupy za centroid jej
// piechoty (albo do najbliższego miasta, gdy grupa nie ma piechoty),
// przez findAcceptableGround. Gated tacticalSkill — na niskich
// poziomach AI to po prostu czasem przeoczy ("zostawia artylerię bez osłony").
function decideProtectRanged(api, state) {
  if (Math.random() >= cfgVal('tacticalSkill')) return;
  const enemies = enemyAliveUnits(api, state);
  if (enemies.length === 0) return;
  for (const key of ['defense', 'offense']) {
    const list = [...state.groups[key]];
    const rangedUnits = list.filter((u) => api.UNIT_TYPES[u.type].ranged);
    if (rangedUnits.length === 0) continue;
    const threatened = rangedUnits.filter((u) => enemies.some((e) => dist(u, e) <= AI_CONFIG.protectRangedThreatRadiusPx));
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
      x: shelter.x + (hdx / hlen) * 40,
      y: shelter.y + (hdy / hlen) * 40,
    };
    retreatPoint = findAcceptableGround(api, retreatPoint, { avoidForest: true, preferHills: true });
    api.issueMoveOrder(threatened, retreatPoint);
  }
}

// ------------------------------------------------------------
// Obrona — garnizon minimalny w KAŻDYM własnym mieście (nie tylko
// najbardziej zagrożonym), z priorytetem dla aktualnie oblężonego
// (pełny garrisonMinUnits). Oblężenie z ZEREM obrońców w strefie to
// sytuacja AWARYJNA — pomija reactionDelaySeconds całkowicie (żaden
// poziom, nawet Łatwy, nie czeka bezczynnie, gdy miasto realnie traci
// strefę) i przekierowuje najbliższe DOSTĘPNE zgrupowanie, ciągnąc z
// ofensywy, jeśli rezerwa jest pusta — miasto jest ważniejsze niż
// trwający atak. Miękkie "zauważenie" oblężenia (wzmocnienie garnizonu
// zanim jest krytycznie) nadal idzie przez reactionDelaySeconds.
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

  // Awaria: miasto oblężone, strefa PUSTA (zero obrońców) — natychmiast,
  // bez opóźnienia reakcji, niezależnie od poziomu trudności.
  let emergencyCity = null;
  for (const c of mine) {
    if (c.besiegingOwner && countUnitsNear(api, state, api.cityCenter(c), api.CITY_ZONE_RADIUS) === 0) {
      emergencyCity = c;
      break;
    }
  }
  if (emergencyCity && ![...state.groups.defense].some((u) => u.__garrisonCityId === emergencyCity.id)) {
    const center = api.cityCenter(emergencyCity);
    const pool = state.groups.reserve.size > 0 ? state.groups.reserve : state.groups.offense;
    const responders = [...pool].sort((a, b) => dist(a, center) - dist(b, center)).slice(0, AI_CONFIG.garrisonMinUnits);
    for (const u of responders) {
      pool.delete(u);
      u.__garrisonCityId = emergencyCity.id;
      state.groups.defense.add(u);
    }
    if (responders.length > 0) {
      issueLineOrder(api, responders, center, null);
      if (state.groups.offense.size === 0) { state.advanceTarget = null; state.advanceCommittedAt = null; }
    }
  }

  let threatenedCity = emergencyCity;
  if (!threatenedCity) {
    for (const c of mine) {
      const rec = state.siegeNoticedAt.get(c.id);
      if (rec && (now - rec.firstSeenAt) / 1000 >= cfgVal('reactionDelaySeconds')) {
        threatenedCity = c;
        break;
      }
    }
  }

  // Okazjonalny błąd: czasem AI zostawia miasto słabiej bronione (pomija
  // odświeżenie garnizonu w tej turze), ale TYLKO gdy nic akurat nie
  // jest realnie zagrożone — nigdy w obliczu prawdziwego oblężenia.
  if (!threatenedCity && Math.random() < cfgVal('mistakeChance')) return;

  // Każda jednostka garnizonu nosi znacznik __garrisonCityId (na samym
  // obiekcie jednostki — przetrwa między klatkami tak długo, jak żyje) i
  // ZOSTAJE w state.groups.defense na stałe, więc refreshGroups nigdy jej
  // nie zmiecie z powrotem do rezerwy, zanim fizycznie dotrze na miejsce.
  // Przydział PACZKĄ (issueLineOrder), nie jednostka po jednostce — i
  // TYLKO RAZ na przydzieloną paczkę: raz rozstawiony garnizon nigdy nie
  // dostaje kolejnego rozkazu, więc wypchnięcie przez przechodzące
  // jednostki nie wywołuje żadnego "powrotu" (patrz diagnoza, pkt 7).
  for (const c of mine) {
    const center = api.cityCenter(c);
    const requiredMin = c === threatenedCity ? AI_CONFIG.garrisonMinUnits : AI_CONFIG.garrisonPerCityMinUnits;
    const assignedToThisCity = [...state.groups.defense].filter((u) => u.__garrisonCityId === c.id).length;
    if (assignedToThisCity >= requiredMin) continue;
    let need = requiredMin - assignedToThisCity;
    const newGuards = [];
    while (need > 0 && state.groups.reserve.size > 0) {
      const guard = [...state.groups.reserve][0];
      state.groups.reserve.delete(guard);
      guard.__garrisonCityId = c.id;
      state.groups.defense.add(guard);
      newGuards.push(guard);
      need--;
    }
    if (newGuards.length > 0) issueLineOrder(api, newGuards, center, null);
  }
}

// ------------------------------------------------------------
// Stała obecność do przodu — kontrola terenu i blokowanie dostępu do
// własnych miast NIEZALEŻNIE od tego, czy coś akurat atakuje. Ułamek
// wolnej rezerwy (forwardDefenseFraction, PONAD garnizon) trzymany na
// przełęczach między własnymi a najbliższymi wrogimi miastami, do
// maxForwardPositions par naraz — to jest właśnie "reagowanie na kilku
// kierunkach". Na niskich poziomach forwardDefenseFraction=0, więc to
// się w praktyce nie dzieje, bez potrzeby osobnej gałęzi kodu. Jednostki
// oznaczone __forwardPositionId zostają w state.groups.defense na stałe
// (jak garnizon) — więc podlegają też decideRetreat/decideHealingRotation.
// Przydział PACZKĄ (issueLineOrder) zamiast jednostka po jednostce, i
// TYLKO RAZ na paczkę — te same powody co w decideDefense.
// ------------------------------------------------------------
function decideForwardPresence(api, state) {
  const fraction = cfgVal('forwardDefenseFraction');
  if (fraction <= 0) return;
  const mine = myCities(api, state);
  const enemies = enemyCities(api, state);
  if (mine.length === 0 || enemies.length === 0) return;

  const maxPositions = Math.max(1, Math.min(cfgVal('maxForwardPositions'), mine.length, enemies.length));
  const pairs = [];
  const usedHomes = new Set();
  for (let i = 0; i < mine.length && pairs.length < maxPositions; i++) {
    const home = mine[i];
    if (usedHomes.has(home.id)) continue;
    const enemyCity = nearestCity(api.cityCenter(home), enemies, api);
    if (!enemyCity) continue;
    usedHomes.add(home.id);
    pairs.push({ home, enemyCity, key: `fwd:${home.id}:${enemyCity.id}` });
  }
  if (pairs.length === 0) return;

  const totalPower = sumPower(api, myAliveUnits(api, state)) || 1;
  const desiredPowerPerPosition = (totalPower * fraction) / pairs.length;

  for (const { home, enemyCity, key } of pairs) {
    let assignedPower = sumPower(api, [...state.groups.defense].filter((u) => u.__forwardPositionId === key));
    if (assignedPower >= desiredPowerPerPosition) continue;
    const homeCenter = api.cityCenter(home);
    const point = findChokePoint(api, homeCenter, api.cityCenter(enemyCity));
    const newGuards = [];
    while (assignedPower < desiredPowerPerPosition && state.groups.reserve.size > 0) {
      const guard = [...state.groups.reserve][0];
      state.groups.reserve.delete(guard);
      guard.__forwardPositionId = key;
      state.groups.defense.add(guard);
      newGuards.push(guard);
      assignedPower += unitPower(api, guard);
    }
    if (newGuards.length > 0) issueLineOrder(api, newGuards, point, homeCenter);
  }
}

// ------------------------------------------------------------
// Natarcie — cel to WYŁĄCZNIE klastry widocznej armii wroga w fazach
// OPENING/MIDGAME (teren premiuje/karze wybór), a w OFFENSIVE dodatkowo
// miasta wroga (próg wyższy niż zwykłe starcie). Miasto to nagroda za
// wygraną bitwę, nigdy cel sam w sobie. Wołane w KAŻDEJ fazie — AI ma
// stale szukać starcia, nie czekać bezczynnie na próg mocy.
// ------------------------------------------------------------
function decideAdvance(api, state, now, allowCityTargets) {
  if (now < state.regroupUntil) return; // przegrupowanie po zwycięstwie — nie rusza dalej
  if (now < state.retreatCooldownUntil) return; // schłodzenie po przegranej — nie rzuca się od razu z powrotem w tę samą walkę

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
    if (committedFor < cfgVal('commitmentTime')) {
      issueFormationOrder(api, state.groups.offense, state.advanceTarget.point, homeFor(state.advanceTarget.point));
      return;
    }
  }
  state.advanceTarget = null;
  state.advanceCommittedAt = null;

  const totalPower = sumPower(api, myAliveUnits(api, state));
  const maxCommitPower = totalPower * cfgVal('maxArmyCommitmentFraction');
  const candidates = [...state.groups.reserve, ...state.groups.offense];
  // Zdrowsze jednostki jako pierwsze — ranne, wciąż leczące się w
  // rezerwie, zostają z tyłu dłużej ("zastępuje ranne świeżymi").
  if (Math.random() < cfgVal('tacticalSkill')) {
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

  // Koncentracja sił przed starciem: jeśli wybrani kandydaci są
  // rozrzuceni dalej niż groupConsolidationRadius (część świeża z
  // rezerwy przy mieście, część już na przedpolu), każ im się najpierw
  // zejść do wspólnego punktu (centroid — obie części idą sobie naprzeciw)
  // i dopiero w KOLEJNEJ turze decyzyjnej oceniaj cele. Bez tego oddziały
  // dochodziłyby do walki pojedynczo. Gated tacticalSkill. Zwykły
  // issueMoveOrder (nie formacja) — to tylko zbiórka, nie linia bojowa.
  if (engageUnits.length > 1 && Math.random() < cfgVal('tacticalSkill')) {
    const centroid = {
      x: engageUnits.reduce((s, u) => s + u.x, 0) / engageUnits.length,
      y: engageUnits.reduce((s, u) => s + u.y, 0) / engageUnits.length,
    };
    const maxSpread = Math.max(...engageUnits.map((u) => dist(u, centroid)));
    if (maxSpread > AI_CONFIG.groupConsolidationRadius) {
      api.issueMoveOrder(engageUnits.filter((u) => u.engagedTargetId == null), centroid);
      return;
    }
  }

  let bestTarget = null, bestScore = -Infinity, bestKind = null, bestRatio = 0;
  for (const cluster of clusterEnemyUnits(api, state)) {
    const clusterPower = sumPower(api, cluster.units) || 1;
    const ratio = committedPower / clusterPower;
    const centroid = findAcceptableGround(api, cluster.centroid, {}); // nigdy nie celuj wprost w wodę
    let terrainScore = 0;
    if (isHillsAt(api, centroid)) terrainScore += 0.3;
    if (isForestAt(api, centroid)) terrainScore -= 0.3;
    const score = ratio + terrainScore;
    if (score > bestScore) { bestScore = score; bestTarget = centroid; bestKind = 'ARMY'; bestRatio = ratio; }
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
    // Brak widocznego celu: wysuń GŁÓWNE siły na rozsądną pozycję
    // (przełęcz) zamiast stać bezczynnie — "wysuwa siły na front", ale
    // bez atakowania czegokolwiek. Działa w KAŻDEJ fazie.
    const enemyRef = enemyCities(api, state)[0];
    const homeCity = myCities(api, state)[0];
    if (enemyRef && homeCity) {
      const staging = findChokePoint(api, api.cityCenter(homeCity), api.cityCenter(enemyRef));
      issueFormationOrder(api, new Set(engageUnits), staging, api.cityCenter(homeCity));
    }
    return;
  }

  const threshold = bestKind === 'CITY' ? cfgVal('offenseSuperiorityThreshold') : cfgVal('midEngageSuperiorityThreshold');
  const meets = bestRatio >= threshold;
  const mistake = Math.random() < cfgVal('mistakeChance');
  if (!meets && !mistake) return; // czeka na choćby lekką przewagę, nie rzuca się bez niej

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
    issueFormationOrder(api, new Set(rest), bestTarget, home);
  } else {
    issueFormationOrder(api, new Set(engageUnits), bestTarget, home);
  }
}

// ------------------------------------------------------------
// Odwrót z WYRAŹNIE przegrywanego starcia — próg (retreatCombatHpRatio)
// istotnie niższy niż kiedyś: AI trzyma się starcia mimo pierwszych
// strat, wycofuje CAŁĄ grupę dopiero gdy naprawdę przegrywa.
// "Rozwiązanie" grupy = wyczyszczenie Setu — ocalali wrócą do REZERWY.
// Ustawia retreatCooldownUntil — symetryczne schłodzenie do "dużego
// zwycięstwa" (regroupUntil), naprawia oscylację atak/odwrót (diagnoza).
// ------------------------------------------------------------
function decideRetreat(api, state, now) {
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

    if (myPower / enemyPower < cfgVal('retreatCombatHpRatio')) {
      const home = nearestCity(centroid, myCities(api, state), api);
      if (home) api.issueMoveOrder(list, api.cityCenter(home));
      set.clear();
      if (key === 'offense') { state.advanceTarget = null; state.advanceCommittedAt = null; }
      state.retreatCooldownUntil = now + cfgVal('retreatCooldownSeconds') * 1000;
    }
  }
}

// Rotacja uszkodzonych oddziałów: CAŁA grupa (nie pojedyncze jednostki)
// poniżej progu średniego HP wraca do miasta się leczyć (leczenie działa
// TYLKO w strefie miasta). Decyzja na poziomie grupy — nie
// mikrozarządzanie pojedynczą raną jednostką w środku starcia. Gated
// mistakeChance — na niskich poziomach AI czasem o tym zapomina.
function decideHealingRotation(api, state) {
  if (Math.random() < cfgVal('mistakeChance')) return;
  for (const key of ['defense', 'offense']) {
    const set = state.groups[key];
    if (set.size === 0) continue;
    if (groupHpFraction(api, set) >= cfgVal('retreatGroupHpFraction')) continue;
    const list = [...set];
    const centroid = { x: list.reduce((s, u) => s + u.x, 0) / list.length, y: list.reduce((s, u) => s + u.y, 0) / list.length };
    const home = nearestCity(centroid, myCities(api, state), api);
    if (home) api.issueMoveOrder(list, api.cityCenter(home));
    set.clear();
    if (key === 'offense') { state.advanceTarget = null; state.advanceCommittedAt = null; }
  }
}

// ------------------------------------------------------------
// Sondowanie i rajdy — presja na przeciwnika NIEZALEŻNA od głównego
// starcia, żeby gracz nigdy nie miał kilku minut całkowitego spokoju.
// ------------------------------------------------------------

// Rajd na konwój — okazjonalny: tylko gdy akurat wypadnie rzut i akurat
// jest wolna (rezerwowa) grupa. Aktywne od startu meczu.
function decideConvoyRaid(api, state) {
  if (Math.random() >= cfgVal('convoyRaidChance')) return;
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

// Sondowanie: odrywa 1-2 jednostki z NADWYŻKI rezerwy (nie rusza
// garnizonu ani obecności do przodu) i wysyła je w stronę najsłabiej
// widocznie bronionego miasta wroga. Rozporządzalne, jak rajd na
// konwój — strata to koszt nękania/informacji, nie realnej siły.
function decideProbe(api, state) {
  if (Math.random() >= cfgVal('probeChance')) return;
  const spare = [...state.groups.reserve];
  if (spare.length < 3) return; // zostaw margines, nie ogałacaj rezerwy do zera
  const probers = spare.slice(0, Math.min(2, spare.length - 2));
  if (probers.length === 0) return;
  const enemies = enemyCities(api, state);
  if (enemies.length === 0) return;
  let weakest = null, weakestPower = Infinity;
  for (const c of enemies) {
    const center = api.cityCenter(c);
    const defenders = enemyAliveUnits(api, state).filter((u) => dist(u, center) <= api.CITY_ZONE_RADIUS + 60);
    const power = sumPower(api, defenders);
    if (power < weakestPower) { weakestPower = power; weakest = c; }
  }
  if (!weakest) return;
  api.issueMoveOrder(probers, api.cityCenter(weakest));
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

// Koryguje bazowy docelowy skład armii (AI_CONFIG.targetArmyComposition)
// w odpowiedzi na WIDOCZNY skład wroga (pozycje/typy jednostek są zawsze
// widoczne na mapie dla obu stron — to uczciwa wiedza). Reaguje tylko na
// wyraźny wzorzec (counterCompositionThreshold), umiarkowaną korektą
// (counterCompositionShift), nigdy nie zamienia całej armii w jeden typ.
// Gated tacticalSkill — na niskich poziomach AI po prostu tego nie
// zauważa i trzyma się bazowego składu.
function computeTargetComposition(api, state) {
  if (Math.random() >= cfgVal('tacticalSkill')) return AI_CONFIG.targetArmyComposition;
  const enemy = enemyAliveUnits(api, state);
  const total = enemy.length || 1;
  const cavalryShare = enemy.filter((u) => u.type === 'CAVALRY').length / total;
  const infantryShare = enemy.filter((u) => u.type === 'LIGHT_INFANTRY' || u.type === 'HEAVY_INFANTRY').length / total;
  const comp = { ...AI_CONFIG.targetArmyComposition };
  if (cavalryShare >= AI_CONFIG.counterCompositionThreshold) {
    comp.HEAVY_INFANTRY = (comp.HEAVY_INFANTRY || 0) + AI_CONFIG.counterCompositionShift;
    comp.CAVALRY = Math.max(0, (comp.CAVALRY || 0) - AI_CONFIG.counterCompositionShift);
  }
  if (infantryShare >= AI_CONFIG.counterCompositionThreshold) {
    comp.ARCHER = (comp.ARCHER || 0) + AI_CONFIG.counterCompositionShift / 2;
    comp.CANNON = (comp.CANNON || 0) + AI_CONFIG.counterCompositionShift / 2;
    comp.LIGHT_INFANTRY = Math.max(0, (comp.LIGHT_INFANTRY || 0) - AI_CONFIG.counterCompositionShift);
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

// Dawniej: JEDNA próba (produkcja ALBO ulepszenie, rzut monetą) na cały
// cykl decyzyjny, niezależnie od tego, ile złota było w banku — główna
// przyczyna "AI marnuje złoto" (patrz diagnoza). Teraz: pętla wydawania,
// dopóki stać na choćby jedną akcję. Podział produkcja/ulepszenia to
// PROPORCJA WYDATKÓW w tej pętli (każda iteracja losuje, którą akcję
// spróbować NAJPIERW), nie szansa na pojedynczą, jednorazową akcję.
// Gdy preferowana akcja akurat niedostępna (kolejka pełna/nic do
// ulepszenia), próbuje drugiej, zanim naprawdę podda się na ten cykl.
function decideEconomy(api, state) {
  decideTradeRoutes(api, state);

  const mine = myCities(api, state);
  if (mine.length === 0) return;
  const underPressure = isUnderPressure(api, state);
  const productionShare = underPressure
    ? cfgVal('economySplitUnderPressure')
    : (cfgVal('economySplitByPhase')[state.phase] ?? 0.7);

  const tryProduce = () => {
    const type = pickProductionType(api, state);
    if (!type) return false;
    const city = [...mine].sort((a, b) => a.queue.length - b.queue.length)[0];
    return api.queueProduction(city, type);
  };
  const tryUpgrade = () => {
    const upgradable = mine.filter((c) => c.level < 5 && c.upgradeRemaining === 0);
    if (upgradable.length === 0) return false;
    const weakest = upgradable.sort((a, b) => a.level - b.level)[0];
    return api.upgradeCity(weakest);
  };

  for (let i = 0; i < 20; i++) {
    const preferProduction = Math.random() < productionShare;
    const first = preferProduction ? tryProduce : tryUpgrade;
    const second = preferProduction ? tryUpgrade : tryProduce;
    if (!first() && !second()) break; // ani produkcja, ani ulepszenie możliwe -> naprawdę koniec złota na ten cykl
  }
}

// ------------------------------------------------------------
// Maszyna stanów faz — przejścia oparte o SYTUACJĘ, nie zegar (poza
// łagodzeniem progu przy bardzo długim patcie). OPENING już nie
// blokuje decideAdvance (patrz runDecisionCycle) — wpływa WYŁĄCZNIE na
// podział ekonomii i na to, kiedy odblokowuje się MIDGAME/OFFENSIVE
// (a więc ataki na miasta).
// ------------------------------------------------------------
function updatePhase(api, state, now) {
  const myPower = sumPower(api, myAliveUnits(api, state));
  const enemyPower = sumPower(api, enemyAliveUnits(api, state));

  // Wykrycie "świeżo wygranej dużej bitwy": nagły spadek widocznej siły
  // wroga bez porównywalnego spadku siły własnej między turami decyzyjnymi.
  // Po wygranej bitwie grupa natarcia NIE rusza dalej — wraca się leczyć
  // i przegrupować (regroupUntil).
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
      state.regroupUntil = now + cfgVal('regroupDurationSeconds') * 1000;
    }
  }
  state.lastEnemyPower = enemyPower;
  state.lastMyPower = myPower;

  if (state.gameStartTime == null) state.gameStartTime = now;
  const stalledSeconds = Math.max(0, (now - state.gameStartTime) / 1000 - AI_CONFIG.stalemateSofteningStartSeconds);
  const effectiveOffenseRatio = Math.max(
    AI_CONFIG.midToOffensivePowerRatioFloor,
    cfgVal('midToOffensivePowerRatio') - stalledSeconds * AI_CONFIG.stalemateSofteningRatePerSecond,
  );

  if (state.phase === 'OPENING') {
    // Tolerancja jednego miasta wciąż "w drodze" (garnizon wysłany, ale
    // jeszcze nie dotarł) — bez tego jeden pechowy przydział mógłby
    // blokować przejście w nieskończoność.
    const mineCities = myCities(api, state);
    const securedCount = mineCities.filter(
      (c) => countUnitsNear(api, state, api.cityCenter(c), api.CITY_ZONE_RADIUS) >= AI_CONFIG.garrisonPerCityMinUnits,
    ).length;
    const citiesSecured = securedCount >= mineCities.length - 1;
    if (myPower >= cfgVal('openingArmyPowerThreshold') && citiesSecured) {
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
// raz na klatkę, ale WEWNĘTRZNIE działa co decisionIntervalSeconds
// (zależne od poziomu — patrz cfgVal w makeTick). decideAdvance/
// decideForwardPresence/decideProbe/decideConvoyRaid działają w KAŻDEJ
// fazie — AI ma stale wywierać presję, nie czekać bezczynnie na próg mocy.
// ------------------------------------------------------------
function runDecisionCycle(api, state, now) {
  refreshGroups(api, state);
  updatePhase(api, state, now);
  decideHealingRotation(api, state);
  decideRetreat(api, state, now);
  decideDefense(api, state, now);
  decideForwardPresence(api, state);
  decideAdvance(api, state, now, state.phase === 'OFFENSIVE');
  decideProtectRanged(api, state);
  decideProbe(api, state);
  decideConvoyRaid(api, state);
  decideEconomy(api, state);
}

function makeTick(api, state) {
  return function tick(dt, now) {
    if (api.isGameOver()) return;
    state.decisionTimer += dt;
    if (state.decisionTimer < cfgVal('decisionIntervalSeconds')) return;
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
