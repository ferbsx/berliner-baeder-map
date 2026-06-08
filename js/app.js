import { loadPools } from './data.js';
import {
  initMap,
  renderPools,
  setOrigin,
  setDestination,
  clearDestination,
  fitTo,
  focusPool,
  invalidateSize,
} from './map.js';
import { berlinNow, statusAt, humanDuration, dateLabel, berlinWallClockToISO } from './time.js';
import { geocode, planJourney, runPool } from './transit.js';
import { kindOf } from './config.js';

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  origin: null, // {lat, lng, label}
  destination: null, // {lat, lng, label} | null — optional "where to next"
  mode: 'now', // 'now' | 'plan'
  planDate: null,
  planTime: '14:00',
  shown: [], // pools currently displayed (open at target time)
  token: 0, // bumped to cancel stale transit batches
  cards: new Map(), // slug → card element
};

const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

// ---------- helpers ----------
function haversine(a, b) {
  const R = 6371,
    rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat),
    dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function target() {
  if (state.mode === 'plan') {
    const ymd = state.planDate || state.data.dates[0];
    const [h, m] = state.planTime.split(':').map(Number);
    return { ymd, minutes: h * 60 + m, departureISO: berlinWallClockToISO(ymd, state.planTime) };
  }
  const n = berlinNow();
  return { ymd: n.ymd, minutes: n.minutes, departureISO: undefined };
}

// Google Maps directions deep link. from/to = {lat,lng}; null `from` = device location.
function gmapsDir(from, to, mode = 'transit') {
  let u = `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=${mode}`;
  if (from) u += `&origin=${from.lat},${from.lng}`;
  return u;
}

const linesOf = (leg) =>
  leg && leg.ridden && leg.ridden.length ? leg.ridden.map((r) => r.name).join(' › ') : '';
const legIcon = (leg) => (leg && leg.walkOnly ? '🚶' : '🚆');
const fmtDist = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

// Badge shows total trip time: start→pool (→destination if set). Walk-only trips
// get a 🚶 instead of 🚆 (so a pool right next door reads as a short walk, not "keine Route").
function travelBadge(pool) {
  const t = pool.travel;
  if (!state.origin) return '<span class="badge badge--none">Start wählen</span>';
  if (!t) return '<span class="badge badge--loading">…</span>';
  if (t.total == null) return '<span class="badge badge--none">keine Route</span>';
  const walk = t.walkOnly;
  return `<span class="badge ${walk ? 'badge--walk' : 'badge--time'}">${walk ? '🚶' : '🚆'} ${t.total} min</span>`;
}

// Secondary line: category + transit lines / "zu Fuß" / per-leg breakdown.
function travelDetail(pool) {
  const k = kindOf(pool.kind);
  const t = pool.travel;
  if (!state.destination) {
    if (!t || t.legA.error) return k.label;
    if (t.legA.walkOnly) {
      const d = pool.dist != null ? ` (${fmtDist(pool.dist)})` : '';
      return `${k.label} · 🚶 zu Fuß${d}`;
    }
    const lines = linesOf(t.legA);
    return `${k.label}${lines ? ' · ' + lines : ''}`;
  }
  if (!t || t.total == null) return k.label;
  return `${k.label} · ${legIcon(t.legA)} ${t.legA.durationMin} min hin · ${legIcon(t.legB)} ${t.legB.durationMin} min weiter`;
}

// Directions links (1 link, or 2 when a destination is set). A walk-only leg
// opens Google Maps in walking mode and is labelled accordingly.
function routeLinks(pool) {
  const t = pool.travel;
  const aMode = t && t.legA && t.legA.walkOnly ? 'walking' : 'transit';
  if (!state.destination) {
    const label = aMode === 'walking' ? 'Fußweg ↗' : 'Route (ÖPNV) ↗';
    return `<a href="${gmapsDir(state.origin, pool, aMode)}" target="_blank" rel="noopener">${label}</a>`;
  }
  const bMode = t && t.legB && t.legB.walkOnly ? 'walking' : 'transit';
  return (
    `<a href="${gmapsDir(state.origin, pool, aMode)}" target="_blank" rel="noopener">→ Bad ↗</a> ` +
    `<a href="${gmapsDir(pool, state.destination, bMode)}" target="_blank" rel="noopener">→ Ziel ↗</a>`
  );
}

// ---------- rendering ----------
function cardHtml(pool) {
  const k = kindOf(pool.kind);
  const s = pool.status;
  const left = s.minutesLeft != null ? ` <span class="left">(noch ${humanDuration(s.minutesLeft)})</span>` : '';
  return `
    <div class="pool-card__top">
      <div class="pool-card__name">
        <span class="kind-dot" style="background:${k.color}"></span>${pool.name}
      </div>
      ${travelBadge(pool)}
    </div>
    <div class="pool-card__hours">Geöffnet bis ${s.until}${left}</div>
    <div class="pool-card__meta">${travelDetail(pool)}</div>
    <div class="pool-card__links">
      <a href="${pool.url}" target="_blank" rel="noopener">Offizielle Seite ↗</a>
      ${routeLinks(pool)}
    </div>`;
}

