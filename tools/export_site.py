"""Build public/ (what the Worker serves) from the design canvas.

The page is designed in design/Main.dc.html, a Claude design canvas. This fills its template
holes, drops the photo placeholders that have no photo yet, adds the page head, the form
script and the Turnstile site key, and copies the icons and client files next to it.

Usage:
  python3 tools/export_site.py                      # uses the site key in tools/site.json
  python3 tools/export_site.py --site-key KEY --out DIR

Needs Pillow (pip install pillow) for the icon sizes.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TEST_KEYS = {"1x00000000000000000000AA", "2x00000000000000000000AB", "3x00000000000000000000FF"}

parser = argparse.ArgumentParser()
parser.add_argument("--canvas", default=ROOT / "design" / "Main.dc.html", type=Path)
parser.add_argument("--out", default=ROOT / "public", type=Path)
parser.add_argument("--site-key", help="Turnstile site key (defaults to tools/site.json)")
parser.add_argument("--allow-test-key", action="store_true", help="allow Cloudflare's Turnstile test keys (local tests only)")
args = parser.parse_args()

site = json.loads((ROOT / "tools" / "site.json").read_text(encoding="utf-8"))
site_key = args.site_key or site["turnstileSiteKey"]
if not re.fullmatch(r"[0-9]x[A-Za-z0-9_-]{10,}", site_key):
    sys.exit(f"Turnstile site key missing or malformed: {site_key!r}. Put it in tools/site.json.")
if site_key in TEST_KEYS and not args.allow_test_key:
    sys.exit("That is a Turnstile test key. Use the real site key for public/, or pass --allow-test-key for a test build.")

EMAIL = site["email"]
ACCENT = site["accent"]
MAIL_HREF = "mailto:" + EMAIL + "?subject=Quote%20request"

src = args.canvas.read_text(encoding="utf-8")

title = re.search(r"<title>(.*?)</title>", src, re.S).group(1).strip()
helmet = re.search(r"<helmet>(.*?)</helmet>", src, re.S).group(1)
font_link = re.search(r'<link rel="stylesheet" href="https://fonts\.googleapis\.com/[^"]+">', helmet).group(0)
page_css = re.search(r"<style>(.*?)</style>", helmet, re.S).group(1).strip()
body = re.search(r"</helmet>(.*?)</x-dc>", src, re.S).group(1).strip("\n")

holes = {"mailHref": MAIL_HREF, "email": EMAIL, "accent": ACCENT}
body = re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: holes[m.group(1)], body)
if "{{" in body or "}}" in body:
    sys.exit("unfilled template hole left in the page")

# Photo placeholders (grey wells describing a photo still to be taken) stay out of the live
# site until the photos exist.
figures = re.findall(r"<figure\b.*?</figure>\n?", body, re.S)
placeholders = [f for f in figures if "<img" not in f and "Photo" in f]
for f in placeholders:
    body = body.replace(f, "", 1)
body = re.sub(r"\n{3,}", "\n\n", body)

if body.count('data-sitekey="TURNSTILE_SITE_KEY"') != 1:
    sys.exit("expected one Turnstile placeholder in the form")
body = body.replace('data-sitekey="TURNSTILE_SITE_KEY"', f'data-sitekey="{site_key}"')
for needed in ('id="quote-form"', 'id="q-sent-title"', 'id="q-offline"', 'href="#start"'):
    if needed not in body:
        sys.exit(f"form markup changed: {needed} not found")

description = (
    "The part you can't buy, designed and 3D printed to fit. Send a photo and a few "
    "measurements, and you'll get a firm price before any work starts. Portage, Michigan."
)

SITE_URL = "https://halvek.co"
# Every page that should be in search results. Add a path here when a new page goes up.
PAGES = ["/"]

# Who the business is, for search engines (schema.org). Only facts already stated on the page:
# no street address, and no prices, which would go stale the next time the page changes.
business = {
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "ProfessionalService",
            "@id": f"{SITE_URL}/#business",
            "name": "Halvek",
            "legalName": "Halvek LLC",
            "url": f"{SITE_URL}/",
            "email": EMAIL,
            "logo": f"{SITE_URL}/og-image.png",
            "image": f"{SITE_URL}/og-image.png",
            "description": description,
            "address": {
                "@type": "PostalAddress",
                "addressLocality": "Portage",
                "addressRegion": "MI",
                "addressCountry": "US",
            },
            "areaServed": [
                {"@type": "City", "name": "Portage, Michigan"},
                {"@type": "City", "name": "Kalamazoo, Michigan"},
            ],
        },
        {
            "@type": "WebSite",
            "@id": f"{SITE_URL}/#website",
            "url": f"{SITE_URL}/",
            "name": "Halvek",
            "publisher": {"@id": f"{SITE_URL}/#business"},
        },
    ],
}
structured_data = json.dumps(business, indent=1, ensure_ascii=False).replace("</", "<\\/")

head_common = f"""<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
{font_link}
<style>
{page_css}
</style>"""

index = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="https://halvek.co/">
<meta property="og:type" content="website">
<meta property="og:url" content="https://halvek.co/">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:image" content="https://halvek.co/og-image.png">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#F6F5F1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://challenges.cloudflare.com">
{head_common}
<script type="application/ld+json">
{structured_data}
</script>
<script src="/quote.js" defer></script>
</head>
<body>
{body}
</body>
</html>
"""

