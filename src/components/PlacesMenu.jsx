import { useEffect, useState } from 'react';
import { MagnifyingGlass, WarningCircle } from '@phosphor-icons/react';
import { searchPlaces } from '../utils/weatherApi';
import { parseCoordinates } from '../utils/places';

// The search starts once typing pauses for this long, and from this many letters
const SEARCH_DELAY_MS = 300;
const MIN_LETTERS = 2;

/**
 * Finds a place anywhere in the world by name, and lists the saved places.
 * - places: the saved places, [{ id, name, desc?, region? }]
 * - activeId: id of the saved place in focus
 * - onPlace(place): a saved place was chosen
 * - onResult({ name, region, lat, lng, zone }): a search result was chosen
 */
export default function PlacesMenu({ id, places, activeId, onPlace, onResult }) {
  const [query, setQuery] = useState('');
  // the answer to the last search that finished: { text, results } or { text, failed: true }
  const [answer, setAnswer] = useState(null);

  const text = query.trim();
  const coordinates = parseCoordinates(text);
  const searching = text.length >= MIN_LETTERS && !coordinates;

  useEffect(() => {
    if (!searching) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const results = await searchPlaces(text, controller.signal);
        if (!controller.signal.aborted) setAnswer({ text, results });
      } catch {
        if (!controller.signal.aborted) setAnswer({ text, failed: true });
      }
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searching, text]);

  // An answer counts for the text it was asked for. While that text is being typed further, the matches
  // found so far stay on screen instead of blinking away at every letter.
  const current = searching && answer?.text === text ? answer : null;
  const earlier = searching && !current && answer?.results && (text.startsWith(answer.text) || answer.text.startsWith(text)) ? answer : null;
  const results = (current ?? earlier)?.results ?? [];

  const onSubmit = (e) => {
    e.preventDefault();
    if (coordinates) onResult({ name: null, ...coordinates });
    // Enter takes the best match for what is in the box, not for what was there a moment ago
    else if (current && results.length > 0) onResult(results[0]);
  };

  return (
    <div id={id} className="menu-panel places-menu panel">
      <form className="search-field" role="search" onSubmit={onSubmit}>
        <MagnifyingGlass size={18} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Town or place name"
          aria-label="Search for a place"
          autoComplete="off"
          enterKeyHint="search"
          autoFocus
        />
      </form>

      {coordinates && (
        <ul>
          <li>
            <button type="button" onClick={() => onResult({ name: null, ...coordinates })}>
              <b>Go to {coordinates.lat.toFixed(3)}, {coordinates.lng.toFixed(3)}</b>
              <small>Latitude and longitude</small>
            </button>
          </li>
        </ul>
      )}

      {searching && !current && !earlier && <p className="menu-note" role="status">Searching…</p>}

      {current?.failed && (
        <p className="menu-error" role="alert">
          <WarningCircle size={16} aria-hidden="true" />
          The place search is not answering. Check your connection.
        </p>
      )}

      {current && !current.failed && results.length === 0 && (
        <p className="menu-note" role="status">No place found with that name.</p>
      )}

      {results.length > 0 && (
        <ul aria-label="Search results">
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => onResult(result)}>
                <b>{result.name}</b>
                {result.region && <small>{result.region}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!searching && !coordinates && (
        <>
          <h2 className="menu-heading">My places</h2>
          {places.length === 0 ? (
            <p className="menu-note">No saved places yet. Search for one, or tap the map and save the point.</p>
          ) : (
            <ul>
              {places.map((place) => (
                <li key={place.id}>
                  <button type="button" aria-current={activeId === place.id} onClick={() => onPlace(place)}>
                    <b>{place.name}</b>
                    {(place.desc || place.region) && <small>{place.desc || place.region}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
