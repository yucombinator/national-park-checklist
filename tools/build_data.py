#!/usr/bin/env python3
"""Build the park dataset used by the checklist site.

Inputs (downloaded once into tools/.cache):
  - NPS administrative boundaries (ArcGIS feature service, GeoJSON)
  - OurAirports airports.csv (scheduled-service fields)
  - GeoNames US/territory place files (population)

Outputs:
  - data/parks.geojson   park shapes, gateway cities/airports, access notes
  - data/drive.json      drive matrix between every pair of parks

Every derived number is reproducible: rerun this file.
"""

import csv
import collections
import json
import math
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

from shapely.geometry import MultiPolygon, Point, shape, mapping
from shapely.ops import nearest_points

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
DATA = os.path.join(ROOT, "data")

NPS_URL = (
    "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/"
    "NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/"
    "query?where=1%3D1&outFields=*&f=geojson&returnGeometry=true&outSR=4326"
)
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
ROUTES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat"
GEONAMES_URL = "https://download.geonames.org/export/dump/{code}.zip"
OSRM = "https://router.project-osrm.org"

CA_PLACES_URL = "https://opendata.arcgis.com/datasets/0fb235ee5bb34e51a825add061dd1a21_0.geojson"
CA_NRCAN_LIST_URL = (
    "https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/"
    "CLSS_Administrative_Boundaries/MapServer/1/query?where=1%3D1"
    "&outFields=adminAreaId,adminAreaNameEng&returnGeometry=false&f=json"
)
CA_GULF_URL = (
    "https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/"
    "CLSS_Administrative_Boundaries/MapServer/1/query?where=adminAreaId%3D%27GULF%27"
    "&outFields=adminAreaId,adminAreaNameEng&outSR=4326&f=geojson"
)
NE_ADMIN1_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_50m_admin_1_states_provinces.geojson"
)

# NPS types the 62 "National Parks" plainly, but New River Gorge carries the
# preserve type because its unit is a park *and* preserve. Everything else in
# that bucket (20 units) is a preserve without a park designation.
PARK_CODES = None  # filled from NPS data
EXTRA_PARK_CODES = {"NERI"}

US_TERRITORIES = ("US", "VI", "AS", "GU", "MP", "PR")
GATEWAY_COUNTRIES = US_TERRITORIES + ("CA",)

CA_PROVINCE_REGION = {
    "Nova Scotia": "Atlantic",
    "New Brunswick": "Atlantic",
    "Prince Edward Island": "Atlantic",
    "Newfoundland and Labrador": "Atlantic",
    "Quebec": "Quebec",
    "Ontario": "Ontario",
    "Manitoba": "Prairies",
    "Saskatchewan": "Prairies",
    "Alberta": "Prairies",
    "British Columbia": "Pacific",
    "Yukon": "North",
    "Northwest Territories": "North",
    "Nunavut": "North",
}
CA_PROVINCE_CODE = {
    "Alberta": "ab", "British Columbia": "bc", "Manitoba": "mb",
    "New Brunswick": "nb", "Newfoundland and Labrador": "nl",
    "Nova Scotia": "ns", "Northwest Territories": "nt", "Nunavut": "nu",
    "Ontario": "on", "Prince Edward Island": "pe", "Quebec": "qc",
    "Saskatchewan": "sk", "Yukon": "yt",
}

