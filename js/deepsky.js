/* ============================================================================
   DARKWARD — Deep sky tonight

   The planets are only half of what is worth looking at. This lists the
   showpiece deep-sky objects — nebulae, galaxies, star clusters — that clear
   the horizon during tonight's dark hours from wherever you tapped.

   HOW THE POSITIONS WORK
   ----------------------
   Unlike a planet, a deep-sky object does not move. Its right ascension and
   declination are fixed, so there is no orbit to compute: the coordinates
   below are handed straight to astronomy-engine's Horizon(), which turns them
   into "how far above your horizon, right now".

   That is also why this file needs no custom-star slots. astronomy-engine only
   offers eight of those, and js/tonightsky.js already uses one for the galactic
   centre — but Horizon() will take raw coordinates, so the catalogue can be as
   long as you like.

   THE COORDINATES
   ---------------
   Right ascension in HOURS, declination in DEGREES, epoch J2000 — the standard
   way catalogues are published. Precession shifts these by roughly a third of a
   degree per twenty-five years, which is far below anything that matters for
   "is it up, and how high".

   WHAT "NEEDS" MEANS
   ------------------
   Roughly what it takes to see the object at all from a properly dark site.
   It is about surface brightness as much as total magnitude: the Andromeda
   Galaxy is magnitude 3.4 but spread over an area larger than the full moon,
   so it is a faint smudge rather than an obvious star.

   THIS LIST IS DELIBERATELY SHORT — the twenty or so objects most worth
   driving for, weighted towards the southern sky because that is where this
   app opens. It should be expanded. Adding one is another entry below.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

// Below this the object is buried in haze and whatever is on your horizon.
const DEEP_SKY_MIN_ALTITUDE = 15;

// How many to list. More than this and the panel stops being scannable.
const DEEP_SKY_SHOWN = 6;

// How often to check each object's height across the dark window, in minutes.
const DEEP_SKY_SAMPLE_MINUTES = 15;

/* ----------------------------------------------------------------------------
   The catalogue
   -------------------------------------------------------------------------- */

const DEEP_SKY_OBJECTS = [
    /* ---- Southern showpieces ---- */
    { name: 'Eta Carinae Nebula',  designation: 'NGC 3372', ra: 10.7500, dec: -59.8667,
      magnitude: 1.0, needs: 'Naked eye',  kind: 'Nebula' },
    { name: 'Large Magellanic Cloud', designation: 'LMC',   ra: 5.3928,  dec: -69.7561,
      magnitude: 0.9, needs: 'Naked eye',  kind: 'Galaxy' },
    { name: 'Small Magellanic Cloud', designation: 'SMC',   ra: 0.8772,  dec: -72.8003,
      magnitude: 2.7, needs: 'Naked eye',  kind: 'Galaxy' },
    { name: 'Omega Centauri',      designation: 'NGC 5139', ra: 13.4464, dec: -47.4794,
      magnitude: 3.9, needs: 'Naked eye',  kind: 'Globular cluster' },
    { name: '47 Tucanae',          designation: 'NGC 104',  ra: 0.4017,  dec: -72.0814,
      magnitude: 4.1, needs: 'Naked eye',  kind: 'Globular cluster' },
    { name: 'Jewel Box',           designation: 'NGC 4755', ra: 12.8950, dec: -60.3667,
      magnitude: 4.2, needs: 'Binoculars', kind: 'Open cluster' },
    { name: 'Coalsack Nebula',     designation: 'Caldwell 99', ra: 12.8333, dec: -62.5000,
      magnitude: 0.0, needs: 'Naked eye',  kind: 'Dark nebula' },
    { name: 'Southern Pleiades',   designation: 'IC 2602',  ra: 10.7160, dec: -64.4000,
      magnitude: 1.9, needs: 'Naked eye',  kind: 'Open cluster' },
    { name: 'Centaurus A',         designation: 'NGC 5128', ra: 13.4244, dec: -43.0192,
      magnitude: 6.8, needs: 'Telescope',  kind: 'Galaxy' },

    /* ---- Visible from much of the world ---- */
    { name: 'Orion Nebula',        designation: 'M42',      ra: 5.5881,  dec: -5.3911,
      magnitude: 4.0, needs: 'Naked eye',  kind: 'Nebula' },
    { name: 'Lagoon Nebula',       designation: 'M8',       ra: 18.0603, dec: -24.3867,
      magnitude: 6.0, needs: 'Binoculars', kind: 'Nebula' },
    { name: 'Sagittarius Star Cloud', designation: 'M24',   ra: 18.2750, dec: -18.4833,
      magnitude: 4.6, needs: 'Binoculars', kind: 'Star cloud' },
    { name: 'Pleiades',            designation: 'M45',      ra: 3.7900,  dec: 24.1167,
      magnitude: 1.6, needs: 'Naked eye',  kind: 'Open cluster' },

    /* ---- Northern showpieces ---- */
    { name: 'Andromeda Galaxy',    designation: 'M31',      ra: 0.7122,  dec: 41.2692,
      magnitude: 3.4, needs: 'Binoculars', kind: 'Galaxy' },
    { name: 'Hercules Cluster',    designation: 'M13',      ra: 16.6947, dec: 36.4603,
      magnitude: 5.8, needs: 'Binoculars', kind: 'Globular cluster' },
    { name: 'Double Cluster',      designation: 'NGC 869/884', ra: 2.3330, dec: 57.1333,
      magnitude: 4.3, needs: 'Binoculars', kind: 'Open cluster' },
    { name: 'Triangulum Galaxy',   designation: 'M33',      ra: 1.5642,  dec: 30.6603,
      magnitude: 5.7, needs: 'Telescope',  kind: 'Galaxy' },
    { name: 'Ring Nebula',         designation: 'M57',      ra: 18.8931, dec: 33.0292,
      magnitude: 8.8, needs: 'Telescope',  kind: 'Planetary nebula' }
];

