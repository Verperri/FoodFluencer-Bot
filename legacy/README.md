# Legacy — Flask prototype (deprecated)

This folder holds the original **Flask web-app prototype** of FoodFluencer Bot.
It is **no longer used or maintained** — all functionality has been superseded by
the Chrome extension at the repository root (`background.js`, `popup.js`, etc.).

It is kept only for historical reference. Nothing in the extension imports from or
depends on anything here.

## Contents

| File | Purpose (historical) |
|---|---|
| `app.py` | Flask server: search/export/random/photo-proxy routes against the **old** Google Places API (`maps.googleapis.com/maps/api/place/*`). |
| `templates/index.html` | Server-rendered UI. |
| `static/style.css` | Styles for the rendered page. |
| `requirements.txt` | Python deps (`flask`, `requests`, `python-dotenv`). |
| `.env.example` | `GOOGLE_API_KEY` template for the Flask server (the extension instead stores its key in the popup's Settings panel). |

## Why it was retired

- The extension uses the **new** Places API (`places.googleapis.com/v1`) plus
  keyless scraping/Foursquare/OSM fallbacks; this prototype is on the deprecated
  endpoint and has diverged.
- It runs `app.run(debug=True)`, which enables the Werkzeug debugger — **never
  expose this to a network**. If you run it locally for reference, keep it bound
  to localhost and treat it as untrusted.

## Running it (reference only)

```bash
cd legacy
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # add your GOOGLE_API_KEY
python app.py          # serves on http://127.0.0.1:5000
```
