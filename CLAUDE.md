# Projekt: gra .io typu RTS (roboczo: WarConvoy)

## Czym jest ta gra
Przeglądarkowa gra .io łącząca mechaniki War Dots (ruch jednostek rysowany
liniami, teren wpływa na przemieszczanie) z OpenFront.io (ekonomia oparta
na konwojach między miastami).

## Decyzje projektowe (NIE zmieniaj ich bez pytania)
- Lobby: 2-4 graczy
- Miasta: predefiniowane na mapie, gracze ich NIE budują

(Teren i typy jednostek — patrz „Ruch i teren” i „System jednostek” niżej.)

## Jak ze mną pracować
- Jestem game designerem BEZ doświadczenia w programowaniu — wyjaśniaj
  decyzje techniczne prostym językiem
- Zawsze najpierw przedstaw plan, czekaj na akceptację, dopiero potem koduj
- Nie dodawaj funkcji, o które nie prosiłem (bez scope creep)

## Terminologia — dwie różne "linie"
- **Linia rozkazu** — krzywa narysowana przez gracza, do której jednostki
  nacierają i na której stają. Tymczasowa, znika po wykonaniu rozkazu.
- **Linia frontu** — emergentna granica między strefami wpływu graczy,
  wynikająca z rozmieszczenia jednostek. Nikt jej nie rysuje, przesuwa się
  sama wraz z ruchem jednostek.

## Sterowanie (rdzeń rozgrywki)
- LPM klik w pustkę = odznacz wszystko; LPM klik w jednostkę = zaznacz
  jedną; Shift+LPM = dodaj do zaznaczenia; LPM przeciągnięcie = prostokąt
  selekcji
- PPM klik = ruch najszybszą trasą; PPM przeciągnięcie OD zaznaczonej
  jednostki = tryb TRASA; PPM przeciągnięcie po pustym terenie = tryb FRONT
- Tryb TRASA: jednostki idą PO NARYSOWANEJ KRZYWEJ, nie najkrótszą drogą.
  A* służy tylko do omijania przeszkód między punktami kontrolnymi. To
  podstawowa mechanika gry.
- Tryb FRONT: jednostki rozstawiają się równomiernie wzdłuż narysowanej
  krzywej, każda idzie do swojego punktu najszybszą trasą. Po dotarciu
  stają.

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
- Prototyp: vanilla JS + canvas, jeden plik, bez frameworków, bez build
  stepu
- Docelowy backend: Cloudflare Workers + Durable Objects (jeden pokój gry
  = jeden Durable Object, WebSocket)

## Ekonomia
- Wyłącznie konwoje między miastami, BRAK pasywnego dochodu z kopalń
- Upkeep: każda jednostka kosztuje utrzymanie na sekundę — armia musi być
  opłacana z handlu
- Limit zaopatrzenia: miasto utrzymuje określoną liczbę jednostek,
  nadmiarowe tracą życie. Ogranicza snowball i liczbę encji na serwerze.
- Leczenie z dala od frontu, szybsze na miastach — wymusza rotację
  oddziałów
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
- Linia rozkazu gruba i czarna, strzałki kierunku
- Paleta graczy kontrastująca z zielenią i szarością terenu: czerwony,
  niebieski, ciemny fiolet, pomarańczowy

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
1. Prototyp ruchu (trasy + fronty) ← obecny etap
2. Siatka terytorium i emergentna linia frontu
3. Mechanika okrążania
4. Przejmowanie miast przez front
5. Ekonomia konwojów + bandyci
6. Multiplayer (Cloudflare Workers + Durable Objects, jeden pokój = jeden
   Durable Object)

## Otwarte decyzje (do rozstrzygnięcia po testach)
- Czy linia frontu ma konsekwencje mechaniczne (bezpieczeństwo konwojów
  po swojej stronie), czy jest tylko wizualizacją?
- Obrona przed bandytami: eskorta konwojów czy patrole w kluczowych
  punktach zaplecza?
- Czy 5 typów jednostek, czy 4?
- Balans przeciwwag okrążania (długość karencji, siła bonusu przebicia)
