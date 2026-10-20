// Entry point: load data, wire map, list, search, filters, trip planner, share.

import { initMap, setState, focusPark, fitVisible, fitMainland, showGateways, clearGateways, setBasemap, getMap } from "./map.js";
import { detailHtml, escapeHtml, escapeAttr, driveLabel, serviceBadge } from "./park-data.js";
import { getVisited, toggleVisited, setVisited, resetVisited, encodeVisited, decodeVisited } from "./store.js";
import { matches, matchScore, haversineMi } from "./filter.js";
import { planTrip, fmtDuration } from "./trip.js";

const REGION_ORDER = [
  "Alaska",
  "Hawaiʻi & Pacific",
  "Pacific Northwest",
  "California",
  "Southwest",
  "Rockies",
  "Plains & Midwest",
  "South",
  "Northeast",
  "Florida & Caribbean",
];

const state = {
  filter: "all",
  search: "",
  region: "all",
  country: "all",
  visited: new Set(),
};

const US_REGION_ORDER = [
  "Alaska",
  "Hawaiʻi & Pacific",
  "Pacific Northwest",
  "California",
  "Southwest",
  "Rockies",
  "Plains & Midwest",
  "South",
  "Northeast",
  "Florida & Caribbean",
];

const CA_REGION_ORDER = ["Atlantic", "Quebec", "Ontario", "Prairies", "Pacific", "North"];

const trip = { codes: [], open: false };

let parks = [];
let parksByCode = new Map();
let matrix = null;
let openCode = null;
let restoreSearchFocus = false;
let searchTimer = null;

const $ = (sel) => document.querySelector(sel);

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

function showError(msg) {
  const el = $("#err");
  el.textContent = msg;
  el.classList.add("show");
}

let toastTimer = null;
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function updateCounters() {
  const byCountry = { US: [0, 0], CA: [0, 0] };
  for (const park of parks) {
    const bucket = byCountry[park.country] || (byCountry[park.country] = [0, 0]);
    bucket[1] += 1;
    if (state.visited.has(park.code)) bucket[0] += 1;
  }

  for (const country of ["US", "CA"]) {
    const [seen, total] = byCountry[country] || [0, 0];
    const suffix = country.toLowerCase();
    const pct = total ? Math.round((seen / total) * 100) : 0;

    $(`#progress-fill-${suffix}`).style.width = `${pct}%`;
    $(`#progress-text-${suffix}`).textContent = `${seen} / ${total}`;
    const bar = $(`#progress-bar-${suffix}`);
    bar.setAttribute("aria-valuenow", String(seen));
    bar.setAttribute("aria-valuemax", String(total));
  }

  $("#visited-count").textContent = state.visited.size;
  $("#progress-text").textContent =
    `${state.visited.size} visited · US ${byCountry.US[0]} of ${byCountry.US[1]} · Canada ${byCountry.CA[0]} of ${byCountry.CA[1]}`;
  $("#trip-toggle").textContent = trip.codes.length ? `Trip (${trip.codes.length})` : "Plan a trip";
}

function refresh() {
  state.visited = new Set(getVisited());
  setState(state);
  updateCounters();
  if (!$("#list").hidden) renderList();
  if (openCode) renderDetail(parksByCode.get(openCode));
  renderTrip();
}

// ---------- detail ----------

function renderDetail(props) {
  const el = $("#detail");
  if (!props) {
    el.classList.remove("open");
    document.body.classList.remove("detail-open");
    clearGateways();
    openCode = null;
    writeHash();
    return;
  }

  openCode = props.code;
  el.innerHTML = detailHtml(props, { inTrip: trip.codes.includes(props.code) });
  el.classList.add("open");
  document.body.classList.add("detail-open");
  showGateways(props);
  writeHash();

  const closeBtn = document.createElement("button");
  closeBtn.className = "detail-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close park details");
  closeBtn.addEventListener("click", () => renderDetail(null));
  el.prepend(closeBtn);

  el.querySelector(".toggle-btn").addEventListener("click", () => {
    toggleVisited(props.code);
    refresh();
    renderDetail(parksByCode.get(props.code));
  });

  el.querySelector(".trip-btn").addEventListener("click", () => {
    toggleTrip(props.code);
    renderDetail(parksByCode.get(props.code));
  });
}