# Four designated parks are missing from one source or the other; these keep
# their Parks Canada short codes when the name match cannot find one.
CA_LINKS = {
    "CA-AKAM": "https://parks.canada.ca/pn-np/nl/mealy",
    "CA-AULA": "https://parks.canada.ca/pn-np/nt/aulavik",
    "CA-AUYU": "https://parks.canada.ca/pn-np/nu/auyuittuq",
    "CA-BANF": "https://parks.canada.ca/pn-np/ab/banff",
    "CA-BRPE": "https://parks.canada.ca/pn-np/on/bruce",
    "CA-CBHI": "https://parks.canada.ca/pn-np/ns/cbreton",
    "CA-ELKI": "https://parks.canada.ca/pn-np/ab/elkisland",
    "CA-FORI": "https://parks.canada.ca/pn-np/qc/forillon",
    "CA-FUND": "https://parks.canada.ca/pn-np/nb/fundy",
    "CA-GBIS": "https://parks.canada.ca/pn-np/on/georg",
    "CA-GLAC": "https://parks.canada.ca/pn-np/bc/glacier",
    "CA-GRAS": "https://parks.canada.ca/pn-np/sk/grasslands",
    "CA-GROS": "https://parks.canada.ca/pn-np/nl/grosmorne",
    "CA-GULF": "https://parks.canada.ca/pn-np/bc/gulf",
    "CA-GWAA": "https://parks.canada.ca/pn-np/bc/gwaiihaanas",
    "CA-IVVA": "https://parks.canada.ca/pn-np/yt/ivvavik",
    "CA-JASP": "https://parks.canada.ca/pn-np/ab/jasper",
    "CA-KEJI": "https://parks.canada.ca/pn-np/ns/kejimkujik",
    "CA-KLUA": "https://parks.canada.ca/pn-np/yt/kluane",
    "CA-KOOT": "https://parks.canada.ca/pn-np/bc/kootenay",
    "CA-KOUC": "https://parks.canada.ca/pn-np/nb/kouchibouguac",
    "CA-MAUR": "https://parks.canada.ca/pn-np/qc/mauricie",
    "CA-MING": "https://parks.canada.ca/pn-np/qc/mingan",
    "CA-NAAT": "https://parks.canada.ca/pn-np/nt/naatsihchoh",
    "CA-NAHA": "https://parks.canada.ca/pn-np/nt/nahanni",
    "CA-NOVA": "https://parks.canada.ca/pn-np/nl/terranova",
    "CA-PALB": "https://parks.canada.ca/pn-np/sk/princealbert",
    "CA-PEIS": "https://parks.canada.ca/pn-np/pe/pei-ipe",
    "CA-PELE": "https://parks.canada.ca/pn-np/on/pelee",
    "CA-PRIM": "https://parks.canada.ca/pn-np/bc/pacificrim",
    "CA-PUKA": "https://parks.canada.ca/pn-np/on/pukaskwa",
    "CA-QAUS": "https://parks.canada.ca/pn-np/nu/qausuittuq",
    "CA-QUTT": "https://parks.canada.ca/pn-np/nu/quttinirpaaq",
    "CA-REVE": "https://parks.canada.ca/pn-np/bc/revelstoke",
    "CA-RIDM": "https://parks.canada.ca/pn-np/mb/riding",
    "CA-SABL": "https://parks.canada.ca/pn-np/ns/sable",
    "CA-SIRM": "https://parks.canada.ca/pn-np/nu/sirmilik",
    "CA-THAI": "https://parks.canada.ca/pn-np/nt/thaidene-nene",
    "CA-THIS": "https://parks.canada.ca/pn-np/on/1000",
    "CA-TORN": "https://parks.canada.ca/pn-np/nl/torngats",
    "CA-TUKT": "https://parks.canada.ca/pn-np/nt/tuktutnogait",
    "CA-UKKU": "https://parks.canada.ca/pn-np/nu/ukkusiksalik",
    "CA-VUNT": "https://parks.canada.ca/pn-np/yt/vuntut",
    "CA-WAPU": "https://parks.canada.ca/pn-np/mb/wapusk",
    "CA-WATE": "https://parks.canada.ca/pn-np/ab/waterton",
    "CA-WOOD": "https://parks.canada.ca/pn-np/nt/woodbuffalo",
    "CA-YOHO": "https://parks.canada.ca/pn-np/bc/yoho",
}

CA_CODE_OVERRIDES = {
    "BRUCEPENINSULA": "BRPE",
    "PUKASKWA": "PUKA",
    "SABLEISLAND": "SABL",
    "AKAMIUAPISHKU": "AKAM",
}

