// Map layer: basemap, park polygons, collision-aware labels, gateway hints.

import { parkStyle, driveLabel, SERVICE_COLOR, SERVICE_LABEL } from "./park-data.js";
import { matches } from "./filter.js";

const map = L.map("map", {
  center: [39.8, -98.5],
  zoom: 4,
  minZoom: 2,
  maxZoom: 13,
  zoomControl: false,
});

const opentopo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 16,
  attribution: 'Basemap: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
});

const light = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 16, attribution: '&copy; <a href="https://www.esri.com">Esri</a>' },
);

const BASEMAPS = { light, terrain: opentopo };
let activeBase = "light";
light.addTo(map);

L.control.zoom({ position: "topleft" }).addTo(map);
L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);

const DIM_STYLE = { opacity: 0.12, fillOpacity: 0.08, weight: 1 };

let parkLayer = null;
let labelLayer = null;
let gatewayLayer = null;
let onSelect = null;
let labelMarkers = [];
let state = { filter: "all", search: "", region: "all", visited: new Set(), wishlist: new Set() };

export function initMap(geojson, handlers, sharedState) {
  onSelect = handlers.onSelect;
  state = sharedState;

  parkLayer = L.geoJSON(geojson, {
    style: parkStyle,
    onEachFeature: onEachPark,
  }).addTo(map);

  labelLayer = L.layerGroup().addTo(map);
  gatewayLayer = L.layerGroup().addTo(map);
  addLabels(geojson);

  // No maxBounds: a checklist map should never fight the cursor. The initial
  // view stays on the lower 48 and the region chips jump to Alaska, Hawaiʻi,
  // Samoa and the Caribbean.
  fitMainland(geojson.features.map((f) => f.properties));

  map.on("zoomend moveend resize", queueLabelLayout);
  queueLabelLayout();
  window.__map = map;
}

/** The contiguous 48, which is the useful default view. */
export function fitMainland(propsList) {
  const pts = propsList
    .filter((p) => {
      const [lon, lat] = p.centroid;
      return lon >= -130 && lon <= -66 && lat >= 24 && lat <= 50;
    })
    .map((p) => [p.centroid[1], p.centroid[0]]);

  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 6 });
}

function onEachPark(feature, layer) {
  const props = feature.properties;

  layer.on({
    click: (e) => {
      L.DomEvent.stopPropagation(e);
      if (onSelect) onSelect(props);
    },
    mouseover: () => layer.setStyle({ weight: 3, fillOpacity: 0.95 }),
    mouseout: () => {
      layer.setStyle(parkStyle(feature));
      dimIfHidden(layer);
    },
  });
}

function addLabels(geojson) {
  for (const feat of geojson.features) {
    const props = feat.properties;
    const [lon, lat] = props.centroid;
    if (lat == null) continue;

    const label = L.marker([lat, lon], {
      icon: L.divIcon({
        className:
          "park-label" + (props.country === "CA" ? " ca" : ""),
        html: escapeHtml(props.name.replace(" National Park", "")),
        iconSize: null,
      }),
      keyboard: true,
      title: props.name,
    });
    label.parkCode = props.code;
    label.parkProps = props;
    label.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      if (onSelect) onSelect(props);
    });
    labelMarkers.push(label);
  }
}

// ---------- label layout with overlap suppression ----------

let layoutFrame = null;

function queueLabelLayout() {
  if (layoutFrame) cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(layoutLabels);
}

