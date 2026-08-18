/* ============================================================================
   ASTROMAP — Tonight's Sky

   WHAT THIS DOES
   --------------
   Given a point on the map, this works out what you would actually see there
   tonight:

     1. When the night is    — sunset, sunrise, and the hours of true darkness
     2. The Moon             — phase, how much of it is lit, when it is up
     3. The planets          — which naked-eye planets clear the horizon,
                               when they rise and set, and how high they climb
     4. The Milky Way        — a plain-English estimate of whether you will
                               see it, from darkness + moon + where the
                               galactic centre sits

   All of it is real computation. Nothing here is a placeholder.

   THE LIBRARY
   -----------
   Positions come from astronomy-engine by Don Cross (MIT licensed), loaded
   from a CDN in index.html. It is a full ephemeris, not an approximation, and
   it runs entirely in the browser — no API key, no network calls, no account.
   https://github.com/cosinekitty/astronomy

   If that CDN is unreachable the global `Astronomy` simply will not exist. We
   check for it and show a friendly message instead of crashing, so the rest of
   the app keeps working.

   WHY THIS FILE ALSO DRAWS ITS OWN SECTION
   ----------------------------------------
   js/skyquality.js is pure data and lets js/inspect.js do the drawing, because
   its numbers are woven in among the weather. "Tonight's sky" is different: it
   is one self-contained block of the panel, so this file owns it from the
   calculation right through to the HTML. One file, one section, one job — and
   it stops inspect.js growing without limit.

   inspect.js only ever calls two functions from here:
       showTonightSkyLoading()
       displayTonightSky(lat, lng, utcOffsetSeconds, skyQuality, offsetIsEstimated)

   Going the other way, this file borrows one helper — setText() from
   inspect.js. These scripts are plain <script> tags rather than modules, so
   they all share one global namespace and can see each other's functions. That
   is why every name in this project is distinct: two files declaring the same
   `const` at the top level would stop the page dead.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

// The five planets you can see with your eyes alone. Uranus (magnitude ~5.7)
// and Neptune (~7.8) are deliberately left out: both need binoculars or a
// telescope, so listing them under "tonight's sky" would set you up for a
// disappointing drive.
const NAKED_EYE_PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

// Below about 10 degrees you are looking through so much air — and past so
// many trees, hills and rooftops — that a planet is not realistically
// observable. We use this to decide what counts as "visible tonight".
const MIN_USEFUL_ALTITUDE = 10;

// How often to check each object's height during the night. Ten minutes is
// fine detail for a body that takes hours to cross the sky, and the whole
// night's worth of sampling still finishes in a few milliseconds.
const SAMPLE_MINUTES = 10;

// Astronomical twilight: the sun 18 degrees below the horizon. Above this the
// sky still carries a glow that hides faint things like the Milky Way.
const ASTRONOMICAL_TWILIGHT_ALTITUDE = -18;

// The galactic centre — the bright, crowded heart of the Milky Way in
// Sagittarius. Its position (Sgr A*, J2000) is fixed, so we hand it to
// astronomy-engine as a custom star and then ask for its altitude like any
// other body. Whether this point is up, and how high, is the single biggest
// factor in how impressive the Milky Way looks.
const GALACTIC_CENTRE_RA = 17.761124;      // right ascension, in hours
const GALACTIC_CENTRE_DEC = -29.007805;    // declination, in degrees
const GALACTIC_CENTRE_DISTANCE_LY = 26000; // only needs to be roughly right

// Tracks whether we have registered the galactic centre yet, so we only do it
// once rather than on every click.
let galacticCentreDefined = false;

/* ============================================================================
   Entry point — everything the panel needs, in one object

   Returns either
       { available: false, reason: 'library' }
   or
       { available: true, night, moon, planets, milkyWay }
   ============================================================================ */

function computeTonightSky(lat, lng, utcOffsetSeconds, skyQuality, now) {
    // The CDN failed, or we are offline. Say so rather than throwing.
    if (typeof Astronomy === 'undefined') {
        return { available: false, reason: 'library' };
    }

    defineGalacticCentreOnce();

    // `now` is normally left out and defaults to the real clock. It exists so
    // the calculations can be checked against a fixed date — testing a polar
    // midsummer night is impossible if the answer changes every day.
    const startedAt = now || new Date();

    const observer = new Astronomy.Observer(lat, lng, 0);
    const anchor = observingNightAnchor(startedAt, utcOffsetSeconds);

    const night = findNightWindow(observer, anchor);

    // Planets and the Milky Way are only worth reporting when there is some
    // sort of night. Under the midnight sun there simply is not one.
    const canObserve = night.kind !== 'midnight-sun';

    // Order matters here. The Milky Way estimate needs to know how badly the
    // moon spoils the night, so the moon has to be worked out first and its
    // interference passed along.
    const moon = describeMoon(observer, night, anchor);

    return {
        available: true,
        night: night,
        moon: moon,
        planets: canObserve ? findVisiblePlanets(observer, night, anchor) : [],
        milkyWay: canObserve
            ? assessMilkyWay(observer, night, skyQuality, moon.interference)
            : null
    };
}

