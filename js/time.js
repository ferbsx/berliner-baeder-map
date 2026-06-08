// All opening-hours logic reasons in Berlin local wall-clock time, regardless
// of the visitor's device timezone (you might be planning from abroad).
import { TZ } from './config.js';

const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

const pad = (n) => String(n).padStart(2, '0');

// Current Berlin date + minutes-since-midnight.
export function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some engines emit 24 at midnight
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + parseInt(get('minute'), 10),
  };
}

// Berlin's UTC offset (in minutes) on a given instant — handles CEST/CET.
function berlinOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  return Math.round((local - utc) / 60000);
}

// Build a UTC ISO string for a Berlin wall-clock date + time, e.g.
// ("2026-06-10", "15:00") → "2026-06-10T13:00:00.000Z" (summer, +02:00).
export function berlinWallClockToISO(ymd, hhmm) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const asUTC = Date.UTC(Y, M - 1, D, h, m);
  const offset = berlinOffsetMinutes(new Date(asUTC));
  return new Date(asUTC - offset * 60000).toISOString();
}

// Status of one pool on one day at a given minute-of-day.
// dayEntry = { date, periods: [{open, close}] }
// → { open, until?, minutesLeft?, opensAt? }
export function statusAt(dayEntry, minutes) {
  if (!dayEntry || !dayEntry.periods || dayEntry.periods.length === 0) {
    return { open: false, opensAt: null };
  }
  for (const p of dayEntry.periods) {
    const o = hm(p.open);
    const c = hm(p.close);
    if (minutes >= o && minutes < c) {
      return { open: true, until: p.close, minutesLeft: c - minutes };
    }
  }
  const next = dayEntry.periods
    .map((p) => p.open)
    .filter((op) => hm(op) > minutes)
    .sort();
  return { open: false, opensAt: next[0] || null };
}

// "2h 05m" / "45 min"
export function humanDuration(min) {
  if (min == null) return '';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${pad(min % 60)} min`;
}

// "Mo. 08.06." style label for a yyyy-mm-dd date.
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export function dateLabel(ymd, todayYmd) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const wd = WD[new Date(Date.UTC(Y, M - 1, D)).getUTCDay()];
  const base = `${wd}. ${pad(D)}.${pad(M)}.`;
  if (ymd === todayYmd) return `Heute (${base})`;
  return base;
}
