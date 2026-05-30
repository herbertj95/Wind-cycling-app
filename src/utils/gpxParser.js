// GPX Parser and Heading Vector Physics Utility

/**
 * Calculates the spherical distance between two coordinates in kilometers (Haversine formula)
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates the bearing/heading from point A to point B in degrees (0 to 360)
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  const brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

/**
 * Converts a degree bearing (0-360) to a clear compass direction label
 */
export function getCompassLabel(bearing) {
  const directions = [
    { label: 'N', min: 337.5, max: 22.5 },
    { label: 'NNE', min: 22.5, max: 67.5 },
    { label: 'NE', min: 45, max: 90 },
    { label: 'ENE', min: 67.5, max: 112.5 },
    { label: 'E', min: 112.5, max: 157.5 },
    { label: 'ESE', min: 112.5, max: 157.5 },
    { label: 'SE', min: 157.5, max: 202.5 },
    { label: 'SSE', min: 202.5, max: 247.5 },
    { label: 'S', min: 157.5, max: 202.5 },
    { label: 'SSW', min: 202.5, max: 247.5 },
    { label: 'SW', min: 202.5, max: 247.5 },
    { label: 'WSW', min: 247.5, max: 292.5 },
    { label: 'W', min: 247.5, max: 292.5 },
    { label: 'WNW', min: 292.5, max: 337.5 },
    { label: 'NW', min: 292.5, max: 337.5 },
    { label: 'NNW', min: 337.5, max: 22.5 }
  ];

  const val = Math.round(bearing);
  if (val >= 337.5 || val < 22.5) return 'N';
  if (val >= 22.5 && val < 67.5) return 'NE';
  if (val >= 67.5 && val < 112.5) return 'E';
  if (val >= 112.5 && val < 157.5) return 'SE';
  if (val >= 157.5 && val < 202.5) return 'S';
  if (val >= 202.5 && val < 247.5) return 'SW';
  if (val >= 247.5 && val < 292.5) return 'W';
  return 'NW';
}

/**
 * Classifies the wind relative to the cyclist's travel bearing.
 * - Wind Direction (windDir) is the angle the wind is COMING FROM.
 * - Riding direction (bearing) is the angle the cyclist is RIDING TOWARD.
 * Returns: 'tailwind' | 'headwind' | 'crosswind'
 */
export function classifyWindEffect(bearing, windDir) {
  let diff = Math.abs(bearing - windDir) % 360;
  if (diff > 180) {
    diff = 360 - diff;
  }

  // Tailwind: Wind is coming from behind (angle difference is large, close to 180)
  if (diff >= 135) {
    return 'tailwind';
  }
  // Headwind: Wind is coming from front (angle difference is small, close to 0/360)
  if (diff <= 45) {
    return 'headwind';
  }
  // Crosswind: Wind is hitting from the side (roughly 45 to 135 degrees)
  return 'crosswind';
}

/**
 * Parses GPX XML content string into a normalized JSON array of trackpoints
 */
export function parseGpxData(gpxText, routeName = 'Imported Route') {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, 'text/xml');

    // Check for XML parsing error
    const parseError = xmlDoc.getElementsByTagName('parsererror')[0];
    if (parseError) {
      throw new Error('Invalid GPX format: XML parsing error');
    }

    const trkpts = xmlDoc.getElementsByTagName('trkpt');
    if (trkpts.length === 0) {
      throw new Error('No trackpoints found in GPX');
    }

    const points = [];
    let cumulativeDistance = 0;

    // Downsample points to a maximum of 400 for butter-smooth rendering and lag-free HUD updates
    const maxPoints = 400;
    const step = Math.max(1, Math.ceil(trkpts.length / maxPoints));

    for (let i = 0; i < trkpts.length; i += step) {
      const pt = trkpts[i];
      const lat = parseFloat(pt.getAttribute('lat'));
      const lng = parseFloat(pt.getAttribute('lon'));

      const eleEl = pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : 0;

      let distance = 0;
      let bearing = 0;

      if (points.length > 0) {
        const prevPt = points[points.length - 1];
        const stepDist = calculateDistance(prevPt.lat, prevPt.lng, lat, lng);
        cumulativeDistance += stepDist;
        distance = cumulativeDistance;
        bearing = calculateBearing(prevPt.lat, prevPt.lng, lat, lng);

        if (points.length === 1) {
          points[0].bearing = bearing;
        }
      }

      points.push({
        lat,
        lng,
        ele,
        distance,
        bearing,
      });
    }

    // Set the bearing of the last point same as the second-to-last
    if (points.length > 1) {
      points[points.length - 1].bearing = points[points.length - 2].bearing;
    }

    return {
      name: routeName,
      points,
      totalDistance: cumulativeDistance,
      totalElevationGain: calculateElevationGain(points)
    };
  } catch (error) {
    console.error('GPX parsing error:', error);
    throw error;
  }
}

function calculateElevationGain(points) {
  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i - 1].ele;
    if (diff > 0) {
      gain += diff;
    }
  }
  return Math.round(gain);
}

// ==========================================
// PREMIUM PRE-CONFIGURED LISBON CYCLING ROUTES
// ==========================================

export const PRESET_ROUTES = [
  {
    id: 'alges-monsanto',
    name: 'Alges-Monsanto',
    filename: 'Alges-Monsanto.gpx',
    description: 'Hilly woodland route connecting Algés climbs up into Monsanto Forest Park.'
  },
  {
    id: 'cacilhas-caparica',
    name: 'Cacilhas-Caparica',
    filename: 'Cacilhas-Caparica.gpx',
    description: 'Scenic South Tagus Estuary route extending to Caparica Atlantic coast.'
  },
  {
    id: 'cascais-sintra',
    name: 'Cascais-Sintra',
    filename: 'Cascais-Sintra.gpx',
    description: 'High-altitude Sintra mountain climb exposed to rapid marine headwinds.'
  },
  {
    id: 'lisboa-alverca',
    name: 'Lisboa-Alverca',
    filename: 'Lisboa-Alverca.gpx',
    description: 'Flat, high-speed riverbed route parallel to the north Tagus estuary.'
  },
  {
    id: 'lisboa-cascais',
    name: 'Lisboa-Cascais',
    filename: 'Lisboa-Cascais.gpx',
    description: 'The classic Estrada Marginal ocean highway sprint from Lisbon to Cascais.'
  },
  {
    id: 'seixal-arrabida',
    name: 'Seixal-Arrabida',
    filename: 'Seixal-Arrabida.gpx',
    description: 'Extreme climbing route along Seixal marshes up into the Arrábida cliffs.'
  }
];
