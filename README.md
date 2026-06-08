# Berliner Bäder – jetzt offen 🏊

A free, static web app that shows **which Berliner Bäder‑Betriebe pools are open right now**,
**how much longer they'll be open**, and **how long it takes to get there by public transport**
from your location — on a transit‑focused map of Berlin.

- 🗺️ **Map**: Leaflet + ÖPNVKarte tiles (all U‑/S‑Bahn, tram and bus lines), free, no API key.
- 🚆 **Directions**: the free, keyless [VBB transport REST API](https://v6.vbb.transport.rest)
  computes real public‑transport journey times, live in the browser.
- 🕒 **Opening hours**: scraped from
  [berlinerbaeder.de](https://www.berlinerbaeder.de/oeffnungszeiten-auf-einem-blick/)
  by a GitHub Action **every 30 minutes** and committed as `data/pools.json`.
- 💸 **Excludes pools with separate/extra entrance pricing** (e.g. Strandbad Halensee) — see below.
- 🧭 Two modes: **Jetzt** (open now from your location) and **Planen** (pick a start, day & time).
- 🍽️ **Optional destination** ("Ziel danach"): add a place you're heading afterwards (e.g. a
  restaurant) and pools are ranked by **total** start → pool → destination transit time, so you
  find the one best-connected to both. Each leg gets its own Google Maps directions link.

Everything runs client‑side, so it hosts for free on **GitHub Pages**.

---

## How it works

```
berlinerbaeder.de ──(GitHub Action, every 30 min)──> scraper/scrape.mjs ──> data/pools.json
                                                                                   │
data/pools-meta.json  (static: coords, official URL, category, exclusions)         │
        └──────────────────────────────┬────────────────────────────────────────┘
                                        ▼
                       Browser (index.html + js/*) merges the two,
                       filters to OPEN & non‑excluded pools, draws Leaflet
                       markers, and asks the VBB API for journey times.
```

Why a scheduled scrape instead of fetching on every page load? GitHub Pages only serves static
files, and berlinerbaeder.de blocks direct cross‑origin browser requests (no CORS). The Action
refreshes the data every 30 minutes and commits it; each commit redeploys Pages, so visitors
always get near‑current hours without any backend.

## Project layout

| Path | Purpose |
|------|---------|
| `index.html`, `css/`, `js/` | the static app (ES modules, no build step) |
| `data/pools.json` | **generated** opening hours (7‑day rolling window) — committed by CI |
| `data/pools-meta.json` | hand‑curated: coordinates, official URL, category, `excluded` flag |
| `scraper/scrape.mjs` | fetch + parse → writes `data/pools.json` |
| `.github/workflows/scrape.yml` | cron job that runs the scraper and commits changes |

## Deploy to GitHub Pages (free)

1. Create a new GitHub repo and push this folder to the `main` branch.
2. **Settings → Pages → Build and deployment → Source: _Deploy from a branch_**, branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions: _Read and write permissions_**
   (so the scrape job can commit the refreshed data).
4. Open **Actions → “Refresh opening hours” → Run workflow** once to generate fresh data
   (it then runs automatically every 30 min).
5. Your site is live at `https://<user>.github.io/<repo>/`.

> Scheduled GitHub Actions only run from the **default branch** and may be delayed a few minutes
> under load — fine for opening hours.

## Excluded pools (separate pricing)

Per the request, pools whose entrance pricing differs from the standard BBB tariff are **not shown**.
These were identified by cross‑checking the official
[tariff page](https://www.berlinerbaeder.de/preise-tarifsatzung/): every pool listed there is shown;
the ones absent (separately operated lidos) are excluded:

> Sportbad Britz · Strandbad Friedrichshagen · Strandbad Grünau · Strandbad Halensee ·
> Strandbad Jungfernheide · Strandbad Orankesee · Strandbad Plötzensee · Strandbad Wendenschloss

(Strandbad **Wannsee** *is* on the standard tariff, so it stays.) To change this, edit the
`excluded` flags in [`data/pools-meta.json`](data/pools-meta.json).

## Local development

```bash
# refresh the data once (Node 18+; uses a File polyfill for Node 18)
cd scraper && npm install && node scrape.mjs && cd ..

# serve the static site (ES modules need http://, not file://)
python3 -m http.server 8000
# open http://localhost:8000
```

## Data sources & credits

- Opening hours & official pool pages — [Berliner Bäder‑Betriebe](https://www.berlinerbaeder.de/).
- Journeys & geocoding — [VBB transport.rest](https://v6.vbb.transport.rest) by Jannis Redmann.
- Map tiles — [ÖPNVKarte / memomaps.de](https://memomaps.de/) (CC‑BY‑SA) and
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Step‑by‑step directions open in Google Maps (transit mode).

Pool coordinates were geocoded via OpenStreetMap Nominatim and stored statically.
