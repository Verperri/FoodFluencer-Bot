import os
import csv
import random
import requests
import logging
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, request, jsonify, Response
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")

BELGIAN_RESTAURANTS = [
    "Comme Chez Soi Brussels",
    "In De Wulf Dranouter",
    "The Jane Antwerp",
    "Hof van Cleve Kruishoutem",
    "Bon Bon Brussels",
    "Numerus Clausus Namur",
    "Zilte Antwerp",
    "De Librije Bruges",
    "La Paix Brussels",
    "Bozar Restaurant Brussels",
    "De Karmeliet Bruges",
    "Bistro du Canal Brussels",
    "Humphrey Brussels",
    "Noma Ghent",
    "Vrijmoed Ghent",
    "OAK Ghent",
    "Le Pigeon Noir Ghent",
    "Gruut Stadsbrouwerij Ghent",
    "Balls & Glory Ghent",
    "Braserie Appelmans Antwerp",
    "Fiskebar Antwerp",
    "Dôme Antwerp",
    "Lunch Garden Belgium",
    "De Troubadour Bruges",
    "Den Dyver Bruges",
    "Le Chalet de la Foret Brussels",
    "La Villa Lorraine Brussels",
    "Le Tournant Liège",
    "Tanneurs Liège",
    "La Menuiserie Ghent",
]
EXPORTS_DIR = Path("exports")
LOGS_DIR = Path("logs")
LOG_FILE = LOGS_DIR / "export_log.csv"

EXPORTS_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOGS_DIR / "app.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


