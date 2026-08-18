/* ============================================================================
   ASTROMAP — "Where should I go tonight?"

   Pick a starting point and a distance you are willing to drive, and this
   finds the best places to stand tonight and ranks them.

   HOW IT DECIDES
   --------------
   Three things matter, and the score weighs all of them:

     darkness   how little artificial light there is, from the same light
                pollution atlas the map overlay draws (js/skyquality.js)
     cloud      the average cloud cover tonight between 8pm and 4am, from
                Open-Meteo, in the local time of each candidate
     distance   how far you would have to drive, as the crow flies

   WHERE THE CANDIDATES COME FROM
   ------------------------------
   Only from two places, never from thin air:

     1. OpenStreetMap, via the Overpass API — viewpoints, campsites and named
        car parks. These are real, mapped, reachable spots.
     2. js/darkskyplaces.js — a hand-checked list of certified dark-sky places.

   That restriction is deliberate. It would be easy to score every square
   kilometre of the atlas and point at the darkest one, but the darkest pixel
   for a hundred miles is usually the middle of a paddock behind a locked gate.
   Everything suggested here is somewhere a person can actually go.

   THE ORDER OF OPERATIONS MATTERS
   -------------------------------
   Weather is fetched LAST, and only for a shortlist. Open-Meteo will take many
   locations in a single request, so the whole ranking costs one Overpass
   request and one weather request, no matter how many candidates come back.
   Asking for the weather at four hundred car parks would be rude and slow.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const OVERPASS_API = 'https://overpass-api.de/api/interpreter';

// Told to Overpass inside the query, so it gives up rather than grinding away.
const OVERPASS_QUERY_TIMEOUT_SECONDS = 25;

// Our own patience, slightly longer, in case the server never answers at all.
const OVERPASS_GIVE_UP_MS = 30000;

// Overpass caps its reply at this many elements. Around 500 comes back as
// roughly 100 KB, which is a reasonable thing to ask a volunteer-run service
// for and a reasonable thing to download on a phone.
const OVERPASS_MAX_ELEMENTS = 500;

const RECOMMEND_RADII_KM = [50, 100, 200];
const RECOMMEND_DEFAULT_RADIUS_KM = 100;
const RECOMMEND_RADIUS_STORAGE_KEY = 'astromap-recommend-radius';

// How many candidates get a weather lookup. They all travel in one request, so
// this is about keeping the reply small rather than about request count.
const WEATHER_CANDIDATE_LIMIT = 15;

const RECOMMEND_TOP_N = 5;

/* ----------------------------------------------------------------------------
   How the three factors are balanced

   Darkness leads because it is the one thing you cannot change by waiting: a
   bright sky is bright every night of the year. Cloud is close behind, since
   an overcast night at a perfect site shows you nothing. Distance matters
   least — it is the thing a keen observer will happily trade away — but it is
   not nothing, so it breaks ties in favour of the closer drive.

   These are judgement calls, not physics. Change them and the recommendations
   change; that is the point of having them in one place.
   -------------------------------------------------------------------------- */

const WEIGHT_DARKNESS = 0.45;
const WEIGHT_CLOUD = 0.40;
const WEIGHT_DISTANCE = 0.15;

const EARTH_RADIUS_KM = 6371;

/* ----------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

let recommendRadiusKm = RECOMMEND_DEFAULT_RADIUS_KM;

// The numbered pins currently on the map.
let recommendMarkers = [];

// Overpass allows only a couple of queries at a time per address, so one at a
// time is both polite and enough.
let recommendRunning = false;

// Remember answers for a given place and radius; asking twice costs nothing.
const overpassCache = new Map();
const MAX_CACHED_OVERPASS = 8;

document.addEventListener('DOMContentLoaded', initializeRecommend);

/* ============================================================================
   Wiring up
   ============================================================================ */