CA_ACCESS = {
    "AULAVIK": "Fly-in; no roads",
    "IVVAVIK": "Fly-in; no roads",
    "VUNTUT": "Fly-in; no roads",
    "TUKTUTNOGAIT": "Fly-in; no roads",
    "NAHANNI": "Fly-in or river; no roads",
    "NAATSIHCHOH": "Fly-in; no roads",
    "WAPUSK": "Fly-in or boat; no roads",
    "TORNGAT": "Fly-in or boat; no roads",
    "AUYUITTUQ": "Fly-in; no roads",
    "QUTTINIRPAAQ": "Fly-in; no roads",
    "SIRMILIK": "Fly-in or boat; no roads",
    "UKKUSIKSALIK": "Fly-in; no roads",
    "QAUSUITTUQ": "Fly-in; no roads",
    "THAIDENE": "Fly-in or winter road",
    "GWAIIHAANAS": "Boat or plane; no roads",
    "MINGAN": "Boat or plane",
    "PACIFICRIM": "Road to some beaches; boat elsewhere",
    "GULFISLANDS": "Ferry or boat",
    "GEORGIANBAY": "Boat or ferry to the islands",
    "THOUSANDISLANDS": "Boat or ferry to most islands",
}

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia", "AS": "American Samoa",
    "VI": "Virgin Islands", "PR": "Puerto Rico", "GU": "Guam",
    "MP": "Northern Mariana Islands",
}
STATE_ALIASES = {"SAMOA": "AS"}

REGIONS = {
    "Alaska": ["DENA", "GAAR", "GLBA", "KATM", "KEFJ", "KOVA", "LACL", "WRST"],
    "Hawaiʻi & Pacific": ["HALE", "HAVO", "NPSA"],
    "Pacific Northwest": ["NOCA", "OLYM", "MORA", "CRLA"],
    "California": ["REDW", "LAVO", "YOSE", "SEQU", "KICA", "PINN", "JOTR", "DEVA", "CHIS"],
    "Southwest": ["GRCA", "ZION", "BRCA", "ARCH", "CANY", "CARE", "PEFO", "SAGU",
                  "GUMO", "WHSA", "MEVE", "GRBA"],
    "Rockies": ["ROMO", "GRTE", "YELL", "GLAC", "GRSA", "BLCA", "WICA", "THRO", "BADL"],
    "Plains & Midwest": ["VOYA", "ISRO", "INDU", "CUVA", "MAMM", "HOSP", "JEFF"],
    "South": ["SHEN", "GRSM", "CONG", "BIBE", "CAVE", "MACA"],
    "Northeast": ["ACAD"],
    "Florida & Caribbean": ["BISC", "EVER", "DRTO", "VIIS"],
}

# Curated from park plan-your-visit pages. Deliberately conservative: only
# entry controls that change trip logistics, and every card links the official
# page so the reader can confirm before booking.
ACCESS = {
    "ACAD": ("Cadillac Summit Road reservation (late May–Oct)", ""),
    "ARCH": ("Timed entry reservation, Apr–Oct", ""),
    "DENA": ("Road permit past Savage River (summer)", ""),
    "GLAC": ("Vehicle reservation, Going-to-the-Sun Rd (summer)", ""),
    "GRSM": ("Parking tag required", ""),
    "HALE": ("Sunrise reservation for the summit (3–7am)", ""),
    "JEFF": ("Tram ticket to the top", ""),
    "MORA": ("Timed entry reservation (summer)", ""),
    "ROMO": ("Timed entry reservation, May–Oct", ""),
    "YOSE": ("Entry reservation on peak days; Half Dome lottery", ""),
    "ZION": ("Angels Landing lottery; shuttle in season", ""),
    "BISC": ("", "Boat or kayak access"),
    "CHIS": ("", "Boat or plane; no bridge to the islands"),
    "DRTO": ("", "Ferry or seaplane only"),
    "GAAR": ("", "Fly-in; no roads"),
    "GLBA": ("", "Boat or plane; no roads"),
    "ISRO": ("", "Ferry or seaplane only"),
    "KATM": ("", "Floatplane or boat; no roads"),
    "KEFJ": ("", "Road to Exit Glacier; boat or plane elsewhere"),
    "KOVA": ("", "Fly-in; no roads"),
    "LACL": ("", "Floatplane or boat; no roads"),
    "NPSA": ("", "Fly to Pago Pago, then road"),
    "VOYA": ("", "Boat or road; water access to campsites"),
    "WRST": ("", "Road to McCarthy; fly-in elsewhere"),
}

