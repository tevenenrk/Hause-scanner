# Hause Scanner

Skan mieszkania goglami **Meta Quest 3 / 3S** prosto z przeglądarki (WebXR), z którego powstaje **edytowalna makieta 3D z ruchomymi meblami**. Przesuwasz meble i sprawdzasz, czy się zmieszczą. Robisz to na komputerze albo w mieszanej rzeczywistości, w skali 1:1, na tle prawdziwego pokoju.

Bez instalacji i bez budowania. To statyczna strona: HTML, JS i dołączona lokalnie biblioteka Three.js.

## Co potrafi

**Skan (na Queście)**
- odczytuje pokój z systemowej **Konfiguracji przestrzeni (Space Setup)**: podłogę, ściany, sufit, drzwi, okna i meble,
- na starcie pyta: **użyć skanu zapisanego w goglach** czy **zeskanować od nowa** (Space Setup jest ustawieniem Questa wspólnym dla wszystkich projektów, więc bez tego nowy projekt dostawał stary skan),
- **kontrola skanu**: jeszcze przed zapisem sprawdza, czy skan jest kompletny i sensowny. Wykrywa niezeskanowane miejsca (czerwone kafelki na podłodze), brak podłogi, sufitu i ścian, ściany obrysu bez zeskanowanej ściany, dziwną wysokość lub powierzchnię, brak drzwi i zbyt szerokie drzwi, meble wiszące w powietrzu, wystające za ścianę, zdublowane, malutkie (szum) albo wielkości pokoju. Kliknięcie uwagi o meblu wskazuje go strzałką. Ta sama kontrola jest w goglach („✔ Kontrola”) i na PC (karta „Kontrola skanu”),
- przy „Co to jest?” nad pytanym meblem **podskakuje strzałka**, od panelu biegnie do niego linia, a bryła pulsuje. Gdy mebel jest poza wzrokiem, przed oczami pojawia się strzałka kierunku. Na PC też jest strzałka,
- **pokazuje na żywo trójkąty skanu** (siatkę Space Setup), płaszczyzny i bryły mebli. Tam, gdzie nie ma trójkątów, pokój nie jest zeskanowany,
- działa w trybie **bez granicy** (przestrzeń `unbounded` przeglądarki Questa), więc możesz chodzić po mieszkaniu. Gdy gogle go nie udostępnią, aplikacja wraca do zwykłego trybu z granicą,
- zamienia skan na prosty model: obrys pokoju, wysokość, otwory i meble jako bryłki,
- **wiele pokoi**: gdy Space Setup zawiera kilka pokoi, zapisujesz **pokój, w którym stoisz** (bez ścian, mebli i siatki sąsiednich) albo **wszystkie pokoje naraz**, ułożone względem siebie tak jak w rzeczywistości. Pokój zapisany wcześniej nie jest dublowany, a reszta układa się względem niego. Bryły wielkości całego pokoju (siatki innych pokoi) są odrzucane, a zdublowane drzwi na tej samej ścianie scalane,
- przy każdym meblu wybierasz **prostopadłościan** albo **kształt ze skanu**: uproszczoną bryłę z trójkątów skanu, np. kanapa jako siedzisko, podłokietniki i oparcie,
- po zapisie **dopytuje**, co to za przedmiot („Co to jest? Stół / Kanapa / …”), i pozwala oznaczyć mebel jako tymczasowy albo usunąć go. Już na tym etapie możesz **scalić bryły** („Scal z inną bryłą”), jeśli skaner podzielił jeden mebel na kilka.

