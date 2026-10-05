'use strict';
/* End-to-end smoke test: mock Shopify + mock webhook + local SMTP sink, then exercise the app. Run: npm test */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { SMTPServer } = require('smtp-server');

const site = require('../data/site.json');
const fallback = require('../data/fallback-menu.json');

// Build a fake Shopify catalogue in the real products.json shape, from the fallback data.
const byColl = {};
for (const p of Object.values(fallback.products)) {
  (byColl[p.collection] = byColl[p.collection] || []).push({
    handle: p.handle, title: p.title,
    body_html: '<p>' + (p.description || '').replace(/&/g, '&amp;') + '</p>',
    variants: [{ price: p.price.toFixed(2), available: true }],
    images: p.image ? [{ src: p.image + '?v=1' }] : []
  });
}
byColl['tilllegg'] = [{ handle: 'ekstra-snitte', title: 'Ekstra snitte | Catering', body_html: '<ul><li>En snitte</li></ul>', variants: [{ price: '35.00', available: true }], images: [] },
  { handle: 'utsolgt', title: 'Utsolgt vare', body_html: '', variants: [{ price: '10.00', available: false }], images: [] }];
byColl['varm-drikke-catering'] = [{ handle: 'kaffe-5l', title: 'Kaffe &amp; te – 5L', body_html: 'Kaffe med kaffefl&oslash;te', variants: [{ price: '399.00', available: true }], images: [] }];

const webhookHits = [];
const shop = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/hook') { let b = ''; req.on('data', c => b += c); req.on('end', () => { webhookHits.push(JSON.parse(b)); res.end('ok'); }); return; }
  const m = /^\/collections\/([^/.?]+)(\/products)?\.json/.exec(req.url);
  if (!m) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', 'application/json');
  if (m[2]) return res.end(JSON.stringify({ products: byColl[m[1]] || [] }));
  return res.end(JSON.stringify({ collection: { title: m[1], image: null } }));
});

const mails = [];
const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, session, cb) { let d = ''; stream.on('data', c => d += c); stream.on('end', () => { mails.push({ to: session.envelope.rcptTo.map(r => r.address), raw: d }); cb(); }); } });

