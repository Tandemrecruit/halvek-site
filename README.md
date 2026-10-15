# halvek.co

The Halvek website and its quote form, deployed as one Cloudflare Worker (`long-firefly-ffac`).

- `public/` is the site as served: the home page, the 404 page, icons and the form script. It is
  generated; don't edit it by hand.
- `design/Main.dc.html` is the page's design source (the Claude design canvas "Halvek.co
  Portfolio"). `tools/export_site.py` turns it into `public/`.
- `src/worker.js` handles `POST /api/quote`. Everything else is served straight from `public/`
  without running the script.
- `src/client/quote.js` is the form script; `src/client/_headers` sets security headers on pages.

## How a quote request travels

1. The visitor fills in the form under "Start a project". Photos are resized in the browser to
   1600 px on the long side (which also strips the GPS position phones store in photos). Up to
   8 files and 5 MB in all.
2. A Cloudflare Turnstile check runs in the background (a checkbox appears only if Cloudflare
   isn't sure the visitor is a person).
3. The Worker checks where the request came from, the rate limit (5 a minute per IP address),
   the Turnstile token, the fields, and the files (by their contents, not their names).
4. It emails the request to quotes@halvek.co through Zoho CPaaS (the service formerly called
   ZeptoMail), from `website@halvek.co`, with the client's address as Reply-To and the files
   attached. Reply to the email to answer the client. The Worker uses Zoho's current send
   address (`cpaas.zoho.com`) and falls back to the older `api.zeptomail.com` if the first
   can't be reached or turns the key away.
5. If the email is refused, the Worker sends a second, text-only copy (no attachments, no
   Reply-To) that says so, so the lead still arrives. If that fails too, the visitor is asked to
   email instead, and the request details are written to the Worker's logs (kept 3 days).
6. Until both secrets are set, `/api/quote/status` reports not ready and the page swaps the form
   for "Send it by email for now", so nobody fills in a form that can't send.

Nothing is sent to the client automatically; anyone could type a stranger's address into the
form, so the page itself confirms the request.

## One-time setup

1. **Turnstile widget.** Cloudflare dashboard → Turnstile → Add widget. Name: "halvek.co quote
   form". Hostname: `halvek.co`. Mode: Managed. The **site key** goes in `tools/site.json` (it is
   public); keep the **secret key** for step 4.
2. **Deploys from GitHub.** Workers & Pages → long-firefly-ffac → Settings → Builds → Connect,
   choose this repository, branch `main`, no build command, deploy command `npm run deploy`.
   Every push to `main` then deploys. (`npm run deploy` refuses to deploy a `public/` without a
   real Turnstile site key.) The Worker needs this first deploy before Cloudflare lets it hold
   secrets; until step 4 is done the page shows the email route instead of the form.
3. **Zoho CPaaS Agent key.** In the Zoho Mail Admin Console (mailadmin.zoho.com) → Transactional
   Emails → Agents → the agent → SMTP/API → API, copy the key (Zoho also calls it the Send Mail
   token or Agent key). The same screens are in the Zoho CPaaS console itself. Complete Zoho's
   account review if it asks (use: "notifications from my website's quote form, sent to my own
   inbox"). Credits expire six months after purchase (a new account's free credit after one
   month), and the form stops sending if they lapse.
4. **Secrets.** `TURNSTILE_SECRET_KEY` and `ZEPTOMAIL_TOKEN` (the Agent key) are kept as build
   secrets: Workers & Pages → long-firefly-ffac → Settings → Builds → Variables and secrets.
   `npm run deploy` (tools/deploy.mjs) passes them on to the Worker as runtime secrets on every
   deploy, so changing one there takes effect at the next deploy (push, or retry the latest
   build). Secrets set directly under Settings → Variables and Secrets also work and are left
   alone.

5. **Workers Paid plan.** Compute → Workers plans → Upgrade (under Paid). Requests with
   photos need more CPU time than the free plan allows (see "Limits worth knowing").

To deploy from a computer instead: install Node.js 20 or later, then in this folder run
`npm install`, `npx wrangler login` and `npm run deploy`. Secrets can be set with
`npx wrangler secret put TURNSTILE_SECRET_KEY` and `npx wrangler secret put ZEPTOMAIL_TOKEN`.

## After the first deploy

- Send a real request from a phone with two or three photos.
- Check it lands in the inbox (not spam) from "Halvek quote form", then press Reply and check
  the To line shows the address you entered as the client.
- Workers & Pages → long-firefly-ffac → Observability shows a `"sent"` log line for it.

## Changing the site

1. Change the page in the design canvas, then copy it to `design/Main.dc.html`.
2. Run `python3 tools/export_site.py` (needs Python 3 with Pillow) to rebuild `public/`.
3. Commit and push; Workers Builds deploys it.

Keep the form markup's ids (`quote-form`, `q-name`, `q-files`, `q-turnstile`, `q-status`,
`q-sent` and the rest) when editing the design: the form script looks them up by id.

## Tests

`python3 -I test/e2e.py` builds a test copy of the site, runs the Worker locally with stand-ins
for Turnstile and ZeptoMail, and drives the form in Chromium (needs `npm install`, Python with
Playwright, Pillow and reportlab). It covers validation, photo resizing, the email payload, the
error paths, the no-JavaScript fallback and the rate limit. Screenshots go to
`test/output/shots`.

## Limits worth knowing

- The Worker needs the Workers Paid plan ($5 a month). The first real request (three phone
  photos, 1.7 MB) used 20 ms of CPU, and the free plan allows 10 ms per request, tolerating
  only occasional overruns. About half of that cost is receiving and unpacking the upload, so
  no code change brings a photo request under 10 ms. Paid allows 30 seconds per request by
  default, and this site stays well inside the usage the plan includes.
- Zoho limits a whole email to 15 MB; the 5 MB file cap stays well inside it.
- Optional hardening: a WAF rate-limiting rule for `POST /api/quote` (Cloudflare's free zone
  plan includes one) stops floods before they reach the Worker. On Workers Paid, requests past
  the 10 million a month included cost $0.30 per million.
