'use strict';
/*
 * Lille Ælling – catering request page
 * Static pages + live menu proxy (Shopify) + quote endpoint (email / webhook).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const SHOP_URL = (process.env.SHOP_URL || 'https://lilleelling.no').replace(/\/$/, '');
const MENU_TTL_MS = Number(process.env.MENU_TTL_MINUTES || 10) * 60 * 1000;
const SITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'site.json'), 'utf8'));
const FALLBACK = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'fallback-menu.json'), 'utf8'));

const SMTP_ON = Boolean(process.env.SMTP_HOST);
const WEBHOOK_ON = Boolean(process.env.LEAD_WEBHOOK_URL);
const DRY_RUN = process.env.DRY_RUN === 'true';
const SEND_CUSTOMER_COPY = SMTP_ON && process.env.SEND_CUSTOMER_COPY === 'true';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

/* ---------------- helpers ---------------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', eacute: 'é', ndash: '–', mdash: '—', bull: '•', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENT ? ENT[n] : m));
}
function htmlToText(html) {
  return decode(String(html || '')
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
function cleanTitle(t) {
  return decode(t).replace(/\s*\|\s*catering\s*$/i, '').trim();
}
function unitFor(handle, title, text) {
  if (SITE.unitOverrides && SITE.unitOverrides[handle]) return SITE.unitOverrides[handle];
  if (/pakke/i.test(title)) return 'pakke';
  if (/(pr\.?|per)\s*(person|pers\b|kuvert)/i.test(text)) return 'person';
  if (/min\.?\s*\d+\s*(personer|pers)/i.test(text)) return 'person';
  return 'stk';
}
function minPersons(text) {
  const m = /min\.?\s*(\d+)\s*(personer|pers)/i.exec(text);
  return m ? Number(m[1]) : null;
}
function normalizeProduct(p, collection) {
  const text = htmlToText(p.body_html);
  const v = (p.variants || [])[0] || {};
  const img = (p.images || [])[0];
  return {
    handle: p.handle,
    title: cleanTitle(p.title),
    price: Math.round(Number(v.price || 0)),
    available: v.available !== false,
    image: img ? String(img.src).split('?')[0] : null,
    description: text,
    unit: unitFor(p.handle, p.title, text),
    min: minPersons(text),
    collection
  };
}
async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'lae-catering/2.0', accept: 'application/json' } });
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------------- menu (live from Shopify, cached) ---------------- */
let menuCache = null; // { at, data }
let menuInflight = null;

async function buildMenu() {
  const handles = [...new Set(SITE.categories.flatMap(c => c.collections || []))];
  const products = {};      // handle -> product
  const collections = {};   // collection handle -> { title, image, items: [handles] }
  await Promise.all(handles.map(async h => {
    const [list, meta] = await Promise.all([
      getJSON(`${SHOP_URL}/collections/${h}/products.json?limit=250`),
      getJSON(`${SHOP_URL}/collections/${h}.json`).catch(() => null)
    ]);
    const items = [];
    for (const p of list.products || []) {
      const n = normalizeProduct(p, h);
      if (!n.available || n.price <= 0) continue;
      if (!products[n.handle]) products[n.handle] = n;
      items.push(n.handle);
    }
    collections[h] = {
      title: meta && meta.collection ? decode(meta.collection.title) : h,
      image: meta && meta.collection && meta.collection.image ? String(meta.collection.image.src).split('?')[0] : null,
      items
    };
  }));
  const categories = SITE.categories.map(c => {
    let groups;
    if (c.handles) {
      groups = [{ title: null, items: c.handles.filter(h => products[h]) }];
    } else {
      groups = (c.collections || []).map(h => ({ title: (c.collections.length > 1 ? (SITE.collectionLabels[h] || collections[h].title) : null), items: collections[h] ? collections[h].items : [] }));
    }
    const firstColl = (c.collections || [])[0];
    const firstItem = groups.flatMap(g => g.items)[0];
    const image = c.image || (firstColl && collections[firstColl] && collections[firstColl].image) || (firstItem && products[firstItem].image) || null;
    return { id: c.id, label: c.label, image, groups: groups.filter(g => g.items.length) };
  }).filter(c => c.groups.length);
  if (Object.keys(products).length < 5) throw new Error('menu too small: ' + Object.keys(products).length);
  return { source: 'live', updatedAt: new Date().toISOString(), categories, products };
}

