// Park rendering: polygon styles and detail-card markup.

import { isVisited } from "./store.js";
import { fmtDuration } from "./trip.js";

export const PALETTE = {
  US: { open: "#74c69d", openLine: "#52b788", visited: "#f59e0b", visitedLine: "#92400e" },
  CA: { open: "#8ecae6", openLine: "#219ebc", visited: "#d62828", visitedLine: "#8b1a1a" },
};

export function parkStyle(feature) {
  const props = feature.properties;
  const visited = isVisited(props.code);
  const palette = PALETTE[props.country] || PALETTE.US;
  return {
    fillColor: visited ? palette.visited : palette.open,
    weight: visited ? 2.5 : 1.5,
    opacity: 1,
    color: visited ? palette.visitedLine : palette.openLine,
    fillOpacity: visited ? 0.85 : 0.7,
  };
}

export const SERVICE_LABEL = {
  major: "major hub",
  regional: "regional",
  limited: "limited service",
};

// Mirrors AIRPORT_RADIUS in tools/build_data.py.
const AIRPORT_RADIUS_LABEL = 250;

export const SERVICE_COLOR = {
  major: "#1d4ed8",
  regional: "#3b82f6",
  limited: "#93c5fd",
};

export function serviceBadge(airport) {
  const tier = airport.service || "limited";
  return `<span class="svc ${tier}" title="${SERVICE_LABEL[tier]}">${SERVICE_LABEL[tier]}</span>`;
}

/** "1 h 12 min · 58 mi", or a straight-line note when there is no road. */
export function driveLabel(g) {
  if (g.drive_min === 0 && g.drive_mi === 0) return "at the park";
  if (g.drive_min != null && g.drive_mi != null) {
    return `${fmtDuration(g.drive_min)} · ${g.drive_mi} mi`;
  }
  if (g.miles != null) return `${g.miles} mi direct`;
  return "";
}

export function detailHtml(props, opts = {}) {
  const visited = isVisited(props.code);
  const inTrip = opts.inTrip;

  const cities = props.nearby_cities.length
    ? props.nearby_cities
        .map(
          (c) => `
      <div class="nearby-item">
        <span class="name">${escapeHtml(c.name)}</span>
        <span class="dist">${escapeHtml(driveLabel(c))}</span>
      </div>`,
        )
        .join("")
    : `<div class="nearby-empty">No town within 300 mi</div>`;

  const airports = props.nearby_airports.length
    ? props.nearby_airports
        .map(
          (a) => `
      <div class="nearby-item">
        <span class="name"><span class="iata">${a.iata}</span>${escapeHtml(a.name)}${serviceBadge(a)}</span>
        <span class="dist">${escapeHtml(driveLabel(a))}</span>
      </div>`,
        )
        .join("")
    : `<div class="nearby-empty">No scheduled service within ${AIRPORT_RADIUS_LABEL} mi</div>`;

  const permit = props.permit
    ? `<div class="notice permit"><b>Entry control</b>${escapeHtml(props.permit)}</div>`
    : "";
  const access = props.access
    ? `<div class="notice access"><b>Access</b>${escapeHtml(props.access)}</div>`
    : "";

  return `
    <h3>${escapeHtml(props.name)}</h3>
    <p class="state">${escapeHtml(props.state_label)} · ${escapeHtml(props.region)}</p>
    <span class="visited-badge ${visited ? "visited" : "unvisited"}${props.country === "CA" ? " ca" : ""}">
      ${visited ? "★ Visited" : "Not visited"}
    </span>
    <span class="country-tag ${props.country === "CA" ? "ca" : "us"}">${props.country === "CA" ? "Canada" : "United States"}</span>
    ${permit}${access}
    <div class="section">
      <h4>Gateway towns</h4>
      <div class="nearby">${cities}</div>
    </div>
    <div class="section">
      <h4>Airports</h4>
      <div class="nearby">${airports}</div>
    </div>
    <div class="actions">
      <button class="toggle-btn ${visited ? "visited" : ""}${props.country === "CA" ? " ca" : ""}" data-code="${props.code}">
        ${visited ? "Mark unvisited" : "Mark visited"}
      </button>
      <button class="trip-btn ${inTrip ? "on" : ""}" data-code="${props.code}">
        ${inTrip ? "− Trip" : "+ Trip"}
      </button>
    </div>
    <a class="park-link" href="${escapeAttr(props.link)}" target="_blank" rel="noopener">
      Plan your visit on nps.gov ↗
    </a>
  `;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
