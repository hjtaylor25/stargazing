/* ============================================================================
   ASTROMAP — Sky Quality (Light Pollution) Lookup

   WHAT THIS DOES
   --------------
   Given a latitude and longitude, this returns the REAL modelled artificial
   sky brightness at that point, taken from David J. Lorenz's World Atlas of
   Artificial Night Sky Brightness (2025 edition).

   This is the same data that draws the coloured overlay on the map, so the
   number in the panel and the colour under your finger always agree.

   HOW IT WORKS
   ------------
   Lorenz publishes the atlas twice: once as coloured PNG map tiles (what we
   draw), and once as small binary data files (what we read numbers from).

   The binary files split the world into 5-degree squares. Each square holds a
   600 x 600 grid of values — one every 1/120 of a degree, roughly 900 m. The
   file is gzipped and delta-encoded: the very first value is stored in full
   and every value after it is stored as a small change from its neighbour,
   which is why the whole 5-degree square fits in about 70 KB.

   To read one point we therefore:
     1. work out which 5-degree tile it falls in, and which grid cell inside it
     2. download and gunzip that tile (browsers can gunzip natively)
     3. walk the deltas up the left-hand edge, then across the row, adding them
        up until we reach our cell
     4. convert the resulting compressed integer back to a brightness ratio

   The decoding steps mirror Lorenz's own reader on his atlas page, so our
   numbers match what his site reports for the same point.

   IMPORTANT — THIS IS NOT THE BORTLE SCALE
   ----------------------------------------
   Lorenz explicitly asks that his atlas not be presented as Bortle numbers.
   The atlas models brightness at the ZENITH (straight up); the Bortle scale is
   a subjective judgement of the whole sky from horizon to horizon. We report
   his own Light Pollution Zone and Index instead, plus the standard
   magnitudes-per-square-arcsecond figure.

   Coverage: 65°S to 75°N. Outside that band we say so rather than guess.

   Data: David J. Lorenz, World Atlas of Artificial Night Sky Brightness 2025,
   built on VIIRS night-lights from NOAA / Earth Observation Group.
   https://djlorenz.github.io/astronomy/lp/
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

// Which edition of the atlas to read. The map overlay in lightpollution.js
// must use the same year, otherwise the panel and the colours would disagree.
const ATLAS_YEAR = 2025;

const ATLAS_BINARY_BASE = `https://djlorenz.github.io/astronomy/binary_tiles/${ATLAS_YEAR}`;

// Each binary tile covers 5 degrees of latitude and longitude...
const TILE_DEGREES = 5;
// ...sampled on a 600 x 600 grid, i.e. one point every 1/120 of a degree.
const POINTS_PER_DEGREE = 120;
const GRID_SIZE = 600;

// The atlas only covers 65°S to 75°N (28 tile rows of 5 degrees).
const ATLAS_SOUTH_LIMIT = -65;
const ATLAS_NORTH_LIMIT = 75;

/* ----------------------------------------------------------------------------
   Light Pollution Zones, straight from Lorenz's colour key.

   "index" is the Light Pollution Index: artificial sky glow expressed as a
   multiple of the natural night sky. 0 is pristine; 1 means the artificial
   glow equals the natural glow; a city centre is 30 or more.

   "score" is only used to draw our 0-100 bar. Higher = darker = better.
   -------------------------------------------------------------------------- */

const LP_ZONES = [
    { maxIndex: 0.01,     zone: '0',  score: 100, label: 'Pristine dark sky' },
    { maxIndex: 0.06,     zone: '1a', score: 94,  label: 'Excellent dark sky' },
    { maxIndex: 0.11,     zone: '1b', score: 88,  label: 'Excellent dark sky' },
    { maxIndex: 0.19,     zone: '2a', score: 82,  label: 'Very dark sky' },
    { maxIndex: 0.33,     zone: '2b', score: 76,  label: 'Very dark sky' },
    { maxIndex: 0.58,     zone: '3a', score: 68,  label: 'Dark rural sky' },
    { maxIndex: 1.00,     zone: '3b', score: 60,  label: 'Rural sky' },
    { maxIndex: 1.73,     zone: '4a', score: 52,  label: 'Rural / suburban edge' },
    { maxIndex: 3.00,     zone: '4b', score: 44,  label: 'Suburban sky' },
    { maxIndex: 5.20,     zone: '5a', score: 36,  label: 'Suburban sky' },
    { maxIndex: 9.00,     zone: '5b', score: 28,  label: 'Bright suburban sky' },
    { maxIndex: 15.59,    zone: '6a', score: 21,  label: 'Suburban / urban edge' },
    { maxIndex: 27.00,    zone: '6b', score: 14,  label: 'Urban sky' },
    { maxIndex: 46.77,    zone: '7a', score: 8,   label: 'City sky' },
    { maxIndex: Infinity, zone: '7b', score: 3,   label: 'Inner-city sky' }
];