/**
 * Register the galactic centre as a custom star, once per page load.
 * astronomy-engine keeps eight user-defined star slots; we use the first.
 */
function defineGalacticCentreOnce() {
    if (galacticCentreDefined) return;

    Astronomy.DefineStar(
        Astronomy.Body.Star1,
        GALACTIC_CENTRE_RA,
        GALACTIC_CENTRE_DEC,
        GALACTIC_CENTRE_DISTANCE_LY
    );

    galacticCentreDefined = true;
}

/* ============================================================================
   When is "tonight"?

   Not the calendar day. If you open this at 2am you are already out observing,
   and "tonight" means the night you are standing in — the one that began at
   sunset yesterday evening.

   Astronomers handle this by treating noon, not midnight, as the boundary
   between one observing night and the next. So we find the most recent local
   noon and search forward from there: before midday that is yesterday's noon,
   after midday it is today's.

   Everything is anchored to the LOCAL time of the place you clicked, using the
   UTC offset Open-Meteo already gave us, so planning a night in Chile from a
   laptop in Australia still means the right night.
   ============================================================================ */

function observingNightAnchor(now, utcOffsetSeconds) {
    // Shift the instant by the offset, then read its UTC fields. Those fields
    // are now the wall-clock numbers at the clicked location. This trick keeps
    // us clear of the browser's own timezone entirely.
    const local = new Date(now.getTime() + utcOffsetSeconds * 1000);

    const hour = local.getUTCHours();
    const daysBack = hour < 12 ? 1 : 0;

    const noonLocal = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() - daysBack,
        12, 0, 0
    );

    // Undo the shift to get back to a real moment in time.
    return new Date(noonLocal - utcOffsetSeconds * 1000);
}

/* ============================================================================
   The shape of the night

   Returns sunset, sunrise, and the window of true astronomical darkness, plus
   a `kind` describing what sort of night it is at all:

       'normal'        an ordinary night, possibly without full darkness
       'midnight-sun'  high latitude in summer — the sun never sets
       'polar-night'   high latitude in winter — the sun never rises

   Those last two are why every search below is allowed to return null. At 70
   degrees north in June there is no sunset to find, and pretending otherwise
   would produce nonsense.
   ============================================================================ */

function findNightWindow(observer, anchor) {
    const sun = Astronomy.Body.Sun;

    // One day, not two, and that limit is doing real work.
    //
    // The anchor is local noon, so if the sun sets at all today it sets within
    // twelve hours — a one-day window can never miss a genuine sunset. Allowing
    // two days does the opposite of helping: at McMurdo on 18 August 2026 the
    // sun peaks at 0.7 degrees BELOW the horizon, so there is no sunset that
    // day, and a two-day search happily returned one 25.6 hours later. That
    // belonged to the following day — the first time the sun cleared the
    // horizon all season, for a 77-minute day — and it made the app report an
    // ordinary night in the middle of polar night.
    //
    // With a one-day window the search correctly finds nothing, and the polar
    // branch below classifies the day properly.
    const sunset = Astronomy.SearchRiseSet(sun, observer, -1, anchor, 1);
    const sunrise = sunset
        ? Astronomy.SearchRiseSet(sun, observer, +1, sunset.date, 1)
        : null;

    // No sunset within two days means the sun is either permanently up or
    // permanently down. The anchor is local noon, so the sun is as high as it
    // gets — if it is still below the horizon then, this is polar night.
    if (!sunset || !sunrise) {
        const highest = altitudeOf(sun, observer, anchor);

        if (highest > 0) {
            return {
                kind: 'midnight-sun',
                sunset: null, sunrise: null,
                darkStart: null, darkEnd: null,
                hasTrueDarkness: false
            };
        }

        // Polar night: dark around the clock, so use the whole 24 hours.
        const dayLater = new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
        return {
            kind: 'polar-night',
            sunset: null, sunrise: null,
            darkStart: anchor, darkEnd: dayLater,
            hasTrueDarkness: true
        };
    }

    // True darkness begins when the sun passes 18 degrees below the horizon.
    // In summer at moderate latitudes it may never get there — Scotland in
    // June, for instance — and these searches correctly return null.
    const darkStart = Astronomy.SearchAltitude(
        sun, observer, -1, sunset.date, 1, ASTRONOMICAL_TWILIGHT_ALTITUDE
    );
    const darkEnd = darkStart
        ? Astronomy.SearchAltitude(
            sun, observer, +1, darkStart.date, 1, ASTRONOMICAL_TWILIGHT_ALTITUDE
          )
        : null;

    const hasTrueDarkness = Boolean(darkStart && darkEnd);

    return {
        kind: 'normal',
        sunset: sunset.date,
        sunrise: sunrise.date,
        // When there is no astronomical darkness, fall back to the hours
        // between sunset and sunrise. It is the best window available, and the
        // panel says plainly that full darkness never arrives.
        darkStart: hasTrueDarkness ? darkStart.date : sunset.date,
        darkEnd: hasTrueDarkness ? darkEnd.date : sunrise.date,
        hasTrueDarkness: hasTrueDarkness
    };
}

