/* ============================================================================
   ASTROMAP — Tap-to-Inspect Panel

   Click anywhere on the map and this script fills a slide-in panel with
   everything you need to decide whether that spot is worth driving to:

     1. Where it is           — Nominatim reverse geocoding
     2. How dark it is        — the light pollution atlas (see skyquality.js)
     3. What the sky will do  — Open-Meteo hourly cloud forecast
     4. A 3-night outlook     — so you can pick the best night this week
     5. What is up there      — moon, planets and the Milky Way, calculated
                                in the browser by js/tonightsky.js

   The panel is a bottom sheet on phones and a side panel on wider screens.

   APIs used (all free, no keys, no accounts):
     Nominatim   https://nominatim.openstreetmap.org  — place names
     Open-Meteo  https://open-meteo.com               — weather

   Both are run by volunteers or funded by goodwill, so we debounce clicks and
   cache results rather than firing a request on every twitch of the mouse.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

const NOMINATIM_API = 'https://nominatim.openstreetmap.org/reverse';
const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast';

// Wait this long after the last click before calling any API. If you click
// three times in quick succession, only the last one costs a request.
const DEBOUNCE_DELAY = 400;

// What counts as "night" for the cloud forecast: 8pm through 4am, in the
// LOCAL time of the place you clicked (Open-Meteo does that conversion for us
// when we pass timezone=auto).
const NIGHT_START_HOUR = 20;
const NIGHT_END_HOUR = 4;

// How many nights the outlook shows. We ask for one extra day of forecast
// because the last night runs past midnight into the following morning.
//
// Seven, because the question a stargazer actually has is not "what is it like
// tonight" but "which night this week should I go". Open-Meteo will give up to
// sixteen days for free; seven is the range where the forecast is still worth
// believing.
const OUTLOOK_NIGHTS = 7;
const FORECAST_DAYS = OUTLOOK_NIGHTS + 1;

/* ----------------------------------------------------------------------------
   Seeing, estimated from the jet stream

   "Seeing" is how steady the air is — whether a star sits as a clean point or
   boils. It is not forecast directly by any free service, but the strongest
   single driver is high-altitude wind shear, so the wind speed at the 250 hPa
   pressure level (about 10 km up, where the jet stream lives) is the standard
   proxy. Slow air up there means steady stars.

   These bands are the usual convention, in km/h. Like the Milky Way rating,
   this is an informed estimate and the panel says so.
   -------------------------------------------------------------------------- */

const SEEING_BANDS = [
    { upTo: 40,       label: 'Excellent' },
    { upTo: 80,       label: 'Good' },
    { upTo: 120,      label: 'Average' },
    { upTo: 160,      label: 'Poor' },
    { upTo: Infinity, label: 'Very poor' }
];

// Within this many degrees of the dew point, moisture starts settling on cold
// glass and a night can end early with fogged optics.
const DEW_WARNING_MARGIN = 2.5;

/* ----------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

let currentInspectLocation = null;
let inspectPanelOpen = false;
let currentMarker = null;

// Timer for the click debounce.
let pendingInspectTimer = null;

// Increments on every inspection. A slow response for an old click checks this
// before touching the panel, so a stale answer can never overwrite a fresh one.
let inspectRequestId = 0;

document.addEventListener('DOMContentLoaded', function () {
    waitForMapReady(initializeInspect);
});

/* ============================================================================
   Wire up the map click and the panel buttons
   ============================================================================ */

function initializeInspect() {
    if (!map) return;

    map.on('click', function (e) {
        const { lat, lng } = e.lngLat;

        // Show the marker straight away so the click feels instant, then wait
        // out the debounce before spending anyone's API quota.
        placeMarker(lat, lng);

        clearTimeout(pendingInspectTimer);
        pendingInspectTimer = setTimeout(() => inspectLocation(lat, lng), DEBOUNCE_DELAY);
    });

    const closeButton = document.getElementById('inspect-close');
    if (closeButton) {
        closeButton.addEventListener('click', closeInspectPanel);
    }

    const stellariumButton = document.getElementById('stellarium-button');
    if (stellariumButton) {
        stellariumButton.addEventListener('click', openStellariumWeb);
    }

    // Escape closes the panel, which is what keyboard users expect.
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && inspectPanelOpen) {
            closeInspectPanel();
        }
    });

    initializeInspectTabs();

    // Work out the panel's position now, so the very first open is already
    // correct rather than settling into place, then keep watching for changes.
    positionInspectPanel();
    watchControlsHeight();

    console.log('✓ Tap-to-inspect initialized');
}

