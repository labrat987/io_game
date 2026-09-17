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

## System counterów jednostek
- Łucznicy > piechota lekka | słabi vs kawaleria
- Działa > skupione grupy, piechota ciężka | słabe vs kawaleria
- Piechota lekka > łucznicy | słaba vs piechota ciężka
- Piechota ciężka > kawaleria, piechota lekka | słaba vs działa
- Kawaleria > łucznicy, działa | słaba vs piechota ciężka

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