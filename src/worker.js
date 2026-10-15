// halvek.co: serves the static site in ./public and handles POST /api/quote,
// which checks a quote request and emails it to quotes@halvek.co through ZeptoMail.
//
// Secrets (set in the Cloudflare dashboard or with `wrangler secret put`):
//   TURNSTILE_SECRET_KEY  secret key of the Turnstile widget on the form
//   ZEPTOMAIL_TOKEN       Send Mail token of the ZeptoMail Mail Agent
// Variables (wrangler.jsonc): QUOTE_TO, QUOTE_FROM, ALLOWED_HOSTNAMES.
// ZEPTOMAIL_URL and TURNSTILE_VERIFY_URL exist only so local tests can point at a mock.

import { Buffer } from "node:buffer";

const MAX_BODY_BYTES = 8 * 1024 * 1024; // whole request
// Attachments are base64-encoded here, which costs CPU time, and the Workers free plan allows
// 10 ms per request. Photos are resized in the browser first (about 300-600 KB each), so 5 MB
// covers a full set of eight.
const MAX_FILES = 8;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 5 * 1024 * 1024;

const FIELD_LIMITS = {
  name: 100,
  email: 254,
  details: 5000,
  measurements: 2000,
  environment: 500,
  quantity: 100,
  deadline: 100,
};
const PACKAGES = ["Fitment part", "Replacement part", "Product design", "Printed copies", "Not sure"];

const ZEPTOMAIL_URL = "https://api.zeptomail.com/v1.1/email";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "quote";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/quote") return handleQuote(request, env);
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(request, env) {
  const ref = crypto.randomUUID().slice(0, 8);
  const fromScript = request.headers.get("X-Halvek-Form") === "1";
  const reply = (status, error = null, extra = {}) =>
    fromScript ? json({ ok: !error, error, ref, ...extra }, status) : resultPage(status, error, env);

  if (request.method !== "POST") {
    return new Response(null, { status: 303, headers: { Location: "/#start", "Cache-Control": "no-store" } });
  }

  const allowed = allowedHostnames(env);
  if (!originAllowed(request.headers.get("Origin"), allowed)) {
    log(ref, "rejected", { reason: "origin" });
    return reply(403, "forbidden");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) return reply(413, "too_large");

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.QUOTE_LIMITER) {
    const { success } = await env.QUOTE_LIMITER.limit({ key: ip || "unknown" });
    if (!success) {
      log(ref, "rejected", { reason: "rate_limit" });
      return reply(429, "rate_limited");
    }
  }

  if (!env.TURNSTILE_SECRET_KEY || !env.ZEPTOMAIL_TOKEN) {
    log(ref, "error", { reason: "not_configured" });
    return reply(503, "not_configured");
  }

  // The form script sends the Turnstile token in a header, so it is checked before the body
  // (photos included) is read: bots are turned away cheaply, and a slow upload can't outlast
  // the token's five minutes.
  const token = request.headers.get("X-Turnstile-Token") || "";
  if (!token || token.length > 2048) return reply(403, "challenge_missing");
  const challenge = await verifyTurnstile(token, ip, allowed, env);
  if (!challenge.ok) {
    log(ref, "rejected", { reason: "challenge", detail: challenge.detail });
    return reply(403, challenge.unavailable ? "challenge_unavailable" : "challenge_failed");
  }

  let form;
  try {
    form = await readForm(request, declaredLength === null);
  } catch {
    return reply(400, "bad_request");
  }
  if (!form) return reply(413, "too_large");

  const fields = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    fields[key] = clean(form.get(key));
    if (fields[key].length > max) return reply(400, "field_too_long", { field: key });
  }
  for (const key of ["name", "email", "quantity", "deadline", "environment"]) fields[key] = oneLine(fields[key]);
  const pkg = text(form.get("package"));
  fields.package = PACKAGES.includes(pkg) ? pkg : "";

  for (const key of ["name", "email", "details"]) {
    if (!fields[key]) return reply(422, "missing_field", { field: key });
  }
  if (!looksLikeEmail(fields.email)) return reply(422, "bad_email", { field: "email" });

  const uploads = form.getAll("files").filter((f) => typeof f === "object" && f !== null && f.size > 0);
  if (uploads.length > MAX_FILES) return reply(413, "too_many_files");
  const attachments = [];
  let totalBytes = 0;
  for (const file of uploads) {
    if (file.size > MAX_FILE_BYTES) return reply(413, "file_too_large", { file: shortName(file.name) });
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) return reply(413, "files_too_large");
    const type = sniffType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!type) return reply(415, "bad_file_type", { file: shortName(file.name) });
    attachments.push({ file, type, size: file.size, name: attachmentName(file.name, type, attachments.length + 1) });
  }

  // A hidden field people never see. Bots fill it, but so can a browser's autofill, so a request
  // that passed Turnstile is still delivered, marked for a second look.
  const trapped = Boolean(text(form.get("hv_trap")));

  const result = await deliver({ fields, attachments, ref, env, trapped });
  if (!result.ok) {
    // Both tries failed. The log keeps enough to answer the client by hand (Workers Logs, 3 days).
    log(ref, "lost", {
      name: fields.name,
      email: fields.email,
      details: clip(oneLine(fields.details), 600),
      files: attachments.map((a) => a.name),
      first: result.first,
      second: result.second,
    });
    return reply(502, "send_failed");
  }
  log(ref, "sent", { files: attachments.length, bytes: totalBytes, trapped, filesDropped: result.filesDropped });
  return reply(200, null, result.filesDropped ? { warning: "files_not_attached" } : {});
}

