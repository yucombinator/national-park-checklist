// Visited-state store: localStorage, plus URL-safe share encoding.

const KEY = "nps-visited";
const WISH_KEY = "nps-wishlist";

function readList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key, codes) {
  localStorage.setItem(key, JSON.stringify([...new Set(codes)]));
}

export function getVisited() {
  return readList(KEY);
}

export function getWishlist() {
  return readList(WISH_KEY);
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
  writeList(KEY, codes);
}

export function resetVisited() {
  localStorage.removeItem(KEY);
}

export function setWishlist(codes) {
  writeList(WISH_KEY, codes);
}

export function isWishlisted(code) {
  return getWishlist().includes(code);
}

export function toggleWishlist(code) {
  const list = getWishlist();
  const i = list.indexOf(code);
  if (i >= 0) list.splice(i, 1);
  else list.push(code);
  writeList(WISH_KEY, list);
  return i < 0; // true when it is now on the wishlist
}

export function resetWishlist() {
  localStorage.removeItem(WISH_KEY);
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

/** Pack a code list into a short URL-safe bitmask keyed by the code order. */
export function encodeMask(codes, allCodes) {
  const bytes = new Uint8Array(Math.ceil(allCodes.length / 8));
  allCodes.forEach((code, i) => {
    if (codes.includes(code)) bytes[i >> 3] |= 1 << (i & 7);
  });
  return b64url(bytes);
}

/** Unpack a bitmask back into the park codes it marks. */
export function decodeMask(token, allCodes) {
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