function renderList() {
  const list = $('pool-list');
  list.innerHTML = '';
  state.cards.clear();

  if (!state.shown.length) {
    const li = document.createElement('li');
    li.className = 'pool-list__empty';
    li.textContent =
      state.mode === 'plan'
        ? 'Zu diesem Zeitpunkt hat kein (regulär bepreistes) Bad geöffnet.'
        : 'Gerade hat kein Bad geöffnet.';
    list.appendChild(li);
    return;
  }

  for (const pool of state.shown) {
    const li = document.createElement('li');
    li.className = 'pool-card';
    li.dataset.slug = pool.slug;
    li.innerHTML = cardHtml(pool);
    li.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // let links work
      selectPool(pool.slug, true);
    });
    list.appendChild(li);
    state.cards.set(pool.slug, li);
  }
}

function refreshCard(pool) {
  const el = state.cards.get(pool.slug);
  if (el) el.innerHTML = cardHtml(pool);
}

function renderMarkers() {
  renderPools(
    state.shown,
    (pool) => {
      const s = pool.status;
      const t = pool.travel;
      let travelLine = '';
      if (state.origin && t && t.total != null) {
        if (state.destination) {
          travelLine =
            `<div class="popup__row">${t.walkOnly ? '🚶' : '🚆'} ${t.total} min gesamt · ` +
            `${legIcon(t.legA)} ${t.legA.durationMin} hin, ${legIcon(t.legB)} ${t.legB.durationMin} weiter</div>`;
        } else if (t.walkOnly) {
          travelLine = `<div class="popup__row">🚶 ${t.total} min zu Fuß${
            pool.dist != null ? ` (${fmtDist(pool.dist)})` : ''
          }</div>`;
        } else {
          travelLine = `<div class="popup__row">🚆 ${t.total} min mit ÖPNV${
            linesOf(t.legA) ? ` · ${linesOf(t.legA)}` : ''
          }</div>`;
        }
      }
      return `
        <div class="popup__name">${pool.name}</div>
        <div class="popup__row">Geöffnet bis <b>${s.until}</b>${
        s.minutesLeft != null ? ` (noch ${humanDuration(s.minutesLeft)})` : ''
      }</div>
        ${travelLine}
        <div class="popup__links">
          <a href="${pool.url}" target="_blank" rel="noopener">Seite ↗</a>
          ${routeLinks(pool)}
        </div>`;
    },
    (slug) => selectPool(slug, false)
  );
}

