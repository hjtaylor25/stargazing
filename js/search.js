/* ============================================================================
   ASTROMAP — Search and "Use my location"

   Two ways to get to a place without hunting for it on the map:

     1. Start typing and pick from the suggestions
     2. Press the crosshair button and let the browser share your location

   Either way the map flies there and the inspect panel opens for that point,
   so searching feels exactly like tapping the map yourself.

   WHY PHOTON AND NOT NOMINATIM
   ----------------------------
   Place names come from Photon, an OpenStreetMap geocoder run by Komoot:
   https://photon.komoot.io

   The obvious choice would have been Nominatim, which this app already uses to
   turn coordinates back into a place name. It cannot be used here. Nominatim's
   usage policy lists auto-complete under "Unacceptable Use" — "you must not
   implement such a service on the client side using the API" — and doing it
   anyway is the kind of thing that gets an application blocked.
   https://operations.osmfoundation.org/policies/nominatim/

   Photon exists precisely for this job. Its own description is "search-as-you-
   type with OpenStreetMap", typeahead is a listed feature, it needs no API key,
   and its terms are simply: "You can use the API for your project, but please
   be fair - extensive usage will be throttled."

   So the split is: Photon answers "what is this place called that I am typing",
   Nominatim answers "what is the name of this point I tapped" (see inspect.js).
   Both are OpenStreetMap data, and both are credited.

   BEING FAIR TO A FREE SERVICE
   ----------------------------
   Typing sends requests, so four things keep the traffic sensible:

     * nothing is sent until you pause typing for a moment (the debounce)
     * nothing is sent for one or two characters, which would match half the
       world anyway
     * a request still in flight is cancelled the moment you type again, so we
       never leave work running that nobody is waiting for
     * every answer is cached, so backspacing costs nothing
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const PHOTON_SEARCH_API = 'https://photon.komoot.io/api/';

// Six is enough to find what you meant without burying you in options.
const SEARCH_RESULT_LIMIT = 6;

// How long to wait after the last keystroke before asking Photon anything.
// Long enough that typing a word is one request rather than eight; short
// enough that the list still feels like it is keeping up.
const SUGGEST_DEBOUNCE_DELAY = 300;

// Below this, a query matches so much that the results are useless.
const SEARCH_MIN_CHARACTERS = 3;

// Photon indexes all of OpenStreetMap, streets and bus stops included. A road
// is never the answer to "where shall I drive tonight", and road names crowd
// out real places, so this one category is dropped. Everything else is kept:
// Photon's own ranking is good — it puts the state first for "New South Wales"
// and Siding Spring Observatory first for "Siding Spring" — and the kind label
// under each result makes anything unexpected obvious at a glance.
const SEARCH_EXCLUDED_KEYS = ['highway'];

// How far to zoom for a result with no bounding box. Roughly "town and its
// surroundings", which suits picking a spot to drive to.
const SEARCH_ZOOM = 11;

// Never zoom closer than this when fitting a result's bounding box, or
// searching a small village would drop you into individual streets.
const SEARCH_MAX_ZOOM = 12;

const GEOLOCATION_OPTIONS = {
    // A rough fix is plenty for choosing somewhere to stargaze. Asking for high
    // accuracy switches on GPS, which is slower and eats battery for no gain.
    enableHighAccuracy: false,
    timeout: 10000,
    // A fix from the last five minutes is fine; no need to wake the hardware.
    maximumAge: 300000
};

/* ----------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

// Remembering answers means backspacing through a word costs nothing.
const searchCache = new Map();
const MAX_CACHED_SEARCHES = 40;

// Counts down after each keystroke; only the last one actually fires.
let suggestTimer = null;

// The request currently in flight, so a new keystroke can cancel it.
let inFlightSearch = null;

document.addEventListener('DOMContentLoaded', initializeSearch);

/* ============================================================================
   Wiring up
   ============================================================================ */