// ---------- trip ----------

function toggleTrip(code) {
  const i = trip.codes.indexOf(code);
  if (i >= 0) trip.codes.splice(i, 1);
  else trip.codes.push(code);
  if (trip.codes.length) trip.open = true;
  updateCounters();
  renderTrip();
  if (!$("#list").hidden) renderList();
}

function renderTrip() {
  const el = $("#trip");
  if (!trip.open && !trip.codes.length) {
    el.hidden = true;
    document.body.classList.remove("trip-open");
    return;
  }
  el.hidden = false;
  document.body.classList.add("trip-open");

  if (!trip.codes.length) {
    el.innerHTML = `
      <div class="trip-head">
        <h3>Trip planner</h3>
        <button class="trip-close" aria-label="Close trip planner">&times;</button>
      </div>
      <p class="trip-empty">Add parks with <b>+ Trip</b> in the list or on a park card.</p>`;
    el.querySelector(".trip-close").addEventListener("click", () => {
      trip.open = false;
      renderTrip();
    });
    return;
  }

  const plan = planTrip(trip.codes, matrix, parks);
  const steps = [];
  plan.order.forEach((code, i) => {
    const park = parksByCode.get(code);
    steps.push(`
      <li class="stop">
        <span class="n">${i + 1}</span>
        <button class="stop-name" data-code="${code}">${escapeHtml(park?.name ?? code)}${
          park ? `<span class="country-tag ${park.country === "CA" ? "ca" : "us"}">${park.country}</span>` : ""
        }</button>
        <button class="stop-remove" data-code="${code}" aria-label="Remove ${escapeAttr(park?.name ?? code)}">&times;</button>
      </li>`);

    const l = plan.legs[i];
    if (l) {
      const label = l.connected
        ? `${fmtDuration(l.minutes)} · ${l.miles} mi`
        : `no road route — fly`;
      steps.push(`<li class="leg ${l.connected ? "" : "unrouted"}">${escapeHtml(label)}</li>`);
    }
  });

  el.innerHTML = `
    <div class="trip-head">
      <h3>Trip · ${plan.order.length} parks</h3>
      <button class="trip-close" aria-label="Close trip planner">&times;</button>
    </div>
    <ol class="trip-steps">${steps.join("")}</ol>
    <div class="trip-total">
      <span>Total</span>
      <b>${fmtDuration(plan.totalMinutes)} · ${plan.totalMiles.toLocaleString()} mi</b>
    </div>
    ${plan.disconnected ? `<p class="trip-note">Some parks need a flight — those legs are excluded from the drive total.</p>` : ""}
    <div class="trip-actions">
      <button id="trip-show">Show on map</button>
      <button id="trip-clear" class="link-btn">Clear trip</button>
    </div>
  `;

  el.querySelector(".trip-close").addEventListener("click", () => {
    trip.open = false;
    renderTrip();
  });
  el.querySelector("#trip-clear").addEventListener("click", () => {
    trip.codes = [];
    trip.open = false;
    updateCounters();
    renderTrip();
    if (!$("#list").hidden) renderList();
    if (openCode) renderDetail(parksByCode.get(openCode));
  });
  el.querySelector("#trip-show").addEventListener("click", () => {
    showView("map");
    fitVisible(trip.codes.map((c) => parksByCode.get(c)).filter(Boolean));
  });
  el.querySelectorAll(".stop-name").forEach((btn) => {
    btn.addEventListener("click", () => {
      const park = parksByCode.get(btn.dataset.code);
      showView("map");
      focusPark(btn.dataset.code);
      renderDetail(park);
    });
  });
  el.querySelectorAll(".stop-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleTrip(btn.dataset.code);
      renderDetail(openCode ? parksByCode.get(openCode) : null);
    });
  });
}

// ---------- list ----------

function sortParks(list) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (state.sort === "state") {
    return [...list].sort(
      (a, b) => String(a.state_label).localeCompare(String(b.state_label)) || byName(a, b),
    );
  }
  if (state.sort === "visited") {
    return [...list].sort(
      (a, b) => Number(state.visited.has(b.code)) - Number(state.visited.has(a.code)) || byName(a, b),
    );
  }
  return [...list].sort(byName);
}

