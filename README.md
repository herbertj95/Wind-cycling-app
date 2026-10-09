# 🚴‍♂️ Wind Cycling App

Wind speed and direction for riding, anywhere in the world: on the map, hour by hour, and along your own route.

The map is the whole screen. The wind is drawn on top of it wherever you take the map, a time bar lets you move through the next two days, and loading a GPX route shows where the wind will push you and where it will slow you down.

---

## ✨ What it does

* **🗺️ Wind map**: the wind moves across the map as white streaks, and arrows carry the speed in km/h. Arrows get longer as the wind gets stronger and always point the way the wind is blowing.
* **🌍 Anywhere**: move the map or use **Search** to find a town, and the forecast follows. Tap any point to read its wind.
* **🧭 Names to find your way**: road numbers and summits with their height from a regional view; zoomed in to street level, street names and landmarks such as monuments, museums, stadiums, viewpoints and stations.
* **📍 Your places**: places are labelled on the map with their current wind. The app starts with nine riding spots around Lisbon (Guincho, Marginal, Sintra, Arrábida and others); save any searched or tapped point with the bookmark in the readout, and remove the ones you do not need.
* **🕒 Time bar**: 48 hours of forecast for the place you are looking at, in the local time of that place, with small arrows above the bars for the way the wind turns and the hours of the clock under them. Drag it or press play. The map follows without reloading.
* **📊 Route analysis**: open your own GPX file from anywhere, or one of the bundled routes around Lisbon. The route is coloured by what the wind does to you: blue pushes, red slows, grey barely matters. Each point is checked at the time you would get there, for the riding speed you choose. Ferry crossings and other gaps in a recording are not counted as ridden.
* **🌧️ Rain**: the hours with rain stand on a teal foot on the time bar, taller the harder it rains. On a wet hour the readout says how hard, how much and how likely ("Light rain, 0.4 mm/h (60% chance)"), and a route says how many kilometres you would ride in the rain leaving when you say, with the profile hatched over those stretches. The map itself stays about the wind.
* **⏰ When to leave**: with a route open, the app works out the ride for every hour it could start at and names the best time today and tomorrow ("Best: today 07:00 to 10:00, tomorrow 08:00"), in daylight. It says whether the headwind comes on the way out or the way home, and when the route is clearly easier ridden the other way round, *Reverse* says so.
* **📏 Measured wind**: in Portugal, the readout shows what the nearest IPMA weather station measured in the last hours next to the forecast ("Measured 18 km/h NW at 09:00, as forecast").
* **🚴 Ride it**: move along the elevation profile, or press *Ride it*, and the rider on the map shows your heading and where the wind hits you.
* **↕️ More map when you want it**: the wind readout, the time bar and the route details each fold away with the small arrow on them, and stay that way until you open them again. Folded, the readout is one line (speed, direction, gusts) and the route keeps its wind as a low red and blue band that you can still drag along.
* **☀️ Day and night map**: a light map for reading in the sun and a dark one for the evening. *Motion* switches the moving wind on and off; the arrows and numbers stay.
* **📡 Works with a weak signal**: the forecast for what you looked at last (your places, the route, that part of the map) is kept on the device. If a download fails, the app says so and keeps showing the saved one. It never invents data.

---

## 🛠️ Technology

