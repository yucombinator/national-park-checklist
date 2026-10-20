// Visited-state store: localStorage, plus URL-safe share encoding.

const KEY = "nps-visited";

export function getVisited() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export function isVisited(code) {
  return getVisited().includes(code);
}

export function toggleVisited(code) {
  const visited = getVisited();
  const i = visited.indexOf(code);
  if (i >= 0) visited.splice(i, 1);
  else visited.push(code);
  localStorage.setItem(KEY, JSON.stringify(visited));
  return i < 0;
}

export function setVisited(codes) {
  localStorage.setItem(KEY, JSON.stringify([...new Set(codes)]));
}

export function resetVisited() {
  localStorage.removeItem(KEY);
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

/** Pack a visited list into a short URL-safe bitmask keyed by the code order. */
export function encodeVisited(codes, allCodes) {
  const bytes = new Uint8Array(Math.ceil(allCodes.length / 8));
  allCodes.forEach((code, i) => {
    if (codes.includes(code)) bytes[i >> 3] |= 1 << (i & 7);
  });
  return b64url(bytes);
}

/** Unpack a bitmask back into the park codes it marks visited. */
export function decodeVisited(token, allCodes) {
  let bytes;
  try {
    bytes = fromB64url(token);
  } catch {
    return [];
  }
  const out = [];
  allCodes.forEach((code, i) => {
    if (i >> 3 < bytes.length && bytes[i >> 3] & (1 << (i & 7))) out.push(code);
  });
  return out;
}