function initializeRecommend() {
    // Restore the radius chosen last time.
    const saved = parseInt(localStorage.getItem(RECOMMEND_RADIUS_STORAGE_KEY), 10);
    if (RECOMMEND_RADII_KM.includes(saved)) {
        recommendRadiusKm = saved;
    }

    document.querySelectorAll('.radius-btn').forEach(function (button) {
        button.addEventListener('click', function () {
            setRecommendRadius(parseInt(this.getAttribute('data-radius'), 10));
        });
    });

    const findButton = document.getElementById('recommend-button');
    if (findButton) {
        findButton.addEventListener('click', findBestSpots);
    }

    // Escape clears the suggestions, matching the search box and the saved
    // places list. This panel was the only one that did not, which is exactly
    // the sort of inconsistency a keyboard user notices immediately.
    const panel = document.querySelector('.recommend-panel');
    if (panel) {
        panel.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') return;
            clearRecommendations();
            setRecommendStatus('');
        });
    }

    updateRadiusButtons();

    // The label follows the map whenever the map is what it is following.
    // waitForMapReady lives in js/map.js and waits for the style to finish.
    waitForMapReady(function () {
        map.on('moveend', updateRecommendOriginLabel);
        updateRecommendOriginLabel();
    });

    console.log(`✓ Recommendations initialized (${DARK_SKY_PLACES.length} curated places)`);
}

function setRecommendRadius(km) {
    if (!RECOMMEND_RADII_KM.includes(km)) return;

    recommendRadiusKm = km;
    localStorage.setItem(RECOMMEND_RADIUS_STORAGE_KEY, String(km));
    updateRadiusButtons();
}

function updateRadiusButtons() {
    document.querySelectorAll('.radius-btn').forEach(function (button) {
        const isChosen = parseInt(button.getAttribute('data-radius'), 10) === recommendRadiusKm;
        button.classList.toggle('is-selected', isChosen);
        // aria-pressed is what a screen reader announces; the class only paints.
        button.setAttribute('aria-pressed', String(isChosen));
    });
}

/* ============================================================================
   The main run
   ============================================================================ */

async function findBestSpots() {
    if (recommendRunning) return;

    const origin = recommendationOrigin();
    if (!origin) {
        setRecommendStatus('Tap the map first, so I know where you are starting from.');
        return;
    }

    recommendRunning = true;
    setRecommendBusy(true);
    clearRecommendations();
    updateRecommendOriginLabel();

    try {
        setRecommendStatus('Looking for places you can get to…');
        const fromOsm = await fetchOverpassCandidates(origin, recommendRadiusKm);

        const curated = curatedPlacesWithin(origin, recommendRadiusKm);

        // A null from Overpass means the request failed, which is different
        // from it succeeding with nothing to report. Carry on with the curated
        // list rather than giving up — but hold on to the warning.
        //
        // It cannot be shown yet: the progress messages below would overwrite
        // it, and the run ends by clearing the line. So it is kept and shown at
        // the end, next to the results it applies to. Without this the list
        // looks like a complete answer when half its sources are missing.
        const warning = fromOsm === null
            ? 'OpenStreetMap is not answering, so these are certified dark-sky places only.'
            : '';

        const candidates = deduplicateCandidates(curated.concat(fromOsm || []));

        if (candidates.length === 0) {
            setRecommendStatus(warning
                ? `No spots found within ${recommendRadiusKm} km, and OpenStreetMap is not answering.`
                : `No mapped spots found within ${recommendRadiusKm} km.`);
            return;
        }

        setRecommendStatus(`Reading the atlas for ${candidates.length} places…`);
        const withDarkness = await addDarkness(candidates, origin);

        const shortlist = shortlistForWeather(withDarkness);

        setRecommendStatus('Checking tonight’s cloud…');
        const withWeather = await addTonightCloud(shortlist);

        const ranked = rankCandidates(withWeather).slice(0, RECOMMEND_TOP_N);

        if (ranked.length === 0) {
            setRecommendStatus('Nothing scored well enough to suggest tonight.');
            return;
        }

        setRecommendStatus(warning);
        renderRecommendations(ranked);
        showRecommendationPins(ranked);

    } catch (error) {
        console.error('✗ Recommendation run failed:', error);
        setRecommendStatus('Something went wrong finding spots. The rest of the app still works.');

    } finally {
        recommendRunning = false;
        setRecommendBusy(false);
    }
}

/**
 * Where to search from: the place you last tapped, or whatever the map is
 * centred on if you have not tapped anything yet.
 *
 * The tapped point wins deliberately. Once you have chosen somewhere, panning
 * the map to look around should not silently move your starting point out from
 * under you. Close the inspect panel and it goes back to following the map.
 *
 * Which of the two is in use is written on screen by the function below,
 * because a distance is meaningless if you cannot tell what it is measured
 * from — and there is no way to guess from looking at the map.
 */