/* ----------------------------------------------------------------------------
   How high is something, right now?

   Two steps, and both are needed. Equator() gives the object's position on the
   celestial sphere as seen from this exact spot on the Earth's surface;
   Horizon() then turns that into the everyday question "how far above the
   horizon, and in which direction".

   'normal' asks for refraction to be included: air bends light slightly, so a
   body sitting on the horizon actually appears a little above it.
   -------------------------------------------------------------------------- */

function altitudeOf(body, observer, when) {
    const equator = Astronomy.Equator(body, when, observer, true, true);
    return Astronomy.Horizon(when, observer, equator.ra, equator.dec, 'normal').altitude;
}

/**
 * Step through the dark window and record how an object behaves across it:
 * the highest it gets, when that happens, and what share of the night it
 * spends above the horizon.
 */
function sampleAcrossNight(body, observer, night) {
    const stepMs = SAMPLE_MINUTES * 60 * 1000;
    const start = night.darkStart.getTime();
    const end = night.darkEnd.getTime();

    let peakAltitude = -90;
    let peakTime = null;
    let samplesAbove = 0;
    let samplesTotal = 0;

    for (let t = start; t <= end; t += stepMs) {
        const when = new Date(t);
        const altitude = altitudeOf(body, observer, when);

        samplesTotal++;
        if (altitude > 0) samplesAbove++;

        if (altitude > peakAltitude) {
            peakAltitude = altitude;
            peakTime = when;
        }
    }

    return {
        peakAltitude: peakAltitude,
        peakTime: peakTime,
        fractionUp: samplesTotal > 0 ? samplesAbove / samplesTotal : 0
    };
}

/* ============================================================================
   The Moon

   Two different numbers describe the moon, and they are easy to confuse:

     MoonPhase()   an angle from 0 to 360 degrees. 0 is new, 90 first quarter,
                   180 full, 270 last quarter. This is what tells us the phase
                   NAME, and whether the moon is waxing or waning.

     Illumination().phase_fraction
                   the fraction of the disc that is actually lit, 0 to 1. This
                   is the percentage people quote.

   For an observer, what matters most is not just how bright the moon is but
   whether it is in the sky at all. A brilliant 90% moon that sets at 10pm
   leaves you a fine dark morning; a 40% moon up all night is worse.

   WHERE THE SEARCH STARTS MATTERS
   -------------------------------
   Rise and set are searched forward from the moment darkness falls, not from
   midday. Searching from midday looks correct and is not: on a waxing crescent
   evening the moon has already risen by lunchtime, so the next moonrise found
   is tomorrow morning's, and the panel ends up quoting times for a night the
   user is not planning. Starting at nightfall gives the moonset that actually
   interrupts tonight.
   ============================================================================ */

function describeMoon(observer, night, anchor) {
    const moon = Astronomy.Body.Moon;

    const phaseAngle = Astronomy.MoonPhase(anchor);
    const illumination = Astronomy.Illumination(moon, anchor).phase_fraction;

    // Waxing means growing: the lit fraction increases from new to full.
    const waxing = phaseAngle < 180;

    // Under the midnight sun there is no dark window, so fall back to the
    // observing-night anchor purely so the moon can still be described.
    const from = night.darkStart || anchor;

    const rise = Astronomy.SearchRiseSet(moon, observer, +1, from, 2);
    const set = Astronomy.SearchRiseSet(moon, observer, -1, from, 2);

    // Which of those two times is the useful one depends on whether the moon
    // is already up when the sky goes dark.
    const upWhenDarkFalls = altitudeOf(moon, observer, from) > 0;

    // How much of the dark window does it spoil? A moon that is bright AND up
    // is the problem; either one alone is survivable.
    const track = night.darkStart ? sampleAcrossNight(moon, observer, night) : null;
    const fractionUp = track ? track.fractionUp : 0;
    const interference = illumination * fractionUp;

    return {
        phaseAngle: phaseAngle,
        phaseName: moonPhaseName(phaseAngle),
        illumination: illumination,
        waxing: waxing,
        rise: rise ? rise.date : null,
        set: set ? set.date : null,
        upWhenDarkFalls: upWhenDarkFalls,
        fractionOfNightUp: fractionUp,
        interference: interference
    };
}

/**
 * Turn the 0-360 degree phase angle into the name people actually use.
 * Each of the four "corner" phases gets a narrow band around it, and the
 * crescents and gibbous phases fill the gaps between them.
 */