/* ============================================================================
   Tabs

   The panel holds three tabs' worth of detail. Only one is on screen, which is
   what keeps it a fixed, readable height however much goes into it.

   The choice is remembered, because people have a favourite: someone checking
   whether tonight is worth it wants Conditions every time, and someone
   planning a trip wants Forecast every time. Making them re-pick on every tap
   would be tiresome.
   ============================================================================ */

const INSPECT_TAB_STORAGE_KEY = 'astromap-inspect-tab';
const INSPECT_TABS = ['conditions', 'tonight', 'forecast'];

function initializeInspectTabs() {
    const tabs = Array.from(document.querySelectorAll('.inspect-tab'));

    tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
            showInspectTab(tab.getAttribute('data-tab'));
        });
    });

    // Left and right arrows move between tabs, which is what a keyboard user
    // expects of a tab strip and what the ARIA pattern calls for.
    const strip = document.querySelector('.inspect-tabs');
    if (strip) {
        strip.addEventListener('keydown', function (event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

            const current = tabs.indexOf(document.activeElement);
            if (current < 0) return;

            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            // Wraps around, so you can keep pressing in one direction.
            const next = (current + step + tabs.length) % tabs.length;

            tabs[next].focus();
            showInspectTab(tabs[next].getAttribute('data-tab'));
        });
    }

    const remembered = localStorage.getItem(INSPECT_TAB_STORAGE_KEY);
    showInspectTab(INSPECT_TABS.includes(remembered) ? remembered : 'conditions');
}

function showInspectTab(name) {
    if (!INSPECT_TABS.includes(name)) return;

    document.querySelectorAll('.inspect-tab').forEach(function (tab) {
        const isActive = tab.getAttribute('data-tab') === name;
        tab.classList.toggle('is-active', isActive);
        // aria-selected is what a screen reader announces; the class only paints.
        tab.setAttribute('aria-selected', String(isActive));
        // Only the selected tab is in the tab order — arrows move between them.
        tab.tabIndex = isActive ? 0 : -1;
    });

    document.querySelectorAll('.tab-panel').forEach(function (panel) {
        panel.classList.toggle('hidden', panel.getAttribute('data-tab') !== name);
    });

    localStorage.setItem(INSPECT_TAB_STORAGE_KEY, name);
}

/* ============================================================================
   Inspect a location: fetch everything, then fill the panel
   ============================================================================ */

async function inspectLocation(lat, lng) {
    currentInspectLocation = { lat, lng };

    const requestId = ++inspectRequestId;

    openInspectPanel();
    setInspectTitle('Loading…');
    showSkyQualityLoading();
    showWeatherLoading();
    showTonightSkyLoading();

    // Coordinates are known immediately, so show them before anything loads.
    displayPlaceInfo({ name: 'Looking up…' }, lat, lng);

    // Tell the star what it would be saving. The name is not known yet, so it
    // is passed as null — js/favourites.js falls back to the coordinates if you
    // press the star before the lookup finishes.
    setFavouriteContext(lat, lng, null);

    // The recommendations panel measures distances from here now, so its label
    // has to say so. (js/recommend.js)
    updateRecommendOriginLabel();

    // Three independent lookups, so run them together rather than one after
    // another. Promise.all rejects as soon as any one of them rejects, so each
    // fetch function handles its own errors and resolves with null instead.
    const [placeData, weatherData, skyQuality] = await Promise.all([
        fetchPlaceName(lat, lng),
        fetchWeather(lat, lng),
        lookupSkyQuality(lat, lng)
    ]);

    // The user clicked somewhere else while we were waiting — drop this result.
    if (requestId !== inspectRequestId) {
        console.log('Discarding a stale inspect result');
        return;
    }

    displayPlaceInfo(placeData, lat, lng);
    displaySkyQuality(skyQuality);
    displayWeather(weatherData);

    // Now the real name is known, hand it to the star so saving uses it.
    setFavouriteContext(lat, lng, placeData.name);

    // Tonight's sky is pure computation — no network — but it has to wait for
    // the other two: it needs the location's real UTC offset to print times in
    // local time, and the darkness reading to judge the Milky Way.
    const offset = localTimeOffset(weatherData, lng);
    displayTonightSky(lat, lng, offset.seconds, skyQuality, offset.estimated);
}

/**
 * How far ahead of UTC is the place you clicked?
 *
 * Open-Meteo tells us exactly, for free, because we asked for timezone=auto —
 * and its answer already accounts for daylight saving. No extra request needed.
 *
 * If the weather call failed we fall back to the offset implied by longitude:
 * the earth turns 15 degrees an hour. That is close for most places but can be
 * an hour or more out where political time zones ignore the sun, so the panel
 * marks those times as approximate rather than pretending they are exact.
 */
