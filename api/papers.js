// ============================================================
// agog · "This week" papers proxy  (Vercel serverless function)
// ------------------------------------------------------------
// Deploy on Vercel and this answers GET /api/papers with the
// approved papers for the most recent week, in the SAME shape
// as papers.json — so the website renders with no other change.
//
// Your Airtable token NEVER reaches the browser: it lives only
// in this server-side function, read from an env var.
//
// Set these Environment Variables in Vercel (Project → Settings
// → Environment Variables):
//   AIRTABLE_TOKEN  = your Personal Access Token (pat...)
//   AIRTABLE_BASE   = your Base ID  (app...)
//   AIRTABLE_TABLE  = your table name (e.g. Papers)
// ============================================================

export default async function handler(req, res) {
  const TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE  = process.env.AIRTABLE_BASE;
  const TABLE = process.env.AIRTABLE_TABLE || 'Papers';

  if (!TOKEN || !BASE) {
    res.status(500).json({ error: 'Missing AIRTABLE_TOKEN or AIRTABLE_BASE env var' });
    return;
  }

  // Ask Airtable only for approved rows, newest week first.
  const params = new URLSearchParams();
  params.set('filterByFormula', `{status} = "approved"`);
  params.append('sort[0][field]', 'week_of');
  params.append('sort[0][direction]', 'desc');
  params.set('pageSize', '50');

  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}?${params}`;

  let data;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) {
      const body = await r.text();
      res.status(502).json({ error: 'Airtable error', status: r.status, body });
      return;
    }
    data = await r.json();
  } catch (e) {
    res.status(502).json({ error: 'Fetch to Airtable failed', detail: String(e) });
    return;
  }

  const rows = (data.records || []).map(rec => rec.fields);

  // Keep only the most recent week present, so the page always shows "this week".
  const latestWeek = rows.reduce((max, r) => (r.week_of > (max || '') ? r.week_of : max), '');
  const thisWeek = rows.filter(r => r.week_of === latestWeek);

  // Normalize to the website's expected shape (matches papers.json).
  const papers = thisWeek.map(f => ({
    title:    f.title,
    field:    f.field,
    authors:  f.authors,
    initials: initialsFrom(f.authors),
    venue:    f.venue,
    year:     f.year,
    url:      f.url,
    summary:  f.summary,
    cites:    f.cites ?? 0,
    read_min: f.read_min ?? 0,
    is_new:   f.is_new ?? true,
    source:   f.source || 'ai',
    status:   f.status
  }));

  // Issue number is optional; derive a simple one from the date if you don't store it.
  const issue = thisWeek[0]?.issue ?? null;

  // Cache at the edge for 5 min so you're not hammering Airtable on every visit.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(200).json({ week_of: latestWeek, issue, papers });
}

// "P. Nair, T. Vehkala" -> ["PN","TV"]  (first letter of each author's parts)
function initialsFrom(authors) {
  if (!authors) return [];
  return String(authors).split(',').slice(0, 3).map(name => {
    const letters = name.trim().split(/[\s.]+/).filter(Boolean).map(p => p[0].toUpperCase());
    return (letters[0] || '') + (letters[letters.length - 1] || '');
  });
}
