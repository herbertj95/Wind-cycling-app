# 🚴‍♂️ Wind Cycling App

A premium, high-performance real-time wind and route analysis tool built specifically for cyclists in the Lisbon Metropolitan Area and beyond.

The application allows cyclists to upload GPX routes, cross-reference their exact geographical path against high-resolution Open-Meteo weather grids, and accurately predict tailwind boosts, crosswind sweep, and headwind resistance before they even clip into the pedals.

---

## ✨ Core Features

* **🗺️ Interactive Wind Map**: A rich, dark-mode Leaflet map overlaying your cycling route with dense, dynamic wind vector particles showing real-time wind direction and intensity.
* **📊 Route Wind Impact Analysis**: Get a precise breakdown of your route's wind exposure. Features a dynamic SVG elevation chart combined with a color-coded wind ribbon (`Green = Tailwind`, `Yellow = Crosswind`, `Red = Headwind`).
* **📡 Rider Position Telemetry HUD**: Simulate your ride! Drag the marker along the route to see point-specific real-time telemetry (Live Wind Speed, Gusts, Temperature, and exact coordinates).
* **⚠️ Smart Ride Advisory**: Intelligent threshold warnings advising when deep-section aerodynamic wheels are unsafe due to severe crosswinds, or pacing strategies for heavy headwinds.
* **💎 Premium Glassmorphism UI**: High-end translucent interface components with dynamic glow states depending on the severity of the wind conditions.

---

## 🛠️ Technology Stack

* **Frontend Framework**: React 18 + Vite
* **Map Engine**: Leaflet (`react-leaflet`) with high-contrast CartoDB dark tiles
* **Data Integration**:
  * [Open-Meteo API](https://open-meteo.com) for ultra-high-resolution localized weather data.
  * Native GPX parsing (XML DOM extraction) for precise route plotting and coordinate interpolation.
* **Styling**: Vanilla CSS utilizing custom Glassmorphism panels, CSS Grid/Flexbox architecture, and dynamic SVGs.

---

## 🚀 Getting Started

### Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

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
4. **Build for production:**

   ```bash
   npm run build
   ```

---

## 🧭 How to Use

1. **Upload a Route**: Click the **"Load Route"** panel in the top left to upload a `.gpx` file from your Garmin, Wahoo, or Strava account. (A few default Lisbon routes are included in the `public/routes` directory).
2. **Analyze Wind Impact**: Look at the right-hand **Route Wind Impact** sidebar to see exactly what percentage of your ride will be assisted or resisted by the wind.
3. **Simulate Your Ride**: Switch the top tab to **Simulate Route**. Drag the slider to virtually ride your route and see the localized wind vectors and telemetry shift as you navigate different geographical microclimates.

---

*Made for cyclists, powered by precision data.*