async function getMenu() {
  const fresh = menuCache && Date.now() - menuCache.at < MENU_TTL_MS;
  if (fresh) return menuCache.data;
  if (!menuInflight) {
    menuInflight = buildMenu()
      .then(data => { menuCache = { at: Date.now(), data }; return data; })
      .catch(err => {
        console.error('[menu] live fetch failed:', err.message);
        // keep serving the last good (or fallback) menu, retry the shop in 60 s instead of on every request
        const data = menuCache ? menuCache.data : { ...FALLBACK, source: 'fallback' };
        menuCache = { at: Date.now() - MENU_TTL_MS + 60 * 1000, data };
        return data;
      })
      .finally(() => { menuInflight = null; });
  }
  return menuInflight;
}

app.get('/api/menu', async (req, res) => {
  const data = await getMenu();
  res.set('Cache-Control', 'public, max-age=120');
  res.json(data);
});

/* ---------------- public config ---------------- */
app.get('/config.js', (req, res) => {
  const cfg = {
    gtmId: process.env.GTM_ID || '',
    pixelId: process.env.META_PIXEL_ID || '',
    consentRequired: process.env.CONSENT_REQUIRED !== 'false',
    customerCopy: SEND_CUSTOMER_COPY,
    site: {
      phone: SITE.phone, phoneDisplay: SITE.phoneDisplay, email: SITE.email, address: SITE.address,
      shopUrl: SITE.shopUrl, privacyUrl: SITE.privacyUrl, deliveryRadiusKm: SITE.deliveryRadiusKm,
      google: SITE.google, reviews: SITE.reviews, responseText: SITE.responseText
    }
  };
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .send('window.LAE_CONFIG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';');
});

/* ---------------- quote endpoint ---------------- */
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 6;
}
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

function validate(b, menu) {
  const errors = {};
  const out = {
    name: str(b.name, 120), phone: str(b.phone, 40), email: str(b.email, 160), company: str(b.company, 160),
    date: str(b.date, 10), time: str(b.time, 5), fulfil: b.fulfil === 'henting' ? 'henting' : 'levering',
    address: str(b.address, 200), postcode: str(b.postcode, 10), message: str(b.message, 2000),
    occasion: str(b.occasion, 60), source: b.source && typeof b.source === 'object' ? b.source : {}
  };
  if (out.name.length < 2) errors.name = 'Skriv inn navnet ditt.';
  if (out.phone.replace(/\D/g, '').length < 8) errors.phone = 'Skriv inn et telefonnummer med 8 siffer.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.email = 'Skriv inn en e-post som navn@domene.no.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) errors.date = 'Velg en dato.';
  else {
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Oslo' })); today.setHours(0, 0, 0, 0);
    if (new Date(out.date + 'T00:00:00') < today) errors.date = 'Velg en dato fra i dag og fremover.';
  }
  if (!/^\d{2}:\d{2}$/.test(out.time)) errors.time = 'Velg et klokkeslett.';
  if (out.fulfil === 'levering') {
    if (out.address.length < 3) errors.address = 'Skriv inn leveringsadressen.';
    if (!/^\d{4}$/.test(out.postcode)) errors.postcode = 'Skriv inn et postnummer med 4 siffer.';
  }
  // Re-price items from the server-side menu – never trust client prices.
  const items = [];
  for (const it of Array.isArray(b.items) ? b.items.slice(0, 60) : []) {
    const p = menu.products[it && it.handle];
    const qty = Math.floor(Number(it && it.qty));
    if (!p || !(qty > 0) || qty > 2000) continue;
    items.push({ handle: p.handle, title: p.title, unit: p.unit, price: p.price, qty, line: p.price * qty });
  }
  if (!items.length && out.message.length < 5) errors.items = 'Velg minst én meny, eller beskriv hva du ønsker.';
  out.items = items;
  out.estimate = items.reduce((s, i) => s + i.line, 0);
  return { errors, data: out };
}