**Edytor (PC lub przeglądarka Questa)**
- przesuwanie mebli myszą (przyciąganie do ścian), obrót, zmiana wymiarów, kształty: prostopadłościan, L (narożnik) i walec,
- **scalanie brył jako suma** (jak sumowanie boolowskie): scalone bryły tworzą jeden mebel o złożonym kształcie. Każda bryła zachowuje swój kształt i wysokość, całość przesuwa się i obraca razem, a kolizje liczone są dla każdej bryły osobno. „✂ Rozdziel bryły” cofa scalenie. Scalasz przez „⧉ Scal z…” albo Shift/Ctrl + klik,
- **wersje układu**: alternatywne przemeblowania tego samego mieszkania („+ Nowa wersja” kopiuje bieżący układ). Przełączasz je listą po lewej albo w goglach,
- **🏠 Makieta**: widok całego mieszkania z pełnymi ścianami, który sam się obraca (myszą obracasz i przybliżasz),
- **kolizje**: czerwony = mebel nachodzi na inny mebel lub wystaje za ścianę, pomarańczowy = stoi w strefie otwierania drzwi,
- **wolne miejsce wokół** zaznaczonego mebla (ile cm do ściany lub do najbliższego mebla),
- przerywany obrys pokazuje, gdzie mebel stał w skanie („↺ Jak w skanie” przywraca tę pozycję),
- **korekta błędów skanu**: narożniki, długości ścian, przesuwanie ścian, drzwi i okna, wysokość, podgląd siatki 3D ze skanu,
- wiele pokoi w jednym projekcie i układanie ich w mieszkanie; mebel przeciągnięty do innego pokoju zmienia przynależność,
- **łączenie drzwi między pokojami**: w trybie „Ściany” zaznacz drzwi i wybierz „🔗 Połącz z drzwiami innego pokoju”, potem kliknij drzwi w drugim pokoju. Tamten pokój ustawi się po drugiej stronie ściany (grubość do ustawienia). Zbędne drzwi (np. otwarte skrzydło rozpoznane jako drugie drzwi) usuwasz przyciskiem „Usuń”,
- miarka, cofnij i ponów, widok 3D i z góry, eksport **JSON** (projekt) oraz **GLB** (model 3D, np. do Blendera).

**Menu w goglach**
- Po wejściu („Edytuj w MR” albo „Makieta VR”) pojawia się **ekran startowy**. Wybierasz na nim **wersję układu mebli** (albo tworzysz nową jako kopię) i **tryb**: 🏠 *Jestem w mieszkaniu* (model na prawdziwych pokojach), 🧱 *Makieta* albo 🚶 *Spacer wirtualny*.
- Potem menu ma zakładki: **Tryb** (przełączanie trybów, wyrównanie, sterowanie makietą i spacerem), **Meble** (nowa bryła, katalog, „Do potwierdzenia”, ukryte), **Ściany**, **Widok**, **Narzędzia** (miarka, kontrola skanu, ekran startowy) i **Wersje**. Na dole każdej zakładki są „Cofnij”, „Ponów” i „Zapisz i wyjdź”.
- **Ściany w goglach**: w zakładce „Ściany” meble są zablokowane. Wskazujesz ścianę spustem i ciągniesz, żeby ją przesunąć (np. gdy skaner wziął zabudowaną szafę za ścianę). Są też przyciski ±1 i ±5 cm, „+ Drzwi tutaj”, „+ Okno tutaj” i zmiana wysokości pokoju.
- Kolory mebli wybierasz z **kolorowych próbek** (bez kodów).

**Edycja w MR (na Queście)**
- model nakłada się na prawdziwy pokój (dopasowanie po podłodze ze Space Setup) z możliwością ręcznego wyrównania,
- chwytanie mebli „na kiju”: mebel trzyma się końca promienia. Gałka przód/tył odsuwa go i przybliża, gałka w bok obraca. Mebel stojący przykleja się do podłogi i dosuwa do ścian, a **wiszący** (np. telewizor, szafka wisząca) przykleja się tyłem do ściany i jedzie wzdłuż niej, gałka przód/tył zmienia wtedy wysokość. Mocowanie przełączasz w panelu mebla: „Stoi na podłodze” albo „Wisi na ścianie”,
- panel 3D: obrót, wymiary ±1/±5 cm, dosuwanie do ściany, typ, **scalanie** („Scal z…”, potem wskazujesz drugą bryłę), duplikowanie, ukrywanie, usuwanie, cofanie, dodawanie mebli,
- **🏠 Makieta w goglach**: miniatura mieszkania przed Tobą. **Grip** (albo szczypnięcie poza meblem) chwyta makietę ręką: przenosisz ją i obracasz. **Obie ręce naraz**: rozsuwanie dłoni powiększa, zsuwanie zmniejsza. Gałka też obraca i skaluje. Meble chwytasz i przesuwasz także w miniaturze,
- trójkąty skanu na żywo (można wyłączyć),
- **👁 Wygląd**: ściany wyłączone, tylko krawędzie, półprzezroczyste (krycie 10–75%) albo pełne; meble jako bryły (krycie 20–100%) albo krawędzie; podłoga wł./wył. W MR domyślnie ściany są półprzezroczyste, a meble pełne. Każdy mebel ma własny wygląd (normalny / półprzezroczysty / krawędzie / ukryty),
- **zmiana wymiarów uchwytami**: zaznaczony mebel ma trzy kulki: czerwoną (szerokość), niebieską (głębokość) i zieloną (wysokość). Chwyć spustem i ciągnij, a przeciwległa ściana bryły zostaje w miejscu. Do tego przyciski ±1 / ±5 / ±10 cm,
- **📏 Miarka**: dwa punkty spustem (mebel, ściana, podłoga, trójkąty skanu). W makiecie mierzy w prawdziwej skali,
- **+ Nowa bryła**: prostopadłościan do budowania nowych elementów; bryły sklejasz „Scal z…” (suma brył),
- **🚶 Spacer wirtualny**: także w MR. Chodzisz po makiecie jak w grach VR (lewa gałka: ruch, prawa: obrót o 30°, prawa do przodu: teleport). „Wróć do 1:1 w pokoju” ponownie nakłada model na prawdziwe mieszkanie,
- **pełne parametry w goglach** („Więcej…”): kształt, wysokość nad podłogą, przesuwanie o 1 cm, kolor, „Jak w skanie”, potwierdzenie, rozdzielanie brył, wolne miejsce wokół (linie z odległościami), lista ukrytych mebli, wersje układu.