function gatewayCell(items, fmt) {
  if (!items.length) return `<span class="muted">—</span>`;
  return items
    .slice(0, 2)
    .map(fmt)
    .join("<br>");
}

function rowHtml(p) {
      const isV = state.visited.has(p.code);
      const inTrip = trip.codes.includes(p.code);
      const cities = gatewayCell(
        p.nearby_cities,
        (c) => `${escapeHtml(c.name)} <span class="muted">${escapeHtml(driveLabel(c))}</span>`,
      );
      const airports = gatewayCell(
        p.nearby_airports,
        (a) =>
          `<b>${a.iata}</b> <span class="muted">${escapeHtml(driveLabel(a))}</span>${
            a.service && a.service !== "major" ? serviceBadge(a) : ""
          }`,
      );

      return `
      <tr data-code="${p.code}" class="${isV ? "visited" : ""}">
        <td class="c-check">
          <button class="check-btn" data-code="${p.code}"
            aria-label="${isV ? "Unmark" : "Mark"} ${escapeAttr(p.name)} visited"
            aria-pressed="${isV}">✓</button>
        </td>
        <td class="park-name">
          ${escapeHtml(p.name)}
          <span class="country-tag ${p.country === "CA" ? "ca" : "us"}">${p.country}</span>
          <span class="park-region">${escapeHtml(p.region)}</span>
          ${p.permit ? `<span class="flag">entry control</span>` : ""}
        </td>
        <td class="park-state">${escapeHtml(p.state_label)}</td>
        <td class="c-cities">${cities}</td>
        <td class="c-airports">${airports}</td>
        <td class="c-trip">
          <button class="trip-add ${inTrip ? "on" : ""}" data-code="${p.code}"
            aria-pressed="${inTrip}" aria-label="${inTrip ? "Remove from" : "Add to"} trip">${inTrip ? "−" : "+"}</button>
        </td>
      </tr>`;
}