const nok = n => new Intl.NumberFormat('nb-NO').format(n) + ' kr';
const UNIT = { person: 'pers.', pakke: 'pakker', stk: 'stk.' };
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dateNo(iso) {
  try { return new Date(iso + 'T12:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch { return iso; }
}

function leadEmail(q, id) {
  const rows = q.items.map(i => `<tr><td style="padding:6px 12px 6px 0">${esc(i.title)}</td><td style="padding:6px 12px 6px 0">${i.qty} ${UNIT[i.unit]} × ${nok(i.price)}</td><td style="padding:6px 0;text-align:right">${nok(i.line)}</td></tr>`).join('');
  const where = q.fulfil === 'henting' ? 'Henting på Losjeplassen 2' : `Levering: ${esc(q.address)}, ${esc(q.postcode)}`;
  const src = Object.entries(q.source || {}).filter(([, v]) => v).map(([k, v]) => `${esc(k)}=${esc(String(v).slice(0, 120))}`).join(', ');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#221D19;line-height:1.5">
<h2 style="margin:0 0 12px">Ny catering-forespørsel ${esc(id)}</h2>
<p><b>${esc(q.name)}</b>${q.company ? ' (' + esc(q.company) + ')' : ''}<br>Telefon: <a href="tel:${esc(q.phone)}">${esc(q.phone)}</a><br>E-post: ${esc(q.email)}</p>
<p><b>Dato:</b> ${esc(dateNo(q.date))} kl. ${esc(q.time)}<br><b>${where}</b></p>
${q.items.length ? `<table style="border-collapse:collapse;margin:12px 0">${rows}<tr><td colspan="2" style="padding:10px 12px 0 0;border-top:1px solid #ddd"><b>Estimert pris inkl. mva.</b></td><td style="padding:10px 0 0;border-top:1px solid #ddd;text-align:right"><b>${nok(q.estimate)}</b></td></tr></table>` : '<p>Ingen menyer valgt – se melding.</p>'}
${q.message ? `<p><b>Allergier og ønsker:</b><br>${esc(q.message).replace(/\n/g, '<br>')}</p>` : ''}
${src ? `<p style="color:#6B6158;font-size:13px">Kilde: ${src}</p>` : ''}
</div>`;
  const text = [
    `Ny catering-forespørsel ${id}`, '', `${q.name}${q.company ? ' (' + q.company + ')' : ''}`, `Telefon: ${q.phone}`, `E-post: ${q.email}`, '',
    `Dato: ${dateNo(q.date)} kl. ${q.time}`, q.fulfil === 'henting' ? 'Henting på Losjeplassen 2' : `Levering: ${q.address}, ${q.postcode}`, '',
    ...q.items.map(i => `- ${i.title}: ${i.qty} ${UNIT[i.unit]} × ${nok(i.price)} = ${nok(i.line)}`),
    q.items.length ? `Estimert pris inkl. mva.: ${nok(q.estimate)}` : 'Ingen menyer valgt.', '',
    q.message ? `Allergier og ønsker:\n${q.message}` : '', src ? `Kilde: ${src}` : ''
  ].join('\n');
  return { html, text };
}
function customerEmail(q) {
  const lines = q.items.map(i => `- ${i.title}: ${i.qty} ${UNIT[i.unit]}`).join('\n');
  return [
    `Hei ${q.name.split(' ')[0]},`, '',
    'Takk for forespørselen til Lille Ælling. Vi ringer deg for å bekrefte meny, pris og levering.', '',
    `Dato: ${dateNo(q.date)} kl. ${q.time}`,
    q.fulfil === 'henting' ? 'Henting på Losjeplassen 2, 3015 Drammen' : `Levering til: ${q.address}, ${q.postcode}`, '',
    lines, q.items.length ? `Estimert pris inkl. mva.: ${nok(q.estimate)} (endelig pris bekreftes på telefon)` : '', '',
    q.message ? `Dine ønsker:\n${q.message}\n` : '',
    'Ingen betaling før bestillingen er bekreftet.', '',
    `Lille Ælling, ${SITE.address}`, `Telefon ${SITE.phoneDisplay}, ${SITE.email}`
  ].join('\n');
}

let transporter = null;
function mailer() {
  if (!SMTP_ON) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

app.post('/api/quote', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true, id: 'LAE-0' }); // honeypot: pretend success
  if (rateLimited(req.ip)) return res.status(429).json({ ok: false, message: `For mange forsøk. Ring oss på ${SITE.phoneDisplay}.` });
  if (!SMTP_ON && !WEBHOOK_ON && !DRY_RUN) {
    console.error('[quote] REJECTED: no delivery channel configured (set SMTP_HOST or LEAD_WEBHOOK_URL)');
    return res.status(503).json({ ok: false, message: `Skjemaet er midlertidig utilgjengelig. Ring oss på ${SITE.phoneDisplay}.` });
  }
  const menu = await getMenu();
  const { errors, data: q } = validate(b, menu);
  if (Object.keys(errors).length) return res.status(422).json({ ok: false, errors });
  const id = 'LAE-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  const delivered = [];
  const failures = [];
  try {
    const t = mailer();
    if (t) {
      const { html, text } = leadEmail(q, id);
      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      await t.sendMail({ from, to: process.env.LEAD_TO || SITE.email, replyTo: q.email, subject: `Catering-forespørsel ${dateNo(q.date)}: ${q.name}${q.items.length ? ', ' + nok(q.estimate) : ''}`, html, text });
      delivered.push('email');
      if (SEND_CUSTOMER_COPY) {
        await t.sendMail({ from, to: q.email, replyTo: process.env.LEAD_TO || SITE.email, subject: 'Vi har mottatt forespørselen din – Lille Ælling', text: customerEmail(q) })
          .catch(e => console.error('[quote] customer copy failed:', e.message));
      }
    }
  } catch (e) { failures.push('email: ' + e.message); }
  try {
    if (WEBHOOK_ON) {
      const r = await fetch(process.env.LEAD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, createdAt: new Date().toISOString(), ...q }) });
      if (!r.ok) throw new Error('status ' + r.status);
      delivered.push('webhook');
    }
  } catch (e) { failures.push('webhook: ' + e.message); }
  console.log('[quote]', JSON.stringify({ id, delivered, failures, items: q.items.length, estimate: q.estimate, date: q.date, dryRun: DRY_RUN }));
  if (!delivered.length && !DRY_RUN) {
    return res.status(502).json({ ok: false, message: `Vi fikk ikke sendt forespørselen. Ring oss på ${SITE.phoneDisplay}, så hjelper vi deg.` });
  }
  res.json({ ok: true, id, estimate: q.estimate, items: q.items });
});

app.get('/healthz', (req, res) => res.json({ ok: true, smtp: SMTP_ON, webhook: WEBHOOK_ON, dryRun: DRY_RUN, menu: menuCache ? menuCache.data.source : 'not-loaded' }));

/* ---------------- static ---------------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], setHeaders(res, p) { res.set('Cache-Control', /\.(html|css|js)$/.test(p) ? 'no-cache' : 'public, max-age=86400'); } }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`[lae] listening on ${PORT} | smtp=${SMTP_ON} webhook=${WEBHOOK_ON} dryRun=${DRY_RUN}`);
  if (!SMTP_ON && !WEBHOOK_ON && !DRY_RUN) console.error('[lae] WARNING: no lead delivery configured – /api/quote will return 503');
  getMenu().then(m => console.log('[menu] loaded from', m.source));
});