USER_AGENT = "park-checklist-builder/1.0 (+https://yuchenhou.com)"

# A gateway farther than this is not a gateway — it is a different trip.
CITY_RADIUS = 150
AIRPORT_RADIUS = 250

# Airports are ranked by drive time plus a penalty for thin service, so a real
# hub two hours out beats a one-flight-a-day field next door.
SERVICE_PENALTY = {"major": 0, "regional": 60, "limited": 500}

# A polygon smaller than this is ~0.1 km². At national zoom Leaflet still
# strokes it at full width, so thousands of islets render as speckle. Keep the
# archipelago, drop the rocks.
MIN_PART_AREA = 1e-5
MAJOR_ROUTES = 25
REGIONAL_ROUTES = 2


def fetch(url, path, timeout=120):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f"  download {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(path, "wb") as fh:
        fh.write(resp.read())
    return path


def haversine(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def drop_specks(geom):
    """Remove sub-pixel islets, never the whole park."""
    if geom.geom_type != "MultiPolygon":
        return geom
    parts = [part for part in geom.geoms if part.area >= MIN_PART_AREA]
    if not parts:
        parts = [max(geom.geoms, key=lambda part: part.area)]
    return MultiPolygon(parts) if len(parts) > 1 else parts[0]


def round_coords(obj, digits=5):
    if isinstance(obj, (list, tuple)):
        return [round_coords(v, digits) for v in obj]
    if isinstance(obj, float):
        return round(obj, digits)
    return obj


def load_parks():
    path = fetch(NPS_URL, os.path.join(CACHE, "nps_boundaries.geojson"))
    with open(path) as fh:
        raw = json.load(fh)
    parks = []
    for feat in raw["features"]:
        props = feat["properties"]
        if props.get("UNIT_TYPE") == "National Parks" or props.get("UNIT_CODE") in EXTRA_PARK_CODES:
            parks.append(feat)
    parks.sort(key=lambda f: f["properties"]["UNIT_NAME"])
    return parks


def state_codes(raw):
    raw = (raw or "").strip()
    if raw in STATE_ALIASES:
        return [STATE_ALIASES[raw]]
    out = []
    for part in re.split(r"[^A-Za-z]+", raw):
        code = part.upper()
        if code in STATE_NAMES and code not in out:
            out.append(code)
    return out


def region_of(code):
    for region, codes in REGIONS.items():
        if code in codes:
            return region
    return "Other"


def load_cities():
    cities = []
    for code in GATEWAY_COUNTRIES:
        url = GEONAMES_URL.format(code=code)
        path = fetch(url, os.path.join(CACHE, f"gn_{code}.zip"))
        txt = os.path.join(CACHE, f"{code}.txt")
        if not os.path.exists(txt):
            import zipfile
            with zipfile.ZipFile(path) as z:
                z.extractall(CACHE)
        with open(txt, encoding="utf-8") as fh:
            for line in fh:
                c = line.rstrip("\n").split("\t")
                if len(c) < 15 or c[6] != "P":
                    continue
                try:
                    pop = int(c[14])
                    lat, lon = float(c[4]), float(c[5])
                except ValueError:
                    continue
                if pop < 300:
                    continue
                cities.append({"name": c[1], "lat": lat, "lon": lon, "pop": pop})
    return cities


def load_routes():
    """Distinct destinations per airport, from the OpenFlights route table."""
    path = fetch(ROUTES_URL, os.path.join(CACHE, "routes.dat"))
    dest = collections.defaultdict(set)
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.reader(fh):
            if len(row) < 6:
                continue
            src, dst = row[2].strip(), row[4].strip()
            if src and src != "\\N" and dst and dst != "\\N":
                dest[src].add(dst)
    return {code: len(set_) for code, set_ in dest.items()}


def service_tier(routes, airport_type):
    if routes >= MAJOR_ROUTES:
        return "major"
    if routes >= REGIONAL_ROUTES or airport_type == "large_airport":
        return "regional"
    return "limited"


def load_airports():
    path = fetch(AIRPORTS_URL, os.path.join(CACHE, "airports.csv"))
    routes = load_routes()
    out = []
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if row["iso_country"] not in GATEWAY_COUNTRIES:
                continue
            if row["type"] not in ("large_airport", "medium_airport"):
                continue
            if row["scheduled_service"] != "yes":
                continue
            iata = (row["iata_code"] or "").strip()
            if not iata:
                continue
            try:
                lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
            except ValueError:
                continue
            served = routes.get(iata, 0)
            out.append({
                "name": row["name"],
                "city": row["municipality"] or "",
                "iata": iata,
                "lat": lat,
                "lon": lon,
                "routes": served,
                "service": service_tier(served, row["type"]),
            })
    return out


def osrm_table(coords, sources, destinations, tries=3):
    """Return (durations, distances). Missing legs come back as None."""
    q = f"{OSRM}/table/v1/driving/{';'.join(f'{lon:.5f},{lat:.5f}' for lon, lat in coords)}"
    params = {"annotations": "duration,distance"}
    if sources is not None:
        params["sources"] = ";".join(str(i) for i in sources)
    if destinations is not None:
        params["destinations"] = ";".join(str(i) for i in destinations)
    url = q + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as resp:
                payload = json.load(resp)
            if payload.get("code") != "Ok":
                raise RuntimeError(payload.get("code"))
            return payload.get("durations"), payload.get("distances")
        except Exception as exc:  # noqa: BLE001 - network best effort
            if attempt == tries - 1:
                print(f"    osrm failed: {exc}", file=sys.stderr)
                return None, None
            time.sleep(2 + attempt * 2)
    return None, None


def gateway_pool(candidates, geom, centroid, prefilter=420, widen=120):
    clat, clon = centroid[1], centroid[0]
    pool = [c for c in candidates if haversine(clat, clon, c["lat"], c["lon"]) <= prefilter]
    if len(pool) < 12:
        pool = sorted(candidates, key=lambda c: haversine(clat, clon, c["lat"], c["lon"]))[:widen]
    return pool


def distance_to_park(geom, cand):
    pt = Point(cand["lon"], cand["lat"])
    if geom.contains(pt):
        return 0.0, pt
    near = nearest_points(geom.boundary, pt)[0]
    return haversine(near.y, near.x, cand["lat"], cand["lon"]), near


def pick_gateways(candidates, geom, centroid, limit=3, max_miles=400):
    scored = []
    for cand in gateway_pool(candidates, geom, centroid):
        straight, near = distance_to_park(geom, cand)
        if straight > max_miles:
            continue
        scored.append((straight, near, cand))
    scored.sort(key=lambda x: x[0])

    out, seen = [], set()
    for straight, near, cand in scored:
        key = re.sub(r"[^a-z]", "", cand["name"].lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({"cand": cand, "straight": straight, "near": near})
        if len(out) == limit:
            break
    return out


def add_drive(picked, centroid, threshold=400):
    """Attach drive distance/time per gateway.

    A park's nearest boundary point can snap to a dirt track, so each gateway
    is routed to both that boundary point and the park's representative point;
    the fastest plausible leg wins. Legs below 20 mph are treated as bad snaps.
    """
    n = len(picked)
    coords = [(p["cand"]["lon"], p["cand"]["lat"]) for p in picked]
    for p in picked:
        coords.append((p["near"].x, p["near"].y))
        coords.append((centroid[0], centroid[1]))

    destinations = list(range(n, 3 * n))
    durations, distances = osrm_table(
        coords, sources=list(range(n)), destinations=destinations
    )

    for i, item in enumerate(picked):
        best = None
        if durations and distances:
            for k in (2 * i, 2 * i + 1):
                dur = durations[i][k]
                dist = distances[i][k]
                if dur is None or dist is None:
                    continue
                miles = dist / 1609.344
                minutes = dur / 60
                if minutes <= 0 or miles <= 0:
                    continue
                if miles / (minutes / 60) < 20:  # implausible snap
                    continue
                if best is None or minutes < best[0]:
                    best = (minutes, miles)

        if best is None:
            best = None
        elif best[0] > item["straight"] * 3 + 10:
            # OSRM snapped to a track or took a detour the map does not support;
            # fall back to a distance-based estimate rather than print nonsense.
            best = None

        if best is None:
            miles = item["straight"]
            if miles <= 0.5:
                item["drive_mi"], item["drive_min"] = 0, 0
            else:
                item["drive_mi"] = int(round(miles * 1.25))
                item["drive_min"] = int(round(item["drive_mi"] / 50 * 60))
        else:
            item["drive_min"] = int(round(best[0]))
            item["drive_mi"] = int(round(best[1]))
    return picked



def norm_name(name):
    """Fold a park name to a comparable key (accents, suffixes and all)."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().upper()
    s = re.sub(
        r"\b(NATIONAL HISTORIC SITE|HAIDA HERITAGE SITE|HERITAGE SITE|OF CANADA|"
        r"NATIONAL PARK RESERVE|NATIONAL PARK|RESERVE|PARK|AND)\b",
        " ",
        s,
    )
    return re.sub(r"[^A-Z]", "", s)


def ca_display_name(raw):
    s = re.sub(r"\s+and Haida Heritage Site.*$", "", raw, flags=re.I)
    s = re.sub(r"\s+and National Historic Site.*$", "", s, flags=re.I)
    s = re.sub(r"\s*of Canada\b", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def ca_slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"national park( reserve)?", " ", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def load_nrcan_codes():
    path = fetch(CA_NRCAN_LIST_URL, os.path.join(CACHE, "ca_nrcan_codes.json"))
    with open(path) as fh:
        data = json.load(fh)
    out = {}
    for feat in data.get("features", []):
        attrs = feat["attributes"]
        out[norm_name(attrs["adminAreaNameEng"])] = attrs["adminAreaId"]
    return out


def load_provinces():
    path = fetch(NE_ADMIN1_URL, os.path.join(CACHE, "ne_admin1.geojson"))
    with open(path) as fh:
        data = json.load(fh)
    out = []
    for feat in data["features"]:
        props = feat["properties"]
        if props.get("adm0_a3") != "CAN":
            continue
        out.append((props.get("name"), shape(feat["geometry"])))
    return out


def fold_ascii(text):
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def province_for(point, provinces):
    for name, geom in provinces:
        if geom.contains(point):
            return name
    # Islands and coastal strips fall outside the land polygons, so take the
    # nearest province instead of leaving the field blank.
    if not provinces:
        return ""
    return min(provinces, key=lambda item: item[1].distance(point))[0]


def load_ca_parks():
    """Parks Canada units, unioned across the two federal open-data sources.

    The Parks Canada "places" layer has clean names and 46 units but omits Gulf
    Islands; the NRCan legislative layer carries the short park codes and Gulf
    Islands. Merge both.
    """
    path = fetch(CA_PLACES_URL, os.path.join(CACHE, "ca_places.geojson"), timeout=300)
    with open(path) as fh:
        data = json.load(fh)

    nrcan = load_nrcan_codes()
    provinces = load_provinces()
    units = []

    for feat in data["features"]:
        props = feat["properties"]
        if not props.get("PLACE_TYPE_E", "").startswith("National Park"):
            continue
        raw = props["DESC_EN"]
        key = norm_name(raw)
        code = nrcan.get(key)
        if not code:
            for prefix, override in CA_CODE_OVERRIDES.items():
                if key.startswith(prefix):
                    code = override
                    break
        if not code:
            code = key[:4] or "PARK"
        units.append({"raw": raw, "key": key, "code": "CA-" + code, "geometry": feat["geometry"]})

    have = {u["code"] for u in units}
    if "CA-GULF" not in have:
        gulf_path = fetch(CA_GULF_URL, os.path.join(CACHE, "ca_gulf.geojson"))
        with open(gulf_path) as fh:
            gdata = json.load(fh)
        if gdata.get("features"):
            units.append({
                "raw": "Gulf Islands National Park Reserve of Canada",
                "key": "GULFISLANDS",
                "code": "CA-GULF",
                "geometry": gdata["features"][0]["geometry"],
            })

    for unit in units:
        name = ca_display_name(unit["raw"])
        geom = shape(unit["geometry"])
        prov = province_for(geom.representative_point(), provinces)
        prov = fold_ascii(prov) if prov else ""
        access = ""
        for prefix, note in CA_ACCESS.items():
            if unit["key"].startswith(prefix):
                access = note
                break
        pc = CA_PROVINCE_CODE.get(prov)
        slug = ca_slug(name)
        unit.update({
            "name": name,
            "country": "CA",
            "region": CA_PROVINCE_REGION.get(fold_ascii(prov), "North"),
            "state_label": prov,
            "state_names": prov,
            "permit": "",
            "access": access,
            "link": CA_LINKS.get(unit["code"], "https://parks.canada.ca/pn-np"),
        })
    return units


def build():
    units = []

    print("loading US parks")
    for feat in load_parks():
        props = feat["properties"]
        code = props["UNIT_CODE"]
        states = state_codes(props.get("STATE"))
        permit, access_notes = ACCESS.get(code, ("", ""))
        units.append({
            "name": props["UNIT_NAME"],
            "code": code,
            "country": "US",
            "region": region_of(code),
            "state_label": ", ".join(states),
            "state_names": ", ".join(STATE_NAMES[c] for c in states),
            "permit": permit,
            "access": access_notes,
            "link": f"https://www.nps.gov/{code.lower()}/planyourvisit/index.htm",
            "geometry": feat["geometry"],
        })
    print(f"  US: {len(units)}")

    print("loading Canadian parks")
    ca_units = load_ca_parks()
    units.extend(ca_units)
    print(f"  CA: {len(ca_units)}")

    print("loading gateways")
    cities = load_cities()
    airports = load_airports()
    print(f"  cities: {len(cities)}  airports: {len(airports)}")

    features = []

    for unit in units:
        geom = shape(unit["geometry"]).simplify(0.02, preserve_topology=True)
        if geom.is_empty:
            geom = shape(unit["geometry"])
        geom = drop_specks(geom)
        centroid = geom.representative_point()
        anchor = (centroid.x, centroid.y)

        city_picks = add_drive(
            pick_gateways(cities, geom, anchor, max_miles=CITY_RADIUS), anchor
        )
        airport_candidates = add_drive(
            pick_gateways(airports, geom, anchor, limit=8, max_miles=AIRPORT_RADIUS), anchor
        )
        # A real hub two hours out is a better answer than a one-flight field
        # next door, so rank by drive time plus a service-tier penalty.
        airport_candidates.sort(
            key=lambda p: (p["drive_min"] if p["drive_min"] is not None else 10**6)
            + SERVICE_PENALTY[p["cand"]["service"]]
        )
        airport_picks = airport_candidates[:3]

        # Keep the closest thin-service field too: it is often the seasonal
        # strip at the park gate, and the UI labels it rather than hiding it.
        if not any(p["cand"]["service"] == "limited" for p in airport_picks):
            limited = [p for p in airport_candidates if p["cand"]["service"] == "limited"]
            limited.sort(key=lambda p: p["drive_min"] if p["drive_min"] is not None else 10**6)
            if limited:
                airport_picks.append(limited[0])

        features.append({
            "type": "Feature",
            "properties": {
                "name": unit["name"],
                "code": unit["code"],
                "country": unit["country"],
                "region": unit["region"],
                "state_label": unit["state_label"],
                "state_names": unit["state_names"],
                "centroid": [round(centroid.x, 5), round(centroid.y, 5)],
                # Routing anchor: the nearest gateway town sits on a real road,
                # unlike a park centroid that can land in wilderness. The drive
                # matrix routes between these anchors.
                "road_point": (
                    [round(city_picks[0]["cand"]["lon"], 5), round(city_picks[0]["cand"]["lat"], 5)]
                    if city_picks
                    else [round(centroid.x, 5), round(centroid.y, 5)]
                ),
                "permit": unit["permit"],
                "access": unit["access"],
                "link": unit["link"],
                "nearby_cities": [
                    {
                        "name": p["cand"]["name"],
                        "lat": round(p["cand"]["lat"], 5),
                        "lon": round(p["cand"]["lon"], 5),
                        "miles": int(round(p["straight"])),
                        "drive_mi": p["drive_mi"],
                        "drive_min": p["drive_min"],
                        "pop": p["cand"]["pop"],
                    }
                    for p in city_picks if p["straight"] <= CITY_RADIUS
                ],
                "nearby_airports": [
                    {
                        "name": p["cand"]["name"],
                        "city": p["cand"]["city"],
                        "iata": p["cand"]["iata"],
                        "service": p["cand"]["service"],
                        "routes": p["cand"]["routes"],
                        "lat": round(p["cand"]["lat"], 5),
                        "lon": round(p["cand"]["lon"], 5),
                        "miles": int(round(p["straight"])),
                        "drive_mi": p["drive_mi"],
                        "drive_min": p["drive_min"],
                    }
                    for p in airport_picks if p["straight"] <= AIRPORT_RADIUS
                ],
            },
            "geometry": mapping(geom),
        })
        print(f"  {unit['code']}: {len(city_picks)} cities, {len(airport_picks)} airports")

    for feat in features:
        feat["geometry"] = round_coords(feat["geometry"])

    payload = {
        "type": "FeatureCollection",
        "generated": time.strftime("%Y-%m-%d"),
        "features": features,
    }
    os.makedirs(DATA, exist_ok=True)
    out = os.path.join(DATA, "parks.geojson")
    with open(out, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {out} ({os.path.getsize(out)/1024:.0f} KB)")

    # ---- park-to-park drive matrix -------------------------------------
    coords = [tuple(f["properties"]["road_point"]) for f in features]
    codes = [f["properties"]["code"] for f in features]
    n = len(codes)
    durations = [[None] * n for _ in range(n)]
    distances = [[None] * n for _ in range(n)]

    chunk = 8
    for start in range(0, n, chunk):
        end = min(start + chunk, n)
        print(f"  matrix rows {start}–{end - 1}")
        durs, dists = osrm_table(
            coords,
            sources=list(range(start, end)),
            destinations=list(range(n)),
        )
        if not durs:
            continue
        for r, row in enumerate(durs):
            durations[start + r] = row
        for r, row in enumerate(dists or []):
            distances[start + r] = row
        time.sleep(0.7)

    matrix = {
        "generated": time.strftime("%Y-%m-%d"),
        "codes": codes,
        "duration_min": [
            [int(round(v / 60)) if isinstance(v, (int, float)) else -1 for v in row]
            for row in durations
        ],
        "distance_mi": [
            [int(round(v / 1609.344)) if isinstance(v, (int, float)) else -1 for v in row]
            for row in distances
        ],
    }
    mpath = os.path.join(DATA, "drive.json")
    with open(mpath, "w") as fh:
        json.dump(matrix, fh, separators=(",", ":"))
    routed = sum(1 for row in matrix["duration_min"] for v in row if v >= 0)
    print(f"wrote {mpath} ({os.path.getsize(mpath)/1024:.0f} KB), {routed}/{n*n} legs routed")


if __name__ == "__main__":
    build()
