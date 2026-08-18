# Light Pollution Data

**Status: the app now uses real data.** The placeholder overlay has been removed.

AstroMap reads David J. Lorenz's *World Atlas of Artificial Night Sky
Brightness* (2025 edition) directly from the author's own public hosting on
GitHub Pages. No download, no self-hosting, no API key.

<https://djlorenz.github.io/astronomy/lp/>

---

## What we use, and where

The atlas is published in two forms, and AstroMap uses both.

### 1. Coloured map tiles — the overlay you see

```
https://djlorenz.github.io/astronomy/image_tiles/tiles2025/tile_{z}_{x}_{y}.png
```

Set up in `js/lightpollution.js`. Two things are unusual about these tiles and
both are handled in that file:

| Property   | Value | Why it matters |
|------------|-------|----------------|
| Tile size  | 1024 px | Not the usual 256. MapLibre needs `tileSize: 1024` or every tile lands in the wrong place. |
| Max zoom   | 6 | The highest level published. `maxzoom: 6` tells MapLibre to stretch level 6 when you zoom in further, instead of requesting tiles that do not exist. |

Squares containing no artificial light at all are simply not published, so
those tiles return **404**. That is normal, not an error — `js/map.js`
deliberately ignores 404s so panning across the outback does not raise an error
banner.

### 2. Binary data tiles — the numbers in the Sky Quality panel

```
https://djlorenz.github.io/astronomy/binary_tiles/2025/binary_tile_{x}_{y}.dat.gz
```

Decoded in `js/skyquality.js`. Each file covers a 5° × 5° square as a 600 × 600
grid (one sample per 1/120°, roughly 900 m). The values are delta-encoded and
gzipped, which is how a whole 5° square fits in about 70 KB.

The browser does the gunzipping natively via `DecompressionStream`, so there is
no library to load. The decoding steps mirror the reader on Lorenz's own atlas
page, so our numbers match what his site reports for the same point.

**Both files must reference the same year.** `LP_TILE_URL` in
`lightpollution.js` and `ATLAS_YEAR` in `skyquality.js` are the two places to
change if you move to a different edition (2016, 2020, 2022, 2023, 2024 and
2025 are all published).

---

## Attribution — required

Lorenz hosts this for free. Credit him. AstroMap does so in three places: the
MapLibre attribution control, the light pollution panel, and the inspect panel
footer.

```
D. J. Lorenz, World Atlas of Artificial Night Sky Brightness 2025
https://djlorenz.github.io/astronomy/lp/
```

He also makes one specific request:

> "Most light pollution websites, including ones that have simply copied my
> data, state that the maps depict the Bortle Scale. This is not the case. […]
> If you use my maps on your site, I ask that you do not conflate the Bortle
> Scale with my maps."

The atlas models **artificial sky brightness at the zenith** — straight up. The
Bortle scale is a subjective judgement of the *whole* sky from horizon to
horizon. So the Sky Quality panel reports Lorenz's own Light Pollution Zone and
Index plus magnitudes per square arc-second, and says plainly that it is not
Bortle.

The underlying satellite data is VIIRS night-lights from NOAA, processed by the
[Earth Observation Group](https://eogdata.mines.edu/) at the Colorado School of
Mines.

---

## Reading the numbers

| Shown as | Means |
|----------|-------|
| **LP Zone** | Lorenz's scale, `0` (pristine) to `7b` (inner city). Each whole number is a 3× jump in artificial light; the `a`/`b` halves are √3 apart. |
| **LP Index** | Artificial glow as a multiple of the natural night sky. `0` is pristine, `1` means artificial equals natural, a city is 30 or more. |
| **mag/arcsec²** | Total sky brightness. The scale runs backwards: **bigger is darker**. 22.0 is a pristine sky, ~17 is an inner city. |

Full colour key: <https://djlorenz.github.io/astronomy/lp/colors.html>

---

## Limitations to know about

- **Coverage is 65°S to 75°N.** Outside that band the panel says so rather than
  guessing.
- **Resolution is about 900 m.** Fine for choosing a valley; not fine for
  choosing which side of a car park to stand on.
- **It is a model, not a measurement.** It simulates atmospheric scattering of
  known ground light sources. It cannot know about a floodlit sports field that
  switched on last month, and it assumes clear, average atmospheric conditions.
- **Snow, terrain and altitude are not accounted for** in the way a local
  observer would experience them.
- **It says nothing about the moon**, which on a bright night dominates
  everything the atlas measures. Moon phase arrives in Phase 4.

---

## If you would rather self-host

Lorenz's GitHub Pages hosting is free and reliable, so self-hosting is not
required. Do it if you want to be independent of it, or to work offline.

1. **Mirror the published tiles** (simplest). Both trees are plain static
   files, so a recursive fetch and a static file server is all it takes. Be
   considerate about rate: this is one person's personal site.

2. **Or build tiles from the source rasters.** Download the atlas GeoTIFF from
   the [download page](https://djlorenz.github.io/astronomy/lp/), then:

   ```bash
   # Reproject to Web Mercator, which is what web maps expect
   gdalwarp -t_srs EPSG:3857 -r bilinear atlas.tif atlas_3857.tif

   # Cut it into an {z}/{x}/{y}.png pyramid
   gdal2tiles.py -z 0-8 -r average atlas_3857.tif tiles/

   # Serve them
   cd tiles && python3 -m http.server 8001
   ```

   Then point `LP_TILE_URL` in `js/lightpollution.js` at
   `http://localhost:8001/{z}/{x}/{y}.png` and change `LP_TILE_SIZE` to `256`,
   since `gdal2tiles` writes standard 256 px tiles.

   Note that this only replaces the *overlay*. The Sky Quality numbers come
   from the binary tiles, so mirror those too and update `ATLAS_BINARY_BASE` in
   `js/skyquality.js`.
