/* ============================================================================
   DARKWARD — Service worker (offline support)

   WHY THIS EXISTS
   ---------------
   Dark sites are dark because nobody lives there, which is also why they have
   no phone signal. Arriving somewhere genuinely good and finding the app is a
   blank page is the worst possible time for that to happen.

   Almost everything Darkward does can work offline. The astronomy is computed
   in your browser, not fetched. The light pollution atlas and the map tiles do
   not change. Only the weather is genuinely live.

   So this file keeps a copy of everything as you use it, and serves those
   copies when the network is gone.

   HOW IT DECIDES
   --------------
   Three rules, in the order they are tested:

     1. Our own files (HTML, CSS, JS, the logo)
        Cache first. They are versioned with ?v= in index.html, so a new
        version is simply a different URL and cannot be served stale.

     2. Things that never change (map tiles, atlas tiles, fonts, the astronomy
        library on its CDN)
        Cache first, falling back to the network. This is what makes the map
        still draw at a dark site.

     3. Live data (weather, place names, spot searches)
        Network first, falling back to whatever was last cached. Fresh when
        there is signal, and the last known answer when there is not — which
        is far better than an error, as long as it is the second choice and
        not the first.

   UPDATING
   --------
   Bump CACHE_VERSION whenever the app files change. The old cache is deleted
   on activate, so nothing is left behind. skipWaiting and clients.claim mean a
   new worker takes over straight away rather than waiting for every tab to be
   closed — without them, an update can appear not to have worked at all.
   ============================================================================ */

const CACHE_VERSION = 'darkward-v10';

/* The app shell: enough to open the page and draw the interface with no
   network at all. The ?v= numbers must match the ones in index.html. */
const APP_SHELL = [
    './',
    './index.html',
    './css/styles.css?v=10',
    './css/themes.css?v=10',
    './js/map.js?v=10',
    './js/lightpollution.js?v=10',
    './js/skyquality.js?v=10',
    './js/tonightsky.js?v=10',
    './js/deepsky.js?v=10',
    './js/events.js?v=10',
    './js/inspect.js?v=10',
    './js/search.js?v=10',
    './js/favourites.js?v=10',
    './js/darkskyplaces.js?v=10',
    './js/recommend.js?v=10',
    './js/theme.js?v=10',
    './assets/darkward-mark-small.svg'
];

/* Hosts whose answers never really change, so a cached copy is always fine. */
const DURABLE_HOSTS = [
    'cartodb-basemaps-a.global.ssl.fastly.net',
    'cartodb-basemaps-b.global.ssl.fastly.net',
    'cartodb-basemaps-c.global.ssl.fastly.net',
    'cartodb-basemaps-d.global.ssl.fastly.net',
    'djlorenz.github.io',
    'unpkg.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

/* Hosts that answer with live data, where fresh matters. */
const LIVE_HOSTS = [
    'api.open-meteo.com',
    'nominatim.openstreetmap.org',
    'photon.komoot.io',
    'overpass-api.de'
];

/* ============================================================================
   Install — take a copy of the app shell
   ============================================================================ */

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then(cache => cache.addAll(APP_SHELL))
            // Do not sit in "waiting" behind the previous worker.
            .then(() => self.skipWaiting())
            .catch(error => console.warn('[sw] could not pre-cache:', error))
    );
});

/* ============================================================================
   Activate — throw away caches from older versions
   ============================================================================ */

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names.filter(name => name !== CACHE_VERSION)
                     .map(name => caches.delete(name))
            ))
            // Start controlling pages that are already open.
            .then(() => self.clients.claim())
    );
});

/* ============================================================================
   Fetch — the three rules
   ============================================================================ */

self.addEventListener('fetch', function (event) {
    const request = event.request;

    // Only GETs are cacheable. Overpass is queried with POST, so it falls
    // straight through to the network, which is correct.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (LIVE_HOSTS.includes(url.hostname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (url.origin === self.location.origin || DURABLE_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(request));
    }
});

/**
 * Serve from the cache, and only go to the network if it is not there.
 * Anything successfully fetched is kept for next time.
 */
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        await rememberIfUseful(request, response);
        return response;
    } catch (error) {
        // Genuinely nothing to serve. A missing map tile just draws blank,
        // which is better than the whole page failing.
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}

/**
 * Try the network, fall back to the last cached answer.
 * Used for weather and searches, where stale beats nothing.
 */
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        await rememberIfUseful(request, response);
        return response;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(JSON.stringify({ offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Store a response, but only a real one.
 *
 * An opaque response (a cross-origin request made without CORS) has a status of
 * 0 and no readable body, so caching it would mean serving an empty file
 * forever afterwards.
 */
async function rememberIfUseful(request, response) {
    if (!response || !response.ok || response.type === 'opaque') return;

    const cache = await caches.open(CACHE_VERSION);
    // The response body can only be read once, so the copy goes in the cache
    // and the original goes back to the page.
    await cache.put(request, response.clone());
}