function startApp(port, env) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  p.getLog = () => log;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('app did not start:\n' + log)), 8000);
    p.stdout.on('data', () => { if (/listening/.test(log)) { clearTimeout(t); setTimeout(() => resolve(p), 300); } });
  });
}
const j = (port, p, opt) => fetch(`http://127.0.0.1:${port}${p}`, opt).then(async r => ({ status: r.status, body: await r.json() }));
const post = (port, body) => j(port, '/api/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const future = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);
const good = { name: 'Kari Nordmann', phone: '+47 900 00 000', email: 'kari@example.no', date: future, time: '18:00', fulfil: 'levering', address: 'Bragernes torg 1', postcode: '3017', message: '3 glutenfrie', items: [{ handle: 'tradisjonell-julebuffet', qty: 30, price: 1 }, { handle: 'riskrem-med-rod-saus-tillegg-til-buffet', qty: 30 }, { handle: 'finnes-ikke', qty: 2 }], source: { utm_source: 'facebook' } };

(async () => {
  let pass = 0; const ok = (m) => { pass++; console.log('  ✓ ' + m); };
  await new Promise(r => shop.listen(4001, r));
  await new Promise(r => smtp.listen(4025, r));

  console.log('A) live menu + SMTP + webhook');
  const a = await startApp(4100, { SHOP_URL: 'http://127.0.0.1:4001', SMTP_HOST: '127.0.0.1', SMTP_PORT: '4025', SMTP_SECURE: 'false', SMTP_FROM: 'web@lilleelling.no', LEAD_TO: 'post@lilleelling.no', SEND_CUSTOMER_COPY: 'true', LEAD_WEBHOOK_URL: 'http://127.0.0.1:4001/hook' });
  try {
    const m = await j(4100, '/api/menu');
    assert.strictEqual(m.body.source, 'live'); ok('menu source = live');
    assert.strictEqual(m.body.categories.length, 9); ok('9 categories');
    assert.deepStrictEqual(m.body.categories[0].groups[0].items, site.categories[0].handles); ok('Populære = 5 configured handles in order');
    const P = m.body.products;
    assert.strictEqual(P['tradisjonell-julebuffet'].unit, 'person'); assert.strictEqual(P['tradisjonell-julebuffet'].min, 10); ok('julebuffet unit=person, min=10 parsed from text');
    assert.strictEqual(P['5-snitter'].unit, 'pakke'); ok('snitterpakke unit=pakke');
    assert.strictEqual(P['ekstra-snitte'].title, 'Ekstra snitte'); ok('" | Catering" suffix stripped');
    assert.ok(!P['utsolgt']); ok('sold-out product hidden');
    assert.strictEqual(P['kaffe-5l'].title, 'Kaffe & te – 5L'); assert.ok(/kaffefløte/.test(P['kaffe-5l'].description)); ok('HTML entities decoded');
    const drikke = m.body.categories.find(c => c.id === 'drikke');
    assert.deepStrictEqual(drikke.groups.map(g => g.title), ['Varm drikke', 'Kald drikke', 'Tillegg']); ok('multi-collection category has group titles');
    const cfg = await fetch('http://127.0.0.1:4100/config.js').then(r => r.text());
    assert.ok(/customerCopy":true/.test(cfg)); ok('/config.js served');

    const bad = await post(4100, { name: 'K', phone: '123', email: 'x', date: '2020-01-01', time: '', fulfil: 'levering', address: '', postcode: '12', items: [] });
    assert.strictEqual(bad.status, 422);
    assert.deepStrictEqual(Object.keys(bad.body.errors).sort(), ['address', 'date', 'email', 'items', 'name', 'phone', 'postcode', 'time']); ok('invalid request -> 422 with all field errors');
    const pickup = await post(4100, { ...good, fulfil: 'henting', address: '', postcode: '', items: [], message: 'Kan dere lage noe glutenfritt til 12?' });
    assert.strictEqual(pickup.status, 200); ok('pickup + message-only request accepted (no address needed)');

    mails.length = 0; webhookHits.length = 0;
    const r = await post(4100, good);
    assert.strictEqual(r.status, 200); assert.ok(r.body.ok);
    assert.strictEqual(r.body.estimate, 30 * 549 + 30 * 69); ok('estimate re-priced on server: ' + r.body.estimate + ' (client price ignored, unknown item dropped)');
    await new Promise(x => setTimeout(x, 400));
    assert.strictEqual(mails.length, 2); ok('2 emails sent (business + customer copy)');
    assert.deepStrictEqual(mails[0].to, ['post@lilleelling.no']); assert.deepStrictEqual(mails[1].to, ['kari@example.no']); ok('recipients correct');
    assert.ok(/Tradisjonell julebuffet/.test(mails[0].raw) && /utm_source=3Dfacebook|utm_source=facebook/.test(mails[0].raw)); ok('lead email contains items + ad source');
    assert.strictEqual(webhookHits.length, 1); assert.strictEqual(webhookHits[0].estimate, 18540); ok('webhook received lead JSON');

    const hp = await post(4100, { ...good, website: 'spam' });
    assert.strictEqual(hp.body.id, 'LAE-0'); ok('honeypot silently dropped');

    for (const pg of ['/', '/foresporsel', '/takk', '/styles.css', '/app.js']) { const s = (await fetch('http://127.0.0.1:4100' + pg)).status; assert.strictEqual(s, 200, pg); }
    ok('pages + assets return 200');
  } finally { a.kill(); }

  console.log('B) shop unreachable -> fallback menu');
  const b = await startApp(4101, { SHOP_URL: 'http://127.0.0.1:4999', DRY_RUN: 'true' });
  try {
    const m = await j(4101, '/api/menu');
    assert.strictEqual(m.body.source, 'fallback'); ok('menu source = fallback when shop is down');
    const r = await post(4101, good); assert.ok(r.body.ok); ok('DRY_RUN accepts without delivery channel');
  } finally { b.kill(); }

  console.log('C) no delivery channel configured');
  const c = await startApp(4102, { SHOP_URL: 'http://127.0.0.1:4001' });
  try {
    const r = await post(4102, good); assert.strictEqual(r.status, 503); ok('returns 503 + phone fallback instead of silently losing leads');
  } finally { c.kill(); }

  console.log(`\n${pass} checks passed`);
  shop.close(); smtp.close(); process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