function initializeSearch() {
    const form = document.getElementById('search-form');
    const input = document.getElementById('search-input');
    const locateButton = document.getElementById('locate-button');
    const panel = document.querySelector('.search-panel');

    if (form) {
        form.addEventListener('submit', function (event) {
            // Without this the browser reloads the page on Enter and everything
            // you were looking at disappears.
            event.preventDefault();

            // Enter means "I have finished typing", so skip the wait.
            clearTimeout(suggestTimer);
            runSearch(input ? input.value : '', false);
        });
    }

    if (input) {
        // Suggestions as you type. The `input` event covers pasting and
        // dictation as well as typing, which `keyup` would miss.
        input.addEventListener('input', function () {
            clearTimeout(suggestTimer);

            const query = this.value.trim();

            if (query.length < SEARCH_MIN_CHARACTERS) {
                clearSearchResults();
                setSearchStatus('');
                return;
            }

            suggestTimer = setTimeout(() => runSearch(query, true), SUGGEST_DEBOUNCE_DELAY);
        });
    }

    if (locateButton) {
        locateButton.addEventListener('click', useMyLocation);
    }

    // Arrow keys and Escape inside the search panel.
    if (panel) {
        panel.addEventListener('keydown', handleSearchKeys);
    }

    // Clicking anywhere else puts the results away, which is what people
    // expect from a dropdown.
    document.addEventListener('click', function (event) {
        if (panel && !panel.contains(event.target)) {
            clearSearchResults();
        }
    });

    console.log('✓ Search initialized');
}

/* ============================================================================
   Running a search

   `quiet` is true for suggestions typed into the box and false when the search
   button or Enter was used. The only difference is the spinner: flashing it on
   and off with every pause in typing is more distracting than helpful.
   ============================================================================ */

async function runSearch(rawQuery, quiet) {
    const query = rawQuery.trim();

    // Whatever was in flight is answering an older question now.
    cancelInFlightSearch();

    clearSearchResults();

    // Saved places share this dropdown slot, so putting results up means
    // taking that list down. closeFavourites() lives in js/favourites.js.
    closeFavourites();

    if (query.length < SEARCH_MIN_CHARACTERS) {
        setSearchStatus(query ? `Type at least ${SEARCH_MIN_CHARACTERS} characters.` : '');
        return;
    }

    const searchButton = document.getElementById('search-button');
    if (!quiet) setButtonBusy(searchButton, true);
    setSearchStatus('Searching…');

    try {
        const places = await fetchPlaces(query);

        if (places.length === 0) {
            setSearchStatus(`No places found for “${query}”.`);
            return;
        }

        setSearchStatus('');
        renderSearchResults(places);

    } catch (error) {
        // A newer keystroke replaced this request. That is not a failure, and
        // the newer one is already updating the screen, so say nothing.
        if (error.name === 'AbortError') return;

        console.error('✗ Photon search error:', error);
        setSearchStatus('Search is unavailable right now. The map still works.');

    } finally {
        if (!quiet) setButtonBusy(searchButton, false);
    }
}

function cancelInFlightSearch() {
    if (inFlightSearch) {
        inFlightSearch.abort();
        inFlightSearch = null;
    }
}

/**
 * Ask Photon for places matching a query.
 *
 * Throws if the request fails or is cancelled; returns an array otherwise,
 * which may legitimately be empty.
 */
async function fetchPlaces(query) {
    // Results are biased towards wherever the map is looking, so someone in
    // Australia typing "katoo" gets Katoomba rather than a village in Laos.
    // The bias is part of the cache key, rounded to whole degrees so that
    // nudging the map does not throw the cache away.
    const bias = getMapCenter();
    const key = bias
        ? `${query.toLowerCase()}@${Math.round(bias.lat)},${Math.round(bias.lng)}`
        : query.toLowerCase();

    if (searchCache.has(key)) {
        return searchCache.get(key);
    }

    const parameters = {
        q: query,
        limit: String(SEARCH_RESULT_LIMIT),
        lang: 'en'
    };

    if (bias) {
        parameters.lat = bias.lat.toFixed(4);
        parameters.lon = bias.lng.toFixed(4);
    }

    // AbortController lets us call off a request we no longer care about.
    const controller = new AbortController();
    inFlightSearch = controller;

    const params = new URLSearchParams(parameters);
    const response = await fetch(`${PHOTON_SEARCH_API}?${params}`, { signal: controller.signal });

    if (!response.ok) {
        throw new Error(`Photon returned ${response.status}`);
    }

    const data = await response.json();
    const places = (data.features || []).filter(isUsefulPlace);

    rememberSearch(key, places);
    return places;
}

/** Drop the categories that are never a destination — see SEARCH_EXCLUDED_KEYS. */
function isUsefulPlace(feature) {
    const properties = feature.properties || {};
    return !SEARCH_EXCLUDED_KEYS.includes(properties.osm_key);
}

/** Store a result, dropping the oldest once the cache is full. */
function rememberSearch(key, places) {
    if (searchCache.size >= MAX_CACHED_SEARCHES) {
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
    }
    searchCache.set(key, places);
}