function localTimeOffset(weatherData, lng) {
    if (weatherData && Number.isFinite(weatherData.utc_offset_seconds)) {
        return { seconds: weatherData.utc_offset_seconds, estimated: false };
    }

    return { seconds: Math.round(lng / 15) * 3600, estimated: true };
}

/**
 * Inspect a place the user picked on purpose — a search result, or the
 * "use my location" button — rather than by tapping the map.
 *
 * The map click handler waits out a debounce first, because clicks can arrive
 * in bursts while someone is finding their spot. A search result is a single
 * deliberate choice, so there is nothing to wait for and it runs immediately.
 * Any click-inspection still counting down is cancelled, so a stray earlier tap
 * cannot land on top of the place that was just chosen.
 *
 * Used by js/search.js.
 */
function inspectChosenLocation(lat, lng) {
    clearTimeout(pendingInspectTimer);
    placeMarker(lat, lng);
    inspectLocation(lat, lng);
}

/* ============================================================================
   Marker showing the inspected point
   ============================================================================ */

function placeMarker(lat, lng) {
    if (!map) return;

    if (currentMarker) {
        currentMarker.remove();
    }

    const markerElement = document.createElement('div');
    markerElement.className = 'inspect-marker';

    currentMarker = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
}

/* ============================================================================
   Place name — Nominatim reverse geocoding

   Usage policy: https://operations.osmfoundation.org/policies/nominatim/
   At most one request per second, and identify yourself.

   A note on identification: browsers deliberately refuse to let JavaScript set
   the User-Agent header, so we cannot send a custom one from a web page. What
   we can do is send the Referer automatically (the browser does that for us),
   keep the request rate low through the debounce above, and credit OSM in the
   panel footer. That is the accepted way for a browser app to use Nominatim.
   ============================================================================ */

async function fetchPlaceName(lat, lng) {
    // If the lookup fails we still want to show something useful, so the
    // fallback is the coordinates themselves.
    const fallback = { name: `${lat.toFixed(3)}°, ${lng.toFixed(3)}°`, address: {} };

    try {
        const params = new URLSearchParams({
            lat: lat.toString(),
            lon: lng.toString(),
            format: 'json',
            zoom: '12',                 // suburb / town level, not street level
            'accept-language': 'en'
        });

        const response = await fetch(`${NOMINATIM_API}?${params}`, {
            headers: { 'Accept-Language': 'en' }
        });

        if (!response.ok) {
            throw new Error(`Nominatim returned ${response.status}`);
        }

        const data = await response.json();

        // Clicking in the ocean or the desert returns an error field and no
        // address. That is a legitimate answer, not a failure.
        if (data.error || !data.address) {
            return { name: 'Unnamed location', address: {} };
        }

        return {
            name: buildPlaceName(data.address),
            address: data.address,
            fullAddress: data.display_name
        };

    } catch (error) {
        console.error('✗ Nominatim error:', error);
        return fallback;
    }
}

/**
 * Nominatim returns a whole address tree. Pick the most specific useful part,
 * then add the region and country for context — "Katoomba, New South Wales".
 */
function buildPlaceName(address) {
    // Most specific first: the first one that exists wins.
    const specificKeys = [
        'hamlet', 'village', 'suburb', 'town', 'city_district',
        'city', 'municipality', 'county', 'state_district'
    ];

    const parts = [];

    const specific = specificKeys.map(key => address[key]).find(value => value);
    if (specific) parts.push(specific);

    if (address.state && address.state !== specific) parts.push(address.state);
    if (address.country && parts.length < 2) parts.push(address.country);

    return parts.length ? parts.join(', ') : 'Unnamed location';
}

/* ============================================================================
   Weather — Open-Meteo

   Docs: https://open-meteo.com/en/docs

   Two things worth knowing, because both caused bugs earlier on:

   1. Variable names must be exact. Asking for a name Open-Meteo does not know
      (cloud_cover_2m_max, say) does not error — you simply get nothing back,
      which shows up in the UI as "undefined".

   2. `visibility` is an HOURLY variable. It has to be requested under `hourly`
      as well as `current`, and it is reported in METRES.

   We ask for hourly cloud cover split into low, mid and high layers because
   they matter differently to an astronomer: high cirrus can still be observed
   through, low stratus cannot.
   ============================================================================ */