/* ============================================================================
   Which of them are up tonight
   ============================================================================ */

/**
 * Sample each object across the dark window and keep the ones that get high
 * enough to be worth pointing at, best-placed first.
 */
function findVisibleDeepSky(observer, night) {
    if (typeof Astronomy === 'undefined' || !night || !night.darkStart) return [];

    const stepMs = DEEP_SKY_SAMPLE_MINUTES * 60 * 1000;
    const start = night.darkStart.getTime();
    const end = night.darkEnd.getTime();

    const visible = [];

    DEEP_SKY_OBJECTS.forEach(function (object) {
        let peakAltitude = -90;
        let peakTime = null;

        for (let t = start; t <= end; t += stepMs) {
            const when = new Date(t);
            // Fixed coordinates go straight in — no orbit to work out.
            const altitude = Astronomy.Horizon(
                when, observer, object.ra, object.dec, 'normal').altitude;

            if (altitude > peakAltitude) {
                peakAltitude = altitude;
                peakTime = when;
            }
        }

        if (peakAltitude < DEEP_SKY_MIN_ALTITUDE) return;

        visible.push(Object.assign({}, object, {
            peakAltitude: peakAltitude,
            peakTime: peakTime
        }));
    });

    visible.sort((a, b) => b.peakAltitude - a.peakAltitude);
    return visible;
}

/* ============================================================================
   Drawing the list
   ============================================================================ */

function renderDeepSky(lat, lng, night, utcOffsetSeconds, skyQuality) {
    const list = document.getElementById('dso-list');
    if (!list) return;

    list.innerHTML = '';

    if (typeof Astronomy === 'undefined') {
        addDeepSkyMessage(list, 'The astronomy library could not be loaded.');
        return;
    }

    if (!night || !night.darkStart || night.kind === 'midnight-sun') {
        addDeepSkyMessage(list, 'No darkness here tonight, so nothing to list.');
        return;
    }

    const observer = new Astronomy.Observer(lat, lng, 0);
    const visible = findVisibleDeepSky(observer, night).slice(0, DEEP_SKY_SHOWN);

    if (visible.length === 0) {
        addDeepSkyMessage(list, 'Nothing from the showpiece list climbs high enough tonight.');
        return;
    }

    visible.forEach(function (object) {
        const row = document.createElement('li');
        row.className = 'planet';

        const name = document.createElement('span');
        name.className = 'planet-name';
        name.textContent = object.name;

        const peak = document.createElement('span');
        peak.className = 'planet-peak';
        peak.textContent = `${Math.round(object.peakAltitude)}°`;
        peak.title = 'Highest point above the horizon tonight';

        const detail = document.createElement('span');
        detail.className = 'planet-detail';
        detail.textContent =
            `${object.designation} · ${object.kind} · ` +
            `${object.needs} · highest ${formatSkyTime(object.peakTime, utcOffsetSeconds)}`;

        row.append(name, peak, detail);
        list.appendChild(row);
    });

    // A bright sky hides faint things however high they climb, so say so rather
    // than letting the list imply they will all be easy.
    const washedOut = skyQuality && skyQuality.available && skyQuality.magnitudes < 20.0;
    if (washedOut) {
        addDeepSkyMessage(list,
            'This sky is bright enough that the fainter ones here will be washed out.');
    }
}

function addDeepSkyMessage(list, text) {
    const item = document.createElement('li');
    item.className = 'planet-empty text-small text-secondary';
    item.textContent = text;
    list.appendChild(item);
}
