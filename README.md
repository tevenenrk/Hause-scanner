# Hause Scanner

Skan mieszkania goglami **Meta Quest 3 / 3S** prosto z przeglądarki (WebXR), z którego powstaje **edytowalna makieta 3D z ruchomymi meblami**. Przesuwasz meble i sprawdzasz, czy się zmieszczą. Robisz to na komputerze albo w mieszanej rzeczywistości, w skali 1:1, na tle prawdziwego pokoju.

Bez instalacji i bez budowania. To statyczna strona: HTML, JS i dołączona lokalnie biblioteka Three.js.

## Co potrafi

**Skan (na Queście)**
- odczytuje pokój z systemowej **Konfiguracji przestrzeni (Space Setup)**: podłogę, ściany, sufit, drzwi, okna i meble,
- **pokazuje na żywo trójkąty skanu** (siatkę Space Setup), płaszczyzny i bryły mebli. Tam, gdzie nie ma trójkątów, pokój nie jest zeskanowany,
- działa w trybie **bez granicy** (przestrzeń `unbounded` przeglądarki Questa), więc możesz chodzić po mieszkaniu. Gdy gogle go nie udostępnią, aplikacja wraca do zwykłego trybu z granicą,
- zamienia skan na prosty model: obrys pokoju, wysokość, otwory i meble jako bryłki,
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
- miarka, cofnij i ponów, widok 3D i z góry, eksport **JSON** (projekt) oraz **GLB** (model 3D, np. do Blendera).

**Edycja w MR (na Queście)**
- model nakłada się na prawdziwy pokój (dopasowanie po podłodze ze Space Setup) z możliwością ręcznego wyrównania,
- chwytanie mebli promieniem kontrolera albo szczypnięciem, obrót gałką,
- panel 3D: obrót, wymiary ±1/±5 cm, dosuwanie do ściany, typ, **scalanie** („Scal z…”, potem wskazujesz drugą bryłę), duplikowanie, ukrywanie, usuwanie, cofanie, dodawanie mebli,
- **🏠 Makieta w goglach**: miniatura mieszkania przed Tobą. Gałka obraca (lewo/prawo) i skaluje (góra/dół), spust na podłodze makiety ją przesuwa, a meble chwytasz i przesuwasz także w miniaturze,
- trójkąty skanu na żywo (można wyłączyć),
- **pełne parametry w goglach** („Więcej…”): kształt, wysokość nad podłogą, przesuwanie o 1 cm, kolor, „Jak w skanie”, potwierdzenie, rozdzielanie brył, wolne miejsce wokół (linie z odległościami), lista ukrytych mebli, wersje układu.

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

Do adresu dodaj `?emulate=office_small` (albo `living_room`, `meeting_room`). Uruchomi się emulator Meta Quest 3 (IWER) z prawdziwymi skanami pokoi z Questa. Przyciski 🥽 działają wtedy na komputerze, a panel emulatora pozwala sterować kontrolerami.

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