async function fetchWeather(lat, lng) {
    try {
        const params = new URLSearchParams({
            latitude: lat.toString(),
            longitude: lng.toString(),
            current: 'temperature_2m,relative_humidity_2m,dew_point_2m,cloud_cover,visibility,wind_speed_10m,weather_code',
            // dew_point_2m and temperature_2m together say whether your optics
            // will fog; wind_speed_250hPa is the jet stream, for seeing.
            hourly: 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,' +
                    'dew_point_2m,temperature_2m,wind_speed_250hPa',
            forecast_days: FORECAST_DAYS.toString(),
            temperature_unit: 'celsius',
            wind_speed_unit: 'kmh',
            // timezone=auto reports every timestamp in the LOCAL time of the
            // clicked point, which is what makes "8pm to 4am" mean the right
            // thing no matter where in the world you clicked.
            timezone: 'auto'
        });

        const response = await fetch(`${OPEN_METEO_API}?${params}`);

        if (!response.ok) {
            throw new Error(`Open-Meteo returned ${response.status}`);
        }

        return await response.json();

    } catch (error) {
        console.error('✗ Open-Meteo error:', error);
        return null;
    }
}

/* ============================================================================
   Work out what the sky does each night

   Open-Meteo hands back a flat list of hours:
       time:        ["2026-08-18T00:00", "2026-08-18T01:00", ...]
       cloud_cover: [12, 15, ...]

   We slice that list into nights. Night 0 runs from 8pm on the first day to
   4am on the second, night 1 from 8pm on the second day, and so on.

   The timestamps are deliberately read as plain text rather than fed to
   `new Date()`. They are already local to the clicked location, and handing
   them to Date would reinterpret them in the BROWSER's timezone — so planning
   a night in Perth from a laptop in London would come out hours wrong.
   ============================================================================ */

function summariseNights(weatherData) {
    if (!weatherData || !weatherData.hourly || !weatherData.hourly.time) {
        return [];
    }

    const hourly = weatherData.hourly;

    // The list of calendar days covered by the forecast, in order.
    const days = [...new Set(hourly.time.map(stamp => stamp.slice(0, 10)))];

    const nights = [];

    for (let night = 0; night < OUTLOOK_NIGHTS; night++) {
        const eveningDate = days[night];
        const morningDate = days[night + 1];

        // Not enough forecast to cover this night — stop rather than guess.
        if (!eveningDate || !morningDate) break;

        const hourIndexes = [];

        hourly.time.forEach(function (stamp, index) {
            const date = stamp.slice(0, 10);
            const hour = parseInt(stamp.slice(11, 13), 10);

            const isEvening = date === eveningDate && hour >= NIGHT_START_HOUR;
            const isEarlyMorning = date === morningDate && hour < NIGHT_END_HOUR;

            if (isEvening || isEarlyMorning) {
                hourIndexes.push(index);
            }
        });

        if (hourIndexes.length === 0) continue;

        // pick() reads one hourly variable safely. If Open-Meteo did not return
        // a series at all — an unsupported variable, or a model that does not
        // carry it — the whole list comes back empty rather than throwing.
        const pick = name => hourly[name]
            ? hourIndexes.map(i => hourly[name][i])
            : [];

        const totals = pick('cloud_cover');

        // Which hour of the night is clearest? Handy for knowing when to set up.
        // Start from the first hour that actually has a reading, so a gap at
        // the beginning of the night cannot win by default.
        let clearest = null;
        hourIndexes.forEach(function (i) {
            const cloud = numberOrNull(hourly.cloud_cover ? hourly.cloud_cover[i] : null);
            if (cloud === null) return;
            if (clearest === null || cloud < clearest.cloud) {
                clearest = { cloud: cloud, hour: parseInt(hourly.time[i].slice(11, 13), 10) };
            }
        });

        // How close the air gets to its dew point at the coldest part of the
        // night — the moment optics are most likely to fog.
        const temperatures = pick('temperature_2m').filter(v => numberOrNull(v) !== null);
        const dewPoints = pick('dew_point_2m').filter(v => numberOrNull(v) !== null);
        const coldest = temperatures.length ? Math.min.apply(null, temperatures) : null;

        nights.push({
            date: eveningDate,
            cloudTotal: average(totals),
            cloudLow: average(pick('cloud_cover_low')),
            cloudMid: average(pick('cloud_cover_mid')),
            cloudHigh: average(pick('cloud_cover_high')),
            visibilityMetres: average(pick('visibility')),
            clearestHour: clearest ? clearest.hour : null,
            clearestCloud: clearest ? clearest.cloud : null,
            minTemperature: coldest,
            dewPoint: average(dewPoints),
            jetWind: average(pick('wind_speed_250hPa'))
        });
    }

    return nights;
}

