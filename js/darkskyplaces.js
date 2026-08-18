/* ============================================================================
   ASTROMAP — Curated dark-sky places (seed data)

   A small, hand-checked list of places that have been formally certified for
   the quality of their night sky by DarkSky International (known as the
   International Dark-Sky Association until 2023).

   WHY THIS LIST EXISTS
   --------------------
   OpenStreetMap knows where the viewpoints and campsites are, but it does not
   know which places are genuinely famous for their skies. These are the
   destinations worth a long drive, and they would otherwise never appear in a
   recommendation. js/recommend.js merges them with whatever Overpass returns.

   WHAT THE NUMBERS ARE
   --------------------
   Names, designations and certification years come from DarkSky International's
   published list of International Dark Sky Places. Coordinates were geocoded
   from OpenStreetMap and are a representative point INSIDE each place — the
   centre of a town, a park headquarters, a conservation park — not the centroid
   of the whole protected area, which for a reserve can be thousands of square
   kilometres of nothing in particular.

   So treat a coordinate as "this is where this place is", accurate to a few
   kilometres, not as "park here". Every one was checked to land in the right
   country before being written down.

   THIS LIST IS DELIBERATELY SHORT
   -------------------------------
   There are well over two hundred certified places worldwide, and this is a
   dozen of them, weighted towards Australia and New Zealand because that is
   where this app opens. IT SHOULD BE EXPANDED. Adding one is just another entry
   below — name, designation, country, year, and a coordinate inside it. The
   full list is at https://darksky.org/what-we-do/international-dark-sky-places/

   Nothing here is invented. If you add to it, keep it that way: an entry that
   is not actually certified would make the recommendations quietly wrong.
   ============================================================================ */

const DARK_SKY_PLACES = [
    /* ---- Australia ---------------------------------------------------- */
    {
        name: 'Warrumbungle National Park',
        designation: 'Dark Sky Park',
        region: 'New South Wales, Australia',
        certified: 2016,          // Australia's first
        lat: -31.2491,
        lng: 148.9703
    },
    {
        name: 'River Murray Dark Sky Reserve',
        designation: 'Dark Sky Reserve',
        region: 'South Australia, Australia',
        certified: 2019,
        // Swan Reach Conservation Park is the reserve's designated core site.
        lat: -34.5870,
        lng: 139.4987
    },
    {
        name: 'Arkaroola Wilderness Sanctuary',
        designation: 'Dark Sky Sanctuary',
        region: 'South Australia, Australia',
        certified: 2023,
        lat: -30.1893,
        lng: 139.3772
    },
    {
        name: 'The Jump-Up, Australian Age of Dinosaurs',
        designation: 'Dark Sky Sanctuary',
        region: 'Queensland, Australia',
        certified: 2019,
        lat: -22.4797,
        lng: 143.1824
    },

    /* ---- New Zealand -------------------------------------------------- */
    {
        name: 'Aoraki Mackenzie Dark Sky Reserve',
        designation: 'Dark Sky Reserve',
        region: 'Canterbury, New Zealand',
        certified: 2012,          // first in the southern hemisphere
        // Lake Tekapo sits at the heart of the reserve.
        lat: -44.0045,
        lng: 170.4777
    },
    {
        name: 'Aotea / Great Barrier Island',
        designation: 'Dark Sky Sanctuary',
        region: 'Auckland, New Zealand',
        certified: 2017,
        lat: -36.1994,
        lng: 175.4173
    },
    {
        name: 'Stewart Island / Rakiura',
        designation: 'Dark Sky Sanctuary',
        region: 'Southland, New Zealand',
        certified: 2019,
        lat: -46.9867,
        lng: 167.8821
    },

    /* ---- Rest of the world -------------------------------------------- */
    {
        name: 'NamibRand Nature Reserve',
        designation: 'Dark Sky Reserve',
        region: 'Hardap, Namibia',
        certified: 2012,
        lat: -25.2108,
        lng: 15.9831
    },
    {
        name: 'Gabriela Mistral Dark Sky Sanctuary',
        designation: 'Dark Sky Sanctuary',
        region: 'Elqui Valley, Chile',
        certified: 2015,
        lat: -30.0340,
        lng: -70.7127
    },
    {
        name: 'Exmoor National Park',
        designation: 'Dark Sky Reserve',
        region: 'Devon and Somerset, England',
        certified: 2011,          // Europe's first
        lat: 51.1338,
        lng: -3.6040
    },
    {
        name: 'Kerry International Dark-Sky Reserve',
        designation: 'Dark Sky Reserve',
        region: 'County Kerry, Ireland',
        certified: 2014,
        lat: 51.8249,
        lng: -10.2742
    },
    {
        name: 'Death Valley National Park',
        designation: 'Dark Sky Park',
        region: 'California, United States',
        certified: 2013,
        lat: 36.4702,
        lng: -117.0884
    }
];