function renderList() {
  const el = $("#list");
  const visible = sortParks(parks.filter((p) => matches(p, state)));

  const totals = { US: [0, 0], CA: [0, 0] };
  for (const park of parks) {
    const bucket = totals[park.country] || (totals[park.country] = [0, 0]);
    bucket[1] += 1;
    if (state.visited.has(park.code)) bucket[0] += 1;
  }

  const groupOrder =
    state.country === "all" ? ["US", "CA"] : [state.country];
  const groups = groupOrder
    .map((country) => ({
      country,
      list: visible.filter((p) => p.country === country),
    }))
    .filter((g) => g.list.length);

  const rows = groups
    .map((g) => {
      const [seen, total] = totals[g.country] || [0, 0];
      const label = g.country === "CA" ? "Canada" : "United States";
      const head = `
        <tr class="group-row ${g.country === "CA" ? "ca" : "us"}">
          <th colspan="6">
            ${label}
            <span class="group-count">${seen} of ${total} visited · ${g.list.length} shown</span>
          </th>
        </tr>`;
      return head + g.list.map(rowHtml).join("");
    })
    .join("");

  el.innerHTML = `
    <div class="list-bar">
      <button id="back-map" class="btn">← Map</button>
      <input id="list-search" type="search" placeholder="Find a park, state, town or airport…"
        value="${escapeAttr(state.search)}" autocomplete="off" spellcheck="false">
      <label class="sort">
        <span class="sr-only">Sort parks</span>
        <select id="sort">
          <option value="name"${state.sort === "name" ? " selected" : ""}>Name</option>
          <option value="state"${state.sort === "state" ? " selected" : ""}>State</option>
          <option value="visited"${state.sort === "visited" ? " selected" : ""}>Visited first</option>
        </select>
      </label>
      <button id="print" class="btn">Print</button>
      <button id="share" class="btn">Share</button>
    </div>
    <header>
      <div>
        <h2>National Parks</h2>
        <p>${visible.length} shown · ${state.visited.size} of ${parks.length} visited</p>
      </div>
    </header>
    <table>
      <thead>
        <tr>
          <th class="c-check"><span class="sr-only">Visited</span></th>
          <th>Park</th>
          <th>State</th>
          <th>Gateway towns</th>
          <th>Airports</th>
          <th class="c-trip"><span class="sr-only">Trip</span></th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty">No parks match those filters.</td></tr>`}</tbody>
    </table>
  `;

  const bar = el.querySelector(".list-bar");
  if (bar) el.style.setProperty("--bar-h", `${bar.offsetHeight}px`);

  el.querySelector("#back-map").addEventListener("click", () => showView("map"));
  el.querySelector("#print").addEventListener("click", () => window.print());
  el.querySelector("#share").addEventListener("click", share);

  const searchInput = el.querySelector("#list-search");
  searchInput.addEventListener("input", (e) => {
    state.search = e.target.value;
    restoreSearchFocus = true;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 120);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.target.value = "";
      state.search = "";
      refresh();
    }
  });

  if (restoreSearchFocus) {
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    restoreSearchFocus = false;
  }

  el.querySelector("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderList();
  });

  el.querySelectorAll(".check-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleVisited(btn.dataset.code);
      refresh();
    });
  });

  el.querySelectorAll(".trip-add").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTrip(btn.dataset.code);
    });
  });

  el.querySelectorAll("tr[data-code]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const park = parksByCode.get(tr.dataset.code);
      if (!park) return;
      showView("map");
      focusPark(park.code);
      renderDetail(park);
    });
  });
}

// ---------- region chips ----------

function renderRegions() {
  const el = $("#region-chips");
  const inScope = (p) => state.country === "all" || p.country === state.country;
  const present = [...US_REGION_ORDER, ...CA_REGION_ORDER].filter((r) =>
    parks.some((p) => p.region === r && inScope(p)),
  );

  if (state.region !== "all" && !present.includes(state.region)) state.region = "all";

  const chips = [
    `<button class="chip" data-region="all" aria-pressed="${state.region === "all"}">All</button>`,
    ...present.map((r) => {
      const cls = CA_REGION_ORDER.includes(r) ? "chip ca" : "chip";
      return `<button class="${cls}" data-region="${escapeAttr(r)}" aria-pressed="${state.region === r}">${escapeHtml(r)}</button>`;
    }),
  ];
  el.innerHTML = chips.join("");

  el.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.region = chip.dataset.region;
      el.querySelectorAll(".chip").forEach((c) =>
        c.setAttribute("aria-pressed", String(c.dataset.region === state.region)),
      );
      refresh();
      // a region chip is also a jump link: Alaska and Hawaiʻi are off the
      // mainland view and otherwise hard to find
      if (state.region === "all") fitMainland(parks);
      else fitVisible(parks.filter((p) => p.region === state.region));
    });
  });
}

// ---------- views ----------

function showView(which) {
  const isMap = which === "map";
  $("#view-map").setAttribute("aria-pressed", String(isMap));
  $("#view-list").setAttribute("aria-pressed", String(!isMap));
  $("#list").hidden = isMap;
  document.body.classList.toggle("list-open", !isMap);
  if (!isMap) renderList();
}

function showCountry(country) {
  state.country = country === "us" ? "US" : country === "ca" ? "CA" : "all";
  for (const c of ["all", "us", "ca"]) {
    const value = c === "us" ? "US" : c === "ca" ? "CA" : "all";
    $(`#country-${c}`).setAttribute("aria-pressed", String(state.country === value));
  }
  renderRegions();
  refresh();
  if (state.country === "all") fitMainland(parks);
  else fitVisible(parks.filter((p) => p.country === state.country));
}

function showFilter(filter) {
  state.filter = filter;
  for (const f of ["all", "visited", "unvisited"]) {
    $(`#filter-${f}`).setAttribute("aria-pressed", String(f === filter));
  }
  refresh();
}

// ---------- share ----------

function currentHash() {
  const parts = [];
  const token = encodeVisited(getVisited(), parks.map((p) => p.code));
  if (token && getVisited().length) parts.push(`v=${token}`);
  if (openCode) parts.push(`p=${openCode}`);
  return parts.join("&");
}

function writeHash() {
  const hash = currentHash();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
}