not_found = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found · Halvek</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
{head_common}
</head>
<body>
<div style="width: 100%; min-height: 100vh; background: #F6F5F1; color: #121212; font-family: 'Instrument Sans', 'Helvetica Neue', Helvetica, sans-serif; font-size: 17px; line-height: 1.55;">
<header style="max-width: 1280px; margin: 0 auto; padding: 22px clamp(20px, 5vw, 72px);">
<a href="/" style="font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; color: #121212; text-decoration: none;">Halvek</a>
</header>
<main style="max-width: 1280px; margin: 0 auto; padding: clamp(32px, 5vw, 72px) clamp(20px, 5vw, 72px); display: flex; flex-direction: column; gap: 22px;">
<h1 style="margin: 0; font-size: clamp(36px, 5.6vw, 80px); font-weight: 500; line-height: 1.02; letter-spacing: -0.035em;">This page doesn't exist.</h1>
<p style="margin: 0; max-width: 32em; font-size: 18px; color: #5A5A57;">The home page has the three packages, their prices and the quote form.</p>
<a href="/#start" style="align-self: flex-start; display: inline-flex; align-items: center; min-height: 52px; padding: 14px 28px; background: {ACCENT}; color: #FFFFFF; font-size: 17px; font-weight: 500; text-decoration: none; border-radius: 999px;">Request a quote</a>
</main>
</div>
</body>
</html>
"""

out = args.out
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
(out / "index.html").write_text(index, encoding="utf-8")
(out / "404.html").write_text(not_found, encoding="utf-8")

# No <lastmod>: a build date would change on every export whether or not the page did.
sitemap_urls = "\n".join(f"  <url><loc>{SITE_URL}{path}</loc></url>" for path in PAGES)
(out / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    f"{sitemap_urls}\n"
    "</urlset>\n",
    encoding="utf-8",
)
# Cloudflare's managed robots.txt (which turns away AI training crawlers) is put in front of
# this file, so it only needs to point to the sitemap. Everything not disallowed is allowed.
(out / "robots.txt").write_text(f"Sitemap: {SITE_URL}/sitemap.xml\n", encoding="utf-8")

client = ROOT / "src" / "client"
shutil.copyfile(client / "quote.js", out / "quote.js")
shutil.copyfile(client / "_headers", out / "_headers")

brand = ROOT / "src" / "brand"
shutil.copyfile(brand / "mark-small.svg", out / "favicon.svg")
shutil.copyfile(brand / "favicon-32.png", out / "favicon-32.png")
shutil.copyfile(brand / "mark-tile-1024.png", out / "og-image.png")
tile = Image.open(brand / "mark-tile-1024.png").convert("RGBA")
tile.resize((180, 180), Image.Resampling.LANCZOS).save(out / "apple-touch-icon.png", optimize=True)
Image.open(brand / "favicon-32.png").convert("RGBA").save(out / "favicon.ico", sizes=[(16, 16), (32, 32)])

print(f"wrote {out}: {sorted(p.name for p in out.iterdir())}; {len(placeholders)} photo placeholder(s) left out")
