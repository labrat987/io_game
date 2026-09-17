# Projekt: gra .io typu RTS (roboczo: WarConvoy)

## Czym jest ta gra
Przeglądarkowa gra .io łącząca mechaniki War Dots (ruch jednostek rysowany 
liniami, teren wpływa na przemieszczanie) z OpenFront.io (ekonomia oparta 
na konwojach między miastami).

## Decyzje projektowe (NIE zmieniaj ich bez pytania)
- Lobby: 2-4 graczy
- Miasta: predefiniowane na mapie, gracze ich NIE budują
- Ekonomia: wyłącznie konwoje między miastami. BRAK pasywnego dochodu 
  (bez kopalń) — aktywna gra konwojami to rdzeń projektu
- Teren: pole (normalna prędkość), las (spowolnienie), góry (nieprzechodnie), 
  woda (nieprzechodnie)
- 5 typów jednostek: łucznicy (dystans lekki), działa (dystans ciężki), 
  piechota lekka, piechota ciężka, kawaleria (szybka, flankowanie)

## System jednostek (rewizja — ZASTĘPUJE wcześniejszy system counterów)
Gra opiera się na automatycznej walce i linii frontu — gracz nie wybiera,
kto z kim walczy, więc klasyczny system counterów (RPS) nie pasuje.
Jednostki różnicujemy zamiast tego przez:

1. **Macierz teren × typ jednostki** — wpływa na PRĘDKOŚĆ i OBRAŻENIA
   (nie tylko prędkość). Np. jednostki ciężkie skuteczne na otwartym
   polu, tracące przewagę w lesie.
2. **Zasięg projekcji siły** — kluczowy nowy wymiar. Jednostki dystansowe
   (łucznicy, działa) rzutują siłę na większy promień niż jednostki
   walczące wręcz, ale są słabe w bezpośrednim kontakcie. Efekt:
   artyleria z tyłu wypycha linię frontu, kawaleria służy do rajdów na nią.
3. **Koszt, prędkość, HP** — jak wcześniej.

## Mechaniki do zaimplementowania później (zainspirowane War of Dots)
- Limit zaopatrzenia: każde miasto utrzymuje określoną liczbę jednostek;
  nadmiarowe jednostki bez zaopatrzenia tracą życie. Ogranicza snowball
  i liczbę encji na serwerze.
- Upkeep: każda jednostka kosztuje utrzymanie na sekundę — armia musi
  być opłacana z dochodu z konwojów.
- Leczenie z dala od frontu: jednostki regenerują się poza strefą walki,
  szybciej na miastach. Wymusza rotację oddziałów.
- Miasta rzutują dużą siłę — uniemożliwia przejęcie miasta pojedynczą
  jednostką prześlizgującą się przez front.
- Produkcja przez suwaki (tempo produkcji + proporcja typów jednostek),
  nie klikanie pojedynczych jednostek.

## Wymóg techniczny walki (KRYTYCZNE)
Obrażenia w starciu muszą być liczone JEDNOCZEŚNIE dla wszystkich
uczestników w jednym kroku symulacji, nigdy sekwencyjnie w pętli po
jednostkach. Sekwencyjne liczenie tworzy eksploit, w którym jednostka
atakująca jako druga nie otrzymuje obrażeń (znany błąd w War of Dots).

## Zasady techniczne
- Wszystkie statystyki jednostek i parametry balansu TRZYMAJ W OSOBNYM 
  PLIKU KONFIGURACYJNYM (JSON/JS config), nigdy zahardkodowane w logice
- Prototyp: vanilla JS + canvas, jeden plik, bez frameworków, bez build stepu
- Docelowy backend: Cloudflare Workers + Durable Objects (jeden pokój gry 
  = jeden Durable Object, WebSocket)

## Jak ze mną pracować
- Jestem game designerem BEZ doświadczenia w programowaniu — wyjaśniaj 
  decyzje techniczne prostym językiem
- Zawsze najpierw przedstaw plan, czekaj na akceptację, dopiero potem koduj
- Nie dodawaj funkcji, o które nie prosiłem (bez scope creep)
- Kolejność budowy: 1) prototyp ruchu lokalnie → 2) ekonomia konwojów → 3) dopiero multiplayer