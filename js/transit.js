// Public-transport journey planning via the free, keyless, CORS-enabled
// VBB REST API (https://v6.vbb.transport.rest). All client-side.
import { VBB_BASE, JOURNEY_CONCURRENCY } from './config.js';

// Geocode a free-text start (address / stop / POI) → {lat, lng, label}.
export async function geocode(query) {
  const u = new URL(VBB_BASE + '/locations');
  u.searchParams.set('query', query);
  u.searchParams.set('results', '5');
  u.searchParams.set('fuzzy', 'true');
  u.searchParams.set('stops', 'true');
  u.searchParams.set('addresses', 'true');
  u.searchParams.set('poi', 'true');
  const res = await fetch(u);
  if (!res.ok) throw new Error(`locations: HTTP ${res.status}`);
  const list = await res.json();
  for (const item of list) {
    const loc = item.location || item;
    if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
      return { lat: loc.latitude, lng: loc.longitude, label: item.name || query };
    }
  }
  return null;
}

// Plan one journey origin → dest. departureISO optional (defaults to "now").
// → { durationMin, legs:[{mode,line,from,to}], depart, arrive } | null
export async function planJourney(origin, dest, departureISO, signal) {
  const u = new URL(VBB_BASE + '/journeys');
  u.searchParams.set('from.latitude', origin.lat);
  u.searchParams.set('from.longitude', origin.lng);
  u.searchParams.set('from.address', origin.label || 'Start');
  u.searchParams.set('to.latitude', dest.lat);
  u.searchParams.set('to.longitude', dest.lng);
  u.searchParams.set('to.address', dest.label || 'Ziel');
  u.searchParams.set('results', '1');
  u.searchParams.set('stopovers', 'false');
  u.searchParams.set('polylines', 'false');
  if (departureISO) u.searchParams.set('departure', departureISO);

  const res = await fetch(u, { signal });
  if (!res.ok) throw new Error(`journeys: HTTP ${res.status}`);
  const data = await res.json();
  const j = data.journeys && data.journeys[0];
  if (!j || !j.legs || !j.legs.length) return null;

  const legs = j.legs;
  const depart = new Date(legs[0].departure || legs[0].plannedDeparture);
  const arrive = new Date(
    legs[legs.length - 1].arrival || legs[legs.length - 1].plannedArrival
  );
  const durationMin = Math.round((arrive - depart) / 60000);

  const ridden = legs
    .filter((l) => l.line)
    .map((l) => ({ mode: l.line.mode || l.line.product, name: l.line.name }));

  return { durationMin, depart, arrive, ridden };
}

// Run a batch of async tasks with bounded concurrency; each result is delivered
// to onResult(index, value|error) as soon as it resolves, so the UI can fill in
// progressively. tasks: Array<() => Promise>.
export async function runPool(tasks, onResult, concurrency = JOURNEY_CONCURRENCY) {
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        onResult(i, await tasks[i]());
      } catch (err) {
        onResult(i, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
}