// ---- Reading the request --------------------------------------------------

// Parses the form. Requests without a Content-Length (chunked) are read with a running count,
// so they can't get past the size limit; the result is null when they go over.
async function readForm(request, chunked) {
  if (!chunked) return request.formData();
  if (!request.body) return new FormData();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), {
    headers: { "Content-Type": request.headers.get("Content-Type") || "" },
  }).formData();
}

// ---- Checks ---------------------------------------------------------------

function allowedHostnames(env) {
  return new Set(
    String(env.ALLOWED_HOSTNAMES || "halvek.co")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function originAllowed(origin, allowed) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) return false;
  return allowed.has(url.hostname);
}

async function verifyTurnstile(token, ip, allowed, env) {
  const fields = { secret: env.TURNSTILE_SECRET_KEY, response: token, idempotency_key: crypto.randomUUID() };
  if (ip) fields.remoteip = ip;
  let result;
  // One retry on a dropped connection or a server error. The idempotency key lets siteverify
  // answer the retry instead of rejecting the token as already used.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(env.TURNSTILE_VERIFY_URL || TURNSTILE_VERIFY_URL, {
        method: "POST",
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        result = await res.json();
        break;
      }
      if (attempt === 2 || res.status < 500) return { ok: false, unavailable: true, detail: `http_${res.status}` };
    } catch (err) {
      if (attempt === 2 || (err && err.name === "TimeoutError")) return { ok: false, unavailable: true, detail: err && err.name };
    }
  }
  if (!result.success) return { ok: false, detail: (result["error-codes"] || []).join(",") || "failed" };
  if (result.action !== TURNSTILE_ACTION) return { ok: false, detail: "action" };
  if (!allowed.has(String(result.hostname || "").toLowerCase())) return { ok: false, detail: "hostname" };
  return { ok: true };
}

// Plain ASCII addresses only: name@example.com, no leading, trailing or doubled dots.
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function looksLikeEmail(value) {
  return value.length <= 254 && value.indexOf("@") <= 64 && EMAIL_PATTERN.test(value);
}

// The first bytes of a file say what it is, whatever its name or the browser claims.
function sniffType(b) {
  const at = (offset, ...values) => values.every((v, i) => b[offset + i] === v);
  const ascii = (offset, length) => String.fromCharCode(...b.subarray(offset, offset + length));
  if (b.length < 12) return null;
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heif";
    if (["avif", "avis"].includes(brand)) return "image/avif";
  }
  return null;
}

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
};

