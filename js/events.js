/* ============================================================================
   DARKWARD — Coming up

   What is worth putting in the diary: the dark-moon windows, meteor shower
   peaks, and the next eclipses — checked against where you actually are.

   WHY LOCAL VISIBILITY MATTERS
   ----------------------------
   An eclipse is not an event you can attend from anywhere. The partial lunar
   eclipse of 28 August 2026 happens with the moon 40 degrees BELOW the horizon
   from Brisbane, so for anyone there it does not happen at all. Listing it
   without saying so would send someone outside at 2am for nothing, which is
   exactly the sort of thing this app exists to prevent.

   So every eclipse below is checked from the point you tapped, and says
   plainly whether you will see it.

   METEOR SHOWERS
   --------------
   The peak dates in the table shift by a day either way from year to year as
   the Earth meets each debris stream at a slightly different point. They are
   given to the nearest day and labelled "around", which is the honest
   precision — you would watch the night either side anyway.

   ZHR is the zenithal hourly rate: how many you would see per hour under a
   perfect sky with the radiant straight overhead. Real counts are always
   lower, often far lower. It is a comparison between showers, not a promise.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

// How far ahead to look, and how many entries to show.
const EVENTS_HORIZON_DAYS = 120;
const EVENTS_SHOWN = 6;

/* ----------------------------------------------------------------------------
   The major annual meteor showers

   Radiant position is J2000, right ascension in hours and declination in
   degrees — used to check whether the shower's radiant is even above your
   horizon, because a shower whose radiant never rises produces nothing for you.
   -------------------------------------------------------------------------- */

const METEOR_SHOWERS = [
    { name: 'Quadrantids',     month: 1,  day: 3,  zhr: 110, ra: 15.33, dec: 49.5 },
    { name: 'Lyrids',          month: 4,  day: 22, zhr: 18,  ra: 18.13, dec: 34.0 },
    { name: 'Eta Aquariids',   month: 5,  day: 6,  zhr: 50,  ra: 22.47, dec: -1.0 },
    { name: 'Delta Aquariids', month: 7,  day: 30, zhr: 25,  ra: 22.67, dec: -16.4 },
    { name: 'Perseids',        month: 8,  day: 12, zhr: 100, ra: 3.20,  dec: 58.0 },
    { name: 'Orionids',        month: 10, day: 21, zhr: 20,  ra: 6.35,  dec: 15.6 },
    { name: 'Leonids',         month: 11, day: 17, zhr: 15,  ra: 10.27, dec: 21.8 },
    { name: 'Geminids',        month: 12, day: 14, zhr: 150, ra: 7.50,  dec: 32.4 },
    { name: 'Ursids',          month: 12, day: 22, zhr: 10,  ra: 14.48, dec: 75.8 }
];

/* ============================================================================
   Building the list
   ============================================================================ */

function renderEvents(lat, lng, utcOffsetSeconds) {
    const list = document.getElementById('events-list');
    if (!list) return;

    list.innerHTML = '';

    if (typeof Astronomy === 'undefined') {
        addEventMessage(list, 'The astronomy library could not be loaded.');
        return;
    }

    const observer = new Astronomy.Observer(lat, lng, 0);
    const now = new Date();

    const events = []
        .concat(darkMoonWindows(now))
        .concat(upcomingShowers(now, observer))
        .concat(upcomingEclipses(now, observer));

    events.sort((a, b) => a.when - b.when);

    const soon = events
        .filter(e => daysBetween(now, e.when) <= EVENTS_HORIZON_DAYS)
        .slice(0, EVENTS_SHOWN);

    if (soon.length === 0) {
        addEventMessage(list, 'Nothing notable in the next few months.');
        return;
    }

    soon.forEach(event => list.appendChild(buildEventRow(event, now, utcOffsetSeconds)));
}

/**
 * New moon is the headline here: the fortnight around it is when everything
 * faint is actually reachable. Full moon is listed too, as the one to avoid.
 */
function darkMoonWindows(now) {
    const events = [];

    let quarter = Astronomy.SearchMoonQuarter(now);

    // Four quarters is a little over one lunar month, which is enough to be
    // sure of catching the next new moon and the next full moon.
    for (let i = 0; i < 5; i++) {
        if (quarter.quarter === 0) {
            events.push({
                when: quarter.time.date,
                name: 'New moon',
                detail: 'Darkest skies of the month — the nights either side are the ones to take.'
            });
        } else if (quarter.quarter === 2) {
            events.push({
                when: quarter.time.date,
                name: 'Full moon',
                detail: 'Nothing faint survives this. Good for lunar detail, bad for everything else.'
            });
        }
        quarter = Astronomy.NextMoonQuarter(quarter);
    }

    // Only the next of each, or the list fills with moon phases.
    const firstNew = events.find(e => e.name === 'New moon');
    const firstFull = events.find(e => e.name === 'Full moon');
    return [firstNew, firstFull].filter(Boolean);
}

