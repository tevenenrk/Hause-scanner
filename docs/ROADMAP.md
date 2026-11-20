# Plan rozwoju (zapamiętane założenia)

Cel końcowy: **cały skan mieszkania → czysta makieta 3D z teksturami i ruchomymi meblami**, które można przesuwać (na PC i w MR na Queście), z możliwością ręcznej korekty błędów skanu. Nie musi to być jeden program, tylko kilka narzędzi połączonych w łańcuch.

## Etap 1 — zrobione (ta wersja)
- [x] Odczyt pokoju ze Space Setup na Quest 3/3S w przeglądarce (WebXR `plane-detection` + `mesh-detection`).
- [x] Konwersja na uproszczony model: obrys, wysokość, drzwi, okna, meble jako bryłki (prostopadłościan / L / walec).
- [x] „Dopytywanie” bez AI: po skanie aplikacja pokazuje każdy wykryty przedmiot i pyta „Co to jest?” (w MR i na PC).
- [x] Edytor na PC: przesuwanie, obrót, wymiary, usuwanie, ukrywanie (meble tymczasowe), duplikowanie, kolizje, strefy drzwi, odległości do ścian, miarka, cofnij/ponów.
- [x] Korekta skanu: narożniki, długości ścian, przesuwanie ścian, drzwi i okna, wysokość pokoju, podgląd siatki ze skanu.
- [x] Edycja w MR 1:1: chwytanie mebli promieniem/szczypnięciem, obrót gałką, panel 3D, wyrównanie modelu do pokoju.
- [x] Wiele pokoi w jednym projekcie + ręczne układanie pokoi w mieszkanie (tryb „Pokoje”); przenoszenie mebla między pokojami.
- [x] Automatyczne dopasowanie sąsiedniego pokoju, jeśli Quest w tej samej sesji udostępnia podłogi kilku pokoi.
- [x] Eksport JSON (pełny projekt) i GLB (model 3D do Blendera itp.), import pokoi z pliku.
- [x] Podgląd trójkątów skanu (siatka Space Setup) na żywo podczas skanowania i edycji w MR.
- [x] Tryb bez granicy (`unbounded`) z powrotem do `local-floor`; nakładka chowa się przy oknach systemowych.
- [x] Makieta: na PC widok „🏠 Makieta”, w goglach miniatura mieszkania (obrót, skala, przesuwanie, edycja mebli w miniaturze).
- [x] Scalanie brył jako suma (kształt złożony, kolizje per bryła), także na etapie „Co to jest?”; rozdzielanie.
- [x] Gotowy model w pełnym VR: makieta + spacer 1:1 z chodzeniem gałką, pełne parametry mebli w panelu gogli.
- [x] Wersje układu (alternatywne przemeblowania) na PC i w goglach.
- [x] Wiele pokoi w Space Setup: zapis pokoju, w którym stoisz, albo wszystkich naraz (z ułożeniem); odrzucanie brył wielkości pokoju i siatek innych pokoi; scalanie zdublowanych drzwi.
- [x] Łączenie drzwi między pokojami (ustawia pokoje względem siebie).
- [x] Makieta: chwytanie ręką (grip / szczypnięcie), skalowanie dwiema rękami.
- [x] Kształt ze skanu (mapa wysokości z trójkątów → bryła złożona) jako alternatywa dla prostopadłościanu.
- [x] Wybór przy skanie: zapisany skan z gogli albo skan od nowa.
- [x] Wygląd w goglach: ściany/meble pełne, półprzezroczyste (regulowane krycie) lub krawędzie; wygląd per mebel.
- [x] Uchwyty zmiany wymiarów w goglach, ±10 cm, miarka w goglach, „Nowa bryła”.
- [x] Spacer wirtualny także w MR, teleport jak w grach VR.
- [x] Zdjęcia i link przy meblach, kamery zdjęć z dopasowaniem widoku, paczka ZIP dla AI (zdjęcie + render z tej samej kamery).
- [x] Strzałka wskazująca pytany mebel (gogle i PC) i kontrola kompletności skanu (dziury, brakujące ściany, podejrzane meble).
- [x] Etap 2 odświeżenia: ekran startowy (tryb + wersja), menu z zakładkami, kolory jako próbki, edycja ścian w goglach.
- [ ] Etap 3: zdjęcia z gogli (kamera Questa) z pozycją kamery.
- [ ] Etap 4: odświeżenie interfejsu na PC.
- [ ] Łączenie drzwi także w goglach (na razie na PC).