/* ============================================================================
   Showing the results

   Built with createElement rather than innerHTML. Place names come from the
   internet, and building nodes directly means none of that text can ever be
   treated as markup.
   ============================================================================ */

function renderSearchResults(places) {
    const list = document.getElementById('search-results');
    if (!list) return;

    list.innerHTML = '';

    places.forEach(function (place) {
        const properties = place.properties || {};

        const item = document.createElement('li');

        // A real <button> gets keyboard focus, Enter and the space bar for
        // free. Faking that on a <div> with ARIA is more code and worse.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-result';
        button.addEventListener('click', () => chooseSearchResult(place));

        const name = document.createElement('span');
        name.className = 'search-result-name';
        name.textContent = placeName(properties);

        const detail = document.createElement('span');
        detail.className = 'search-result-detail';
        detail.textContent = [describePlaceKind(properties), describePlaceLocation(properties)]
            .filter(Boolean)
            .join(' · ');

        button.append(name, detail);
        item.appendChild(button);
        list.appendChild(item);
    });

    list.appendChild(buildSearchAttribution());
}

/** Photon serves OpenStreetMap data; both deserve the credit. */
function buildSearchAttribution() {
    const credit = document.createElement('li');
    credit.className = 'search-attribution';

    const photon = document.createElement('a');
    photon.href = 'https://photon.komoot.io/';
    photon.target = '_blank';
    photon.rel = 'noopener';
    photon.textContent = 'Photon';

    const osm = document.createElement('a');
    osm.href = 'https://www.openstreetmap.org/copyright';
    osm.target = '_blank';
    osm.rel = 'noopener';
    osm.textContent = 'OpenStreetMap';

    credit.append(document.createTextNode('Search by '), photon,
                  document.createTextNode(' · data © '), osm);
    return credit;
}

function clearSearchResults() {
    const list = document.getElementById('search-results');
    if (list) list.innerHTML = '';
}

function setSearchStatus(message) {
    const status = document.getElementById('search-status');
    if (status) status.textContent = message;
}

/**
 * Show a button as working. The CSS spins its icon and the disabled state
 * stops a second click landing while the first is still in flight.
 */
function setButtonBusy(button, busy) {
    if (!button) return;
    button.classList.toggle('is-busy', busy);
    button.disabled = busy;
}

/* ----------------------------------------------------------------------------
   Turning Photon's properties into something readable

   Photon returns structured fields rather than one long line:
       { name: "Katoomba", state: "New South Wales", country: "Australia",
         osm_key: "place", osm_value: "town" }
   -------------------------------------------------------------------------- */

function placeName(properties) {
    return properties.name || properties.city || properties.state || 'Unnamed place';
}

/**
 * The line under the name: where in the world this is. Anything that simply
 * repeats the name is skipped, so "Katoomba" does not read "Katoomba, Katoomba".
 */
function describePlaceLocation(properties) {
    const parts = [];

    ['city', 'county', 'state', 'country'].forEach(function (field) {
        const value = properties[field];
        if (value && value !== properties.name && !parts.includes(value)) {
            parts.push(value);
        }
    });

    return parts.join(', ');
}

/**
 * What kind of place is this? OpenStreetMap's own words are database-ish
 * ("nature_reserve", "administrative"), so the common ones get plain English
 * and anything unexpected is tidied up rather than hidden.
 */
const PLACE_KIND_LABELS = {
    city: 'City',
    town: 'Town',
    village: 'Village',
    hamlet: 'Hamlet',
    suburb: 'Suburb',
    neighbourhood: 'Neighbourhood',
    locality: 'Locality',
    county: 'County',
    state: 'State',
    region: 'Region',
    province: 'Province',
    country: 'Country',
    municipality: 'Municipality',
    administrative: 'Administrative area',
    national_park: 'National park',
    nature_reserve: 'Nature reserve',
    protected_area: 'Protected area',
    park: 'Park',
    viewpoint: 'Viewpoint',
    camp_site: 'Campsite',
    peak: 'Peak',
    station: 'Station'
};

