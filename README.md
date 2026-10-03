# 🚴‍♂️ Wind Cycling App

Wind speed and direction for riding around Lisbon: on the map, hour by hour, and along your own route.

The map is the whole screen. The wind is drawn on top of it, a time bar lets you move through the next two days, and loading a GPX route shows where the wind will push you and where it will slow you down.

---

## ✨ What it does

* **🗺️ Wind map**: the wind moves across the map as white streaks, and arrows carry the speed in km/h. Arrows get longer as the wind gets stronger and always point the way the wind is blowing.
* **📍 Spots**: nine riding spots (Guincho, Marginal, Sintra, Arrábida and others) are labelled on the map with their current wind. Tap a spot, or anywhere on the map, to read that point.
* **🕒 Time bar**: 48 hours of forecast for the place you are looking at. Drag it or press play. The map follows without reloading.
* **📊 Route analysis**: load one of the bundled routes or your own GPX file. The route is coloured by what the wind does to you: blue pushes, red slows, grey barely matters. Each point is checked at the time you would get there, for the riding speed you choose. Ferry crossings and other gaps in a recording are not counted as ridden.
* **🚴 Ride it**: move along the elevation profile, or press *Ride it*, and the rider on the map shows your heading and where the wind hits you.
* **☀️ Day and night map**: a light map for reading in the sun and a dark one for the evening. *Motion* switches the moving wind on and off; the arrows and numbers stay.
* **📡 Works with a weak signal**: the last forecast is kept on the device. If a refresh fails, the app says so and keeps showing the saved one. It never invents data.

---

## 🛠️ Technology

* **App**: React 19 + Vite
* **Map**: [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) vector tiles, recoloured in `src/utils/mapStyle.js`. No API key needed.
* **Relief**: Mapzen Terrarium elevation tiles (AWS Open Data)
* **Weather**: [Open-Meteo](https://open-meteo.com) hourly forecast, 10 m wind, on a 6 × 6 grid over greater Lisbon. "Now" is the current minute, blended between the two forecast hours around it; gusts are those of the hour in progress.
* **Android**: Capacitor
* **Styling**: plain CSS (`src/index.css` for tokens, `src/App.css` for layout)

### How the code is organised

| Path | What is in it |
|---|---|
| `src/utils/weatherApi.js` | Forecast download, the wind grid and interpolation between grid points |
| `src/utils/wind.js` | Compass words, Beaufort names, head/tail/cross components |
| `src/utils/gpxParser.js` | GPX parsing, distance, heading and climbing |
| `src/utils/routeAnalysis.js` | Wind along a route and the ride advisory |
| `src/utils/mapStyle.js` | Basemap colours and the route colour scale |
| `src/map/` | The map itself: basemap, moving wind layer, arrows, route and markers |
| `src/components/` | Panels: wind readout, time bar, route panel, routes menu |

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
| `npm test` | Unit tests for the wind and route maths |
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

1. **Read the wind**: the panel in the top left shows the wind for the selected spot. Tap another spot, or any point on the map.
2. **Pick a time**: drag the bar at the bottom. *Back to now* returns to the current hour.
3. **Load a route**: open **Routes** and choose one, or open your own `.gpx` file. You can also drop a file on the map.
4. **Ride it**: move along the profile to see head, tail and crosswind at each kilometre. Set your average speed to match your ride.

### Adding your own bundled route

Put the `.gpx` file in `public/routes`, run `npm run routes:slim`, and add it to `PRESET_ROUTES` in `src/utils/gpxParser.js`.

---

*Made for cyclists, powered by precision data.*