function selectPool(slug, fromList) {
  for (const [s, el] of state.cards) el.classList.toggle('is-active', s === slug);
  if (fromList) {
    focusPool(slug);
  } else {
    const el = state.cards.get(slug);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function sortShown(byTravel) {
  state.shown.sort((a, b) => {
    if (byTravel) {
      const ta = a.travel && a.travel.total != null ? a.travel.total : Infinity;
      const tb = b.travel && b.travel.total != null ? b.travel.total : Infinity;
      if (ta !== tb) return ta - tb;
    }
    if (state.origin && a.dist != null && b.dist != null) return a.dist - b.dist;
    return a.name.localeCompare(b.name, 'de');
  });
}

function setSortNote(byTravel) {
  if (!state.origin) {
    $('results-sort').textContent = '';
    return;
  }
  if (!byTravel) {
    $('results-sort').textContent = 'nach Entfernung';
    return;
  }
  $('results-sort').textContent = state.destination ? 'nach Gesamtzeit (hin + weiter)' : 'nach Fahrzeit';
}

// ---------- the main compute pass ----------
async function recompute() {
  if (!state.data) return;
  const myToken = ++state.token;
  const { ymd, minutes, departureISO } = target();

  // 1. filter to pools open at the target time
  const open = [];
  for (const p of state.data.pools) {
    const day = p.days.find((d) => d.date === ymd);
    const st = statusAt(day, minutes);
    if (st.open) {
      const dist = state.origin ? haversine(state.origin, p) : null;
      open.push({ ...p, status: st, dist, travel: null });
    }
  }
  state.shown = open;
  sortShown(false);

  $('results-count').textContent =
    open.length === 1 ? '1 Bad geöffnet' : `${open.length} Bäder geöffnet`;
  setSortNote(false);
  renderList();
  renderMarkers();
  fitTo(state.shown, state.origin, state.destination);

  // 2. transit times (only when we know where the user starts)
  if (!state.origin || !open.length) return;
  const dest = state.destination;

  // Each pool: leg A = start→pool, plus leg B = pool→destination when one is set.
  // Both legs use the same base departure time (an approximation — we don't model
  // how long you swim — but it's what makes a pool "well-connected to both").
  const tasks = open.map((pool) => async () => {
    const a = await safe(() => planJourney(state.origin, pool, departureISO));
    const b = dest ? await safe(() => planJourney(pool, dest, departureISO)) : undefined;
    return { a, b };
  });

  await runPool(tasks, (i, value) => {
    if (myToken !== state.token) return; // stale batch — ignore
    const pool = open[i];
    const r = value instanceof Error ? {} : value || {};
    const mkLeg = (x) =>
      x ? { durationMin: x.durationMin, ridden: x.ridden, walkOnly: !!x.walkOnly } : { error: true };
    const legA = mkLeg(r.a);
    let legB = null;
    let total = null;
    let walkOnly = false;
    if (dest) {
      legB = mkLeg(r.b);
      total =
        legA.durationMin != null && legB.durationMin != null
          ? legA.durationMin + legB.durationMin
          : null;
      walkOnly = !!legA.walkOnly && !!legB.walkOnly;
    } else {
      total = legA.durationMin != null ? legA.durationMin : null;
      walkOnly = !!legA.walkOnly;
    }
    pool.travel = { legA, legB, total, walkOnly };
    refreshCard(pool);
  });

  if (myToken !== state.token) return;
  // 3. final re-sort by fastest total trip + re-render (markers get rank numbers)
  sortShown(true);
  setSortNote(true);
  renderList();
  renderMarkers();
}

// ---------- origin handling ----------
function setOriginState(lat, lng, label, statusClass = 'is-set') {
  state.origin = { lat, lng, label };
  const el = $('origin-status');
  el.textContent = label;
  el.className = 'origin-status ' + statusClass;
  setOrigin(lat, lng, label);
  updateFavButtons();
  recompute();
}

function useGeolocation() {
  const el = $('origin-status');
  if (!navigator.geolocation) {
    el.textContent = 'Standort nicht verfügbar – Adresse eingeben.';
    el.className = 'origin-status is-error';
    return;
  }
  el.textContent = 'Standort wird ermittelt…';
  el.className = 'origin-status';
  navigator.geolocation.getCurrentPosition(
    (pos) => setOriginState(pos.coords.latitude, pos.coords.longitude, '📍 Mein Standort'),
    () => {
      el.textContent = 'Kein Standort – bitte Adresse eingeben.';
      el.className = 'origin-status is-error';
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

async function geocodeInput() {
  const q = $('origin-input').value.trim();
  if (!q) return;
  const el = $('origin-status');
  el.textContent = 'Suche Ort…';
  el.className = 'origin-status';
  try {
    const r = await geocode(q);
    if (r) setOriginState(r.lat, r.lng, r.label);
    else {
      el.textContent = 'Ort nicht gefunden.';
      el.className = 'origin-status is-error';
    }
  } catch {
    el.textContent = 'Suche fehlgeschlagen.';
    el.className = 'origin-status is-error';
  }
}

// ---------- destination handling ----------
function setDestinationState(lat, lng, label) {
  state.destination = { lat, lng, label };
  const el = $('dest-status');
  el.textContent = '🏁 ' + label;
  el.className = 'origin-status is-set';
  $('dest-clear').hidden = false;
  setDestination(lat, lng, label);
  updateFavButtons();
  recompute();
}

function clearDestinationState() {
  const had = !!state.destination;
  state.destination = null;
  $('dest-input').value = '';
  const el = $('dest-status');
  el.textContent = '';
  el.className = 'origin-status';
  $('dest-clear').hidden = true;
  clearDestination();
  updateFavButtons();
  if (had) recompute();
}

async function geocodeDest() {
  const q = $('dest-input').value.trim();
  if (!q) {
    clearDestinationState();
    return;
  }
  const el = $('dest-status');
  el.textContent = 'Suche Ort…';
  el.className = 'origin-status';
  try {
    const r = await geocode(q);
    if (r) setDestinationState(r.lat, r.lng, r.label);
    else {
      el.textContent = 'Ort nicht gefunden.';
      el.className = 'origin-status is-error';
    }
  } catch {
    el.textContent = 'Suche fehlgeschlagen.';
    el.className = 'origin-status is-error';
  }
}

// ---------- favourites (persisted in localStorage) ----------
const FAVS_KEY = 'baeder.favs.v1';
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAVS_KEY)) || [];
  } catch {
    return [];
  }
}
function storeFavs(list) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (e.g. private mode) — favourites just won't persist */
  }
}
function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}
function sameSpot(a, b) {
  return a && b && Math.abs(a.lat - b.lat) < 3e-4 && Math.abs(a.lng - b.lng) < 3e-4;
}

