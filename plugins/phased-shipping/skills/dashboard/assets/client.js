(function () {
  "use strict";
  // The page's only script. It reloads the page, keeps the clocks running and works out Idle and No update in the
  // browser from the times written in data-t. It makes no request and builds no address, writes text with textContent
  // only, and keeps the open state of each details element, the scroll position and the focused row in sessionStorage.
  var doc = document;
  var body = doc.body;
  var ds = body.dataset;
  function bounded(v, dflt, lo, hi) { var n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : dflt; }
  var REFRESH = bounded(ds.refreshS, 10, 5, 300) * 1000;
  var WARN = bounded(ds.warnMin, 90, 1, 100000) * 60000;
  var IDLE = bounded(ds.idleMin, 180, 1, 100000) * 60000;
  var PAGE_STALE = bounded(ds.pageStaleMin, 90, 1, 100000) * 60000;
  var SLUG = /^[a-z]-[0-9a-f]{10}$/;
  var LABEL = { working: "Working", waiting: "Waiting for you", done: "Done", idle: "Idle" };
  var MARK = { working: "mk-w", waiting: "mk-q", done: "mk-d", idle: "mk-i" };

  var store = null;
  try { store = window.sessionStorage; } catch (e) { store = null; }
  // A stored open state is read as a true or false only; any other value is ignored.
  function flag(key) {
    try { var v = store.getItem(key); return v === "1" ? true : v === "0" ? false : null; } catch (e) { return null; }
  }
  function put(key, v) { try { store.setItem(key, v); } catch (e) { /* storage is off: the refresh still works */ } }
  function list(sel, root) { return [].slice.call((root || doc).querySelectorAll(sel)); }
  function setText(el, v) { if (el && el.textContent !== v) el.textContent = v; }

  function dur(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    return h + " h " + String(m % 60).padStart(2, "0") + " min";
  }
  function clock(t) {
    var d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, "0"); }).join(":");
  }

  // ---- open states, scroll and focus survive a reload ----
  var printing = false;
  list("details[data-k]").forEach(function (d) {
    try {
      var k = d.getAttribute("data-k");
      if (!SLUG.test(k)) return;
      var v = flag("pw:o:" + k);
      if (v !== null) d.open = v;
    } catch (e) { /* a bad stored open state is ignored */ }
  });
  doc.addEventListener("toggle", function (e) {
    var d = e.target;
    if (printing || !d || !d.matches || !d.matches("details[data-k]")) return;
    var k = d.getAttribute("data-k");
    if (SLUG.test(k)) put("pw:o:" + k, d.open ? "1" : "0");
  }, true);

  // ---- pause, hold and the countdown ----
  var paused = false;
  try { paused = flag("pw:paused") === true; } catch (e) { paused = false; }
  var holdUntil = 0;
  var next = Date.now() + REFRESH;
  var btn = doc.getElementById("pw-pause");
  var cd = doc.getElementById("pw-countdown");
  function paint() {
    pausedLook();
    if (!btn) return;
    setText(btn, paused ? "Resume refresh" : "Pause refresh");
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
  }
  // The paused class stops the drifting stripes (CSS only) while the refresh is paused.
  function pausedLook() { body.classList.toggle("paused", paused); }
  if (btn) {
    btn.addEventListener("click", function () {
      paused = !paused;
      put("pw:paused", paused ? "1" : "0");
      next = Date.now() + REFRESH;
      paint();
      tick();
    });
  }
  function holding() {
    var a = doc.activeElement;
    if (a && a.closest && a.closest(".t")) return true;
    if (doc.querySelector(".t:hover")) return true;
    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return true;
    return Date.now() < holdUntil;
  }

  // ---- states worked out from the times in the page ----
  function classify(now) {
    var all = { working: 0, waiting: 0, idle: 0 };
    list(".proj").forEach(function (proj) {
      var c = { working: 0, waiting: 0, idle: 0 };
      var workedSum = 0;
      list("[data-session]", proj).forEach(function (row) {
        var declared = row.getAttribute("data-declared");
        var age = now - Number(row.getAttribute("data-t"));
        var skew = row.hasAttribute("data-skew");
        var state = declared;
        if (declared !== "done" && (skew || age >= IDLE)) state = "idle";
        row.setAttribute("data-state", state);
        setText(row.querySelector("[data-label]"), LABEL[state] || "");
        var mk = row.querySelector("[data-mk]");
        if (mk) mk.className = "mk " + (MARK[state] || "");
        var warn = row.querySelector("[data-warn]");
        var showWarn = skew || (declared === "working" && state !== "idle" && age >= WARN);
        if (warn) {
          warn.hidden = !showWarn;
          if (showWarn) setText(warn.querySelector("[data-warn-text]"), skew ? "Clock skew" : "No update for " + dur(age));
        }
        var idleNote = row.querySelector("[data-idle-note]");
        if (idleNote) idleNote.hidden = state !== "idle";
        var live = state === "working" || state === "waiting";
        var worked = Number(row.getAttribute("data-w")) + (state === "working" && age > 0 ? age : 0);
        list("[data-worked]", row).forEach(function (el) { setText(el, dur(worked)); });
        setText(row.querySelector("[data-elapsed]"), dur(Number(row.getAttribute("data-e")) + (live && age > 0 ? age : 0)));
        if (live) workedSum += worked;
        if (c[state] !== undefined) c[state]++;
      });
      ["working", "waiting", "idle"].forEach(function (k) {
        all[k] += c[k];
        setText(proj.querySelector('[data-n="' + k + '"]'), String(c[k]));
      });
      setText(proj.querySelector('[data-n="active"]'), String(c.working + c.waiting));
      setText(proj.querySelector("[data-proj-worked]"), dur(workedSum));
      var stamp = proj.querySelector("[data-wait-stamp]");
      if (stamp) stamp.hidden = c.waiting === 0;
      if (c.waiting > 0) proj.setAttribute("data-attn", ""); else proj.removeAttribute("data-attn");
    });
    var sum = doc.getElementById("pw-summary");
    if (sum && sum.hasAttribute("data-live")) {
      var parts = [];
      if (all.waiting) parts.push(all.waiting + " waiting for you");
      parts.push(all.working + " working", all.idle + " idle");
      setText(sum.querySelector("[data-text]"), parts.join(" " + String.fromCharCode(183) + " "));
    }
  }

  function tick() {
    var now = Date.now();
    list("[data-since]").forEach(function (el) { setText(el, dur(now - Number(el.getAttribute("data-t")))); });
    list("[data-clock]").forEach(function (el) { setText(el, clock(Number(el.getAttribute("data-t")))); });
    classify(now);
    var written = doc.querySelector("[data-written]");
    var stale = doc.getElementById("pw-stale");
    if (written && stale) {
      var age = now - Number(written.getAttribute("data-t"));
      stale.hidden = age < PAGE_STALE;
      setText(stale.querySelector("[data-since-written]"), dur(age));
    }
    if (paused) { setText(cd, "Refresh paused"); return; }
    if (holding()) { next = Math.max(next, now + 2000); setText(cd, "Refresh held while you read"); return; }
    setText(cd, "Next refresh in " + Math.max(0, Math.ceil((next - now) / 1000)) + " s");
    if (now >= next) {
      put("pw:y", String(Math.round(window.scrollY)));
      var a = doc.activeElement;
      var holder = a && a.closest ? a.closest("details[data-k]") : null;
      if (a && a.id === "pw-pause") put("pw:focus", "pause");
      else if (holder && a.tagName === "SUMMARY" && SLUG.test(holder.getAttribute("data-k"))) put("pw:focus", holder.getAttribute("data-k"));
      else put("pw:focus", "");
      location.reload();
    }
  }

  // ---- truncated text: focusable only when it is really cut off ----
  function measure() {
    list(".t").forEach(function (t) {
      var s = t.querySelector(".t-s");
      var cut = !!s && s.scrollWidth > s.clientWidth + 1;
      t.classList.toggle("is-cut", cut);
      // A title inside a summary is not focusable (a summary is interactive already); its full text is in the page for a
      // screen reader and shows on hover.
      var inSummary = !!(t.closest && t.closest("summary"));
      if (cut && !inSummary) t.setAttribute("tabindex", "0"); else t.removeAttribute("tabindex");
    });
  }
  doc.addEventListener("keydown", function (e) {
    var a = doc.activeElement;
    if (e.key === "Escape" && a && a.classList && a.classList.contains("t")) a.classList.add("t-dismissed");
  });
  // The full-text box is fixed to the window so a scrolling table never clips it.
  function place(t) {
    if (!t || !t.classList.contains("is-cut")) return;
    var f = t.querySelector(".t-f");
    if (!f) return;
    var r = t.getBoundingClientRect();
    f.style.position = "fixed";
    f.style.top = r.top + "px";
    f.style.left = r.left + "px";
    window.requestAnimationFrame(function () {
      var w = f.offsetWidth;
      f.style.left = Math.max(17, Math.min(r.left, window.innerWidth - w + 1)) + "px";
    });
  }
  doc.addEventListener("focusin", function (e) {
    if (e.target.classList && e.target.classList.contains("t")) { e.target.classList.remove("t-dismissed"); place(e.target); }
  });
  doc.addEventListener("mouseover", function (e) {
    var t = e.target.closest && e.target.closest(".t");
    if (t) place(t);
  });
  window.addEventListener("scroll", function () {
    var a = doc.activeElement;
    if (a && a.classList && a.classList.contains("t")) place(a);
    var hv = doc.querySelector(".t:hover");
    if (hv) place(hv);
  }, true);
  doc.addEventListener("pointerdown", function () { holdUntil = Date.now() + 4000; });
  window.addEventListener("resize", measure);

  // ---- print: every section is opened for the print and put back after ----
  var closedBeforePrint = [];
  window.addEventListener("beforeprint", function () {
    holdUntil = Date.now() + 60000;
    printing = true;
    closedBeforePrint = list("details").filter(function (d) { return !d.open; });
    closedBeforePrint.forEach(function (d) { d.open = true; });
  });
  window.addEventListener("afterprint", function () {
    closedBeforePrint.forEach(function (d) { d.open = false; });
    closedBeforePrint = [];
    window.setTimeout(function () { printing = false; }, 300);
  });

  // ---- start ----
  // Each restore step stands alone: a bad stored value or a refused call is ignored and the script still starts.
  try {
    var y = Number(store && store.getItem("pw:y"));
    if (isFinite(y) && y > 0 && y < 1e7) window.scrollTo(0, y);
  } catch (e) { /* a bad scroll position is ignored */ }
  try {
    var want = store ? store.getItem("pw:focus") : null;
    if (want === "pause" && btn) btn.focus({ preventScroll: true });
    else if (want && SLUG.test(want)) {
      var target = doc.querySelector('details[data-k="' + want + '"] > summary');
      if (target) target.focus({ preventScroll: true });
    }
  } catch (e) { /* a bad stored focus is ignored */ }
  body.classList.add("js");
  measure();
  paint();
  tick();
  window.setInterval(tick, 1000);
})();