/* ============================================================================
   Filling in the panel — place
   ============================================================================ */

function displayPlaceInfo(placeData, lat, lng) {
    // The name is the panel's title and the coordinates sit under it, which
    // saves a whole section and keeps everything on one screen.
    setInspectTitle(placeData.name);
    setText('place-coords', `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`);
}

/* ============================================================================
   Filling in the panel — sky quality (light pollution)
   ============================================================================ */

function showSkyQualityLoading() {
    setBarWidth('darkness-fill', 0);
    setText('darkness-label', 'Reading the atlas…');
    setText('darkness-detail', '');
    setText('darkness-bortle', '');
}

function displaySkyQuality(skyQuality) {
    // lookupSkyQuality never guesses. If it could not get a real number it
    // says so, and so do we.
    if (!skyQuality || !skyQuality.available) {
        setBarWidth('darkness-fill', 0);
        setText('darkness-label', 'Not available here');
        setText('darkness-detail', explainMissingSkyQuality(skyQuality));
        setText('darkness-bortle', '');
        return;
    }

    setBarWidth('darkness-fill', skyQuality.score);
    setText('darkness-label', skyQuality.label);

    // Give the real numbers as well as the friendly label, because the numbers
    // are what let you compare two spots properly.
    // Kept short enough to stay on one line in the panel: every line that wraps
    // here is a line the panel grows by, and the panel is sized to fit without
    // scrolling.
    setText(
        'darkness-detail',
        `Zone ${skyQuality.zone} · ` +
        `${skyQuality.magnitudes.toFixed(2)} mag/arcsec² · ` +
        `${formatLightPollutionIndex(skyQuality.index)}× natural glow`
    );

    // The familiar number, offered second and clearly hedged. The "≈" and the
    // word "rough" are doing real work here: this is converted from the
    // brightness figure above, not observed.
    setText(
        'darkness-bortle',
        `≈ Bortle ${skyQuality.bortle} — a rough conversion, not a measurement. `
    );
}

function explainMissingSkyQuality(skyQuality) {
    const reason = skyQuality ? skyQuality.reason : 'network';

    if (reason === 'out-of-bounds') {
        return 'The atlas covers 65°S to 75°N only.';
    }
    if (reason === 'unsupported') {
        return 'Your browser cannot unzip the atlas data.';
    }
    if (reason === 'no-data') {
        return 'The atlas has no data for this square.';
    }
    return 'Could not reach the light pollution atlas.';
}

/* ============================================================================
   Filling in the panel — weather
   ============================================================================ */

function showWeatherLoading() {
    ['temp-current', 'cloud-current', 'visibility-current',
     'humidity-current', 'wind-current'].forEach(id => setText(id, '…'));

    setText('night-cloud-total', '…');
    setText('night-cloud-low', '…');
    setText('night-cloud-mid', '…');
    setText('night-cloud-high', '…');
    setText('night-clearest', '');

    const forecastContainer = document.getElementById('forecast-nights');
    if (forecastContainer) {
        forecastContainer.innerHTML = '<p class="text-small text-secondary">Loading forecast…</p>';
    }
}

function displayWeather(weatherData) {
    if (!weatherData || !weatherData.current) {
        showWeatherUnavailable();
        return;
    }

    const current = weatherData.current;

    setText('temp-current', formatValue(current.temperature_2m, '°C'));
    setText('cloud-current', formatValue(current.cloud_cover, '%'));
    setText('visibility-current', formatVisibility(current.visibility));
    setText('humidity-current', formatValue(current.relative_humidity_2m, '%'));
    setText('wind-current', formatValue(current.wind_speed_10m, ' km/h'));
    setText('dew-current', formatValue(current.dew_point_2m, '°C'));

    // Open-Meteo tells us the ground height of the nearest model cell, free,
    // in every reply. Height matters: you climb above haze and low cloud, and
    // the air above you is thinner.
    setText('elevation-current', formatValue(weatherData.elevation, ' m'));

    const nights = summariseNights(weatherData);
    displayTonight(nights[0]);
    displayDewOutlook(nights[0], current);
    displaySeeing(nights[0]);

    // The moon glyphs in the outlook lean the correct way for the hemisphere,
    // so the outlook needs to know where it is describing.
    displayOutlook(nights, weatherData.latitude, weatherData.utc_offset_seconds || 0);
}

/**
 * How likely is dew tonight?
 *
 * Air holds less moisture as it cools. When the temperature falls to the dew
 * point, the extra has to go somewhere, and cold glass pointed at a cold sky is
 * the first place it lands. A telescope can be dewed up and useless while the
 * sky overhead is perfectly clear, which is why this is worth its own line.
 */