async function share() {
  const hash = currentHash();
  const url = `${location.origin}${location.pathname}${hash ? `#${hash}` : ""}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied — opens with this checklist");
  } catch {
    showToast(url);
  }
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const v = params.get("v");
  if (v !== null) {
    setVisited(decodeVisited(v, parks.map((p) => p.code)));
  }
  return params.get("p");
}

// ---------- matrix ----------

function syntheticMatrix(list) {
  const codes = list.map((p) => p.code);
  const duration_min = [];
  const distance_mi = [];
  for (let i = 0; i < list.length; i++) {
    duration_min.push([]);
    distance_mi.push([]);
    for (let j = 0; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const mi = haversineMi(a.centroid[1], a.centroid[0], b.centroid[1], b.centroid[0]) * 1.2;
      duration_min[i].push(Math.round((mi / 50) * 60));
      distance_mi[i].push(Math.round(mi));
    }
  }
  return { codes, duration_min, distance_mi, synthetic: true };
}

async function loadMatrix() {
  try {
    matrix = await loadJson("data/drive.json");
  } catch {
    matrix = syntheticMatrix(parks);
    console.warn("drive.json unavailable — using straight-line estimates");
  }
}

// ---------- boot ----------

async function main() {
  let geojson;
  try {
    geojson = await loadJson("data/parks.geojson");
  } catch (err) {
    showError(err.message);
    return;
  }

  parks = geojson.features.map((f) => f.properties);
  parksByCode = new Map(parks.map((p) => [p.code, p]));
  $("#park-count").textContent = parks.length;

  const deepLink = readHash();

  state.visited = new Set(getVisited());
  initMap(geojson, { onSelect: renderDetail }, state);
  renderRegions();
  updateCounters();

  $("#view-map").addEventListener("click", () => showView("map"));
  $("#view-list").addEventListener("click", () => showView("list"));

  for (const c of ["all", "us", "ca"]) {
    $(`#country-${c}`).addEventListener("click", () => showCountry(c));
  }

  for (const f of ["all", "visited", "unvisited"]) {
    $(`#filter-${f}`).addEventListener("click", () => showFilter(f));
  }

  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      state.search = value;
      refresh();
    }, 120);
  });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = parks
        .filter((p) => matches(p, state))
        .sort(
          (a, b) =>
            matchScore(a, state) - matchScore(b, state) ||
            a.name.length - b.name.length ||
            a.name.localeCompare(b.name),
        )[0];
      if (first) {
        focusPark(first.code);
        renderDetail(first);
      }
    }
    if (e.key === "Escape") {
      e.target.value = "";
      state.search = "";
      refresh();
    }
  });

  $("#base-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-base]");
    if (!btn) return;
    setBasemap(btn.dataset.base);
    $("#base-seg")
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });

  $("#trip-toggle").addEventListener("click", () => {
    trip.open = !trip.open;
    renderTrip();
  });

  $("#share-control").addEventListener("click", share);

  $("#sheet-handle").addEventListener("click", () => {
    const expanded = document.body.classList.toggle("sheet-expanded");
    const handle = $("#sheet-handle");
    handle.setAttribute("aria-expanded", String(expanded));
    handle.querySelector(".sheet-label").textContent = expanded ? "Fewer options" : "More options";
  });

  $("#reset").addEventListener("click", () => {
    if (!getVisited().length) return;
    if (!confirm("Clear every visited park?")) return;
    resetVisited();
    refresh();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openCode) renderDetail(null);
  });

  // the list is only rendered on demand, but printing needs its markup
  window.addEventListener("beforeprint", () => renderList());

  getMap().on("click", () => {
    if (openCode) renderDetail(null);
  });

  await loadMatrix();

  if (deepLink && parksByCode.has(deepLink)) {
    focusPark(deepLink);
    renderDetail(parksByCode.get(deepLink));
  }

  if ("serviceWorker" in navigator) {
    // updateViaCache: the worker script itself must never come from the HTTP
    // cache, or a new deploy can take up to ten minutes to take over.
    navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .catch(() => {});
  }
}

main().catch((err) => showError(err.message));

window.__parks = () => parks;
window.__state = () => state;
