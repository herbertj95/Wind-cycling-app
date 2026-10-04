// Places shown as labels on the map. The Lisbon ones are the starting set; riders add and remove their own.
// `label` is the short name drawn on the map.

export const DEFAULT_PLACES = [
  {
    id: 'lisbon',
    name: 'Lisbon Central',
    label: 'Lisboa',
    desc: 'The historic centre, partly sheltered by the hills but open along the waterfront.',
    lat: 38.73,
    lng: -9.14,
    anchor: 'left',
  },
  {
    id: 'guincho',
    name: 'Guincho / Cabo da Roca',
    label: 'Guincho',
    desc: 'Exposed Atlantic cliffs, known for strong headwinds.',
    lat: 38.73,
    lng: -9.47,
    anchor: 'left',
  },
  {
    id: 'marginal',
    name: 'Estrada Marginal',
    label: 'Marginal',
    desc: 'The road along the Tagus, open to crosswinds off the water.',
    lat: 38.69,
    lng: -9.31,
  },
  {
    id: 'sintra',
    name: 'Serra de Sintra (Peninha)',
    label: 'Sintra',
    desc: 'Mountain roads where gusts change from one bend to the next.',
    lat: 38.78,
    lng: -9.42,
  },
  {
    id: 'monsanto',
    name: 'Monsanto Forest Park',
    label: 'Monsanto',
    desc: 'Forested climbs with good cover from the wind.',
    lat: 38.73,
    lng: -9.19,
    anchor: 'right',
  },
  {
    id: 'vasco_gama',
    name: 'Ponte Vasco da Gama',
    label: 'Vasco da Gama',
    desc: 'Flat estuary path with no protection from cross-gusts.',
    lat: 38.79,
    lng: -9.09,
  },
  {
    id: 'povoa',
    name: 'Póvoa de Santa Iria',
    label: 'Póvoa',
    desc: 'Flat riverside route, often straight into the wind.',
    lat: 38.86,
    lng: -9.05,
  },
  {
    id: 'caparica',
    name: 'Costa da Caparica',
    label: 'Caparica',
    desc: 'Open sandy coast south of the river with steady sea breezes.',
    lat: 38.64,
    lng: -9.24,
  },
  {
    id: 'arrabida',
    name: 'Serra da Arrábida',
    label: 'Arrábida',
    desc: 'Steep cliff roads above the sea, gusty near the top.',
    lat: 38.48,
    lng: -9.01,
  },
];

// The view the app opens with the first time: every default place, with a little air around them.
export const HOME_BOUNDS = (() => {
  const lats = DEFAULT_PLACES.map((p) => p.lat);
  const lngs = DEFAULT_PLACES.map((p) => p.lng);
  return {
    south: Math.min(...lats) - 0.03,
    north: Math.max(...lats) + 0.03,
    west: Math.min(...lngs) - 0.05,
    east: Math.max(...lngs) + 0.05,
  };
})();

/** Where the places are kept on the device. */
export const PLACES_KEY = 'wind-places-v1';

const isPlace = (p) =>
  p && typeof p.id === 'string' && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/** The rider's places, or the default set when none were saved on this device. */
export function loadPlaces() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACES_KEY));
    if (Array.isArray(saved) && saved.every(isPlace)) return saved;
  } catch {
    // unreadable or unavailable storage: start from the defaults
  }
  return DEFAULT_PLACES;
}

export function savePlaces(places) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
  } catch {
    // the places just will not be remembered
  }
}

/** A new place for the list. `region` ("Catalonia, Spain") and `zone` (its time zone) are kept when they are known. */
export function makePlace(name, lat, lng, { region, zone } = {}) {
  const label = name.trim();
  const place = { id: `place-${Date.now().toString(36)}`, name: label, label, lat, lng };
  if (region) place.region = region;
  if (zone) place.zone = zone;
  return place;
}

/** "38.72, -9.14" as { lat, lng }, or null when the text is not a latitude and a longitude the map can show. */
export function parseCoordinates(text) {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