function upcomingShowers(now, observer) {
    return METEOR_SHOWERS.map(function (shower) {
        const peak = nextOccurrence(now, shower.month, shower.day);

        // Does the radiant ever get above the horizon from here? A shower
        // whose radiant stays down produces nothing you can see.
        const highest = highestRadiantAltitude(observer, peak, shower);

        const moonLit = Astronomy.Illumination(Astronomy.Body.Moon, peak).phase_fraction;

        const parts = [`Up to ~${shower.zhr}/hour in ideal conditions`];

        if (highest < 5) {
            parts.push('but the radiant barely rises here, so expect very few');
        } else if (moonLit > 0.6) {
            parts.push(`though a ${Math.round(moonLit * 100)}% moon will drown most of them`);
        } else {
            parts.push(`with a ${Math.round(moonLit * 100)}% moon`);
        }

        return {
            when: peak,
            name: shower.name + ' peak',
            detail: parts.join(', ') + '.',
            approximate: true
        };
    });
}

/** The radiant's best altitude on the night of the peak. */
function highestRadiantAltitude(observer, peak, shower) {
    let best = -90;
    for (let hour = 0; hour < 24; hour++) {
        const when = new Date(peak.getTime() + hour * 3600 * 1000);
        const altitude = Astronomy.Horizon(when, observer, shower.ra, shower.dec, 'normal').altitude;
        if (altitude > best) best = altitude;
    }
    return best;
}

function upcomingEclipses(now, observer) {
    const events = [];

    try {
        const lunar = Astronomy.SearchLunarEclipse(now);
        // The moon has to be above your horizon at peak, or the eclipse simply
        // is not happening as far as you are concerned.
        const equator = Astronomy.Equator(Astronomy.Body.Moon, lunar.peak.date, observer, true, true);
        const altitude = Astronomy.Horizon(
            lunar.peak.date, observer, equator.ra, equator.dec, 'normal').altitude;

        events.push({
            when: lunar.peak.date,
            name: `${capitalise(lunar.kind)} lunar eclipse`,
            detail: altitude > 0
                ? `Visible from here — the moon is ${Math.round(altitude)}° up at maximum.`
                : 'Not visible from here — the moon is below your horizon at maximum.'
        });
    } catch (error) {
        console.warn('Could not find the next lunar eclipse:', error);
    }

    try {
        const solar = Astronomy.SearchLocalSolarEclipse(now, observer);
        const obscured = Math.round((solar.obscuration || 0) * 100);

        events.push({
            when: solar.peak.time.date,
            name: `${capitalise(solar.kind)} solar eclipse`,
            detail: `Visible from here — up to ${obscured}% of the sun covered, ` +
                    `${Math.round(solar.peak.altitude)}° above the horizon.`
        });
    } catch (error) {
        console.warn('Could not find the next local solar eclipse:', error);
    }

    return events;
}

/* ============================================================================
   Drawing a row
   ============================================================================ */

function buildEventRow(event, now, utcOffsetSeconds) {
    const row = document.createElement('li');
    row.className = 'event';

    const name = document.createElement('span');
    name.className = 'event-name';
    name.textContent = event.name;

    const when = document.createElement('span');
    when.className = 'event-when';
    when.textContent = describeWhen(event, now, utcOffsetSeconds);

    const detail = document.createElement('span');
    detail.className = 'event-detail';
    detail.textContent = event.detail;

    row.append(name, when, detail);
    return row;
}

/**
 * "in 9 days" is easier to act on than a date, so both are given: the countdown
 * where the eye lands and the date underneath it.
 */
function describeWhen(event, now, utcOffsetSeconds) {
    const days = Math.round(daysBetween(now, event.when));
    const local = new Date(event.when.getTime() + utcOffsetSeconds * 1000);

    const date = `${local.getUTCDate()} ${monthName(local.getUTCMonth())}`;
    const lead = event.approximate ? 'around ' : '';

    if (days <= 0) return `${lead}today`;
    if (days === 1) return `${lead}tomorrow`;
    return `${lead}${date} · ${days}d`;
}

function addEventMessage(list, text) {
    const item = document.createElement('li');
    item.className = 'planet-empty text-small text-secondary';
    item.textContent = text;
    list.appendChild(item);
}

/* ----------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/** The next time this month and day comes round, this year or next. */
function nextOccurrence(now, month, day) {
    const thisYear = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day, 12, 0, 0));
    if (thisYear >= now) return thisYear;
    return new Date(Date.UTC(now.getUTCFullYear() + 1, month - 1, day, 12, 0, 0));
}

function daysBetween(from, to) {
    return (to.getTime() - from.getTime()) / (24 * 3600 * 1000);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthName(monthIndex) {
    return MONTH_NAMES[monthIndex];
}

function capitalise(text) {
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
}
