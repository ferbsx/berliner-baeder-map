// Leaflet map with a public-transport-focused base layer (ÖPNVKarte / memomaps,
// which renders all train, tram and bus lines) plus a standard OSM fallback.
import { BERLIN_CENTER, BERLIN_ZOOM, kindOf } from './config.js';

let map;
let markerLayer;
const markers = new Map(); // slug → L.marker
let originMarker;

export function initMap() {
  const opnv = L.tileLayer('https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution:
      'Nahverkehr © <a href="https://memomaps.de/">memomaps.de</a> (CC-BY-SA) · ' +
      'Daten © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  });

  map = L.map('map', { layers: [opnv], zoomControl: true }).setView(
    BERLIN_CENTER,
    BERLIN_ZOOM
  );
  L.control.layers({ 'Nahverkehr (ÖPNV)': opnv, 'Standard (OSM)': osm }, {}, {
    position: 'topright',
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  return map;
}

function poolIcon(kind, rank) {
  const { color, icon } = kindOf(kind);
  const inner = rank != null ? `<span class="pin--rank">${rank}</span>` : `<span>${icon}</span>`;
  return L.divIcon({
    className: '',
    html: `<div class="pin" style="background:${color}">${inner}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24],
  });
}

// Render markers for the given pools. popupHtml(pool) builds popup content;
// onSelect(slug) fires when a marker is clicked.
export function renderPools(pools, popupHtml, onSelect) {
  markerLayer.clearLayers();
  markers.clear();
  pools.forEach((pool, i) => {
    const rank = pool.travel && pool.travel.durationMin != null ? i + 1 : null;
    const m = L.marker([pool.lat, pool.lng], {
      icon: poolIcon(pool.kind, rank),
      title: pool.name,
    });
    m.bindPopup(() => popupHtml(pool), { maxWidth: 260 });
    m.on('click', () => onSelect && onSelect(pool.slug));
    m.addTo(markerLayer);
    markers.set(pool.slug, m);
  });
}

export function setOrigin(lat, lng, label) {
  if (originMarker) map.removeLayer(originMarker);
  originMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: '', html: '<div class="origin-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    title: label || 'Start',
    zIndexOffset: 1000,
  }).addTo(map);
  originMarker.bindPopup(`<b>Start:</b> ${label || 'gewählter Ort'}`);
}

// Fit the view to origin + all pool markers.
export function fitTo(pools, origin) {
  const pts = pools.map((p) => [p.lat, p.lng]);
  if (origin) pts.push([origin.lat, origin.lng]);
  if (!pts.length) return;
  if (pts.length === 1) {
    map.setView(pts[0], 13);
  } else {
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  }
}

export function focusPool(slug) {
  const m = markers.get(slug);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
  m.openPopup();
}

export const invalidateSize = () => map && map.invalidateSize();