function recommendationOrigin() {
    if (currentInspectLocation) return currentInspectLocation;
    return getMapCenter();
}

function updateRecommendOriginLabel() {
    const label = document.getElementById('recommend-origin');
    if (!label) return;

    const origin = recommendationOrigin();

    if (!origin) {
        label.textContent = '';
        return;
    }

    const source = currentInspectLocation
        ? 'the spot you tapped'
        : 'the middle of the map';

    label.textContent =
        `Measuring from ${source} · ${origin.lat.toFixed(3)}°, ${origin.lng.toFixed(3)}°`;
}

/* ============================================================================
   Candidates from OpenStreetMap, via Overpass

   Two things about Overpass are worth knowing before changing this:

   1. IT ANSWERS WITH HTML WHEN IT IS BUSY. Even though the query says
      [out:json], an overloaded server replies with an HTML error page — and
      sometimes with a 200 status. So the reply is read as text and parsed
      inside a try, rather than trusting response.json().

   2. UNFILTERED CAR PARKS ARE ENORMOUS. Counting them for a 200 km circle
      around Brisbane gives 17,475 of them, against 1,395 viewpoints and
      campsites put together. Asking only for car parks that have a NAME brings
      that to 990, and a named car park is the useful kind anyway — a lookout
      or a trailhead, rather than the back of a supermarket.
   ============================================================================ */

function buildOverpassQuery(origin, radiusKm) {
    const radiusMetres = Math.round(radiusKm * 1000);
    const around = `around:${radiusMetres},${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}`;

    // `nwr` asks for nodes, ways and relations, because a campsite or car park
    // is often drawn as an area rather than a single point. `out center` then
    // gives each area a middle point to put on the map.
    return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];` +
           `(nwr(${around})[tourism=viewpoint];` +
           `nwr(${around})[tourism=camp_site];` +
           `nwr(${around})[amenity=parking][name];);` +
           `out center ${OVERPASS_MAX_ELEMENTS};`;
}

/**
 * Returns an array of candidates, or null if the request could not be made.
 * The difference matters: null means "ask again later", [] means "nothing there".
 */
async function fetchOverpassCandidates(origin, radiusKm) {
    const cacheKey = `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}@${radiusKm}`;
    if (overpassCache.has(cacheKey)) {
        console.log('Reusing cached Overpass result');
        return overpassCache.get(cacheKey);
    }

    // Overpass can simply never reply. Without this the button would spin for
    // ever, which is the worst kind of failure because it looks like progress.
    const controller = new AbortController();
    const giveUp = setTimeout(() => controller.abort(), OVERPASS_GIVE_UP_MS);

    try {
        const response = await fetch(OVERPASS_API, {
            method: 'POST',
            // Sent as form data, which browsers may post without asking the
            // server for permission first, so there is no extra round trip.
            body: new URLSearchParams({ data: buildOverpassQuery(origin, radiusKm) }),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Overpass returned ${response.status}`);
        }

        // See the note above: this may not be JSON at all.
        const body = await response.text();
        let data;
        try {
            data = JSON.parse(body);
        } catch (parseError) {
            throw new Error('Overpass sent an error page instead of data (it is probably busy)');
        }

        const candidates = (data.elements || [])
            .map(overpassElementToCandidate)
            .filter(Boolean);

        rememberOverpass(cacheKey, candidates);
        console.log(`✓ Overpass returned ${candidates.length} usable candidates`);
        return candidates;

    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('Overpass took too long and was given up on');
        } else {
            console.error('✗ Overpass error:', error);
        }
        return null;

    } finally {
        clearTimeout(giveUp);
    }
}

function rememberOverpass(key, value) {
    if (overpassCache.size >= MAX_CACHED_OVERPASS) {
        overpassCache.delete(overpassCache.keys().next().value);
    }
    overpassCache.set(key, value);
}