def search_restaurant(query: str) -> dict | None:
    """Search for a restaurant in Belgium using Places Text Search."""
    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    params = {
        "query": query,
        "region": "be",
        "type": "restaurant",
        "key": GOOGLE_API_KEY,
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "OK" or not data.get("results"):
        return None
    return data["results"][0]


def get_place_details(place_id: str) -> dict:
    """Fetch full details including photos for a place."""
    url = "https://maps.googleapis.com/maps/api/place/details/json"
    params = {
        "place_id": place_id,
        "fields": "name,formatted_address,photos,url,rating,user_ratings_total",
        "key": GOOGLE_API_KEY,
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("result", {})


def download_photo(photo_reference: str, max_width: int = 1200) -> bytes:
    """Download a photo by its reference."""
    url = "https://maps.googleapis.com/maps/api/place/photo"
    params = {
        "maxwidth": max_width,
        "photo_reference": photo_reference,
        "key": GOOGLE_API_KEY,
    }
    resp = requests.get(url, params=params, timeout=15, allow_redirects=True)
    resp.raise_for_status()
    return resp.content


def slugify(name: str) -> str:
    import re
    name = name.lower().strip()
    name = re.sub(r"[^\w\s-]", "", name)
    name = re.sub(r"[\s_-]+", "_", name)
    return name[:60]


def log_export(restaurant_name: str, address: str, export_folder: str, photo_count: int):
    write_header = not LOG_FILE.exists()
    with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["timestamp", "restaurant_name", "address", "export_folder", "photo_count"])
        writer.writerow([
            datetime.now().isoformat(),
            restaurant_name,
            address,
            export_folder,
            photo_count,
        ])


@app.route("/")
def index():
    return render_template("index.html", api_configured=bool(GOOGLE_API_KEY))


@app.route("/search", methods=["POST"])
def search():
    if not GOOGLE_API_KEY:
        return jsonify({"error": "Google API key not configured. See SETUP.md."}), 400

    data = request.get_json()
    query = (data.get("query") or "").strip()
    if not query:
        return jsonify({"error": "Please enter a restaurant name."}), 400

    # Append Belgium to bias results
    if "belgium" not in query.lower() and "belgië" not in query.lower():
        search_query = f"{query} Belgium"
    else:
        search_query = query

    logger.info("Searching for: %s", search_query)
    place = search_restaurant(search_query)
    if not place:
        return jsonify({"error": f"No restaurant found for '{query}' in Belgium."}), 404

    details = get_place_details(place["place_id"])
    photos = details.get("photos", [])

    # Sort by width (proxy for resolution/popularity) and take top 5
    photos_sorted = sorted(photos, key=lambda p: p.get("width", 0), reverse=True)[:5]

    return jsonify({
        "place_id": place["place_id"],
        "name": details.get("name", place.get("name")),
        "address": details.get("formatted_address", ""),
        "rating": details.get("rating"),
        "total_ratings": details.get("user_ratings_total"),
        "maps_url": details.get("url", ""),
        "photo_count": len(photos_sorted),
        "photos": [
            {
                "reference": p["photo_reference"],
                "width": p.get("width"),
                "height": p.get("height"),
                "attributions": p.get("html_attributions", []),
            }
            for p in photos_sorted
        ],
    })


@app.route("/export", methods=["POST"])
def export():
    if not GOOGLE_API_KEY:
        return jsonify({"error": "Google API key not configured."}), 400

    data = request.get_json()
    name = data.get("name", "").strip()
    address = data.get("address", "").strip()
    photos = data.get("photos", [])

    if not name or not photos:
        return jsonify({"error": "Missing restaurant data."}), 400

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder_name = f"{slugify(name)}_{timestamp}"
    export_path = EXPORTS_DIR / folder_name
    export_path.mkdir(parents=True, exist_ok=True)

    downloaded = []
    for i, photo in enumerate(photos[:5], start=1):
        ref = photo.get("reference")
        if not ref:
            continue
        try:
            image_bytes = download_photo(ref)
            filename = f"photo_{i:02d}.jpg"
            filepath = export_path / filename
            filepath.write_bytes(image_bytes)
            downloaded.append(filename)
            logger.info("Saved %s for %s", filename, name)
        except Exception as e:
            logger.warning("Failed to download photo %d for %s: %s", i, name, e)

    # Write info note
    info_lines = [
        f"Restaurant: {name}",
        f"Address:    {address}",
        f"Exported:   {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Photos:     {len(downloaded)}",
        "",
        "Photos downloaded:",
    ]
    for fn in downloaded:
        info_lines.append(f"  - {fn}")

    (export_path / "info.txt").write_text("\n".join(info_lines), encoding="utf-8")

    log_export(name, address, str(export_path), len(downloaded))
    logger.info("Export complete: %s (%d photos)", folder_name, len(downloaded))

    return jsonify({
        "success": True,
        "folder": str(export_path),
        "photos_saved": len(downloaded),
        "files": downloaded,
    })


@app.route("/random", methods=["POST"])
def random_restaurant():
    """Pick a random Belgian restaurant and return its details + photos."""
    if not GOOGLE_API_KEY:
        return jsonify({"error": "Google API key not configured."}), 400

    pick = random.choice(BELGIAN_RESTAURANTS)
    logger.info("Random pick: %s", pick)

    place = search_restaurant(pick)
    if not place:
        return jsonify({"error": f"Could not find '{pick}' — try again."}), 404

    details = get_place_details(place["place_id"])
    photos = details.get("photos", [])
    photos_sorted = sorted(photos, key=lambda p: p.get("width", 0), reverse=True)[:5]

    return jsonify({
        "place_id": place["place_id"],
        "name": details.get("name", place.get("name")),
        "address": details.get("formatted_address", ""),
        "rating": details.get("rating"),
        "total_ratings": details.get("user_ratings_total"),
        "maps_url": details.get("url", ""),
        "photo_count": len(photos_sorted),
        "photos": [
            {
                "reference": p["photo_reference"],
                "width": p.get("width"),
                "height": p.get("height"),
                "attributions": p.get("html_attributions", []),
            }
            for p in photos_sorted
        ],
    })


@app.route("/photo")
def photo_proxy():
    """Proxy Google Places photos to avoid exposing the API key in the browser."""
    ref = request.args.get("ref", "")
    if not ref or not GOOGLE_API_KEY:
        return "", 400
    try:
        image_bytes = download_photo(ref, max_width=800)
        return Response(image_bytes, content_type="image/jpeg")
    except Exception as e:
        logger.warning("Photo proxy error: %s", e)
        return "", 502


if __name__ == "__main__":
    app.run(debug=True, port=5000)