function displayDewOutlook(tonight, current) {
    const spreadNow = numberOrNull(current.temperature_2m) !== null
                   && numberOrNull(current.dew_point_2m) !== null
        ? current.temperature_2m - current.dew_point_2m
        : null;

    if (!tonight || numberOrNull(tonight.minTemperature) === null
                 || numberOrNull(tonight.dewPoint) === null) {
        setText('dew-note', spreadNow === null
            ? ''
            : `${spreadNow.toFixed(1)}° above the dew point right now.`);
        return;
    }

    const overnightMargin = tonight.minTemperature - tonight.dewPoint;

    if (overnightMargin <= 0) {
        setText('dew-note', 'The air reaches its dew point tonight — expect dew on optics.');
    } else if (overnightMargin < DEW_WARNING_MARGIN) {
        setText('dew-note',
            `Only ${overnightMargin.toFixed(1)}° above the dew point at its coldest — dew is likely.`);
    } else {
        setText('dew-note',
            `${overnightMargin.toFixed(1)}° above the dew point at its coldest — dew unlikely.`);
    }
}

function displaySeeing(tonight) {
    const jet = tonight ? numberOrNull(tonight.jetWind) : null;

    if (jet === null) {
        setText('seeing-current', '—');
        setText('seeing-note', '');
        return;
    }

    const band = SEEING_BANDS.find(entry => jet < entry.upTo);
    setText('seeing-current', band.label);
    setText('seeing-note',
        `Estimated from ${Math.round(jet)} km/h of jet stream overhead. ` +
        'Steady high air means stars sit still rather than boiling.');
}

function showWeatherUnavailable() {
    ['temp-current', 'cloud-current', 'visibility-current',
     'humidity-current', 'wind-current'].forEach(id => setText(id, '—'));

    setText('night-cloud-total', '—');
    setText('night-cloud-low', '—');
    setText('night-cloud-mid', '—');
    setText('night-cloud-high', '—');
    setText('night-clearest', '');
    setText('dew-current', '—');
    setText('dew-note', '');
    setText('elevation-current', '—');
    setText('seeing-current', '—');
    setText('seeing-note', '');
    setText('forecast-best', '');

    const forecastContainer = document.getElementById('forecast-nights');
    if (forecastContainer) {
        forecastContainer.innerHTML =
            '<p class="text-small text-secondary">Weather is unavailable right now. ' +
            'Everything else on this panel still works.</p>';
    }
}

/**
 * Tonight in detail: average cloud over the night, split by altitude.
 */
function displayTonight(night) {
    if (!night) {
        setText('night-cloud-total', '—');
        setText('night-cloud-low', '—');
        setText('night-cloud-mid', '—');
        setText('night-cloud-high', '—');
        setText('night-clearest', '');
        return;
    }

    setText('night-cloud-total', formatValue(night.cloudTotal, '%'));
    setText('night-cloud-low', formatValue(night.cloudLow, '%'));
    setText('night-cloud-mid', formatValue(night.cloudMid, '%'));
    setText('night-cloud-high', formatValue(night.cloudHigh, '%'));

    if (night.clearestCloud !== null) {
        setText(
            'night-clearest',
            `Clearest around ${formatHour(night.clearestHour)} ` +
            `(${Math.round(night.clearestCloud)}% cloud)`
        );
    } else {
        setText('night-clearest', '');
    }
}

/**
 * The week ahead: one row per night, so you can run your eye down the column
 * and pick a night rather than comparing seven separate cards.
 *
 * Cloud alone does not answer the question. A perfectly clear night with a
 * full moon overhead is a poor night for anything faint, so the moon is shown
 * beside the cloud and both feed the "best night" line underneath.
 *
 * Rows are built with createElement rather than innerHTML, matching the rest
 * of the app.
 */
