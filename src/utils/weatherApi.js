// Open-Meteo Weather API Integration for Lisbon Metropolitan Area
// Bounding box: Approx. Lat 38.5°N to 39.0°N, Lng -9.5°W to -9.0°W

// 25 Bounding grid coordinates in Lisbon for Arrow Grid Overlay
export const LISBON_GRID_POINTS = (() => {
  const lats = [38.5, 38.625, 38.75, 38.875, 39.0];
  const lngs = [-9.5, -9.375, -9.25, -9.125, -9.0];
  const list = [];
  lats.forEach(lat => {
    lngs.forEach(lng => {
      list.push({ lat, lng });
    });
  });
  return list;
})();

// Spot coordinates (Lisbon microclimates)
export const MICROCLIMATE_SPOTS = [
  {
    id: 'lisbon',
    name: 'Lisbon Central',
    desc: 'The historic metropolitan center, moderately sheltered by urban topography but highly exposed along the waterfront trade-wind lines.',
    lat: 38.73,
    lng: -9.14,
    windMultiplier: 1.0,
    tempOffset: 0,
    isSheltered: true,
    rimWarning: false,
  },
  {
    id: 'guincho',
    name: 'Guincho / Cabo da Roca',
    desc: 'Exposed Atlantic cliffs, infamous for high speed gale-force headwinds.',
    lat: 38.73,
    lng: -9.47,
    windMultiplier: 1.6, // Stronger coastal wind factor
    tempOffset: -2,      // Wind-chill and Atlantic cold
    isSheltered: false,
    rimWarning: true,
  },
  {
    id: 'marginal',
    name: 'Estrada Marginal',
    desc: 'Tagus river cycle artery, highly vulnerable to tricky side crosswinds.',
    lat: 38.69,
    lng: -9.31,
    windMultiplier: 1.1,
    tempOffset: 0,
    isSheltered: false,
    rimWarning: false,
  },
  {
    id: 'sintra',
    name: 'Serra de Sintra (Peninha)',
    desc: 'Mountainous terrain with severe gust microclimates and heavy drafts.',
    lat: 38.78,
    lng: -9.42,
    windMultiplier: 1.4,
    tempOffset: -4, // Mountain cooling
    isSheltered: false,
    rimWarning: true,
  },
  {
    id: 'monsanto',
    name: 'Monsanto Forest Park',
    desc: 'Densely forested hill climbs offering excellent cover from wind.',
    lat: 38.73,
    lng: -9.19,
    windMultiplier: 0.5, // Sheltered by canopy
    tempOffset: 1,       // Retained inland warmth
    isSheltered: true,
    rimWarning: false,
  },
  {
    id: 'vasco_gama',
    name: 'Ponte Vasco da Gama',
    desc: 'Long flat salt marsh estuary path, completely unprotected from cross-gusts.',
    lat: 38.79,
    lng: -9.09,
    windMultiplier: 1.3,
    tempOffset: -1,
    isSheltered: false,
    rimWarning: true,
  },
  {
    id: 'povoa',
    name: 'Póvoa de Santa Iria',
    desc: 'Flat riverbed cycle route, prone to relentless head-on river winds.',
    lat: 38.86,
    lng: -9.05,
    windMultiplier: 1.2,
    tempOffset: 0,
    isSheltered: false,
    rimWarning: false,
  },
  {
    id: 'caparica',
    name: 'Costa da Caparica',
    desc: 'Exposed sandy coast south of the river. Steady marine breezes.',
    lat: 38.64,
    lng: -9.24,
    windMultiplier: 1.2,
    tempOffset: -1,
    isSheltered: false,
    rimWarning: false,
  },
  {
    id: 'arrabida',
    name: 'Serra da Arrábida',
    desc: 'Dramatic steep cliff climbs with ocean thermal drafts and sheer drops.',
    lat: 38.48,
    lng: -9.01,
    windMultiplier: 1.3,
    tempOffset: -2,
    isSheltered: false,
    rimWarning: true,
  }
];

