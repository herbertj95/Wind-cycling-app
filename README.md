# 🚴‍♂️ Wind Cycling App

Wind speed and direction for riding, anywhere in the world: on the map, hour by hour, and along your own route.

The map is the whole screen. The wind is drawn on top of it wherever you take the map, a time bar lets you move through the next two days, and loading a GPX route shows where the wind will push you and where it will slow you down.

---

## ✨ What it does

* **🗺️ Wind map**: the wind moves across the map as white streaks, and arrows carry the speed in km/h. Arrows get longer as the wind gets stronger and always point the way the wind is blowing.
* **🌍 Anywhere**: move the map or use **Search** to find a town, and the forecast follows. Tap any point to read its wind.
* **🧭 Names to find your way**: road numbers and summits with their height from a regional view; zoomed in to street level, street names and landmarks such as monuments, museums, stadiums, viewpoints and stations.
* **📍 Your places**: places are labelled on the map with their current wind. The app starts with nine riding spots around Lisbon (Guincho, Marginal, Sintra, Arrábida and others); save any searched or tapped point with the bookmark in the readout, and remove the ones you do not need.
* **🕒 Time bar**: 48 hours of forecast for the place you are looking at, in the local time of that place. Drag it or press play. The map follows without reloading.
* **📊 Route analysis**: open your own GPX file from anywhere, or one of the bundled routes around Lisbon. The route is coloured by what the wind does to you: blue pushes, red slows, grey barely matters. Each point is checked at the time you would get there, for the riding speed you choose. Ferry crossings and other gaps in a recording are not counted as ridden.
* **🚴 Ride it**: move along the elevation profile, or press *Ride it*, and the rider on the map shows your heading and where the wind hits you.
* **↕️ More map when you want it**: the time bar and the route details each fold down to one line with the small arrow on them, and stay that way until you open them again.
* **☀️ Day and night map**: a light map for reading in the sun and a dark one for the evening. *Motion* switches the moving wind on and off; the arrows and numbers stay.
* **📡 Works with a weak signal**: the forecast for what you looked at last (your places, the route, that part of the map) is kept on the device. If a download fails, the app says so and keeps showing the saved one. It never invents data.

---

## 🛠️ Technology

* **App**: React 19 + Vite
* **Map**: [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) vector tiles, recoloured in `src/utils/mapStyle.js`. No API key needed.
* **Relief**: Mapzen Terrarium elevation tiles (AWS Open Data)
* **Weather**: [Open-Meteo](https://open-meteo.com) hourly forecast, 10 m wind. "Now" is the current minute, blended between the two forecast hours around it; gusts are those of the hour in progress.
* **Place search**: the Open-Meteo geocoding API (names from [GeoNames](https://www.geonames.org/))
* **Android**: Capacitor
* **Styling**: plain CSS (`src/index.css` for tokens, `src/App.css` for layout)

### Where the wind comes from

The forecast is downloaded as points on a fixed lattice over the whole globe, 0.125° apart (about 11 to 14 km), and the wind anywhere is blended from the four points around it. Only what the app is showing is asked for: the four points around the place in the readout, the points along the route, those around the saved places in view, and those across the map. Zoomed out, the map takes a coarser lattice (0.25°, 0.5° and so on up to 4°) instead of more points, while the readout, the place labels and the route always read from the finest one. The map does not zoom out further than a country-sized view, because the wind between points even further apart would not mean much.

Open-Meteo is free for non-commercial use, without an API key, up to 600 calls a minute, 5,000 an hour and 10,000 a day per address, and **every forecast point counts as one call**. The app keeps well inside that: points are reused for an hour and by every zoom level they belong to, a view is only asked for once the map has stopped moving, and it never asks for more than 400 points a minute or 3,600 an hour (counted across restarts). If the service still says its allowance ran out, the app waits as long as it is told to. Opening the app takes about 80 calls; a session of looking around, a few hundred.

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
| `src/utils/gpxParser.js` | GPX parsing, distance, heading and climbing |
| `src/utils/routeAnalysis.js` | Wind along a route and the ride advisory |
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
| `npm run routes:slim` | Strips timestamps and extra points from the GPX files in `public/routes` |

### Android

```bash
npm run android:sync
npx cap open android
```

Then build and run from Android Studio.

---

## 🧭 How to use

1. **Read the wind**: the panel in the top left shows the wind for the selected place. Tap another place label, or any point on the map.
2. **Go somewhere else**: open **Search** and type the name of a town (or a latitude and longitude), or just move the map. **Locate me** goes to where you are.
3. **Keep a place**: the bookmark in the readout saves the point you are looking at to your places, and removes it again. Your places are listed under **Search**.
4. **Pick a time**: drag the bar at the bottom. *Back to now* returns to the current hour. Times are local to the place; when that is not your own time zone, the offset is shown next to them.
5. **Load a route**: open **Routes** and open your own `.gpx` file, or choose one of the routes around Lisbon. You can also drop a file on the map.
6. **Ride it**: move along the profile to see head, tail and crosswind at each kilometre. Set your average speed to match your ride.

### Reading the wind along a route

The strip and the percentages split the route by what you feel along the road: **tailwind** (blue) and **headwind** (red) count from 5 km/h along your direction of travel; everything below that, crosswind included, is **across or light** (grey). The same colours are on the route on the map.

Under the elevation profile, the band shows that head or tail component kilometre by kilometre: red above the line is wind against you, blue below it is wind behind you, and the height is its strength. The value of the two ends of the scale is written at the left, "15 km/h" at the top (headwind) and at the bottom (tailwind): the full height stands for 15 km/h, or for the strongest value on the route rounded up to the next 5 when that is more, so on a calm day the band stays thin. There is no grey in it: the grey stretches of the strip are where the band stays within 5 km/h of the line.

### Adding your own bundled route

Put the `.gpx` file in `public/routes`, run `npm run routes:slim`, and add it to `PRESET_ROUTES` in `src/utils/gpxParser.js`.

---

*Made for cyclists, powered by precision data.*