function overpassElementToCandidate(element) {
    // A node carries its own lat/lon. Ways and relations do not — `out center`
    // adds a `center` holding the middle of the shape instead.
    const lat = Number.isFinite(element.lat) ? element.lat
              : (element.center && element.center.lat);
    const lng = Number.isFinite(element.lon) ? element.lon
              : (element.center && element.center.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const tags = element.tags || {};

    return {
        name: tags.name || describeCandidateKind(tags),
        kind: describeCandidateKind(tags),
        lat: lat,
        lng: lng,
        source: 'osm'
    };
}

function describeCandidateKind(tags) {
    if (tags.tourism === 'viewpoint') return 'Viewpoint';
    if (tags.tourism === 'camp_site') return 'Campsite';
    if (tags.amenity === 'parking') return 'Car park';
    return 'Spot';
}

/* ============================================================================
   Candidates from the curated list
   ============================================================================ */

function curatedPlacesWithin(origin, radiusKm) {
    return DARK_SKY_PLACES
        .filter(place => haversineKm(origin, place) <= radiusKm)
        .map(place => ({
            name: place.name,
            kind: place.designation,
            lat: place.lat,
            lng: place.lng,
            source: 'curated',
            region: place.region,
            certified: place.certified
        }));
}

/**
 * Drop candidates that are effectively the same spot.
 *
 * Rounding to three decimal places is about 110 metres. A certified dark-sky
 * park and an OpenStreetMap car park inside it should not both be suggested,
 * and whichever was added first wins — the curated list is passed in first for
 * exactly that reason, since its names are better.
 */
function deduplicateCandidates(candidates) {
    const seen = new Set();
    const unique = [];

    candidates.forEach(function (candidate) {
        const key = `${candidate.lat.toFixed(3)},${candidate.lng.toFixed(3)}`;
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(candidate);
    });

    return unique;
}

/* ============================================================================
   Scoring
   ============================================================================ */

/**
 * Look up the sky brightness for every candidate.
 *
 * This looks expensive and is not. The atlas is stored in 5-degree tiles, so a
 * couple of hundred candidates within driving distance nearly all fall in the
 * same one or two tiles, which are downloaded once and then cached in memory.
 * Everything after that is arithmetic.
 */
async function addDarkness(candidates, origin) {
    const scored = [];

    for (const candidate of candidates) {
        const sky = await lookupSkyQuality(candidate.lat, candidate.lng);
        scored.push(Object.assign({}, candidate, {
            sky: sky,
            distanceKm: haversineKm(origin, candidate)
        }));
    }

    return scored;
}

/**
 * Closer is better, on a 0-100 scale, measured against the radius you chose.
 * Somewhere on your doorstep scores 100; somewhere at the very edge scores 0.
 */
function distanceScore(distanceKm) {
    const fraction = distanceKm / recommendRadiusKm;
    return Math.max(0, Math.min(100, 100 * (1 - fraction)));
}

function darknessScore(candidate) {
    return (candidate.sky && candidate.sky.available) ? candidate.sky.score : 0;
}

/**
 * Pick which candidates are worth a weather lookup.
 *
 * Cloud is unknown at this point, so they are ranked on the other two factors
 * using the same balance as the real score, just with the cloud share removed.
 * Ranking on darkness alone would quietly throw away a slightly less dark spot
 * twenty minutes away in favour of a marginally darker one three hours away.
 */
function shortlistForWeather(candidates) {
    const provisional = candidates.map(function (candidate) {
        const score = (WEIGHT_DARKNESS * darknessScore(candidate)
                     + WEIGHT_DISTANCE * distanceScore(candidate.distanceKm))
                    / (WEIGHT_DARKNESS + WEIGHT_DISTANCE);
        return Object.assign({}, candidate, { provisionalScore: score });
    });

    provisional.sort((a, b) => b.provisionalScore - a.provisionalScore);
    return provisional.slice(0, WEATHER_CANDIDATE_LIMIT);
}

/**
 * Tonight's cloud for the whole shortlist, in ONE request.
 *
 * Open-Meteo accepts comma-separated coordinates and answers with an array,
 * one entry per location, each with its own timezone. Watch the shape though:
 * ask about a single location and it answers with a plain object instead of a
 * one-item array, so the reply is normalised before use.
 */
async function addTonightCloud(candidates) {
    if (candidates.length === 0) return candidates;

    try {
        const params = new URLSearchParams({
            latitude: candidates.map(c => c.lat.toFixed(4)).join(','),
            longitude: candidates.map(c => c.lng.toFixed(4)).join(','),
            hourly: 'cloud_cover',
            forecast_days: '2',
            timezone: 'auto'
        });

        const response = await fetch(`${OPEN_METEO_API}?${params}`);
        if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);

        const data = await response.json();
        const perLocation = Array.isArray(data) ? data : [data];

        return candidates.map(function (candidate, index) {
            // summariseNights() is the same function the inspect panel uses, so
            // "tonight" means the same 8pm-4am window in both places.
            const nights = summariseNights(perLocation[index]);
            const tonight = nights[0];

            return Object.assign({}, candidate, {
                cloudPercent: tonight ? numberOrNull(tonight.cloudTotal) : null
            });
        });

    } catch (error) {
        // Losing the forecast is survivable — darkness and distance still rank
        // the list, and the reason line says the cloud is unknown.
        console.error('✗ Could not get cloud forecast for candidates:', error);
        return candidates.map(c => Object.assign({}, c, { cloudPercent: null }));
    }
}

