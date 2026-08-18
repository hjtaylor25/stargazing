/* ============================================================================
   ASTROMAP — Map Initialization and Management
   
   This file sets up MapLibre GL JS with:
   - A free, no-key basemap (Carto dark raster tiles)
   - Full-screen interactive map with smooth pan/zoom
   - Attribution for the basemap and any overlays
   - Error handling with user-friendly messages
   - Basic interaction setup for future features
   
   MapLibre GL is a free, open-source fork of Mapbox GL.
   Documentation: https://maplibre.org/maplibre-gl-js/docs/
   ============================================================================ */

// Global map instance — accessible to other scripts
let map = null;

// Initialize map when the page loads
document.addEventListener('DOMContentLoaded', initializeMap);

/* ============================================================================
   Main initialization function
   ============================================================================ */

function initializeMap() {
    // Show the loading spinner while map initializes
    showLoader(true);

    try {
        // Create the map instance
        // We're using OpenFreeMap's dark-matter raster tiles, which:
        // - Require no API key
        // - Are free for personal and commercial use
        // - Include proper attribution
        // - Are actively maintained by volunteers
        
        map = new maplibregl.Map({
            container: 'map',
            // The style uses Carto's basemaps, which are:
            // - Free raster tiles (no API key required)
            // - Actively maintained by Carto
            // - Perfect for astronomy (dark_all is very dark and good for night sky)
            // - Well-tested and reliable
            // See: https://carto.com/basemaps/
            style: {
                version: 8,
                sources: {
                    'carto-dark': {
                        type: 'raster',
                        tiles: [
                            'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-b.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-c.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png',
                            'https://cartodb-basemaps-d.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png'
                        ],
                        tileSize: 256,
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    }
                },
                layers: [
                    {
                        id: 'carto-base',
                        type: 'raster',
                        source: 'carto-dark'
                    }
                ]
            },
            
            // Initial view: centered on Australia
            // (the user can change this with search/geolocation)
            center: [133.7751, -25.2744],
            zoom: 4,
            
            // Allow the map to take up the full container
            bounds: undefined,
            
            // Enable smooth interactions
            pitch: 0,
            bearing: 0,
            
            // Attribution, kept out of the way.
            //
            // `compact: true` asks for a small circled-i button rather than a
            // bar of credits across the bottom of the map, which MapLibre would
            // otherwise show on any window wider than 640 pixels.
            //
            // The attribution itself is not optional — OpenStreetMap and CARTO
            // both require it — so the button stays visible at all times and one
            // click opens the full credits. This is MapLibre's own supported
            // way of presenting it.
            attributionControl: { compact: true },

            // Keeps the position in the address bar as #zoom/lat/lng, so a
            // reload puts you back where you were and you can send someone a
            // link to exactly the spot you are looking at. MapLibre reads it on
            // startup and rewrites it as you pan, using replaceState so panning
            // does not fill up the back button.
            hash: true
        });

        // Add basic UI controls
        // Navigation: zoom buttons and compass
        map.addControl(new maplibregl.NavigationControl(), 'top-right');

        // There is deliberately no MapLibre GeolocateControl here.
        //
        // js/search.js provides our own "use my location" button, sitting with
        // the search box where you would look for it. Keeping MapLibre's as
        // well would put two buttons that do the same thing on screen, and its
        // failure messages are generic browser text we cannot reword — whereas
        // ours explains what to do when permission is denied.

        // Listen for map load completion
        map.on('load', function() {
            console.log('✓ Map loaded successfully');
            hideLoader();
            collapseAttribution();
        });

        // Catch and report errors gracefully.
        //
        // One important exception: a missing tile is normal, not a failure.
        // The light pollution atlas simply does not publish a tile for squares
        // that contain no artificial light at all, so the darkest parts of the
        // world return 404. Showing the user an error banner every time they
        // pan over the outback would be both wrong and very annoying.
        map.on('error', function(e) {
            const isMissingTile = e.error && e.error.status === 404;

            if (isMissingTile) {
                console.debug('Tile not published (this is expected):', e.error.url);
                return;
            }

            console.error('Map error:', e.error);
            showError('Map encountered an error. The map may be partially unavailable.');
        });

    } catch (error) {
        console.error('Failed to initialize map:', error);
        hideLoader();
        showError('Failed to load the map. Please refresh the page.');
    }
}

