# FoodFluencer Bot — Setup Guide

Retrieves the top 3–5 photos for any restaurant in Belgium and exports them to a local folder with a metadata note.

## 1. Get a Google Places API key (free)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Create a new project (or select an existing one).
3. In the left menu go to **APIs & Services → Library**.
4. Search for and enable **Places API**.
5. Go to **APIs & Services → Credentials** → **+ Create Credentials → API key**.
6. Copy the generated key.

> Free tier gives $200/month credit — roughly 5,000–10,000 restaurant searches for free.

## 2. Configure the key

```bash
cp .env.example .env
```

Open `.env` and replace the placeholder:

```
GOOGLE_API_KEY=AIza...your_key_here
```

## 3. Install dependencies

```bash
pip install -r requirements.txt
```

## 4. Run

```bash
python app.py
```

Open your browser at **http://localhost:5000**

## How it works

1. Type a restaurant name (e.g. `Comme Chez Soi, Brussels` or `De Vitrine, Ghent`).
2. Click **Search** — the top result in Belgium is shown with a preview of up to 5 photos.
3. Click **Export Photos** — images are saved to `exports/<restaurant>_<timestamp>/` along with an `info.txt` note containing the name and address.
4. All exports are logged to `logs/export_log.csv`.

## Output structure

```
exports/
  comme_chez_soi_20260602_143021/
    photo_01.jpg
    photo_02.jpg
    photo_03.jpg
    info.txt          ← name, address, timestamp
logs/
  export_log.csv      ← running history of all exports
  app.log             ← server log
```