function displayOutlook(nights, latitude, utcOffsetSeconds) {
    const container = document.getElementById('forecast-nights');
    if (!container) return;

    container.innerHTML = '';
    setText('forecast-best', '');

    if (nights.length === 0) {
        container.innerHTML =
            '<p class="text-small text-secondary">No night forecast available.</p>';
        return;
    }

    nights.forEach(function (night, position) {
        const moon = (typeof moonOnNight === 'function')
            ? moonOnNight(night.date, utcOffsetSeconds)
            : null;

        const row = document.createElement('div');
        row.className = 'forecast-night';

        const label = document.createElement('span');
        label.className = 'forecast-date';
        label.textContent = position === 0 ? 'Tonight' : weekdayName(night.date);

        // Moon glyph and its lit percentage, side by side.
        const moonCell = document.createElement('span');
        moonCell.className = 'forecast-moon-cell';
        if (moon && typeof createMoonGlyph === 'function') {
            moonCell.appendChild(
                createMoonGlyph(moon.illumination, moon.waxing, latitude, 'moon-glyph-small'));
            const pct = document.createElement('span');
            pct.className = 'forecast-moon-pct';
            pct.textContent = `${Math.round(moon.illumination * 100)}%`;
            moonCell.appendChild(pct);
            moonCell.title = `${moon.phaseName}, ${Math.round(moon.illumination * 100)}% lit`;
        }

        // Drawn as "how clear", so a longer bar always means a better night.
        const clearness = numberOrNull(night.cloudTotal) === null
            ? 0
            : 100 - night.cloudTotal;

        const track = document.createElement('span');
        track.className = 'forecast-bar';
        const fill = document.createElement('span');
        fill.className = 'forecast-bar-fill';
        fill.style.width = clearness + '%';
        track.appendChild(fill);

        const value = document.createElement('span');
        value.className = 'forecast-cloud';
        value.textContent = formatValue(night.cloudTotal, '%');
        value.title = describeCloud(night.cloudTotal);

        row.append(label, moonCell, track, value);
        container.appendChild(row);
    });

    displayBestNight(nights, utcOffsetSeconds);
}

/* ----------------------------------------------------------------------------
   Which night to go

   Cloud matters most — no amount of moonless sky helps under an overcast — but
   a bright moon washes out everything faint, so it carries real weight too.
   Seventy/thirty reflects that: the moon can demote a night, but it cannot
   rescue a cloudy one.

   This is a suggestion, not a verdict, and it is worded as one.
   -------------------------------------------------------------------------- */

const BEST_NIGHT_CLOUD_WEIGHT = 0.7;
const BEST_NIGHT_MOON_WEIGHT = 0.3;

function displayBestNight(nights, utcOffsetSeconds) {
    let best = null;

    nights.forEach(function (night, position) {
        const cloud = numberOrNull(night.cloudTotal);
        if (cloud === null) return;

        const moon = (typeof moonOnNight === 'function')
            ? moonOnNight(night.date, utcOffsetSeconds)
            : null;
        const moonLit = moon ? moon.illumination * 100 : 0;

        const score = BEST_NIGHT_CLOUD_WEIGHT * (100 - cloud)
                    + BEST_NIGHT_MOON_WEIGHT * (100 - moonLit);

        if (!best || score > best.score) {
            best = { score: score, position: position, night: night, moonLit: moonLit };
        }
    });

    if (!best) {
        setText('forecast-best', '');
        return;
    }

    const name = best.position === 0 ? 'tonight' : weekdayName(best.night.date);

    setText('forecast-best',
        `Best of the week looks like ${name} — ` +
        `${Math.round(best.night.cloudTotal)}% cloud, ` +
        `${Math.round(best.moonLit)}% moon.`);
}

/**
 * Plain-English cloud description. Deliberately words rather than emoji: the
 * Astronomer theme must not put coloured pixels on screen.
 */
function describeCloud(cloudPercent) {
    if (numberOrNull(cloudPercent) === null) return 'No data';
    if (cloudPercent < 20) return 'Clear';
    if (cloudPercent < 45) return 'Mostly clear';
    if (cloudPercent < 70) return 'Partly cloudy';
    if (cloudPercent < 90) return 'Cloudy';
    return 'Overcast';
}

/* ============================================================================
   Small formatting helpers

   Open-Meteo returns null for anything its model does not cover, and null is
   a genuine answer meaning "we do not know". Everything below is careful to
   show a dash for that rather than "undefined" or a misleading zero.
   ============================================================================ */

/** Returns the number, or null for null / undefined / NaN. */
function numberOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function formatValue(value, unit) {
    const number = numberOrNull(value);
    return number === null ? '—' : `${Math.round(number)}${unit}`;
}