// A safe name with the extension that matches the contents. Direction-control characters are
// removed so a name can't pretend to be something else ("photo‮gpj.pdf" shows as photofdp.jpg).
function attachmentName(original, type, index) {
  let base = String(original || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[\p{Cc}\p{Cf}"<>|:*?\\/]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .trim()
    .slice(0, 80);
  if (!base) base = `file-${index}`;
  return `${base}.${EXTENSIONS[type]}`;
}

function shortName(name) {
  return String(name || "")
    .replace(/^.*[\\/]/, "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, "")
    .slice(0, 80);
}

// ---- Email ----------------------------------------------------------------

// Sends the request. If ZeptoMail refuses it, a second, text-only copy goes out without
// Reply-To or attachments, so a bad address or an odd file can't lose the lead.
async function deliver({ fields, attachments, ref, env, trapped }) {
  const fullBody = await buildBody(fields, attachments, ref, env, { trapped });
  let first = await zeptoSend(fullBody, env, 25_000);
  // A dropped connection says nothing about the email itself, so the full email gets one more try.
  if (!first.ok && first.status === 0 && first.detail !== "TimeoutError") first = await zeptoSend(fullBody, env, 25_000);
  if (first.ok) return { ok: true };
  log(ref, "retrying", { status: first.status, detail: first.detail });
  const note = `ZeptoMail refused the full request (${first.status || "no answer"}${first.detail ? `, ${first.detail}` : ""}), so this copy has no attachments and no Reply-To. Write to ${fields.email} directly${attachments.length ? " and ask for the files again" : ""}.`;
  const second = await zeptoSend(await buildBody(fields, [], ref, env, { trapped, note, listedFiles: attachments, noReplyTo: true }), env, 15_000);
  if (second.ok) return { ok: true, filesDropped: attachments.length > 0 };
  return { ok: false, first, second };
}

async function buildBody(fields, attachments, ref, env, { trapped = false, note = "", listedFiles = attachments, noReplyTo = false }) {
  const to = env.QUOTE_TO || "quotes@halvek.co";
  const from = env.QUOTE_FROM || "website@halvek.co";
  const summary = clip(oneLine(fields.details), 70);
  const notes = [];
  if (trapped) notes.push("The hidden anti-spam field was filled in. This may be spam, or a browser's autofill; check before replying.");
  if (note) notes.push(note);
  const payload = {
    from: { address: from, name: "Halvek quote form" },
    to: [{ email_address: { address: to, name: "Halvek" } }],
    subject: clip(`${trapped ? "[Check] " : ""}Quote request from ${fields.name}: ${summary}`, 200),
    htmlbody: emailHtml(fields, listedFiles, ref, notes),
    textbody: emailText(fields, listedFiles, ref, notes),
    track_opens: false,
    track_clicks: false,
    client_reference: `halvek-quote-${ref}`,
  };
  if (!noReplyTo) payload.reply_to = [{ address: fields.email, name: clip(fields.name, 100) }];
  if (!attachments.length) return JSON.stringify(payload);

  // File contents are base64-encoded and spliced into the JSON in pieces rather than run
  // through JSON.stringify, which keeps CPU time down.
  const nonce = crypto.randomUUID();
  payload.attachments = attachments.map((a, i) => ({ name: a.name, mime_type: a.type, content: `@@${nonce}-${i}@@` }));
  let rest = JSON.stringify(payload);
  const parts = [];
  for (let i = 0; i < attachments.length; i++) {
    const marker = `@@${nonce}-${i}@@`;
    const at = rest.indexOf(marker);
    const bytes = await attachments[i].file.arrayBuffer();
    parts.push(rest.slice(0, at), Buffer.from(bytes).toString("base64"));
    rest = rest.slice(at + marker.length);
  }
  parts.push(rest);
  return new Blob(parts, { type: "application/json" });
}

async function zeptoSend(body, env, timeoutMs) {
  try {
    const res = await fetch(env.ZEPTOMAIL_URL || ZEPTOMAIL_URL, {
      method: "POST",
      headers: {
        Authorization: zeptoAuth(env.ZEPTOMAIL_TOKEN),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    let detail = "";
    try {
      const answer = await res.json();
      const err = answer && (answer.error || answer.data);
      detail = [err && err.code, err && err.error_code, err && Array.isArray(err.details) && err.details.map((d) => d.code).join("+")]
        .filter(Boolean)
        .join(" ");
    } catch {
      // Not JSON; the status says enough.
    }
    return { ok: false, status: res.status, detail };
  } catch (err) {
    return { ok: false, status: 0, detail: err && err.name };
  }
}

function zeptoAuth(token) {
  const t = String(token || "").trim();
  return /^zoho-enczapikey\s/i.test(t) ? t : `Zoho-enczapikey ${t}`;
}

function rows(fields, files) {
  const listed = files.length ? files.map((a) => `${a.name} (${formatBytes(a.size)})`).join("\n") : "None";
  return [
    ["Name", fields.name],
    ["Email", fields.email],
    ["Package", fields.package || "Not chosen"],
    ["What they need", fields.details],
    ["Key measurements", fields.measurements],
    ["Where it lives", fields.environment],
    ["Quantity", fields.quantity],
    ["Deadline", fields.deadline],
    ["Files", listed],
  ];
}

function emailHtml(fields, files, ref, notes) {
  const cell = "padding:10px 0;border-top:1px solid #D9D7D0;vertical-align:top;";
  const body = rows(fields, files)
    .map(([label, value]) => {
      const shown = value
        ? label === "Email"
          ? `<a href="mailto:${escapeHtml(value)}" style="color:#121212;">${escapeHtml(value)}</a>`
          : escapeHtml(value)
        : '<span style="color:#5A5A57;">Not given</span>';
      return `<tr><th align="left" style="${cell}width:150px;padding-right:16px;font-weight:600;">${label}</th><td style="${cell}white-space:pre-wrap;">${shown}</td></tr>`;
    })
    .join("");
  const noteHtml = notes.map((n) => `<p style="margin:0 0 16px;padding:10px 12px;background:#E7E5DF;">${escapeHtml(n)}</p>`).join("");
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#121212;">
${noteHtml}<p style="margin:0 0 16px;">New quote request from the form at halvek.co. Reply to this email to answer ${escapeHtml(fields.name)} directly.</p>
<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;width:100%;max-width:680px;border-bottom:1px solid #D9D7D0;">${body}</table>
<p style="margin:16px 0 0;font-size:12px;color:#5A5A57;">Ref ${ref} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</p>
</div>`;
}

function emailText(fields, files, ref, notes) {
  const lines = rows(fields, files).map(([label, value]) => `${label}:\n${value || "Not given"}\n`);
  const noteText = notes.map((n) => `NOTE: ${n}\n\n`).join("");
  return `${noteText}New quote request from the form at halvek.co. Reply to this email to answer ${fields.name} directly.\n\n${lines.join("\n")}\nRef ${ref}\n`;
}

// ---- Helpers --------------------------------------------------------------

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value) {
  return text(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n");
}

function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function formatBytes(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function log(ref, event, data = {}) {
  console.log(JSON.stringify({ ref, event, ...data }));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Shown only when the form was posted without JavaScript (the script normally handles the reply).
function resultPage(status, error, env) {
  const email = env.QUOTE_TO || "quotes@halvek.co";
  const ok = !error;
  const title = ok ? "Request sent" : "That didn't go through";
  const message = ok
    ? `You'll hear back from ${email} within two business days, with a quote or a few questions.`
    : `Please email the same details, with your photos attached, to <a href="mailto:${email}?subject=Quote%20request" style="color:#121212;text-decoration-color:#A4472A;text-decoration-thickness:2px;text-underline-offset:5px;">${email}</a>.`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Halvek</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap">
</head>
<body style="margin:0;background:#F6F5F1;color:#121212;font-family:'Instrument Sans','Helvetica Neue',Helvetica,sans-serif;font-size:17px;line-height:1.55;">
<header style="max-width:1280px;margin:0 auto;padding:22px clamp(20px,5vw,72px);"><a href="/" style="font-size:22px;font-weight:600;letter-spacing:-0.02em;line-height:1;color:#121212;text-decoration:none;">Halvek</a></header>
<main style="max-width:1280px;margin:0 auto;padding:clamp(32px,5vw,72px) clamp(20px,5vw,72px);display:flex;flex-direction:column;gap:22px;">
<h1 style="margin:0;font-size:clamp(32px,4.5vw,56px);font-weight:500;line-height:1.05;letter-spacing:-0.03em;">${title}</h1>
<p style="margin:0;max-width:34em;font-size:18px;">${message}</p>
<a href="/" style="align-self:flex-start;color:#121212;font-weight:500;text-decoration:underline;text-decoration-color:#A4472A;text-decoration-thickness:2px;text-underline-offset:5px;padding:10px 0;">Back to halvek.co</a>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