function moonPhaseName(phaseAngle) {
    if (phaseAngle < 22.5) return 'New moon';
    if (phaseAngle < 67.5) return 'Waxing crescent';
    if (phaseAngle < 112.5) return 'First quarter';
    if (phaseAngle < 157.5) return 'Waxing gibbous';
    if (phaseAngle < 202.5) return 'Full moon';
    if (phaseAngle < 247.5) return 'Waning gibbous';
    if (phaseAngle < 292.5) return 'Last quarter';
    if (phaseAngle < 337.5) return 'Waning crescent';
    return 'New moon';
}

/* ============================================================================
   The planets

   For each naked-eye planet we sample the dark window to find how high it
   climbs, then search outwards from that peak for the rise and set either side
   of it. Searching backwards for the rise matters: a planet already up at
   sunset rose during the afternoon, and reporting tomorrow's rise instead
   would be misleading.

   Anything that never clears MIN_USEFUL_ALTITUDE is dropped. That single rule
   also handles Mercury gracefully — it is usually lost in twilight, and it
   only appears in this list on the nights it genuinely climbs clear of it.
   ============================================================================ */

function findVisiblePlanets(observer, night, anchor) {
    const planets = [];

    NAKED_EYE_PLANETS.forEach(function (name) {
        const body = Astronomy.Body[name];
        const track = sampleAcrossNight(body, observer, night);

        // Never gets high enough to be worth looking for.
        if (track.peakAltitude < MIN_USEFUL_ALTITUDE) return;

        // A negative limitDays searches backwards in time.
        const rise = Astronomy.SearchRiseSet(body, observer, +1, track.peakTime, -2);
        const set = Astronomy.SearchRiseSet(body, observer, -1, track.peakTime, 2);

        planets.push({
            name: name,
            magnitude: Astronomy.Illumination(body, anchor).mag,
            peakAltitude: track.peakAltitude,
            peakTime: track.peakTime,
            rise: rise ? rise.date : null,
            set: set ? set.date : null
        });
    });

    // Best-placed first: the highest planet is the easiest to find and the
    // least spoiled by haze near the horizon.
    planets.sort((a, b) => b.peakAltitude - a.peakAltitude);

    return planets;
}

/* ============================================================================
   Milky Way visibility — a heuristic, and labelled as one

   This is an ESTIMATE, not a measurement. It combines the three things that
   decide whether the Milky Way shows up, and reports whichever is worst:

     1. Darkness      below a rural sky the Milky Way is simply gone. This
                      comes from the light pollution atlas (skyquality.js).
     2. The moon      moonlight washes the sky out. We use the combination of
                      brightness and time spent above the horizon worked out
                      in describeMoon().
     3. Galactic core the bright part, in Sagittarius. From southern latitudes
                      it passes nearly overhead; from northern Europe it barely
                      clears the horizon, and in northern winter it is not up
                      at all.

   Each factor is scored 0-3 and the overall rating is the WORST of them,
   because these are limits rather than contributions — a perfect dark sky
   cannot rescue a full moon. The reason we show names the limiting factor, so
   the answer is never just a number you have to trust.
   ============================================================================ */

function assessMilkyWay(observer, night, skyQuality, moonInterference) {
    // Note this is the core's highest point DURING THE DARK HOURS, not its
    // highest point over the whole day. The difference matters: from London in
    // August the core technically reaches 9 degrees, but it does so in the
    // evening twilight and is already sinking by the time the sky is properly
    // dark. What you can actually observe is the number worth reporting.
    const core = sampleAcrossNight(Astronomy.Body.Star1, observer, night);
    const coreAltitude = core.peakAltitude;

    // Sky brightness in magnitudes per square arcsecond. Bigger is darker.
    // May be missing — the atlas does not cover the poles, and the lookup can
    // fail — in which case we grade on the other two factors and say so.
    const magnitudes = (skyQuality && skyQuality.available) ? skyQuality.magnitudes : null;

    const darknessScore = magnitudes === null ? null : scoreDarkness(magnitudes);
    const moonScore = scoreMoonInterference(moonInterference);
    const coreScore = scoreCoreAltitude(coreAltitude);

    // Twilight all night is its own answer, whatever else is going on.
    if (!night.hasTrueDarkness) {
        return {
            rating: 0,
            headline: 'Not tonight',
            reason: 'The sky never gets fully dark here at this time of year.',
            coreAltitude: coreAltitude,
            coreUp: coreAltitude > 0
        };
    }

    const scores = [moonScore, coreScore];
    if (darknessScore !== null) scores.push(darknessScore);

    const rating = Math.min.apply(null, scores);

    return {
        rating: rating,
        headline: milkyWayHeadline(rating),
        reason: milkyWayReason(rating, darknessScore, moonScore, coreScore, coreAltitude),
        coreAltitude: coreAltitude,
        coreUp: coreAltitude > 0
    };
}

function scoreDarkness(magnitudes) {
    if (magnitudes >= 21.3) return 3;   // dark rural sky or better
    if (magnitudes >= 20.5) return 2;   // rural
    if (magnitudes >= 19.5) return 1;   // rural/suburban edge
    return 0;                           // suburban or worse
}

