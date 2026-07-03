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

import './polyfill.mjs';
import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SOURCE = 'https://www.berlinerbaeder.de/oeffnungszeiten-auf-einem-blick/';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'data', 'pools.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
