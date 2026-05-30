// Build offline CONUS basemap geometry for the map's land/state-border layer.
//
// Converts us-atlas/states-10m.json (TopoJSON, WGS84 lon/lat) into two GeoJSON
// files committed under data/:
//   - us-states.geojson : CONUS state polygons (for borders)
//   - us-nation.geojson  : merged CONUS landmass outline (for the land fill)
// Alaska, Hawaii and territories are dropped so the geometry matches the
// continental Albers extent the map fits to. Run once and commit the output:
//   node prep/make_basemap.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { feature, merge } from "topojson-client";

const require = createRequire(import.meta.url);
const us = require("us-atlas/states-10m.json");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");

// FIPS to exclude: 02 AK, 15 HI, 60 AS, 66 GU, 69 MP, 72 PR, 78 VI
const NON_CONUS = new Set(["02", "15", "60", "66", "69", "72", "78"]);

const conusGeoms = us.objects.states.geometries.filter(
  (g) => !NON_CONUS.has(String(g.id)),
);

// state polygons (for borders + hit-free context)
const states = {
  type: "FeatureCollection",
  features: conusGeoms.map((g) => feature(us, g)),
};

// single merged CONUS landmass outline (for the land fill)
const nation = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: {}, geometry: merge(us, conusGeoms) }],
};

fs.writeFileSync(path.join(DATA, "us-states.geojson"), JSON.stringify(states));
fs.writeFileSync(path.join(DATA, "us-nation.geojson"), JSON.stringify(nation));
console.log(
  `wrote ${states.features.length} CONUS states + nation outline to data/`,
);
