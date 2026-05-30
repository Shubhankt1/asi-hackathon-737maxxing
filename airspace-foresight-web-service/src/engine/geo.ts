// Geometry helpers: great-circle distance and point-in-polygon.

const R_NM = 3440.065; // mean earth radius in nautical miles
const DEG = Math.PI / 180;

/** Great-circle distance between two lat/lon points, in nautical miles. */
export function haversineNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Ray-casting point-in-polygon test for a single ring of [lon, lat] vertices.
 * Returns true if (lon, lat) is inside the ring.
 */
export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function ringBbox(ring: number[][]): [number, number, number, number] {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Area-weighted-ish centroid (simple vertex average; good enough for labels). */
export function ringCentroid(ring: number[][]): [number, number] {
  let sx = 0,
    sy = 0;
  const n = ring.length;
  for (const [lon, lat] of ring) {
    sx += lon;
    sy += lat;
  }
  return [sx / n, sy / n];
}