function scoreMoonInterference(interference) {
    if (interference < 0.05) return 3;  // effectively no moon in the way
    if (interference < 0.20) return 2;
    if (interference < 0.50) return 1;
    return 0;
}

function scoreCoreAltitude(altitude) {
    if (altitude >= 30) return 3;       // well clear of the horizon murk
    if (altitude >= 15) return 2;
    if (altitude > 0) return 1;         // up, but low and dimmed by the air
    return 0;                           // below the horizon all night
}

function milkyWayHeadline(rating) {
    if (rating === 3) return 'Excellent';
    if (rating === 2) return 'Good';
    if (rating === 1) return 'Faint';
    return 'Unlikely';
}

/**
 * Explain the rating by naming whatever is holding it back. If several things
 * are equally limiting we mention the darkness first, since that is the one
 * you can fix by driving somewhere else.
 */
function milkyWayReason(rating, darknessScore, moonScore, coreScore, coreAltitude) {
    const parts = [];

    if (darknessScore === null) {
        parts.push('darkness here is unknown');
    } else if (darknessScore === rating) {
        if (darknessScore === 0) parts.push('the sky here is too light-polluted');
        else if (darknessScore === 1) parts.push('this is only a rural/suburban sky');
        else if (darknessScore === 2) parts.push('a rural sky, dark but not pristine');
        else parts.push('the sky here is genuinely dark');
    }

    if (moonScore === rating) {
        if (moonScore === 0) parts.push('a bright moon dominates the night');
        else if (moonScore === 1) parts.push('the moon is up for much of the night');
        else if (moonScore === 2) parts.push('there is a little moonlight');
        else parts.push('the moon stays out of the way');
    }

    if (coreScore === rating) {
        if (coreScore === 0) {
            parts.push('the bright core stays below the horizon — only the fainter outer band is up');
        } else if (coreScore === 1) {
            parts.push(`the core only reaches ${Math.round(coreAltitude)}° above the horizon`);
        } else if (coreScore === 2) {
            parts.push(`the core climbs to ${Math.round(coreAltitude)}°`);
        } else {
            parts.push(`the core rides high, up to ${Math.round(coreAltitude)}°`);
        }
    }

    // Capitalise the first word and finish the sentence properly.
    const sentence = parts.join(', and ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

/* ============================================================================
   Formatting times in the LOCAL time of the clicked place

   astronomy-engine hands back JavaScript Date objects, which are absolute
   moments in time. Printing one with toLocaleTimeString() would show it in the
   BROWSER's timezone — so a rise time for Chile would come out in Australian
   time if that is where you happen to be sitting.

   The fix is the same shift used in observingNightAnchor(): move the instant by
   the location's UTC offset, then read its UTC fields, which are now the local
   wall-clock numbers.
   ============================================================================ */

function formatSkyTime(date, utcOffsetSeconds) {
    if (!date) return '—';

    const shifted = new Date(date.getTime() + utcOffsetSeconds * 1000);

    const hour24 = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();

    const suffix = hour24 < 12 ? 'am' : 'pm';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

    return `${hour12}:${String(minute).padStart(2, '0')}${suffix}`;
}

/* ============================================================================
   Drawing the moon

   Rather than an emoji — which browsers render as a fixed full-colour glyph,
   and which would put white and blue pixels on screen in Astronomer mode — the
   moon is drawn as an SVG path in currentColor, so it takes the theme's colour
   like any other text.

   The shape is built from two arcs:
     - the lit limb, always a half-circle
     - the terminator, a half-ellipse whose width tracks the phase

   The ellipse's horizontal radius is r * |1 - 2f| for a lit fraction f. At half
   moon that is zero and the arc collapses to a straight line; at full moon it
   equals r and closes the circle. The sweep flag flips at half moon so the
   terminator bulges the correct way for a crescent versus a gibbous moon.

   WHICH SIDE IS LIT
   -----------------
   In the northern hemisphere a waxing moon is lit on the right. From the
   southern hemisphere you are, in effect, standing upside down relative to
   that, and the same moon appears lit on the LEFT. This app opens on Australia,
   so drawing the northern convention everywhere would show most of its users a
   mirror image of the moon actually in their sky.

   setMoonGlyph() below therefore flips the glyph below the equator. The exact
   tilt also drifts through the night as the moon crosses the sky, which no
   static picture can show — so this is still "which phase, leaning the right
   way", not a photograph.
   ============================================================================ */

function moonPhasePath(illumination) {
    const radius = 14;
    const centreX = 16;
    const top = centreX - radius;
    const bottom = centreX + radius;

    // +1 at new moon, 0 at half, -1 at full.
    const k = 1 - 2 * illumination;
    // Rounded to two decimals: any more just makes the path attribute hard to
    // read when you inspect the element, and it changes nothing on screen.
    const terminatorRadius = Math.round(Math.abs(k) * radius * 100) / 100;

    // Before half moon the terminator curves towards the lit limb, making a
    // thin crescent; after half moon it curves away, making a fat gibbous.
    const terminatorSweep = k > 0 ? 0 : 1;

    // Drawn with the lit side on the right, then mirrored below if waning.
    return `M ${centreX} ${top} ` +
           `A ${radius} ${radius} 0 0 1 ${centreX} ${bottom} ` +
           `A ${terminatorRadius} ${radius} 0 0 ${terminatorSweep} ${centreX} ${top} Z`;
}

/* ============================================================================
   Filling in the panel
   ============================================================================ */

function showTonightSkyLoading() {
    setText('moon-phase', 'Calculating…');
    setText('moon-detail', '');
    setText('milkyway-headline', '');
    setText('milkyway-reason', '');
    setText('sky-window', '');

    const list = document.getElementById('planet-list');
    if (list) list.innerHTML = '';

    setMoonGlyph(0, true, 0);
}

/**
 * The main render. Called by inspect.js once the sky quality lookup has
 * finished, because the Milky Way estimate needs to know how dark it is.
 */
function displayTonightSky(lat, lng, utcOffsetSeconds, skyQuality, offsetIsEstimated) {
    const sky = computeTonightSky(lat, lng, utcOffsetSeconds, skyQuality);

    if (!sky.available) {
        showTonightSkyUnavailable();
        return;
    }

    // Under the midnight sun there is no night to assess, so milkyWay is null
    // and we substitute a message that explains why.
    const milkyWay = sky.milkyWay || assessMilkyWayFallback();

    renderNightWindow(sky.night, utcOffsetSeconds, offsetIsEstimated);
    renderNightTimeline(sky.night, sky.moon, utcOffsetSeconds);
    renderMoon(sky.moon, utcOffsetSeconds, lat);
    renderMilkyWay(milkyWay);
    renderPlanets(sky.planets, utcOffsetSeconds, sky.night);

    // The deep-sky list needs the same night window, so it is driven from here
    // rather than working the whole thing out again. (js/deepsky.js)
    //
    // Both of these are checked before being called. They are extra sections
    // rather than core ones, and if either file failed to load, losing that
    // section is a fair price — losing the moon, the planets and the Milky Way
    // along with it would not be.
    if (typeof renderDeepSky === 'function') {
        renderDeepSky(lat, lng, sky.night, utcOffsetSeconds, skyQuality);
    }

    // What is coming up in the months ahead, checked from this point.
    // (js/events.js)
    if (typeof renderEvents === 'function') {
        renderEvents(lat, lng, utcOffsetSeconds);
    }
}

function showTonightSkyUnavailable() {
    setText('moon-phase', 'Sky calculations unavailable');
    setText('moon-detail', 'The astronomy library could not be loaded.');
    setText('milkyway-headline', '');
    setText('milkyway-reason', '');
    setText('sky-window', '');

    const list = document.getElementById('planet-list');
    if (list) list.innerHTML = '';

    setMoonGlyph(0, true, 0);
}

/** Used only under the midnight sun, where there is no night to assess. */
function assessMilkyWayFallback() {
    return {
        rating: 0,
        headline: 'Not tonight',
        reason: 'The sun does not set here at this time of year.',
        coreAltitude: 0,
        coreUp: false
    };
}

function renderNightWindow(night, utcOffsetSeconds, offsetIsEstimated) {
    // Said once, at the bottom of the section, so it covers every time shown
    // above it rather than repeating on each line.
    const caveat = offsetIsEstimated ? ' · times approximate' : '';

    if (night.kind === 'midnight-sun') {
        setText('sky-window', 'The sun does not set here tonight.');
        return;
    }

    if (night.kind === 'polar-night') {
        setText('sky-window', 'Polar night — the sun does not rise, so it is dark all day.');
        return;
    }

    const sunset = formatSkyTime(night.sunset, utcOffsetSeconds);
    const sunrise = formatSkyTime(night.sunrise, utcOffsetSeconds);

    if (!night.hasTrueDarkness) {
        setText(
            'sky-window',
            `Sunset ${sunset}, sunrise ${sunrise} · never fully dark tonight${caveat}`
        );
        return;
    }

    const darkStart = formatSkyTime(night.darkStart, utcOffsetSeconds);
    const darkEnd = formatSkyTime(night.darkEnd, utcOffsetSeconds);

    setText(
        'sky-window',
        `Sunset ${sunset} · fully dark ${darkStart}–${darkEnd} · sunrise ${sunrise}${caveat}`
    );
}

function renderMoon(moon, utcOffsetSeconds, latitude) {
    setMoonGlyph(moon.illumination, moon.waxing, latitude);

    setText(
        'moon-phase',
        `${moon.phaseName} · ${Math.round(moon.illumination * 100)}% lit`
    );

    // Report the one time that changes your night, rather than both times.
    // If the moon is already up, you are waiting for it to go; if it is not,
    // you are counting the hours until it arrives.
    let detail;

    if (moon.fractionOfNightUp < 0.02) {
        detail = 'Below the horizon all night — no moonlight at all';
    } else if (moon.fractionOfNightUp > 0.98) {
        detail = 'Up all night';
    } else if (moon.upWhenDarkFalls) {
        detail = `Sets ${formatSkyTime(moon.set, utcOffsetSeconds)} · darker skies after that`;
    } else {
        detail = `Rises ${formatSkyTime(moon.rise, utcOffsetSeconds)} · darker skies until then`;
    }

    setText('moon-detail', detail);
}

/**
 * Update the moon glyph's shape. The path is regenerated rather than swapping
 * images, so every phase in between is drawn correctly too.
 */
function setMoonGlyph(illumination, waxing, latitude) {
    const lit = document.getElementById('moon-lit');
    const group = document.getElementById('moon-glyph-group');

    if (lit) lit.setAttribute('d', moonPhasePath(illumination));

    // The path is always drawn lit-on-the-right, so the glyph is mirrored
    // whenever that is not what the observer would see.
    //
    // Waxing lights the right in the north and the left in the south, and
    // waning does the opposite — so the two conditions cancel out. Writing it
    // as "these two disagree" is the whole rule:
    //
    //     north + waxing -> right      south + waxing -> left
    //     north + waning -> left       south + waning -> right
    if (group) {
        group.setAttribute('transform',
            moonLitOnRight(waxing, latitude) ? '' : 'translate(32,0) scale(-1,1)');
    }
}

/** See the rule written out above setMoonGlyph(). */
function moonLitOnRight(waxing, latitude) {
    const southernHemisphere = latitude < 0;
    return waxing !== southernHemisphere;
}

/**
 * Build a small standalone moon glyph, for the forecast rows.
 *
 * Same path and the same mirror rule as the big one in the panel, so a phase
 * cannot be drawn one way in one place and another way somewhere else.
 */
function createMoonGlyph(illumination, waxing, latitude, className) {
    const NS = SVG_NS;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', className || 'moon-glyph-small');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');

    const group = document.createElementNS(NS, 'g');
    if (!moonLitOnRight(waxing, latitude)) {
        group.setAttribute('transform', 'translate(32,0) scale(-1,1)');
    }

    const disc = document.createElementNS(NS, 'circle');
    disc.setAttribute('class', 'moon-disc');
    disc.setAttribute('cx', '16');
    disc.setAttribute('cy', '16');
    disc.setAttribute('r', '14');

    const lit = document.createElementNS(NS, 'path');
    lit.setAttribute('class', 'moon-lit');
    lit.setAttribute('d', moonPhasePath(illumination));

    group.append(disc, lit);
    svg.appendChild(group);
    return svg;
}

/**
 * What the moon is doing on a given night, for the week ahead.
 *
 * Sampled at 10pm local — the middle of a typical observing session — because
 * the moon's lit fraction creeps up measurably over a single night and one
 * number has to stand for the whole of it.
 */
function moonOnNight(isoDate, utcOffsetSeconds) {
    if (typeof Astronomy === 'undefined') return null;

    const [year, month, day] = isoDate.split('-').map(Number);
    const when = new Date(Date.UTC(year, month - 1, day, 22, 0, 0) - utcOffsetSeconds * 1000);

    const phaseAngle = Astronomy.MoonPhase(when);

    return {
        illumination: Astronomy.Illumination(Astronomy.Body.Moon, when).phase_fraction,
        waxing: phaseAngle < 180,
        phaseName: moonPhaseName(phaseAngle)
    };
}

/* ============================================================================
   The night, drawn as one bar

   Sunset on the left, sunrise on the right, and everything that matters in
   between: the twilight either side, the block of real astronomical darkness,
   and a second band showing when the moon is up over the top of it.

   Three lines of text saying "sunset 5:45pm, fully dark 7:13pm to 5:30am,
   moon sets 11:48pm" is the same information, but you have to assemble the
   picture in your head. Here the shape of the night is the shape of the bar —
   you can see at a glance whether the moon eats the first half of it.
   ============================================================================ */

// Its own copy rather than borrowing the one in js/favourites.js — a shared
// constant that only exists if another file happens to have loaded is a trap.
const SVG_NS = 'http://www.w3.org/2000/svg';

const TIMELINE_WIDTH = 300;
const TIMELINE_NIGHT_TOP = 6;
const TIMELINE_NIGHT_HEIGHT = 15;
const TIMELINE_MOON_TOP = 24;
const TIMELINE_MOON_HEIGHT = 6;

function renderNightTimeline(night, moon, utcOffsetSeconds) {
    const svg = document.getElementById('night-timeline');
    if (!svg) return;

    svg.innerHTML = '';

    // Nothing sensible to draw without a real sunset and sunrise.
    if (!night || night.kind !== 'normal' || !night.sunset || !night.sunrise) return;

    const from = night.sunset.getTime();
    const to = night.sunrise.getTime();
    const span = to - from;
    if (span <= 0) return;

    // Where along the bar does a given moment fall?
    const x = time => TIMELINE_WIDTH * (Math.min(Math.max(time, from), to) - from) / span;

    // The whole night, twilight included.
    svg.appendChild(timelineRect(0, TIMELINE_NIGHT_TOP, TIMELINE_WIDTH,
                                 TIMELINE_NIGHT_HEIGHT, 'timeline-twilight'));

    // The part that is properly dark.
    if (night.hasTrueDarkness) {
        const darkFrom = x(night.darkStart.getTime());
        const darkTo = x(night.darkEnd.getTime());
        svg.appendChild(timelineRect(darkFrom, TIMELINE_NIGHT_TOP, darkTo - darkFrom,
                                     TIMELINE_NIGHT_HEIGHT, 'timeline-dark'));
    }

    // When the moon is above the horizon, as a band underneath.
    const moonSpan = moonUpSpan(night, moon);
    if (moonSpan) {
        const moonFrom = x(moonSpan.from);
        const moonTo = x(moonSpan.to);
        if (moonTo > moonFrom) {
            svg.appendChild(timelineRect(moonFrom, TIMELINE_MOON_TOP, moonTo - moonFrom,
                                         TIMELINE_MOON_HEIGHT, 'timeline-moon'));
        }
    }

    // Times at each end.
    svg.appendChild(timelineLabel(0, 38, formatSkyTime(night.sunset, utcOffsetSeconds), 'start'));
    svg.appendChild(timelineLabel(TIMELINE_WIDTH, 38,
                                  formatSkyTime(night.sunrise, utcOffsetSeconds), 'end'));
}

/**
 * The stretch of the night the moon is above the horizon.
 *
 * Worked out from where it is when darkness falls rather than by sampling
 * again: if it is already up it will be setting, and if it is not it will be
 * rising. Either way one of the two times is the edge we need, and the other
 * edge is the end of the night.
 */
function moonUpSpan(night, moon) {
    if (!moon || !night.sunset || !night.sunrise) return null;

    const nightFrom = night.sunset.getTime();
    const nightTo = night.sunrise.getTime();

    if (moon.fractionOfNightUp <= 0.01) return null;
    if (moon.fractionOfNightUp >= 0.99) return { from: nightFrom, to: nightTo };

    if (moon.upWhenDarkFalls) {
        return { from: nightFrom, to: moon.set ? moon.set.getTime() : nightTo };
    }

    return { from: moon.rise ? moon.rise.getTime() : nightFrom, to: nightTo };
}

function timelineRect(x, y, width, height, className) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', className);
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(Math.max(0, width)));
    rect.setAttribute('height', String(height));
    return rect;
}

