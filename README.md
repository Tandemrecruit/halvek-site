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
4. It emails the request to quotes@halvek.co through ZeptoMail, from `website@halvek.co`, with
   the client's address as Reply-To and the files attached. Reply to the email to answer the
   client.
5. If ZeptoMail refuses the email, the Worker sends a second, text-only copy (no attachments,
   no Reply-To) that says so, so the lead still arrives. If that fails too, the visitor is asked
   to email instead, and the request details are written to the Worker's logs (kept 3 days).

Nothing is sent to the client automatically; anyone could type a stranger's address into the
form, so the page itself confirms the request.

## One-time setup

1. **Turnstile widget.** Cloudflare dashboard → Turnstile → Add widget. Name: "halvek.co quote
   form". Hostname: `halvek.co`. Mode: Managed. Put the **site key** in `tools/site.json` (it is
   public) and keep the **secret key** for step 3.
2. **ZeptoMail Mail Agent.** ZeptoMail → Mail Agents → Add Mail Agent ("halvek website"),
   linked to the verified domain halvek.co. Under SMTP/API → API, copy the **Send Mail token**.
   Complete ZeptoMail's account review if it asks (use: "notifications from my website's quote
   form, sent to my own inbox"). Buy credits before the free one runs out; credits expire six
   months after purchase, and the form stops sending if they lapse.
3. **Secrets.** Workers & Pages → long-firefly-ffac → Settings → Variables and Secrets → Add,
   type **Secret**, twice: `TURNSTILE_SECRET_KEY` and `ZEPTOMAIL_TOKEN`.
4. **Deploys from GitHub.** Workers & Pages → long-firefly-ffac → Settings → Builds → Connect,
   choose this repository, branch `main`, no build command, deploy command `npm run deploy`.
   Every push to `main` then deploys. (`npm run deploy` refuses to deploy a `public/` without a
   real Turnstile site key.)

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

- The Workers free plan allows 10 ms of CPU per request. Encoding attachments costs roughly
  3 ms per MB, so a typical request (two to four photos) uses a few milliseconds, and the
  largest allowed (5 MB) can go over. Cloudflare tolerates occasional overruns; if the Worker's
  metrics ever show "Exceeded CPU", the fix is the Workers Paid plan ($5 a month) or a lower
  file cap in `src/worker.js` and `src/client/quote.js`.
- ZeptoMail limits a whole email to 15 MB; the 5 MB file cap stays well inside it.
- Optional hardening: a WAF rate-limiting rule for `POST /api/quote` (the free plan includes
  one) stops floods before they reach the Worker's 100,000 requests a day.
