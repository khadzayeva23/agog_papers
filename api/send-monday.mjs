// ============================================================
// agog · Monday digest sender  (Vercel serverless + Cron)
// ------------------------------------------------------------
// Every Monday this fetches your APPROVED papers from Airtable,
// renders the digest email, and hands it to Buttondown.
//
// SAFETY: defaults to creating a DRAFT in Buttondown (nothing is
// sent to subscribers until you review it and click Send). Flip
// to fully automatic by setting env var  SEND_MODE = send.
//
// Vercel Environment Variables needed:
//   AIRTABLE_TOKEN      pat...   (already set)
//   AIRTABLE_BASE       app...   (already set)
//   AIRTABLE_TABLE      Papers   (already set)
//   BUTTONDOWN_API_KEY  your Buttondown API key
//   CRON_SECRET         any long random string (secures this URL)
//   SEND_MODE           draft  (default)  or  send  (auto-send)
//
// Manual use in a browser:
//   /api/send-monday?key=YOUR_CRON_SECRET&dry=1   → preview HTML, sends nothing
//   /api/send-monday?key=YOUR_CRON_SECRET         → create draft (or send if SEND_MODE=send)
// ============================================================

export default async function handler(req, res) {
  const TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE  = process.env.AIRTABLE_BASE;
  const TABLE = process.env.AIRTABLE_TABLE || 'Papers';
  const BD_KEY = process.env.BUTTONDOWN_API_KEY;
  const SECRET = process.env.CRON_SECRET;
  const SEND_MODE = (process.env.SEND_MODE || 'draft').toLowerCase();

  // ---- 1. Only you (or Vercel Cron) may trigger this ----
  const auth = req.headers.authorization || '';
  const keyParam = (req.query && req.query.key) || '';
  const authorized = SECRET
    ? (auth === `Bearer ${SECRET}` || keyParam === SECRET)
    : true; // if no secret set yet, allow (set CRON_SECRET to lock it down)
  if (!authorized) {
    res.status(401).json({ error: 'Unauthorized — pass ?key=CRON_SECRET' });
    return;
  }

  if (!TOKEN || !BASE) {
    res.status(500).json({ error: 'Missing AIRTABLE_TOKEN or AIRTABLE_BASE' });
    return;
  }

  // ---- 2. Fetch approved papers, newest week first ----
  let rows;
  try {
    const params = new URLSearchParams();
    params.set('filterByFormula', `{status} = "approved"`);
    params.append('sort[0][field]', 'week_of');
    params.append('sort[0][direction]', 'desc');
    params.set('pageSize', '50');
    const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}?${params}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) { res.status(502).json({ error: 'Airtable error', status: r.status, body: await r.text() }); return; }
    const data = await r.json();
    rows = (data.records || []).map(rec => rec.fields);
  } catch (e) {
    res.status(502).json({ error: 'Airtable fetch failed', detail: String(e) }); return;
  }

  const latestWeek = rows.reduce((m, r) => (r.week_of > (m || '') ? r.week_of : m), '');
  const papers = rows.filter(r => r.week_of === latestWeek);

  if (!papers.length) {
    res.status(200).json({ ok: false, message: 'No approved papers for the latest week — nothing to send.' });
    return;
  }

  const issue = papers[0]?.issue ?? null;
  const subject = `agog · This week in psychology${issue ? ` · Issue ${issue}` : ''}`;
  const body = renderEmailBody(papers, { week_of: latestWeek, issue });

  // ---- 3. Dry run: preview in the browser, send nothing ----
  if (req.query && req.query.dry) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(body);
    return;
  }

  if (!BD_KEY) {
    res.status(500).json({ error: 'Missing BUTTONDOWN_API_KEY' });
    return;
  }

  // ---- 4. Hand to Buttondown ----
  const status = SEND_MODE === 'send' ? 'about_to_send' : 'draft';
  try {
    const r = await fetch('https://api.buttondown.com/v1/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${BD_KEY}`,
        'Content-Type': 'application/json',
        // required once per key when auto-sending on the newest API version; harmless otherwise
        'X-Buttondown-Live-Dangerously': 'true'
      },
      body: JSON.stringify({ subject, body, status })
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(502).json({ error: 'Buttondown error', status: r.status, detail: out });
      return;
    }
    res.status(200).json({
      ok: true,
      mode: status,
      papers: papers.length,
      week_of: latestWeek,
      buttondown_id: out.id,
      note: status === 'draft'
        ? 'Draft created in Buttondown — open it, review, and click Send.'
        : 'Queued to send to all subscribers.'
    });
  } catch (e) {
    res.status(502).json({ error: 'Buttondown request failed', detail: String(e) });
  }
}

