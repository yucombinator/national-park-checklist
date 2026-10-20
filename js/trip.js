// Route planning for the trip builder: order parks, sum drive legs.

/** Drive leg between two parks, falling back to a straight-line estimate. */
export function leg(a, b, matrix, index) {
  const i = index.get(a);
  const j = index.get(b);
  const mins = matrix?.duration_min?.[i]?.[j];
  const miles = matrix?.distance_mi?.[i]?.[j];

  if (typeof mins === "number" && mins >= 0) {
    return { minutes: mins, miles, connected: true };
  }
  return { minutes: null, miles: null, connected: false };
}

function cost(a, b, matrix, index) {
  const l = leg(a, b, matrix, index);
  return l.connected ? l.minutes : Infinity;
}

function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  list.forEach((item, i) => {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

/** Exact ordering for small sets, greedy + 2-opt beyond that. */
function bestOrder(codes, matrix, index) {
  if (codes.length <= 7) {
    let best = null;
    let bestCost = Infinity;
    for (const perm of permutations(codes)) {
      let total = 0;
      let feasible = true;
      for (let i = 0; i < perm.length - 1; i++) {
        const c = cost(perm[i], perm[i + 1], matrix, index);
        if (!Number.isFinite(c)) {
          feasible = false;
          break;
        }
        total += c;
      }
      if (feasible && total < bestCost) {
        bestCost = total;
        best = perm;
      }
    }
    if (best) return best;
    // disconnected set: keep the given order
    return [...codes];
  }

  const remaining = new Set(codes);
  const order = [];
  let cur = codes[0];
  remaining.delete(cur);
  order.push(cur);

  while (remaining.size) {
    let next = null;
    let best = Infinity;
    for (const c of remaining) {
      const v = cost(cur, c, matrix, index);
      if (v < best) {
        best = v;
        next = c;
      }
    }
    if (next == null) next = remaining.values().next().value;
    order.push(next);
    remaining.delete(next);
    cur = next;
  }
  return order;
}

/** Returns { order, legs, totalMinutes, totalMiles, disconnected }. */
export function planTrip(codes, matrix, parks) {
  if (codes.length < 2) return { order: [...codes], legs: [], totalMinutes: 0, totalMiles: 0, disconnected: false };

  const index = new Map((matrix?.codes || parks.map((p) => p.code)).map((c, i) => [c, i]));
  const order = bestOrder(codes, matrix, index);

  const legs = [];
  let totalMinutes = 0;
  let totalMiles = 0;
  let disconnected = false;

  for (let i = 0; i < order.length - 1; i++) {
    const l = leg(order[i], order[i + 1], matrix, index);
    legs.push({ from: order[i], to: order[i + 1], ...l });
    if (l.connected) {
      totalMinutes += l.minutes;
      totalMiles += l.miles || 0;
    } else {
      disconnected = true;
      // straight-line fallback so totals still mean something
      const a = parks.find((p) => p.code === order[i]);
      const b = parks.find((p) => p.code === order[i + 1]);
      if (a && b) {
        const dx = (a.centroid[0] - b.centroid[0]) * 54;
        const dy = (a.centroid[1] - b.centroid[1]) * 69;
        totalMiles += Math.round(Math.hypot(dx, dy) * 1.2);
      }
    }
  }

  return { order, legs, totalMinutes, totalMiles, disconnected };
}

export function fmtDuration(minutes) {
  if (minutes == null) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
