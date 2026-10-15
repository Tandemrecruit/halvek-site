// halvek.co quote form: checks the fields, shrinks photos in the browser, and sends the
// request to /api/quote. Without this script the form still posts, and the server answers
// with a page that points to email.
(function () {
  "use strict";

  var form = document.getElementById("quote-form");
  if (!form || !window.FormData || !window.XMLHttpRequest || !window.Promise || !window.URL) return;

  var EMAIL = "quotes@halvek.co";
  var MAX_FILES = 8;
  var MAX_SOURCE_PIXELS = 50e6; // bigger photos can run a phone out of memory while decoding
  var MAX_SEND_BYTES = 5 * 1024 * 1024; // one file as sent (the server enforces the same)
  var MAX_TOTAL_BYTES = 5 * 1024 * 1024; // all files together (the server enforces the same)
  var KEEP_AS_IS_BYTES = 1024 * 1024; // small PNG, GIF and WebP drawings are sent untouched, so fine lines stay sharp
  var MAX_EDGE = 1600; // longest side of a resized photo, in pixels
  var JPEG_QUALITY = 0.8;
  var TOKEN_MAX_AGE = 240000; // Turnstile tokens last 300 s; older ones are replaced before sending
  var TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=hvTurnstileReady";

  var el = function (id) { return document.getElementById(id); };
  var fileInput = el("q-files");
  var fileField = fileInput.parentNode;
  var fileList = el("q-file-list");
  var filesError = el("q-files-error");
  var filesStatus = el("q-files-status");
  var status = el("q-status");
  var button = form.querySelector('button[type="submit"]');
  var buttonLabel = button.textContent;
  var sent = el("q-sent");
  var sentNote = el("q-sent-note");
  var again = el("q-again");
  var turnstileBox = el("q-turnstile");

  var items = [];
  var nextId = 1;
  var busy = false;
  var filesNotice = ""; // a one-off message about the files, cleared when the list changes
  var queue = Promise.resolve(); // photos are prepared one at a time to keep memory down on phones

  // ---- Field checks ---------------------------------------------------------

  var EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

  var checks = [
    { id: "q-name", test: function (v) { return v ? "" : "Add your name."; } },
    {
      id: "q-email",
      test: function (v) {
        if (!v) return "Add your email address, so the quote has somewhere to go.";
        return EMAIL_PATTERN.test(v) && v.indexOf("@") <= 64 ? "" : "That email address doesn't look right. Check it for typos.";
      },
    },
    { id: "q-details", test: function (v) { return v ? "" : "Describe what you need. A sentence or two is enough to start."; } },
  ];

  function setFieldError(input, message) {
    var error = el(input.id + "-error");
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (!error) return;
    error.textContent = message || "";
    error.hidden = !message;
  }

  function checkFields() {
    var first = null;
    checks.forEach(function (c) {
      var input = el(c.id);
      var message = c.test(input.value.trim());
      setFieldError(input, message);
      if (message && !first) first = input;
    });
    return first;
  }

  checks.forEach(function (c) {
    var input = el(c.id);
    input.addEventListener("input", function () {
      if (input.getAttribute("aria-invalid") === "true" && !c.test(input.value.trim())) setFieldError(input, "");
    });
    input.addEventListener("blur", function () {
      // Only re-checked on leaving once a field has been flagged, so nobody is scolded mid-form.
      if (input.getAttribute("aria-invalid") === "true") setFieldError(input, c.test(input.value.trim()));
    });
  });

  // ---- Files ----------------------------------------------------------------

  function formatBytes(n) {
    return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function baseName(name) {
    return String(name || "file").replace(/\.[A-Za-z0-9]{1,5}$/, "") || "file";
  }

  function isPdf(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function isSvg(file) {
    return file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name);
  }

  function isImage(file) {
    return /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name);
  }

  function isLosslessDrawing(file) {
    return /^image\/(png|gif|webp)$/.test(file.type) || /\.(png|gif|webp)$/i.test(file.name);
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  // Redraws a photo at no more than MAX_EDGE pixels on its longest side. Redrawing also drops
  // the camera metadata, including the GPS position phones store in photos.
  function shrink(file) {
    return loadImage(file).then(function (loaded) {
      var img = loaded.img;
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      if (w * h > MAX_SOURCE_PIXELS) {
        URL.revokeObjectURL(loaded.url);
        throw new Error("pixels");
      }
      var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF"; // transparent drawings get a white background, not black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(loaded.url);
      img.src = "";
      return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY); }).then(function (blob) {
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("encode");
        return blob;
      });
    });
  }

  function prepare(item) {
    var file = item.file;
    if (isPdf(file)) {
      if (file.size > MAX_SEND_BYTES) return Promise.reject(new Error("big"));
      return Promise.resolve({ blob: file, name: file.name, preview: false });
    }
    if (isSvg(file)) return Promise.reject(new Error("svg"));
    if (!isImage(file)) return Promise.reject(new Error("type"));
    if (isLosslessDrawing(file) && file.size <= KEEP_AS_IS_BYTES) {
      return Promise.resolve({ blob: file, name: file.name, preview: true });
    }
    return shrink(file).then(
      function (blob) {
        if (blob.size > MAX_SEND_BYTES) throw new Error("big");
        return { blob: blob, name: baseName(file.name) + ".jpg", preview: true };
      },
      function (err) {
        if (err && err.message === "pixels") throw new Error("big");
        // This browser can't read the format (HEIC outside Safari, for example). Send it as it is.
        if (file.size > MAX_SEND_BYTES) throw new Error("big");
        return { blob: file, name: file.name, preview: false };
      }
    );
  }

  var PROBLEMS = {
    svg: "SVG files can't be sent here. Save it as a PDF or PNG, or email it to " + EMAIL + ".",
    type: "Not a photo or PDF. Remove it, or email it to " + EMAIL + ".",
    big: "Too large to send here. Remove it, and email it to " + EMAIL + " after you hear back.",
  };

  function addFiles(fileArray) {
    clearStatus();
    var room = MAX_FILES - items.length;
    var accepted = Array.prototype.slice.call(fileArray, 0, Math.max(0, room));
    var skipped = fileArray.length - accepted.length;
    filesNotice = skipped > 0
      ? "Up to " + MAX_FILES + " files. " + (skipped === 1 ? "One file was" : skipped + " files were") + " left out; you can email extras to " + EMAIL + "."
      : "";
    accepted.forEach(function (file) {
      var item = { id: nextId++, file: file, state: "working", name: file.name, size: file.size, blob: null, thumb: null, problem: "" };
      items.push(item);
      var job = queue.then(function () {
        if (items.indexOf(item) === -1) return null; // removed while waiting
        return prepare(item).then(
          function (result) {
            item.state = "ready";
            item.blob = result.blob;
            item.name = result.name;
            item.size = result.blob.size;
            if (result.preview) item.thumb = URL.createObjectURL(result.blob);
          },
          function (err) {
            item.state = "error";
            item.problem = PROBLEMS[err && err.message] || PROBLEMS.big;
          }
        );
      });
      // Always settles, so one odd file can't hold up the files after it or the send button.
      item.ready = queue = job
        .catch(function () {
          if (item.state === "working") {
            item.state = "error";
            item.problem = PROBLEMS.big;
          }
        })
        .then(function () {
          renderFiles();
          if (items.every(function (i) { return i.state !== "working"; })) announceFiles();
        })
        .catch(function () { /* nothing left to do */ });
    });
    renderFiles();
    if (accepted.length) announce(accepted.length === 1 ? "Adding 1 file." : "Adding " + accepted.length + " files.");
  }

  function announce(message) {
    filesStatus.textContent = "";
    setTimeout(function () { filesStatus.textContent = message; }, 60);
  }

  function announceFiles() {
    var ready = items.filter(function (i) { return i.state === "ready"; }).length;
    var failed = items.length - ready;
    var message = ready === 1 ? "1 file ready." : ready + " files ready.";
    if (failed) message += " " + (failed === 1 ? "1 file can't be sent." : failed + " files can't be sent.");
    announce(message);
  }

  function removeItem(id) {
    var index = -1;
    items = items.filter(function (item, i) {
      if (item.id === id) {
        index = i;
        if (item.thumb) URL.revokeObjectURL(item.thumb);
      }
      return item.id !== id;
    });
    filesNotice = "";
    renderFiles();
    // Focus goes to the next file's Remove button, or back to the file picker.
    var next = fileList.querySelectorAll("button")[Math.min(index, items.length - 1)];
    (next || fileInput).focus();
  }

  function clearFiles() {
    items.forEach(function (item) { if (item.thumb) URL.revokeObjectURL(item.thumb); });
    items = [];
    renderFiles();
  }

  function totalBytes() {
    return items.reduce(function (sum, item) { return item.state === "ready" ? sum + item.size : sum; }, 0);
  }

  function showFilesError(message) {
    filesError.textContent = message || "";
    filesError.hidden = !message;
  }

  function fileProblem() {
    if (items.some(function (item) { return item.state === "error"; })) {
      return "Remove the files marked above before sending.";
    }
    if (totalBytes() > MAX_TOTAL_BYTES) {
      return "These files add up to more than 5 MB. Remove some, and email the rest to " + EMAIL + " after you hear back.";
    }
    return "";
  }

  function renderFiles() {
    // Rebuilding the list would drop keyboard focus, so remember which Remove button had it.
    var focused = document.activeElement && fileList.contains(document.activeElement) ? document.activeElement.getAttribute("data-id") : null;
    fileList.textContent = "";
    items.forEach(function (item) {
      var li = document.createElement("li");

      var thumb = document.createElement("span");
      thumb.className = "hv-thumb";
      thumb.setAttribute("aria-hidden", "true");
      if (item.thumb) {
        var img = document.createElement("img");
        img.src = item.thumb;
        img.alt = "";
        thumb.appendChild(img);
      } else {
        var ext = item.name.match(/\.([A-Za-z0-9]{1,5})$/);
        thumb.textContent = (ext ? ext[1] : "File").toUpperCase().slice(0, 4);
      }

      var label = document.createElement("span");
      label.className = "hv-name";
      var name = document.createElement("span");
      name.textContent = item.name;
      var detail = document.createElement("span");
      if (item.state === "working") {
        detail.className = "hv-size";
        detail.textContent = "Preparing";
      } else if (item.state === "error") {
        detail.className = "hv-error";
        detail.style.fontSize = "14px";
        detail.style.whiteSpace = "normal";
        detail.textContent = item.problem;
      } else {
        detail.className = "hv-size";
        detail.textContent = formatBytes(item.size);
      }
      label.appendChild(name);
      label.appendChild(detail);

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "hv-link";
      remove.textContent = "Remove";
      remove.setAttribute("data-id", String(item.id));
      remove.setAttribute("aria-label", "Remove " + item.name);
      remove.addEventListener("click", function () { removeItem(item.id); });

      li.appendChild(thumb);
      li.appendChild(label);
      li.appendChild(remove);
      fileList.appendChild(li);
    });
    fileList.hidden = items.length === 0;
    showFilesError(fileProblem() || filesNotice);
    if (focused) {
      var refocus = fileList.querySelector('button[data-id="' + focused + '"]');
      if (refocus) refocus.focus();
    }
  }

  fileInput.addEventListener("change", function () {
    var picked = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
    fileInput.value = "";
    if (picked.length) addFiles(picked);
  });

  // Photos can be dropped onto the field on a computer. A drop that misses the field is
  // ignored rather than opening the photo in place of the page (and losing the form).
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1;
  }
  ["dragenter", "dragover"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = fileField.contains(e.target) ? "copy" : "none";
    });
  });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (fileField.contains(e.target) && !form.hidden && e.dataTransfer.files.length) {
      addFiles(Array.prototype.slice.call(e.dataTransfer.files));
    }
  });

  // ---- Turnstile ------------------------------------------------------------

  var turnstile = { started: false, loadFailed: false, widget: null, token: "", tokenAt: 0, waiters: [] };

  function settleToken(token) {
    turnstile.token = token;
    turnstile.tokenAt = token ? Date.now() : 0;
    var waiters = turnstile.waiters;
    turnstile.waiters = [];
    waiters.forEach(function (resolve) { resolve(token); });
  }

  window.hvTurnstileReady = function () {
    try {
      turnstile.widget = window.turnstile.render(turnstileBox, {
        sitekey: turnstileBox.getAttribute("data-sitekey"),
        action: "quote",
        appearance: "interaction-only",
        theme: "light",
        size: "flexible",
        "response-field": false,
        callback: function (token) { settleToken(token); },
        "expired-callback": function () { turnstile.token = ""; },
        "error-callback": function () {
          // Release a waiting send now instead of letting it sit; Turnstile retries on its own.
          settleToken("");
        },
      });
    } catch (err) {
      settleToken("");
    }
  };

  function startTurnstile() {
    if (turnstile.started) return;
    turnstile.started = true;
    turnstile.loadFailed = false;
    var script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onerror = function () {
      // Allow another try on the next send; the connection may come back.
      script.remove();
      turnstile.started = false;
      turnstile.loadFailed = true;
      settleToken("");
    };
    document.head.appendChild(script);
  }

  function resetTurnstile() {
    turnstile.token = "";
    turnstile.tokenAt = 0;
    if (turnstile.widget !== null && window.turnstile) {
      try { window.turnstile.reset(turnstile.widget); } catch (err) { /* a fresh token arrives on the next load */ }
    }
  }

  function getToken(timeoutMs) {
    if (turnstile.token && Date.now() - turnstile.tokenAt < TOKEN_MAX_AGE) return Promise.resolve(turnstile.token);
    if (turnstile.token) resetTurnstile(); // too close to expiring; get a fresh one
    startTurnstile();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (token) { if (!done) { done = true; resolve(token); } };
      turnstile.waiters.push(finish);
      setTimeout(function () { finish(turnstile.token); }, timeoutMs);
    });
  }

  // Load the check once someone is near the form, so it has usually finished by the time they send.
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) {
        observer.disconnect();
        startTurnstile();
      }
    }, { rootMargin: "800px 0px" });
    observer.observe(form);
  }
  form.addEventListener("focusin", function () { startTurnstile(); });

  // ---- Status and sending ---------------------------------------------------

  function clearStatus() {
    status.textContent = "";
  }

  function showStatus(message, withEmailLink) {
    status.textContent = "";
    // Filled a moment later, so screen readers notice the change and read it out.
    setTimeout(function () {
      status.textContent = message;
      if (withEmailLink) {
        status.appendChild(document.createTextNode(" "));
        var link = document.createElement("a");
        link.href = mailtoHref();
        link.textContent = "email it instead";
        status.appendChild(link);
        status.appendChild(document.createTextNode("."));
      }
    }, 60);
  }

  function mailtoHref() {
    var f = form.elements;
    var pkg = form.querySelector('input[name="package"]:checked');
    var parts = [
      ["Name", f.name.value],
      ["Package", pkg ? pkg.value : ""],
      ["What I need", f.details.value],
      ["Key measurements", f.measurements.value],
      ["Where it lives", f.environment.value],
      ["Quantity", f.quantity.value],
      ["Deadline", f.deadline.value],
    ]
      .filter(function (p) { return p[1].trim(); })
      .map(function (p) { return p[0] + ": " + p[1].trim(); });
    var body = parts.join("\n\n");
    if (body.length > 1500) body = body.slice(0, 1500) + "…";
    if (items.length) body += "\n\n(Attach your photos to this email before sending.)";
    return "mailto:" + EMAIL + "?subject=" + encodeURIComponent("Quote request") + "&body=" + encodeURIComponent(body);
  }

  function setBusy(on, label) {
    busy = on;
    if (on) {
      button.setAttribute("aria-disabled", "true");
      button.textContent = label || "Sending";
    } else {
      button.removeAttribute("aria-disabled");
      button.textContent = buttonLabel;
    }
  }

  function post(data, token) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", form.getAttribute("action") || "/api/quote");
      xhr.setRequestHeader("X-Halvek-Form", "1");
      xhr.setRequestHeader("X-Turnstile-Token", token);
      xhr.timeout = 180000;
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && e.total > 200000) {
          var pct = Math.floor((e.loaded / e.total) * 100);
          button.textContent = pct < 100 ? "Sending, " + pct + "%" : "Sending";
        }
      };
      // loadend fires after every outcome (done, failed, timed out or stopped), so the form never stays stuck.
      xhr.onloadend = function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (err) { body = null; }
        resolve({ status: xhr.status, body: body });
      };
      xhr.send(data);
    });
  }

  var SERVER_MESSAGES = {
    rate_limited: "Too many tries in a row. Wait a minute, then send again.",
    challenge_failed: "The spam check didn't pass. Send again, or",
    challenge_missing: "The spam check didn't finish. Send again, or",
    challenge_unavailable: "The spam check couldn't be reached. Try again in a minute, or",
    too_large: "The files are too large to send here. Remove some, and email the rest to " + EMAIL + " after you hear back.",
    files_too_large: "These files add up to more than 5 MB. Remove some, and email the rest to " + EMAIL + " after you hear back.",
    too_many_files: "Up to " + MAX_FILES + " files. Remove some, and email the rest to " + EMAIL + ".",
  };

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return;
    clearStatus();

    var invalid = checkFields();
    if (invalid) {
      invalid.focus();
      return;
    }

    setBusy(true, items.some(function (i) { return i.state === "working"; }) ? "Preparing photos" : "Sending");
    Promise.all(items.map(function (i) { return i.ready; }))
      .then(function () {
        var problem = fileProblem();
        if (problem) {
          showFilesError(problem);
          setBusy(false);
          fileInput.focus();
          return null;
        }
        button.textContent = "Sending";
        return getToken(25000).then(function (token) {
          if (!token) {
            setBusy(false);
            showStatus(
              turnstile.loadFailed
                ? "The spam check couldn't load, so the form can't send. Check your connection and send again, or"
                : "Finish the check above the button, then send again. If it doesn't appear,",
              true
            );
            return null;
          }
          var data = new FormData();
          ["name", "email", "details", "measurements", "environment", "quantity", "deadline", "hv_trap"].forEach(function (key) {
            data.append(key, form.elements[key].value);
          });
          var pkg = form.querySelector('input[name="package"]:checked');
          if (pkg) data.append("package", pkg.value);
          var withFiles = false;
          items.forEach(function (item) {
            if (item.state === "ready") {
              data.append("files", item.blob, item.name);
              withFiles = true;
            }
          });
          resetTurnstile(); // each token works once; the next try needs a new one
          return post(data, token).then(function (res) { handleResponse(res, withFiles); });
        });
      })
      .catch(function () {
        setBusy(false);
        showStatus("Something went wrong on this page. Your details are still here, so try again, or", true);
      });
  });

  function handleResponse(res, withFiles) {
    var body = res.body || {};
    if (res.status >= 200 && res.status < 300 && body.ok) {
      showSent(body.warning === "files_not_attached");
      return;
    }
    setBusy(false);
    var code = body.error || "";
    var input = body.field ? el("q-" + body.field) : null;
    if (input) {
      var message = code === "bad_email"
        ? "That email address doesn't look right. Check it for typos."
        : code === "field_too_long" ? "This is longer than the form takes. Shorten it, or send the rest by email." : "This needs filling in.";
      if (el(input.id + "-error")) {
        setFieldError(input, message);
      } else {
        input.setAttribute("aria-invalid", "true");
        showStatus(message, false);
      }
      input.focus();
      return;
    }
    if (code === "file_too_large" || code === "bad_file_type") {
      filesNotice = (body.file || "One file") + (code === "bad_file_type" ? " isn't a photo or PDF." : " is too large to send here.") + " Remove it, and email it to " + EMAIL + ".";
      showFilesError(filesNotice);
      fileInput.focus();
      return;
    }
    var known = SERVER_MESSAGES[code];
    if (known) {
      showStatus(known, /or$|,$/.test(known));
    } else if (res.status >= 500 && !res.body && withFiles) {
      // The server gave up without its usual answer, most likely on a large upload.
      showStatus("That didn't send. Try again with fewer photos, or", true);
    } else {
      showStatus("That didn't send. Your details are still here, so try again in a minute, or", true);
    }
  }

  function showSent(filesDropped) {
    setBusy(false);
    filesNotice = "";
    clearFiles();
    form.reset();
    form.hidden = true;
    sentNote.hidden = !filesDropped;
    sent.hidden = false;
    el("q-sent-title").focus();
  }

  again.addEventListener("click", function () {
    clearStatus();
    showFilesError("");
    sent.hidden = true;
    form.hidden = false;
    el("q-name").focus();
  });
})();
