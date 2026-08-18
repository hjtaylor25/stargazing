/* ============================================================================
   ASTROMAP — Light Pollution Overlay

   Draws David J. Lorenz's World Atlas of Artificial Night Sky Brightness on
   top of the basemap, with a visibility toggle and an opacity slider.

   This is REAL data, not a placeholder. Lorenz publishes ready-made map tiles
   on GitHub Pages, so we can point MapLibre straight at them — no downloading,
   no self-hosting, no API key.

   The colours mean artificial sky glow at the zenith:
       black / grey   pristine to near-pristine
       blue           very dark
       green          rural
       yellow         rural-suburban edge
       orange / red   suburban to urban
       white          inner city
   Full colour key: https://djlorenz.github.io/astronomy/lp/colors.html

   Note on tile sizing: these images are 1024 x 1024 pixels rather than the
   usual 256, and the highest zoom level Lorenz publishes is 6. Telling
   MapLibre `tileSize: 1024` and `maxzoom: 6` makes it request the right tile
   for the current view and smoothly stretch it when you zoom in further. The
   underlying atlas is about 900 m per pixel, so zooming past that only makes
   the same data bigger — it does not reveal more detail.

   Attribution is declared on the source itself, so MapLibre adds it to the
   attribution control automatically.

   Data source: David J. Lorenz, World Atlas of Artificial Night Sky Brightness
   (2025), from NOAA VIIRS night-lights via the Earth Observation Group.
   https://djlorenz.github.io/astronomy/lp/
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

// The year here must match ATLAS_YEAR in skyquality.js, otherwise the colours
// on the map and the numbers in the inspect panel would come from different
// editions of the atlas.
const LP_TILE_URL = 'https://djlorenz.github.io/astronomy/image_tiles/tiles2025/tile_{z}_{x}_{y}.png';

const LP_TILE_SIZE = 1024;   // Lorenz's tiles are 1024px, not the usual 256
const LP_MAX_ZOOM = 6;       // highest zoom level he publishes

// The atlas covers 65°S to 75°N and nothing beyond. Declaring that here stops
// MapLibre asking for polar tiles that were never published: at world zoom
// every single 404 came from outside this box, so this removes all of them.
//
// It cannot remove the rest. Lorenz does not publish a tile for a square with
// no artificial light in it, so open ocean and empty desert 404 too — about
// one tile in ten over Australia. Those are expected, and they render as
// nothing, which is exactly right: no light, no overlay. See map.js for why
// they never reach the error banner.
const LP_BOUNDS = [-180, -65, 180, 75];   // [west, south, east, north]

const LP_ATTRIBUTION =
    'Light pollution: <a href="https://djlorenz.github.io/astronomy/lp/" target="_blank" rel="noopener">' +
    'D. J. Lorenz, World Atlas of Artificial Night Sky Brightness 2025</a>';

const LP_SOURCE_ID = 'light-pollution-source';
const LP_LAYER_ID = 'light-pollution-overlay';

// Remember the user's opacity choice between visits.
const LP_STORAGE_KEY = 'astromap-lp-opacity';
const LP_DEFAULT_OPACITY = 50;

/* ----------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

let lightPollutionVisible = true;
let currentOpacity = LP_DEFAULT_OPACITY;

document.addEventListener('DOMContentLoaded', function () {
    waitForMapReady(initializeLightPollution);
});

/* ============================================================================
   Add the overlay to the map
   ============================================================================ */

function initializeLightPollution() {
    if (!map) return;

    // Restore the saved opacity. parseInt returns NaN for a missing value, and
    // NaN is falsy, so the || quietly falls back to the default.
    currentOpacity = parseInt(localStorage.getItem(LP_STORAGE_KEY), 10) || LP_DEFAULT_OPACITY;

    try {
        map.addSource(LP_SOURCE_ID, {
            type: 'raster',
            tiles: [LP_TILE_URL],
            tileSize: LP_TILE_SIZE,
            minzoom: 0,
            maxzoom: LP_MAX_ZOOM,
            bounds: LP_BOUNDS,
            attribution: LP_ATTRIBUTION
        });

        map.addLayer({
            id: LP_LAYER_ID,
            type: 'raster',
            source: LP_SOURCE_ID,
            paint: {
                'raster-opacity': currentOpacity / 100,
                // Without this, MapLibre cross-fades between zoom levels and
                // the overlay looks muddy while you zoom.
                'raster-fade-duration': 0
            }
        });

        console.log('✓ Light pollution overlay added (Lorenz 2025 atlas)');

    } catch (error) {
        console.error('✗ Could not add light pollution overlay:', error);
        showError('The light pollution overlay could not be loaded. The map still works.');
    }

    setupLightPollutionUI();
}

/* ============================================================================
   Slider and toggle button
   ============================================================================ */

function setupLightPollutionUI() {
    const opacitySlider = document.getElementById('light-pollution-opacity');
    const toggleButton = document.getElementById('toggle-light-pollution');

    if (opacitySlider) {
        // Start the slider where the saved value left off.
        opacitySlider.value = currentOpacity;
        updateOpacityDisplay();

        opacitySlider.addEventListener('input', function () {
            currentOpacity = parseInt(this.value, 10);
            updateOpacity();
            updateOpacityDisplay();
        });
    }

    if (toggleButton) {
        toggleButton.addEventListener('click', toggleLightPollution);
    }
}

function updateOpacity() {
    localStorage.setItem(LP_STORAGE_KEY, currentOpacity);

    if (!map || !map.getLayer(LP_LAYER_ID)) return;
    map.setPaintProperty(LP_LAYER_ID, 'raster-opacity', currentOpacity / 100);
}

function updateOpacityDisplay() {
    const display = document.getElementById('opacity-value');
    if (display) {
        display.textContent = currentOpacity + '%';
    }
}

function toggleLightPollution() {
    if (!map || !map.getLayer(LP_LAYER_ID)) return;

    lightPollutionVisible = !lightPollutionVisible;

    map.setLayoutProperty(
        LP_LAYER_ID,
        'visibility',
        lightPollutionVisible ? 'visible' : 'none'
    );

    const button = document.getElementById('toggle-light-pollution');
    if (button) {
        // aria-pressed is the single source of truth for the button's state:
        // screen readers announce it, and styles.css uses it to decide which of
        // the two eye icons to show (open when the overlay is on, crossed out
        // when it is off). Nothing else needs changing here.
        button.setAttribute('aria-pressed', String(lightPollutionVisible));
        button.title = lightPollutionVisible ? 'Hide the overlay' : 'Show the overlay';
    }

    console.log(`Light pollution overlay is now ${lightPollutionVisible ? 'visible' : 'hidden'}`);
}

/* ============================================================================
   Theming

   Nothing to do here either — see the note at the bottom of js/map.js. The
   Astronomer theme recolours the whole map canvas, overlay included, with a
   single CSS filter.
   ============================================================================ */