export function layoutLabels() {
  layoutFrame = null;
  if (!labelLayer) return;

  for (const m of labelMarkers) {
    if (!labelLayer.hasLayer(m)) labelLayer.addLayer(m);
  }
  for (const m of labelMarkers) {
    if (m._w) continue;
    const el = m.getElement();
    if (!el) continue;
    m._w = el.offsetWidth || 60;
    m._h = el.offsetHeight || 18;
  }

  const narrowed =
    (state.search || "").trim().length > 0 ||
    state.region !== "all" ||
    state.filter !== "all";
  const order = [...labelMarkers].sort((a, b) => {
    const av = state.visited.has(a.parkCode) ? 0 : 1;
    const bv = state.visited.has(b.parkCode) ? 0 : 1;
    return av - bv || a.parkCode.localeCompare(b.parkCode);
  });

  const placed = [];
  const pad = 3;

  for (const m of order) {
    const el = m.getElement();
    if (!el) continue;

    if (!matches(m.parkProps, state)) {
      if (labelLayer.hasLayer(m)) labelLayer.removeLayer(m);
      continue;
    }

    el.classList.toggle("visited", state.visited.has(m.parkCode));
    el.classList.toggle("wish", !state.visited.has(m.parkCode) && state.wishlist.has(m.parkCode));
    el.classList.toggle("ca", m.parkProps?.country === "CA");

    const pt = map.latLngToContainerPoint(m.getLatLng());
    const w = m._w + pad * 2;
    const h = m._h + pad * 2;
    const box = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };

    const overlaps = placed.some(
      (r) =>
        !(box.x + box.w < r.x || r.x + r.w < box.x ||
          box.y + box.h < r.y || r.y + r.h < box.y),
    );

    if (overlaps && !narrowed) {
      if (labelLayer.hasLayer(m)) labelLayer.removeLayer(m);
    } else {
      placed.push(box);
    }
  }
}

// ---------- gateway hints for the open park ----------

export function showGateways(props) {
  gatewayLayer.clearLayers();
  if (!props) return;

  const addGateway = (g, color, kind) => {
    if (g.lat == null || g.lon == null) return;

    const marker = L.circleMarker([g.lat, g.lon], {
      radius: 5.5,
      weight: 2,
      color: "#ffffff",
      fillColor: color,
      fillOpacity: 1,
    });

    const title = kind === "airport" ? `${g.iata} · ${g.name}` : g.name;
    const detail = driveLabel(g);
    const tier = kind === "airport" ? g.service || "limited" : null;
    const sub =
      kind === "airport" && g.city
        ? `${g.city} · ${detail} · ${SERVICE_LABEL[tier]}`
        : detail;

    marker.bindTooltip(
      `<b>${escapeHtml(title)}</b><br><span class="gw-sub">${escapeHtml(sub)}</span>`,
      { className: "gw-tip", direction: "top", offset: [0, -7], opacity: 1 },
    );

    // hover does not exist on a phone, so tapping gives the same details
    marker.bindPopup(
      `<b>${escapeHtml(title)}</b><br><span class="gw-sub">${escapeHtml(sub)}</span>`,
      { className: "gw-pop", closeButton: false },
    );

    marker.on("click", (e) => L.DomEvent.stopPropagation(e));
    marker.addTo(gatewayLayer);
  };

  for (const c of props.nearby_cities || []) addGateway(c, "#6b7280", "town");
  for (const a of props.nearby_airports || []) {
    addGateway(a, SERVICE_COLOR[a.service] || SERVICE_COLOR.limited, "airport");
  }
}

export function clearGateways() {
  gatewayLayer?.clearLayers();
}

// ---------- state ----------

function dimIfHidden(layer) {
  if (!matches(layer.feature.properties, state)) layer.setStyle(DIM_STYLE);
}

export function restyle() {
  if (!parkLayer) return;
  parkLayer.eachLayer((layer) => {
    layer.setStyle(parkStyle(layer.feature));
    dimIfHidden(layer);
  });
  queueLabelLayout();
}

export function setState(next) {
  state = next;
  restyle();
}

export function focusPark(code) {
  if (!parkLayer) return;
  parkLayer.eachLayer((layer) => {
    if (layer.feature.properties.code === code) {
      map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 9 });
    }
  });
}

export function fitVisible(parks) {
  const pts = parks
    .map((p) => {
      const [lon, lat] = p.centroid;
      return [lat, lon];
    })
    .filter(([lat]) => Number.isFinite(lat));
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 9 });
  else if (pts.length === 1) map.setView(pts[0], 8);
}

export function setBasemap(which) {
  if (activeBase === which || !BASEMAPS[which]) return;
  map.removeLayer(BASEMAPS[activeBase]);
  BASEMAPS[which].addTo(map);
  activeBase = which;
}

export function getMap() {
  return map;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}