**Zdjęcia, kamery i paczka dla AI (PC)**
- do każdego mebla możesz przypiąć **zdjęcia** i **link** (np. do sklepu). Mebel, którego jeszcze nie ma, to nowa bryła ze zdjęciem; w paczce dla AI ma status „nowy / planowany”,
- **📷 + Zdjęcie pomieszczenia** tworzy na makiecie **kamerę** (różowy ostrosłup). W trybie „Dopasuj widok do zdjęcia” zdjęcie leży półprzezroczyście na makiecie, a Ty ustawiasz widok i kąt widzenia, aż bryły pokryją się ze zdjęciem. Pozycja kamery jest zapisywana,
- **Plik → Eksport: paczka dla AI (ZIP)**: `README_dla_AI.md` (polecenie i opis), `scena.json`, plan z góry, widok 3D, każde zdjęcie pomieszczenia razem z **renderem makiety z tej samej pozycji kamery**, zdjęcia mebli, `model.glb`, projekt. Paczkę wrzucasz do AI (np. Claude), żeby zrobiła dokładniejszą makietę albo wizualizację, wiedząc, gdzie co stoi i jak wygląda.

**Gotowy model w VR (bez bycia w mieszkaniu)**
- przycisk **🥽 Makieta VR** otwiera pełny VR z gotowym modelem: najpierw makieta przed Tobą,
- **🚶 Spacer 1:1**: wybierasz pokój i chodzisz po wirtualnym mieszkaniu (lewa gałka: chodzenie, prawa: obrót o 30°),
- przemeblowanie działa wszędzie tak samo: w makiecie, na spacerze w VR i w MR w prawdziwym mieszkaniu. Zmiany trafiają do aktywnej wersji układu.

## Jak uruchomić

WebXR wymaga **HTTPS**. Najprościej użyć GitHub Pages:

1. W repozytorium na GitHubie: **Settings → Pages → Source: Deploy from a branch**, wybierz gałąź i katalog `/ (root)`.
2. Po chwili strona będzie pod adresem `https://<użytkownik>.github.io/<repozytorium>/`.
3. Otwórz ten adres w **przeglądarce Meta Quest** (oraz na komputerze, jeśli chcesz edytować na PC).

Lokalnie na komputerze (sam edytor, bez XR):

```bash
python3 -m http.server 8080
```

Potem otwórz `http://localhost:8080`.

## Jak używać na Queście 3S

