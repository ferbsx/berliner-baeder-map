// Loads the scraped opening hours (data/pools.json, refreshed by CI every
// 30 min) and merges them with the static metadata (coords, official URL,
// category, exclusions). Excluded pools — those with separate/extra entrance
// pricing, e.g. Strandbad Halensee — are dropped here and never surface.

export async function loadPools() {
  const [hoursRes, metaRes] = await Promise.all([
    // no-store so we always pick up the freshest committed scrape, not a CDN copy
    fetch('data/pools.json', { cache: 'no-store' }),
    fetch('data/pools-meta.json', { cache: 'no-store' }),
  ]);
  if (!hoursRes.ok) throw new Error(`pools.json: HTTP ${hoursRes.status}`);
  if (!metaRes.ok) throw new Error(`pools-meta.json: HTTP ${metaRes.status}`);

  const hours = await hoursRes.json();
  const meta = await metaRes.json();
  const metaBySlug = new Map(meta.map((m) => [m.slug, m]));

  const pools = [];
  for (const p of hours.pools) {
    const m = metaBySlug.get(p.slug);
    if (!m) continue; // unknown pool / no coordinates
    if (m.excluded) continue; // separate pricing → never shown
    if (m.lat == null || m.lng == null) continue;
    pools.push({
      slug: p.slug,
      name: p.name,
      url: m.url || p.url,
      lat: m.lat,
      lng: m.lng,
      kind: m.kind || 'indoor',
      days: p.days,
    });
  }

  return {
    generatedAt: hours.generatedAt,
    dates: hours.dates, // rolling window starting today (length varies: 7 or 14 days)
    pools,
  };
}
