# Lille Ælling – catering request page (v2)

Replaces the current app on **book.lilleelling.no**. Design source: Figma file "Lille Ælling – Catering lead page v2".

Flow: **/** pick a category and menus into a request basket → **/foresporsel** date, delivery, contact details → **/takk** confirmation.
No payment is taken. Each lead is emailed to the business (and/or sent to a webhook), with server-side prices and the ad source (UTM / gclid / fbclid).

## What's inside

```
server.js                 Express server: static pages, /api/menu, /api/quote, /config.js, /healthz
data/site.json            Content you can edit: phone, categories, Google rating, reviews, unit overrides
data/fallback-menu.json   Menu used only if the Shopify shop can't be reached (snapshot 5 Oct 2026)
public/                   index.html, foresporsel.html, takk.html, styles.css, app.js
test/smoke.js             End-to-end test (mock Shopify, mock SMTP, mock webhook) – run: npm test
railway.json              Railway healthcheck + restart policy
```

Menus and prices are fetched **live** from `lilleelling.no/collections/<handle>/products.json`, cached 10 minutes.
Change a price or a product in Shopify and the page follows. Sold-out products are hidden automatically.

## Deploy on Railway

1. Push this folder to your Git repo (no build step; Railway runs `npm install` and `npm start`).
2. In Railway, point the service that serves **book.lilleelling.no** at this repo, or create a new service and move the custom domain to it.
3. Set the variables below under **Variables**. At least one lead channel (SMTP or webhook) is required: without one, the form refuses requests with a "please call us" message instead of silently losing leads.
4. Open `https://book.lilleelling.no/healthz`. Expect `"smtp":true` (or `"webhook":true`) and `"menu":"live"` (after the first page view).
5. Send one real test request and check that the email arrives.

### Variables

| Variable | Required | Example | What it does |
|---|---|---|---|
| `SMTP_HOST` | one of SMTP/webhook | `smtp.domeneshop.no` | Mail server for lead emails |
| `SMTP_PORT` | with SMTP | `587` | 465 = SSL, 587 = STARTTLS |
| `SMTP_USER` / `SMTP_PASS` | with SMTP | `post@lilleelling.no` | Mail login |
| `SMTP_FROM` | recommended | `Lille Ælling <post@lilleelling.no>` | Sender address |
| `LEAD_TO` | no | `post@lilleelling.no` | Who receives leads (default: post@lilleelling.no) |
| `SEND_CUSTOMER_COPY` | no | `true` | Also email the customer a copy. The thank-you page only mentions the copy when this is on |
| `LEAD_WEBHOOK_URL` | one of SMTP/webhook | Make/Zapier/Sheets URL | Receives every lead as JSON |
| `META_PIXEL_ID` | for Meta ads | `1234567890123456` | Meta Pixel |
| `GTM_ID` | for Google ads | `GTM-XXXXXXX` | Google Tag Manager container |
| `CONSENT_REQUIRED` | no | `true` (default) | Show the cookie banner; tags load only after "Godta" |
| `SHOP_URL` | no | `https://lilleelling.no` | Shopify store to read menus from |
| `MENU_TTL_MINUTES` | no | `10` | Menu cache time |
| `DRY_RUN` | testing only | `true` | Accept requests without sending anything. Never leave on in production |

The old app on Railway already sends emails from `/api/quote`. Check its Variables tab for the SMTP settings and copy them into the names above.
The old page also has Meta Pixel and GTM code in its HTML, but commented out. Take the IDs from there.

## Tracking (fires only after cookie consent)

| When | Meta Pixel event | dataLayer event |
|---|---|---|
| Every page | PageView | gtm.js |
| Menu details opened | ViewContent | lae_viewcontent |
| "Legg til" | AddToCart (value = qty × price, NOK) | lae_addtocart |
| Step 2 page opened with items | InitiateCheckout | lae_initiatecheckout |
| Thank-you page (once per request) | **Lead** (value = estimate, NOK, eventID = request id) | lae_lead |
| Phone link tapped | Contact | lae_contact |

For Google Ads, create a GTM trigger on the custom event `lae_lead` and fire the conversion tag on it.

## Editing content (data/site.json)

- `google.rating`, `google.count`, `google.url`: the hero line "4,9 av 5 på Google (47 omtaler)" appears only when rating and count are set. **Fill in from the real Google profile.**
- `reviews`: `[{ "text": "…", "author": "Kari N., julebord", "stars": 5 }]`. The review section stays hidden while this is empty. Paste real Google reviews word for word.
- `categories`: tile order, labels, which Shopify collections feed each tile. `populare.handles` sets the 5 products under Populære.
- `unitOverrides`: per-product unit (`person`, `pakke` or `stk`). Without an override the unit is read from the product text ("per person", "min. 10 personer", or "pakke" in the title), otherwise `stk`.

## Assumptions to confirm with the client

- **Snitter:** Lunsjsnitter and Snitterpakke Klassisk are priced **per pakke**. This was only confirmed for Deluxe (old page). Change it in `unitOverrides` if wrong.
- **Riskrem tillegg:** can only be added when a julebuffet is in the request (rule taken from the Shopify text).
- **Drikke tile:** also lists the Shopify "Tillegg" collection under its own heading.
- **Delivery fee:** shown as "Avklares med deg". The response time isn't promised anywhere until the client confirms one.

## Test locally

```
npm install
npm test                       # 22 end-to-end checks
DRY_RUN=true npm start         # http://localhost:3000
```