/* ============================================================================
   Collapsing the attribution

   Asking for `compact: true` is not quite enough on its own. The first time
   MapLibre lays the control out it adds BOTH `maplibregl-compact` and
   `maplibregl-compact-show` and sets the `open` attribute, so the credits start
   expanded and only tuck themselves away once you drag the map. Until then a
   pale bar sits over the corner of the map, which is glaring in the dark themes
   and covers part of the view.

   Undoing those two things here collapses it immediately, leaving just the
   circled-i button. MapLibre's own click handler puts them back when that
   button is pressed, so opening the credits still works exactly as normal —
   this only changes the state it starts in.
   ============================================================================ */

function collapseAttribution() {
    const attribution = document.querySelector('.maplibregl-ctrl-attrib');
    if (!attribution) return;

    attribution.classList.remove('maplibregl-compact-show');
    attribution.removeAttribute('open');
}

/* ============================================================================
   Theming the map

   There is deliberately no JavaScript here.

   The Astronomer theme needs the map itself to be monochrome red. That used to
   be attempted with MapLibre paint properties (raster-saturation and friends),
   but paint properties can only desaturate — they cannot recolour — so the map
   came out grey, and grey and white are exactly what that theme must not show.

   css/styles.css now does the whole job with one filter on the map canvas,
   which handles the basemap and the light pollution overlay together and
   cannot get out of step with the rest of the UI. Changing the map's
   appearance per theme is a stylesheet edit, not a code edit.
   ============================================================================ */

/* ============================================================================
   Waiting for the map

   The other scripts (light pollution, inspect panel) cannot touch the map
   until MapLibre has finished loading its style. This helper checks every
   100 ms and runs the callback as soon as the map is ready.

   Polling is used rather than a 'style.load' listener because a listener
   registered after the event has already fired would never run at all, which
   is a genuinely confusing bug to track down. It lives here in map.js so
   there is exactly one copy of it.
   ============================================================================ */

function waitForMapReady(callback) {
    if (map && map.isStyleLoaded()) {
        callback();
        return;
    }
    setTimeout(() => waitForMapReady(callback), 100);
}

/* ============================================================================
   UI Helper functions
   ============================================================================ */

/**
 * Show or hide the loading spinner
 */
function showLoader(show = true) {
    const loader = document.getElementById('loader');
    if (show) {
        loader.classList.remove('hidden');
    } else {
        loader.classList.add('hidden');
    }
}

function hideLoader() {
    showLoader(false);
}

/**
 * Display an error message to the user
 * Errors auto-dismiss after 5 seconds
 */
function showError(message) {
    const banner = document.getElementById('error-banner');
    const messageEl = document.getElementById('error-message');
    
    messageEl.textContent = message;
    banner.classList.remove('hidden');
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        closeError();
    }, 5000);
}

/**
 * Close and hide the error banner
 */
function closeError() {
    const banner = document.getElementById('error-banner');
    banner.classList.add('hidden');
}

/* ============================================================================
   Map interaction helpers (for future phases)
   
   These will be expanded as we add features like:
   - Clicking to inspect locations
   - Drawing and filtering by radius
   - Placing markers for favorites/recommendations
   ============================================================================ */

/**
 * Get map center coordinates
 * Useful for many queries (weather, sky data, etc.)
 */
function getMapCenter() {
    if (!map) return null;
    const center = map.getCenter();
    return {
        lat: center.lat,
        lng: center.lng
    };
}

/**
 * How long map movements should take.
 *
 * The CSS honours prefers-reduced-motion for everything the stylesheet
 * controls, but the map is moved by JavaScript and the stylesheet cannot reach
 * it. Someone who has asked for less movement should not get a 1.5-second
 * swoop across the world every time they pick a search result.
 *
 * Read fresh each time rather than cached, because the preference can be
 * changed while the page is open.
 */
function mapMoveDuration(normalMs) {
    const prefersLessMotion = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return prefersLessMotion ? 0 : normalMs;
}

/**
 * Fly map to a specific location with animation
 */
function flyToLocation(lat, lng, zoom = 12) {
    if (!map) return;

    map.flyTo({
        center: [lng, lat],
        zoom: zoom,
        duration: mapMoveDuration(1500),
        essential: false
    });
}