1. **Ustawienia → Środowisko fizyczne → Konfiguracja przestrzeni**: zeskanuj pokój i zaznacz meble (stół, kanapa, szafka…). Od jakości tego kroku zależy wynik.
2. Otwórz stronę w przeglądarce Questa → **+ Nowy projekt**.
3. **🥽 Skanuj pokój**: zezwól na dostęp do danych przestrzennych. Panel pokaże, ile ścian i mebli wykryto, a w pokoju zobaczysz obrys i bryłki.
4. **Zapisz pokój**: aplikacja zapyta o każdy przedmiot („Co to jest?”). Wskazuj promieniem i klikaj spustem (albo szczypnięciem).
5. Przesuwaj meble (trzymaj spust na meblu), obracaj gałką, a na koniec wybierz **Zapisz i wyjdź**.
6. Kolejny pokój: przejdź do niego, zrób dla niego Space Setup i znowu **Skanuj pokój**. W edytorze, w trybie **Pokoje**, ułożysz pokoje względem siebie.

**Grip** (przycisk chwytu) przywołuje panel przed oczy.

### Granica (strefa stacjonarna / całopokojowa)

Aplikacja prosi przeglądarkę o przestrzeń **bez granicy** (`unbounded`). Panel skanu pokazuje, który tryb jest aktywny („Tryb bez granicy” albo „Przestrzeń: local-floor”).

- Jeśli Quest mimo to prosi o strefę, wybierz **całopokojową**. Najpewniej jest jednak wykonać **Konfigurację przestrzeni w Ustawieniach gogli przed otwarciem strony**. Tam system pokazuje własną animację skanowania (trójkąty) i rysowanie granicy działa normalnie.
- Gdy system wyświetla własne okno (Space Setup, granica, menu), aplikacja chowa swoją nakładkę, żeby niczego nie zasłaniać.
- Klasyczny tryb z granicą możesz wymusić, dodając `?bounded` do adresu.

### Przeniesienie projektu Quest ↔ PC

Projekty są zapisywane w przeglądarce danego urządzenia. Aby edytować na komputerze projekt zeskanowany na Queście:

1. Na Queście użyj **Plik → Eksport: projekt (JSON)**.
2. Przenieś plik (kabel USB, chmura, e-mail).
3. Na PC użyj **Importuj plik…** na ekranie startowym albo **Plik → Import JSON** w edytorze. Ta druga opcja dołącza pokoje do bieżącego projektu.

## Test bez gogli (emulator)

Do adresu dodaj `?emulate=office_small` (albo `living_room`, `meeting_room`, `two_rooms` — test dwóch pokoi w jednym Space Setup). Uruchomi się emulator Meta Quest 3 (IWER) z prawdziwymi skanami pokoi z Questa. Przyciski 🥽 działają wtedy na komputerze, a panel emulatora pozwala sterować kontrolerami.

## Testy

```bash
npm test
```

Uruchamia testy jednostkowe geometrii, kolizji i konwersji skanu (Node 18+, bez zależności).

## Struktura

| Plik | Rola |
|---|---|
| `index.html`, `css/app.css` | interfejs |
| `src/main.js` | ekran projektów, routing, uruchamianie XR |
| `src/editor.js` | edytor 3D na PC |
| `src/roomView.js` | budowanie sceny 3D z modelu (wspólne dla PC i MR) |
| `src/xr/xrApp.js` | sesja WebXR: skan, „Co to jest?”, edycja w MR, wyrównanie |
| `src/xr/sceneCapture.js` | odczyt płaszczyzn i siatek ze Space Setup |
| `src/xr/ui3d.js` | panel 3D sterowany promieniem |
| `src/scanConvert.js` | konwersja danych Questa na model pokoju |
| `src/geometry.js` | geometria: kolizje, przyciąganie, edycja ścian |
| `src/model.js` | model danych, historia zmian, import i eksport |
| `src/store.js` | zapis w IndexedDB |
| `vendor/` | Three.js r180 i IWER (MIT), dołączone lokalnie |
| `dev/captures/` | przykładowe skany z Questa do emulatora (z pakietu `@iwer/sem`, MIT) |

## Ograniczenia

- Quest 3S nie ma czujnika głębi, więc wymiary mają dokładność rzędu kilku cm. Krytyczne wymiary (wnęka, szafa) wpisz z miarki.
- Space Setup opisuje meble jako prostopadłościany. Kształty L i okrągłe ustawisz w edytorze.
- Przeglądarka nie daje dostępu do obrazu z kamer, więc rozpoznawanie mebli przez AI wymaga wersji natywnej (plan w `docs/ROADMAP.md`).

Plan dalszych etapów (całe mieszkanie, mapa z robota sprzątającego, zdjęcia, tekstury) jest w [`docs/ROADMAP.md`](docs/ROADMAP.md).