## Etap 2 — całe mieszkanie
- [ ] Sprawdzić na prawdziwym Queście 3S, czy Space Setup udostępnia w przeglądarce kilka pokoi naraz (multi-room). Jeśli tak — skan całego mieszkania w jednej sesji i automatyczne ułożenie.
- [ ] Sprawdzić na Queście 3S, czy `unbounded` usuwa prośbę o strefę i czy podłoga (y) jest poprawna w tym trybie.
- [ ] Jeśli nie — pokój po pokoju + półautomatyczne łączenie: przyciąganie pokoi po wspólnych drzwiach / równoległych ścianach (grubość ściany jako parametr).
- [ ] Synchronizacja projektu między Questem a PC bez ręcznego eksportu (np. link/QR + prosty serwer albo GitHub Gist — do decyzji ze względu na prywatność).

## Etap 3 — mapa z robota sprzątającego + Claude
- [ ] Import mapy z robota (eksport PNG z aplikacji producenta albo mapa z Valetudo/JSON).
- [ ] Wysłanie do Claude: mapa robota + eksport JSON projektu (obrysy pokoi) → Claude porównuje, wskazuje rozbieżności (np. brakujący róg, przesunięta ściana), proponuje skorygowany plan mieszkania jako JSON w formacie projektu.
- [ ] Import poprawionego planu do edytora (jako nowa wersja, z możliwością porównania).
- Uwaga: mapa robota jest 2D i widzi tylko podłogę pod meblami do wysokości robota — dobrze uzupełnia skan Questa (obrys), ale nie zastąpi wysokości ani mebli.

## Etap 4 — zdjęcia i tekstury
- [x] Zdjęcia mebli i zdjęcia pomieszczeń z pozycją kamery (PC) + paczka dla AI.
- [ ] Zdjęcia robione w goglach: z telefonu albo automatycznie w trakcie skanu przez WebXR `camera-access` (działa w projekcie `tevenenrk/room-scanner`: `src/photo-capture.js` i `src/photo-texture.js`, do przeniesienia).
- [ ] Claude (vision) rozpoznaje materiały i kolory: ściany, podłoga (panele / płytki), fronty mebli → przypisanie materiałów do elementów modelu.
- [ ] Tekstury: kafelkowalne tekstury podłóg/ścian (generowane lub z biblioteki PBR), kolor/tekstura mebli na podstawie zdjęć.
- [ ] Opcjonalnie: dokładniejsze modele wybranych mebli (fotogrametria / Gaussian splatting z telefonu) wstawiane w miejsce bryłek.
- [ ] Eksport makiety z teksturami (GLB).

## Etap 5 — AI w trakcie skanu (wersja natywna lub gdy przeglądarka udostępni kamerę)
- [ ] Klatka z kamery → model wizyjny → automatyczna propozycja typu mebla i pytanie tylko przy niepewności.
- [ ] Rozpoznawanie konkretnych modeli (np. IKEA) i podstawianie dokładnych wymiarów.

## Znane ograniczenia
- Quest 3S nie ma czujnika głębi — dokładność rzędu kilku cm. Krytyczne wymiary warto wpisać z miarki.
- Space Setup modeluje meble jako prostopadłościany; kształty L/okrągłe trzeba ustawić ręcznie w edytorze.
- Projekty są zapisywane lokalnie w przeglądarce (IndexedDB) — osobno na Queście i na PC; przenoszenie przez eksport/import JSON.
