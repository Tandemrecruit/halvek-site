"""End-to-end test of the quote form.

Builds a test copy of the site (Turnstile test key), runs the Worker under `wrangler dev` with
mock Turnstile and ZeptoMail servers, and drives the page in Chromium: validation, photo
resizing, the email that would be sent, every error path, the no-JavaScript fallback and the
rate limit. Screenshots land in test/output/shots.

Usage (from the project folder, after `npm install`):
  python3 -I test/e2e.py
Needs: Python 3.10+, playwright (with Chromium), pillow, reportlab.
Set CHROMIUM=/path/to/chrome to use a specific browser binary.
"""
import base64
import io
import json
import os
import random
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "output"
SHOTS = OUT / "shots"
FILES = OUT / "files"
MOCK_PORT, DEV_PORT = 9911, 8787
BASE = f"http://127.0.0.1:{DEV_PORT}"
MOCK = f"http://127.0.0.1:{MOCK_PORT}"
TEST_SITE_KEY = "1x00000000000000000000AA"
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")

TURNSTILE_STUB = """
(function () {
  var n = 0, opts = null;
  function issue() { n += 1; var t = 'XXXX.DUMMY.TOKEN.' + n; setTimeout(function () { if (opts && opts.callback) opts.callback(t); }, 40); }
  window.turnstile = {
    render: function (el, o) { opts = o; window.__turnstile = { sitekey: o.sitekey, action: o.action, appearance: o.appearance, renders: (window.__turnstile ? window.__turnstile.renders : 0) + 1, resets: 0 }; issue(); return 'widget-1'; },
    reset: function () { window.__turnstile.resets += 1; issue(); },
    getResponse: function () { return ''; },
    remove: function () {}
  };
  var cb = new URL(document.currentScript.src).searchParams.get('onload');
  if (cb && window[cb]) window[cb]();
})();
"""

results = []


def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


# ---- Setup ------------------------------------------------------------------

def export_test_site():
    subprocess.run(
        [sys.executable, "-I", str(ROOT / "tools" / "export_site.py"), "--site-key", TEST_SITE_KEY, "--allow-test-key", "--out", str(OUT / "public")],
        check=True,
    )


