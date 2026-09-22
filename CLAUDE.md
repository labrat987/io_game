# Projekt: gra .io typu RTS (roboczo: WarConvoy)

## Filar projektowy: realizm dowodzenia, nie mikrozarządzanie
Gra ma oddawać doświadczenie DOWODZENIA armią na poziomie operacyjnym, nie
kierowania pojedynczymi żołnierzami. Gracz jest sztabem, nie dowódcą
plutonu.

Kryterium rozstrzygające przy każdej nowej mechanice: czy realny dowódca
podjąłby taką decyzję? Jeśli mechanika wymaga klikania w pojedyncze
jednostki w czasie rzeczywistym — prawdopodobnie jest sprzeczna z filarem.

**Konsekwencje:**
- Walka automatyczna, gracz nie kieruje pojedynczymi starciami
- Rozkazy dla artylerii: ostrzał rejonu, nie wskazywanie pojedynczego celu
  (odrzucono model Total War jako sprzeczny z filarem)
- Rozkazy w formie rysowanych linii — analogia mapy sztabowej

**Kandydaci na mechaniki wzmacniające filar** (do rozważenia po grywalnym
rdzeniu):
- Opóźnienie rozkazów — jednostka reaguje z opóźnieniem 1-2s (rozkaz musi
  dotrzeć). Wymusza planowanie zamiast reagowania.
- Morale — jednostki pod ostrzałem, okrążone lub przetrzebione wycofują
  się same, zamiast walczyć do 0 HP
- Ograniczona widoczność (mgła wojny) — decyzje przy niepełnej informacji;
  nadaje sens zwiadowi i kawalerii
- Rozkaz ostrzału rejonu — wskazanie obszaru na mapie, artyleria
  ostrzeliwuje wszystko, co tam wejdzie (na razie priorytety celu
  łucznik/działo przełączane Tab-em w prototypie ruchu są tymczasowym
  substytutem tego rozkazu)

**Konflikt do zarządzania: realizm vs dostępność.** Format .io wymaga
zrozumienia gry w pierwsze 3 minuty. Realistyczne mechaniki (opóźnienie,
mgła, morale) mogą wyglądać dla nowego gracza jak "gra mnie nie słucha".
Zasada: każda taka mechanika musi mieć wyraźną wizualizację (opóźniony
rozkaz rysowany na szaro do momentu aktywacji, widoczny wskaźnik morale).
Realizm, którego gracz nie rozumie, to frustracja, nie głębia.

## Czym jest ta gra
Przeglądarkowa gra .io łącząca mechaniki War Dots (ruch jednostek rysowany
liniami, teren wpływa na przemieszczanie) z OpenFront.io (ekonomia oparta
na konwojach między miastami).

## Decyzje projektowe (NIE zmieniaj ich bez pytania)
- Lobby: 2-4 graczy
- Miasta: predefiniowane na mapie, gracze ich NIE budują
- Kolejność kluczy w `PLAYERS` musi zostać P1→P4 — `ai.js` wiąże się przy
  starcie modułu z pierwszym kluczem różnym od `OWNED_PLAYER`, więc host
  jest zawsze P1, a bot (gdy jest) zawsze P2. Boty dostępne WYŁĄCZNIE w
  lobby 1v1 (tam zawsze jest dokładnie jeden przeciwnik — zgodne z
  założeniem `ai.js`); w Deathmatchu puste miejsca zostają puste.

(Teren i typy jednostek — patrz „Ruch i teren” i „System jednostek” niżej.)

## Jak ze mną pracować
- Jestem game designerem BEZ doświadczenia w programowaniu — wyjaśniaj
  decyzje techniczne prostym językiem
- Zawsze najpierw przedstaw plan, czekaj na akceptację, dopiero potem koduj
- Nie dodawaj funkcji, o które nie prosiłem (bez scope creep)

## Terminologia — "linia frontu" i punkty nawigacyjne
- **Linia frontu** — emergentna granica między strefami wpływu graczy,
  wynikająca z rozmieszczenia jednostek. Nikt jej nie rysuje, przesuwa się
  sama wraz z ruchem jednostek.
- **Punkty nawigacyjne** — dawny tryb TRASA (rysowanie krzywej
  przeciągnięciem) został zastąpiony systemem punktów: Ctrl+PPM dodaje
  kolejny punkt do sekwencji, obowiązuje to samo dla jednostek i dla
  szlaków handlowych (patrz niżej). Punkty są trwałe (nie znikają po
  jednym rozkazie) i grupa/konwój przechodzi przez nie po kolei, bez
  skracania trasy.