function scoreCandidate(candidate) {
    const darkness = darknessScore(candidate);
    const distance = distanceScore(candidate.distanceKm);

    // With no forecast, score on what we do know rather than inventing a
    // cloud figure. Dropping the term and re-sharing its weight keeps the
    // numbers comparable with the ones that do have a forecast.
    if (candidate.cloudPercent === null) {
        return (WEIGHT_DARKNESS * darkness + WEIGHT_DISTANCE * distance)
             / (WEIGHT_DARKNESS + WEIGHT_DISTANCE);
    }

    const clearness = 100 - candidate.cloudPercent;
    return WEIGHT_DARKNESS * darkness
         + WEIGHT_CLOUD * clearness
         + WEIGHT_DISTANCE * distance;
}

function rankCandidates(candidates) {
    return candidates
        .map(c => Object.assign({}, c, { score: scoreCandidate(c) }))
        .sort((a, b) => b.score - a.score);
}

/* ----------------------------------------------------------------------------
   Distance

   The haversine formula: the great-circle distance between two points on a
   sphere. Straight-line, so it ignores roads entirely — a spot across a valley
   may be twenty minutes away by road and five kilometres away by this measure.
   Road routing is noted as a future improvement in the README.
   -------------------------------------------------------------------------- */

function haversineKm(from, to) {
    const dLat = toRadians(to.lat - from.lat);
    const dLng = toRadians(to.lng - from.lng);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat))
            * Math.sin(dLng / 2) * Math.sin(dLng / 2);

    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

/* ============================================================================
   Showing the results
   ============================================================================ */

/**
 * The one-line explanation under each name, e.g.
 *     "Very dark · 20% cloud · 45 km away"
 *
 * Every part is a real measurement, and anything unknown says so rather than
 * being left out, so a missing forecast never looks like good news.
 */
function describeReason(candidate) {
    const parts = [];

    if (candidate.sky && candidate.sky.available) {
        // The atlas labels read "Very dark sky"; the trailing word is redundant
        // once it is sitting next to a cloud figure.
        parts.push(candidate.sky.label.replace(/ sky$/, ''));
    } else {
        parts.push('Darkness unknown');
    }

    parts.push(candidate.cloudPercent === null
        ? 'cloud unknown'
        : `${Math.round(candidate.cloudPercent)}% cloud`);

    parts.push(`${Math.round(candidate.distanceKm)} km away`);

    return parts.join(' · ');
}

function renderRecommendations(ranked) {
    const list = document.getElementById('recommend-results');
    if (!list) return;

    list.innerHTML = '';
    list.appendChild(buildRecommendHeader(ranked.length));

    ranked.forEach(function (candidate, index) {
        const item = document.createElement('li');

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'recommend-result';
        button.addEventListener('click', () => goToRecommendation(candidate));

        // The number matches the pin on the map.
        const rank = document.createElement('span');
        rank.className = 'recommend-rank';
        rank.textContent = String(index + 1);

        const text = document.createElement('span');
        text.className = 'recommend-text';

        const name = document.createElement('span');
        name.className = 'recommend-name';
        name.textContent = candidate.name;

        const reason = document.createElement('span');
        reason.className = 'recommend-reason';
        reason.textContent = describeReason(candidate);

        text.append(name, reason);

        // Certified places have earned a word about why they are on the list.
        if (candidate.source === 'curated') {
            const badge = document.createElement('span');
            badge.className = 'recommend-badge';
            badge.textContent = 'Certified';
            badge.title = `${candidate.kind}, certified ${candidate.certified}`;
            text.appendChild(badge);
        }

        button.append(rank, text);
        item.appendChild(button);
        list.appendChild(item);
    });

    list.appendChild(buildRecommendAttribution());
}