function describePlaceKind(properties) {
    const kind = properties.osm_value || properties.osm_key || '';

    if (PLACE_KIND_LABELS[kind]) {
        return PLACE_KIND_LABELS[kind];
    }

    if (!kind) return 'Place';

    // "nature_reserve" -> "Nature reserve"
    const spaced = kind.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ============================================================================
   Choosing a result
   ============================================================================ */

function chooseSearchResult(place) {
    const properties = place.properties || {};
    // GeoJSON puts coordinates in [longitude, latitude] order — the opposite
    // way round from how they are usually spoken.
    const coordinates = (place.geometry && place.geometry.coordinates) || [];
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setSearchStatus('That result has no usable coordinates.');
        return;
    }

    clearSearchResults();
    setSearchStatus('');

    // Leave the chosen name in the box so it is obvious what you are looking at.
    const input = document.getElementById('search-input');
    if (input) input.value = placeName(properties);

    zoomToPlace(properties, lat, lng);
    inspectChosenLocation(lat, lng);
}

/**
 * Frame the result properly.
 *
 * Photon gives an `extent` for anything with an area, which is far better than
 * a fixed zoom: a whole state fills the screen, a village does not end up at
 * street level. Falls back to a plain fly-to when there is no extent, which is
 * the case for single points like a viewpoint.
 */
function zoomToPlace(properties, lat, lng) {
    const extent = properties.extent;

    if (map && Array.isArray(extent) && extent.length === 4) {
        // Photon's order is [west, north, east, south].
        const west = Number(extent[0]);
        const north = Number(extent[1]);
        const east = Number(extent[2]);
        const south = Number(extent[3]);

        if ([west, north, east, south].every(Number.isFinite)) {
            map.fitBounds([[west, south], [east, north]], {
                padding: 40,
                maxZoom: SEARCH_MAX_ZOOM,
                duration: mapMoveDuration(1500)
            });
            return;
        }
    }

    flyToLocation(lat, lng, SEARCH_ZOOM);
}

/* ============================================================================
   "Use my location"

   The browser asks the user for permission; we never see their location unless
   they agree. Every way that can go wrong ends in a plain-English message that
   also points at the alternative, because a dead end with no suggestion is the
   most annoying thing an app can do.
   ============================================================================ */

function useMyLocation() {
    const button = document.getElementById('locate-button');

    if (!navigator.geolocation) {
        setSearchStatus('This browser cannot share your location. Try searching for a place instead.');
        return;
    }

    // Browsers only hand out location on a secure connection. localhost counts
    // as secure, so this only bites on a plain http:// site — worth saying
    // clearly rather than letting it fail with a vague permission error.
    if (!window.isSecureContext) {
        setSearchStatus('Location needs a secure (https) connection. Try searching for a place instead.');
        return;
    }

    setButtonBusy(button, true);
    setSearchStatus('Finding your location…');
    clearSearchResults();

    navigator.geolocation.getCurrentPosition(
        function (position) {
            setButtonBusy(button, false);
            setSearchStatus('');

            const lat = position.coords.latitude;
            const lng = position.coords.longitude;

            flyToLocation(lat, lng, SEARCH_ZOOM);
            inspectChosenLocation(lat, lng);
        },
        function (error) {
            setButtonBusy(button, false);
            setSearchStatus(describeGeolocationError(error));
        },
        GEOLOCATION_OPTIONS
    );
}

/**
 * Turn a GeolocationPositionError into something worth reading.
 *
 * The codes are compared against the names on the error object rather than the
 * bare numbers 1, 2 and 3, which say nothing to someone reading this later.
 */
function describeGeolocationError(error) {
    if (error.code === error.PERMISSION_DENIED) {
        return 'Location permission was denied. You can still search for a place by name.';
    }

    if (error.code === error.POSITION_UNAVAILABLE) {
        return 'Your device could not work out where it is. Try searching for a place instead.';
    }

    if (error.code === error.TIMEOUT) {
        return 'Finding your location took too long. Try again, or search for a place.';
    }

    return 'Could not get your location. Try searching for a place instead.';
}

/* ============================================================================
   Keyboard support

   Tab already works, because every result is a real button. This adds the
   shortcuts people expect from a search box on top of that.
   ============================================================================ */

function handleSearchKeys(event) {
    const input = document.getElementById('search-input');
    const buttons = Array.from(document.querySelectorAll('.search-result'));

    if (event.key === 'Escape') {
        clearSearchResults();
        setSearchStatus('');
        if (input) input.focus();
        return;
    }

    if (buttons.length === 0) return;

    // -1 when focus is still in the text box.
    const current = buttons.indexOf(document.activeElement);

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = current < 0 ? 0 : Math.min(current + 1, buttons.length - 1);
        buttons[next].focus();
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        // Going up past the first result puts you back in the text box.
        if (current <= 0) {
            if (input) input.focus();
        } else {
            buttons[current - 1].focus();
        }
    }
}
