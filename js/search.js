/* ============================================================================
   ASTROMAP — Search and "Use my location"

   Two ways to get to a place without hunting for it on the map:

     1. Type a suburb, city or state and pick from the results
     2. Press the crosshair button and let the browser share your location

   Either way the map flies there and the inspect panel opens for that point,
   so searching feels exactly like tapping the map yourself.

   BEING A GOOD CITIZEN — PLEASE READ BEFORE CHANGING THIS
   -------------------------------------------------------
   Place names come from Nominatim, which the OpenStreetMap Foundation runs for
   free. Their usage policy is short and worth reading:
   https://operations.osmfoundation.org/policies/nominatim/

   Two rules shape the whole design of this file:

     * "Auto-complete search ... you must not implement such a service on the
       client side using the API." It is listed under Unacceptable Use, and it
       is the kind of thing that gets an application blocked. So there is NO
       search-as-you-type here. We only call the API when you press Enter or
       the search button. This is the single most tempting change to make to
       this file, and the one you must not make.

     * "No heavy uses (an absolute maximum of 1 request per second)." We hold
       ourselves to that in waitForRateLimit(), and we cache every answer so
       repeating a search costs nothing.

   Attribution is shown under the results, which the policy also requires.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const NOMINATIM_SEARCH_API = 'https://nominatim.openstreetmap.org/search';

// Five is enough to find what you meant without burying you in options.
const SEARCH_RESULT_LIMIT = 5;

// Nominatim's hard limit is one request per second. We never go faster.
const SEARCH_MIN_INTERVAL = 1000;

// How far to zoom for a result with no sensible bounding box. Roughly
// "town and its surroundings", which suits picking a spot to drive to.
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

// Remembering answers means searching "Katoomba" twice costs one request, not
// two. Keyed by the lower-cased query.
const searchCache = new Map();
const MAX_CACHED_SEARCHES = 20;

// When the last request actually went out, so we can space them properly.
let lastSearchAt = 0;

document.addEventListener('DOMContentLoaded', initializeSearch);

/* ============================================================================
   Wiring up
   ============================================================================ */