/**
 * The first row: how many spots, and a button to put the list away again.
 *
 * The list now takes real space in the column rather than floating over the
 * panel below, so being able to dismiss it matters — otherwise the only way to
 * get the room back would be to reload.
 */
function buildRecommendHeader(count) {
    const row = document.createElement('li');
    row.className = 'recommend-head';

    const summary = document.createElement('span');
    summary.textContent = `Top ${count} within ${recommendRadiusKm} km`;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button icon-button-small';
    close.title = 'Hide these suggestions';
    close.setAttribute('aria-label', 'Hide these suggestions');
    // makeIcon() is the shared SVG helper from js/favourites.js.
    close.appendChild(makeIcon('M6 6l12 12M18 6L6 18'));
    close.addEventListener('click', function () {
        clearRecommendations();
        setRecommendStatus('');
    });

    row.append(summary, close);
    return row;
}

function buildRecommendAttribution() {
    const credit = document.createElement('li');
    credit.className = 'search-attribution';

    const osm = document.createElement('a');
    osm.href = 'https://www.openstreetmap.org/copyright';
    osm.target = '_blank';
    osm.rel = 'noopener';
    osm.textContent = 'OpenStreetMap';

    const darksky = document.createElement('a');
    darksky.href = 'https://darksky.org/what-we-do/international-dark-sky-places/';
    darksky.target = '_blank';
    darksky.rel = 'noopener';
    darksky.textContent = 'DarkSky International';

    credit.append(document.createTextNode('Spots from '), osm,
                  document.createTextNode(' · certified places from '), darksky);
    return credit;
}

function clearRecommendations() {
    const list = document.getElementById('recommend-results');
    if (list) list.innerHTML = '';
    clearRecommendationPins();
}

function setRecommendStatus(message) {
    const status = document.getElementById('recommend-status');
    if (status) status.textContent = message;
}

function setRecommendBusy(busy) {
    const button = document.getElementById('recommend-button');
    if (!button) return;

    button.disabled = busy;
    button.textContent = busy ? 'Searching…' : 'Find spots';
}

/* ----------------------------------------------------------------------------
   Numbered pins on the map
   -------------------------------------------------------------------------- */

function showRecommendationPins(ranked) {
    if (!map) return;

    clearRecommendationPins();

    ranked.forEach(function (candidate, index) {
        const element = document.createElement('div');
        element.className = 'recommend-pin';
        element.textContent = String(index + 1);
        element.title = `${candidate.name} — ${describeReason(candidate)}`;
        element.addEventListener('click', () => goToRecommendation(candidate));

        const marker = new maplibregl.Marker({ element: element, anchor: 'center' })
            .setLngLat([candidate.lng, candidate.lat])
            .addTo(map);

        recommendMarkers.push(marker);
    });

    frameRecommendations(ranked);
}

function clearRecommendationPins() {
    recommendMarkers.forEach(marker => marker.remove());
    recommendMarkers = [];
}

/** Zoom out far enough to see every suggestion at once. */
function frameRecommendations(ranked) {
    if (!map || ranked.length === 0) return;

    const origin = recommendationOrigin();
    const points = ranked.map(c => [c.lng, c.lat]);
    if (origin) points.push([origin.lng, origin.lat]);

    const lngs = points.map(p => p[0]);
    const lats = points.map(p => p[1]);

    map.fitBounds(
        [[Math.min.apply(null, lngs), Math.min.apply(null, lats)],
         [Math.max.apply(null, lngs), Math.max.apply(null, lats)]],
        { padding: 60, maxZoom: 11, duration: mapMoveDuration(1500) }
    );
}

function goToRecommendation(candidate) {
    flyToLocation(candidate.lat, candidate.lng, 12);
    inspectChosenLocation(candidate.lat, candidate.lng);
}
