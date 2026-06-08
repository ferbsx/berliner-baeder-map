// Shared constants.
export const VBB_BASE = 'https://v6.vbb.transport.rest';
export const TZ = 'Europe/Berlin';

// Map start view (central Berlin).
export const BERLIN_CENTER = [52.512, 13.4];
export const BERLIN_ZOOM = 11;

// How many transit journeys to request at once (VBB limit is 100 req/min).
export const JOURNEY_CONCURRENCY = 5;

// Pool category → colour + German label (used for markers and badges).
export const KIND = {
  summer: { color: '#2e9e5b', label: 'Sommerbad', icon: '☀' },
  indoor: { color: '#2563eb', label: 'Hallenbad', icon: '🏊' },
  beach: { color: '#0d9488', label: 'Strandbad', icon: '🏖' },
  kids: { color: '#d97706', label: 'Kinderbad', icon: '🧒' },
};
export const kindOf = (k) => KIND[k] || KIND.indoor;