// Fallback high-fidelity weather database in case of API failure / offline
const getMockWeather = (windPreset = 'nortada') => {
  // Preset 1: Nortada (Strong North wind - typical summer pattern in Lisbon)
  // Preset 2: Calm / Gentle breeze
  // Preset 3: South storm gusts
  let baseWindSpeed = 18; // km/h
  let baseWindDir = 340;  // NNW (blowing FROM NNW)
  let baseWindGusts = 28; // km/h
  let baseTemp = 21;      // °C
  
  if (windPreset === 'calm') {
    baseWindSpeed = 6;
    baseWindDir = 240; // Gentle SW
    baseWindGusts = 9;
    baseTemp = 24;
  } else if (windPreset === 'storm') {
    baseWindSpeed = 29;
    baseWindDir = 190; // Strong South gusts
    baseWindGusts = 45;
    baseTemp = 16;
  }

  return LISBON_GRID_POINTS.map((pt, index) => {
    // Generate realistic variance across Lisbon microclimates
    // West areas (Guincho, Lng -9.47) get stronger wind
    // Inland/forest areas (Monsanto) get sheltered
    // Estuary/flat (Vasco da Gama, Lng -9.09) get steady strong river breeze
    
    let multiplier = 1.0;
    let dirSkew = (Math.sin(pt.lat * 50) + Math.cos(pt.lng * 50)) * 10; // Slight local direction changes
    
    // Coastal West (Cabo da Roca / Guincho)
    if (pt.lng < -9.4) {
      multiplier = 1.4;
    }
    // Deep estuary East
    else if (pt.lng > -9.15) {
      multiplier = 1.1;
    }
    // Inland/Center
    else {
      multiplier = 0.8;
    }

    const windSpeed = Math.round(baseWindSpeed * multiplier * (0.9 + (index % 5) * 0.05));
    const windDir = Math.round((baseWindDir + dirSkew + 360) % 360);
    const windGusts = Math.round(baseWindGusts * multiplier * (0.95 + (index % 3) * 0.05));
    
    // Feels like calculates from wind-chill index (simplified formula for 10m wind speed)
    // Wind-chill is prominent at lower temperatures and higher wind speeds
    const apparentTemp = Math.round(baseTemp - (windSpeed * 0.12));

    return {
      lat: pt.lat,
      lng: pt.lng,
      windSpeed,
      windDir,
      windGusts,
      temp: baseTemp,
      apparentTemp,
      relativeHumidity: 65 + (index % 4) * 3,
    };
  });
};

/**
 * Fetches current weather values for the entire Lisbon grid from Open-Meteo
 * Fallback values are generated if API fails or rate-limits occur.
 */
export async function fetchLisbonGridWeather(windPreset = 'live') {
  // If the user selected a simulated planning pattern, skip live API query entirely
  if (windPreset !== 'live') {
    return getMockWeather(windPreset);
  }

  // Live real-time mode: query Open-Meteo directly
  try {
    const latsParam = LISBON_GRID_POINTS.map(p => p.lat).join(',');
    const lngsParam = LISBON_GRID_POINTS.map(p => p.lng).join(',');
    
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latsParam}&longitude=${lngsParam}&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // If it's single coordinate result array vs multi array
    const results = Array.isArray(data) ? data : [data];
    
    return LISBON_GRID_POINTS.map((pt, i) => {
      const forecast = results[i];
      if (!forecast || !forecast.current) {
        throw new Error('Malformed Open-Meteo grid response');
      }
      
      return {
        lat: pt.lat,
        lng: pt.lng,
        windSpeed: Math.round(forecast.current.wind_speed_10m),
        windDir: Math.round(forecast.current.wind_direction_10m),
        windGusts: Math.round(forecast.current.wind_gusts_10m),
        temp: Math.round(forecast.current.temperature_2m),
        apparentTemp: Math.round(forecast.current.apparent_temperature),
        relativeHumidity: Math.round(forecast.current.relative_humidity_2m),
        isRealTime: true
      };
    });
  } catch (error) {
    console.warn('API Error in Live mode, falling back to simulated Nortada:', error.message);
    // Return simulated Nortada but flag it as fallback
    return getMockWeather('nortada').map(pt => ({
      ...pt,
      isFallback: true
    }));
  }
}

/**
 * Finds the weather attributes at a specific location by interpolating from the grid
 */
export function getInterpolatedWeather(lat, lng, gridWeather) {
  if (!gridWeather || gridWeather.length === 0) {
    return {
      windSpeed: 15,
      windDir: 340,
      windGusts: 22,
      temp: 20,
      apparentTemp: 18,
      relativeHumidity: 60
    };
  }

  // Find the nearest point in the grid using simple Euclidean distance
  let nearestPoint = null;
  let minDistance = Infinity;

  for (const pt of gridWeather) {
    const dLat = pt.lat - lat;
    const dLng = pt.lng - lng;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < minDistance) {
      minDistance = dist;
      nearestPoint = pt;
    }
  }

  // Apply microclimate scaling factors based on nearby spots (within 2km)
  let speedMultiplier = 1.0;
  let tempOffset = 0;
  
  for (const spot of MICROCLIMATE_SPOTS) {
    const dLat = spot.lat - lat;
    const dLng = spot.lng - lng;
    const distKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111; // 1 degree lat ~ 111km
    
    if (distKm < 2.5) { // within 2.5 km of a specific spot
      // Blend factor based on proximity
      const blend = (2.5 - distKm) / 2.5;
      speedMultiplier = 1.0 + (spot.windMultiplier - 1.0) * blend;
      tempOffset = spot.tempOffset * blend;
      break;
    }
  }

  return {
    ...nearestPoint,
    windSpeed: Math.round(nearestPoint.windSpeed * speedMultiplier),
    windGusts: Math.round(nearestPoint.windGusts * speedMultiplier),
    temp: Math.round(nearestPoint.temp + tempOffset),
    apparentTemp: Math.round(nearestPoint.apparentTemp + tempOffset),
  };
}