* **App**: React 19 + Vite
* **Map**: [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) vector tiles, recoloured in `src/utils/mapStyle.js`. No API key needed.
* **Relief**: Mapzen Terrarium elevation tiles (AWS Open Data)
* **Weather**: [Open-Meteo](https://open-meteo.com) hourly forecast: 10 m wind, temperature, and precipitation with its probability. "Now" is the current minute, blended between the two forecast hours around it; gusts and rain are those of the hour in progress.
* **Place search**: the Open-Meteo geocoding API (names from [GeoNames](https://www.geonames.org/))
* **Measured wind**: the open data of [IPMA](https://api.ipma.pt/), the weather service of Portugal: the surface observations of its stations, one file for the whole country, hour by hour. The app asks for it at most every 20 minutes (a download that fails is tried again after 5), only while the place in the readout is in or near Portugal (mainland, Madeira or the Azores), and keeps the last copy on the device. Nothing about you or your position is sent. IPMA asks those who use its API to tell it how, at webmaster@ipma.pt.
* **Android**: Capacitor
* **Styling**: plain CSS (`src/index.css` for tokens, `src/App.css` for layout)

### Where the wind comes from

The forecast is downloaded as points on a fixed lattice over the whole globe, 0.125° apart (about 11 to 14 km), and the wind anywhere is blended from the four points around it. Only what the app is showing is asked for: the four points around the place in the readout, the points along the route, those around the saved places in view, and those across the map. Zoomed out, the map takes a coarser lattice (0.25°, 0.5° and so on up to 4°) instead of more points, while the readout, the place labels and the route always read from the finest one. The map does not zoom out further than a country-sized view, because the wind between points even further apart would not mean much.

Open-Meteo is free for non-commercial use, without an API key, up to 600 calls a minute, 5,000 an hour and 10,000 a day per address, and **every forecast point counts as one call** (as long as it asks for no more than ten fields: the app asks for seven). The app keeps well inside that: points are reused for an hour and by every zoom level they belong to, a view is only asked for once the map has stopped moving, and it never asks for more than 400 points a minute or 3,600 an hour (counted across restarts). If the service still says its allowance ran out, the app waits as long as it is told to. Opening the app takes about 80 calls; a session of looking around, a few hundred.

### How the code is organised

| Path | What is in it |
|---|---|
| `src/utils/weatherApi.js` | The two Open-Meteo requests: the forecast for a list of points, and the place search |
| `src/utils/lattice.js` | The world lattice the forecast is requested on |
| `src/utils/windStore.js` | What has been downloaded: decides what to ask for and when, keeps it fresh, saves a copy on the device |
| `src/utils/windField.js` | Reading the wind at a moment and a position from the downloaded points |
| `src/utils/places.js` | The default places and the ones you save |
| `src/utils/time.js` | Times in the local time of a place |
| `src/utils/wind.js` | Compass words, Beaufort names, head/tail/cross components |
| `src/utils/rain.js` | When an hour counts as wet and how the rain is put in words |
| `src/utils/gpxParser.js` | GPX parsing, distance, heading and climbing |
| `src/utils/routeAnalysis.js` | Wind and rain along a route, the ride advisory, and the best time to leave |
| `src/utils/sun.js` | Where the sun is: daylight for a ride, without asking any service |
| `src/utils/ipma.js` | The wind measured by IPMA's stations, and the station nearest a place |
| `src/utils/mapStyle.js` | Basemap colours and the route colour scale |
| `src/map/` | The map itself: basemap, moving wind layer, arrows, route and markers |
| `src/components/` | Panels: wind readout, time bar, route panel, the search and routes menus |

Wind directions are always where the wind comes **from** (0° = north), as in weather reports.

---

## 🚀 Getting started

### Prerequisites

[Node.js](https://nodejs.org/) 22.22 or newer (24 LTS works too).

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/herbertj95/Wind-cycling-app.git
   cd Wind-cycling-app
   ```
2. **Install dependencies:**

   ```bash
   npm install
   ```
3. **Start the development server:**

   ```bash
   npm run dev
   ```

On Windows you can also double-click `start-app.bat`.

### Other commands

| Command | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm test` | Unit tests for the wind, the forecast download and the route maths |
| `npm run lint` | ESLint |
| `npm run android:sync` | Builds and copies the web app into the Android project |
| `npm run android:icons` | Makes the Android start-up screens and the icons for old launchers from the SVGs in `assets/` |
| `npm run routes:slim` | Strips timestamps and extra points from the GPX files in `public/routes` |

### Android

```bash
npm run android:sync
npx cap open android
```

Then build and run from Android Studio.

To get the installable file without opening Android Studio, build it with Gradle after the sync. It needs Java 21; the one that comes with Android Studio does, so point `JAVA_HOME` at it (on Windows, `C:\Program Files\Android\Android Studio\jbr`):

```bash
cd android
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`: copy it to the phone and open it there to install it.

The app icon is the W of Wind drawn as a route in the app's three wind colours. It lives in four places that are changed together: `public/favicon.svg` for the browser, `assets/icon-only.svg` and `assets/splash.svg` (with its copy `splash-dark.svg`) for `npm run android:icons`, and the two vector layers of the Android icon in `android/app/src/main/res/drawable/ic_launcher_*.xml`, which are edited by hand so the icon stays sharp at any size.

---

## 🧭 How to use

1. **Read the wind**: the panel in the top left shows the wind for the selected place. Tap another place label, or any point on the map.
2. **Go somewhere else**: open **Search** and type the name of a town (or a latitude and longitude), or just move the map. **Locate me** goes to where you are.
3. **Keep a place**: the bookmark in the readout saves the point you are looking at to your places, and removes it again. Your places are listed under **Search**.
4. **Pick a time**: drag the bar at the bottom. *Back to now* (*Now* on a phone) returns to the current hour. Times are local to the place; when that is not your own time zone, the offset is shown next to them.
5. **Load a route**: open **Routes** and open your own `.gpx` file, or choose one of the routes around Lisbon. You can also drop a file on the map.
6. **Ride it**: move along the profile to see head, tail and crosswind at each kilometre. Set your average speed to match your ride.
7. **Choose when to go**: tap one of the best times in the route panel to plan the ride for then, or pick any hour on the bar. *Reverse* turns the route round.

### Reading the wind along a route

The coloured bar and the percentages split the route by what you feel along the road: **tailwind** (blue) and **headwind** (red) count from 5 km/h along your direction of travel; everything below that, crosswind included, is **across or light** (grey). The same colours are on the route on the map.

Under the elevation profile, the band shows that head or tail component kilometre by kilometre: red above the line is wind against you, blue below it is wind behind you, and the height is its strength. A thin line marks the highest red point and another the lowest blue one, each with its value: "headwind up to 12 km/h" over the upper line, "tailwind up to 8 km/h" under the lower one. Red and blue are drawn to one scale, so twice the height is twice the wind; the full height of the band stands for 15 km/h, or for the strongest value on the route rounded up to the next 5 when that is more, so on a calm day the band stays thin. There is no grey in it: the grey stretches of the bar are where the band stays within 5 km/h of the line.

With the route details folded away, the band is shown on its own, with the strongest headwind and tailwind beside it.

### The best time to leave

With a route open, the time bar shows the wind at its start, and the app rides the route at every hour of the bar (at your average speed, each point at the time you would get there) to give each start a score. The score adds up what the wind costs you, kilometre by kilometre: a headwind costs more than the same tailwind gives back, and a crosswind costs a little too. Rain adds to it by how hard it falls and how likely it is, and gusts from 25 km/h across the road, or 40 km/h from any side, add more the stronger they are.

The best time on a day is the easiest start, together with the hours next to it that come close; a short line under the bars marks it. Only rides that finish before dark (the end of civil twilight, half an hour or so after sunset) are offered, and only where the forecast covers the whole route. When there is no time left today, the panel says so while it is still light. A ride too long for any day of the bar is offered the starts with the least riding in the dark instead. Today and tomorrow are always looked at; the day after only once the bar holds the whole of its daylight.

The route panel also says which part of the ride has the wind against you, when there is a clear difference: "Headwind out, tailwind home." on a route that comes back to its start, split at its farthest point; "Headwind, then tailwind." on one that goes from one place to another. *Reverse* rides it the other way round, and says *easier that way* when the wind makes it clearly so at the hour shown. A route that comes back by the road it went out on has no *Reverse*: it would be the same ride.

### Measured wind

Where an IPMA station is within 30 km of the place in the readout, and the readout shows the present, the panel adds what that station measured in the last two hours and how it compares with the forecast for the same spot and hour: less than 5 km/h apart is *as forecast* (a phone, short of room, gives the forecast figure instead of the words when the two differ by more). Under it, how far away the station is, and its name where there is room. Stations report every hour, with the wind as one of eight directions. It is shown for a place, a tapped point, your position, or the start of a route (on a phone, the line about what the wind does to the rider takes its place there), never for a later time or a later point of the ride.

### Rain

Rain is read from the same forecast as the wind, hour by hour: millimetres in the hour and the chance of any rain in it. An hour counts as wet from 0.1 mm; under 2.5 mm an hour it is light, from 7.5 mm heavy. An hour with no amount forecast but a chance of 30% or more gets a line too ("40% chance of rain"); a dry hour gets none. The other way round, an amount with a chance under 30% is called possible ("Light rain possible, 0.4 mm/h (3% chance)") and its foot on the time bar is paler: the amount comes from one run of the forecast model, the chance from how many of its runs agree. Along a route the rain is taken where you are when it falls: leave an hour later, or ride faster, and the wet stretch moves. Slanted strokes over the profile mark those stretches, and a teal line along the top of the folded band does the same.

It is a forecast on a grid of about 12 km, not a radar: showers can fall beside the road and not on it, which is why the chance is always shown next to the amount. The amount is total precipitation, so in the cold it is snow, as melted water. Rain is teal with a drop or hatching, never blue: blue already means the wind is behind you.

### Adding your own bundled route

Put the `.gpx` file in `public/routes`, run `npm run routes:slim`, and add it to `PRESET_ROUTES` in `src/utils/gpxParser.js`.

---

*Made for cyclists, powered by precision data.*
