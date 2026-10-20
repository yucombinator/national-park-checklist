// One predicate shared by the map, the list and the counters.

export function haversineMi(aLat, aLon, bLat, bLon) {
  const r = 3958.8;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((bLon - aLon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Lower is a better match: park name, then state, then region, then gateway. */
export function matchScore(props, state) {
  const q = (state.search || "").trim().toLowerCase();
  if (!q) return 0;
  const name = props.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (String(props.state_names || "").toLowerCase().includes(q)) return 3;
  if (String(props.region || "").toLowerCase().includes(q)) return 4;
  return 5;
}

export function matches(props, state) {
  const visited = state.visited;
  const wishlist = state.wishlist || new Set();

  if (state.country && state.country !== "all" && props.country !== state.country) return false;
  if (state.filter === "visited" && !visited.has(props.code)) return false;
  if (state.filter === "unvisited" && visited.has(props.code)) return false;
  if (state.filter === "wishlist" && !wishlist.has(props.code)) return false;

  if (state.region && state.region !== "all" && props.region !== state.region) return false;

  const q = (state.search || "").trim().toLowerCase();
  if (!q) return true;

  return (
    props.name.toLowerCase().includes(q) ||
    String(props.state_names || "").toLowerCase().includes(q) ||
    String(props.state_label || "").toLowerCase().includes(q) ||
    String(props.region || "").toLowerCase().includes(q) ||
    props.nearby_cities.some((c) => c.name.toLowerCase().includes(q)) ||
    props.nearby_airports.some(
      (a) => a.iata.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    )
  );
}