## Sterowanie (rdzeń rozgrywki)
- LPM klik w pustkę = odznacz wszystko; LPM klik w jednostkę = zaznacz
  jedną; Shift+LPM = dodaj do zaznaczenia; LPM przeciągnięcie = prostokąt
  selekcji
- PPM klik = ruch najszybszą trasą (kasuje aktywną sekwencję punktów
  nawigacyjnych); PPM przeciągnięcie po pustym terenie = tryb FRONT
- Trasa dla jednostek — DWA równoległe, CELOWO RÓŻNE sposoby wyznaczenia
  (różne mechanizmy pod spodem, nie jedna wspólna logika):
  1. **Ctrl+PPM** na zaznaczonych jednostkach = punkt nawigacyjny, klik
     po kliku (`waypointGroups`). Pierwsze kliknięcie rusza całą grupę
     do punktu 1 dokładnie jak zwykłe PPM (ten sam ścisły "pierścień"
     formationOffsets, ZERO rozsunięcia bocznego). Kolejne Ctrl+kliknięcia
     dopisują następne punkty. Grupa rusza do kolejnego punktu dopiero,
     gdy WSZYSCY żywi członkowie dotarli do bieżącego — nikt nie ucieka
     do przodu, przydatne do przeprowadzenia oddziału przez wąskie
     przejście. Sekwencja nie jest skracana ani prostowana.
  2. **PPM-przeciągnięcie** zaczęte NA zaznaczonej jednostce rysuje
     ciągłą krzywą (żółta, widoczna tylko podczas rysowania) — jak dawny
     tryb TRASA / jak dziś konwoje na szlakach handlowych. Po puszczeniu
     przycisku KAŻDA jednostka wchodzi na tę krzywą w najbliższym dla
     siebie miejscu i podąża nią NIEZALEŻNIE, jednym ciągłym ruchem, BEZ
     czekania na resztę oddziału przy żadnym punkcie — szybsza kawaleria
     nigdy nie stoi, czekając na wolniejszą piechotę. Czekanie na całą
     grupę dotyczy WYŁĄCZNIE Ctrl+PPM (metoda 1).
  Trasa (obu metod) widoczna tylko dla właściciela, dopóki ją wykonuje.
- Szlaki handlowe — TRZY równoległe sposoby, po zaznaczeniu miasta:
  zwykłe PPM na innym własnym mieście = trasa automatyczna (A*);
  Ctrl+PPM = trasa wyznaczona ręcznie punkt po punkcie, kończy ją
  kliknięcie na mieście docelowym; PPM-przeciągnięcie od zaznaczonego
  miasta do innego własnego = trasa narysowaną krzywą (żółta podczas
  rysowania). Konwoje podążają dokładnie wyznaczoną trasą (między
  kolejnymi punktami A* z uwzględnieniem terenu), nie skracają jej.
  Jeden szlak na parę miast — nowy zastępuje stary.
- Punkt (jednostki albo szlaku) wskazany na nieprzechodnim terenie (góry)
  zostaje automatycznie przesunięty na najbliższe dostępne miejsce, z
  krótkim sygnałem wizualnym.
- Tryb FRONT: jednostki rozstawiają się równomiernie wzdłuż narysowanej
  krzywej, każda idzie do swojego punktu najszybszą trasą. Po dotarciu
  stają. Bez zmian względem poprzedniej wersji.
- Tryb online nie ma pauzy — przycisk pauzy/Spacja działają wyłącznie w
  trybie z AI (`config.mode === 'AI'`), w meczu sieciowym są ukryte.

## Ruch i teren
- Pozycje jednostek ciągłe (float), siatka wyłącznie do pathfindingu i
  odczytu terenu
- A* ważony kosztem terenu (koszt = 1/speedMultiplier), wygładzanie
  ścieżki metodą line-of-sight, brak ścinania rogów po skosie
- Prędkości w pikselach na sekundę × dt, dt ograniczone do maks. 0.1s
- Jednostki kolidują ze sobą, nie mogą się nakładać
- Teren: pole (normalna prędkość), las (spowolnienie), woda przechodnia z
  wysoką karą (bardzo wolno + docelowo utrata życia po wprowadzeniu HP),
  góry całkowicie nieprzechodnie
- Jednostka na nieprzechodnim kaflu zawsze może z niego wyjść (zabezpieczenie
  przed zablokowaniem)