/* ----------------------------------------------------------------------------
   Approximate Bortle class

   The Bortle scale is NOT something you can compute. John Bortle defined it by
   what an observer can see — naked-eye limiting magnitude, whether the zodiacal
   light shows, whether the Milky Way casts a shadow — across the whole sky from
   horizon to horizon. The atlas models one number: brightness straight up.

   So this table is a convention, not a measurement. It is the widely published
   correspondence between Sky Quality Meter readings (which are also
   mag/arcsec² at the zenith) and Bortle classes. It is offered because
   stargazers talk in Bortle numbers, and it is always shown with a "≈" and the
   word "rough" so nobody mistakes it for the real thing.

   Remember the magnitude scale runs backwards: a BIGGER number is a DARKER sky.
   -------------------------------------------------------------------------- */

const BORTLE_FROM_MAGNITUDES = [
    { atLeast: 21.99, bortle: 1 },
    { atLeast: 21.89, bortle: 2 },
    { atLeast: 21.69, bortle: 3 },
    { atLeast: 20.49, bortle: 4 },
    { atLeast: 19.50, bortle: 5 },
    { atLeast: 18.94, bortle: 6 },
    { atLeast: 18.38, bortle: 7 },
    { atLeast: 17.80, bortle: 8 },
    { atLeast: -Infinity, bortle: 9 }
];

function approximateBortle(magnitudes) {
    return BORTLE_FROM_MAGNITUDES.find(entry => magnitudes >= entry.atLeast).bortle;
}

/* ----------------------------------------------------------------------------
   Caches

   Each decoded tile is 360 KB in memory, so we keep only a handful. Panning
   around one region reuses the same tile over and over, which keeps us off
   Lorenz's server — he hosts this for free on GitHub Pages.
   -------------------------------------------------------------------------- */

const atlasTileCache = new Map();     // "tileX,tileY" -> Int8Array (or null if missing)
const MAX_CACHED_TILES = 8;

/* ============================================================================
   Main entry point

   Returns one of:
     { available: true,  index, magnitudes, zone, label, score }
     { available: false, reason: 'out-of-bounds' | 'no-data' | 'unsupported' | 'network' }

   It never invents a value. If the lookup fails the caller shows "unavailable"
   rather than a made-up rating.
   ============================================================================ */

async function lookupSkyQuality(lat, lng) {
    if (lat < ATLAS_SOUTH_LIMIT || lat > ATLAS_NORTH_LIMIT) {
        return { available: false, reason: 'out-of-bounds' };
    }

    // Browsers gunzip for us via DecompressionStream. Every current browser has
    // it, but check rather than throwing a confusing error on an old one.
    if (typeof DecompressionStream === 'undefined') {
        console.warn('DecompressionStream is not supported — sky quality unavailable');
        return { available: false, reason: 'unsupported' };
    }

    // Longitude measured eastwards from the date line, latitude northwards from
    // 65°S. This is the coordinate system the atlas tiles are numbered in, and
    // it avoids negative numbers entirely.
    const lonFromDateLine = modulo(lng + 180, 360);
    const latFromSouthLimit = lat - ATLAS_SOUTH_LIMIT;

    // Tile numbers start at 1, not 0.
    const tileX = Math.floor(lonFromDateLine / TILE_DEGREES) + 1;
    const tileY = Math.floor(latFromSouthLimit / TILE_DEGREES) + 1;

    const tileData = await loadAtlasTile(tileX, tileY);
    if (!tileData) {
        return { available: false, reason: 'no-data' };
    }

    // Which grid point inside the tile? The extra 1/240 shifts us to the centre
    // of a grid cell instead of its corner, so we round to the nearest sample.
    const halfCell = 1 / (2 * POINTS_PER_DEGREE);
    const gridX = Math.round(POINTS_PER_DEGREE * (lonFromDateLine - TILE_DEGREES * (tileX - 1) + halfCell));
    const gridY = Math.round(POINTS_PER_DEGREE * (latFromSouthLimit - TILE_DEGREES * (tileY - 1) + halfCell));

    const compressed = readCompressedValue(tileData, gridX, gridY);
    const brightnessRatio = compressedToBrightnessRatio(compressed);

    // A truncated or corrupt tile would give NaN here. Better to report nothing
    // than to draw a confident-looking bar from a broken number.
    if (!Number.isFinite(brightnessRatio)) {
        console.warn('Atlas value could not be decoded for', lat, lng);
        return { available: false, reason: 'no-data' };
    }

    return describeSkyQuality(brightnessRatio);
}