def write_config(rate_limit, configured=True):
    text = (ROOT / "wrangler.jsonc").read_text(encoding="utf-8")
    config = json.loads("\n".join(line for line in text.splitlines() if not line.strip().startswith("//")))
    config["main"] = str(ROOT / "src" / "worker.js")
    config["assets"]["directory"] = str(OUT / "public")
    for key in ("routes", "workers_dev", "preview_urls", "$schema"):
        config.pop(key, None)
    config["ratelimits"][0]["simple"]["limit"] = rate_limit
    # A namespace of its own per run, so counts from earlier runs don't carry over.
    config["ratelimits"][0]["namespace_id"] = str(2000 + rate_limit + int(time.time()) % 1000)
    (OUT / "wrangler.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    (OUT / ".dev.vars").write_text(
        "\n".join(
            [
                "TURNSTILE_SECRET_KEY=test-secret",
                "ZEPTOMAIL_TOKEN=test-token" if configured else "",
                f"ZEPTOMAIL_URL={MOCK}/v1.1/email",
                f"TURNSTILE_VERIFY_URL={MOCK}/siteverify",
                "ALLOWED_HOSTNAMES=halvek.co,127.0.0.1",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def quiet_env():
    env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    env.update({"NO_PROXY": "*", "WRANGLER_SEND_METRICS": "false", "CI": "1"})
    return env


def wait_for(url, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


DEV_RUNS = [0]


def start_dev():
    DEV_RUNS[0] += 1
    log = open(OUT / f"wrangler-dev-{DEV_RUNS[0]}.log", "w")
    proc = subprocess.Popen(
        ["npx", "wrangler", "dev", "-c", str(OUT / "wrangler.json"), "--ip", "127.0.0.1", "--port", str(DEV_PORT), "--show-interactive-dev-session=false", "--log-level", "info"],
        cwd=ROOT,
        env=quiet_env(),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    if not wait_for(BASE + "/"):
        stop(proc)
        sys.exit("wrangler dev did not start; see test/output/wrangler-dev-*.log")
    return proc


def stop(proc):
    if proc and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def mock(path, body=None):
    data = json.dumps(body or {}).encode() if body is not None else None
    req = urllib.request.Request(MOCK + path, data=data, method="POST" if data is not None else "GET", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def make_files():
    FILES.mkdir(parents=True, exist_ok=True)
    random.seed(7)
    # A phone photo: 4032 x 3024 stored sideways (EXIF orientation 6) with a GPS position.
    w, h = 4032, 3024
    img = Image.blend(Image.linear_gradient("L").resize((w, h)).convert("RGB"), Image.effect_noise((w, h), 60).convert("RGB"), 0.3)
    ImageDraw.Draw(img).rectangle([0, 0, 600, 600], fill=(220, 0, 0))  # stored top-left; shows top-right once rotated
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = "TestCam"
    exif[0x8825] = {1: "N", 2: (42.0, 12.0, 0.0), 3: "W", 4: (85.0, 35.0, 0.0)}
    img.save(FILES / "IMG_4512.jpg", "JPEG", quality=90, exif=exif)
    # A small line drawing (sent untouched) and a big one with a transparent background (resized).
    drawing = Image.new("RGBA", (3000, 2000), (0, 0, 0, 0))
    d = ImageDraw.Draw(drawing)
    for x in range(100, 2900, 200):
        d.line([(x, 100), (x, 1900)], fill=(0, 0, 0, 255), width=6)
    drawing.save(FILES / "bracket sketch.png")
    big = Image.new("RGBA", (3000, 2000), (0, 0, 0, 0))
    big.paste(Image.effect_noise((1200, 2000), 90).convert("RGBA"), (0, 0))
    big.save(FILES / "big transparent.png")
    # A PDF drawing.
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(FILES / "spec.pdf"))
    c.drawString(72, 720, "Bracket, Rev A, 2026-10-15")
    c.save()
    # HEIC that this Chromium can't decode (it gets sent as it is), and a "photo" that isn't one.
    (FILES / "scan.heic").write_bytes(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + random.randbytes(150_000))
    (FILES / "fake.jpg").write_bytes(b"this is not really a photo\n" * 200)
    for i in range(9):
        Image.new("RGB", (400, 300), (30 * i, 90, 120)).save(FILES / f"small-{i}.jpg", quality=80)
    for i in range(5):
        Image.effect_noise((2000, 2000), 120).convert("RGB").save(FILES / f"noise-{i}.png")


# ---- Scenarios --------------------------------------------------------------

def new_page(browser, width=1440, height=900, turnstile=True, js=True):
    context = browser.new_context(viewport={"width": width, "height": height}, java_script_enabled=js)
    page = context.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    # Blocked font and Turnstile requests log "Failed to load resource"; those are the test's doing.
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    if turnstile:
        page.route(re.compile(r"https://challenges\.cloudflare\.com/.*"), lambda r: r.fulfill(status=200, content_type="text/javascript", body=TURNSTILE_STUB))
    else:
        page.route(re.compile(r"https://challenges\.cloudflare\.com/.*"), lambda r: r.abort())
    page.goto(BASE + "/", wait_until="load")
    return page


def fill_required(page, name="Test Client", email="client@example.com", details="A replacement latch for a 1998 Craftsman tool chest.\nThe original snapped at the hinge."):
    page.fill("#q-name", name)
    page.fill("#q-email", email)
    page.fill("#q-details", details)


def wait_ready(page, timeout=20000):
    page.wait_for_function("() => !document.querySelector('#q-file-list .hv-size') || ![...document.querySelectorAll('#q-file-list .hv-size')].some(e => e.textContent === 'Preparing')", timeout=timeout)


def no_overflow(page):
    return page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")


def scenario_layout_and_validation(browser):
    page = new_page(browser)
    check("page has no script errors on load", not page.errors, "; ".join(page.errors))
    hrefs = page.eval_on_selector_all("a", "els => els.filter(a => a.textContent.trim() === 'Request a quote' && !a.closest('#q-offline')).map(a => a.getAttribute('href'))")
    check("every Request a quote link goes to the form", hrefs and all(h == "#start" for h in hrefs), str(hrefs))
    page.click("section >> text=Request a quote")
    page.wait_for_timeout(900)
    top = page.evaluate("() => document.getElementById('start').getBoundingClientRect().top")
    check("hero button scrolls to Start a project", abs(top) < 40, f"top={top}")
    check("Turnstile loads with the form's action", page.evaluate("() => window.__turnstile && window.__turnstile.action") == "quote")
    check("Turnstile gets the site key from the page", page.evaluate("() => window.__turnstile && window.__turnstile.sitekey") == TEST_SITE_KEY)
    check("form stays up when the Worker is set up", page.is_visible("#quote-form") and page.is_hidden("#q-offline"))

    page.click("#quote-form button[type=submit]")
    page.wait_for_timeout(200)
    errors = page.evaluate("() => ['q-name','q-email','q-details'].map(id => [document.getElementById(id).getAttribute('aria-invalid'), document.getElementById(id + '-error').textContent])")
    check("empty send flags name, email and details", all(e[0] == "true" and e[1] for e in errors), str(errors))
    check("focus moves to the first problem", page.evaluate("() => document.activeElement.id") == "q-name")
    check("nothing was sent for an empty form", not mock("/emails")["emails"])
    page.locator("#start").screenshot(path=str(SHOTS / "desktop-errors.png"))

    page.fill("#q-name", "Test Client")
    page.fill("#q-email", "client@example")
    page.fill("#q-details", "Something")
    page.click("#quote-form button[type=submit]")
    page.wait_for_timeout(200)
    check("incomplete email address is caught", "doesn't look right" in page.text_content("#q-email-error"), page.text_content("#q-email-error"))
    page.fill("#q-email", "john@gmail..com")
    page.click("#quote-form button[type=submit]")
    page.wait_for_timeout(200)
    check("doubled dot in an address is caught", page.get_attribute("#q-email", "aria-invalid") == "true")
    check("fixed fields clear their errors", page.get_attribute("#q-name", "aria-invalid") is None)
    page.context.close()


def scenario_full_send(browser):
    mock("/reset", {})
    page = new_page(browser)
    fill_required(page, details='A replacement latch for a 1998 Craftsman tool chest.\nThe original snapped at the hinge. <b>bold</b> & "quotes"')
    page.fill("#q-measurements", "Hinge pin 4.8 mm, overall 62 x 18 mm")
    page.fill("#q-environment", "Garage, unheated")
    page.fill("#q-quantity", "2")
    page.fill("#q-deadline", "Before Christmas")
    page.check("input[name=package][value='Replacement part']")
    page.set_input_files("#q-files", [str(FILES / n) for n in ("IMG_4512.jpg", "bracket sketch.png", "big transparent.png", "spec.pdf", "scan.heic")])
    wait_ready(page)
    rows = page.eval_on_selector_all("#q-file-list li", "els => els.map(li => li.innerText.replace(/\\s+/g, ' ').trim())")
    check("five files listed", len(rows) == 5, str(rows))
    try:
        page.wait_for_function("() => /files ready/.test(document.getElementById('q-files-status').textContent)", timeout=3000)
    except Exception:
        pass
    check("file results announced to screen readers", "5 files ready" in page.text_content("#q-files-status"), page.text_content("#q-files-status"))
    check("photo listed under its new name and size", any(r.startswith("IMG_4512.jpg") and ("KB" in r or "MB" in r) for r in rows), str(rows))
    check("photo has a thumbnail", page.evaluate("() => !!document.querySelector('#q-file-list img')"))
    page.locator("#start").screenshot(path=str(SHOTS / "desktop-files.png"))

    page.click("#quote-form button[type=submit]")
    page.wait_for_selector("#q-sent:not([hidden])", timeout=20000)
    check("success message replaces the form", page.is_hidden("#quote-form") and page.is_visible("#q-sent"))
    check("focus moves to the success heading", page.evaluate("() => document.activeElement.id") == "q-sent-title")
    page.locator("#start").screenshot(path=str(SHOTS / "desktop-sent.png"))

    state = mock("/emails")
    check("exactly one email sent", len(state["emails"]) == 1, str(len(state["emails"])))
    email = state["emails"][0]
    p = email.get("payload") or {}
    check("email JSON is valid", "payload" in email, email.get("payload_error", ""))
    check("ZeptoMail auth header format", email["authorization"] == "Zoho-enczapikey test-token", email["authorization"])
    check("from website@halvek.co, not the inbox's own address", p.get("from", {}).get("address") == "website@halvek.co")
    check("to quotes@halvek.co", p.get("to", [{}])[0].get("email_address", {}).get("address") == "quotes@halvek.co")
    check("reply-to is the client", p.get("reply_to", [{}])[0] == {"address": "client@example.com", "name": "Test Client"}, str(p.get("reply_to")))
    check("subject names the client and the job", p.get("subject", "").startswith("Quote request from Test Client: A replacement latch"), p.get("subject"))
    html = p.get("htmlbody", "")
    check("client text is escaped in the HTML email", "&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;" in html and "<b>bold" not in html)
    for label, value in (("package", "Replacement part"), ("measurements", "Hinge pin 4.8 mm"), ("environment", "Garage, unheated"), ("deadline", "Before Christmas")):
        check(f"email includes {label}", value in html and value in p.get("textbody", ""))
    atts = p.get("attachments", [])
    names = [a["name"] for a in atts]
    check("attachment names", names == ["IMG_4512.jpg", "bracket sketch.png", "big transparent.jpg", "spec.pdf", "scan.heic"], str(names))
    check("attachment types from file contents", [a["mime_type"] for a in atts] == ["image/jpeg", "image/png", "image/jpeg", "application/pdf", "image/heic"], str([a["mime_type"] for a in atts]))
    if len(atts) == 5:
        photo = Image.open(io.BytesIO(base64.b64decode(atts[0]["content"])))
        check("photo resized to 1600 px on the long side, upright", photo.size == (1200, 1600), str(photo.size))
        exif = photo.getexif()
        check("photo metadata (GPS, camera) removed", len(exif) == 0, str(dict(exif)))
        px = photo.convert("RGB").getpixel((photo.size[0] - 20, 20))
        check("photo orientation applied (marker top right)", px[0] > 150 and px[1] < 90, str(px))
        check("small line drawing sent untouched", base64.b64decode(atts[1]["content"]) == (FILES / "bracket sketch.png").read_bytes())
        big = Image.open(io.BytesIO(base64.b64decode(atts[2]["content"]))).convert("RGB")
        check("big transparent drawing resized onto white", big.size == (1600, 1067) and big.getpixel((1500, 500)) >= (245, 245, 245), f"{big.size} {big.getpixel((1500, 500))}")
        check("PDF sent byte for byte", base64.b64decode(atts[3]["content"]) == (FILES / "spec.pdf").read_bytes())
        check("unreadable HEIC sent as it is", base64.b64decode(atts[4]["content"]) == (FILES / "scan.heic").read_bytes())
    ver = state["verifications"]
    check("Turnstile token checked server-side once", len(ver) == 1 and ver[0]["response"].startswith("XXXX.DUMMY.TOKEN") and ver[0]["secret_set"] and ver[0]["idempotency_key"], str(ver))
    check("Turnstile reset after the send", page.evaluate("() => window.__turnstile.resets") >= 1)
    check("form is empty again", page.input_value("#q-name") == "" and page.evaluate("() => document.querySelectorAll('#q-file-list li').length") == 0)
    page.click("#q-again")
    check("Send another request shows the form", page.is_visible("#quote-form") and page.evaluate("() => document.activeElement.id") == "q-name")
    check("no script errors during the send", not page.errors, "; ".join(page.errors))
    page.context.close()


def scenario_file_limits(browser):
    mock("/reset", {})
    page = new_page(browser)
    page.set_input_files("#q-files", [str(FILES / f"small-{i}.jpg") for i in range(9)])
    wait_ready(page)
    count = page.evaluate("() => document.querySelectorAll('#q-file-list li').length")
    check("only 8 files accepted", count == 8, str(count))
    check("told about the file left out", "left out" in page.text_content("#q-files-error"), page.text_content("#q-files-error"))
    page.click("#q-file-list li >> text=Remove")
    check("removing a file clears the notice", page.is_hidden("#q-files-error"))
    check("focus moves to the next Remove button", page.evaluate("() => document.activeElement.textContent") == "Remove")
    page.evaluate("() => { const b = [...document.querySelectorAll('#q-file-list button')]; b.forEach(x => x.click()); }")

    # Focus stays put while another file finishes preparing (the list is rebuilt then).
    page.set_input_files("#q-files", [str(FILES / "small-0.jpg"), str(FILES / "IMG_4512.jpg")])
    page.wait_for_function("() => /KB/.test(document.querySelector('#q-file-list li .hv-size').textContent)")
    page.focus("#q-file-list li button")
    first_id = page.evaluate("() => document.activeElement.getAttribute('data-id')")
    wait_ready(page)
    check("focus survives the list updating", page.evaluate("() => document.activeElement.getAttribute('data-id')") == first_id)
    page.evaluate("() => { const b = [...document.querySelectorAll('#q-file-list button')]; b.forEach(x => x.click()); }")

    page.set_input_files("#q-files", [str(FILES / f"noise-{i}.png") for i in range(5)])
    wait_ready(page, 60000)
    fill_required(page)
    page.click("#quote-form button[type=submit]")
    page.wait_for_timeout(500)
    check("over 5 MB in total is blocked", "more than 5 MB" in page.text_content("#q-files-error"), page.text_content("#q-files-error"))
    check("nothing sent when files are too big", not mock("/emails")["emails"])
    page.evaluate("() => { const b = [...document.querySelectorAll('#q-file-list button')]; b.forEach(x => x.click()); }")

    page.set_input_files("#q-files", [str(FILES / "fake.jpg")])
    wait_ready(page)
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => !document.getElementById('q-files-error').hidden", timeout=15000)
    check("server refuses a file that isn't a photo or PDF", "isn't a photo or PDF" in page.text_content("#q-files-error"), page.text_content("#q-files-error"))
    check("refused file means no email", not mock("/emails")["emails"])
    page.context.close()


def scenario_failures(browser):
    mock("/reset", {})
    mock("/mode", {"email": "fail"})
    page = new_page(browser, 390, 844)
    fill_required(page)
    page.set_input_files("#q-files", [str(FILES / "IMG_4512.jpg")])
    wait_ready(page)
    page.locator("#start").screenshot(path=str(SHOTS / "mobile-files.png"))
    check("no sideways scrolling on a phone", no_overflow(page))
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => document.getElementById('q-status').textContent.length > 0", timeout=20000)
    status = page.text_content("#q-status")
    check("email failure shows a message", "didn't send" in status, status)
    emails = mock("/emails")["emails"]
    retry = (emails[1].get("payload") or {}) if len(emails) == 2 else {}
    check("a refused email is retried once, text only", len(emails) == 2 and not retry.get("attachments") and "reply_to" not in retry, str(len(emails)))
    check("the retry says why and lists the files", "refused the full request" in retry.get("textbody", "") and "IMG_4512.jpg" in retry.get("textbody", ""))
    href = page.get_attribute("#q-status a", "href") or ""
    check("failure offers a prefilled email", href.startswith("mailto:quotes@halvek.co?subject=Quote%20request&body=") and "Test%20Client" in href, href[:120])
    check("details are kept after a failure", page.input_value("#q-details").startswith("A replacement latch") and page.evaluate("() => document.querySelectorAll('#q-file-list li').length") == 1)
    check("button is usable again", page.get_attribute("#quote-form button[type=submit]", "aria-disabled") is None and page.text_content("#quote-form button[type=submit]") == "Request a quote")
    page.locator("#start").screenshot(path=str(SHOTS / "mobile-error.png"))

    mock("/mode", {"email": "ok", "siteverify": "fail"})
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => /spam check/.test(document.getElementById('q-status').textContent)", timeout=20000)
    check("failed spam check explained", "didn't pass" in page.text_content("#q-status"), page.text_content("#q-status"))

    mock("/mode", {"siteverify": "down"})
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => /couldn't be reached/.test(document.getElementById('q-status').textContent)", timeout=20000)
    check("unreachable spam check explained", True)

    mock("/mode", {"siteverify": "ok", "hostname": "evil.example"})
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => /didn't pass/.test(document.getElementById('q-status').textContent)", timeout=20000)
    check("token solved on another hostname is refused", len(mock("/emails")["emails"]) == 2, str(len(mock("/emails")["emails"])))

    mock("/mode", {"hostname": "127.0.0.1"})
    page.click("#quote-form button[type=submit]")
    page.wait_for_selector("#q-sent:not([hidden])", timeout=20000)
    check("send works again after failures", len(mock("/emails")["emails"]) == 3)
    page.locator("#start").screenshot(path=str(SHOTS / "mobile-sent.png"))
    page.context.close()

    page = new_page(browser, turnstile=False)
    fill_required(page)
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => document.getElementById('q-status').textContent.length > 0", timeout=30000)
    check("blocked Turnstile script explained", "couldn't load" in page.text_content("#q-status"), page.text_content("#q-status"))
    page.context.close()


def debug_state(page):
    return {
        "status": page.text_content("#q-status"),
        "button": page.text_content("#quote-form button[type=submit]"),
        "files_error": page.text_content("#q-files-error"),
        "emails": [(len((m.get("payload") or {}).get("attachments", [])), (m.get("payload") or {}).get("subject")) for m in mock("/emails")["emails"]],
        "verifications": len(mock("/emails")["verifications"]),
    }


def scenario_partial_failure(browser):
    mock("/reset", {})
    mock("/mode", {"email": "fail_with_attachments"})
    page = new_page(browser)
    fill_required(page)
    page.set_input_files("#q-files", [str(FILES / "IMG_4512.jpg")])
    wait_ready(page)
    started = time.time()
    page.click("#quote-form button[type=submit]")
    try:
        page.wait_for_selector("#q-sent:not([hidden])", timeout=30000)
    except Exception:
        raise AssertionError(f"no success after {time.time() - started:.1f}s: {debug_state(page)}")
    print(f"  (partial failure send took {time.time() - started:.1f}s)")
    emails = mock("/emails")["emails"]
    check("lead still delivered when attachments are refused", len(emails) == 2 and not (emails[1].get("payload") or {}).get("attachments"), str([(len(m.get("payload", {}).get("attachments", [])), m.get("payload", {}).get("subject")) for m in emails]))
    check("client told to send the photos again", page.is_visible("#q-sent-note"))
    page.click("#q-again")
    fill_required(page)
    mock("/mode", {"email": "ok"})
    started = time.time()
    page.click("#quote-form button[type=submit]")
    try:
        page.wait_for_selector("#q-sent:not([hidden])", timeout=30000)
    except Exception:
        raise AssertionError(f"second send: no success after {time.time() - started:.1f}s: {debug_state(page)}")
    check("photo note hidden on a normal send", page.is_hidden("#q-sent-note"))

    # A request that dies on the way (connection dropped) puts the button back.
    page.click("#q-again")
    fill_required(page)
    page.route("**/api/quote", lambda r: r.abort())
    page.click("#quote-form button[type=submit]")
    page.wait_for_function("() => document.getElementById('q-status').textContent.length > 0", timeout=20000)
    check("dropped connection shows a message and frees the button", page.get_attribute("#quote-form button[type=submit]", "aria-disabled") is None, page.text_content("#q-status"))
    page.context.close()


def scenario_direct_requests(browser):
    mock("/reset", {})
    page = new_page(browser)
    res = page.evaluate(
        """async () => {
          const d = new FormData();
          d.append('name', 'Bot'); d.append('email', 'bot@example.com'); d.append('details', 'spam');
          d.append('hv_trap', 'http://spam.example');
          const r = await fetch('/api/quote', { method: 'POST', body: d, headers: { 'X-Halvek-Form': '1', 'X-Turnstile-Token': 'XXXX.DUMMY.TOKEN.x' } });
          return [r.status, await r.json()];
        }"""
    )
    check("filled hidden field with a passing check still answers normally", res[0] == 200 and res[1].get("ok") is True, str(res))
    emails = mock("/emails")["emails"]
    check("filled hidden field is delivered, marked for a second look", len(emails) == 1 and emails[0]["payload"]["subject"].startswith("[Check] "), str([m.get("payload", {}).get("subject") for m in emails]))
    res = page.evaluate(
        """async () => {
          const d = new FormData();
          d.append('name', 'A'); d.append('email', 'a@example.com'); d.append('details', 'x');
          const r = await fetch('/api/quote', { method: 'POST', body: d, headers: { 'X-Halvek-Form': '1' } });
          return [r.status, await r.json()];
        }"""
    )
    check("request without a Turnstile token refused", res[0] == 403 and res[1].get("error") == "challenge_missing", str(res))
    res = page.evaluate(
        """async () => {
          const d = new FormData();
          d.append('name', 'A'); d.append('email', 'a@example.com'); d.append('details', 'x'.repeat(5001));
          const r = await fetch('/api/quote', { method: 'POST', body: d, headers: { 'X-Halvek-Form': '1', 'X-Turnstile-Token': 'XXXX.DUMMY.TOKEN.y' } });
          return [r.status, await r.json()];
        }"""
    )
    check("over-long field refused", res[0] == 400 and res[1].get("field") == "details", str(res))
    page.context.close()

    body = b"--x\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nA\r\n--x--\r\n"
    req = urllib.request.Request(BASE + "/api/quote", data=body, method="POST", headers={"Content-Type": "multipart/form-data; boundary=x", "Origin": "https://evil.example", "X-Halvek-Form": "1"})
    try:
        urllib.request.urlopen(req, timeout=10)
        status = 200
    except urllib.error.HTTPError as err:
        status = err.code
    check("posts from another website refused", status == 403, str(status))

    # A chunked upload has no Content-Length, so the size is counted as it arrives.
    import http.client

    def chunks():
        yield b"--x\r\nContent-Disposition: form-data; name=\"details\"\r\n\r\n"
        for _ in range(100):
            yield b"a" * 100_000
        yield b"\r\n--x--\r\n"

    conn = http.client.HTTPConnection("127.0.0.1", DEV_PORT, timeout=60)
    try:
        conn.request("POST", "/api/quote", body=chunks(), encode_chunked=True, headers={
            "Content-Type": "multipart/form-data; boundary=x", "Origin": BASE, "X-Halvek-Form": "1", "X-Turnstile-Token": "XXXX.DUMMY.TOKEN.z", "Transfer-Encoding": "chunked"})
        chunked_status = conn.getresponse().status
    except Exception as err:
        chunked_status = repr(err)
    finally:
        conn.close()
    check("oversized chunked upload refused", chunked_status == 413, str(chunked_status))
    req = urllib.request.Request(BASE + "/api/quote", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            final = r.geturl()
    except urllib.error.HTTPError as err:
        final = str(err.code)
    check("opening /api/quote in a browser lands on the form", final.endswith("/#start") or final.endswith("/"), final)

    page = new_page(browser, js=False)
    check("no-JavaScript note shown", "needs JavaScript" in page.inner_text("#start"))
    fill_required(page)
    # Playwright's usual wait for a still element needs page scripts, so press Enter instead of clicking.
    with page.expect_navigation():
        page.press("#q-name", "Enter")
    text = page.inner_text("body")
    check("no-JavaScript send gets a page that points to email", "didn't go through" in text and "quotes@halvek.co" in text, text[:200])
    page.screenshot(path=str(SHOTS / "nojs-result.png"))
    page.context.close()


def scenario_not_configured(browser):
    # Right after the first deploy the secrets aren't set yet: the form should step aside for email.
    status = json.loads(urllib.request.urlopen(BASE + "/api/quote/status", timeout=10).read())
    check("status says not ready without secrets", status == {"ready": False}, str(status))
    page = new_page(browser)
    page.click("section >> text=Request a quote")
    page.wait_for_selector("#q-offline:not([hidden])", timeout=10000)
    check("form steps aside for email when not set up", page.is_hidden("#quote-form") and page.is_visible("#q-offline"))
    href = page.get_attribute("#q-offline a", "href")
    check("email route offered instead", href.startswith("mailto:quotes@halvek.co"), href)
    page.locator("#start").screenshot(path=str(SHOTS / "desktop-offline.png"))
    page.context.close()

    # Someone who filled the form before the check answered gets the email route with their details.
    page = new_page(browser)
    page.route("**/api/quote/status", lambda r: r.fulfill(status=200, content_type="application/json", body='{"ready": true}'))
    fill_required(page)
    page.click("#quote-form button[type=submit]")
    page.wait_for_selector("#q-offline:not([hidden])", timeout=20000)
    href = page.get_attribute("#q-offline a", "href")
    check("details carried into the email when sending fails for setup", "Test%20Client" in href, href[:100])
    page.context.close()


def scenario_rate_limit(browser):
    page = new_page(browser)
    statuses = page.evaluate(
        """async () => {
          const out = [];
          for (let i = 0; i < 7; i++) {
            const d = new FormData(); d.append('name', 'A');
            const r = await fetch('/api/quote', { method: 'POST', body: d, headers: { 'X-Halvek-Form': '1' } });
            out.push(r.status);
          }
          return out;
        }"""
    )
    check("sixth request in a minute is rate-limited", 429 in statuses[5:] and 429 not in statuses[:5], str(statuses))
    page.context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    export_test_site()
    make_files()
    mock_proc = subprocess.Popen([sys.executable, "-I", str(ROOT / "test" / "mock_server.py"), str(MOCK_PORT)], start_new_session=True)
    wait_for(MOCK + "/emails", 10)
    dev = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM) if Path(CHROMIUM).exists() else p.chromium.launch()
            write_config(rate_limit=1000)
            dev = start_dev()
            scenarios = (scenario_layout_and_validation, scenario_full_send, scenario_file_limits, scenario_failures, scenario_partial_failure, scenario_direct_requests)
            only = os.environ.get("ONLY")
            for scenario in scenarios:
                if only and only not in scenario.__name__:
                    continue
                try:
                    scenario(browser)
                except Exception as err:  # keep going so one broken step doesn't hide the rest
                    check(f"{scenario.__name__} ran to the end", False, repr(err)[:300])
            stop(dev)
            if os.environ.get("ONLY"):
                browser.close()
                return finish()
            write_config(rate_limit=5)
            dev = start_dev()
            try:
                scenario_rate_limit(browser)
            except Exception as err:
                check("scenario_rate_limit ran to the end", False, repr(err)[:300])
            stop(dev)
            write_config(rate_limit=1000, configured=False)
            dev = start_dev()
            try:
                scenario_not_configured(browser)
            except Exception as err:
                check("scenario_not_configured ran to the end", False, repr(err)[:300])
            browser.close()
    finally:
        stop(dev)
        stop(mock_proc)
    finish()


def finish():
    failed = [r for r in results if not r["ok"]]
    (OUT / "report.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
