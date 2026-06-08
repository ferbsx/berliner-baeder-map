import { loadPools } from './data.js';
import {
  initMap,
  renderPools,
  setOrigin,
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
  mode: 'now', // 'now' | 'plan'
  planDate: null,
  planTime: '14:00',
  shown: [], // pools currently displayed (open at target time)
  token: 0, // bumped to cancel stale transit batches
  cards: new Map(), // slug → card element
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

function googleTransitUrl(pool) {
  const dest = `${pool.lat},${pool.lng}`;
  const base = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=transit`;
  return state.origin ? `${base}&origin=${state.origin.lat},${state.origin.lng}` : base;
}

function travelBadge(pool) {
  const t = pool.travel;
  if (!state.origin) return '<span class="badge badge--none">Start wählen</span>';
  if (!t) return '<span class="badge badge--loading">…</span>';
  if (t.error || t.durationMin == null)
    return '<span class="badge badge--none">keine Route</span>';
  return `<span class="badge badge--time">🚆 ${t.durationMin} min</span>`;
}

function linesText(pool) {
  const t = pool.travel;
  if (!t || !t.ridden || !t.ridden.length) return '';
  return t.ridden.map((r) => r.name).join(' › ');
}

// ---------- rendering ----------
function cardHtml(pool) {
  const k = kindOf(pool.kind);
  const s = pool.status;
  const left = s.minutesLeft != null ? ` <span class="left">(noch ${humanDuration(s.minutesLeft)})</span>` : '';
  const lines = linesText(pool);
  return `
    <div class="pool-card__top">
      <div class="pool-card__name">
        <span class="kind-dot" style="background:${k.color}"></span>${pool.name}
      </div>
      ${travelBadge(pool)}
    </div>
    <div class="pool-card__hours">Geöffnet bis ${s.until}${left}</div>
    <div class="pool-card__meta">${k.label}${lines ? ' · ' + lines : ''}</div>
    <div class="pool-card__links">
      <a href="${pool.url}" target="_blank" rel="noopener">Offizielle Seite ↗</a>
      <a href="${googleTransitUrl(pool)}" target="_blank" rel="noopener">Route (ÖPNV) ↗</a>
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
      const travelLine =
        state.origin && t && t.durationMin != null
          ? `<div class="popup__row">🚆 ${t.durationMin} min mit ÖPNV${
              linesText(pool) ? ` · ${linesText(pool)}` : ''
            }</div>`
          : '';
      return `
        <div class="popup__name">${pool.name}</div>
        <div class="popup__row">Geöffnet bis <b>${s.until}</b>${
        s.minutesLeft != null ? ` (noch ${humanDuration(s.minutesLeft)})` : ''
      }</div>
        ${travelLine}
        <div class="popup__links">
          <a href="${pool.url}" target="_blank" rel="noopener">Seite ↗</a>
          <a href="${googleTransitUrl(pool)}" target="_blank" rel="noopener">Route ↗</a>
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
      const ta = a.travel && a.travel.durationMin != null ? a.travel.durationMin : Infinity;
      const tb = b.travel && b.travel.durationMin != null ? b.travel.durationMin : Infinity;
      if (ta !== tb) return ta - tb;
    }
    if (state.origin && a.dist != null && b.dist != null) return a.dist - b.dist;
    return a.name.localeCompare(b.name, 'de');
  });
}

function setSortNote(byTravel) {
  $('results-sort').textContent = state.origin
    ? byTravel
      ? 'nach Fahrzeit'
      : 'nach Entfernung'
    : '';
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
  fitTo(state.shown, state.origin);

  // 2. transit times (only when we know where the user starts)
  if (!state.origin || !open.length) return;

  const tasks = open.map((pool) => () => planJourney(state.origin, pool, departureISO));
  await runPool(tasks, (i, value) => {
    if (myToken !== state.token) return; // stale batch — ignore
    const pool = open[i];
    pool.travel = value instanceof Error ? { error: true } : value || { error: true };
    refreshCard(pool);
  });

  if (myToken !== state.token) return;
  // 3. final re-sort by fastest journey + re-render (markers get rank numbers)
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
  await recompute(); // renders open-now list immediately (no travel times yet)
  useGeolocation(); // then try to locate the user → fills in travel times
  setTimeout(invalidateSize, 200); // ensure map sizes correctly after layout
}

main();