/* ============================================================================
   Download and gunzip one 5-degree atlas tile
   ============================================================================ */

async function loadAtlasTile(tileX, tileY) {
    const key = `${tileX},${tileY}`;

    if (atlasTileCache.has(key)) {
        return atlasTileCache.get(key);
    }

    const url = `${ATLAS_BINARY_BASE}/binary_tile_${tileX}_${tileY}.dat.gz`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            // A missing tile means the atlas has no data for that square.
            // Cache the miss so we do not ask again for every nearby click.
            console.warn(`Atlas tile ${key} not available (${response.status})`);
            rememberTile(key, null);
            return null;
        }

        const gzipped = await response.arrayBuffer();
        const plain = await gunzip(gzipped);

        // The atlas stores SIGNED bytes: the deltas can go up as well as down.
        const values = new Int8Array(plain);
        rememberTile(key, values);

        console.log(`✓ Atlas tile ${key} loaded (${values.length} values)`);
        return values;

    } catch (error) {
        console.error('✗ Could not load atlas tile:', error);
        return null;   // not cached — a network blip should be retried later
    }
}

/**
 * Store a tile, evicting the oldest if the cache is full.
 * Map preserves insertion order, so the first key is the oldest.
 */
function rememberTile(key, value) {
    if (atlasTileCache.size >= MAX_CACHED_TILES) {
        const oldestKey = atlasTileCache.keys().next().value;
        atlasTileCache.delete(oldestKey);
    }
    atlasTileCache.set(key, value);
}

/**
 * Decompress gzip data using the browser's built-in DecompressionStream.
 * No library needed — this is why we do not load pako from a CDN.
 */
async function gunzip(arrayBuffer) {
    const stream = new Blob([arrayBuffer]).stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
}

/* ============================================================================
   Walk the delta-encoded grid to recover one value

   Layout of the file (as bytes):
     [0], [1]   the bottom-left value, stored in full across two bytes
     [2...]     every other point, stored as a change from the point before it

   To reach grid point (gridX, gridY) we add up the changes going up the
   left-hand column first, then across the row. That is exactly how the data
   was written, so it is exactly how it has to be read back.
   ============================================================================ */

function readCompressedValue(data, gridX, gridY) {
    let value = 128 * data[0] + data[1];

    // Climb the left-hand edge, one row at a time.
    for (let row = 1; row < gridY; row++) {
        value += data[GRID_SIZE * row + 1];
    }

    // Then walk east along our row.
    for (let column = 1; column < gridX; column++) {
        value += data[GRID_SIZE * (gridY - 1) + 1 + column];
    }

    return value;
}

/**
 * Undo the atlas's logarithmic compression to get the Light Pollution Index:
 * artificial sky glow as a multiple of the natural night sky.
 * (Formula from Lorenz's own atlas reader.)
 */
function compressedToBrightnessRatio(compressed) {
    return (5.0 / 195.0) * (Math.exp(0.0195 * compressed) - 1.0);
}

/* ============================================================================
   Turn a brightness ratio into something a human can read
   ============================================================================ */

function describeSkyQuality(brightnessRatio) {
    // Total sky brightness in magnitudes per square arc-second. The magnitude
    // scale runs backwards: BIGGER numbers mean a DARKER sky. A pristine sky is
    // 22.0; an inner city is around 17.
    const magnitudes = 22.0 - 5.0 * Math.log(1.0 + brightnessRatio) / Math.log(100.0);

    const zone = LP_ZONES.find(entry => brightnessRatio < entry.maxIndex);

    return {
        available: true,
        index: brightnessRatio,
        magnitudes: magnitudes,
        zone: zone.zone,
        label: zone.label,
        score: zone.score,
        // Secondary, and always presented as approximate. See the table above.
        bortle: approximateBortle(magnitudes)
    };
}

/* ----------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/**
 * A true modulo. JavaScript's % keeps the sign of the left-hand side, so
 * -10 % 360 is -10 rather than 350, which would put us on the wrong tile.
 */
function modulo(n, m) {
    return ((n % m) + m) % m;
}

/**
 * Format the Light Pollution Index the way Lorenz's own site does: more
 * decimal places for small numbers, fewer for large ones.
 */
function formatLightPollutionIndex(value) {
    if (value < 0.1) return value.toFixed(3);
    if (value < 3) return value.toFixed(2);
    return value.toFixed(1);
}
