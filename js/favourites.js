/* ============================================================================
   ASTROMAP — Saved places (favourites)

   Star a spot you like and it is kept on this device, so the drive you worked
   out last month is one tap away tonight.

   Two controls, in the two places you would look for them:

     * the star in the inspect panel header saves or unsaves whatever the panel
       is currently showing
     * the star beside the search box opens the list of everything saved

   The list drops down in exactly the same place as the search results, because
   both answer the same question — "where do you want to go?" — and only one of
   them is ever on screen at a time.

   WHERE THIS IS KEPT
   ------------------
   In localStorage, under one key, as JSON. That means:

     * it survives closing the browser
     * it never leaves the machine — there is no account and no server
     * it is per-browser, so your phone and your laptop keep separate lists
     * clearing site data clears it

   localStorage can refuse to store anything at all — private browsing modes
   block it, and it has a size limit — so every write is wrapped and failures
   are reported rather than silently losing your places.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const FAVOURITES_STORAGE_KEY = 'astromap-favourites';

// Two points count as the same place if they agree to four decimal places,
// which is about eleven metres. Exact equality would be too strict: the same
// spot reached by tapping the map and by choosing a search result differs in
// the last few digits, and you would end up with two entries for one place.
const FAVOURITE_MATCH_DECIMALS = 4;

// Where to sit the map when you pick a saved place. Matches the search zoom, so
// arriving somewhere feels the same however you got there.
const FAVOURITE_ZOOM = 11;

/* ----------------------------------------------------------------------------
   State

   What the inspect panel is showing at the moment, so the star knows what it
   would save. Null whenever the panel is closed, which is when the star is
   disabled.
   -------------------------------------------------------------------------- */

let favouriteContext = null;

document.addEventListener('DOMContentLoaded', initializeFavourites);

function initializeFavourites() {
    const star = document.getElementById('favourite-button');
    if (star) {
        star.addEventListener('click', toggleCurrentFavourite);
    }

    const listButton = document.getElementById('favourites-button');
    if (listButton) {
        listButton.addEventListener('click', toggleFavouritesList);
    }

    // Clicking away closes the list, the same way the search results behave.
    document.addEventListener('click', function (event) {
        const panel = document.querySelector('.search-panel');
        if (panel && !panel.contains(event.target)) {
            closeFavourites();
        }
    });

    updateFavouriteButton();
    console.log(`✓ Favourites initialized (${loadFavourites().length} saved)`);
}

/* ============================================================================
   Reading and writing localStorage

   Everything goes through these two functions. localStorage only stores text,
   so the list is turned into JSON on the way out and parsed on the way back.
   ============================================================================ */

/**
 * The saved places, oldest problems and all.
 *
 * Anything unreadable gives an empty list rather than an exception: a corrupted
 * entry should cost you your favourites at worst, never a blank page.
 */
function loadFavourites() {
    try {
        const stored = localStorage.getItem(FAVOURITES_STORAGE_KEY);
        if (!stored) return [];

        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];

        // Filter rather than trust. One malformed entry — hand-edited, or left
        // over from an older version of this file — cannot then break the list.
        return parsed.filter(isUsableFavourite);

    } catch (error) {
        console.warn('Saved places could not be read, starting empty:', error);
        return [];
    }
}

function isUsableFavourite(entry) {
    return Boolean(entry)
        && typeof entry.id === 'string'
        && typeof entry.name === 'string'
        && Number.isFinite(entry.lat)
        && Number.isFinite(entry.lng);
}

/**
 * Write the list back. Returns whether it worked, so callers do not update the
 * screen to show a change that was never actually stored.
 */
function saveFavourites(favourites) {
    try {
        localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(favourites));
        return true;

    } catch (error) {
        // Private browsing refuses to store anything, and storage can be full.
        console.error('✗ Could not save favourites:', error);
        showError('Your saved places could not be stored. Private browsing mode can block this.');
        return false;
    }
}

/* ============================================================================
   What the panel is currently showing

   js/inspect.js calls these as it opens and closes the panel.
   ============================================================================ */

function setFavouriteContext(lat, lng, name) {
    favouriteContext = { lat: lat, lng: lng, name: name || null };
    updateFavouriteButton();
}

