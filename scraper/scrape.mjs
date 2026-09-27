// Scrapes berlinerbaeder.de "Öffnungszeiten auf einen Blick" into ../data/pools.json
//
// The page renders three identical-by-week tables (Alle Bäder / Sommerbäder /
// Hallenbäder) server-side. Each table has a header row whose day-columns are a
// rolling window starting "heute" (today) with the remaining dates printed
// explicitly (e.g. "Di. 09.06.26"). The window length is not fixed — the site
// has used 7-day and 14-day windows — so we read the count from the header.
// Each pool row has a sticky name/link cell followed by one cell per day; an open
// day holds one or more `.period` spans (split hours = multiple periods), a
// closed day holds `.timetable-closed`.
//
// We dedupe pools by slug (the Alle-Bäder table is the superset) and emit
// per-day periods for the whole window so the frontend can answer both
// "open now" and "open on <day> at <time>".
//
// The map needs coordinates, which come from the hand-curated
// data/pools-meta.json. The set of listed pools changes with the seasons and
// renovations, so a pool missing from that file gets its address geocoded
// (see autoMetaFor) instead of silently not showing up.

import './polyfill.mjs';
import * as cheerio from 'cheerio';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SOURCE = 'https://www.berlinerbaeder.de/oeffnungszeiten-auf-einem-blick/';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'data', 'pools.json');
const META = resolve(__dirname, '..', 'data', 'pools-meta.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Nominatim's usage policy: identify the app, at most one request per second.
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const GEOCODER_UA = 'berliner-baeder-map (https://github.com/ferbsx/berliner-baeder-map)';

// "Di. 09.06.26" -> "2026-06-09"
function parseGermanDate(text) {
  const m = text.match(/(\d{2})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return `20${yy}-${mm}-${dd}`;
}

function isoMinusOneDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function cleanName(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Shows up as an annotation on the workflow run when running in GitHub Actions.
const warn = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `Warning: ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function guessKind(name) {
  if (/Sommerbad/.test(name)) return 'summer';
  if (/Strandbad/.test(name)) return 'beach';
  if (/Kinderbad/.test(name)) return 'kids';
  return 'indoor';
}

// The detail page's "Standort" block reads: name<br>street<br>"10713 Berlin <district>"<br>phone
async function fetchAddress(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' } });
  if (!res.ok) throw new Error(`detail page: HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const block = $('.facility_body_contact_address > div').first();
  block.find('br').replaceWith('\n');
  const lines = block.text().split('\n').map(cleanName).filter(Boolean);
  const i = lines.findIndex((l) => /^\d{5}\b/.test(l));
  if (i < 1) throw new Error('no address on detail page');
  return { street: lines[i - 1], postalcode: lines[i].slice(0, 5) };
}

// Rough bounding box of Berlin, to reject a hit somewhere else entirely.
const inBerlin = (lat, lng) => lat > 52.3 && lat < 52.7 && lng > 13.05 && lng < 13.8;

async function geocode(params) {
  const u = new URL(GEOCODER);
  u.search = new URLSearchParams({ ...params, countrycodes: 'de', format: 'jsonv2', limit: '1' });
  await sleep(1100);
  const res = await fetch(u, { headers: { 'User-Agent': GEOCODER_UA } });
  if (!res.ok) throw new Error(`geocoder: HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  return inBerlin(lat, lng) ? { lat: +lat.toFixed(6), lng: +lng.toFixed(6) } : null;
}

// Stand-in metadata for a pool that data/pools-meta.json doesn't list yet:
// its address from the detail page, geocoded, plus a category guessed from
// the name. Curated metadata always wins, so adding the pool to
// pools-meta.json pins its exact position/category (or excludes it).
async function autoMetaFor(pool) {
  const { street, postalcode } = await fetchAddress(pool.url);
  const pos =
    (await geocode({ street, postalcode, city: 'Berlin' })) ||
    (await geocode({ q: `${pool.name}, Berlin` }));
  if (!pos) throw new Error(`could not geocode "${street}, ${postalcode} Berlin"`);
  return { ...pos, kind: guessKind(pool.name), address: `${street}, ${postalcode} Berlin` };
}

async function main() {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' } });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // --- 1. Resolve the day columns from the first header row ---
  // Layout: [ "Bad" | "heute" (no printed date) | "Fr. 03.07.26" | … ].
  // The window size is NOT fixed — the site has used both 7-day and 14-day
  // windows — so derive it from the header rather than assuming a count.
  const headerRow = $('.table-row.header-row').first();
  if (!headerRow.length) throw new Error('Header row not found — page structure changed.');
  const headerCells = headerRow.children('.table-cell').toArray();
  // Drop the leading "Bad" name column; everything after it is a day column.
  const dates = headerCells.slice(1).map((c) => parseGermanDate($(c).text()));
  // The first day column is "heute" with no printed date — derive it from day 2.
  if (!dates[0] && dates[1]) dates[0] = isoMinusOneDay(dates[1]);
  if (dates.length < 2 || dates.some((d) => !d)) {
    throw new Error(`Unexpected date columns (${dates.length}): ${JSON.stringify(dates)}`);
  }

  // --- 2. Parse every pool row, dedupe by slug ---
  const bySlug = new Map();
  $('.table-row').each((_, row) => {
    const $row = $(row);
    if ($row.hasClass('header-row')) return;
    const link = $row.find('.sticky-col a[href*="/baeder/detail/"]').first();
    if (!link.length) return;
    const href = link.attr('href') || '';
    const slugMatch = href.match(/\/baeder\/detail\/([a-z0-9-]+)\//);
    if (!slugMatch) return;
    const slug = slugMatch[1];
    if (bySlug.has(slug)) return; // first occurrence (Alle Bäder table) wins

    const name = cleanName(link.text());
    const url = href.startsWith('http') ? href : `https://www.berlinerbaeder.de${href}`;

    // Day cells = all .table-cell after the sticky name cell
    const dayCells = $row.children('.table-cell').toArray().slice(1);
    const days = dates.map((date, i) => {
      const cell = dayCells[i];
      const periods = [];
      if (cell) {
        $(cell)
          .find('.period')
          .each((__, p) => {
            const times = $(p)
              .find('span')
              .toArray()
              .map((s) => $(s).text().trim())
              .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
            if (times.length >= 2) periods.push({ open: times[0], close: times[1] });
          });
      }
      return { date, periods }; // periods=[] means closed that day
    });

    bySlug.set(slug, { slug, name, url, days });
  });

  const pools = [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (!pools.length) throw new Error('No pools parsed — page structure changed.');

  // --- 3. Place pools that data/pools-meta.json doesn't know yet ---
  // Geocoded positions are carried over from the previous scrape, so each new
  // pool costs one lookup, not one every 30 minutes.
  const known = new Set(JSON.parse(await readFile(META, 'utf-8')).map((m) => m.slug));
  const previous = await readJsonIfExists(OUT);
  const previousAuto = new Map((previous?.pools || []).map((p) => [p.slug, p.autoMeta]));
  const unknown = pools.filter((p) => !known.has(p.slug));
  for (const pool of unknown) {
    pool.autoMeta = previousAuto.get(pool.slug);
    if (pool.autoMeta) continue;
    try {
      pool.autoMeta = await autoMetaFor(pool);
    } catch (err) {
      warn(`${pool.name}: ${err.message} — it won't show on the map`);
    }
  }
  const placed = unknown.filter((p) => p.autoMeta);
  if (placed.length) {
    warn(
      `Not in data/pools-meta.json, placed by geocoding its address: ` +
        placed.map((p) => p.name).join(', ')
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    timezone: 'Europe/Berlin',
    dates,
    poolCount: pools.length,
    pools,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  const openToday = pools.filter((p) => p.days[0].periods.length).length;
  console.log(
    `Wrote ${pools.length} pools to ${OUT}\n` +
      `Window: ${dates[0]} … ${dates[dates.length - 1]} (${dates.length} days) | open today: ${openToday}`
  );
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
