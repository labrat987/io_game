#!/usr/bin/env node
// Narzędzie do automatycznego testowania balansu jednostek WarConvoy.
//
// Uruchamia grę w trybie headless (index.html?headless=1 — bez
// renderowania, bez limitu klatek, patrz window.BalanceSim w index.html)
// i rozgrywa serię starć dokładnie na tej samej logice walki co normalna
// gra (resolveCombat/updateUnit/resolveCollisions wołane wprost).
//
// Wymaga Playwright (require('playwright')) — w tym środowisku:
//   NODE_PATH=/opt/node22/lib/node_modules node balance-sim.js
// W innym środowisku: npm install playwright, potem zwykłe
//   node balance-sim.js
//
// Nie modyfikuje żadnych wartości w CONFIG — tylko czyta i raportuje.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PORT = 8877;
const REPEATS = 50; // minimum wg specyfikacji
const MAX_SECONDS = 1600; // podniesione po tej turze (kolejne -20% prędkości/-15% obrażeń oraz zniesienie
// minRange — dystansowi faktycznie się teraz dobijają zamiast wiecznego pata — wydłużyły starcia;
// zmierzony najdłuższy przypadek CANNON vs CANNON ~1017s, zostawiony margines)

function startServer() {
  const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (filePath === ROOT || filePath.endsWith(path.sep)) filePath = path.join(ROOT, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

// Uśrednia N powtórzeń tego samego starcia w jedną zbiorczą metrykę.
function summarize(battles) {
  const n = battles.length;
  const winsA = battles.filter(b => b.winner === 'A').length;
  const winsB = battles.filter(b => b.winner === 'B').length;
  const draws = battles.filter(b => b.winner === 'DRAW').length;
  const timeouts = battles.filter(b => b.timedOut).length;
  return {
    n,
    winRateA: winsA / n,
    winRateB: winsB / n,
    drawRate: draws / n,
    timeoutRate: timeouts / n,
    avgDuration: mean(battles.map(b => b.durationSeconds)),
    avgSurvivorsWinner: mean(battles.filter(b => b.winner === 'A').map(b => b.survivorsA)
      .concat(battles.filter(b => b.winner === 'B').map(b => b.survivorsB)) || [0]),
    avgRoutedA: mean(battles.map(b => b.routedA)),
    avgRoutedB: mean(battles.map(b => b.routedB)),
    avgLastStandA: mean(battles.map(b => b.lastStandA)),
    avgLastStandB: mean(battles.map(b => b.lastStandB)),
    avgDmgPerUnitA: mean(battles.map(b => b.avgDamagePerUnitA)),
    avgDmgPerUnitB: mean(battles.map(b => b.avgDamagePerUnitB)),
  };
}

async function runRepeated(page, config, n) {
  const battles = [];
  for (let i = 0; i < n; i++) {
    battles.push(await page.evaluate((cfg) => window.BalanceSim.runBattle(cfg), config));
  }
  return battles;
}

function allUnorderedPairsWithMirrors(types) {
  const pairs = [];
  for (let i = 0; i < types.length; i++) {
    for (let j = i; j < types.length; j++) pairs.push([types[i], types[j]]);
  }
  return pairs;
}

async function main() {
  const server = await startServer();
  // W tym środowisku (sandbox) przeglądarka jest preinstalowana pod stałą
  // ścieżką i pobieranie własnej jest zablokowane; na zwykłej maszynie
  // deweloperskiej Playwright sam znajdzie swoją przeglądarkę.
  const sandboxChromium = '/opt/pw-browsers/chromium';
  const launchOpts = fs.existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html?headless=1`);
  await page.waitForTimeout(200);

  const unitTypes = await page.evaluate(() => Object.keys(UNIT_TYPES));
  const costs = await page.evaluate(() => {
    const out = {};
    for (const t of Object.keys(UNIT_TYPES)) out[t] = UNIT_TYPES[t].cost;
    return out;
  });

  const pairs = allUnorderedPairsWithMirrors(unitTypes);
  console.log(`Typy: ${unitTypes.join(', ')}`);
  console.log(`Koszty: ${JSON.stringify(costs)}`);
  console.log(`Par (z lustrzanymi): ${pairs.length}, powtórzeń każda: ${REPEATS}, limit czasu starcia: ${MAX_SECONDS}s\n`);

  // 1. Starcia równoliczne — 10 vs 10
  console.log('=== 1/4 Starcia równoliczne (10 vs 10) ===');
  const equalCount = [];
  for (const [a, b] of pairs) {
    process.stdout.write(`  ${a} vs ${b}... `);
    const battles = await runRepeated(page, {
      armyA: [{ type: a, count: 10 }], armyB: [{ type: b, count: 10 }], maxSeconds: MAX_SECONDS,
    }, REPEATS);
    const s = summarize(battles);
    equalCount.push({ a, b, ...s });
    console.log(`A ${pct(s.winRateA)} / B ${pct(s.winRateB)} / remis ${pct(s.drawRate)}`);
  }

  // 2. Starcia równokosztowe
  console.log('\n=== 2/4 Starcia równokosztowe (budżet = 10x koszt typu A) ===');
  const equalCost = [];
  for (const [a, b] of pairs) {
    const budget = 10 * costs[a];
    const countB = Math.max(1, Math.floor(budget / costs[b]));
    process.stdout.write(`  10x ${a} (koszt ${budget}) vs ${countB}x ${b}... `);
    const battles = await runRepeated(page, {
      armyA: [{ type: a, count: 10 }], armyB: [{ type: b, count: countB }], maxSeconds: MAX_SECONDS,
    }, REPEATS);
    const s = summarize(battles);
    equalCost.push({ a, b, countA: 10, countB, ...s });
    console.log(`A ${pct(s.winRateA)} / B ${pct(s.winRateB)} / remis ${pct(s.drawRate)}`);
  }

  // 3. Teren — 4 reprezentatywne pary x 3 tereny
  console.log('\n=== 3/4 Wpływ terenu (4 reprezentatywne pary x FIELD/FOREST/WATER) ===');
  const terrainPairs = [
    ['ARCHER', 'LIGHT_INFANTRY'],
    ['CAVALRY', 'HEAVY_INFANTRY'],
    ['LIGHT_INFANTRY', 'HEAVY_INFANTRY'],
    ['CANNON', 'CAVALRY'],
  ];
  const terrainResults = [];
  for (const [a, b] of terrainPairs) {
    for (const terrain of ['FIELD', 'FOREST', 'WATER']) {
      process.stdout.write(`  ${a} vs ${b} na ${terrain}... `);
      const battles = await runRepeated(page, {
        armyA: [{ type: a, count: 10 }], armyB: [{ type: b, count: 10 }], terrain, maxSeconds: MAX_SECONDS,
      }, REPEATS);
      const s = summarize(battles);
      terrainResults.push({ a, b, terrain, ...s });
      console.log(`A ${pct(s.winRateA)} / B ${pct(s.winRateB)} / czas śr. ${s.avgDuration.toFixed(0)}s`);
    }
  }

  // 4b. Wpływ ataku z flanki/tyłu (kawaleria) — izolowany test: obrońcy
  // NIERUCHOMI o stałym zwrocie (window.BalanceSim.runFlankBattle), kawaleria
  // ładuje z czoła (0°) vs z tyłu (180°) tej samej wielkości armii. Cel:
  // sprawdzić, czy bonus flankowania robi z kawalerii dominującą jednostkę.
  console.log('\n=== 4b/4 Wpływ ataku z flanki/tyłu (kawaleria, 10 vs 10, obrońca nieruchomy) ===');
  const FLANK_REPEATS = 30;
  const flankScenarios = [
    { defenderType: 'LIGHT_INFANTRY' },
    { defenderType: 'HEAVY_INFANTRY' },
    { defenderType: 'ARCHER' },
  ];
  const flankResults = [];
  for (const { defenderType } of flankScenarios) {
    for (const [label, approachAngleDeg] of [['CZOŁO (0°)', 0], ['TYŁ (180°)', 180]]) {
      process.stdout.write(`  CAVALRY vs ${defenderType}, atak z ${label}... `);
      const battles = [];
      for (let i = 0; i < FLANK_REPEATS; i++) {
        battles.push(await page.evaluate((cfg) => window.BalanceSim.runFlankBattle(cfg), {
          defenderType, defenderCount: 10, attackerType: 'CAVALRY', attackerCount: 10, approachAngleDeg, maxSeconds: MAX_SECONDS,
        }));
      }
      const s = summarize(battles);
      flankResults.push({ defenderType, approach: label, ...s });
      console.log(`kawaleria (A) ${pct(s.winRateA)} / obrońca (B) ${pct(s.winRateB)} / remis ${pct(s.drawRate)}`);
    }
  }

  // 4. Starcia mieszane
  console.log('\n=== 4/4 Starcia mieszane (piechota + wsparcie vs czysta piechota) ===');
  const mixedScenarios = [
    { name: 'LIGHT_INFANTRY+ARCHER vs LIGHT_INFANTRY', infantry: 'LIGHT_INFANTRY', support: 'ARCHER' },
    { name: 'HEAVY_INFANTRY+CANNON vs HEAVY_INFANTRY', infantry: 'HEAVY_INFANTRY', support: 'CANNON' },
  ];
  const mixedResults = [];
  for (const { name, infantry, support } of mixedScenarios) {
    const totalBudget = 10 * costs[infantry];
    const supportBudget = totalBudget * 0.3;
    const infantryBudgetA = totalBudget * 0.7;
    const countInfA = Math.max(1, Math.round(infantryBudgetA / costs[infantry]));
    const countSupport = Math.max(1, Math.round(supportBudget / costs[support]));
    const countInfB = 10;
    process.stdout.write(`  ${name} (${countInfA}x${infantry}+${countSupport}x${support} vs ${countInfB}x${infantry})... `);
    const battles = await runRepeated(page, {
      armyA: [{ type: infantry, count: countInfA }, { type: support, count: countSupport }],
      armyB: [{ type: infantry, count: countInfB }],
      maxSeconds: MAX_SECONDS,
    }, REPEATS);
    const s = summarize(battles);
    mixedResults.push({ name, countInfA, countSupport, countInfB, ...s });
    console.log(`mieszana ${pct(s.winRateA)} / czysta piechota ${pct(s.winRateB)} / remis ${pct(s.drawRate)}`);
  }

  // 5. Załamania morale — starcia FRONTALNE (1v1, bez przewagi, bez
  // flanki) vs OKRĄŻENIE (3 atakujących rozstawionych co 120° wokół
  // obrońcy — jednocześnie przewaga liczebna 3:1 I okrążenie kątowe).
  // Mierzy WYŁĄCZNIE to, o co prosił użytkownik: % starć kończących się
  // złamaniem (routed=true w dowolnym momencie starcia) w każdym z dwóch
  // scenariuszy, oraz średni czas trwania starcia.
  console.log('\n=== 5/5 Załamania morale: starcia FRONTALNE vs OKRĄŻENIE ===');
  const MORALE_DUEL_REPEATS = 50;
  const moraleScenarios = [
    { defenderType: 'LIGHT_INFANTRY', attackerType: 'LIGHT_INFANTRY' },
    { defenderType: 'HEAVY_INFANTRY', attackerType: 'HEAVY_INFANTRY' },
  ];
  const moraleAngleSets = [
    ['FRONTALNE (1v1)', [90]],
    ['OKRĄŻENIE (3 kierunki, 3:1)', [0, 120, 240]],
  ];
  const moraleResults = [];
  for (const { defenderType, attackerType } of moraleScenarios) {
    for (const [label, angles] of moraleAngleSets) {
      process.stdout.write(`  ${defenderType} broni się przed ${attackerType}, ${label}... `);
      const duels = [];
      for (let i = 0; i < MORALE_DUEL_REPEATS; i++) {
        duels.push(await page.evaluate((cfg) => window.BalanceSim.runMoraleDuel(cfg), {
          defenderType, attackerType, attackerAngles: angles, maxSeconds: MAX_SECONDS,
        }));
      }
      const routRate = duels.filter((d) => d.routed).length / duels.length;
      const avgDuration = mean(duels.map((d) => d.durationSeconds));
      const timeoutRate = duels.filter((d) => d.timedOut).length / duels.length;
      moraleResults.push({ defenderType, attackerType, scenario: label, routRate, avgDuration, timeoutRate, n: duels.length });
      console.log(`załamanie ${pct(routRate)} / śr. czas ${avgDuration.toFixed(1)}s / timeout ${pct(timeoutRate)}`);
    }
  }

  await browser.close();
  server.close();

  // ==== RAPORT ====
  console.log('\n\n########## RAPORT ##########\n');

  console.log('--- Odsetek zwycięstw w starciach równokosztowych ---');
  console.log('typA vs typB (liczbaA/liczbaB) | wygrane A | wygrane B | remis | śr. czas');
  for (const r of equalCost) {
    console.log(`${r.a} vs ${r.b} (${r.countA}/${r.countB}) | ${pct(r.winRateA)} | ${pct(r.winRateB)} | ${pct(r.drawRate)} | ${r.avgDuration.toFixed(0)}s`);
  }

  console.log('\n--- Zbiorczy win-rate typu (uśredniony po wszystkich przeciwnikach, równokosztowo) ---');
  const perTypeWinRate = {};
  for (const t of unitTypes) {
    const asA = equalCost.filter(r => r.a === t).map(r => r.winRateA);
    const asB = equalCost.filter(r => r.b === t && r.a !== t).map(r => r.winRateB);
    perTypeWinRate[t] = mean(asA.concat(asB));
  }
  for (const t of unitTypes) {
    const wr = perTypeWinRate[t];
    const flag = wr > 0.65 ? '  <== ZA SILNY (>65%)' : wr < 0.35 ? '  <== ZA SŁABY (<35%)' : '';
    console.log(`${t}: ${pct(wr)}${flag}`);
  }

  console.log('\n--- Skrajne pary (>80% lub <20%, potencjalne dominacje, starcia równokosztowe) ---');
  const extremes = equalCost.filter(r => r.a !== r.b && (r.winRateA > 0.8 || r.winRateA < 0.2));
  if (extremes.length === 0) console.log('(brak)');
  for (const r of extremes) {
    console.log(`${r.a} (${r.countA}) vs ${r.b} (${r.countB}): A ${pct(r.winRateA)}`);
  }

  console.log('\n--- Wpływ terenu ---');
  for (const [a, b] of terrainPairs) {
    const rows = terrainResults.filter(r => r.a === a && r.b === b);
    const winRates = rows.map(r => r.winRateA);
    const spread = Math.max(...winRates) - Math.min(...winRates);
    const durations = rows.map(r => r.avgDuration);
    const durSpreadPct = (Math.max(...durations) - Math.min(...durations)) / mean(durations);
    const noDiff = spread < 0.10 && durSpreadPct < 0.15;
    console.log(`${a} vs ${b}: ${rows.map(r => `${r.terrain}=${pct(r.winRateA)}(${r.avgDuration.toFixed(0)}s)`).join(', ')}${noDiff ? '  <== TEREN BEZ RÓŻNICY' : ''}`);
  }

  console.log('\n--- Załamania (rout) / Last Stand — starcia równoliczne 10v10, jako % startowego składu ---');
  console.log('typA vs typB | A: złamane/LastStand | B: złamane/LastStand');
  for (const r of equalCount) {
    const routA = pct(r.avgRoutedA / 10), lsA = pct(r.avgLastStandA / 10);
    const routB = pct(r.avgRoutedB / 10), lsB = pct(r.avgLastStandB / 10);
    console.log(`${r.a} vs ${r.b} | A: ${routA} / ${lsA} | B: ${routB} / ${lsB}`);
  }
  const overallRoutRate = mean(equalCount.flatMap(r => [r.avgRoutedA / 10, r.avgRoutedB / 10]));
  const overallLastStandRate = mean(equalCount.flatMap(r => [r.avgLastStandA / 10, r.avgLastStandB / 10]));
  console.log(`\nŚrednio po wszystkich starciach równolicznych: złamanie ${pct(overallRoutRate)}, Last Stand ${pct(overallLastStandRate)} jednostek startowego składu.`);

  console.log('\n--- Wpływ ataku z flanki/tyłu na kawalerię (obrońca nieruchomy) ---');
  for (const t of ['LIGHT_INFANTRY', 'HEAVY_INFANTRY', 'ARCHER']) {
    const front = flankResults.find(r => r.defenderType === t && r.approach.startsWith('CZOŁO'));
    const rear = flankResults.find(r => r.defenderType === t && r.approach.startsWith('TYŁ'));
    const swing = rear.winRateA - front.winRateA;
    const flag = rear.winRateA > 0.8 ? '  <== KAWALERIA MOŻE BYĆ ZA SILNA Z TYŁU' : '';
    console.log(`CAVALRY vs ${t}: czoło ${pct(front.winRateA)} -> tył ${pct(rear.winRateA)} (różnica ${swing >= 0 ? '+' : ''}${(swing * 100).toFixed(1)}pp)${flag}`);
  }

  console.log('\n--- Starcia mieszane ---');
  for (const r of mixedResults) {
    console.log(`${r.name}: mieszana ${pct(r.winRateA)} / czysta piechota ${pct(r.winRateB)} / remis ${pct(r.drawRate)} / śr. obrażenia na jednostkę: mieszana ${r.avgDmgPerUnitA.toFixed(1)}, piechota ${r.avgDmgPerUnitB.toFixed(1)}`);
  }

  console.log('\n--- Załamania morale: starcia FRONTALNE vs OKRĄŻENIE ---');
  for (const { defenderType, attackerType } of moraleScenarios) {
    const frontal = moraleResults.find((r) => r.defenderType === defenderType && r.attackerType === attackerType && r.scenario.startsWith('FRONTALNE'));
    const encircled = moraleResults.find((r) => r.defenderType === defenderType && r.attackerType === attackerType && r.scenario.startsWith('OKRĄŻENIE'));
    console.log(`${defenderType}: frontalne ${pct(frontal.routRate)} złamań (śr. czas ${frontal.avgDuration.toFixed(1)}s) | okrążenie ${pct(encircled.routRate)} złamań (śr. czas ${encircled.avgDuration.toFixed(1)}s)`);
  }
  const overallFrontalRoutRate = mean(moraleResults.filter((r) => r.scenario.startsWith('FRONTALNE')).map((r) => r.routRate));
  const overallEncircledRoutRate = mean(moraleResults.filter((r) => r.scenario.startsWith('OKRĄŻENIE')).map((r) => r.routRate));
  const overallDuelDuration = mean(moraleResults.map((r) => r.avgDuration));
  console.log(`\nŚredni czas trwania starcia (wszystkie duele): ${overallDuelDuration.toFixed(1)}s`);
  console.log(`Średni % starć FRONTALNYCH kończących się załamaniem morale: ${pct(overallFrontalRoutRate)} (oczekiwane: bardzo niski)`);
  console.log(`Średni % starć z OKRĄŻENIEM kończących się załamaniem morale: ${pct(overallEncircledRoutRate)} (oczekiwane: wyraźnie wyższy)`);

  console.log('\n--- Błędy konsoli w trakcie symulacji ---');
  console.log(consoleErrors.length ? JSON.stringify(consoleErrors) : '(brak)');

  console.log('\n--- Surowe dane (równoliczne, równokosztowe, mieszane) dla dalszej analizy ---');
  console.log(JSON.stringify({ equalCount, equalCost, terrainResults, mixedResults, flankResults, moraleResults }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