/** Open-Meteo reports visibility in metres; kilometres read better. */
function formatVisibility(metres) {
    const number = numberOrNull(metres);
    if (number === null) return 'Not reported';

    const km = number / 1000;
    return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Average of a list, skipping any gaps. Returns null if there is nothing. */
function average(values) {
    const usable = values.filter(value => numberOrNull(value) !== null);
    if (usable.length === 0) return null;

    const total = usable.reduce((sum, value) => sum + value, 0);
    return total / usable.length;
}

/** 20 -> "8pm", 0 -> "12am", 13 -> "1pm" */
function formatHour(hour24) {
    const suffix = hour24 < 12 ? 'am' : 'pm';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}${suffix}`;
}

/**
 * "2026-08-19" -> "Wed".
 * Built from the date parts so it is not shifted by the browser's timezone.
 */
function weekdayName(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function setText(elementId, text) {
    const element = document.getElementById(elementId);
    if (element) element.textContent = text;
}

function setBarWidth(elementId, percent) {
    const element = document.getElementById(elementId);
    if (element) element.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

/* ============================================================================
   Opening, closing and sizing the panel
   ============================================================================ */

function openInspectPanel() {
    const panel = document.getElementById('inspect-panel');
    if (!panel) return;

    // Position first, then reveal. The other way round shows the panel for one
    // frame at its fallback position and it visibly jumps into place.
    positionInspectPanel();

    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    inspectPanelOpen = true;
}

function closeInspectPanel() {
    const panel = document.getElementById('inspect-panel');
    if (panel) {
        panel.classList.add('hidden');
        panel.setAttribute('aria-hidden', 'true');
    }

    inspectPanelOpen = false;
    currentInspectLocation = null;

    // Nothing is selected any more, so the star has nothing to act on and the
    // recommendations panel goes back to measuring from the map centre.
    clearFavouriteContext();
    updateRecommendOriginLabel();

    // Cancel any inspection still in flight so it cannot reopen the panel.
    clearTimeout(pendingInspectTimer);
    inspectRequestId++;

    if (currentMarker) {
        currentMarker.remove();
        currentMarker = null;
    }
}

function setInspectTitle(text) {
    setText('inspect-title', text);
}

/* ----------------------------------------------------------------------------
   Keep the panel clear of the controls above it

   The panel sits at the bottom of the same left-hand column as the search box
   and the light pollution controls. Rather than hard-coding a top offset —
   which goes wrong the moment anything up there changes height, for instance
   when its text wraps on a narrow screen — we measure where the whole column
   ends and write the answer into a CSS custom property.

   Measuring the column rather than one panel inside it is what let the search
   box be added above without touching a single number down here.

   styles.css then uses --inspect-panel-top for both the panel's `top` and its
   `max-height`, so the two always agree and the panel can never grow up over
   the controls.

   Doing it this way means there is exactly one place that decides the panel's
   vertical position, at every screen size. The previous version had a fixed
   value in one media query and a different one in the base rule, and the two
   quietly fought each other.
   -------------------------------------------------------------------------- */

// Breathing room between the two panels, in pixels.
const PANEL_GAP = 12;

// Always leave at least this much room for the panel itself, even on a very
// short window. Below this it would be more frustrating than useful.
const MIN_PANEL_HEIGHT = 180;

function positionInspectPanel() {
    const controlsColumn = document.querySelector('.map-controls');

    // getBoundingClientRect is relative to the viewport, so .bottom is exactly
    // "how far down the screen do those controls end".
    const controlsBottom = controlsColumn
        ? controlsColumn.getBoundingClientRect().bottom
        : 96;

    // Never push the panel so far down that nothing is left of it.
    const highestAllowedTop = window.innerHeight - MIN_PANEL_HEIGHT;
    const top = Math.min(Math.round(controlsBottom + PANEL_GAP), highestAllowedTop);

    document.documentElement.style.setProperty('--inspect-panel-top', top + 'px');
}

// Re-measure when the window is resized, since the controls above wrap
// differently at different widths.
window.addEventListener('resize', positionInspectPanel);

// The controls column also changes height on its own, without the window
// moving at all — the search status line appears while a search runs, then
// disappears again. A resize listener never sees that.
//
// ResizeObserver watches the element itself and fires whenever its size
// changes, whatever the cause, so the panel below can never end up overlapping
// it. Guarded with a typeof check because it is the one piece of this file that
// a genuinely old browser might not have; without it the layout is simply
// static rather than broken.
function watchControlsHeight() {
    if (typeof ResizeObserver === 'undefined') return;

    const controlsColumn = document.querySelector('.map-controls');
    if (!controlsColumn) return;

    new ResizeObserver(positionInspectPanel).observe(controlsColumn);
}

/* ============================================================================
   Stellarium Web

   Opens the free browser planetarium at the selected coordinates so you can
   see what will actually be up.
   ============================================================================ */

function openStellariumWeb() {
    if (!currentInspectLocation) return;

    const { lat, lng } = currentInspectLocation;
    window.open(
        `https://stellarium-web.org/?latitude=${lat}&longitude=${lng}`,
        '_blank',
        'noopener'
    );
}