- Kotwica pozycji: jednostka bez aktywnego rozkazu (ruch, punkty
  nawigacyjne w toku, wymuszony atak, panika) zapamiętuje miejsce, w
  którym ma stać, i stale do niego wraca, jeśli coś ją stamtąd zepchnie —
  sojusznik przechodzący przez linię ją rozsuwa, ale po utracie kontaktu
  wraca na miejsce; wróg NIE przełamie linii samym naporem, wyłącznie
  zabijając obrońców lub łamiąc ich morale. Nowa kotwica ustawiana jest
  wyłącznie w momencie zakończenia rozkazu (także powrotu z paniki),
  nigdy w trakcie jego wykonywania

## System jednostek — różnicowanie przez pozycję, NIE przez countery
Walka jest automatyczna i pozycyjna, więc klasyczny system rock-paper-scissors
nie działa — gracz nie wybiera, kto z kim walczy. Jednostki różnicujemy przez:

1. **Macierz teren × typ jednostki** wpływająca na prędkość ORAZ obrażenia
   (wzorem War of Dots: jednostki ciężkie skuteczne na otwartym terenie,
   tracące przewagę w lesie)
2. **Zasięg projekcji siły** — kluczowy wyróżnik. Jednostki dystansowe
   (łucznicy, działa) rzutują siłę dalej niż walczące wręcz, ale są słabe
   w kontakcie. Efekt: artyleria z zaplecza wypycha linię frontu, kawaleria
   służy do rajdów na nią.
3. **Koszt, prędkość, HP**

5 typów jednostek: łucznicy (dystans lekki), działa (dystans ciężki),
piechota lekka, piechota ciężka, kawaleria (szybka, flankowanie).

Otwarta kwestia: czy 5 typów jednostek nadal ma sens, czy 4 wystarczy —
piechota lekka i ciężka mogą być redundantne, skoro różnicę niesie teren
i zasięg.

## Terytorium, front i okrążanie (rdzeń gry)
- Jednostki i miasta rzutują siłę na siatkę kafli; kafel należy do gracza
  z największym wpływem
- Przejmowanie miast: gdy front przesunie się tak, że miasto znajdzie się
  w strefie gracza — gracz je zdobywa. Wiąże pozycjonowanie armii z
  ekonomią.
- Okrążanie: flood fill od miast gracza wyznacza obszar zaopatrzony. Grupa
  odcięta od głównej masy tworzy kocioł i traci życie.
- Przeciwwagi (do zbalansowania po testach): karencja ~10-15s przed
  startem strat, bonus do ataku na zewnątrz dla okrążonych, straty
  stopniowe zamiast natychmiastowej śmierci
- Wymóg czytelności: okrążenie MUSI być natychmiast widoczne — pulsujący
  obrys kotła, licznik, wyraźny komunikat
- Flood fill liczony 2-4 razy na sekundę, nie co klatkę
- Miasta rzutują dużą siłę — uniemożliwia przejęcie miasta pojedynczą
  jednostką przemykającą przez front

## KRYTYCZNE — wymóg techniczny walki
Obrażenia w starciu muszą być liczone JEDNOCZEŚNIE dla wszystkich
uczestników w jednym kroku symulacji, NIGDY sekwencyjnie w pętli po
jednostkach. Sekwencyjne liczenie tworzy eksploit, w którym jednostka
atakująca jako druga nie otrzymuje obrażeń (znany błąd w War of Dots).

## Zasady techniczne
- Wszystkie statystyki jednostek i parametry balansu TRZYMAJ W OSOBNYM
  PLIKU KONFIGURACYJNYM (JSON/JS config), nigdy zahardkodowane w logice
- Prototyp: vanilla JS + canvas, jeden plik (`index.html`), bez
  frameworków, bez build stepu. AI (`ai.js`) i sieć (`net.js`) to osobne
  moduły ES, ładowane obok — komunikują się z silnikiem WYŁĄCZNIE przez
  dwa oddzielne mosty (`window.GameAPI` dla AI, `window.EngineNetAPI` dla
  sieci), celowo nierozdzielone, żeby zmiany w jednym nigdy nie mogły
  przypadkiem wpłynąć na drugi.
- Backend: Cloudflare Workers + Durable Objects, DWIE klasy — `LobbyDirectory`
  (jeden, globalny, lista aktywnych lobby, limit 5) i `LobbyRoom` (jeden na
  lobby/mecz, WebSocket przez Hibernation API — połączenia bezczynne nic
  nie kosztują i przeżywają wyładowanie instancji). Backend WYŁĄCZNIE na
  SQLite (jedyna opcja na darmowym planie). Kod: `/server/src/index.js`.