function clearFavouriteContext() {
    favouriteContext = null;
    updateFavouriteButton();
}

/* ============================================================================
   Saving and unsaving
   ============================================================================ */

function toggleCurrentFavourite() {
    if (!favouriteContext) return;

    const alreadySaved = findSavedFavourite(favouriteContext);

    if (alreadySaved) {
        removeFavourite(alreadySaved.id);
    } else {
        addFavourite(favouriteContext);
    }
}

function addFavourite(place) {
    const favourites = loadFavourites();

    // Newest first, so the place you just saved is at the top of the list.
    favourites.unshift({
        id: makeFavouriteId(),
        // The place name may still be loading when you press the star, so fall
        // back to the coordinates rather than saving the word "Loading".
        name: place.name || formatCoordinates(place.lat, place.lng),
        lat: place.lat,
        lng: place.lng,
        savedAt: new Date().toISOString()
    });

    if (saveFavourites(favourites)) {
        afterFavouritesChanged();
    }
}

function removeFavourite(id) {
    const remaining = loadFavourites().filter(saved => saved.id !== id);

    if (saveFavourites(remaining)) {
        afterFavouritesChanged();
    }
}

function renameFavourite(id, newName) {
    const favourites = loadFavourites().map(function (saved) {
        if (saved.id !== id) return saved;
        return Object.assign({}, saved, { name: newName });
    });

    if (saveFavourites(favourites)) {
        afterFavouritesChanged();
    }
}

/**
 * Keep the screen in step after any change: the star reflects whether the
 * current place is saved, and an open list redraws itself.
 */
function afterFavouritesChanged() {
    updateFavouriteButton();

    if (isFavouritesListOpen()) {
        renderFavourites();
    }
}

/**
 * A unique id for a saved place.
 *
 * The timestamp alone is not quite enough — saving twice inside one millisecond
 * is unlikely but not impossible — so a short random suffix settles it.
 */
function makeFavouriteId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ----------------------------------------------------------------------------
   Matching a place against what is saved
   -------------------------------------------------------------------------- */

function isSameSpot(a, b) {
    return a.lat.toFixed(FAVOURITE_MATCH_DECIMALS) === b.lat.toFixed(FAVOURITE_MATCH_DECIMALS)
        && a.lng.toFixed(FAVOURITE_MATCH_DECIMALS) === b.lng.toFixed(FAVOURITE_MATCH_DECIMALS);
}

function findSavedFavourite(place) {
    return loadFavourites().find(saved => isSameSpot(saved, place)) || null;
}

/* ============================================================================
   The star in the inspect panel header
   ============================================================================ */

function updateFavouriteButton() {
    const button = document.getElementById('favourite-button');
    if (!button) return;

    // Nothing selected, so there is nothing for the star to act on.
    if (!favouriteContext) {
        button.disabled = true;
        button.setAttribute('aria-pressed', 'false');
        button.title = 'Select a place first';
        button.setAttribute('aria-label', 'Select a place first');
        return;
    }

    const saved = findSavedFavourite(favouriteContext);
    const label = saved ? 'Remove from saved places' : 'Save this place';

    button.disabled = false;
    // CSS fills the star in when this is true — see .icon-star in styles.css.
    button.setAttribute('aria-pressed', saved ? 'true' : 'false');
    button.title = label;
    button.setAttribute('aria-label', label);
}

/* ============================================================================
   The list of saved places
   ============================================================================ */

function toggleFavouritesList() {
    if (isFavouritesListOpen()) {
        closeFavourites();
    } else {
        renderFavourites();
    }
}

function isFavouritesListOpen() {
    const list = document.getElementById('favourites-list');
    return Boolean(list && list.children.length > 0);
}

function closeFavourites() {
    const list = document.getElementById('favourites-list');
    if (list) list.innerHTML = '';

    const button = document.getElementById('favourites-button');
    if (button) button.setAttribute('aria-expanded', 'false');
}