function initializeSearch() {
    const form = document.getElementById('search-form');
    const locateButton = document.getElementById('locate-button');
    const panel = document.querySelector('.search-panel');

    if (form) {
        form.addEventListener('submit', function (event) {
            // Without this the browser reloads the page on Enter and everything
            // you were looking at disappears.
            event.preventDefault();

            const input = document.getElementById('search-input');
            runSearch(input ? input.value : '');
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
   ============================================================================ */

async function runSearch(rawQuery) {
    const query = rawQuery.trim();

    clearSearchResults();

    if (!query) {
        setSearchStatus('');
        return;
    }

    const searchButton = document.getElementById('search-button');
    setButtonBusy(searchButton, true);
    setSearchStatus('Searching…');

    try {
        const places = await fetchPlaces(query);

        // null and [] mean different things, and the user deserves to know
        // which happened: one is "we could not ask", the other is "we asked
        // and there is nothing there".
        if (places === null) {
            setSearchStatus('Search is unavailable right now. The map still works.');
            return;
        }

        if (places.length === 0) {
            setSearchStatus(`No places found for “${query}”.`);
            return;
        }

        setSearchStatus('');
        renderSearchResults(places);

    } finally {
        // Runs whether the search worked, failed or returned nothing, so the
        // button can never be left stuck in its busy state.
        setButtonBusy(searchButton, false);
    }
}

/**
 * Ask Nominatim for places matching a query.
 *
 * Returns an array of results, or null if the request itself failed.
 */
async function fetchPlaces(query) {
    const key = query.toLowerCase();

    if (searchCache.has(key)) {
        console.log(`Reusing cached search for “${query}”`);
        return searchCache.get(key);
    }

    await waitForRateLimit();

    try {
        const params = new URLSearchParams({
            q: query,
            format: 'json',
            limit: String(SEARCH_RESULT_LIMIT),
            addressdetails: '1',
            'accept-language': 'en'
        });

        // As with the reverse lookup in inspect.js, browsers will not let us set
        // a custom User-Agent, so we identify ourselves by the Referer the
        // browser sends automatically and by keeping our request rate low.
        const response = await fetch(`${NOMINATIM_SEARCH_API}?${params}`, {
            headers: { 'Accept-Language': 'en' }
        });

        if (!response.ok) {
            throw new Error(`Nominatim returned ${response.status}`);
        }

        const places = await response.json();
        rememberSearch(key, places);
        return places;

    } catch (error) {
        console.error('✗ Nominatim search error:', error);
        return null;
    }
}

/**
 * Hold off until at least a second has passed since the last request, then
 * mark this moment as the newest one.
 */
async function waitForRateLimit() {
    const sinceLast = Date.now() - lastSearchAt;
    const stillToWait = SEARCH_MIN_INTERVAL - sinceLast;

    if (stillToWait > 0) {
        await new Promise(resolve => setTimeout(resolve, stillToWait));
    }

    lastSearchAt = Date.now();
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
        const item = document.createElement('li');

        // A real <button> gets keyboard focus, Enter and the space bar for
        // free. Faking that on a <div> with ARIA is more code and worse.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-result';
        button.addEventListener('click', () => chooseSearchResult(place));

        const name = document.createElement('span');
        name.className = 'search-result-name';
        name.textContent = shortPlaceName(place.display_name);

        const detail = document.createElement('span');
        detail.className = 'search-result-detail';
        detail.textContent = [describePlaceKind(place), restOfPlaceName(place.display_name)]
            .filter(Boolean)
            .join(' · ');

        button.append(name, detail);
        item.appendChild(button);
        list.appendChild(item);
    });

    list.appendChild(buildSearchAttribution());
}

/** Required by Nominatim's usage policy: credit shown wherever results are. */
function buildSearchAttribution() {
    const credit = document.createElement('li');
    credit.className = 'search-attribution';

    const link = document.createElement('a');
    link.href = 'https://nominatim.openstreetmap.org/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Nominatim / OpenStreetMap';

    credit.append(document.createTextNode('Search by '), link);
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
   Tidying up Nominatim's display_name

   It arrives as one long line, most specific first:
       "Katoomba, New South Wales, 2780, Australia"

   The first part makes a good heading and the rest makes a good subtitle.
   -------------------------------------------------------------------------- */

function shortPlaceName(displayName) {
    return displayName.split(',')[0].trim();
}

function restOfPlaceName(displayName) {
    return displayName
        .split(',')
        .slice(1)
        .map(part => part.trim())
        .join(', ');
}

/**
 * What kind of place is this? Nominatim's own words are database-ish
 * ("administrative", "protected_area"), so the common ones get plain English
 * and anything unexpected is tidied up rather than hidden.
 */
const PLACE_KIND_LABELS = {
    city: 'City',
    town: 'Town',
    village: 'Village',
    hamlet: 'Hamlet',
    suburb: 'Suburb',
    neighbourhood: 'Neighbourhood',
    county: 'County',
    state: 'State',
    region: 'Region',
    province: 'Province',
    country: 'Country',
    municipality: 'Municipality',
    administrative: 'Administrative area',
    national_park: 'National park',
    protected_area: 'Protected area',
    nature_reserve: 'Nature reserve',
    peak: 'Peak'
};

function describePlaceKind(place) {
    const kind = place.addresstype || place.type || '';

    if (PLACE_KIND_LABELS[kind]) {
        return PLACE_KIND_LABELS[kind];
    }

    if (!kind) return 'Place';

    // "railway_station" -> "Railway station"
    const spaced = kind.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ============================================================================
   Choosing a result
   ============================================================================ */

function chooseSearchResult(place) {
    const lat = parseFloat(place.lat);
    const lng = parseFloat(place.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setSearchStatus('That result has no usable coordinates.');
        return;
    }

    clearSearchResults();
    setSearchStatus('');

    // Leave the chosen name in the box so it is obvious what you are looking at.
    const input = document.getElementById('search-input');
    if (input) input.value = shortPlaceName(place.display_name);

    zoomToPlace(place, lat, lng);
    inspectChosenLocation(lat, lng);
}

/**
 * Frame the result properly.
 *
 * Nominatim returns a bounding box, which is far better than a fixed zoom: a
 * whole state fills the screen, a village does not end up at street level.
 * Falls back to a plain fly-to if the box is missing or malformed.
 */
function zoomToPlace(place, lat, lng) {
    const box = place.boundingbox;

    if (map && Array.isArray(box) && box.length === 4) {
        // Nominatim's order is [minLat, maxLat, minLon, maxLon], as strings.
        const south = Number(box[0]);
        const north = Number(box[1]);
        const west = Number(box[2]);
        const east = Number(box[3]);

        if ([south, north, west, east].every(Number.isFinite)) {
            map.fitBounds([[west, south], [east, north]], {
                padding: 40,
                maxZoom: SEARCH_MAX_ZOOM,
                duration: 1500
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