function applyFav(fav, which) {
  if (which === 'dest') {
    $('dest-input').value = fav.name;
    setDestinationState(fav.lat, fav.lng, fav.name);
  } else {
    $('origin-input').value = fav.name;
    setOriginState(fav.lat, fav.lng, fav.name);
  }
}

function addFav(which) {
  const loc = which === 'dest' ? state.destination : state.origin;
  if (!loc) {
    const el = $(which === 'dest' ? 'dest-status' : 'origin-status');
    el.textContent = which === 'dest' ? 'Erst ein Ziel wählen.' : 'Erst einen Start wählen.';
    el.className = 'origin-status is-error';
    return;
  }
  const suggested = (loc.label || '').replace(/^🏁\s*/, '');
  const name = (window.prompt('Name für diesen Favoriten:', suggested) || '').trim();
  if (!name) return;
  const favs = loadFavs();
  favs.push({ id: newId(), name, lat: loc.lat, lng: loc.lng });
  storeFavs(favs);
  renderFavs();
}

function deleteFav(id) {
  storeFavs(loadFavs().filter((f) => f.id !== id));
  renderFavs();
}

function renderFavs() {
  const favs = loadFavs();
  $('favs-field').hidden = favs.length === 0;
  const ul = $('favs');
  ul.innerHTML = '';
  for (const f of favs) {
    const li = document.createElement('li');
    li.className = 'favs__row';
    li.innerHTML =
      `<span class="favs__name" title="${esc(f.name)}">${esc(f.name)}</span>` +
      `<button data-act="start" data-id="${f.id}">Start</button>` +
      `<button data-act="dest" data-id="${f.id}">Ziel</button>` +
      `<button data-act="del" data-id="${f.id}" class="favs__del" title="Favorit löschen">✕</button>`;
    ul.appendChild(li);
  }
  updateFavButtons();
}

function updateFavButtons() {
  const favs = loadFavs();
  $('origin-fav').classList.toggle('is-set', favs.some((f) => sameSpot(f, state.origin)));
  $('dest-fav').classList.toggle('is-set', favs.some((f) => sameSpot(f, state.destination)));
}

// ---------- controls wiring ----------
function setupControls() {
  $('locate-btn').addEventListener('click', useGeolocation);
  $('origin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      geocodeInput();
    }
  });
  $('origin-input').addEventListener('change', geocodeInput);

  $('dest-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      geocodeDest();
    }
  });
  $('dest-input').addEventListener('change', geocodeDest);
  $('dest-clear').addEventListener('click', clearDestinationState);

  $('origin-fav').addEventListener('click', () => addFav('start'));
  $('dest-fav').addEventListener('click', () => addFav('dest'));
  $('favs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'del') {
      deleteFav(id);
      return;
    }
    const fav = loadFavs().find((f) => f.id === id);
    if (fav) applyFav(fav, act);
  });

  // keep the Leaflet canvas correct on viewport changes (resize / orientation)
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(invalidateSize, 200);
  });

  const setMode = (mode) => {
    state.mode = mode;
    $('mode-now').classList.toggle('is-active', mode === 'now');
    $('mode-plan').classList.toggle('is-active', mode === 'plan');
    $('mode-now').setAttribute('aria-selected', mode === 'now');
    $('mode-plan').setAttribute('aria-selected', mode === 'plan');
    $('plan-row').hidden = mode === 'now';
    recompute();
  };
  $('mode-now').addEventListener('click', () => setMode('now'));
  $('mode-plan').addEventListener('click', () => setMode('plan'));

  $('plan-date').addEventListener('change', (e) => {
    state.planDate = e.target.value;
    recompute();
  });
  $('plan-time').addEventListener('change', (e) => {
    state.planTime = e.target.value || '14:00';
    recompute();
  });
}

function fillPlanDates() {
  const sel = $('plan-date');
  const today = berlinNow().ymd;
  sel.innerHTML = '';
  for (const d of state.data.dates) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = dateLabel(d, today);
    sel.appendChild(opt);
  }
  state.planDate = state.data.dates[0];
}

function showFreshness() {
  const t = new Date(state.data.generatedAt);
  const time = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  }).format(t);
  $('freshness').innerHTML = `Öffnungszeiten <strong>Stand ${time} Uhr</strong><br>aktualisiert alle 30 Min`;
}

// ---------- boot ----------
async function main() {
  initMap();
  setupControls();
  try {
    state.data = await loadPools();
  } catch (err) {
    $('results-count').textContent = 'Daten konnten nicht geladen werden.';
    $('origin-status').textContent = String(err.message || err);
    return;
  }
  fillPlanDates();
  showFreshness();
  renderFavs(); // show any saved favourites
  await recompute(); // renders open-now list immediately (no travel times yet)
  useGeolocation(); // then try to locate the user → fills in travel times
  setTimeout(invalidateSize, 200); // ensure map sizes correctly after layout
}

main();