function renderFavourites() {
    const list = document.getElementById('favourites-list');
    if (!list) return;

    // The two dropdowns share one slot under the search bar, so putting saved
    // places up means taking search results down. clearSearchResults() lives in
    // js/search.js.
    clearSearchResults();

    list.innerHTML = '';

    const favourites = loadFavourites();

    if (favourites.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'favourite-empty';
        empty.textContent = 'No saved places yet. Choose a spot on the map, then press the star.';
        list.appendChild(empty);
    } else {
        favourites.forEach(favourite => list.appendChild(buildFavouriteRow(favourite)));
    }

    const button = document.getElementById('favourites-button');
    if (button) button.setAttribute('aria-expanded', 'true');
}

/**
 * One row: the place itself as a big button, with rename and remove beside it.
 *
 * Built with createElement rather than innerHTML, like the rest of the app.
 * Saved names are typed by the user, and building nodes directly means that
 * text can never be treated as markup.
 */
function buildFavouriteRow(favourite) {
    const row = document.createElement('li');
    row.className = 'favourite';

    // Going there is the main action, so it fills the row.
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'favourite-go';
    go.addEventListener('click', () => goToFavourite(favourite));

    const name = document.createElement('span');
    name.className = 'favourite-name';
    name.textContent = favourite.name;

    const coords = document.createElement('span');
    coords.className = 'favourite-coords';
    coords.textContent = formatCoordinates(favourite.lat, favourite.lng);

    go.append(name, coords);

    const rename = buildRowButton('Rename', PENCIL_ICON_PATH, () => startRenaming(favourite, row));
    const remove = buildRowButton('Remove', TRASH_ICON_PATH, () => removeFavourite(favourite.id));

    row.append(go, rename, remove);
    return row;
}

function buildRowButton(label, iconPath, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button-small';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    button.appendChild(makeIcon(iconPath));
    return button;
}

/* ----------------------------------------------------------------------------
   Icons

   Drawn as SVG in currentColor rather than written as emoji, so they take the
   theme's colour. An emoji pencil would stay full-colour in Astronomer mode,
   which is exactly what that theme exists to prevent.

   SVG elements have to be created with createElementNS, not createElement:
   they live in their own XML namespace, and an <svg> made the ordinary way
   renders as nothing at all.
   -------------------------------------------------------------------------- */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const PENCIL_ICON_PATH = 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z';
const TRASH_ICON_PATH = 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6';

function makeIcon(pathData) {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', pathData);

    svg.appendChild(path);
    return svg;
}

/* ============================================================================
   Renaming, in place

   A browser prompt() would be three lines instead of thirty, but it throws you
   out of the app into a system dialog that cannot be styled or themed, and on
   some phones it is genuinely unpleasant. Swapping the row for a text box keeps
   everything where it is.

   Enter keeps the new name, Escape abandons it, and clicking away keeps it —
   losing what someone just typed because they tapped elsewhere is the more
   annoying of the two possible defaults.
   ============================================================================ */

function startRenaming(favourite, row) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'favourite-rename';
    input.value = favourite.name;
    input.setAttribute('aria-label', 'New name for this place');

    // Saving redraws the whole list, which removes this input and fires its
    // blur handler a second time. This flag makes sure only the first finish
    // counts.
    let finished = false;

    function finish(keepIt) {
        if (finished) return;
        finished = true;

        const newName = input.value.trim();

        if (keepIt && newName) {
            renameFavourite(favourite.id, newName);
        } else {
            // Cancelled, or left blank — an empty name would leave a row you
            // could not identify, so put the list back as it was.
            renderFavourites();
        }
    }

    input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
        }
    });

    input.addEventListener('blur', () => finish(true));

    // The row becomes just the text box while editing. The class switches the
    // row out of its three-column grid so the box can fill the width.
    row.innerHTML = '';
    row.className = 'favourite favourite-editing';
    row.appendChild(input);

    input.focus();
    input.select();
}

/* ============================================================================
   Going to a saved place
   ============================================================================ */

function goToFavourite(favourite) {
    closeFavourites();

    // Exactly what choosing a search result does, so arriving somewhere feels
    // the same however you got there. Both helpers live in other files:
    // flyToLocation in js/map.js, inspectChosenLocation in js/inspect.js.
    flyToLocation(favourite.lat, favourite.lng, FAVOURITE_ZOOM);
    inspectChosenLocation(favourite.lat, favourite.lng);
}

/* ----------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function formatCoordinates(lat, lng) {
    return `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
}