## Ekonomia
- Wyłącznie konwoje między miastami, BRAK pasywnego dochodu z kopalń
- Upkeep: każda jednostka kosztuje utrzymanie na sekundę — armia musi być
  opłacana z handlu
- Limit zaopatrzenia: miasto utrzymuje określoną liczbę jednostek,
  nadmiarowe tracą życie. Ogranicza snowball i liczbę encji na serwerze.
- Leczenie z dala od frontu, szybsze na miastach — wymusza rotację
  oddziałów. Modyfikator pozycyjny bazowego systemu regeneracji
  (`outOfCombatDelay`/`regenPerSecond` w prototypie ruchu — jednostka
  regeneruje się jednakowo wszędzie poza wodą po `outOfCombatDelay`
  sekund bez walki); szybciej-przy-miastach/wolniej-przy-froncie jeszcze
  niezaimplementowane
- Produkcja przez suwaki (tempo + proporcja typów), nie klikanie
  pojedynczych jednostek

## Bandyci (jednostka specjalna, etap 5)
Rozwiązują problem: przy automatycznej walce pozycyjnej regularne
jednostki nie mogą operować za linią frontu, więc konwoje byłyby
nietykalne.

- Ignorują zasady zaopatrzenia i okrążania — to ich główna cecha
- Nie rzutują siły — nie przesuwają frontu, nie zdobywają miast; narzędzie
  wyłącznie ekonomiczne
- Słabi w walce — skuteczni tylko tam, gdzie nie ma obrony
- Przechwytują część ładunku, po napadzie muszą wrócić na własne
  terytorium (okno na reakcję obrońcy)
- Ograniczona widoczność, koszt utrzymania lub limit czasu życia
- Wymóg czytelności: wyraźny komunikat o napadzie z oznaczeniem miejsca.
  Utrata dochodu bez informacji dlaczego = najgorsze możliwe doświadczenie.

## Styl wizualny
- Jednostki jako jednolite koła, kolor = GRACZ (nie typ); typ rozróżniany
  rozmiarem i obrysem
- Teren w płaskich, nasyconych kolorach, bez gradientów i tekstur
- Punkty nawigacyjne (WYŁĄCZNIE Ctrl+PPM — jednostki i ręcznie budowany
  szlak handlowy w trakcie budowania) rysowane jako małe, dyskretne
  kropki (bez numeracji) połączone przerywaną linią w tym samym kolorze
  co podgląd zwykłego marszu — mają wyglądać jak naturalne przedłużenie
  ruchu, nie rzucać się w oczy; osiągnięte punkty wygaszają się (pokazuje
  postęp trasy)
- Trasa jednostki narysowana przeciągnięciem (ciągła krzywa, nie punkty)
  renderuje się w trakcie wykonywania jak zwykły podgląd marszu — zwykła,
  biała linia, bez kropek — bo to fizycznie zwykły `path`, nie sekwencja
  punktów. Ukończony szlak handlowy (dowolną z trzech metod) to zawsze
  ciągła, kolorowa linia w barwie właściciela, też bez kropek.
- Sam GEST rysowania trasy przeciągnięciem (dopóki trzymasz przycisk
  myszy) jest żółty i gruby — wyraźnie widoczny jako aktywna czynność,
  niezależnie od tego, czym się skończy (ciągła trasa jednostki czy
  szlak handlowy)
- Paleta graczy kontrastująca z zielenią i szarością terenu: P1 niebieski
  (`#2f6fed`), P2 czerwony (`#e63946`), P3 ciemny fiolet (`#6f42c1`), P4
  pomarańczowy (`#ff8c1a`); miasta neutralne (bez właściciela) — szary
  (`#9aa0a6`)

## Tryb online (host autorytatywny)
Gra online (lobby, pojedynek 1v1, Deathmatch do 4 graczy) działa w
modelu **host autorytatywny**, prostym językiem:
- Przeglądarka gracza, który założył lobby (host), liczy CAŁĄ symulację —
  dokładnie tę samą, co dziś w grze lokalnej, bez żadnych zmian w logice
  walki/ekonomii/AI.
- Pozostali gracze (klienci) wysyłają WYŁĄCZNIE rozkazy (ruch, trasy,
  front, produkcja, szlaki, ulepszenia) i dostają od hosta obraz gry do
  wyświetlenia — ok. kilkanaście razy na sekundę, wygładzany
  (interpolowany) między odświeżeniami, żeby ruch wyglądał płynnie mimo
  opóźnień sieci. Własny rozkaz gracz widzi na ekranie natychmiast
  (podgląd lokalny), zanim jeszcze host zdąży go faktycznie wykonać.