function timelineLabel(x, y, text, side) {
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'timeline-label');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(y));
    label.setAttribute('text-anchor', side === 'end' ? 'end' : 'start');
    label.textContent = text;
    return label;
}

function renderMilkyWay(milkyWay) {
    setText('milkyway-headline', milkyWay.headline);
    setText('milkyway-reason', milkyWay.reason);

    // The rating drives the colour of the label through CSS, so the styling
    // stays in the stylesheet and honours the theme.
    const element = document.getElementById('milkyway-headline');
    if (element) element.setAttribute('data-rating', String(milkyWay.rating));
}

/**
 * One row per visible planet.
 *
 * Built with createElement rather than innerHTML, matching the rest of the app:
 * nothing here comes from the internet, but keeping one consistent habit is
 * what stops an unsafe one creeping in later.
 */
function renderPlanets(planets, utcOffsetSeconds, night) {
    const list = document.getElementById('planet-list');
    if (!list) return;

    list.innerHTML = '';

    if (planets.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'planet-empty text-small text-secondary';
        empty.textContent = night.kind === 'midnight-sun'
            ? 'No planets — there is no darkness here tonight.'
            : 'No naked-eye planets climb high enough tonight.';
        list.appendChild(empty);
        return;
    }

    planets.forEach(function (planet) {
        const row = document.createElement('li');
        row.className = 'planet';

        const name = document.createElement('span');
        name.className = 'planet-name';
        name.textContent = planet.name;

        const peak = document.createElement('span');
        peak.className = 'planet-peak';
        peak.textContent = `${Math.round(planet.peakAltitude)}°`;
        peak.title = `Highest point above the horizon, at ${formatSkyTime(planet.peakTime, utcOffsetSeconds)}`;

        // Written out as "Rises … · sets …" rather than as a range with a
        // dash. Venus can rise in the morning and set in the evening, and
        // "8:28am–9:06pm" would read as if it were visible all day.
        const detail = document.createElement('span');
        detail.className = 'planet-detail';
        detail.textContent =
            `Rises ${formatSkyTime(planet.rise, utcOffsetSeconds)} · ` +
            `sets ${formatSkyTime(planet.set, utcOffsetSeconds)} · ` +
            `highest ${formatSkyTime(planet.peakTime, utcOffsetSeconds)} · ` +
            `mag ${planet.magnitude.toFixed(1)}`;

        row.append(name, peak, detail);
        list.appendChild(row);
    });
}