// ---- email body (HTML fragment; Buttondown wraps it + adds unsubscribe) ----
function renderEmailBody(papers, meta) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const dateStr = (() => {
    try { return new Date(meta.week_of + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }); }
    catch { return meta.week_of; }
  })();

  const ink = '#14130F', muted = '#5B574A', faint = '#8A8472', acid = '#D6FB3D', line = '#D9D4C6';
  const sans = "'Helvetica Neue', Arial, sans-serif";

  const featured = papers.slice(0, 3).map(p => `
    <tr><td style="padding:22px 0 0;">
      <div style="font:700 11px/1 ${sans}; letter-spacing:0.06em; text-transform:uppercase; color:#FFFFFF; background:${ink}; display:inline-block; padding:4px 9px;">${esc(p.field)}</div>
      <a href="${esc(p.url)}" style="display:block; margin:12px 0 0; font:700 20px/1.18 ${sans}; letter-spacing:-0.01em; color:${ink}; text-decoration:none;">${esc(p.title)}</a>
      <div style="margin:8px 0 0; font:400 12px/1.4 ${sans}; color:${faint};">${esc(p.authors)} · ${esc(p.venue)} · ${esc(p.year)}</div>
      <p style="margin:10px 0 0; font:400 14px/1.5 ${sans}; color:#2E2C25;">${esc(p.summary)}</p>
      <a href="${esc(p.url)}" style="display:inline-block; margin:12px 0 0; font:700 13px/1 ${sans}; color:${ink}; text-decoration:none; border-bottom:2px solid ${acid}; padding-bottom:2px;">Read paper &rarr;</a>
    </td></tr>
    <tr><td style="padding:20px 0 0;"><div style="border-top:1px solid ${line};"></div></td></tr>`).join('');

  const rest = papers.slice(3);
  const restBlock = rest.length ? `
    <tr><td style="padding:18px 0 0;">
      <div style="font:800 12px/1 ${sans}; letter-spacing:0.14em; text-transform:uppercase; color:${muted};">Also this week</div>
    </td></tr>
    ${rest.map(p => `
    <tr><td style="padding:14px 0 0;">
      <a href="${esc(p.url)}" style="text-decoration:none; color:${ink};">
        <span style="font:600 15px/1.35 ${sans}; color:${ink};">${esc(p.title)}</span><br>
        <span style="font:400 12px/1.4 ${sans}; color:${faint};">${esc(p.field)} · ${esc(p.authors)} · ${esc(p.venue)} · ${esc(p.year)}</span>
      </a>
    </td></tr>`).join('')}` : '';

  return `
  <div style="max-width:600px; margin:0 auto; font-family:${sans}; color:${ink};">
    <div style="font:800 12px/1 ${sans}; letter-spacing:0.14em; text-transform:uppercase; color:${muted};">This week in psychology${meta.issue ? ` · Issue ${meta.issue}` : ''} · ${esc(dateStr)}</div>
    <h1 style="margin:12px 0 0; font:800 38px/1.04 ${sans}; letter-spacing:-0.03em; color:${ink};">The mind, updated.</h1>
    <p style="margin:14px 0 0; font:400 16px/1.55 ${sans}; color:#2E2C25;">${papers.length} new peer-reviewed paper${papers.length === 1 ? '' : 's'} this week — in plain language, open access. Tap any to read the source.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${featured}
      ${restBlock}
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 8px;">
      <tr><td style="background:${acid}; border:1.5px solid ${ink};">
        <a href="https://agog.example/" style="display:inline-block; padding:13px 28px; font:700 16px/1 ${sans}; color:${ink}; text-decoration:none;">Read all ${papers.length} on agog &rarr;</a>
      </td></tr>
    </table>

    <p style="margin:26px 0 0; font:400 12px/1.5 ${sans}; color:${faint};">agog — the open-access home for the most current peer-reviewed psychology research. One email, every Monday.</p>
  </div>`;
}