- Serwer (Cloudflare Workers + Durable Objects) to WYŁĄCZNIE poczekalnia
  lobby i przekaźnik wiadomości — nigdy nie liczy samej gry.
- Prywatność: każdy gracz widzi tylko własne plany (trasy, kolejkę
  produkcji, złoto, szlaki) — dokładnie ta sama zasada "przeciwnik nie
  widzi Twoich zamiarów", co dziś obowiązuje wobec AI.
- Rozłączenie: gracz ma 30s na powrót. Jeśli nie wróci — w 1v1 pozostały
  gracz od razu wygrywa; w Deathmatchu jego miasta stają się neutralne
  (traci ekonomię, ale front i tak może je potem przejąć normalnie), a on
  sam wypada z gry, gdy w efekcie straci wszystkie miasta. Rozłączenie
  hosta kończy mecz dla wszystkich (host liczy jedyną kopię gry).
- Deathmatch jest dziś ograniczony do 2 graczy — mapa ma tylko dwie
  predefiniowane strefy startowe (tę samą, co pojedynek 1v1). Docelowa,
  ręcznie zaprojektowana mapa na 4 strefy startowe to osobna sesja
  projektowa (patrz "Kolejność budowy" niżej) — dopiero po niej
  Deathmatch realnie zagra się w 3-4 osoby.
- Boty — wyłącznie w lobby 1v1 (patrz "Decyzje projektowe" wyżej).

## Priorytety produktowe (ważniejsze niż lista mechanik)
- Pierwsze 3 minuty decydują o wszystkim. Gracz musi wykonać sensowny
  ruch w 10 sekund bez czytania czegokolwiek. Bez samouczka tekstowego —
  nauka przez obserwację konsekwencji.
- Cel nadrzędny: jak najszybciej doprowadzić do stanu, w którym dwie
  osoby rozegrają pełny mecz. Wszystko inne jest wtórne.
- Telemetria od pierwszego dnia multiplayera: czas do wyjścia gracza i w
  której minucie, odsetek dokończonych meczów, win rate i użycie typów
  jednostek, moment najczęstszego porzucenia gry
- Architektura ma przewidzieć: konta graczy, podmienialne kolory/kształty
  jednostek (pod skiny), ranking i profil

## Zasada zakresu
Żadna nowa mechanika nie wchodzi do implementacji, dopóki rdzeń nie jest
grywalny. Test przy każdym pomyśle: czy bez tego dwie osoby mogą rozegrać
mecz? Jeśli tak — na listę, nie do kodu.

## Kolejność budowy
1. Prototyp ruchu (trasy + fronty)
2. Siatka terytorium i emergentna linia frontu
3. Mechanika okrążania
4. Przejmowanie miast przez front
5. Ekonomia konwojów + bandyci
6. Multiplayer (Cloudflare Workers + Durable Objects, jeden pokój = jeden
   Durable Object) — W TRAKCIE BUDOWY. Model host-autorytatywny, lobby,
   1v1 i Deathmatch (patrz "Tryb online" wyżej) zaimplementowane i
   przetestowane; pozostaje wdrożenie na docelowy adres Cloudflare i
   pełny test manualny w kilku oknach przeglądarki.
7. Ręcznie zaprojektowana mapa 4-strefowa pod pełny Deathmatch (osobna
   sesja projektowa — do tego czasu Deathmatch ograniczony do 2 graczy,
   patrz "Tryb online")

## Otwarte decyzje (do rozstrzygnięcia po testach)
- Czy linia frontu ma konsekwencje mechaniczne (bezpieczeństwo konwojów
  po swojej stronie), czy jest tylko wizualizacją?
- Obrona przed bandytami: eskorta konwojów czy patrole w kluczowych
  punktach zaplecza?
- Czy 5 typów jednostek, czy 4?
- Balans przeciwwag okrążania (długość karencji, siła bonusu przebicia)
- **Serwer autorytatywny / ochrona przed oszustwami (ODŁOŻONE)**: dziś
  host liczy grę we własnej, modyfikowalnej przeglądarce — zmodyfikowany
  klient hosta mógłby oszukiwać (np. cofnąć rozkaz, podejrzeć cudze dane
  przed wysłaniem filtra prywatności). Akceptowalne do grania ze
  znajomymi, NIE do rankingu/publicznych meczów. Docelowo cała symulacja
  przenosi się do Durable Object (serwer autorytatywny) — to też jedyny
  sposób, żeby rozłączenie hosta nie kończyło meczu dla wszystkich.
