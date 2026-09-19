/* =====================================================================
 * PolyTrack TAS Tool  —  core (Phase 1: capture + overlay + editor + gate)
 * ---------------------------------------------------------------------
 * Portable, in-renderer TAS tool for PolyTrack 0.6.2 (Kodub Electron build).
 *
 * Injected by ONE line in index.html, placed BEFORE main.bundle.js so the
 * Worker/XHR patches are installed before the game spins up its physics
 * worker:
 *     <script src="tas/tas.js"></script>
 *
 * This file is intentionally self-contained (no imports, no build step) so
 * it copy-pastes cleanly from version to version. The only game coupling is
 * a set of STABLE wire contracts (documented inline), never minified ids:
 *   - the sim worker filename "simulation_worker.bundle.js"
 *   - the numeric messageType protocol + field shapes
 *   - the 227-byte CarState binary layout
 *   - the leaderboard host ptproxy.cwcinc.dev + "/leaderboard"
 *
 * Phase 2 (bruteforce) adds tas/tas-sim.worker.js + tas/vendor/determinism.js.
 * Phase 3 (savestate) adds the replay-drive + upload taint wiring.
 * ===================================================================== */
(function () {
  "use strict";

  if (window.__TAS__) { try { console.warn("[TAS] already injected"); } catch (e) {} return; }

  var GAME_VERSION = "0.6.2";        // worker asserts this; bump on port
  var SIM_WORKER_FILE = "simulation_worker.bundle.js";

  // Public namespace. Populated progressively; the early patches below run
  // synchronously at script-eval time, the UI is built on DOMContentLoaded.
  var TAS = window.__TAS__ = window.TAS = {
    version: "0.1.0-phase1",
    gameVersion: GAME_VERSION,
    bus: null,        // tiny event emitter (set below)
    capture: null,    // capture state (set below)
    parseCarState: null,
    Recording: null,
    overlay: null,
    panel: null,
    gate: null,
    log: function (m) { try { console.log("[TAS] " + m); } catch (e) {} }
  }; 

  /* ------------------------------------------------------------------ *
   * 0. Tiny event bus
   * ------------------------------------------------------------------ */
  var bus = (function () {
    var map = Object.create(null);
    return {
      on: function (ev, fn) { (map[ev] || (map[ev] = [])).push(fn); return fn; },
      off: function (ev, fn) { var a = map[ev]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
      emit: function (ev, a, b, c) {
        var l = map[ev]; if (!l) return;
        for (var i = 0; i < l.length; i++) { try { l[i](a, b, c); } catch (e) { TAS.log("bus handler error: " + e); } }
      }
    };
  })();
  TAS.bus = bus;

  /* ------------------------------------------------------------------ *
   * 0b. Settings (persisted to localStorage) — rebindable hotkeys + opts
   * Keys are stored as KeyboardEvent.code strings ("F8", "KeyQ", ...).
   * ------------------------------------------------------------------ */
  var DEFAULT_SETTINGS = {
    keys: { overlay: "F8", panel: "F9", reload: "F7", settings: "F6", savestate: "F5", ssSet: "F4", ssReturn: "F3" },
    units: "kmh",          // kmh | mph | ms
    rememberEditor: true,
    layout: "tall",        // tall | wide
    scale: 1,              // UI size multiplier for the overlay + panel (0.75..3)
    speedDecimals: 3       // decimal places on the speed readouts (0..5) — overlay + game speedometer
  };
  function _clone(o) { return JSON.parse(JSON.stringify(o)); }
  var settings = (function () {
    var s = _clone(DEFAULT_SETTINGS);
    try {
      var raw = localStorage.getItem("tas:settings");
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === "object") {
          if (p.keys) for (var k in DEFAULT_SETTINGS.keys) if (typeof p.keys[k] === "string") s.keys[k] = p.keys[k];
          if (typeof p.units === "string") s.units = p.units;
          if (typeof p.rememberEditor === "boolean") s.rememberEditor = p.rememberEditor;
          if (typeof p.layout === "string") s.layout = p.layout;
          if (typeof p.scale === "number" && isFinite(p.scale)) { var _sc = Math.max(0.75, Math.min(3, p.scale)); s.scale = [1, 1.25, 1.5, 1.75, 2].reduce(function (a, b) { return Math.abs(b - _sc) < Math.abs(a - _sc) ? b : a; }); }
          if (typeof p.speedDecimals === "number" && isFinite(p.speedDecimals)) s.speedDecimals = Math.max(0, Math.min(5, p.speedDecimals | 0));
        }
      }
    } catch (e) {}
    return s;
  })();
  TAS.settings = settings;
  function saveSettings() { try { localStorage.setItem("tas:settings", JSON.stringify(settings)); } catch (e) {} bus.emit("settings"); }

  // Speed-display precision (0..5), shared by the TAS overlay (fmtSpeed) and the
  // game's own speedometer. The patched game speedometer reads window.__TAS_speedDecimals
  // each frame, so we mirror the setting onto window here (synchronously, before
  // the game boots) and again on every settings change.
  function currentSpeedDecimals() { var d = settings.speedDecimals; d = (d == null ? 3 : d | 0); return Math.max(0, Math.min(5, d)); }
  function applySpeedDecimals() { try { window.__TAS_speedDecimals = currentSpeedDecimals(); } catch (e) {} }
  applySpeedDecimals();
  bus.on("settings", applySpeedDecimals);

  // Human-friendly label for a KeyboardEvent.code.
  function keyLabel(code) {
    if (!code) return "—";
    if (/^Key([A-Z])$/.test(code)) return RegExp.$1;
    if (/^Digit(\d)$/.test(code)) return RegExp.$1;
    if (/^Numpad(\d)$/.test(code)) return "Num" + RegExp.$1;
    var map = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Escape: "Esc", Backquote: "`", Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Enter: "Enter", Tab: "Tab" };
    return map[code] || code;
  }

  /* ------------------------------------------------------------------ *
   * 0c. Toast — transient feedback for hotkey actions (panel may be shut)
   * ------------------------------------------------------------------ */
  var _toastEl = null, _toastTimer = null;
  function toast(msg, ms) {
    if (!document.body) return;
    if (!_toastEl) { _toastEl = document.createElement("div"); _toastEl.id = "tas-toast"; document.body.appendChild(_toastEl); }
    _toastEl.textContent = msg; _toastEl.classList.add("show");
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { if (_toastEl) _toastEl.classList.remove("show"); }, ms || 1700);
  }
  TAS.toast = toast;

  /* ------------------------------------------------------------------ *
   * 0d. In-renderer modal (replaces window.alert/confirm/prompt)
   * ------------------------------------------------------------------
   * Native dialogs in Electron steal keyboard focus and the renderer doesn't
   * cleanly get it back (text inputs go dead until you focus a field in another
   * app). A page-level modal keeps focus inside the window, is covered by the
   * input shield (id "tas-modal"), and restores focus to the prior element on
   * close. All callers are async (await tasConfirm/tasPrompt/tasPick).
   * ------------------------------------------------------------------ */
  function tasModal(opts) {
    return new Promise(function (resolve) {
      if (!document.body) { resolve(null); return; }
      var prev = document.activeElement;
      var ov = document.createElement("div"); ov.id = "tas-modal";
      var box = document.createElement("div"); box.className = "tas-modal-box";
      if (opts.title) { var h = document.createElement("div"); h.className = "tas-modal-title"; h.textContent = opts.title; box.appendChild(h); }
      if (opts.message) { var m = document.createElement("div"); m.className = "tas-modal-msg"; m.textContent = opts.message; box.appendChild(m); }
      var inputEl = null, taEl = null;
      if (opts.input) { inputEl = document.createElement("input"); inputEl.className = "tas-modal-input styled"; inputEl.value = opts.input.value || ""; if (opts.input.placeholder) inputEl.placeholder = opts.input.placeholder; box.appendChild(inputEl); }
      if (opts.textarea) { taEl = document.createElement("textarea"); taEl.className = "tas-modal-ta styled"; taEl.value = opts.textarea.value || ""; if (opts.textarea.placeholder) taEl.placeholder = opts.textarea.placeholder; taEl.rows = opts.textarea.rows || 12; taEl.spellcheck = false; box.appendChild(taEl); }
      // The primary button resolves with the field's text when there is one (that's
      // what tasPrompt relies on) — a textarea takes the same role as an input.
      var fieldEl = inputEl || taEl;
      if (opts.items) {
        var list = document.createElement("div"); list.className = "tas-modal-list";
        opts.items.forEach(function (it) { var row = document.createElement("div"); row.className = "tas-modal-item"; row.textContent = it; row.addEventListener("click", function () { done(it); }); list.appendChild(row); });
        box.appendChild(list);
      }
      var btnRow = document.createElement("div"); btnRow.className = "tas-modal-btns";
      (opts.buttons || [{ label: "Cancel", value: false }, { label: "OK", value: true, primary: true }]).forEach(function (b) {
        var btn = document.createElement("button"); btn.textContent = b.label; if (b.primary) btn.className = "primary";
        btn.addEventListener("click", function () { done(b.primary && fieldEl ? fieldEl.value : b.value); });
        btnRow.appendChild(btn);
      });
      box.appendChild(btnRow);
      ov.appendChild(box); document.body.appendChild(ov);
      var closed = false, cancelVal = ("cancelValue" in opts) ? opts.cancelValue : false;
      function done(val) {
        if (closed) return; closed = true;
        try { window.removeEventListener("keydown", onKey, true); } catch (e) {}
        try { ov.remove(); } catch (e) {}
        try { if (prev && prev.focus) prev.focus(); } catch (e) {}
        resolve(val);
      }
      function onKey(e) {
        if (e.code === "Escape") { e.preventDefault(); e.stopPropagation(); done(cancelVal); }
        // Enter must stay a newline inside a textarea, so it only submits without one.
        else if (e.code === "Enter" && !opts.items && !taEl) { e.preventDefault(); e.stopPropagation(); done(inputEl ? inputEl.value : true); }
      }
      window.addEventListener("keydown", onKey, true);
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) done(cancelVal); });
      setTimeout(function () { try { (fieldEl || box.querySelector("button.primary") || box).focus(); if (fieldEl) fieldEl.select(); } catch (e) {} }, 0);
    });
  }
  function tasConfirm(message, title) { return tasModal({ title: title || "Confirm", message: message, buttons: [{ label: "Cancel", value: false }, { label: "OK", value: true, primary: true }] }).then(function (v) { return v === true; }); }
  function tasPrompt(message, def, title) { return tasModal({ title: title || "", message: message, input: { value: def || "" }, cancelValue: null, buttons: [{ label: "Cancel", value: null }, { label: "OK", value: true, primary: true }] }); }
  function tasPick(title, items) { return tasModal({ title: title, items: items, cancelValue: null, buttons: [{ label: "Cancel", value: null }] }); }
  TAS.confirm = tasConfirm; TAS.prompt = tasPrompt;

  /* ================================================================== *
   * 1. CarState parser  (port of the game's module-3899 "VO" decoder)
   * ------------------------------------------------------------------
   * Input buffer from a worker UpdateResult is [u32 carId][CarState...].
   * CarState is VARIABLE-LENGTH little-endian; only the prefix through the
   * flags byte is at a fixed offset, so we MUST walk it sequentially. Wheel
   * order is [FL, FR, RL, RR]. Returns null on any malformed buffer.
   * ================================================================== */
  function parseUpdateBuffer(ab) {
    // ab: ArrayBuffer (or typed-array .buffer) of length up to 227.
    var u8, dv, base;
    if (ab instanceof ArrayBuffer) { u8 = new Uint8Array(ab); dv = new DataView(ab); base = 0; }
    else if (ArrayBuffer.isView(ab)) { u8 = new Uint8Array(ab.buffer, ab.byteOffset, ab.byteLength); dv = new DataView(ab.buffer, ab.byteOffset, ab.byteLength); base = 0; }
    else return null;
    if (u8.length < 5) return null;
    var carId = (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
    var s = parseCarState(dv, u8, 4);
    if (!s) return null;
    s.carId = carId;
    return s;
  }

  // Parse the CarState region starting at byte `i` (relative to the DataView's
  // own offset). `u8` is a Uint8Array view aligned with `dv`.
  function parseCarState(dv, u8, i) {
    try {
      var n = u8.length;
      function need(k) { if (i + k > n) throw 0; }
      need(3); var frames = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16); i += 3;
      need(4); var speedKmh = dv.getFloat32(i, true); i += 4;
      need(1); var flags = u8[i]; i += 1;
      var hasStarted = !!(flags & 1);
      var finished = !!(flags & 2);
      var hasCheckpointToRespawnAt = !!(flags & 4);
      var contact = [!!(flags & 8), !!(flags & 16), !!(flags & 32), !!(flags & 64)];
      var finishFrames = null;
      if (finished) { need(3); finishFrames = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16); i += 3; }
      need(2); var nextCheckpointIndex = dv.getUint16(i, true); i += 2;
      need(12);
      var position = { x: dv.getFloat32(i, true), y: dv.getFloat32(i + 4, true), z: dv.getFloat32(i + 8, true) }; i += 12;
      need(16);
      var quaternion = { x: dv.getFloat32(i, true), y: dv.getFloat32(i + 4, true), z: dv.getFloat32(i + 8, true), w: dv.getFloat32(i + 12, true) }; i += 16;
      need(1); var impCount = u8[i]; i += 1;
      if (impCount > 4) return null; // matches game guard
      var collisionImpulses = [];
      for (var c = 0; c < impCount; c++) { need(4); collisionImpulses.push(dv.getFloat32(i, true)); i += 4; }
      var wheelContact = [null, null, null, null];
      for (var w = 0; w < 4; w++) {
        if (contact[w]) {
          need(24);
          var cp = { x: dv.getFloat32(i, true), y: dv.getFloat32(i + 4, true), z: dv.getFloat32(i + 8, true) };
          var cn = { x: dv.getFloat32(i + 12, true), y: dv.getFloat32(i + 16, true), z: dv.getFloat32(i + 20, true) };
          wheelContact[w] = { position: cp, normal: cn }; i += 24;
        }
      }
      function f4() { need(16); var a = [dv.getFloat32(i, true), dv.getFloat32(i + 4, true), dv.getFloat32(i + 8, true), dv.getFloat32(i + 12, true)]; i += 16; return a; }
      var wheelSuspensionLength = f4();
      var wheelSuspensionVelocity = f4();
      var wheelDeltaRotation = f4();
      var wheelSkidInfo = f4();           // <-- per-wheel grip 0..1
      need(4); var steering = dv.getFloat32(i, true); i += 4;
      need(1); var cb = u8[i]; i += 1;
      var controls = { up: !!(cb & 1), right: !!(cb & 2), down: !!(cb & 4), left: !!(cb & 8), reset: !!(cb & 16) };
      var brakeLightEnabled = !!(cb & 32);
      return {
        frames: frames, speedKmh: speedKmh,
        hasStarted: hasStarted, finished: finished, finishFrames: finishFrames,
        nextCheckpointIndex: nextCheckpointIndex, hasCheckpointToRespawnAt: hasCheckpointToRespawnAt,
        position: position, quaternion: quaternion,
        collisionImpulses: collisionImpulses, wheelContact: wheelContact,
        wheelSuspensionLength: wheelSuspensionLength, wheelSuspensionVelocity: wheelSuspensionVelocity,
        wheelDeltaRotation: wheelDeltaRotation, wheelSkidInfo: wheelSkidInfo,
        steering: steering, brakeLightEnabled: brakeLightEnabled, controls: controls,
        byteLength: i
      };
    } catch (e) { return null; }
  }
  TAS.parseCarState = parseUpdateBuffer;

  /* ================================================================== *
   * 2. Recording codec  (5 toggle channels -> zlib -> base64url)
   * ------------------------------------------------------------------
   * Byte-compatible with the game's Recording.serialize()/deserialize():
   *   per channel: 3-byte LE count, then 3-byte LE deltas (first absolute),
   *   channels in order up,right,down,left,reset, single zlib(deflate)
   *   stream, base64url (+/=  ->  -_  with '=' stripped).
   * Uses the native CompressionStream("deflate") (RFC-1950 zlib) so there is
   * ZERO copied/3rd-party code; this is the same path the previous tool used
   * and the game's pako inflate accepts it. encode/decode are async.
   * ================================================================== */
  var CHANNELS = ["up", "right", "down", "left", "reset"];
  var KEY_ORDER = ["w", "a", "s", "d", "r"]; // editor key letters -> up,left,down,right,reset

  function b64urlEncode(u8) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  function b64urlDecode(str) {
    var s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin; try { bin = atob(s); } catch (e) { return null; }
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function deflate(u8) {
    if (typeof CompressionStream === "undefined") throw new Error("CompressionStream unavailable");
    var cs = new CompressionStream("deflate");
    var wr = cs.writable.getWriter(); wr.write(u8); wr.close();
    var buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function inflate(u8) {
    if (typeof DecompressionStream === "undefined") throw new Error("DecompressionStream unavailable");
    var ds = new DecompressionStream("deflate");
    var wr = ds.writable.getWriter(); wr.write(u8); wr.close();
    var buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
  }
  function packChannels(ch) {
    var total = 0, k;
    for (k = 0; k < 5; k++) total += 3 + 3 * ch[CHANNELS[k]].length;
    var out = new Uint8Array(total), o = 0;
    for (k = 0; k < 5; k++) {
      var arr = ch[CHANNELS[k]], len = arr.length;
      out[o] = len & 255; out[o + 1] = (len >>> 8) & 255; out[o + 2] = (len >>> 16) & 255; o += 3;
      var prev = 0;
      for (var j = 0; j < len; j++) { var v = j === 0 ? arr[0] : arr[j] - prev; prev = arr[j]; out[o] = v & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = (v >>> 16) & 255; o += 3; }
    }
    return out;
  }
  function unpackChannels(u8) {
    var ch = { up: [], right: [], down: [], left: [], reset: [] }, o = 0;
    for (var k = 0; k < 5; k++) {
      if (o + 3 > u8.length) return null;
      var t = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); o += 3;
      if (o + 3 * t > u8.length) return null;
      var arr = [], prev = 0;
      for (var j = 0; j < t; j++) { var v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); o += 3; prev = j === 0 ? v : prev + v; arr.push(prev); }
      ch[CHANNELS[k]] = arr;
    }
    return ch;
  }

  // Recording: holds the 5 channels and supports recordFrame()/getControls()
  // exactly like the game, plus text<->channels and (de)serialize.
  function Recording(channels) {
    this.ch = channels || { up: [], right: [], down: [], left: [], reset: [] };
    this._last = null;
  }
  Recording.MAX_FRAMES = 5999999;
  Recording.prototype.clone = function () {
    var c = {}; for (var k = 0; k < 5; k++) c[CHANNELS[k]] = this.ch[CHANNELS[k]].slice();
    var r = new Recording(c); r._last = this._last; return r;
  };
  Recording.prototype.recordFrame = function (frame, controls) {
    if (frame > Recording.MAX_FRAMES) return;
    if (this._last != null && frame <= this._last) return;
    this._last = frame;
    for (var k = 0; k < 5; k++) {
      var a = this.ch[CHANNELS[k]];
      var parity = (a.length % 2) !== 0;
      if (!!controls[CHANNELS[k]] !== parity) a.push(frame);
    }
  };
  Recording.prototype.getControls = function (frame) {
    var out = {};
    for (var k = 0; k < 5; k++) {
      var a = this.ch[CHANNELS[k]], cnt = 0;
      // count toggles <= frame (arrays are ascending)
      for (var i = 0; i < a.length; i++) { if (a[i] <= frame) cnt++; else break; }
      out[CHANNELS[k]] = (cnt % 2) !== 0;
    }
    return out;
  };
  Recording.prototype.numberOfFrames = function () {
    var mx = 0;
    for (var k = 0; k < 5; k++) { var a = this.ch[CHANNELS[k]]; if (a.length) mx = Math.max(mx, a[a.length - 1]); }
    return mx;
  };
  // Total number of key toggles. Distinguishes "no inputs" from "an input at
  // frame 0" (whose numberOfFrames() is 0 even though it has a real input).
  Recording.prototype.numberOfInputs = function () {
    var n = 0; for (var k = 0; k < 5; k++) n += this.ch[CHANNELS[k]].length; return n;
  };
  Recording.prototype.serialize = async function () { return b64urlEncode(await deflate(packChannels(this.ch))); };
  Recording.deserialize = async function (str) {
    var dec = b64urlDecode(str); if (!dec) return null;
    var inf; try { inf = await inflate(dec); } catch (e) { return null; }
    var ch = unpackChannels(inf); return ch ? new Recording(ch) : null;
  };
  TAS.Recording = Recording;

  /* ------------------------------------------------------------------ *
   * 2b. Recording <-> editor text
   * Text format (state-based, like the old tool): "frame,keys" per line,
   * keys from {w,a,s,d,r}; plus a `tap START END KEYS ON OFF` macro and
   * `#` comments. A blank keys field = release all. The canonical state at
   * frame F is whatever the last line at/<=F set.
   * ------------------------------------------------------------------ */
  function normalizeKeys(str) {
    var set = {}; str = String(str || "").toLowerCase();
    for (var i = 0; i < str.length; i++) if (KEY_ORDER.indexOf(str[i]) >= 0) set[str[i]] = 1;
    var o = ""; for (var k = 0; k < KEY_ORDER.length; k++) if (set[KEY_ORDER[k]]) o += KEY_ORDER[k];
    return o;
  }
  function keysToControls(keys) {
    return { up: keys.indexOf("w") >= 0, left: keys.indexOf("a") >= 0, down: keys.indexOf("s") >= 0, right: keys.indexOf("d") >= 0, reset: keys.indexOf("r") >= 0 };
  }
  // Expand editor text (with tap macros) into a sorted [{frame,keys}] state list.
  function compileScript(text) {
    var lines = String(text || "").split("\n");
    var map = new Map(); // frame -> keys (state)
    function setState(f, keys) { if (f >= 0 && !isNaN(f)) map.set(f, normalizeKeys(keys)); }
    function stateAt(f) { // last set state at/<=f
      var best = "", bf = -1;
      map.forEach(function (v, fr) { if (fr <= f && fr > bf) { bf = fr; best = v; } });
      return best;
    }
    // Pass 1: all plain `frame,keys` lines (collect taps for pass 2).
    var taps = [];
    for (var li = 0; li < lines.length; li++) {
      var raw = lines[li], hash = raw.indexOf("#");
      var code = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      if (!code) continue;
      var mTap = code.match(/^tap\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)$/i);
      if (mTap) { taps.push(mTap); continue; }
      var mLine = code.match(/^(\d+)\s*,(.*)$/);
      if (mLine) setState(+mLine[1], mLine[2].toLowerCase() === "none" ? "" : mLine[2]);
    }
    // Pass 2: expand taps AFTER all plain lines, so the restored "previous
    // state" reflects the full base timeline regardless of authoring order.
    for (var ti = 0; ti < taps.length; ti++) {
      var mt = taps[ti];
      var s = +mt[1], e = +mt[2], keys = mt[3].toLowerCase() === "none" ? "" : normalizeKeys(mt[3]), on = +mt[4], off = +mt[5];
      if (s >= e || on <= 0 || off <= 0) continue;
      var prev = stateAt(s - 1), p = s;
      while (p <= e) { setState(p, keys); p += on; if (p > e) break; setState(p, prev); p += off; }
    }
    var entries = [];
    map.forEach(function (v, f) { entries.push({ frame: f, keys: v }); });
    entries.sort(function (a, b) { return a.frame - b.frame; });
    return entries;
  }
  // state list -> Recording (toggle channels)
  function scriptToRecording(text) {
    var entries = compileScript(text);
    var rec = new Recording();
    var prevFrame = -1;
    for (var i = 0; i < entries.length; i++) {
      var f = entries[i].frame; if (f <= prevFrame) continue; prevFrame = f;
      rec.recordFrame(f, keysToControls(entries[i].keys));
    }
    return rec;
  }
  // Recording -> compact editor text (one line per state change)
  function recordingToScript(rec) {
    // Single ascending walk: keep a per-channel pointer + running parity and
    // flip parity as each channel's next toggle frame is reached. O(toggles).
    var framesSet = {};
    for (var k = 0; k < 5; k++) { var a0 = rec.ch[CHANNELS[k]]; for (var i = 0; i < a0.length; i++) framesSet[a0[i]] = 1; }
    var list = Object.keys(framesSet).map(Number).sort(function (a, b) { return a - b; });
    var ptr = [0, 0, 0, 0, 0], par = [false, false, false, false, false];
    var out = [], lastKeys = null;
    for (var j = 0; j < list.length; j++) {
      var f = list[j];
      for (var c = 0; c < 5; c++) { var a = rec.ch[CHANNELS[c]]; while (ptr[c] < a.length && a[ptr[c]] <= f) { par[c] = !par[c]; ptr[c]++; } }
      // CHANNELS order = up,right,down,left,reset -> keys w,a,s,d,r
      var keys = ""; if (par[0]) keys += "w"; if (par[3]) keys += "a"; if (par[2]) keys += "s"; if (par[1]) keys += "d"; if (par[4]) keys += "r";
      if (keys !== lastKeys) { out.push(f + "," + keys); lastKeys = keys; }
    }
    return out.join("\n");
  }
  // Shrink a script to its most compact form: dedupe consecutive identical
  // states, then fold alternating A/B runs back into `tap` macros. Inverse of
  // expanding taps; round-trips to the same recording.
  function compactScript(text) {
    var entries = compileScript(text);
    var ded = [];
    for (var i = 0; i < entries.length; i++) { if (!ded.length || entries[i].keys !== ded[ded.length - 1].keys) ded.push(entries[i]); }
    var out = [], idx = 0;
    while (idx < ded.length) {
      var found = false;
      if (idx + 3 < ded.length) {
        var A = ded[idx].keys, B = ded[idx + 1].keys;
        var before = idx > 0 ? ded[idx - 1].keys : "";
        var on = ded[idx + 1].frame - ded[idx].frame;
        var off = ded[idx + 2].frame - ded[idx + 1].frame;
        if (B === before && A !== B && on > 0 && off > 0) {
          var count = 2, cur = ded[idx + 1].frame, isA = true, j = idx + 2;
          while (j < ded.length) {
            var expKeys = isA ? A : B, expStep = isA ? off : on, nf = cur + expStep;
            if (ded[j].frame === nf && ded[j].keys === expKeys) { count++; cur = nf; isA = !isA; j++; }
            else break;
          }
          if (count >= 4) { out.push("tap " + ded[idx].frame + " " + cur + " " + (A || "none") + " " + on + " " + off); idx += count; found = true; }
        }
      }
      if (!found) { out.push(ded[idx].frame + "," + ded[idx].keys); idx++; }
    }
    return out.join("\n");
  }

  // Speed formatter honouring the units setting -> [valueString, unitLabel].
  function fmtSpeed(kmh) {
    var v = Math.abs(kmh), d = currentSpeedDecimals();
    if (settings.units === "mph") return [(v / 1.609344).toFixed(d), "mph"];
    if (settings.units === "ms") return [(v / 3.6).toFixed(d), "m/s"];
    return [v.toFixed(d), "km/h"];
  }

  // Frames (= ms, physics is 1000 fps) -> a PolyTrack-style time string.
  function fmtTime(frames) {
    var ms = Math.max(0, frames | 0), totalSec = ms / 1000, m = Math.floor(totalSec / 60), s = totalSec - m * 60;
    return m > 0 ? (m + ":" + (s < 10 ? "0" : "") + s.toFixed(3)) : (s.toFixed(3) + "s");
  }

  TAS.compileScript = compileScript;
  TAS.scriptToRecording = scriptToRecording;
  TAS.recordingToScript = recordingToScript;
  TAS.compactScript = compactScript;

  /* ================================================================== *
   * 2c. Savestate (Phase 3)  —  drive a replay from an arbitrary frame N
   * ------------------------------------------------------------------
   * The physics worker can't seed a moving car's velocity, so we re-simulate
   * the input prefix [0..N) and then hand the SAME car to the live keyboard.
   * Mechanism: when armed, the next player CreateCar (carRecording==null) is
   * rewritten with carRecording = the prefix recording + tasSwitchFrame = N.
   * Our patched simulation_worker.bundle.js fast-forwards that car through the
   * recording up to frame N (budgeted per tick, so it's near-instant), then
   * switches to live ControlCar input — so you take over driving at frame N.
   *   - The game records the whole [0..end) run normally (local PB/ghost work).
   *   - N>0 taints the run so the leaderboard upload is blocked (gate, §4).
   * SS is consumed one-shot by onOutbound (§3).
   * ================================================================== */
  var SS = TAS.savestate = { armed: false, frame: 0, prefixEncoded: null, label: "" };

  // Encode a prefix recording from editor text and arm the next run to start
  // from frame N. Returns {ok, msg}. N>0 sets the upload taint.
  async function armSavestate(frame, text) {
    frame = Math.max(0, frame | 0);
    var rec = scriptToRecording(text || "");
    if (frame > 0 && rec.numberOfInputs() < 1) return { ok: false, msg: "The prefix recording is empty — load/extract a run into the editor first (or set frame 0)." };
    var enc;
    try { enc = await rec.serialize(); } catch (e) { return { ok: false, msg: "Failed to encode prefix recording: " + e }; }
    SS.frame = frame; SS.prefixEncoded = enc; SS.armed = true; SS.label = frame + "f"; SS._announced = false;
    // Taint follows the savestate automatically: a start at frame N>0 can't be a
    // legit time, so its leaderboard upload is blocked (no manual toggle).
    setTaint(frame > 0);
    bus.emit("savestate", SS);
    return { ok: true };
  }
  function disarmSavestate() { if (!SS.armed && SS.prefixEncoded == null) { setTaint(false); return; } SS.armed = false; SS.prefixEncoded = null; SS._announced = false; setTaint(false); bus.emit("savestate", SS); }
  // Single source of truth for the upload-block flag + its visual indicator.
  function setTaint(on) { window.__TAS_tainted = !!on; if (TAS.overlay) TAS.overlay.setTainted(!!on); }
  TAS.setTaint = setTaint;
  TAS.armSavestate = armSavestate;
  TAS.disarmSavestate = disarmSavestate;

  /* ---- Start-positions: in-run savestate checkpoints --------------------
   * While DRIVING, snapshot a spot ("set position") = {current frame, the run's
   * inputs up to here}. "Return to position" re-arms that as a savestate and
   * resets the run, so you fast-forward back to that exact spot/velocity — as
   * often as you like. Works from a legit run (frame 0) or an existing
   * savestate; using a position taints the run (savestate-assisted). */
  SS.points = []; // [{frame, prefixEncoded, label}]

  // Arm directly with an already-serialized prefix (start-positions path;
  // armSavestate() above is the editor-text entry point).
  function armSavestateRaw(frame, prefixEncoded) {
    frame = Math.max(0, frame | 0);
    SS.frame = frame; SS.prefixEncoded = prefixEncoded; SS.armed = true; SS.label = frame + "f"; SS._announced = false;
    setTaint(frame > 0);
    bus.emit("savestate", SS);
  }

  // Recreate the player car (which re-applies the armed savestate) by firing the
  // game's own Start-Reset keybind. Reads the binding from the game's settings.
  function triggerReset() {
    var code = null;
    try {
      var raw = localStorage.getItem("polytrack_v5_prod_key_bindings");
      if (raw) { var arr = JSON.parse(raw); for (var i = 0; i < arr.length; i++) { if (arr[i] && arr[i][0] === "VehicleStartReset" && arr[i][1]) { code = arr[i][1][0] || arr[i][1][1]; break; } } }
    } catch (e) {}
    if (!code) { toast("Press your Start-Reset key to go there (couldn't auto-reset)."); return false; }
    try {
      var d = { code: code, key: code, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent("keydown", d)); document.dispatchEvent(new KeyboardEvent("keydown", d));
      window.dispatchEvent(new KeyboardEvent("keyup", d)); document.dispatchEvent(new KeyboardEvent("keyup", d));
      return true;
    } catch (e) { toast("Press your Start-Reset key to go there."); return false; }
  }
  TAS.triggerReset = triggerReset;

  // Snapshot the current run up to the current frame as a start position.
  async function ssSetPoint() {
    var pid = capture.playerCarId, st = pid != null ? capture.latest.get(pid) : null;
    if (!st) { toast("No active run — drive a track first."); return; }
    var frame = st.frames | 0;
    if (frame <= 0) { toast("Drive a moment first, then set a position."); return; }
    var enc; try { enc = await capture.liveRecording.clone().serialize(); } catch (e) { toast("Couldn't snapshot the run: " + e); return; }
    SS.points.push({ frame: frame, prefixEncoded: enc, label: fmtTime(frame) });
    bus.emit("savestate", SS);
    toast("Start position set @ " + fmtTime(frame) + " (" + SS.points.length + " saved)");
  }
  function ssGoto(point) { if (!point) return; armSavestateRaw(point.frame, point.prefixEncoded); toast("Returning to position @ " + fmtTime(point.frame) + "…"); triggerReset(); }
  function ssGotoLast() { if (SS.points.length) ssGoto(SS.points[SS.points.length - 1]); else toast("No start positions set yet."); }
  function ssDeletePoint(i) { if (i >= 0 && i < SS.points.length) { SS.points.splice(i, 1); bus.emit("savestate", SS); } }
  function ssClearPoints() { SS.points = []; bus.emit("savestate", SS); }
  // Fresh LEGIT run from the start (clears the savestate so nothing is injected).
  function ssLegit() { disarmSavestate(); toast("Legit run from the start…"); triggerReset(); }
  TAS.ssSetPoint = ssSetPoint; TAS.ssGoto = ssGoto; TAS.ssGotoLast = ssGotoLast; TAS.ssDeletePoint = ssDeletePoint; TAS.ssClearPoints = ssClearPoints; TAS.ssLegit = ssLegit;

  /* ================================================================== *
   * 3. Capture backbone  —  the portable core
   * ------------------------------------------------------------------
   * Wrap window.Worker so we observe the game's physics worker without
   * touching any minified game internals:
   *   - outbound (main->worker) Init / CreateCar: capture track context.
   *   - inbound  (worker->main) UpdateResult: stream live CarState.
   * Field-shape detection (not the numeric enum) makes this robust.
   * Installed SYNCHRONOUSLY at script eval (before the game makes its
   * worker). Heavy parse hooks attach to TAS.bus.
   * ================================================================== */
  var capture = TAS.capture = {
    worker: null,                    // the game's live sim worker
    _RealWorker: null,               // the native Worker ctor (for spawning untapped BF workers)
    init: null,                      // last Init payload {trackParts, carCollisionShapeVertices, carMassOffset, isRealtime}
    cars: new Map(),                 // carId -> {trackData, mountainVertices, mountainOffset, hasRecording}
    lastCar: null,                   // the most recent CreateCar payload (track context for BF)
    playerCarId: null,               // last CreateCar with carRecording == null (the live, drivable car)
    activeCarId: null,               // the car currently being VIEWED (live OR replay) — telemetry source
    latest: new Map(),               // carId -> last parsed CarState
    lastUpdateTs: new Map(),         // carId -> perfNow() of last UpdateResult (for active-car pick)
    liveRecording: new Recording(),  // reconstructed inputs of the current player run (for "set position")
    _liveRunFrames: -1,
    ready: false,
    // Numeric messageType enum — defaults are the verified-stable 0.6.2 values,
    // overridden by whatever the live game actually sends (robust to reordering).
    msgType: { init: 0, verify: 1, testDeterminism: 2, createCar: 3, deleteCar: 4, startCar: 5, controlCar: 6, pauseCar: 7, verifyResult: 8, determinismResult: 9, updateResult: 10 }
  };

  function onOutbound(msg) {
    if (!msg || typeof msg !== "object") return;
    var mt = msg.messageType;
    // Init: has version + trackParts + carCollisionShapeVertices
    if (msg.trackParts && msg.carCollisionShapeVertices && ("carMassOffset" in msg)) {
      if (typeof mt === "number") capture.msgType.init = mt;
      capture.init = { trackParts: msg.trackParts, carCollisionShapeVertices: msg.carCollisionShapeVertices, carMassOffset: msg.carMassOffset, isRealtime: !!msg.isRealtime, version: msg.version };
      capture.ready = true;
      bus.emit("init", capture.init);
      return;
    }
    // CreateCar: has trackData + carId + 'carRecording' key + mountainVertices,
    // but NOT 'targetFrames' (which is unique to the Verify message — Verify
    // otherwise shares the exact same key set and would misclassify as a car).
    if (("trackData" in msg) && ("carId" in msg) && ("carRecording" in msg) && ("mountainVertices" in msg) && !("targetFrames" in msg)) {
      if (typeof mt === "number") capture.msgType.createCar = mt;
      var info = { trackData: msg.trackData, mountainVertices: msg.mountainVertices, mountainOffset: msg.mountainOffset, hasRecording: msg.carRecording != null };
      capture.cars.set(msg.carId, info);
      capture.lastCar = info; // freshest track context for the bruteforce
      if (msg.carRecording == null) {
        capture.playerCarId = msg.carId; capture.liveRecording = new Recording(); capture._liveRunFrames = -1; capture._finishUploaded = false; capture._playerBornTs = perfNow();
        // Savestate: rewrite the just-created player car so the patched worker
        // fast-forwards the prefix recording to frame N (on creation — the car
        // sits AT N, frozen at N's velocity, until you drive), then hands it to
        // live keyboard control. NOT consumed: it re-applies on every reset, so
        // each Start-Reset drops you back at frame N. Disarmed when you return
        // to the viewer / main menu (installViewerContext).
        // LEGIT = a clean run: created with NO savestate injection (and therefore
        // from frame 0, no prefix). Only such runs may reach the official Kodub
        // leaderboard; everything else (savestate / start-positions) stays blocked.
        capture.legitRun = !(SS.armed && SS.prefixEncoded != null);
        if (SS.armed && SS.prefixEncoded != null) {
          msg.carRecording = SS.prefixEncoded;
          msg.tasSwitchFrame = SS.frame;
          capture._savestateCarId = msg.carId; capture._savestateFinished = false; // for the finish-time toast
          // Remember the prefix + split frame so "Watch replay" can transfer the
          // WHOLE run (editor prefix [0..N) + your live driving [N..)) into the
          // editor. Survives Start-Resets (re-injected each time); cleared below
          // when a fresh, non-savestate run starts.
          capture._ssRun = { prefix: SS.prefixEncoded, frame: SS.frame };
          TAS.log("savestate: injected prefix into player car " + msg.carId + " @ switchFrame " + SS.frame);
          bus.emit("savestate", SS);
          if (!SS._announced) { SS._announced = true; try { toast("Savestate @ frame " + SS.frame + " — reset returns you here; finishing posts a driven run"); } catch (e) {} }
        } else {
          capture._ssRun = null; // a normal (non-savestate) run — nothing to transfer
        }
      }
      bus.emit("createcar", msg.carId, info);
      return;
    }
    // StartCar: carId + targetSimulationTimeFrames (learn its enum number).
    if (("carId" in msg) && ("targetSimulationTimeFrames" in msg) && typeof mt === "number") { capture.msgType.startCar = mt; return; }
    // Verify (learn number; not otherwise used).
    if (("trackData" in msg) && ("targetFrames" in msg) && typeof mt === "number") { capture.msgType.verify = mt; return; }
    // DeleteCar: only {messageType, carId} — clean up caches so a car from a
    // previous session can't be mistaken for the active (viewed) car.
    if (("carId" in msg) && !("trackData" in msg) && !("carRecording" in msg) && !("targetSimulationTimeFrames" in msg) && !("isPaused" in msg) && typeof msg.up !== "boolean") {
      if (typeof mt === "number") capture.msgType.deleteCar = mt;
      capture.latest.delete(msg.carId); capture.lastUpdateTs.delete(msg.carId); capture.cars.delete(msg.carId);
      if (capture.playerCarId === msg.carId) capture.playerCarId = null;
      return;
    }
  }

  // Pick the car the user is currently VIEWING. Prefer a recently-updated LIVE
  // car (driving); otherwise the most-recently-updated car (replay viewer).
  function pickActiveCar(now) {
    var bestLive = null, bestLiveTs = -1, bestAny = null, bestAnyTs = -1;
    capture.latest.forEach(function (st, carId) {
      var ts = capture.lastUpdateTs.get(carId) || 0;
      var info = capture.cars.get(carId);
      if (ts > bestAnyTs) { bestAnyTs = ts; bestAny = carId; }
      if (info && !info.hasRecording && ts > bestLiveTs) { bestLiveTs = ts; bestLive = carId; }
    });
    if (bestLive != null && (now - bestLiveTs) < 300) return bestLive;
    return bestAny;
  }

  // Cheap car-id peek (first 4 bytes LE) — matches parseUpdateBuffer's carId, no full parse.
  function readCarIdOnly(ab) {
    try {
      var u8;
      if (ab instanceof ArrayBuffer) { if (ab.byteLength < 4) return null; u8 = new Uint8Array(ab, 0, 4); }
      else if (ArrayBuffer.isView(ab)) { if (ab.byteLength < 4) return null; u8 = new Uint8Array(ab.buffer, ab.byteOffset, 4); }
      else return null;
      return (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0;
    } catch (e) { return null; }
  }
  function onInbound(data) {
    if (!data || typeof data !== "object") return;
    var bufs = data.carStateBuffers;
    if (!bufs || !bufs.length) return;
    if (typeof data.messageType === "number") capture.msgType.updateResult = data.messageType;
    var now = perfNow(), updated = [];
    // A non-realtime batch (the ghost pre-sim on a race reset) streams MANY frames per car at
    // once. The tool only needs the latest state per non-player car, but the old loop fully
    // parsed every intermediate ghost frame — the reset lag. Skip them: keep only the last
    // buffer per non-player car (+ every player frame, which liveRecording needs). The GAME
    // still processes the full message via its own onmessage handler — our tap is a separate
    // observer — so its ghost trajectories are unaffected.
    var lastIdx = null;
    if (bufs.length > 16) {
      lastIdx = Object.create(null);
      for (var b = 0; b < bufs.length; b++) { var cid = readCarIdOnly(bufs[b]); if (cid != null) lastIdx[cid] = b; }
    }
    for (var i = 0; i < bufs.length; i++) {
      if (lastIdx) { var cidI = readCarIdOnly(bufs[i]); if (cidI != null && cidI !== capture.playerCarId && lastIdx[cidI] !== i) continue; }
      var st = parseUpdateBuffer(bufs[i]);
      if (!st) continue;
      capture.latest.set(st.carId, st);
      capture.lastUpdateTs.set(st.carId, now);
      updated.push(st);
      // Reconstruct the current player run's inputs from the stream (same
      // semantics as the game's recordFrame). Used by the savestate "set
      // position" feature to snapshot the run up to the current frame.
      if (st.carId === capture.playerCarId) {
        if (st.frames < capture._liveRunFrames) { capture.liveRecording = new Recording(); capture._finishUploaded = false; } // run restarted
        capture._liveRunFrames = st.frames;
        if (st.hasStarted && !st.finished) capture.liveRecording.recordFrame(st.frames, st.controls);
        // Crossed the finish while LIVE DRIVING (legit OR savestate) → auto-post
        // it to the TAS leaderboard as a "driven" run (the human never hand-edited
        // inputs). Replay/Apply playback is excluded (different carId, not driving).
        if (st.finished && st.finishFrames != null && !capture._finishUploaded && !inReplayViewer()) {
          capture._finishUploaded = true;
          // A genuine live drive takes roughly real wall-clock time (the realtime
          // loop is 1ms/frame). A SIMULATED/replayed run (flat-out) finishes far
          // faster — that's what was wrongly uploading replays you raced against —
          // so require the elapsed wall time to be near the driven-frame count.
          var driveMs = perfNow() - (capture._playerBornTs || 0);
          var liveFrames = st.finishFrames - (capture._ssRun ? (capture._ssRun.frame | 0) : 0);
          if (driveMs >= liveFrames * 0.5) {
            try { toast("Finished — full track time " + fmtTime(st.finishFrames)); } catch (e) {}
            autoUploadDrivenFinish(st.finishFrames);
          } else {
            TAS.log("skipped auto-upload (simulated/replay: " + Math.round(driveMs) + "ms wall vs " + liveFrames + " frames)");
          }
        }
      }
      bus.emit("carstate", st.carId, st);
    }
    // Telemetry follows the active (viewed) car — live OR replay.
    var active = pickActiveCar(now);
    capture.activeCarId = active;
    if (active != null) for (var j = 0; j < updated.length; j++) if (updated[j].carId === active) { bus.emit("telemetry", updated[j]); break; }

    // Fast replay restore after Apply: check physics progress and seek/pause once ready
    if (window.__TAS_viewSeek && window.__TAS_viewState && !window.__TAS_viewState.seek) {
      window.__TAS_viewState.seek = window.__TAS_viewSeek;
    }
    if (TAS._applyRestoreFrame != null && !TAS._applyRestored) {
      var restoreFrame = TAS._applyRestoreFrame;
      var maxSimFrame = 0;
      var anyFinished = false;
      capture.latest.forEach(function (st, carId) {
        var info = capture.cars.get(carId);
        if (info && info.hasRecording) {
          if (st.frames > maxSimFrame) maxSimFrame = st.frames;
          if (st.finished) {
            anyFinished = true;
            if (st.finishFrames != null && st.finishFrames > maxSimFrame) {
              maxSimFrame = st.finishFrames;
            }
          }
        }
      });
      if (maxSimFrame >= restoreFrame || (anyFinished && maxSimFrame > 0)) {
        TAS._applyRestored = true;
        var target = Math.min(restoreFrame, maxSimFrame);
        if (window.__TAS_viewState && typeof window.__TAS_viewState.seek === "function") {
          try { window.__TAS_viewState.seek(target); } catch (e) {}
        } else if (window.__TAS_viewSeek) {
          try { window.__TAS_viewSeek(target); } catch (e) {}
        }
        try {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, cancelable: true }));
        } catch (e) {}
        if (TAS._applyStatusFn) {
          try { TAS._applyStatusFn("Applied — stopped at " + fmtTime(target) + "."); } catch (e) {}
        }
        setTimeout(function () {
          try {
            if (window.__TAS_viewState && typeof window.__TAS_viewState.seek === "function") {
              window.__TAS_viewState.seek(target);
            } else if (window.__TAS_viewSeek) {
              window.__TAS_viewSeek(target);
            }
          } catch (e) {}
        }, 50);
      }
    }
  }

  // --- install the Worker wrapper synchronously ---
  (function patchWorker() {
    var Real = window.Worker;
    if (!Real) { TAS.log("window.Worker missing — capture disabled"); return; }
    capture._RealWorker = Real; // bruteforce spawns workers via this (untapped)
    function TASWorker(url, opts) {
      var w = new Real(url, opts);
      try {
        if (String(url).indexOf(SIM_WORKER_FILE) >= 0) {
          capture.worker = w;
          TAS.log("attached to sim worker");
          var realPost = w.postMessage.bind(w);
          w.postMessage = function (m, transfer) { try { onOutbound(m); } catch (e) { TAS.log("outbound tap err: " + e); } return realPost(m, transfer); };
          w.addEventListener("message", function (ev) { try { onInbound(ev.data); } catch (e) { TAS.log("inbound tap err: " + e); } });
        }
      } catch (e) { TAS.log("worker attach err: " + e); }
      return w;
    }
    TASWorker.prototype = Real.prototype;
    try { Object.setPrototypeOf(TASWorker, Real); } catch (e) {}
    window.Worker = TASWorker;
  })();

  /* ================================================================== *
   * 4. Leaderboard gate  —  block ALL official-leaderboard uploads
   * ------------------------------------------------------------------
   * The tool NEVER uploads to PolyTrack's official leaderboard. Because it can
   * drive savestate / TAS runs (and even a "legit" run is indistinguishable
   * once the tool is installed), EVERY submit is blocked unconditionally — a
   * clean "null" (uploadId=null) success is synthesized so the game's handler
   * resolves normally and the LOCAL PB/ghost still save. Only the SUBMIT (POST)
   * is blocked; the GET leaderboard READ (a ?query) is left alone so you can
   * still VIEW the leaderboard. Every transport is covered (XHR / fetch /
   * sendBeacon), and a submit is recognised by URL *or* its "recording=" body
   * signature, so a version/path change can't slip a run through.
   * ================================================================== */
  window.__TAS_tainted = window.__TAS_tainted || false;
  var gate = TAS.gate = {
    blockedCount: 0,
    isSubmit: function (method, url, body) {
      if (String(method || "").toUpperCase() !== "POST") return false;
      var u = String(url || ""), host = "", path = u;
      try { var p = new URL(u, location.href); host = p.host; path = p.pathname; } catch (e) { host = u; path = u.split("?")[0]; }
      if (host.indexOf("ptproxy.cwcinc.dev") < 0) return false;       // only the kodub API
      if (/\/leaderboard$/.test(path)) return true;            // the known submit endpoint
      try { if (typeof body === "string" && /(^|&)recording=/.test(body)) return true; } catch (e) {} // submit body signature
      return false;
    },
    // The official Kodub leaderboard is allowed ONLY for a clean run: hand-driven
    // from frame 0 with NO savestate / start-position / editor assistance. That's
    // exactly capture.legitRun (set false the moment a savestate prefix is
    // injected into the player car). Anything else stays blocked.
    allowOfficial: function () { return capture.legitRun === true; }
  };
  (function patchUpload() {
    function blocked(tag) { gate.blockedCount++; TAS.log("BLOCKED leaderboard upload (" + tag + " #" + gate.blockedCount + ")"); }
    // ---- XHR ----
    var P = XMLHttpRequest.prototype, rOpen = P.open, rSend = P.send;
    P.open = function (method, url) { this.__tasM = method; this.__tasU = url; if (gate.noteUrl) gate.noteUrl(url); return rOpen.apply(this, arguments); };
    P.send = function (body) {
      if (gate.isSubmit(this.__tasM, this.__tasU, body) && !gate.allowOfficial()) {
        blocked("xhr");
        gate.captureRun(typeof body === "string" ? body : null);
        var xhr = this;
        try {
          Object.defineProperty(xhr, "readyState", { configurable: true, get: function () { return 4; } });
          Object.defineProperty(xhr, "status", { configurable: true, get: function () { return 200; } });
          Object.defineProperty(xhr, "responseText", { configurable: true, get: function () { return "null"; } });
          Object.defineProperty(xhr, "response", { configurable: true, get: function () { return "null"; } });
        } catch (e) {}
        setTimeout(function () {
          try { xhr.dispatchEvent(new Event("readystatechange")); } catch (e) {}
          try { xhr.dispatchEvent(new Event("load")); } catch (e) {}
          try { xhr.dispatchEvent(new Event("loadend")); } catch (e) {}
        }, 0);
        return;
      }
      return rSend.apply(this, arguments);
    };
    // ---- fetch ----
    var rFetch = window.fetch;
    if (rFetch) {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === "string" ? input : (input && input.url);
          var method = (init && init.method) || (input && input.method) || "GET";
          var body = init && init.body;
          if (gate.noteUrl) gate.noteUrl(url);
          if (gate.isSubmit(method, url, typeof body === "string" ? body : null) && !gate.allowOfficial()) {
            blocked("fetch");
            gate.captureRun(typeof body === "string" ? body : null);
            return Promise.resolve(new Response("null", { status: 200, headers: { "Content-Type": "text/plain" } }));
          }
        } catch (e) {}
        return rFetch.apply(this, arguments);
      };
    }
    // ---- sendBeacon (defense in depth; the game doesn't use it today) ----
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        var rBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
          try { if (gate.isSubmit("POST", url, typeof data === "string" ? data : null) && !gate.allowOfficial()) { blocked("beacon"); gate.captureRun(typeof data === "string" ? data : null); return true; } } catch (e) {}
          return rBeacon(url, data);
        };
      }
    } catch (e) {}
  })();

  /* ================================================================== *
   * 4a-bis. TAS Board  —  the SEPARATE community leaderboard.
   * ------------------------------------------------------------------
   * The official board is hard-blocked above. Instead, finished runs are
   * captured from the (blocked) submit body and routed to a Supabase-backed
   * board that anyone can upload to / view, each run AUTO-TAGGED
   * legit / savestate / tas with the full recording attached (re-watchable).
   * Backend setup: tas/TASBOARD.md. The client talks to Supabase's REST API;
   * Supabase isn't kodub.com so it sails through the upload gate untouched.
   * ================================================================== */
  // Built-in backend — embedded so the tool works for everyone out of the box
  // (no per-person setup). This is a Supabase ANON public key; it's safe to ship
  // because the table's RLS only allows read + insert (no update/delete). A user
  // can still point at their OWN backend via the Configure form (overrides win).
  var BOARD_URL = "https://edgeoqjhugjolbthkygg.supabase.co";
  var BOARD_KEY = "sb_publishable_Ii3TbmPQ3vvoZ8exJbBi2A_b93cqWJ4";
  var board = TAS.board = (function () {
    function raw() { try { return JSON.parse(localStorage.getItem("tas:board") || "{}") || {}; } catch (e) { return {}; } }
    // Effective config = embedded defaults overlaid with the user's overrides.
    function cfg() {
      var c = raw();
      return {
        url: c.url || BOARD_URL,
        key: c.key || BOARD_KEY,
        nickname: c.nickname || "",
        autoUpload: c.autoUpload !== undefined ? !!c.autoUpload : true,
        categoryOverride: c.categoryOverride || "auto"
      };
    }
    function setCfg(c) { try { localStorage.setItem("tas:board", JSON.stringify(c || {})); } catch (e) {} bus.emit("board:cfg", c); }
    function patchCfg(p) { var c = raw(); for (var k in p) c[k] = p[k]; setCfg(c); return c; }
    function configured() { var c = cfg(); return !!(c.url && c.key); }
    function base() { return String(cfg().url || "").replace(/\/+$/, ""); }
    function api(pathAndQuery, opts) {
      var c = cfg();
      if (!c.url || !c.key) return Promise.reject(new Error("TAS Board not configured (set Project URL + anon key)."));
      opts = opts || {};
      var headers = { apikey: c.key, Authorization: "Bearer " + c.key };
      for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
      var url = base() + "/rest/v1/" + pathAndQuery, method = opts.method || "GET", body = opts.body || null;
      // Prefer the Electron main process (Node, no CORS / no Origin rewrite) so
      // uploads aren't blocked by a preflight. Falls back to renderer fetch.
      if (window.electron && typeof window.electron.tasBoardFetch === "function") {
        return window.electron.tasBoardFetch(method, url, headers, body).then(function (r) {
          var txt = (r && (r.text != null ? r.text : r.error)) || "";
          return { ok: !!(r && r.ok), status: (r && r.status) || 0, text: function () { return Promise.resolve(txt); }, json: function () { try { return Promise.resolve(JSON.parse(txt || "null")); } catch (e) { return Promise.reject(e); } } };
        });
      }
      opts.headers = headers;
      return fetch(url, opts);
    }
    function upload(run) {
      return api("runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(run)
      }).then(function (r) {
        if (r.ok) return { ok: true };
        return r.text().then(function (t) { return { ok: false, error: (t || ("HTTP " + r.status)) }; });
      });
    }
    function fetchRuns(trackId, category, limit) {
      var q = "runs?select=*&order=frames.asc&limit=" + (limit || 200);
      if (trackId) q += "&track_id=eq." + encodeURIComponent(trackId);
      if (category && category !== "all") q += "&category=eq." + encodeURIComponent(category);
      return api(q).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); });
        return r.json();
      });
    }
    // Upload only if it beats this user's current best for the same track+category
    // (keeps the board to one row per person per category — their personal best).
    function uploadIfBest(run) {
      var q = "runs?select=frames&order=frames.asc&limit=1&track_id=eq." + encodeURIComponent(run.track_id) + "&category=eq." + encodeURIComponent(run.category);
      q += run.user_id ? ("&user_id=eq." + encodeURIComponent(run.user_id)) : ("&nickname=eq." + encodeURIComponent(run.nickname || "anon"));
      return api(q).then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
        var best = (rows && rows[0]) ? rows[0].frames : null;
        if (best != null && run.frames >= best) return { uploaded: false, pb: false, prevBest: best };
        return upload(run).then(function (res) { return res.ok ? { uploaded: true, pb: (best != null), prevBest: best } : { uploaded: false, error: res.error }; });
      });
    }
    return { cfg: cfg, setCfg: setCfg, patchCfg: patchCfg, configured: configured, upload: upload, uploadIfBest: uploadIfBest, fetchRuns: fetchRuns };
  })();

  // Passively learn, from the (allowed) leaderboard GET, BOTH the current track
  // id (for the "this track" filter) AND the player's userTokenHash — the game's
  // own public, stable per-user id, which we credit/dedupe TAS runs by.
  gate.noteUrl = function (url) {
    try {
      var u = new URL(String(url || ""), location.href);
      if (u.host.indexOf("ptproxy.cwcinc.dev") >= 0 && /leaderboard/.test(u.pathname)) {
        var t = u.searchParams.get("trackId");
        if (t && t !== TAS.currentTrackId) { TAS.currentTrackId = t; bus.emit("track", t); }
        var uh = u.searchParams.get("userTokenHash");
        if (uh) TAS.userId = uh;
      }
    } catch (e) {}
  };

  // Two categories only:
  //   driven — the run was driven to the finish live (legit OR savestate); the
  //            human never hand-edited inputs. Auto-uploaded on finish.
  //   edited — the run includes at least one manually edited input (full TAS);
  //            uploaded with the panel button.
  // The official submit is captured ONLY for its metadata (car style); driven
  // uploads are built from the live input stream when the car crosses the line.
  gate.captureRun = function (body) {
    if (typeof body !== "string" || !body) return;
    try {
      var p = new URLSearchParams(body);
      if (p.get("carStyle")) capture.carStyle = p.get("carStyle");
      gate.lastRun = { track_id: p.get("trackId") || "", car_style: p.get("carStyle") || "", nickname: p.get("nickname") || "" };
    } catch (e) {}
  };

  /* ================================================================== *
   * 4a-ter. Block local PB persistence
   * ------------------------------------------------------------------
   * The official upload is blocked, but the game ALSO saves each finished run as
   * a LOCAL record in localStorage (key "...record..._undeterministic_...",
   * value {uploadId, tokenHash, frames, recording}). Because we blocked the
   * upload, uploadId is null — so a NORMAL (un-patched) PolyTrack opened on the
   * same profile later SYNCS that stored record to the official leaderboard,
   * leaking a tool run. Fix: (a) drop writes to the record keys so nothing new is
   * stored, and (b) purge already-stored, never-uploaded records on startup.
   * ================================================================== */
  (function blockLocalRecords() {
    var RECORD_KEY = /^polytrack_.*_record_/;
    try {
      var proto = window.Storage && window.Storage.prototype;
      if (proto && proto.setItem) {
        var rawSet = proto.setItem;
        proto.setItem = function (key, value) {
          // Block the local PB record ONLY for non-legit runs (savestate/edited).
          // A legit run uploads for real → its record carries a valid uploadId, so
          // saving it is fine (a normal client won't re-sync it). A blocked run's
          // record would have uploadId=null → a normal client would leak it.
          try { if (RECORD_KEY.test(String(key)) && capture.legitRun !== true) { try { TAS.log("blocked local record save (non-legit run — would leak via a normal client): " + key); } catch (e) {} return; } } catch (e) {}
          return rawSet.call(this, key, value);
        };
      }
    } catch (e) {}
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || !RECORD_KEY.test(k)) continue;
        var pending = true;
        try { var v = JSON.parse(localStorage.getItem(k)); pending = !v || v.uploadId == null; } catch (e) { pending = true; }
        if (pending) kill.push(k);
      }
      for (var j = 0; j < kill.length; j++) { try { localStorage.removeItem(kill[j]); } catch (e) {} }
      if (kill.length) { try { TAS.log("purged " + kill.length + " un-uploaded local record(s) so a normal client can't sync them to the leaderboard."); } catch (e) {} }
    } catch (e) {}
  })();

  /* ================================================================== *
   * 4a-quater. Camera-matrix capture (for the 3D trigger-box overlay)
   * ------------------------------------------------------------------
   * Patched at TOP LEVEL (this script is non-deferred, so it runs before the
   * deferred main.bundle.js) so the hooks are in place BEFORE THREE compiles
   * shaders + looks up its uniform locations. We capture the MAIN camera's
   * projection/view straight from the values uploaded via uniformMatrix4fv — no
   * per-frame GPU readback — and only during a full-screen pass, so shadow /
   * reflection sub-cameras (small viewports) never overwrite the real camera.
   * ================================================================== */
  // diag counters so an on-screen readout can tell us WHAT failed (no devtools)
  var boxVP = TAS._boxVP = { P: null, V: null, V2: null, MV: null, vp: null, hooked: false, want: false, mvFresh: false, frameMax: 0, frameMV: null, frameFresh: false, sawProj: 0, sawView: 0, sawMV: 0, rigid: 0, ubo: 0 };
  var tasLocName = new WeakMap();
  function mat4mul(a, b) { var o = new Float32Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function tasIsRigid(m) {
    var c0=m[0]*m[0]+m[1]*m[1]+m[2]*m[2], c1=m[4]*m[4]+m[5]*m[5]+m[6]*m[6], c2=m[8]*m[8]+m[9]*m[9]+m[10]*m[10];
    var d01=m[0]*m[4]+m[1]*m[5]+m[2]*m[6], d02=m[0]*m[8]+m[1]*m[9]+m[2]*m[10], d12=m[4]*m[8]+m[5]*m[9]+m[6]*m[10];
    return Math.abs(c0-1)<.03 && Math.abs(c1-1)<.03 && Math.abs(c2-1)<.03 && Math.abs(d01)<.03 && Math.abs(d02)<.03 && Math.abs(d12)<.03;
  }
  // Finalize the per-frame view: only adopt the largest draw's matrix if it was
  // FRESHLY uploaded this frame (THREE caches modelViewMatrix when the camera is
  // static, so a stale matrix must not overwrite the good view). Called once per
  // frame from the overlay draw loop, before it reads boxVP.vp.
  function tasFinalizeVP() {
    if (boxVP.frameFresh && boxVP.frameMV && tasIsRigid(boxVP.frameMV)) { boxVP.V2 = boxVP.frameMV; boxVP.rigid++; }
    boxVP.frameMax = 0; boxVP.frameFresh = false;
    var V = boxVP.V || boxVP.V2; if (boxVP.P && V) boxVP.vp = mat4mul(boxVP.P, V);
  }
  (function patchCameraCapture() {
    var NAMES = { projectionMatrix: 1, viewMatrix: 1, modelViewMatrix: 1 };
    function patchProto(proto) {
      if (!proto || proto.__tasBoxHook) return; proto.__tasBoxHook = true; boxVP.hooked = true;
      var oGUL = proto.getUniformLocation;
      if (typeof oGUL === "function") proto.getUniformLocation = function (prog, name) {
        var loc = oGUL.call(this, prog, name);
        if (loc && NAMES[name]) { try { tasLocName.set(loc, name); } catch (e) {} try { loc.__tasMat = name; } catch (e) {} }
        return loc;
      };
      var oUM = proto.uniformMatrix4fv;
      if (typeof oUM === "function") proto.uniformMatrix4fv = function (loc, transpose, value, srcOffset) {
        try {
          var nm = loc && (tasLocName.get(loc) || loc.__tasMat);
          if (nm && value && value.length >= 16) {
            if (nm === "projectionMatrix") { var off = srcOffset | 0, m = new Float32Array(16), i; for (i = 0; i < 16; i++) m[i] = value[off + i]; if (Math.abs(m[11] + 1) < 0.01 && Math.abs(m[15]) < 0.01) { boxVP.P = m; boxVP.sawProj++; } } // perspective only; cached/rare so always
            else if (boxVP.want) { var o2 = srcOffset | 0, m2 = new Float32Array(16), j; for (j = 0; j < 16; j++) m2[j] = value[o2 + j]; if (nm === "viewMatrix") { boxVP.V = m2; boxVP.sawView++; } else { boxVP.MV = m2; boxVP.mvFresh = true; boxVP.sawMV++; } }
          }
        } catch (e) {}
        return oUM.apply(this, arguments);
      };
      // Track the largest draw this frame AND whether its modelViewMatrix was just
      // uploaded (fresh). The track is the biggest world-space (model=identity)
      // mesh, so when its matrix is fresh it equals the view matrix.
      function onDraw(count) {
        if (!boxVP.want) return;
        if (count > boxVP.frameMax) { boxVP.frameMax = count; boxVP.frameMV = boxVP.MV; boxVP.frameFresh = boxVP.mvFresh; }
        boxVP.mvFresh = false;
      }
      var oDE = proto.drawElements; if (typeof oDE === "function") proto.drawElements = function (mode, count) { var r = oDE.apply(this, arguments); onDraw(count | 0); return r; };
      var oDA = proto.drawArrays; if (typeof oDA === "function") proto.drawArrays = function (mode, first, count) { var r = oDA.apply(this, arguments); onDraw(count | 0); return r; };
      var oDI = proto.drawElementsInstanced; if (typeof oDI === "function") proto.drawElementsInstanced = function (mode, count) { var r = oDI.apply(this, arguments); onDraw(count | 0); return r; };
      function sniffUBO(ctx, data) {
        try {
          if (!boxVP.want || !data) return; var f;
          if (data instanceof Float32Array) f = data; else if (data.buffer) f = new Float32Array(data.buffer, data.byteOffset || 0, (data.byteLength || 0) >> 2); else return;
          if (f.length < 32) return;
          if (Math.abs(f[11] + 1) < 0.001 && Math.abs(f[15]) < 0.001 && f[31] !== 0) { var P = new Float32Array(16), V = new Float32Array(16), i; for (i = 0; i < 16; i++) { P[i] = f[i]; V[i] = f[16 + i]; } boxVP.P = P; boxVP.V = V; boxVP.ubo++; }
        } catch (e) {}
      }
      var oBD = proto.bufferData; if (typeof oBD === "function") proto.bufferData = function (target, data) { try { if (target === this.UNIFORM_BUFFER && typeof data === "object") sniffUBO(this, data); } catch (e) {} return oBD.apply(this, arguments); };
      var oBSD = proto.bufferSubData; if (typeof oBSD === "function") proto.bufferSubData = function (target, off, data) { try { if (target === this.UNIFORM_BUFFER && typeof data === "object") sniffUBO(this, data); } catch (e) {} return oBSD.apply(this, arguments); };
    }
    try { patchProto(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (e) {}
    try { patchProto(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (e) {}
  })();

  /* ================================================================== *
   * 4b. Input shield
   * ------------------------------------------------------------------
   * The game's vehicle key handlers live on window in the BUBBLE phase and
   * call preventDefault() on W/A/S/D (and arrows). When you type into our
   * editor that both swallows the character AND drives the car. We install a
   * CAPTURE-phase listener on window (fires before any bubble listener, and
   * before the game's listeners are even registered) that, for key events
   * targeting our UI, calls stopPropagation() so the game never sees them.
   * We do NOT preventDefault, so the field still receives the keystroke
   * normally (stopPropagation does not cancel the default text insertion).
   * ================================================================== */
  (function installInputShield() {
    function inOurUI(node) {
      while (node) {
        if (node.nodeType === 1 && (node.id === "tas-panel" || node.id === "tas-modal" || node.id === "tas-board")) return true;
        node = node.parentNode;
      }
      return false;
    }
    // Balance keydown/keyup: a keyup is swallowed only when its keydown was (i.e. the
    // press started over our UI). Otherwise a key pressed while the game canvas had
    // focus, then released after focus moved into a TAS field, would have ONLY its
    // keyup eaten here — leaving the game's action latched on (the "stuck key" bug).
    var shielded = Object.create(null);
    function shield(e) {
      if (e.type === "keydown") { if (inOurUI(e.target)) { shielded[e.code] = 1; e.stopPropagation(); } }
      else if (e.type === "keyup") { if (shielded[e.code]) { delete shielded[e.code]; e.stopPropagation(); } }
      else if (inOurUI(e.target)) { e.stopPropagation(); } // keypress: follow the target
    }
    var types = ["keydown", "keyup", "keypress"];
    for (var i = 0; i < types.length; i++) window.addEventListener(types[i], shield, true);
  })();

  /* ================================================================== *
   * 4c. Bruteforce engine (Phase 2a — stock-worker pool)
   * ------------------------------------------------------------------
   * Spawns a pool of UNTAPPED copies of simulation_worker.bundle.js (the
   * game's own physics worker — zero copied code), inits them from the
   * captured Init payload (isRealtime:false => flat-out), and for each
   * variant sends CreateCar(variant recording)+StartCar(horizon). The worker
   * streams CarStates back; we score them here against the chosen objective
   * (checkpoint or trigger boxes) and keep the best via (1+λ) hill-climbing.
   *
   * Correct by construction (real game worker parses the captured trackData
   * itself, so no track parsing here). Phase 2b will add a custom worker that
   * snapshots the prefix and scores in-thread for a big speedup.
   * ================================================================== */
  var KEYSETS_DEFAULT = "w, wa, wd, none";
  var BF = TAS.bf = {
    running: false, workers: [], pending: new Map(), carIdSeq: 9000000,
    iterLeft: 0, infinite: false, best: null, baseMap: null, baseResult: null, ctx: null,
    // Stop condition: "iters" (count variants), "time" (wall-clock deadline), "never".
    limitMode: "iters", deadline: 0, limitTimer: null,
    // Personal-best event queue drained by the UI on its throttle tick — every island
    // PB lands here, not just global bests, so the log can show each population's own
    // progress. Bounded; overflow is counted rather than allowed to grow unbounded.
    pbQueue: [], pbDropped: 0,
    horizon: 0, startFrame: 0, endFrame: 0, endState: "", speedFrame: 0,
    triggers: [], nogos: [], blend: 0.5, allowed: [""], mut: {}, totalRuns: 0,
    // Vector-aligned scoring: score the trigger speed term by how much of the car's
    // velocity points AT the next box (dot product) instead of by raw speed.
    // Adaptive cooling: anneal each island's mutation strength as it stalls.
    align: false, cool: true,
    // Crash/dead detection (C1). deadAbort kills a run stopped for deadLimit frames below
    // deadSpeed (pure throughput). crashWeight>0 subtracts a soft penalty for hard-decel
    // spikes (impacts) — 0 by default, because a fast wall-scrape is sometimes optimal.
    deadAbort: true, deadLimit: 500, deadSpeed: 1, crashDecel: 6, crashWeight: 0,
    // Gradient-guided mutation (B3): fraction of mutations biased to the parent's hotspot band.
    focus: 0.5,
    // Island / population model: N independent populations each evolve their own
    // best; a population that stalls is "kicked" (migrate the global best in, or
    // restart from the base) so the whole search can escape a local minimum.
    islands: [], numIslands: 1, _isl: -1, stallLimit: 250, _baseDone: false, _baseDispatched: false,
    // Per-island pool of top-K variants + crossover + a dedup set (see bfPopInsert/bfCrossover/bfSignature).
    poolSize: 6, crossover: true, seen: null,
    // Snapshot mode: each worker keeps ONE persistent car, simulates the prefix
    // [0..startFrame) once, snapshots the WASM memory, and restores+continues per
    // variant — skipping the prefix re-sim entirely (opt-in; section opt only).
    snapshot: false, _runId: 0,
    migrations: 0, startedAt: 0, bestAtRun: 0, reaper: null, onUpdate: null
  };

  function bfStateAtMap(map, frame) { var best = "", bf = -1; map.forEach(function (v, f) { if (f <= frame && f > bf) { bf = f; best = v; } }); return best; }
  function bfMapToEntries(map) { var a = []; map.forEach(function (v, f) { a.push({ frame: f, keys: v }); }); a.sort(function (x, y) { return x.frame - y.frame; }); return a; }
  function bfEntriesToRecording(entries) {
    var rec = new Recording(), pf = -1;
    for (var i = 0; i < entries.length; i++) { var f = entries[i].frame; if (f <= pf) continue; pf = f; rec.recordFrame(f, keysToControls(entries[i].keys)); }
    return rec;
  }
  function bfRandKeys() { return BF.allowed[(Math.random() * BF.allowed.length) | 0]; }

  // ---- Variant model ---------------------------------------------------------
  // A BF variant is { map, taps }: `map` is the plain-state timeline (frame->keys)
  // and `taps` is a list of structured `tap` macros {start,end,keys,on,off}. When
  // tap-editing is OFF, taps=[] and `map` holds the fully-expanded inputs (the old
  // flat-Map behavior). When ON, tap macros are kept structured so their PARAMETERS
  // (start/end/keys/on/off) can be mutated; free-frame edits then avoid their spans.
  function bfCloneTap(t) { return { start: t.start, end: t.end, keys: t.keys, on: t.on, off: t.off }; }
  function bfCloneVariant(v) { return { map: new Map(v.map), taps: v.taps.map(bfCloneTap) }; }
  // Parse editor text into a variant WITHOUT expanding tap macros.
  function bfParseGenome(text) {
    var lines = String(text || "").split("\n"), map = new Map(), taps = [];
    for (var i = 0; i < lines.length; i++) {
      var code = lines[i].split("#")[0].trim(); if (!code) continue;
      var mt = code.match(/^tap\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)$/i);
      if (mt) { var ts = +mt[1], te = +mt[2], ton = +mt[4], tof = +mt[5]; if (te > ts && ton > 0 && tof > 0) taps.push({ start: ts, end: te, keys: mt[3].toLowerCase() === "none" ? "" : normalizeKeys(mt[3]), on: ton, off: tof }); continue; }
      var ml = code.match(/^(\d+)\s*,(.*)$/); if (ml && +ml[1] >= 0) map.set(+ml[1], ml[2].toLowerCase() === "none" ? "" : normalizeKeys(ml[2]));
    }
    return { map: map, taps: taps };
  }
  // Expand one tap macro into a state map (same semantics as compileScript pass 2).
  function bfExpandTapInto(map, t) {
    var s = t.start, e = t.end, on = t.on, off = t.off; if (s >= e || on <= 0 || off <= 0) return;
    var prev = bfStateAtMap(map, s - 1), p = s;
    while (p <= e) { map.set(p, t.keys); p += on; if (p > e) break; map.set(p, prev); p += off; }
  }
  // Compile a variant to a full state map (taps expanded), then re-assert the
  // frozen end-anchor so post-window play stays identical to the base.
  function bfCompileVariant(v) {
    var map = new Map(v.map);
    for (var i = 0; i < v.taps.length; i++) bfExpandTapInto(map, v.taps[i]);
    if (BF.tail) BF.tail.forEach(function (val, f) { map.set(f, val); });   // freeze post-window tail to base
    else map.set(BF.endFrame, BF.endState);
    return map;
  }
  // Single-pass recording build (main-thread hot path, once per variant). The old route
  // bfCompileVariant→bfMapToEntries→bfEntriesToRecording did TWO full Map clones (one here,
  // one already in bfMutate), a sort, and a channel rebuild every variant — serial on the
  // main thread, so it capped runs/sec once workers were plentiful. This clones only when
  // taps must be expanded (tapEdit), and folds compile + sort + channel emit into one walk.
  // Semantically identical to the old chain (tail overrides map at shared frames).
  function bfVariantToRecording(v) {
    var work;
    if (v.taps && v.taps.length) { work = new Map(v.map); for (var i = 0; i < v.taps.length; i++) bfExpandTapInto(work, v.taps[i]); }
    else work = v.map;                                  // no taps → no clone needed
    var tail = BF.tail;
    var frames = [];
    work.forEach(function (val, f) { if (!tail || !tail.has(f)) frames.push(f); }); // tail wins at shared frames
    if (tail) tail.forEach(function (val, f) { frames.push(f); });
    else frames.push(BF.endFrame);
    frames.sort(function (a, b) { return a - b; });
    function stateAt(f) { return (tail && tail.has(f)) ? tail.get(f) : work.get(f); }
    var ch = { up: [], right: [], down: [], left: [], reset: [] }, pf = -1;
    for (var j = 0; j < frames.length; j++) {
      var f = frames[j]; if (f <= pf || f > Recording.MAX_FRAMES) continue; pf = f;
      var c = keysToControls(stateAt(f) || "");
      for (var k = 0; k < 5; k++) { var a = ch[CHANNELS[k]]; if (!!c[CHANNELS[k]] !== ((a.length % 2) !== 0)) a.push(f); }
    }
    return new Recording(ch);
  }
  // Nudge one parameter of a tap, clamped so it stays a valid macro inside the
  // search window [winS, winE) (end kept < winE so a tap never touches the anchor).
  function bfMutateTapParam(t, part, winS, winE, maxShift) {
    function nudge(val, lo, hi, step) { var d = 0; while (d === 0) d = ((Math.random() * (2 * step + 1)) | 0) - step; return Math.max(lo, Math.min(hi, val + d)); }
    var onOffStep = Math.max(1, Math.round(maxShift / 10));
    if (part === "start") t.start = nudge(t.start, winS, t.end - 1, maxShift);
    else if (part === "end") t.end = nudge(t.end, t.start + 1, winE - 1, maxShift);
    else if (part === "keys") t.keys = bfRandKeys();
    else if (part === "on") t.on = nudge(t.on, 1, 100000, onOffStep);
    else t.off = nudge(t.off, 1, 100000, onOffStep);
    if (t.end <= t.start) t.end = t.start + 1;
    if (t.on < 1) t.on = 1; if (t.off < 1) t.off = 1;
  }

  // Adaptive cooling (simulated-annealing-ish): the effective mutation strength for
  // one island. A fixed maxShift is wrong at both ends of a search — 30 frames is
  // what you want while hunting for a racing line, and it is exactly what ruins a
  // line that is already good. So each island runs at the configured rate/maxShift
  // right after it finds a best, and anneals toward 1/1 as it stalls; any new best
  // resets it to full strength. Geometric (x^t) rather than linear so maxShift walks
  // 30→1 smoothly AND t=1 reproduces the configured value exactly (x^1 === x), i.e.
  // a freshly-improved island behaves identically to the old fixed-strength code.
  // Reaching t=0 coincides with the stall kick in bfFinalize, so the tail of the
  // anneal is the last thing an island tries before it gets migrated/restarted.
  function bfMutStrength(island) {
    var mut = BF.mut;
    if (!BF.cool || island < 0) return mut;
    var isl = BF.islands[island];
    if (!isl || !isl.stalls) return mut;
    var t = 1 - Math.min(1, isl.stalls / Math.max(1, BF.stallLimit));
    return {
      rate: Math.max(1, Math.round(Math.pow(Math.max(1, mut.rate), t))),
      maxShift: Math.max(1, Math.round(Math.pow(Math.max(1, mut.maxShift), t))),
      wShift: mut.wShift, wToggle: mut.wToggle, wInsert: mut.wInsert
    };
  }

  // Produce a mutated variant from a parent (free-frame edits confined to
  // [startFrame, endFrame) and off the taps' spans; tap-parameter edits per weights).
  // `mut` is the effective strength for this island (see bfMutStrength); defaults to
  // the configured BF.mut.
  function bfMutate(parent, mut, hot) {
    var v = bfCloneVariant(parent), s = BF.startFrame, e = BF.endFrame, tm = BF.tapMut;
    mut = mut || BF.mut;
    // Gradient targeting (B3): if the parent gave us a hotspot frame (where its line
    // diverged), some of the time confine edits to a band around it — concentrate the
    // search where it matters instead of spraying the whole window. Soft: implemented as
    // a bounded re-roll so it never starves the rest of the window and can't corrupt the
    // in-place inWin bookkeeping (frame values, not indices).
    var band = null;
    if (hot === hot && hot != null && Math.random() < BF.focus) { var _sp = Math.max(20, ((e - s) / 4) | 0); band = [hot - _sp, hot + _sp]; }
    function pickIdx() {
      var ii = (Math.random() * inWin.length) | 0;
      if (band) for (var q = 0; q < 3; q++) { if (inWin[ii] >= band[0] && inWin[ii] <= band[1]) break; ii = (Math.random() * inWin.length) | 0; }
      return ii;
    }
    // Frames covered by a tap (dynamic — a mutated tap moves its own span) are
    // off-limits to free-frame edits so the tap's pattern stays clean.
    var tr = v.taps.map(function (t) { return [t.start, t.end]; });
    function inTap(f) { for (var i = 0; i < tr.length; i++) if (f >= tr[i][0] && f <= tr[i][1]) return true; return false; }
    // Editable taps: only those wholly inside the window (keeps outside-window play
    // — and the snapshot prefix — identical to the base).
    function editableTaps() { var a = []; if (BF.tapEdit && tm) for (var i = 0; i < v.taps.length; i++) { var t = v.taps[i]; if (t.start >= s && t.end <= e - 1) a.push(i); } return a; }
    // In-window free-edit frames + editable taps, built ONCE and maintained in place.
    // These used to be rebuilt with a full map scan on every single mutation, which is
    // O(map × rate) per variant and dominated dispatch cost on long scripts. Only a
    // tap-parameter edit can move a span and invalidate membership, so only it rebuilds.
    var inWin = [], ed;
    function rebuild() { inWin.length = 0; v.map.forEach(function (val, f) { if (f >= s && f < e && !(tr.length && inTap(f))) inWin.push(f); }); ed = editableTaps(); }
    rebuild();
    var wTap = tm ? (tm.wStart + tm.wEnd + tm.wKeys + tm.wOn + tm.wOff) : 0;
    var n = 1 + ((Math.random() * mut.rate) | 0);
    for (var k = 0; k < n; k++) {
      var total = mut.wShift + mut.wToggle + mut.wInsert + (ed.length ? wTap : 0);
      if (total <= 0) break;
      var r = Math.random() * total;
      if (r < mut.wShift && inWin.length) {
        var ii = pickIdx(), f0 = inWin[ii];
        var d = 0; while (d === 0) d = ((Math.random() * (2 * mut.maxShift + 1)) | 0) - mut.maxShift;
        var nf = Math.max(s, Math.min(e - 1, f0 + d));
        if (nf !== f0 && !(tr.length && inTap(nf))) {
          var had = v.map.has(nf), kk = v.map.get(f0);
          v.map.delete(f0); v.map.set(nf, kk);
          if (had) inWin.splice(ii, 1); else inWin[ii] = nf;   // shifting onto a live frame merges the two
        }
      } else if (r < mut.wShift + mut.wToggle && inWin.length) {
        v.map.set(inWin[pickIdx()], bfRandKeys());
      } else if (r < mut.wShift + mut.wToggle + mut.wInsert) {
        var f2 = band ? Math.max(s, Math.min(e - 1, (band[0] + ((Math.random() * Math.max(1, band[1] - band[0])) | 0)))) : s + ((Math.random() * Math.max(1, e - s)) | 0);
        if (!(tr.length && inTap(f2))) { var had2 = v.map.has(f2); v.map.set(f2, bfRandKeys()); if (!had2) inWin.push(f2); }
      } else if (ed.length) {
        // Tap-parameter edit: pick an editable tap + a part weighted by the 5 weights.
        var t2 = v.taps[ed[(Math.random() * ed.length) | 0]];
        var rp = Math.random() * wTap, a2 = 0, part;
        if ((a2 += tm.wStart) > rp) part = "start";
        else if ((a2 += tm.wEnd) > rp) part = "end";
        else if ((a2 += tm.wKeys) > rp) part = "keys";
        else if ((a2 += tm.wOn) > rp) part = "on";
        else part = "off";
        bfMutateTapParam(t2, part, s, e, mut.maxShift);
        tr = v.taps.map(function (t) { return [t.start, t.end]; });
        rebuild();   // a moved tap span changes which free frames are off-limits
      }
    }
    return v;
  }

  // ---- population helpers (islands keep a top-K pool, not a single best) ----------
  // A cheap genome signature over the IN-WINDOW state (+ tap params) — the only part a
  // mutation can touch. Drives dedup: skip re-simulating / re-storing an identical
  // variant (very common once cooling drives maxShift→1, and whenever a shift lands on
  // an existing frame). FNV-1a 32-bit.
  function bfSignature(v) {
    var s = BF.startFrame, e = BF.endFrame, parts = [];
    v.map.forEach(function (val, f) { if (f >= s && f < e) parts.push(f + ":" + val); });
    parts.sort();
    var str = parts.join("|");
    if (v.taps && v.taps.length) {
      var tp = v.taps.map(function (t) { return t.start + "," + t.end + "," + t.keys + "," + t.on + "," + t.off; });
      tp.sort(); str += "#" + tp.join("|");
    }
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h;
  }
  // Crossover: splice two parents at a random in-window frame — a's line before the cut,
  // b's after — so different populations that solved different corners can be recombined.
  // Out-of-window frames come from a (they're identical across variants: edits are windowed).
  function bfCrossover(a, b) {
    var s = BF.startFrame, e = BF.endFrame, cut = s + ((Math.random() * Math.max(1, e - s)) | 0);
    var child = bfCloneVariant(a), drop = [];
    child.map.forEach(function (val, f) { if (f >= cut && f < e) drop.push(f); });
    for (var i = 0; i < drop.length; i++) child.map.delete(drop[i]);
    b.map.forEach(function (val, f) { if (f >= cut && f < e) child.map.set(f, val); });
    if (BF.tapEdit) {
      child.taps = a.taps.filter(function (t) { return t.start < cut; }).map(bfCloneTap)
        .concat(b.taps.filter(function (t) { return t.start >= cut; }).map(bfCloneTap));
    }
    return child;
  }
  // Annealed tournament selection over the island's pool. Fresh island (stalls≈0) → big
  // tournament ≈ always pick the best (exploit). Stalling island → tournament shrinks to
  // 1 = a uniformly-random elite (explore). This IS the annealing-acceptance mechanism —
  // it replaces a Metropolis test, which is ill-defined across the 1e9-per-box score tiers.
  function bfSelectParent(isl) {
    if (!isl || !isl.pop || !isl.pop.length) return BF.best || BF.baseResult || null;
    var pop = isl.pop, t = 1 - Math.min(1, (isl.stalls || 0) / Math.max(1, BF.stallLimit));
    var tsize = Math.max(1, Math.min(pop.length, 1 + Math.round(t * (pop.length - 1))));
    var best = null;
    for (var i = 0; i < tsize; i++) { var c = pop[(Math.random() * pop.length) | 0]; if (!best || c.score > best.score) best = c; }
    return best;
  }
  // Insert a candidate into the island pool: dedup by signature, keep the top BF.poolSize
  // by score (sorted desc, so pop[0] is the island best).
  function bfPopInsert(isl, cand, sig) {
    var pop = isl.pop, K = BF.poolSize;
    if (sig != null) {
      for (var i = 0; i < pop.length; i++) if (pop[i]._sig === sig) { if (cand.score > pop[i].score) { cand._sig = sig; pop[i] = cand; pop.sort(function (a, b) { return b.score - a.score; }); } return; }
      cand._sig = sig;
    }
    if (pop.length < K) pop.push(cand);
    else if (cand.score > pop[pop.length - 1].score) pop[pop.length - 1] = cand;
    else return;
    pop.sort(function (a, b) { return b.score - a.score; });
  }
  // Stuck: reseed the pool — half the time chase the global champion (intensify), half
  // restart from the base (diversify).
  function bfKick(isl) {
    var seed = (BF.best && Math.random() < 0.5)
      ? { score: BF.best.score, variant: bfCloneVariant(BF.best.variant), info: "migrated" }
      : (BF.baseResult ? { score: BF.baseResult.score, variant: bfCloneVariant(BF.baseResult.variant), info: "restart" } : null);
    if (seed) { isl.pop = [seed]; isl.best = seed; }
  }

  // ---- scoring ----
  function bfBoxContains(t, p) {
    return Math.abs(p.x - t.x) <= t.sx / 2 && Math.abs(p.y - t.y) <= t.sy / 2 && Math.abs(p.z - t.z) <= t.sz / 2;
  }
  function bfDist(a, b) { var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  function bfNewAcc(variant) {
    return {
      variant: variant, maxCp: 0, finished: false, finishFrames: null, lastFrame: 0, lastSpeed: 0,
      invalid: false,   // entered a no-go box → run is disqualified
      // maxCp/finished/finishFrames are reported in the readout only — the score is
      // driven entirely by the trigger boxes now.
      trigEntered: 0, trigMinDist: Infinity, trigSpeedAt: 0, trigEntryFrame: null,
      // Speed sampled at the COMMON speed-check frame (BF.speedFrame) — the same frame
      // for every run, so the speed comparison is fair. null until that frame is reached.
      checkSpeed: null,
      // previous frame's position — the velocity DIRECTION for aligned scoring is the
      // position delta (CarState carries only a scalar speed, no velocity vector).
      // NaN = no previous frame yet.
      prevX: NaN, prevY: 0, prevZ: 0,
      // Crash/dead detection (C1). stuck = consecutive frames stopped after the start;
      // crashCost = summed hard-deceleration spikes (impact proxy); prevSpeed for the delta.
      stuck: 0, crashCost: 0, prevSpeed: 0, dead: false,
      // Gradient hotspot (B3): the frame where the run got closest to the box it's failing
      // — i.e. where the racing line diverges. Mutating a child near here concentrates edits
      // where they matter instead of spraying them uniformly across the window.
      hotFrame: NaN
    };
  }
  /* Vector-aligned speed: the component of the car's velocity that points AT the
   * target box — speed × cos(angle between velocity and the direction to the box).
   * Raw speed is a deceptive objective in a racing game: a car sliding sideways past
   * a box at 300 km/h outscores one heading cleanly into it at 150, so the search
   * evolves toward the wall. This term makes the two separable.
   *
   * Kept in km/h so `blend` and FRAME_W keep their tuned meaning, and deliberately
   * allowed to go NEGATIVE when the car is moving away from the box. Uses |speedKmh|
   * for magnitude (speedKmh is signed forward-axis speed) and takes direction purely
   * from the position delta, so a car reversing INTO the box still scores positive.
   *
   * Note this reads at the closest-approach frame, which is the useful place for it:
   * a run cut short while still heading in has cos≈1 (≈ raw speed), while one that
   * merely sails past has velocity ⊥ to the box at its nearest point and collapses
   * to ≈0. Arriving vs. passing-by IS the signal.
   */
  function bfAlignedSpeed(acc, st, target, d) {
    var sp = Math.abs(st.speedKmh);
    if (!BF.align || acc.prevX !== acc.prevX) return sp;   // prevX NaN = first frame of the run
    var vx = st.position.x - acc.prevX, vy = st.position.y - acc.prevY, vz = st.position.z - acc.prevZ;
    var vm = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (vm < 1e-9 || d < 1e-9) return 0;                   // stationary, or sitting on the box centre
    var tx = target.x - st.position.x, ty = target.y - st.position.y, tz = target.z - st.position.z;
    return sp * ((vx * tx + vy * ty + vz * tz) / (vm * d));
  }
  function bfAccumulate(acc, st) {
    acc.lastFrame = st.frames; acc.lastSpeed = Math.abs(st.speedKmh);
    // Crash/dead signals (C1). A hard one-frame speed drop is an impact proxy (CarState
    // carries collisionImpulses too, but a decel spike is cheap and mirrors 1:1 in the
    // worker). "Stuck" = stopped for a sustained run after the start = a dead run.
    var _sp = Math.abs(st.speedKmh), _decel = acc.prevSpeed - _sp;
    if (_decel > BF.crashDecel) acc.crashCost += (_decel - BF.crashDecel);
    if (st.hasStarted && st.frames > BF.startFrame && _sp < BF.deadSpeed) acc.stuck++; else acc.stuck = 0;
    acc.prevSpeed = _sp;
    // Sample the exit speed once, at the first frame at/after the common check frame —
    // measured at the SAME frame for every run (see bfScore for why box-entry speed was
    // wrong). Every non-no-go run reaches this frame since it is ≤ the horizon.
    if (acc.checkSpeed == null && st.frames >= BF.speedFrame) acc.checkSpeed = Math.abs(st.speedKmh);
    if (st.nextCheckpointIndex > acc.maxCp) acc.maxCp = st.nextCheckpointIndex;
    if (st.finished && !acc.finished) { acc.finished = true; acc.finishFrames = st.finishFrames; }
    // No-go boxes: entering ANY of them invalidates the run for good.
    if (!acc.invalid && BF.nogos.length) {
      for (var ng = 0; ng < BF.nogos.length; ng++) { if (bfBoxContains(BF.nogos[ng], st.position)) { acc.invalid = true; break; } }
    }
    var next = BF.triggers[acc.trigEntered];
    if (next) {
      var d = bfDist(st.position, next);
      // Closest approach: aligned when enabled — this is the term that decides
      // between runs that MISS the box, so "how much of your speed is aimed at it"
      // is what we want to rank on.
      if (d < acc.trigMinDist) { acc.trigMinDist = d; acc.trigSpeedAt = bfAlignedSpeed(acc, st, next, d); acc.hotFrame = st.frames; }
      // Entry speed stays RAW: inside the box the direction to its centre is
      // meaningless, and for every box but the last this is overwritten next frame
      // anyway (trigMinDist resets to Infinity). For the last box it IS the goal —
      // there is no next target to align against, so raw speed is the honest metric.
      if (bfBoxContains(next, st.position)) {
        acc.trigEntryFrame = st.frames; acc.trigSpeedAt = Math.abs(st.speedKmh);
        acc.trigEntered++; acc.trigMinDist = Infinity;
      }
    }
    acc.prevX = st.position.x; acc.prevY = st.position.y; acc.prevZ = st.position.z;
  }
  /* Crossing the finish deliberately does NOT end the run — only collecting every box,
   * hitting a no-go, or reaching the horizon does.
   *
   * This used to `return true` on st.finished, which quietly inverted the whole search
   * whenever the last box sat on the finish line: the game latches `finished` the frame
   * the car enters the finish detector, the run was cut dead right there, and the box a
   * few frames beyond never got collected. So a run that actually FINISHED scored as
   * incomplete (trigEntered < length) and lost to one that missed the finish but drove
   * through the boxes — i.e. the search was rewarded for not finishing.
   *
   * The sim is happy to keep going (the game's own non-realtime loop never checks the
   * finished flag either), and the auto horizon already leaves ~4000 frames of margin
   * past the player's finish, so there's room to actually reach a box on the line.
   */
  function bfIsDone(acc, st) {
    if (acc.invalid) return true;   // hit a no-go box — stop early, run is dead
    // Dead-run abort (C1a): stopped/wedged for a sustained stretch → it will never reach
    // the box, so reclaim the worker now. (Doesn't hard-fail the run — it just stops
    // simulating; incomplete-run distance scoring already ranks it low.)
    if (BF.deadAbort && acc.stuck >= BF.deadLimit) { acc.dead = true; return true; }
    if (st.frames >= BF.horizon) return true;
    // A completed run keeps simulating to the common speed-check frame, so its exit
    // speed is read at the SAME frame as every other run rather than at its own arrival
    // frame (which sampled the earlier/better run before it finished accelerating and
    // made it look slower). speedFrame ≤ horizon, so this always terminates.
    return acc.trigEntered >= BF.triggers.length && st.frames >= BF.speedFrame;
  }
  function bfRemainingDist(acc) {
    var d = 0, ts = BF.triggers, i = acc.trigEntered;
    if (i >= ts.length) return 0;
    d = acc.trigMinDist === Infinity ? 0 : acc.trigMinDist; // closest approach to next
    for (var k = i; k < ts.length - 1; k++) d += bfDist(ts[k], ts[k + 1]);
    return d;
  }
  function bfScore(acc) {
    if (acc.invalid) return -Infinity;   // entered a no-go box — never a best
    var REACH = 1e9;
    // tier by boxes entered, then speed/distance blend (Donadigo-style).
    // FRAME_W scales the frame term (~thousands) down toward the speed term
    // (~hundreds of km/h) so the slider has a meaningful range near the middle.
    var FRAME_W = 0.1;
    var crash = BF.crashWeight > 0 ? BF.crashWeight * acc.crashCost : 0; // C1b: 0 by default
    var entered = acc.trigEntered;
    if (entered >= BF.triggers.length) {
      // Completed: blend ARRIVAL FRAME at the last box (the unconfounded time term) with
      // exit speed measured at the COMMON check frame — NOT speed at box entry. Box-entry
      // speed sampled each run at its own arrival frame, so a run that reached the box a
      // frame earlier was measured a frame earlier in its acceleration and looked slower,
      // letting the blended speed term reject the genuinely-faster run. Sampling all runs
      // at one fixed frame removes that: the earlier arrival is also faster there.
      var f = acc.trigEntryFrame == null ? acc.lastFrame : acc.trigEntryFrame;
      var exitSpeed = acc.checkSpeed != null ? acc.checkSpeed : acc.lastSpeed;
      return BF.triggers.length * REACH + BF.blend * exitSpeed - (1 - BF.blend) * f * FRAME_W - crash;
    }
    return entered * REACH + BF.blend * acc.trigSpeedAt - (1 - BF.blend) * bfRemainingDist(acc) - crash;
  }

  function bfParseAllowed(str) {
    var out = [];
    String(str || KEYSETS_DEFAULT).split(",").forEach(function (p) {
      var t = p.trim().toLowerCase(); if (!t) return;
      out.push(t === "none" ? "" : normalizeKeys(t));
    });
    if (!out.length) out = [""];
    return out;
  }

  function bfSpawnWorkers(n) {
    var Real = capture._RealWorker || window.Worker;
    for (var i = 0; i < n; i++) {
      var w;
      try { w = new Real(SIM_WORKER_FILE); } catch (e) { TAS.log("BF worker spawn failed: " + e); break; }
      (function (W) {
        W.onmessage = function (ev) { bfOnMessage(W, ev.data); };
        W.onerror = function (ev) { TAS.log("BF worker error: " + (ev && ev.message || ev)); };
      })(w);
      w.postMessage({
        messageType: capture.msgType.init, version: (capture.init.version || GAME_VERSION),
        isRealtime: false, trackParts: capture.init.trackParts,
        carCollisionShapeVertices: capture.init.carCollisionShapeVertices, carMassOffset: capture.init.carMassOffset
      });
      // Snapshot mode: hand the worker the track context + scoring config ONCE per run,
      // keyed by the run id, so variant messages carry only the inputs. These used to
      // ride along on every __bfSnap dispatch even though the worker reads them exactly
      // once (when it builds its snapshot) — and mountainVertices is a plain Array of
      // 2.5k–57k doubles, so structured-cloning it per variant was burning main-thread
      // time that directly capped runs/sec. The worker falls back to a message-carried
      // copy if present, so an unpatched/older worker still works.
      if (BF.snapshot && BF.ctx) {
        w.postMessage({
          __bfInit: true, prefixKey: BF._runId, cfg: BF._cfg,
          trackData: BF.ctx.trackData, mountainVertices: BF.ctx.mountainVertices, mountainOffset: BF.ctx.mountainOffset
        });
      }
      BF.workers.push({ worker: w, busy: false, carId: null, acc: null, ts: 0, bfCarId: 7000000 + BF.workers.length });
    }
  }

  function bfOnMessage(W, data) {
    if (!data) return;
    // Snapshot mode: the worker already scored the run — one tiny message, no states.
    if (data.bfResult) {
      var sl = data.bfCarId != null ? BF.pending.get(data.bfCarId) : null;
      if (sl && sl.carId != null) { sl._wscore = data.score; sl._winfo = data.info; sl._wfin = data.finishFrames; sl._wlast = data.frames; sl._whot = data.hot; bfFinalize(sl); }
      return;
    }
    var bufs = data.carStateBuffers; // BF workers only ever post UpdateResult
    if (!bufs) return;
    var slot = null, done = false;
    for (var i = 0; i < bufs.length; i++) {
      var st = parseUpdateBuffer(bufs[i]); if (!st) continue;
      slot = BF.pending.get(st.carId); if (!slot) continue;
      bfAccumulate(slot.acc, st);
      if (bfIsDone(slot.acc, st)) { bfFinalize(slot); done = true; break; }
    }
    // Snapshot path posts the WHOLE variant in one message; if the batch ran out
    // without hitting a terminal condition, the run is complete → finalize it.
    if (data.bfComplete && !done) { var s2 = slot || (data.bfCarId != null ? BF.pending.get(data.bfCarId) : null); if (s2 && s2.carId != null) bfFinalize(s2); }
  }

  function bfFinalize(slot) {
    if (slot.carId == null) return;
    var acc = slot.acc, island = slot.island, score, info, hot;
    // Snapshot mode: the worker already computed the score+info (+hotspot). Otherwise score here.
    if (slot._wscore !== undefined) { score = slot._wscore; info = slot._winfo; hot = slot._whot; slot._wscore = undefined; }
    else { score = bfScore(acc); info = bfDescribeAcc(acc); hot = acc.hotFrame; }
    BF.totalRuns++;
    var improved = false;      // global best beaten — drives the editor write + autosave
    var islandPb = false;      // this population beat its OWN best (may still be behind the global)
    var prevBest = BF.best ? BF.best.score : null;
    if (island < 0) {
      // The unmutated base finished: record it as the baseline and hand EVERY
      // population its own copy of the base inputs to evolve from independently.
      BF.baseResult = { score: score, variant: bfCloneVariant(acc.variant), info: info, hot: hot };
      BF.best = { score: score, variant: bfCloneVariant(acc.variant), info: info, hot: hot };
      for (var i = 0; i < BF.numIslands; i++) { var be = { score: score, variant: bfCloneVariant(acc.variant), info: info, hot: hot }; BF.islands[i] = { best: be, pop: [be], stalls: 0 }; }
      BF._baseDone = true; improved = true; islandPb = true;
    } else {
      var isl = BF.islands[island];
      // A no-go run scores -Infinity and must never enter the pool.
      if (score !== -Infinity) {
        var wasBest = isl.best ? isl.best.score : -Infinity;
        bfPopInsert(isl, { score: score, variant: bfCloneVariant(acc.variant), info: info, hot: hot }, acc._sig);
        isl.best = isl.pop[0];
        if (isl.best.score > wasBest) {
          isl.stalls = 0; islandPb = true;
          if (!BF.best || isl.best.score > BF.best.score) { BF.best = { score: isl.best.score, variant: bfCloneVariant(isl.best.variant), info: isl.best.info, hot: isl.best.hot }; improved = true; }
        } else if (++isl.stalls >= BF.stallLimit) {
          bfKick(isl); isl.stalls = 0; BF.migrations++;
        }
      } else if (++isl.stalls >= BF.stallLimit) {
        bfKick(isl); isl.stalls = 0; BF.migrations++;
      }
    }
    if (!BF.snapshot) { try { slot.worker.postMessage({ messageType: capture.msgType.deleteCar, carId: slot.carId }); } catch (e) {} } // keep the persistent snapshot car alive
    BF.pending.delete(slot.carId);
    slot.carId = null; slot.acc = null; slot.busy = false; slot.island = undefined;
    if (improved) BF.bestAtRun = BF.totalRuns;
    // Queue EVERY population's own PB for the log — a population beating its own best
    // is real progress worth seeing even while another population is further ahead.
    // Queued (not rendered here) so the DOM never touches the finalize hot path; the UI
    // drains it on its throttle tick. Bounded: at high runs/sec early in a search these
    // arrive far faster than anyone can read, so drop the oldest and report the count.
    if (islandPb) {
      if (BF.pbQueue.length >= 300) { BF.pbQueue.shift(); BF.pbDropped++; }
      BF.pbQueue.push({
        run: BF.totalRuns, island: island, score: score, info: info, best: improved,
        delta: (improved && prevBest != null && isFinite(prevBest)) ? (score - prevBest) : null,
        shift: (BF.cool && slot.mut) ? slot.mut.maxShift : null
      });
    }
    if (BF.onUpdate) BF.onUpdate(improved);
    bfPump();
  }

  function bfDescribeAcc(acc) {
    var e = acc.trigEntered;
    // cp/FIN are informational only — nothing scores off them now. They're the
    // cross-check on your box placement: the game's own checkpoint count and finish
    // frame, independent of where you dropped the boxes. "box 1/3 cp4" means the car is
    // getting down the track fine and a box is in the wrong place.
    var fin = " cp" + acc.maxCp + (acc.finished ? " FIN@" + acc.finishFrames : "");
    // Completed: show arrival frame + exit speed at the check frame (the two scored
    // terms). Incomplete: closest approach to the next box + its speed ("algn" if the
    // aligned metric is on — see bfAccumulate).
    if (e >= BF.triggers.length) return "all " + e + " boxes @f" + (acc.trigEntryFrame || acc.lastFrame) + " exit" + (acc.checkSpeed != null ? acc.checkSpeed : acc.lastSpeed).toFixed(3) + fin;
    return "box " + e + "/" + BF.triggers.length + " d" + (acc.trigMinDist === Infinity ? "?" : acc.trigMinDist.toFixed(3)) + (BF.align ? " algn" : " spd") + acc.trigSpeedAt.toFixed(3) + fin;
  }

  async function bfSendVariant(slot, island) {
    slot.busy = true;
    var variant;
    if (island < 0) { variant = bfCloneVariant(BF.base); slot.mut = null; slot._sig = null; } // seed pass: the unmutated base
    else {
      var isl = BF.islands[island];
      // Keep the strength this variant was actually born at — by the time it finalizes,
      // a PB has already reset its island's stalls, so recomputing it there would always
      // report full strength and tell you nothing about the anneal.
      slot.mut = bfMutStrength(island);
      var parent = bfSelectParent(isl), tries = 0, sig;
      // Re-mutate a few times if we produced a genome we've already evaluated (dedup).
      var _hot = parent ? parent.hot : NaN;
      do {
        if (BF.crossover && isl && isl.pop && isl.pop.length >= 2 && Math.random() < 0.2) {
          variant = bfMutate(bfCrossover(parent.variant, bfSelectParent(isl).variant), slot.mut, _hot);
        } else {
          variant = bfMutate(parent ? parent.variant : BF.base, slot.mut, _hot);
        }
        sig = bfSignature(variant);
      } while (BF.seen && BF.seen.has(sig) && ++tries < 3);
      slot._sig = sig;
      if (BF.seen) { if (BF.seen.size > 300000) BF.seen.clear(); BF.seen.add(sig); }
    }
    // Snapshot mode reuses ONE persistent car per worker (fixed id); otherwise a
    // fresh car id per variant.
    var carId = BF.snapshot ? slot.bfCarId : BF.carIdSeq++;
    var rec = bfVariantToRecording(variant);
    var encoded, rawCh;
    // Snapshot mode sends the RAW toggle channels (rec.ch IS the recording) — no
    // deflate on the way out, no inflate in the worker. The other path needs the
    // game's serialized format for CreateCar.
    if (BF.snapshot) { rawCh = [rec.ch.up, rec.ch.right, rec.ch.down, rec.ch.left, rec.ch.reset]; }
    else { try { encoded = await rec.serialize(); } catch (e) { slot.busy = false; BF.iterLeft++; if (BF.running) bfPump(); return; } }
    if (!BF.running) { slot.busy = false; return; }
    slot.carId = carId; slot.acc = bfNewAcc(variant); slot.acc._sig = slot._sig; slot.island = island; slot.ts = perfNow();
    BF.pending.set(carId, slot);
    var ctx = BF.ctx;
    try {
      if (BF.snapshot) {
        // The worker scores the whole run IN-THREAD and returns just {score,info}
        // — no per-frame car states cross the wire (the big communication win).
        // trackData / mountainVertices / cfg are NOT resent per variant: the worker
        // cached them from the single __bfInit at spawn (see bfSpawnWorkers).
        slot.worker.postMessage({ __bfSnap: true, carId: carId, prefixKey: BF._runId, startFrame: BF.startFrame, targetSimulationFrames: BF.horizon, rawCh: rawCh });
      } else {
        slot.worker.postMessage({ messageType: capture.msgType.createCar, mountainVertices: ctx.mountainVertices, mountainOffset: ctx.mountainOffset, trackData: ctx.trackData, carId: carId, carRecording: encoded });
        slot.worker.postMessage({ messageType: capture.msgType.startCar, carId: carId, targetSimulationTimeFrames: BF.horizon });
      }
    } catch (e) { TAS.log("BF dispatch err: " + e); slot.busy = false; BF.pending.delete(carId); slot.carId = null; }
  }

  function perfNow() { try { return performance.now(); } catch (e) { return 0; } }

  /* Headless: simulate ONE recording flat-out in a fresh stock worker and
   * resolve its finish time. Used by the TAS Board to verify + time a full-TAS
   * editor script before upload (a TAS run is never hand-driven, so the game
   * never produces a submittable recording for it). Reuses the BF worker
   * protocol; needs the captured track context (enter+drive the track once). */
  function boardSimulateFinish(encoded, horizon) {
    return new Promise(function (resolve, reject) {
      if (!capture.init || !capture.lastCar || capture.lastCar.trackData == null) { reject(new Error("enter the track and drive once first (no captured track data yet)")); return; }
      var Real = capture._RealWorker || window.Worker, w;
      try { w = new Real(SIM_WORKER_FILE); } catch (e) { reject(e); return; }
      var carId = 8100000 + ((Math.random() * 100000) | 0), done = false;
      var cap = Math.min(Recording.MAX_FRAMES, horizon || Recording.MAX_FRAMES);
      function fin(res, err) { if (done) return; done = true; clearTimeout(to); try { w.terminate(); } catch (e) {} err ? reject(err) : resolve(res); }
      var to = setTimeout(function () { fin(null, new Error("simulation timed out")); }, 25000);
      w.onmessage = function (ev) {
        var d = ev.data; if (!d || !d.carStateBuffers) return;
        for (var i = 0; i < d.carStateBuffers.length; i++) {
          var st = parseUpdateBuffer(d.carStateBuffers[i]); if (!st || st.carId !== carId) continue;
          if (st.finished) { fin({ finishFrames: st.finishFrames }); return; }
          if (st.frames >= cap) { fin(null, new Error("run didn't finish within the simulated horizon")); return; }
        }
      };
      w.onerror = function (ev) { fin(null, new Error("worker: " + (ev && ev.message || ev))); };
      try {
        w.postMessage({ messageType: capture.msgType.init, version: (capture.init.version || GAME_VERSION), isRealtime: false, trackParts: capture.init.trackParts, carCollisionShapeVertices: capture.init.carCollisionShapeVertices, carMassOffset: capture.init.carMassOffset });
        w.postMessage({ messageType: capture.msgType.createCar, mountainVertices: capture.lastCar.mountainVertices, mountainOffset: capture.lastCar.mountainOffset, trackData: capture.lastCar.trackData, carId: carId, carRecording: encoded });
        w.postMessage({ messageType: capture.msgType.startCar, carId: carId, targetSimulationTimeFrames: cap });
      } catch (e) { fin(null, e); }
    });
  }

  // Is there budget left to dispatch another variant? Iterations are consumed per
  // dispatch; the time limit is a wall-clock deadline, so BF stops issuing new work the
  // instant it expires (a hard timer in bfStart also finishes the run at exactly that
  // moment, rather than waiting on whatever is still in flight).
  function bfBudgetLeft() {
    if (BF.limitMode === "never") return true;
    if (BF.limitMode === "time") return perfNow() < BF.deadline;
    return BF.iterLeft > 0;
  }
  function bfPump() {
    if (!BF.running) return;
    // Seed phase: evaluate the unmutated base ONCE (on a single worker) before the
    // populations diverge, so each starts from a scored copy of the base inputs.
    if (!BF._baseDone) {
      if (!BF._baseDispatched) {
        for (var s = 0; s < BF.workers.length; s++) { if (!BF.workers[s].busy) { BF._baseDispatched = true; if (BF.limitMode === "iters") BF.iterLeft--; bfSendVariant(BF.workers[s], -1); break; } }
      }
      return; // other workers wait ~one sim until the islands are seeded
    }
    var anyBusy = false;
    for (var i = 0; i < BF.workers.length; i++) {
      var slot = BF.workers[i];
      if (slot.busy) { anyBusy = true; continue; }
      if (!bfBudgetLeft()) continue;
      if (BF.limitMode === "iters") BF.iterLeft--;
      // Round-robin across the populations: each free worker advances the next one.
      BF._isl = (BF._isl + 1) % BF.numIslands;
      bfSendVariant(slot, BF._isl);
      anyBusy = true;
    }
    if (!anyBusy && BF.pending.size === 0 && !bfBudgetLeft()) bfFinish();
  }

  // Reaper: reclaim a worker whose variant never reported a terminal frame.
  function bfReap() {
    var now = perfNow(), timeout = Math.max(8000, BF.horizon * 4);
    BF.pending.forEach(function (slot, carId) {
      if (now - slot.ts > timeout) {
        if (slot.island < 0 && !BF._baseDone) BF._baseDispatched = false; // base seed died → let bfPump re-issue it (else deadlock)
        if (!BF.snapshot) { try { slot.worker.postMessage({ messageType: capture.msgType.deleteCar, carId: carId }); } catch (e) {} }
        BF.pending.delete(carId); slot.carId = null; slot.acc = null; slot.busy = false; slot.island = undefined;
      }
    });
    if (BF.running) bfPump();
  }

  function bfStart(opts) {
    if (BF.running) return { ok: false, msg: "already running" };
    if (!capture.init || !capture.lastCar) return { ok: false, msg: "Enter a track and drive once first (need captured track data)." };
    var _allTrig = opts.triggers || [];
    BF.triggers = _allTrig.filter(function (t) { return !t.nogo; }); // ordered objective boxes
    BF.nogos = _allTrig.filter(function (t) { return t.nogo; });     // forbidden boxes
    BF.blend = opts.blend; BF.startFrame = opts.startFrame; BF.endFrame = opts.endFrame;
    BF.allowed = bfParseAllowed(opts.keys); BF.mut = opts.mut;
    BF.align = !!opts.align;
    BF.cool = opts.cool !== false;
    // Crash/dead detection (C1).
    BF.deadAbort = opts.deadAbort !== false;
    BF.deadLimit = Math.max(50, opts.deadLimit | 0 || 500);
    BF.deadSpeed = opts.deadSpeed > 0 ? opts.deadSpeed : 1;
    BF.crashWeight = opts.crashWeight >= 0 ? +opts.crashWeight : 0;
    BF.crashDecel = opts.crashDecel > 0 ? +opts.crashDecel : 6;
    // Stop condition — one of iterations / seconds / never, replacing the old
    // iterations-box-plus-"run forever"-checkbox pair.
    BF.limitMode = (opts.limitMode === "time" || opts.limitMode === "never") ? opts.limitMode : "iters";
    BF.infinite = (BF.limitMode === "never");
    BF.limitSeconds = BF.limitMode === "time" ? Math.max(1, opts.limitValue | 0) : 0;
    BF.iterLeft = BF.limitMode === "iters" ? Math.max(1, opts.limitValue | 0) : Infinity;
    if (BF.endFrame <= BF.startFrame) return { ok: false, msg: "End frame must be > start frame." };
    if (BF.allowed.length === 1 && BF.allowed[0] === "") return { ok: false, msg: 'Keys must include at least one non-empty keyset (e.g. "w, wd").' };
    if (!BF.triggers.length) return { ok: false, msg: BF.nogos.length ? "Add at least one ordered (non no-go) trigger box — put one on each checkpoint you want hit, and one on the finish line." : "Add at least one trigger box (⊕ at car is the quick way — scrub to a checkpoint and click it)." };
    // Validate the captured track context up front (the worker dereferences
    // mountainOffset.x/.y/.z and would otherwise throw silently per variant).
    var lc = capture.lastCar, mo = lc && lc.mountainOffset;
    if (!lc || lc.trackData == null || lc.mountainVertices == null || !mo || typeof mo.x !== "number") return { ok: false, msg: "Captured track data looks incomplete — re-enter the track and drive once." };

    // Base variant. tap-edit ON keeps tap macros structured (their params become
    // mutable); OFF expands them into the flat state map (fully frame-editable).
    BF.tapEdit = !!opts.tapEdit; BF.tapMut = opts.tapMut || null;
    var baseVar;
    if (BF.tapEdit) baseVar = bfParseGenome(opts.baseText || "");
    else { var entries = compileScript(opts.baseText || ""); baseVar = { map: new Map(entries.map(function (e) { return [e.frame, e.keys]; })), taps: [] }; }
    // Fixed end-anchor: freeze the compiled state at endFrame so window edits (and
    // tap tweaks) don't bleed past. Computed from the fully-expanded base.
    var compiled0 = new Map(baseVar.map);
    for (var _t = 0; _t < baseVar.taps.length; _t++) bfExpandTapInto(compiled0, baseVar.taps[_t]);
    BF.endState = bfStateAtMap(compiled0, BF.endFrame);
    // Freeze the WHOLE post-window tail (every frame >= endFrame) to the base
    // expansion, not just the endFrame anchor — otherwise a non-editable tap whose
    // span reaches past endFrame would re-derive its off-phase (prev) values from
    // mutated in-window state, leaking window edits past the window (unfair scoring).
    BF.tail = new Map(); compiled0.forEach(function (val, f) { if (f >= BF.endFrame) BF.tail.set(f, val); });
    BF.tail.set(BF.endFrame, BF.endState);
    BF.base = baseVar;

    // horizon: how far each variant is simulated. Auto = past the base inputs
    // and the captured run's finish (if the player has completed the track),
    // with a margin; the Check-frame field overrides it.
    var lastFrame = 0; compiled0.forEach(function (v, f) { if (f > lastFrame) lastFrame = f; });
    var pst = capture.latest.get(capture.playerCarId); var playerFin = (pst && pst.finishFrames) ? pst.finishFrames : 0;
    BF.horizon = Math.min(Recording.MAX_FRAMES, opts.checkFrame > 0 ? Math.max(BF.endFrame, opts.checkFrame) : (Math.max(BF.endFrame, lastFrame, playerFin) + 4000));
    // Common speed-check frame: the fixed frame at which every run's exit speed is read
    // (see bfScore). Defaults to the window end — the section-exit boundary, past which
    // all inputs are frozen identical, so it's the fair place to compare how the window
    // was driven. The Check-frame field overrides it to measure further out. Clamped to
    // the horizon so a completed run is always guaranteed to reach it.
    BF.speedFrame = Math.max(1, Math.min(BF.horizon, opts.checkFrame > 0 ? opts.checkFrame : BF.endFrame));

    BF.ctx = { trackData: capture.lastCar.trackData, mountainVertices: capture.lastCar.mountainVertices, mountainOffset: capture.lastCar.mountainOffset };
    BF.best = null; BF.baseResult = null; BF.totalRuns = 0; BF.migrations = 0;
    BF.pbQueue = []; BF.pbDropped = 0;
    BF._baseDispatched = false; BF._baseDone = false; BF._isl = -1;
    BF.numIslands = Math.max(1, Math.min(64, opts.islands | 0 || 1));
    BF.islands = []; for (var _i = 0; _i < BF.numIslands; _i++) BF.islands[_i] = { best: null, pop: [], stalls: 0 };
    BF.stallLimit = Math.max(20, opts.stallLimit | 0 || 250);
    // Each island keeps a pool of its top-K variants (B1); tournament-selects a parent
    // from it (annealed, = B4) and occasionally recombines two elites (B2). Dedup skips
    // re-evaluating genomes already tried (A5).
    BF.poolSize = Math.max(1, Math.min(24, opts.poolSize | 0 || 6));
    BF.crossover = opts.crossover !== false;
    BF.seen = new Set();
    // In-thread scoring is now the DEFAULT (A1): the worker runs + scores each variant and
    // returns only {score,info,hot} — no per-frame CarState streamed back, no deflate on
    // dispatch. It handles startFrame 0 by recreating the car per variant (A2-lite) and
    // startFrame>0 by the heap snapshot. Uncheck the box only to fall back to the legacy
    // streaming path (e.g. an unpatched worker). `snapshot` is the flag that selects it.
    BF.snapshot = opts.snapshot !== false; BF._runId++; // per-run id so workers rebuild their snapshot
    // Scoring config handed to the worker so it can score in-thread (snapshot mode).
    BF._cfg = { triggers: BF.triggers, nogos: BF.nogos, blend: BF.blend, align: BF.align, speedFrame: BF.speedFrame,
      deadAbort: BF.deadAbort, deadLimit: BF.deadLimit, deadSpeed: BF.deadSpeed, crashDecel: BF.crashDecel, crashWeight: BF.crashWeight, startFrame: BF.startFrame };
    BF.pending.clear(); BF.workers = [];

    // Clamp to the machine's real thread count: more physics workers than cores just
    // time-slices the same CPUs and *lowers* runs/sec (negative scaling). hardwareConcurrency
    // is the parallelism ceiling; honour a smaller user value, never exceed it.
    var _hc = 0; try { _hc = navigator.hardwareConcurrency || 0; } catch (e) {}
    var n = Math.max(1, Math.min(256, opts.workers | 0 || 4));
    if (_hc > 0 && n > _hc) { n = _hc; BF.workersCapped = true; } else BF.workersCapped = false;
    bfSpawnWorkers(n);
    if (!BF.workers.length) return { ok: false, msg: "Failed to spawn workers." };
    BF.running = true;
    BF.startedAt = perfNow(); BF.bestAtRun = 0;
    // Time limit: stop dispatching at the deadline (bfBudgetLeft) AND hard-finish on a
    // timer, so "30 seconds" means 30 seconds rather than 30 seconds plus however long
    // the last batch of in-flight variants happens to take.
    BF.deadline = BF.limitMode === "time" ? BF.startedAt + BF.limitSeconds * 1000 : Infinity;
    if (BF.limitTimer) { clearTimeout(BF.limitTimer); BF.limitTimer = null; }
    if (BF.limitMode === "time") BF.limitTimer = setTimeout(function () { if (BF.running) bfFinish(); }, BF.limitSeconds * 1000);
    BF.reaper = setInterval(bfReap, 4000);
    bfPump();
    return { ok: true };
  }

  function bfStop() {
    BF.running = false;
    if (BF.limitTimer) { clearTimeout(BF.limitTimer); BF.limitTimer = null; }
    if (BF.reaper) { clearInterval(BF.reaper); BF.reaper = null; }
    for (var i = 0; i < BF.workers.length; i++) { try { BF.workers[i].worker.terminate(); } catch (e) {} }
    BF.workers = []; BF.pending.clear();
  }
  function bfFinish() { bfStop(); if (BF.onUpdate) BF.onUpdate(false, true); }
  function bfBestText() { if (!BF.best) return null; var rec = bfVariantToRecording(BF.best.variant); return BF.tapEdit ? compactScript(recordingToScript(rec)) : recordingToScript(rec); }
  TAS.bfStart = bfStart; TAS.bfStop = bfStop; TAS.bfBestText = bfBestText;

  /* ================================================================== *
   * 5. UI  (overlay + panel + editor)  — built on DOMContentLoaded
   * ================================================================== */
  /* ---- Bruteforce UI (appended into the panel body) ---- */
  function buildBruteforce(panel) {
    var host = panel.body;
    var el = document.createElement("div"); el.id = "tas-bf"; el.className = "collapsed";
    // Sectioned layout (E): each group is a native <details> so advanced knobs collapse
    // out of the way, and the long explanations moved from inline paragraphs into `?`
    // tooltips (title=) so the panel reads clean instead of cramped. Every element id the
    // handlers below rely on is preserved; new controls: bf-pool, bf-crossover, bf-deadabort, bf-crashw.
    el.innerHTML =
      '<div class="bfhead"><span class="chev">▸</span><b>Brute Force</b><span class="bfpill" id="bf-pill">idle</span></div>' +
      '<div class="bfbody">' +
        '<details class="bfsec" open><summary>Search window</summary>' +
          '<div class="grid">' +
            '<label title="First frame the search may edit.">Start</label><input id="bf-start" type="number" placeholder="0">' +
            '<label title="Last editable frame; everything from here on is frozen to the base run.">End</label><input id="bf-end" type="number" placeholder="2000">' +
            '<label title="Frame each run is checked at: exit speed is sampled here (same frame for every run, so speed compares fairly) and it caps the sim. Blank = the End frame.">Check</label><input id="bf-check" type="number" placeholder="auto = End">' +
            '<label title="Key combos the search may use, comma-separated. e.g. w, wa, wd, none">Keys</label><input id="bf-keys" value="' + KEYSETS_DEFAULT + '">' +
          '</div>' +
        '</details>' +
        '<details class="bfsec" open><summary>Objective — trigger boxes</summary>' +
          '<div class="hint">Driven through <b>in order</b>: one box per checkpoint you care about + one on the finish line. Tick <b>no-go</b> to invalidate any run that enters a box.</div>' +
          '<div id="bf-triggers"></div>' +
          '<div class="mini"><button id="bf-tr-add">+ box</button><button id="bf-tr-atcar" title="Add a box at the car\'s current position (scrub a replay first)">+ at car</button></div>' +
          '<div class="trow"><span class="tlab">dist</span><input type="range" id="bf-blend" min="0" max="100" value="50" style="flex:1;width:auto"><span class="tlab">speed</span><span id="bf-blend-r" class="bfpill">50/50</span></div>' +
          '<label class="ck"><input type="checkbox" id="bf-align"> 🧭 Vector-aligned speed<span class="q" title="Score the speed term by how much of the car\'s velocity points AT the next box, so a run fast in the wrong direction stops out-scoring a slower one that\'s arriving. Only affects runs that miss the box; entry speed stays raw.">?</span></label>' +
          '<label class="ck"><input type="checkbox" id="bf-show3d" checked> Draw boxes in 3D<span class="q" title="Draw the boxes into the game\'s 3D view — yellow inside, red = no-go.">?</span></label>' +
        '</details>' +
        '<details class="bfsec" open><summary>Compute</summary>' +
          '<div class="grid">' +
            '<label title="Physics workers. Auto-capped to your CPU thread count (more just slows it down).">Workers</label><div class="mini"><input id="bf-workers" type="number" value="4" min="1" max="256" style="flex:1"><button id="bf-workers-max" title="Use every CPU thread">Max</button></div>' +
            '<label title="Independent search populations. Each evolves its own line, so one getting stuck doesn\'t stall the rest.">Populations</label><input id="bf-islands" type="number" value="4" min="1" max="64">' +
            '<label title="How many top variants each population keeps and breeds from. Bigger = more diverse, slightly slower to converge.">Pool</label><input id="bf-pool" type="number" value="6" min="1" max="24">' +
            '<label title="When to stop: after N variants, after a wall-clock time, or never.">Stop after</label>' +
            '<div class="mini"><input id="bf-limit-n" type="number" value="100000" style="flex:1"><select id="bf-limit-mode" style="flex:1"><option value="iters">iterations</option><option value="time">seconds</option><option value="never">never</option></select></div>' +
          '</div>' +
          '<label class="ck"><input type="checkbox" id="bf-snapshot" checked> ⚡ In-thread scoring (fast)<span class="q" title="The worker runs AND scores each variant and returns only the result — no per-frame data streamed back, no encode on dispatch. Much faster and the default. Uncheck only for an unpatched worker (legacy streaming path).">?</span></label>' +
        '</details>' +
        '<details class="bfsec"><summary>Mutation</summary>' +
          '<div class="sub">rate · maxShift · shift / toggle / insert weights</div>' +
          '<div class="mini">' +
            '<input id="bf-rate" type="number" value="3" title="max mutations per iteration">' +
            '<input id="bf-shift" type="number" value="30" title="max frame shift">' +
            '<input id="bf-ws" type="number" value="3" title="shift weight">' +
            '<input id="bf-wt" type="number" value="1" title="toggle weight">' +
            '<input id="bf-wi" type="number" value="3" title="insert weight">' +
          '</div>' +
          '<label class="ck"><input type="checkbox" id="bf-cool" checked> ❄ Adaptive cooling<span class="q" title="Each population starts at the rate/maxShift above and anneals toward 1 the longer it goes without a new best, resetting on a new best. Big shifts find the line, small ones polish it — no need to retune mid-search.">?</span></label>' +
          '<label class="ck"><input type="checkbox" id="bf-crossover" checked> ⚭ Crossover<span class="q" title="Sometimes breed a new line by splicing two good ones at a random frame — recombines corners solved by different populations.">?</span></label>' +
          '<label class="ck"><input type="checkbox" id="bf-tapedit"> Edit <code>tap</code> macros as units<span class="q" title="Mutate each tap\'s start/end/keys/on/off (weights below) instead of expanding it. Off = expand & free-edit. On + all weights 0 = protect taps.">?</span></label>' +
          '<div id="bf-tap-sub" style="display:none">' +
            '<div class="sub">tap weights — start · end · input · hold · release</div>' +
            '<div class="mini">' +
              '<input id="bf-tw-start" type="number" value="1" min="0" title="shift a tap\'s START frame">' +
              '<input id="bf-tw-end" type="number" value="1" min="0" title="shift a tap\'s END frame">' +
              '<input id="bf-tw-keys" type="number" value="1" min="0" title="change a tap\'s input keys">' +
              '<input id="bf-tw-on" type="number" value="1" min="0" title="change a tap\'s hold (on) count">' +
              '<input id="bf-tw-off" type="number" value="1" min="0" title="change a tap\'s release (off) count">' +
            '</div>' +
          '</div>' +
        '</details>' +
        '<details class="bfsec"><summary>Crash handling</summary>' +
          '<label class="ck"><input type="checkbox" id="bf-deadabort" checked> Abort dead runs<span class="q" title="Kill a run that\'s been stopped/wedged for a while — it will never reach the box — and reclaim the worker. Pure speed, no downside.">?</span></label>' +
          '<div class="grid"><label title="Penalty weight for hard impacts (deceleration spikes). 0 = ignore crashes, since a fast wall-scrape is sometimes optimal. Raise it to steer toward clean lines.">Crash penalty</label><input id="bf-crashw" type="number" value="0" min="0" step="any"></div>' +
        '</details>' +
        '<details class="bfsec"><summary>Output &amp; sharing</summary>' +
          '<div class="grid"><label>Save best to</label><div class="mini"><input id="bf-file" placeholder="filename — auto-saved each best" style="flex:1"><button id="bf-open" title="Open a saved run into the editor">Open…</button></div></div>' +
          '<div class="mini"><button id="bf-export" style="flex:1" title="Copy every setting (incl. trigger boxes) as a JSON block to share">⇪ Export</button><button id="bf-import" style="flex:1" title="Paste someone else\'s exported settings">⇩ Import</button></div>' +
        '</details>' +
        '<div class="mini"><button id="bf-go" class="bfstart">Start BF</button></div>' +
        '<div class="bfbest" id="bf-best">Best: — (auto-written to the editor)</div>' +
        '<div class="bfstats" id="bf-stats">' +
          '<span class="k">state</span><span id="bfs-state">idle</span>' +
          '<span class="k">best score</span><span id="bfs-score">—</span>' +
          '<span class="k">runs</span><span id="bfs-runs">0</span>' +
          '<span class="k">runs/sec</span><span id="bfs-rate">0</span>' +
          '<span class="k">elapsed</span><span id="bfs-elapsed">0s</span>' +
          '<span class="k">since best</span><span id="bfs-stag">—</span>' +
          '<span class="k">workers</span><span id="bfs-workers">0 / 0</span>' +
          '<span class="k">pending</span><span id="bfs-pending">0</span>' +
          '<span class="k">budget left</span><span id="bfs-iters">—</span>' +
          '<span class="k">horizon</span><span id="bfs-horizon">—</span>' +
        '</div>' +
        '<div class="bflog" id="bf-log"></div>' +
      '</div>';
    host.appendChild(el);
    var $ = function (id) { return el.querySelector("#" + id); };
    try { $("bf-workers").value = Math.max(1, Math.min(256, (navigator.hardwareConcurrency || 4) - 1)); } catch (e) {}
    if ($("bf-workers-max")) $("bf-workers-max").onclick = function () { $("bf-workers").value = Math.max(1, Math.min(256, (navigator.hardwareConcurrency || 8))); };

    el.querySelector(".bfhead").onclick = function () { el.classList.toggle("collapsed"); el.querySelector(".chev").textContent = el.classList.contains("collapsed") ? "▸" : "▾"; };
    $("bf-blend").oninput = function () { var v = +this.value; $("bf-blend-r").textContent = (100 - v) + "/" + v; };
    $("bf-tapedit").onchange = function () { $("bf-tap-sub").style.display = this.checked ? "" : "none"; };
    // Set while bfImportSettings is writing fields, so handlers can tell a real user
    // interaction from a programmatic import.
    var bfImporting = false;
    // "never" takes no value; swapping units re-defaults an obviously-wrong carry-over
    // so you don't ask for 100000 SECONDS after switching from 100000 iterations.
    $("bf-limit-mode").onchange = function () {
      var n = $("bf-limit-n");
      n.style.display = this.value === "never" ? "none" : "";
      // Never on import: the incoming value is intentional, whatever it is. Without this
      // guard, importing "500 iterations" would silently become 100000.
      if (bfImporting) return;
      if (this.value === "time" && +n.value > 86400) n.value = 60;
      if (this.value === "iters" && +n.value < 1000) n.value = 100000;
    };

    var trHost = $("bf-triggers");
    function addTrigger(init) {
      var row = document.createElement("div"); row.className = "trbox";
      function inp(role, ph, val) { return '<input data-r="' + role + '" type="number" step="any" placeholder="' + ph + '" value="' + (val == null ? "" : val) + '">'; }
      row.innerHTML =
        '<div class="trline"><span class="tlab">center</span>' + inp("x", "X", init && init.x) + inp("y", "Y", init && init.y) + inp("z", "Z", init && init.z) + '</div>' +
        '<div class="trline"><span class="tlab">size</span>' + inp("sx", "X", init ? (init.sx != null ? init.sx : 4) : 4) + inp("sy", "Y", init ? (init.sy != null ? init.sy : 4) : 4) + inp("sz", "Z", init ? (init.sz != null ? init.sz : 4) : 4) + '</div>' +
        '<div class="trfoot">' +
          '<label title="No-go: any run that enters this box is invalidated"><input data-r="nogo" type="checkbox"' + (init && init.nogo ? " checked" : "") + ' style="width:auto"> no-go (invalidates runs)</label>' +
          '<button data-r="rm" title="remove this box">Remove</button>' +
        '</div>';
      row.querySelector('[data-r="rm"]').onclick = function () { row.remove(); };
      trHost.appendChild(row);
    }
    function readTriggers() {
      var out = [], rows = trHost.querySelectorAll(".trbox");
      for (var i = 0; i < rows.length; i++) {
        var g = function (r) { return parseFloat(rows[i].querySelector('[data-r="' + r + '"]').value); };
        var x = g("x"), y = g("y"), z = g("z");
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        var sx = g("sx"), sy = g("sy"), sz = g("sz");
        var ng = rows[i].querySelector('[data-r="nogo"]');
        out.push({ x: x, y: y, z: z, sx: isFinite(sx) ? Math.abs(sx) : 0, sy: isFinite(sy) ? Math.abs(sy) : 0, sz: isFinite(sz) ? Math.abs(sz) : 0, nogo: !!(ng && ng.checked) });
      }
      return out;
    }

    /* ---- Share bruteforce settings (export / import) ----------------------
     * ONE table drives both directions, so a control can't end up exported but not
     * importable (or vice versa) as the panel grows — add a row here and it just works.
     *
     * Deliberately NOT included:
     *   · "Save best to"  — a local output filename; importing it would silently point
     *                       your friend's auto-save at a file named after your run.
     *   · the editor script — that's the TAS itself, not a search setting. Share it via
     *                       the board, or Save/Open a .tas.
     * Trigger boxes ARE included (they're the substance of a trigger search), but they
     * are world coordinates — so the export stamps the track it came from and import
     * warns on a mismatch instead of silently applying boxes that don't line up.
     */
    var BF_SETTINGS = [
      ["bf-start", "startFrame"], ["bf-end", "endFrame"], ["bf-check", "checkFrame"],
      ["bf-keys", "keys"], ["bf-workers", "workers"], ["bf-islands", "populations"],
      ["bf-limit-n", "stopAfter"], ["bf-limit-mode", "stopAfterUnit"],
      ["bf-blend", "distSpeedBlend"], ["bf-align", "vectorAlignedSpeed"], ["bf-show3d", "draw3dBoxes"],
      ["bf-rate", "mutRate"], ["bf-shift", "mutMaxShift"],
      ["bf-ws", "weightShift"], ["bf-wt", "weightToggle"], ["bf-wi", "weightInsert"],
      ["bf-cool", "adaptiveCooling"], ["bf-tapedit", "tapEdit"],
      ["bf-tw-start", "tapWeightStart"], ["bf-tw-end", "tapWeightEnd"], ["bf-tw-keys", "tapWeightKeys"],
      ["bf-tw-on", "tapWeightOn"], ["bf-tw-off", "tapWeightOff"],
      ["bf-snapshot", "inThreadScoring"], ["bf-pool", "poolSize"], ["bf-crossover", "crossover"],
      ["bf-deadabort", "deadAbort"], ["bf-crashw", "crashPenalty"]
    ];
    function bfIdForKey(k) { for (var i = 0; i < BF_SETTINGS.length; i++) if (BF_SETTINGS[i][1] === k) return BF_SETTINGS[i][0]; return null; }
    function bfGetField(el) {
      if (el.type === "checkbox") return !!el.checked;
      // null (not "") for a blank number so the JSON reads honestly — e.g. Check frame
      // left blank is "auto", and null round-trips back to blank on import.
      if (el.type === "number" || el.type === "range") { var n = parseFloat(el.value); return isFinite(n) ? n : null; }
      return el.value;
    }
    function bfSetField(el, v) {
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = (v == null ? "" : String(v));
      // Several controls drive layout/labels from their own handler (objective → which
      // sub-panel is visible, blend → its readout, tapedit → the weights block, show3d →
      // TAS.showBoxes). Fire them, or the panel shows sections that don't match the values.
      try { el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); } catch (e) {}
    }
    function bfExportSettings() {
      var out = {};
      for (var i = 0; i < BF_SETTINGS.length; i++) { var el = $(BF_SETTINGS[i][0]); if (el) out[BF_SETTINGS[i][1]] = bfGetField(el); }
      return JSON.stringify({
        tas: "bf-settings", v: 1, tool: TAS.version, game: GAME_VERSION,
        track: TAS.currentTrackId || null,
        exported: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        settings: out, triggers: readTriggers()
      }, null, 2);
    }
    function bfImportSettings(text) {
      var o;
      try { o = JSON.parse(String(text || "").trim()); }
      catch (e) { return { ok: false, msg: "that isn't valid JSON — paste the whole block including the outer { and }." }; }
      if (!o || o.tas !== "bf-settings") return { ok: false, msg: 'that JSON isn\'t a bruteforce settings export (no "tas": "bf-settings" tag).' };
      if (!o.settings || typeof o.settings !== "object") return { ok: false, msg: 'the export has no "settings" block.' };
      var applied = 0, unknown = [];
      // Suppress the interactive "re-default on unit swap" heuristics while we write:
      // every incoming value is deliberate and must land exactly as exported.
      bfImporting = true;
      try {
        for (var k in o.settings) {
          if (!Object.prototype.hasOwnProperty.call(o.settings, k)) continue;
          var el = bfIdForKey(k) && $(bfIdForKey(k));
          if (!el) { unknown.push(k); continue; }   // newer/older export — skip, don't fail the whole import
          bfSetField(el, o.settings[k]); applied++;
        }
      } finally { bfImporting = false; }
      // Triggers replace wholesale: they're an ordered route, not a set to merge into.
      var trig = Array.isArray(o.triggers) ? o.triggers : null;
      if (trig) {
        trHost.innerHTML = "";
        for (var t = 0; t < trig.length; t++) addTrigger(trig[t]);
        if (!trig.length) addTrigger(null);       // keep the single blank seed row
      }
      var notes = [];
      if (unknown.length) notes.push(unknown.length + " unknown setting" + (unknown.length > 1 ? "s" : "") + " ignored (" + unknown.slice(0, 3).join(", ") + (unknown.length > 3 ? "…" : "") + ")");
      if (o.track && TAS.currentTrackId && o.track !== TAS.currentTrackId) notes.push("⚠ exported on a DIFFERENT track — trigger boxes are world coordinates and won't line up");
      var hw = 0; try { hw = navigator.hardwareConcurrency || 0; } catch (e) {}
      if (hw && o.settings.workers > hw) notes.push("⚠ workers=" + o.settings.workers + " but this machine reports " + hw + " threads — lower it or hit Max");
      return { ok: true, applied: applied, triggers: trig ? trig.length : 0, notes: notes };
    }
    function bfReportImport(text) {
      var r = bfImportSettings(text);
      if (!r.ok) { panel.setStatus("Import failed: " + r.msg); toast("Import failed"); return; }
      var msg = "Imported " + r.applied + " setting" + (r.applied === 1 ? "" : "s") + " + " + r.triggers + " trigger box" + (r.triggers === 1 ? "" : "es") + ".";
      if (r.notes.length) msg += " " + r.notes.join(" · ");
      panel.setStatus(msg); toast("Settings imported");
    }
    TAS.bfExportSettings = bfExportSettings; TAS.bfImportSettings = bfImportSettings;

    $("bf-export").onclick = async function () {
      var json = bfExportSettings();
      copyText(json);
      var r = await tasModal({
        title: "Bruteforce settings",
        message: "Copied to your clipboard — send it over and they load it with ⇩ Import settings.\nYour editor script and 'Save best to' filename are not included.",
        textarea: { value: json, rows: 14 }, cancelValue: null,
        // tasModal's primary button resolves with the field's text, so "Done" comes back
        // as the JSON itself — only the non-primary "Save .json" can match "save" here.
        buttons: [{ label: "Save .json", value: "save" }, { label: "Done", value: "done", primary: true }]
      });
      if (r === "save") saveText(json, "bf-settings" + (TAS.currentTrackId ? "-" + String(TAS.currentTrackId).slice(0, 8) : "") + ".json");
    };
    $("bf-import").onclick = async function () {
      var text = await tasModal({
        title: "Import bruteforce settings",
        message: "Paste an exported settings block. This overwrites every bruteforce field on the panel, including the trigger boxes.",
        textarea: { value: "", rows: 14, placeholder: '{\n  "tas": "bf-settings",\n  ...\n}' }, cancelValue: null,
        buttons: [{ label: "Cancel", value: null }, { label: "Load .json…", value: "file" }, { label: "Import", value: true, primary: true }]
      });
      if (text == null) return;
      if (text === "file") { loadTextFile(bfReportImport, ".json,.txt"); return; }
      bfReportImport(text);
    };

    // Expose the live trigger list (incl. the no-go flag) for the 3D box overlay.
    // Drawn whenever valid boxes exist (readTriggers skips blank rows), regardless
    // of the objective dropdown, so you can see boxes while placing them.
    TAS.getBfTriggers = function () { return readTriggers(); };
    TAS.showBoxes = true;
    if ($("bf-show3d")) $("bf-show3d").onchange = function () { TAS.showBoxes = this.checked; };

    $("bf-tr-add").onclick = function () { addTrigger(null); };
    $("bf-tr-atcar").onclick = function () {
      var st = currentCarState();
      if (!st || !st.position) { panel.setStatus("No car position yet — scrub a replay (or drive) first."); return; }
      addTrigger({ x: Math.round(st.position.x * 100) / 100, y: Math.round(st.position.y * 100) / 100, z: Math.round(st.position.z * 100) / 100 });
    };

    var logEl = $("bf-log"), bestEl = $("bf-best"), pill = $("bf-pill"), goBtn = $("bf-go");

    // Live stats readout — updated on a light interval while running + on key events.
    var statEls = {
      state: $("bfs-state"), score: $("bfs-score"), runs: $("bfs-runs"), rate: $("bfs-rate"),
      elapsed: $("bfs-elapsed"), stag: $("bfs-stag"), workers: $("bfs-workers"),
      pending: $("bfs-pending"), iters: $("bfs-iters"), horizon: $("bfs-horizon")
    };
    function fmtElapsed(ms) { var s = Math.floor(ms / 1000); if (s < 60) return s + "s"; var m = Math.floor(s / 60); return m + "m " + (s % 60) + "s"; }
    function updateStats(finished) {
      var busy = 0; for (var i = 0; i < BF.workers.length; i++) if (BF.workers[i].busy) busy++;
      var elapsed = BF.startedAt ? (perfNow() - BF.startedAt) : 0;
      statEls.state.textContent = BF.running ? "running" : (finished ? "done" : (BF.totalRuns ? "stopped" : "idle"));
      statEls.score.textContent = BF.best ? BF.best.score.toFixed(3) : "—";
      statEls.runs.textContent = BF.totalRuns;
      statEls.rate.textContent = elapsed > 0 ? (BF.totalRuns / (elapsed / 1000)).toFixed(1) : "0";
      statEls.elapsed.textContent = fmtElapsed(elapsed);
      statEls.stag.textContent = BF.best ? ((BF.totalRuns - (BF.bestAtRun || 0)) + " runs ago") : "—";
      statEls.workers.textContent = busy + " / " + BF.workers.length + " busy";
      statEls.pending.textContent = BF.pending.size;
      // Budget left reads in whatever unit the stop condition is actually counting in.
      statEls.iters.textContent = BF.limitMode === "never" ? "∞"
        : BF.limitMode === "time" ? (BF.running ? Math.max(0, (BF.deadline - perfNow()) / 1000).toFixed(1) + "s" : "—")
        : Math.max(0, Math.floor(BF.iterLeft)) + " runs";
      statEls.horizon.textContent = BF.horizon || "—";
    }
    setInterval(function () { if (BF.running) updateStats(); }, 300);

    // ---- Auto-save best to a named file (userData/tas-runs/<name>.tas) + open ----
    function bfFileName() { return ($("bf-file").value || "").trim(); }
    var lastSaved = "", lastSaveAt = 0;
    function autoSaveBest(force) {
      var name = bfFileName(); if (!name) return;
      var t = bfBestText(); if (t == null || t === lastSaved) return;
      var now = perfNow(); if (!force && now - lastSaveAt < 1000) return;
      lastSaveAt = now; lastSaved = t;
      try { if (window.electron && window.electron.tasSaveRun) window.electron.tasSaveRun(name, t); } catch (e) {}
    }
    $("bf-open").onclick = async function () {
      try {
        if (!(window.electron && window.electron.tasListRuns)) { panel.setStatus("Saved-runs storage needs the updated electron preload/main (copy electron/* into the build)."); return; }
        var res = await window.electron.tasListRuns();
        var files = (res && res.files) || [];
        if (!files.length) { panel.setStatus("No saved runs yet — set a filename and run BF."); return; }
        var pick = await tasPick("Open a saved run", files);
        if (pick == null) return;
        var r = await window.electron.tasReadRun(pick);
        if (r && r.ok) { panel.setEditor(r.content); panel.setStatus("Opened saved run '" + pick + "' into the editor."); }
        else panel.setStatus("Couldn't open '" + pick + "': " + (r && r.error || "not found"));
      } catch (e) { panel.setStatus("Open failed: " + e); }
    };

    /* Drain the PB queue into the log. One line per population personal-best — a
     * population beating its own best is progress worth seeing even when another is
     * further ahead — with the lines that took the OVERALL lead marked ★ and gold.
     * Everything is batched into one fragment and appended on the throttle tick, so a
     * search doing thousands of runs/sec never touches the DOM per run. */
    function pbSpan(cls, text) { var s = document.createElement("span"); s.className = cls; s.textContent = text; return s; }
    function drainPbLog() {
      var q = BF.pbQueue;
      if (!q.length && !BF.pbDropped) return;
      var frag = document.createDocumentFragment();
      if (BF.pbDropped) {
        var d = document.createElement("div"); d.className = "pb drop";
        d.textContent = "… " + BF.pbDropped + " more PB" + (BF.pbDropped === 1 ? "" : "s") + " (too fast to show)";
        frag.appendChild(d); BF.pbDropped = 0;
      }
      for (var i = 0; i < q.length; i++) {
        var e = q[i], row = document.createElement("div");
        row.className = "pb" + (e.best ? " gb" : "");
        row.appendChild(pbSpan("rn", "[" + e.run + "]"));
        row.appendChild(pbSpan("pop", e.island < 0 ? "base" : "pop " + e.island));
        row.appendChild(document.createTextNode(e.best ? " ★ " : "   "));
        row.appendChild(document.createTextNode(e.info + "  "));
        row.appendChild(pbSpan("sc", isFinite(e.score) ? e.score.toFixed(3) : String(e.score)));
        if (e.delta != null && isFinite(e.delta)) row.appendChild(pbSpan("dl", " +" + e.delta.toFixed(3)));
        if (e.shift != null) row.appendChild(pbSpan("mt", " ±" + e.shift + "f"));   // cooling strength it was found at
        frag.appendChild(row);
      }
      q.length = 0;
      // Stick to the bottom only if the user is already there — don't yank their scroll
      // out from under them while they're reading back.
      var atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
      logEl.appendChild(frag);
      while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
      if (atEnd) logEl.scrollTop = logEl.scrollHeight;
    }

    var lastLog = 0, pendingBest = false;
    function refresh(improved, finished) {
      if (improved) pendingBest = true;
      var now = perfNow();
      if (now - lastLog > 250 || finished) {
        lastLog = now;
        drainPbLog();
        if (pendingBest && BF.best) {
          pendingBest = false;
          bestEl.textContent = "Best: " + BF.best.score.toFixed(3) + " · " + BF.best.info;
          // Auto-write the best straight into the editor (+ the save file). Global bests
          // only — a population PB that's still behind the leader must not clobber it.
          var bt = bfBestText(); if (bt != null) panel.setEditor(bt);
          autoSaveBest(false);
        }
        pill.textContent = finished ? "done · " + BF.totalRuns : (BF.running ? BF.totalRuns + " runs" : "idle");
        updateStats(finished);
      }
      if (finished || !BF.running) { goBtn.textContent = "Start BF"; goBtn.classList.remove("stop"); if (finished) autoSaveBest(true); }
    }
    BF.onUpdate = refresh;

    $("bf-go").onclick = function () {
      if (BF.running) { bfStop(); pill.textContent = "stopped · " + BF.totalRuns; goBtn.textContent = "Start BF"; goBtn.classList.remove("stop"); updateStats(); return; }
      var opts = {
        baseText: panel.editor.value || "",
        triggers: readTriggers(), blend: (+$("bf-blend").value) / 100,
        align: $("bf-align").checked, cool: $("bf-cool").checked,
        startFrame: parseInt($("bf-start").value, 10) || 0, endFrame: parseInt($("bf-end").value, 10) || 0,
        checkFrame: parseInt($("bf-check").value, 10) || 0, keys: $("bf-keys").value,
        workers: parseInt($("bf-workers").value, 10) || 4,
        islands: parseInt($("bf-islands").value, 10) || 1,
        poolSize: parseInt($("bf-pool").value, 10) || 6,
        crossover: $("bf-crossover").checked,
        deadAbort: $("bf-deadabort").checked,
        crashWeight: Math.max(0, parseFloat($("bf-crashw").value) || 0),
        tapEdit: $("bf-tapedit").checked,
        tapMut: { wStart: Math.max(0, parseInt($("bf-tw-start").value, 10) || 0), wEnd: Math.max(0, parseInt($("bf-tw-end").value, 10) || 0), wKeys: Math.max(0, parseInt($("bf-tw-keys").value, 10) || 0), wOn: Math.max(0, parseInt($("bf-tw-on").value, 10) || 0), wOff: Math.max(0, parseInt($("bf-tw-off").value, 10) || 0) },
        snapshot: $("bf-snapshot").checked,
        limitMode: $("bf-limit-mode").value, limitValue: parseInt($("bf-limit-n").value, 10) || 0,
        mut: { rate: Math.max(1, parseInt($("bf-rate").value, 10) || 3), maxShift: Math.max(1, parseInt($("bf-shift").value, 10) || 30), wShift: Math.max(0, parseInt($("bf-ws").value, 10) || 0), wToggle: Math.max(0, parseInt($("bf-wt").value, 10) || 0), wInsert: Math.max(0, parseInt($("bf-wi").value, 10) || 0) }
      };
      var _freeW = opts.mut.wShift + opts.mut.wToggle + opts.mut.wInsert;
      var _tapW = opts.tapEdit ? (opts.tapMut.wStart + opts.tapMut.wEnd + opts.tapMut.wKeys + opts.tapMut.wOn + opts.tapMut.wOff) : 0;
      if (_freeW <= 0 && _tapW <= 0) opts.mut.wInsert = 1;   // nothing selected → default to inserts
      logEl.textContent = ""; bestEl.textContent = "Best: —"; lastSaved = "";
      var r = bfStart(opts);
      if (!r.ok) { panel.setStatus("BF: " + r.msg); pill.textContent = "idle"; return; }
      goBtn.textContent = "Stop BF"; goBtn.classList.add("stop"); pill.textContent = "running…"; updateStats();
      if (BF.workersCapped) toast("Workers capped to " + BF.workers.length + " (your CPU's thread count) — more would only slow it down.");
      panel.setStatus("Brute force on " + BF.workers.length + " workers × " + BF.numIslands + " populations · " + BF.triggers.length + " box" + (BF.triggers.length === 1 ? "" : "es") + (BF.nogos.length ? " + " + BF.nogos.length + " no-go" : "") + (BF.snapshot ? " · ⚡snapshot@" + BF.startFrame : "") + (BF.align ? " · 🧭aligned" : "") + (BF.cool ? " · ❄cooling" : "") + " (horizon " + BF.horizon + "). Best auto-writes to the editor" + (bfFileName() ? " + '" + bfFileName() + ".tas'" : "") + ".");
    };

    // seed one empty trigger row
    addTrigger(null);
    return { el: el };
  }

  /* ---- Renderer box overlay (the "deeper hook") --------------------------
   * Draws BF trigger boxes INTO the game's 3D view. The renderer/scene/camera
   * live in minified closures and aren't reachable, so we recover the camera
   * view-projection by sniffing THREE's standard `projectionMatrix` /
   * `viewMatrix` shader uniforms — patching the WebGL context draw calls (the
   * only globally-patchable rendering hook) — then project the box corners onto
   * a transparent full-screen 2D canvas. Always-on-top (no depth test), like an
   * x-ray box. Normal boxes draw cyan / yellow-when-inside; no-go boxes draw
   * red. If a build's shaders lack those uniforms this silently does nothing. */
  function installRendererBoxOverlay() {
    var cv = null, ctx2d = null; // capturedVP lives in the top-level boxVP (patched before the game runs)
    function project(vp, x, y, z, W, H) {
      var cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12], cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
      var cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (cw <= 1e-6) return { visible: false };
      return { x: (cx / cw * 0.5 + 0.5) * W, y: (1 - (cy / cw * 0.5 + 0.5)) * H, visible: true };
    }
    var EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    function corners(b) { var hx = b.sx / 2, hy = b.sy / 2, hz = b.sz / 2, c = []; for (var i = 0; i < 8; i++) c.push([b.x + (i & 1 ? hx : -hx), b.y + (i & 2 ? hy : -hy), b.z + (i & 4 ? hz : -hz)]); return c; }
    // The boxes are static, so re-read them from the DOM at most ~5×/s instead of
    // parsing every trigger row on every animation frame.
    var boxCache = [], boxCacheT = -1e9;
    function getBoxes() {
      var now = perfNow();
      if (now - boxCacheT > 200) { boxCache = (TAS.showBoxes !== false && TAS.getBfTriggers) ? (TAS.getBfTriggers() || []) : []; boxCacheT = now; }
      return boxCache;
    }
    function draw() {
      requestAnimationFrame(draw);
      var boxes = getBoxes();
      var want = boxes.length > 0;  // overlay shows whenever you have boxes (+ a diagnostic)
      boxVP.want = want;            // gate the camera-matrix capture (zero overhead when no boxes)
      // Adopt the view matrix from the largest FRESH draw this frame (THREE caches
      // modelViewMatrix while the camera is static — a stale matrix must not
      // overwrite the good view, or the box flashes off-screen between frames).
      if (want) tasFinalizeVP();
      if (want && !cv) { cv = document.createElement("canvas"); cv.id = "tas-gl-overlay"; cv.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483640"; (document.body || document.documentElement).appendChild(cv); ctx2d = cv.getContext("2d"); }
      if (!ctx2d) return;
      var dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0); ctx2d.clearRect(0, 0, W, H);
      if (!want) return;
      var vp = boxVP.vp;
      // Diagnostic readout (visible since devtools is disabled). Tells us whether
      // the camera matrices were captured and via which path.
      if (TAS.showBoxDiag !== false) {
        ctx2d.font = "12px ui-monospace,Consolas,monospace";
        ctx2d.fillStyle = vp ? "rgba(120,220,140,.92)" : "rgba(255,180,80,.95)";
        ctx2d.fillText("TAS boxes: " + boxes.length + " · camera " + (vp ? "OK" : (boxVP.hooked ? "WAITING" : "NOT-HOOKED")) +
          " · proj=" + boxVP.sawProj + " view=" + boxVP.sawView + " mv=" + boxVP.sawMV + " rigid=" + boxVP.rigid + (boxVP.ubo ? " ubo=" + boxVP.ubo : ""), 10, 18);
        if (!vp) { ctx2d.fillStyle = "rgba(255,180,80,.95)"; ctx2d.fillText("camera not captured yet — read these numbers to the dev", 10, 34); return; }
      } else if (!vp) return;
      var st = currentCarState(), car = st ? st.position : null, ordinal = 0;
      for (var bi = 0; bi < boxes.length; bi++) {
        var b = boxes[bi];
        var inside = car && Math.abs(car.x - b.x) <= b.sx / 2 && Math.abs(car.y - b.y) <= b.sy / 2 && Math.abs(car.z - b.z) <= b.sz / 2;
        // Normal boxes: cyan, YELLOW when the car is inside. No-go boxes: red,
        // brighter red when the car is inside (a run touching one is killed).
        var col = b.nogo ? (inside ? "#ff8a8a" : "#ff4d4d") : (inside ? "#ffe14a" : "#22d3ee");
        var pts = corners(b).map(function (c) { return project(vp, c[0], c[1], c[2], W, H); });
        ctx2d.strokeStyle = col; ctx2d.lineWidth = inside ? 3 : 2; ctx2d.beginPath();
        for (var e = 0; e < EDGES.length; e++) { var a = pts[EDGES[e][0]], d = pts[EDGES[e][1]]; if (a.visible && d.visible) { ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(d.x, d.y); } }
        ctx2d.stroke();
        var ctr = project(vp, b.x, b.y, b.z, W, H);
        var label = b.nogo ? "✗" : String(++ordinal);
        if (ctr.visible) { ctx2d.fillStyle = col; ctx2d.font = "bold 13px monospace"; ctx2d.fillText(label, ctr.x + 3, ctr.y); }
      }
    }
    requestAnimationFrame(draw);
  }

  /* ---- Auto-TAS UI (appended into the panel body) ----
   * Front-end for the autonomous pipeline in tas/pipeline (headless bit-exact
   * engine + RRT ghost search + root-parallel windowed MCTS + 1ms polisher).
   * Electron main spawns it as a background Node process on the CURRENT
   * track's data (captured from the sim worker, same as Brute Force uses),
   * streams its log here, and the resulting script is loaded straight into
   * the editor — Apply → replay to watch it, upload via the TAS board.
   * Requires the tas-auto-* bridge in electron/main.js + preload.js. */
  function buildAutoTas(panel) {
    var host = panel.body;
    var el = document.createElement("div"); el.id = "tas-auto"; el.className = "collapsed";
    el.innerHTML =
      '<div class="bfhead"><span class="chev">▸</span><b>Auto-TAS</b><span class="bfpill" id="at-pill">idle</span></div>' +
      '<div class="bfbody">' +
        '<div class="hint">Fully automatic TAS of the <b>track you\'re viewing</b>: a pool of headless game engines (bit-exact physics) searches with RRT + windowed MCTS + a 1ms polisher. <b>Heavy</b> — it uses most CPU cores for the whole budget; the game stays playable but hot. The best script lands in the editor when it\'s done (or when you stop it).</div>' +
        '<div class="grid">' +
          '<label title="Parallel headless engines. Each holds its own copy of the physics (~150–300 MB RAM).">Workers</label><input id="at-workers" type="number" min="1" max="32">' +
          '<label title="Phase 2 ghost search budget in seconds. 0 = skip — the MCTS drives from scratch using the track\'s geodesic guidance, which usually works just as well.">RRT (s)</label><input id="at-rrt" type="number" value="0" min="0">' +
          '<label title="Phase 3 optimizer budget IN MINUTES — THE main knob. The searcher commits roughly 1 second of run per 0.5–2 minutes of search, so a full track wants 60+ min (a 1–2 min run is just a smoke test and yields ~a second of inputs). If it doesn\'t finish, the best partial is loaded instead.">MCTS (min)</label><input id="at-mcts" type="number" value="60" min="1">' +
          '<label title="Phase 4 native 1ms polish budget (runs only if the track was finished).">Polish (min)</label><input id="at-polish" type="number" value="10" min="0">' +
          '<label title="Random seed — blank picks one. Same seed + same budgets reproduce the same result (the whole pipeline is deterministic).">Seed</label><input id="at-seed" type="number" placeholder="random">' +
        '</div>' +
        '<div class="mini"><button id="at-go" class="bfstart">Start Auto-TAS</button></div>' +
        '<div class="bflog" id="at-log">idle — open a replay (Watch) or drive this track once so its data is captured, then Start.</div>' +
        '<div class="atstatus" id="at-status"></div>' +
      '</div>';
    host.appendChild(el);
    var $ = function (id) { return el.querySelector("#" + id); };
    el.querySelector(".bfhead").onclick = function () {
      el.classList.toggle("collapsed");
      el.querySelector(".chev").textContent = el.classList.contains("collapsed") ? "▸" : "▾";
    };

    var pill = $("at-pill"), log = $("at-log"), status = $("at-status"), go = $("at-go");
    var running = false;
    var LOG_MAX = 400;
    function setStatus(m) { status.textContent = m; }
    function addLog(line) {
      var atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 6;
      var div = document.createElement("div"); div.textContent = line; log.appendChild(div);
      while (log.childNodes.length > LOG_MAX) log.removeChild(log.firstChild);
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    function setRunning(r) {
      running = r;
      go.disabled = false;
      go.textContent = r ? "Stop Auto-TAS" : "Start Auto-TAS";
      go.classList.toggle("atstop", r);
      pill.textContent = r ? "running" : "idle";
    }

    var E = window.electron || {};
    if (typeof E.tasAutoStart !== "function") {
      go.disabled = true;
      log.textContent = "Not available in this session.";
      setStatus("The Auto-TAS bridge isn't loaded — electron/main.js + preload.js were updated; fully restart the game to pick them up.");
      return { el: el };
    }

    var cores = navigator.hardwareConcurrency || 8;
    // Leave headroom for the running game — oversubscribing slows the search
    // MORE than the missing workers would (memory-bandwidth bound).
    $("at-workers").value = Math.max(2, cores - 4);

    E.onTasAutoLog(function (line) {
      addLog(line);
      if (!running) return;
      // Live progress in the pill: which phase + how much RUN TIME is locked
      // so far (the search commits inputs at ~real-time×30–130 — this makes
      // the pace visible instead of looking stuck or "broken").
      var ph = /phase (\d\w*)/.exec(line);
      if (ph) el._atPhase = ph[1];
      var lk = /locked=(\d+)ms/.exec(line);
      if (lk) el._atLocked = (+lk[1] / 1000).toFixed(1) + "s";
      var bf = /bestFin=(\d+)/.exec(line);
      if (bf) el._atFin = (+bf[1] / 1000).toFixed(2) + "s";
      pill.textContent = (el._atPhase ? "3" === el._atPhase[0] ? "phase " + el._atPhase : "phase " + el._atPhase : "running") +
        (el._atLocked ? " · " + el._atLocked : "") + (el._atFin ? " · fin " + el._atFin : "");
    });
    E.onTasAutoDone(function (res) {
      setRunning(false);
      var a = (res && res.artifacts) || {};
      if (a["final.tas"]) {
        var ms = null, verify = null;
        try { var meta = JSON.parse(a["meta.json"] || "null"); if (meta) { ms = meta.finishMs; verify = meta.verify; } } catch (e2) {}
        panel.setEditor(a["final.tas"]);
        setStatus("DONE: " + (ms != null ? fmtTime(ms) : "finished") +
          (verify != null ? (verify ? " · game-verify PASS" : " · game-verify FAIL") : "") +
          " — loaded into the editor. Apply → replay to watch it.");
        addLog("=== FINISHED" + (ms != null ? " @ " + ms + "ms" : "") + " — script loaded into the editor ===");
        try { toast("Auto-TAS finished" + (ms != null ? ": " + fmtTime(ms) : "")); } catch (e3) {}
        try { if (E.tasSaveRun) E.tasSaveRun("auto_" + String(TAS.currentTrackId || "track").slice(0, 24) + "_" + (ms != null ? ms + "ms" : Date.now()), a["final.tas"]); } catch (e4) {}
      } else {
        var partial = a["phase3-partial.tas"] || a["phase3.tas"] || a["phase2-ghost.tas"];
        if (partial) {
          panel.setEditor(partial);
          setStatus("Did not finish within the budget — best PARTIAL loaded into the editor (Apply → replay to see how far it got). Raise the MCTS budget and run again, or hand-finish it with Savestate.");
          addLog("=== NO FINISH — best partial loaded into the editor ===");
        } else {
          setStatus("Ended without output (exit code " + (res && res.code) + ") — see the log above.");
        }
      }
    });

    // Reattach if the renderer reloaded while a run is still going.
    try { E.tasAutoStatus().then(function (st) { if (st && st.running) { setRunning(true); addLog("(reattached to a running Auto-TAS process — log resumes from here)"); } }); } catch (e) {}

    go.onclick = function () {
      if (running) {
        E.tasAutoStop();
        addLog("stopping…");
        go.disabled = true; go.textContent = "stopping…";   // re-enabled when the done event lands
        pill.textContent = "stopping";
        return;
      }
      if (!capture.init || !capture.lastCar || capture.lastCar.trackData == null) {
        setStatus("No track captured yet — open a replay (Watch) or drive this track once first.");
        return;
      }
      var opts = {
        trackData: capture.lastCar.trackData,
        workers: Math.max(1, Math.min(32, (+$("at-workers").value) || (cores - 2))),
        rrtBudget: Math.max(0, (+$("at-rrt").value) || 0),
        sims: 200,
        mctsBudget: Math.max(60, Math.round(((+$("at-mcts").value) || 60) * 60)),
        polishBudget: Math.max(0, Math.round(((+$("at-polish").value) || 10) * 60)),
        polishRounds: 300,
        seed: (+$("at-seed").value) || undefined,
      };
      log.textContent = "";
      el._atPhase = el._atLocked = el._atFin = null;
      addLog("starting: workers=" + opts.workers + " · rrt=" + opts.rrtBudget + "s · mcts=" + opts.mctsBudget + "s · polish=" + opts.polishBudget + "s" + (opts.seed ? " · seed=" + opts.seed : ""));
      // Expectation guard: the optimizer commits ~1s of run per 0.5–2 min of
      // search on a busy machine. Tiny budgets are smoke tests, not TAS runs.
      if (opts.mctsBudget < 900) {
        addLog("NOTE: MCTS budget is only " + Math.round(opts.mctsBudget / 60) + " min — expect just a second or two of driving. A real attempt wants 60+ min (the field is in MINUTES).");
      }
      setStatus("");
      E.tasAutoStart(opts).then(function (r) {
        if (!r || !r.ok) { setStatus("Failed to start: " + ((r && r.error) || "unknown error")); addLog("start failed: " + ((r && r.error) || "?")); return; }
        setRunning(true);
        setStatus("Running — artifacts land in " + r.outDir);
      });
    };

    return { el: el };
  }

  /* ---- Savestate UI (appended into the panel body) ----
   * Launched FROM the replay viewer: scrub to frame N, then drop into LIVE
   * driving of the same track starting at frame N of the viewed replay. The
   * editor's current script is the prefix (your edits are honored), so the car
   * re-simulates [0..N) then hands you control. N>0 taints the run (no upload). */
  function buildSavestate(panel) {
    var host = panel.body;
    var el = document.createElement("div"); el.id = "tas-ss"; el.className = "collapsed";
    el.innerHTML =
      '<div class="sshead"><span class="chev">▸</span><b>Savestate</b><span class="sspill" id="ss-pill">idle</span></div>' +
      '<div class="ssbody">' +
        '<div class="sub">Drive this track from frame N of the replay you\'re viewing. You arrive AT frame N with its exact momentum (the prefix [0..N) is re-simulated from the editor script — your edits count); drive to continue, and <b>Start-Reset returns you to frame N</b> each time. A start at N&gt;0 is tainted — finishing it will NOT upload.</div>' +
        '<div class="grid">' +
          '<label>Frame N</label><div class="mini"><input id="ss-frame" type="number" value="0" min="0" style="flex:1"><button id="ss-now" title="Use the replay\'s current scrubbed frame">Use scrub frame</button></div>' +
        '</div>' +
        '<div class="mini"><button id="ss-arm" class="ssarm">Drive from frame N</button></div>' +
        '<div class="ssstatus" id="ss-status">Open a replay (Watch), scrub to a frame, then Drive from frame N to take over there.</div>' +
      '</div>';
    host.appendChild(el);
    var $ = function (id) { return el.querySelector("#" + id); };
    el.querySelector(".sshead").onclick = function () { el.classList.toggle("collapsed"); el.querySelector(".chev").textContent = el.classList.contains("collapsed") ? "▸" : "▾"; };
    var pill = $("ss-pill"), statusEl = $("ss-status");
    function setStatus(m) { statusEl.textContent = m; }
    function scrubFrame() { try { var vs = window.__TAS_viewState && window.__TAS_viewState(); return vs ? (vs.frame | 0) : 0; } catch (e) { return 0; } }
    $("ss-now").onclick = function () { $("ss-frame").value = scrubFrame(); };
    async function drive() {
      if (!inReplayViewer()) { setStatus("Savestate launches from the Replay viewer — open a replay (Watch) first."); return; }
      var V = window.__TAS_view;
      if (!V || typeof V.drive !== "function") { setStatus("Replay-viewer hook unavailable — open a replay via Watch."); return; }
      var n = parseInt($("ss-frame").value, 10) || 0;
      var r = await armSavestate(n, panel.editor.value || "");   // prefix = current editor script (the viewed replay + edits)
      if (!r.ok) { setStatus(r.msg); return; }
      try {
        V.drive(V.trackMeta, V.trackData, V.category, V.records, null); // leave viewer, drive the same track
        setStatus(n > 0
          ? "Driving this track — you arrive AT frame " + n + " (with its momentum); drive to continue, Start-Reset to return there. Finishing posts it to the TAS leaderboard as a driven run."
          : "Driving this track from the start.");
      } catch (e) { disarmSavestate(); setStatus("Couldn't start driving: " + e); }
    }
    $("ss-arm").onclick = drive;
    bus.on("savestate", function (s) { pill.textContent = s.armed ? ("armed @" + s.frame) : "idle"; });
    // Hotkey entry point: open the section + drive from the current scrub frame.
    TAS.quickSavestate = function () {
      if (el.classList.contains("collapsed")) { el.classList.remove("collapsed"); el.querySelector(".chev").textContent = "▾"; }
      if (inReplayViewer()) $("ss-frame").value = scrubFrame();
      drive();
    };
    return { el: el, setStatus: setStatus };
  }

  /* ================================================================== *
   * Game settings integration  —  house ALL TAS keybinds + options inside
   * PolyTrack's OWN settings page (no separate TAS settings modal).
   * ------------------------------------------------------------------
   * main.bundle.js exposes window.__TAS_settings.make(parent, onClose) which
   * builds the REAL settings screen; we open it into a full-screen host so it
   * works from anywhere (the game only offers it from the main menu). A
   * MutationObserver appends a "TAS Tool" section (keybind rows + options) to
   * any settings container — covering both the game-opened and TAS-opened ones.
   * ================================================================== */
  function openGameSettings() {
    var S = window.__TAS_settings;
    if (!S || typeof S.make !== "function") { toast("Open the game's main menu once so Settings can initialise, then try again."); return; }
    if (document.getElementById("tas-gs-host")) return; // already open
    var host = document.createElement("div"); host.id = "tas-gs-host"; document.body.appendChild(host);
    var inst = null, closed = false;
    function close() { if (closed) return; closed = true; try { inst && inst.dispose && inst.dispose(); } catch (e) {} try { host.remove(); } catch (e) {} }
    host.addEventListener("mousedown", function (e) { if (e.target === host) close(); });
    try { inst = S.make(host, close); }
    catch (e) { close(); toast("Couldn't open settings: " + e); TAS.log("openGameSettings err: " + e); }
  }
  TAS.openGameSettings = openGameSettings;

  function installGameSettings() {
    var KEY_ACTIONS = [
      { id: "overlay", label: "TAS: toggle telemetry overlay" },
      { id: "panel", label: "TAS: toggle TAS panel" },
      { id: "reload", label: "TAS: reload replay into editor" },
      { id: "settings", label: "TAS: open this settings page" },
      { id: "savestate", label: "TAS: savestate — drive from scrub frame" },
      { id: "ssSet", label: "TAS: set start position (while driving)" },
      { id: "ssReturn", label: "TAS: return to last start position" }
    ];
    var _injected = [];
    function refreshKeyButtons() { for (var i = 0; i < _injected.length; i++) { var r = _injected[i]; if (r._tasAction) r._tasBtn.textContent = keyLabel(settings.keys[r._tasAction]); } }
    function bindRow(action, label) {
      var row = document.createElement("div"); row.className = "setting key-binding";
      var p = document.createElement("p"); p.textContent = label; row.appendChild(p);
      var bw = document.createElement("div"); bw.className = "button-wrapper"; row.appendChild(bw);
      var btn = document.createElement("button"); btn.className = "button"; btn.textContent = keyLabel(settings.keys[action]); bw.appendChild(btn);
      btn.addEventListener("click", function () {
        if (_rebinding) return;
        btn.textContent = "press…"; row.classList.add("tas-binding"); _rebinding = action;
        function detach() { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onCancel, true); _rebinding = null; row.classList.remove("tas-binding"); }
        // Clicking anywhere but the button aborts the capture (so a half-started rebind
        // can't leave a dangling listener + _rebinding stuck, which disabled all hotkeys).
        function onCancel(ev) { if (ev.target === btn) return; detach(); btn.textContent = keyLabel(settings.keys[action]); }
        function onKey(ev) {
          if (/^(Shift|Control|Alt|Meta)/.test(ev.code)) return; // wait for a real key
          ev.preventDefault(); ev.stopImmediatePropagation();
          detach();
          // Swallow this key's paired keyup so the game never receives a lone release.
          var upCode = ev.code;
          window.addEventListener("keyup", function onUp(u) { window.removeEventListener("keyup", onUp, true); if (u.code === upCode) { u.preventDefault(); u.stopImmediatePropagation(); } }, true);
          if (ev.code === "Escape") { btn.textContent = keyLabel(settings.keys[action]); return; }
          for (var k in settings.keys) if (k !== action && settings.keys[k] === ev.code) settings.keys[k] = ""; // avoid double-bind (within TAS)
          settings.keys[action] = ev.code; saveSettings();
          refreshKeyButtons();
          var gb = gameBindingFor(ev.code); // warn if it collides with a PolyTrack control
          toast(label + " → " + keyLabel(ev.code) + (gb ? "  ⚠ also PolyTrack '" + gb + "' — it'll only do the TAS action now" : ""));
        }
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("mousedown", onCancel, true);
      });
      row._tasAction = action; row._tasBtn = btn;
      return row;
    }
    // Mirror the game's own dropdown rows: a wrapper of `.button`s where the
    // active one carries `.selected` (the game's CSS fills it with --button-hover-color).
    function optButtons(curVal, opts, onPick) {
      var bw = document.createElement("div"); bw.className = "button-wrapper"; var btns = [];
      opts.forEach(function (o) {
        var b = document.createElement("button"); b.className = "button" + (o.v === curVal ? " selected" : ""); b.textContent = o.t; bw.appendChild(b); btns.push(b);
        b.addEventListener("click", function () { onPick(o.v); for (var j = 0; j < btns.length; j++) btns[j].classList.toggle("selected", opts[j].v === o.v); });
      });
      return bw;
    }
    function optRow(label, bw) { var row = document.createElement("div"); row.className = "setting"; var p = document.createElement("p"); p.textContent = label; row.appendChild(p); row.appendChild(bw); return row; }
    function injectInto(container) {
      if (container.getAttribute("data-tas-injected")) return;
      container.setAttribute("data-tas-injected", "1");
      _injected = [];
      var h = document.createElement("h2"); h.textContent = "TAS Tool"; container.appendChild(h);
      var hk = document.createElement("h3"); hk.textContent = "TAS keybinds"; container.appendChild(hk);
      for (var i = 0; i < KEY_ACTIONS.length; i++) { var r = bindRow(KEY_ACTIONS[i].id, KEY_ACTIONS[i].label); _injected.push(r); container.appendChild(r); }
      var hd = document.createElement("h3"); hd.textContent = "TAS display"; container.appendChild(hd);
      container.appendChild(optRow("Interface size (overlay + panel)", optButtons(currentScale(), [{ t: "100%", v: 1 }, { t: "125%", v: 1.25 }, { t: "150%", v: 1.5 }, { t: "175%", v: 1.75 }, { t: "200%", v: 2 }], function (v) { settings.scale = v; saveSettings(); })));
      container.appendChild(optRow("Speed units", optButtons(settings.units, [{ t: "km/h", v: "kmh" }, { t: "mph", v: "mph" }, { t: "m/s", v: "ms" }], function (v) { settings.units = v; saveSettings(); })));
      container.appendChild(optRow("Speed decimals (overlay + game speedometer)", optButtons(currentSpeedDecimals(), [{ t: "0", v: 0 }, { t: "1", v: 1 }, { t: "2", v: 2 }, { t: "3", v: 3 }, { t: "4", v: 4 }, { t: "5", v: 5 }], function (v) { settings.speedDecimals = v; saveSettings(); })));
      container.appendChild(optRow("Panel layout", optButtons(settings.layout, [{ t: "Tall", v: "tall" }, { t: "Wide", v: "wide" }], function (v) { settings.layout = v; saveSettings(); })));
      container.appendChild(optRow("Remember editor across reloads", optButtons(settings.rememberEditor ? "y" : "n", [{ t: "On", v: "y" }, { t: "Off", v: "n" }], function (v) { settings.rememberEditor = (v === "y"); saveSettings(); })));
      var hb = document.createElement("h3"); hb.textContent = "TAS leaderboard"; container.appendChild(hb);
      container.appendChild(optRow("Auto-upload finished runs", optButtons(board.cfg().autoUpload ? "y" : "n", [{ t: "On", v: "y" }, { t: "Off", v: "n" }], function (v) { board.patchCfg({ autoUpload: (v === "y") }); })));
      var nnRow = document.createElement("div"); nnRow.className = "setting";
      var nnP = document.createElement("p"); nnP.textContent = "Upload name"; nnRow.appendChild(nnP);
      var nnV = document.createElement("p"); nnV.style.opacity = ".6"; nnV.textContent = uploadNickname(); nnRow.appendChild(nnV);
      container.appendChild(nnRow);
    }
    function scan() {
      var cs = document.querySelectorAll(".settings-menu-ui > .container");
      for (var i = 0; i < cs.length; i++) if (!cs[i].getAttribute("data-tas-injected")) injectInto(cs[i]);
    }
    var sched = false;
    var mo = new MutationObserver(function () { if (sched) return; sched = true; requestAnimationFrame(function () { sched = false; scan(); }); });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    scan();
  }

  /* ================================================================== *
   * Replay-viewer context
   * ------------------------------------------------------------------
   * The TAS editor / Apply / Brute Force / Savestate only operate while the
   * standalone replay ("preview") viewer is open — editing inputs edits the
   * replay you're viewing. The telemetry OVERLAY is the only thing that also
   * works during live driving. The viewer is detected by its `.preview-toolbar-ui`
   * DOM; main.bundle.js exposes window.__TAS_view (enter/drive + current track
   * args + records) and window.__TAS_viewState() (current scrub frame +
   * focused replay CarState).
   * ================================================================== */
  function inReplayViewer() { return !!document.querySelector(".preview-toolbar-ui"); }
  TAS.inViewer = inReplayViewer;

  // Best current car state for overlays / box-checks: the focused replay's
  // CarState while scrubbing in the viewer, else the live/captured active car.
  function currentCarState() {
    try { if (inReplayViewer() && window.__TAS_viewState) { var vs = window.__TAS_viewState(); if (vs && vs.state) return vs.state; } } catch (e) {}
    return capture.latest.get(capture.activeCarId) || null;
  }
  TAS.currentState = currentCarState;

  // Load the focused replay's inputs into the editor. `force` overwrites;
  // without it, a non-empty editor is left alone (so an Apply re-sim, which
  // re-enters the viewer, doesn't clobber your edits).
  async function loadViewerReplayIntoEditor(force) {
    var V = window.__TAS_view; if (!V || !V.records || !V.records.length) return false;
    var vs = window.__TAS_viewState ? window.__TAS_viewState() : null;
    var idx = vs && typeof vs.focus === "number" ? vs.focus : 0;
    if (idx < 0 || idx >= V.records.length) idx = 0;
    var gameRec = V.records[idx] && V.records[idx].recording;  // a game Recording OBJECT (or base64)
    if (!gameRec) return false;
    TAS._viewerEditIdx = idx;
    // A DIFFERENT replay object → (re)bind the editor to it. The SAME object
    // (e.g. re-entry after an Apply re-sim) → keep the editor so edits / tap
    // macros survive. `force` always reloads.
    var changed = (gameRec !== TAS._viewerBoundRecObj);
    if (!force && !changed && TAS.panel && (TAS.panel.editor.value || "").trim()) return false;
    var b64; try { b64 = (typeof gameRec === "string") ? gameRec : gameRec.serialize(); } catch (e) { return false; }
    var rec = await Recording.deserialize(b64);  // byte-compatible codec
    if (!rec || !TAS.panel) return false;
    TAS._viewerBoundRecObj = gameRec;
    TAS.panel.setEditor(recordingToScript(rec));
    TAS.panel.setStatus("Loaded replay " + (idx + 1) + "/" + V.records.length + " (" + rec.numberOfFrames() + " frames). Edit it, then Apply to re-simulate it in the viewer.");
    return true;
  }
  TAS.loadViewerReplay = loadViewerReplayIntoEditor;

  // Merge a savestate run's editor prefix [0..N) with the live driving [N..) you
  // recorded into ONE full recording — so "Watch replay" can drop the whole run
  // (everything before AND during the savestate) into the editor.
  //
  // The live section is re-based onto the prefix's control state AT N and rebuilt
  // from ONLY the live toggles at frames >= N. (The old version used liveRec's
  // absolute parity, which folds in the prefix catch-up — so one missing/extra
  // catch-up toggle would invert a channel for the WHOLE live section, making the
  // car hold/release throttle wrongly = "the replay drives into the run".)
  async function ssMergeRecording(prefixEncoded, liveRec, N) {
    var prefix = prefixEncoded ? await Recording.deserialize(prefixEncoded) : null;
    if (!prefix) prefix = new Recording();
    var base = prefix.getControls(N > 0 ? N - 1 : 0); // control state the car arrives at N with
    var k, a;
    // live toggles at/after N, per channel (the actual inputs you made after taking over)
    var liveTog = []; for (k = 0; k < 5; k++) { var lk = liveRec.ch[CHANNELS[k]], sub = []; for (a = 0; a < lk.length; a++) if (lk[a] >= N) sub.push(lk[a]); liveTog.push(sub); }
    var marks = {}; marks[0] = 1; if (N > 0) marks[N] = 1; // anchor 0 + the prefix→live switch
    for (k = 0; k < 5; k++) { var pk = prefix.ch[CHANNELS[k]]; for (a = 0; a < pk.length; a++) if (pk[a] < N) marks[pk[a]] = 1; for (a = 0; a < liveTog[k].length; a++) marks[liveTog[k][a]] = 1; }
    var list = Object.keys(marks).map(Number).sort(function (x, y) { return x - y; });
    var ptr = [0, 0, 0, 0, 0], out = new Recording();
    for (var i = 0; i < list.length; i++) {
      var f = list[i], ctrl;
      if (f < N) ctrl = prefix.getControls(f);
      else { ctrl = {}; for (k = 0; k < 5; k++) { while (ptr[k] < liveTog[k].length && liveTog[k][ptr[k]] <= f) ptr[k]++; ctrl[CHANNELS[k]] = (ptr[k] % 2) ? !base[CHANNELS[k]] : base[CHANNELS[k]]; } }
      out.recordFrame(f, ctrl);
    }
    return out;
  }
  async function loadSavestateRunIntoEditor(run) {
    try {
      var live = capture.liveRecording;
      if (!live || live.numberOfInputs() < 1 || !TAS.panel) return false;
      var merged = await ssMergeRecording(run.prefix, live, run.frame | 0);
      TAS._viewerBoundRecObj = null; // this is OUR recording, not a viewer replay object
      TAS.panel.setEditor(recordingToScript(merged));
      TAS.panel.setStatus("Loaded your savestate run — editor prefix [0.." + (run.frame | 0) + ") + your driving, " + merged.numberOfFrames() + " frames total. Apply to watch it, or upload it as TAS.");
      return true;
    } catch (e) { TAS.log("savestate→editor transfer failed: " + e); return false; }
  }

  // Auto-post a just-finished LIVE-DRIVEN run (legit or savestate) to the TAS
  // leaderboard as "driven", credited to the player's userTokenHash, only if it
  // beats their existing best for this track. The recording is the full run
  // (legit = the reconstructed live inputs; savestate = prefix + live merged).
  async function autoUploadDrivenFinish(finishFrames) {
    try {
      if (!board.cfg().autoUpload) return;
      var trackId = TAS.currentTrackId || (gate.lastRun && gate.lastRun.track_id);
      if (!trackId) return; // can't attribute the run to a track
      var ss = capture._ssRun, rec;
      if (ss) rec = await ssMergeRecording(ss.prefix, capture.liveRecording, ss.frame | 0);
      else rec = capture.liveRecording;
      if (!rec || rec.numberOfInputs() < 1) return;
      var enc = await rec.serialize();
      var run = { track_id: trackId, category: "driven", frames: finishFrames | 0, recording: enc, car_style: capture.carStyle || "", nickname: uploadNickname(), user_id: TAS.userId || null };
      var res = await board.uploadIfBest(run);
      if (res.uploaded) toast("Posted to the TAS leaderboard — driven · " + fmtTime(run.frames) + (res.pb ? " (new PB!)" : ""));
      else if (res.error) toast("TAS leaderboard upload failed: " + res.error);
    } catch (e) { TAS.log("driven auto-upload failed: " + e); }
  }

  function installViewerContext() {
    var wasIn = false, stableMiss = 0, menuWas = false;
    function onEnter() {
      if (TAS.panel) { TAS.panel.el.classList.remove("tas-hidden"); applyScale(); }
      // If you just drove a savestate run and hit Watch, transfer the FULL run
      // (prefix + your driving) into the editor instead of the game's replay
      // (whose recording omits the fast-forwarded prefix).
      var ssRun = capture._ssRun, hasLive = capture.liveRecording && capture.liveRecording.numberOfInputs() > 0;
      disarmSavestate();
      if (ssRun && hasLive) { capture._ssRun = null; loadSavestateRunIntoEditor(ssRun); }
      else loadViewerReplayIntoEditor(false);
    }
    function onLeave() { if (TAS.panel) TAS.panel.el.classList.add("tas-hidden"); }
    function evaluate() {
      if (inReplayViewer()) { stableMiss = 0; if (!wasIn) { wasIn = true; onEnter(); } }
      else if (wasIn && ++stableMiss >= 2) { wasIn = false; onLeave(); } // debounce the dispose+rebuild during an Apply re-sim
      // A savestate stays armed across Start-Resets (each reset drops you back
      // at frame N); it ends when you leave to the main menu (or the viewer).
      var menuNow = !!document.querySelector(".menu-ui");
      if (menuNow && !menuWas && SS.armed) disarmSavestate();
      menuWas = menuNow;
    }
    setInterval(evaluate, 300);
    var evPend = false; // debounce: coalesce a burst of DOM mutations into one check
    try { new MutationObserver(function () { if (evPend) return; evPend = true; (window.requestAnimationFrame || setTimeout)(function () { evPend = false; evaluate(); }, 0); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    evaluate();
    // Switching to a different track invalidates a pending savestate-run transfer.
    bus.on("track", function () { capture._ssRun = null; });

    // Telemetry-in-viewer: the worker doesn't stream while you scrub, so drive
    // the overlay from the focused replay's stored CarState at the current frame.
    var traf = 0;
    function poll() {
      traf = 0;
      if (!wasIn || !window.__TAS_viewState) return;
      var vs = window.__TAS_viewState();
      if (vs && vs.state) { var st = vs.state; if (st.finished === undefined) st.finished = (st.finishFrames != null); bus.emit("telemetry", st); }
    }
    setInterval(function () { if (wasIn && !traf) traf = requestAnimationFrame(poll); }, 50);
  }

  /* ---- Game nickname (for crediting TAS Board uploads) ----
   * The community board has no accounts; runs are credited to your PolyTrack
   * nickname, read from the game's own user record in localStorage. */
  function gameNickname() {
    try {
      var keys = Object.keys(localStorage), slotKey = null, i;
      for (i = 0; i < keys.length; i++) if (/polytrack.*_user_slot$/.test(keys[i])) slotKey = keys[i];
      var rec = null;
      if (slotKey) { var slot = localStorage.getItem(slotKey); rec = localStorage.getItem(slotKey.slice(0, -4) + slot); } // _slot -> _<n>
      if (!rec) for (i = keys.length - 1; i >= 0; i--) if (/polytrack.*_user_\d+$/.test(keys[i])) { rec = localStorage.getItem(keys[i]); break; }
      if (rec) { var o = JSON.parse(rec); var nn = (o && o.settings && o.settings.nickname) || (o && o.nickname); if (nn) return String(nn).slice(0, 40); }
    } catch (e) {}
    return null;
  }
  function uploadNickname() { return gameNickname() || (board.cfg().nickname) || "anon"; }

  /* ---- Native twin leaderboard ----
   * Whenever the game shows its real `.leaderboard-ui`, dock an identical-looking
   * TAS leaderboard right beside it (reusing the game's own CSS classes so it's
   * pixel-native). It tracks the same track id the game just queried, and offers
   * Legit / Savestate / TAS tabs. Built entirely from the game's markup. */
  function lbOrdinalSuffix(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }
  function lbOrdinal(n) { return n + lbOrdinalSuffix(n); }
  function lbTime(frames) {
    frames = Math.max(0, frames | 0);
    var ms = frames % 1000, t = (frames - ms) / 1000, sec = t % 60, min = (t - sec) / 60;
    var mm = ("000" + ms).slice(-3);
    return (min > 0 ? (min + ":" + (sec < 10 ? "0" : "") + sec) : ("" + sec)) + "." + mm;
  }
  function lbEntryEl(rank, r) {
    var b = document.createElement("button"); b.className = "main"; b.type = "button";
    var ic = document.createElement("div"); ic.className = "image-container";
    var im = document.createElement("img"); im.className = "show"; im.src = "images/car_thumbnail_placeholder.png"; ic.appendChild(im); b.appendChild(ic);
    // Render the run's real car skin via the game's own thumbnail renderer
    // (hooked in main.bundle.js); falls back to the placeholder above.
    if (r.car_style && typeof window.__TAS_carThumb === "function") {
      try { var pr = window.__TAS_carThumb(r.car_style); if (pr && pr.then) pr.then(function (src) { if (src) im.src = src; }).catch(function () {}); } catch (e) {}
    }
    var left = document.createElement("div"); left.className = "left";
    var pos = document.createElement("p"); pos.className = "position";
    pos.appendChild(document.createTextNode(String(rank)));
    var suf = document.createElement("span"); suf.textContent = lbOrdinalSuffix(rank); pos.appendChild(suf); // native faded suffix style
    left.appendChild(pos); b.appendChild(left);
    var right = document.createElement("div"); right.className = "right";
    var nc = document.createElement("div"); nc.className = "name-container";
    var nm = document.createElement("span"); nm.className = "name"; nm.textContent = r.nickname || "anon"; nc.appendChild(nm);
    right.appendChild(nc);
    var tg = document.createElement("span"); tg.className = "tas-lb-tag tag-" + (r.category || ""); tg.textContent = r.category || ""; right.appendChild(tg);
    var tm = document.createElement("p"); tm.className = "tas-lb-time"; tm.textContent = lbTime(r.frames); right.appendChild(tm);
    b.appendChild(right);
    b.title = (r.nickname || "anon") + " · " + (r.category || "") + " · " + lbTime(r.frames) + "  (click to load into the editor)";
    b.onclick = function () { lbLoadIntoEditor(r); };
    return b;
  }
  async function lbLoadIntoEditor(r) {
    try { if (!TAS.panel) return; var rec = await Recording.deserialize(r.recording); TAS.panel.setEditor(recordingToScript(rec)); toast("Loaded " + (r.category || "") + " run (" + lbTime(r.frames) + ") into the editor."); }
    catch (e) { toast("Couldn't decode that run: " + e); }
  }
  // Rows arrive sorted by time; keep each player's BEST per category (one row per
  // person), so the board is a clean leaderboard even though every PB is stored.
  function dedupeBestPerUser(rows) {
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var who = r.user_id ? ("u:" + r.user_id) : ("n:" + String(r.nickname || "anon").toLowerCase());
      var key = who + "|" + (r.category || "");
      if (seen[key]) continue; seen[key] = 1; out.push(r);
    }
    return out;
  }

  function installLeaderboardTwin() {
    var TWIN = "tas-lb", filterTag = "all", twin = null, lastTrack = null;
    function buildTwin() {
      var el = document.createElement("div"); el.className = "leaderboard-ui " + TWIN;
      var h2 = document.createElement("h2"); h2.textContent = "TAS Leaderboard"; el.appendChild(h2);
      var h3 = document.createElement("h3"); h3.className = "tas-lb-sub"; h3.textContent = "driven & input-edited runs · best per player"; el.appendChild(h3);
      var tabs = document.createElement("div"); tabs.className = "pages tas-lb-tabs";
      [["all", "All"], ["driven", "Driven"], ["edited", "Edited"]].forEach(function (t) {
        var b = document.createElement("button"); b.className = "page" + (t[0] === filterTag ? " selected" : ""); b.type = "button"; b.textContent = t[1]; b.dataset.tag = t[0];
        b.onclick = function () { filterTag = t[0]; Array.prototype.forEach.call(tabs.children, function (c) { c.classList.toggle("selected", c.dataset.tag === filterTag); }); load(); };
        tabs.appendChild(b);
      });
      el.appendChild(tabs);
      var cont = document.createElement("div"); cont.className = "container"; el.appendChild(cont);
      el._cont = cont;
      return el;
    }
    function setMsg(m) { if (twin) { twin._cont.textContent = ""; var p = document.createElement("p"); p.className = "error-message"; p.textContent = m; twin._cont.appendChild(p); } }
    function load() {
      if (!twin) return;
      var trackId = TAS.currentTrackId;
      if (!trackId) { setMsg("Waiting for the track…"); return; }
      lastTrack = trackId;
      setMsg("Loading…");
      board.fetchRuns(trackId, filterTag, 200).then(function (rows) {
        if (!twin) return;
        rows = dedupeBestPerUser(rows || []);
        twin._cont.textContent = "";
        if (!rows.length) { setMsg("No TAS runs yet for this track" + (filterTag !== "all" ? " (" + filterTag + ")" : "") + "."); return; }
        rows.forEach(function (r, i) { twin._cont.appendChild(lbEntryEl(i + 1, r)); });
      }).catch(function (e) { setMsg("Couldn't load: " + (e && e.message || e)); });
    }
    function findGameLB() {
      var all = document.querySelectorAll(".leaderboard-ui:not(." + TWIN + ")");
      for (var i = 0; i < all.length; i++) { var n = all[i]; if (n.offsetParent !== null || n.getClientRects().length) return n; }
      return all[0] || null;
    }
    function dock() {
      var lb = findGameLB();
      if (!lb) { undock(); return; }
      if (twin && twin.previousElementSibling === lb) { if (TAS.currentTrackId !== lastTrack) load(); return; } // already docked, refresh on track change
      undock();
      twin = buildTwin();
      lb.insertAdjacentElement("afterend", twin);
      // The leaderboard column is flex-shrink:0/600px → its parent is a flex row,
      // so the twin sits beside it. If not flex (defensive), make it so.
      var p = lb.parentElement;
      if (p && getComputedStyle(p).display.indexOf("flex") < 0) { p.dataset.tasFlexed = p.getAttribute("style") || ""; p.style.display = "flex"; p.style.flexDirection = "row"; p.style.justifyContent = "center"; p.style.alignItems = "stretch"; }
      load();
    }
    function undock() {
      if (!twin) return;
      var p = twin.parentElement;
      try { twin.remove(); } catch (e) {}
      twin = null;
      if (p && p.dataset && p.dataset.tasFlexed !== undefined) { if (p.dataset.tasFlexed) p.setAttribute("style", p.dataset.tasFlexed); else p.removeAttribute("style"); delete p.dataset.tasFlexed; }
    }
    // Watch the DOM for the game's leaderboard appearing / disappearing
    // (debounced — the callback runs at most once per frame).
    var pend = false;
    function react() { pend = false; if (findGameLB()) dock(); else undock(); }
    var mo = new MutationObserver(function () { if (pend) return; pend = true; (window.requestAnimationFrame || setTimeout)(react, 0); });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    // New track queried → if docked, refresh to that track.
    bus.on("track", function () { if (twin) load(); });
    // Initial pass (in case a leaderboard is already on screen).
    setTimeout(function () { if (findGameLB()) dock(); }, 600);
    return { dock: dock, undock: undock, refresh: load };
  }

  /* ---- Savestate positions HUD (shown WHILE DRIVING) ----
   * A small box with Set/Go/Delete for in-run start positions. Visible only on
   * a track (a player car exists, not in the viewer/menu) since positions are a
   * driving aid. The F4/F3 hotkeys also work without it. */
  function buildPositionsHUD() {
    var el = document.createElement("div"); el.id = "tas-pos"; el.classList.add("tas-hidden");
    el.innerHTML =
      '<div class="ph"><b>Savestate positions</b><span class="sp"></span><button id="pos-min" title="Hide (drive aid)">—</button></div>' +
      '<div class="pb">' +
        '<div class="row"><button id="pos-set" title="Snapshot the current spot as a start position">Set here (F4)</button><button id="pos-legit" title="Restart a clean LEGIT run from the start">Legit from 0</button></div>' +
        '<div id="pos-list" class="poslist"></div>' +
        '<div class="row"><button id="pos-clear" class="btn-min">Clear all</button></div>' +
        '<div class="poshint">F4 set · F3 return to last · finishing posts a driven run</div>' +
      '</div>';
    document.body.appendChild(el);
    var $ = function (id) { return el.querySelector("#" + id); };
    $("pos-set").onclick = function () { ssSetPoint(); };
    $("pos-legit").onclick = function () { ssLegit(); };
    $("pos-clear").onclick = function () { ssClearPoints(); };
    $("pos-min").onclick = function () { el.classList.add("tas-hidden"); el._userHidden = true; };
    var listEl = $("pos-list");
    function render() {
      listEl.textContent = "";
      if (!SS.points.length) { var e0 = document.createElement("div"); e0.className = "posempty"; e0.textContent = "No positions — drive to a spot and Set here."; listEl.appendChild(e0); return; }
      SS.points.forEach(function (p, i) {
        var row = document.createElement("div"); row.className = "posrow";
        var lab = document.createElement("span"); lab.className = "poslab"; lab.textContent = (i + 1) + ". " + p.label;
        var go = document.createElement("button"); go.textContent = "Go"; go.title = "Return to this position"; go.onclick = function () { ssGoto(p); };
        var del = document.createElement("button"); del.className = "btn-min"; del.textContent = "✕"; del.title = "Delete"; del.onclick = function () { ssDeletePoint(i); };
        row.appendChild(lab); row.appendChild(go); row.appendChild(del); listEl.appendChild(row);
      });
    }
    bus.on("savestate", render); render();
    var wasDriving = false;
    function driving() { return capture.playerCarId != null && !inReplayViewer() && !document.querySelector(".menu-ui"); }
    setInterval(function () {
      var d = driving();
      if (d && !wasDriving) el._userHidden = false;            // fresh drive session → re-show
      if (d && !el._userHidden) el.classList.remove("tas-hidden");
      else el.classList.add("tas-hidden");
      wasDriving = d;
    }, 350);
    return { el: el };
  }

  // Global UI scale for the overlay + panel. Applied via CSS `zoom` (Chromium
  // reflows it, so the panel keeps fitting the viewport at large sizes — unlike
  // `transform:scale`, which would overflow off-screen). The panel drag math is
  // made zoom-aware in buildPanel(); everything else scales for free.
  function currentScale() { var s = +settings.scale; return (isFinite(s) && s > 0) ? Math.max(0.75, Math.min(3, s)) : 1; }
  function applyScale() {
    var s = currentScale();
    if (TAS.overlay && TAS.overlay.el) TAS.overlay.el.style.zoom = s;
    if (TAS.posHUD && TAS.posHUD.el) TAS.posHUD.el.style.zoom = s;   // in-run driving aid scales with the overlay
    if (TAS.panel && TAS.panel.el) {
      var p = TAS.panel.el; p.style.zoom = s;
      // After a scale-up, nudge the panel back on-screen if it now overflows.
      // getBoundingClientRect is in actual (post-zoom) px; style.left is CSS px
      // that zoom multiplies, so convert the target actual-px edge back by /s.
      try {
        var r = p.getBoundingClientRect(), moved = false;
        if (r.width && r.right > window.innerWidth) { p.style.left = Math.max(0, (window.innerWidth - r.width) / s) + "px"; p.style.right = "auto"; moved = true; }
        if (r.height && r.bottom > window.innerHeight) { p.style.top = Math.max(0, (window.innerHeight - r.height) / s) + "px"; moved = true; }
        if (moved && TAS.panel.saveGeo) TAS.panel.saveGeo();   // persist the corrected position
      } catch (e) {}
    }
  }
  TAS.applyScale = applyScale;

  function buildUI() {
    if (TAS._uiBuilt) return; TAS._uiBuilt = true;
    injectStyles();
    TAS.overlay = buildOverlay();
    TAS.panel = buildPanel();
    TAS.ssUI = buildSavestate(TAS.panel);
    TAS.bfUI = buildBruteforce(TAS.panel);
    TAS.autoUI = buildAutoTas(TAS.panel);   // autonomous pipeline (tas/pipeline) front-end
    TAS.posHUD = buildPositionsHUD();  // in-run savestate positions (driving aid)
    applyScale(); bus.on("settings", applyScale);   // global UI size (overlay + panel + positions HUD)
    TAS.lbTwin = installLeaderboardTwin(); // native TAS leaderboard docked beside the real one
    installGameSettings();   // TAS keybinds + options live inside the game's own settings page
    installViewerContext();  // panel/editor/BF/apply/savestate are replay-viewer-only
    installRendererBoxOverlay();
    installHotkeys();
    var K = settings.keys;
    TAS.log("UI ready. Keys (rebind in the game's Settings → TAS Tool): " + keyLabel(K.overlay) + " overlay · " + keyLabel(K.panel) + " panel · " + keyLabel(K.savestate) + " savestate · " + keyLabel(K.ssSet) + " set-pos · " + keyLabel(K.ssReturn) + " return-pos.");
  }

  function injectStyles() {
    var css = "" +
      "#tas-overlay{position:fixed;top:8px;right:8px;z-index:2147483646;font:12px/1.35 ui-monospace,Consolas,Menlo,monospace;color:#e6e6ee;background:rgba(14,14,22,.82);border:1px solid #2a2a3a;border-radius:8px;padding:8px 10px;min-width:188px;pointer-events:none;user-select:none;backdrop-filter:blur(2px)}" +
      "#tas-overlay .tas-spd{font-size:26px;font-weight:700;line-height:1;letter-spacing:.5px}" +
      "#tas-overlay .tas-spd small{font-size:11px;font-weight:400;color:#9aa;margin-left:4px}" +
      "#tas-overlay .tas-row{display:flex;justify-content:space-between;gap:10px;margin-top:3px}" +
      "#tas-overlay .tas-row .k{color:#7c7c92}" +
      "#tas-overlay .tas-grip{display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;margin-top:6px;padding-top:6px;border-top:1px solid #2a2a3a}" +
      "#tas-overlay .tas-w{display:flex;flex-direction:column;gap:2px}" +
      "#tas-overlay .tas-w .lab{display:flex;justify-content:space-between;font-size:10px;color:#9aa}" +
      "#tas-overlay .tas-bar{height:5px;border-radius:3px;background:#23232f;overflow:hidden}" +
      "#tas-overlay .tas-bar i{display:block;height:100%;width:0;background:#5cff8a;transition:width .05s linear}" +
      "#tas-overlay .tas-w.air .tas-bar i{background:#555}" +
      "#tas-overlay .tas-w.air .val{color:#777}" +
      "#tas-overlay .tas-keys{margin-top:6px;display:flex;gap:3px;justify-content:center}" +
      "#tas-overlay .tas-keys span{display:inline-block;min-width:16px;text-align:center;padding:1px 0;border-radius:3px;background:#23232f;color:#555;font-size:11px;border:1px solid #2a2a3a}" +
      "#tas-overlay .tas-keys span.on{background:#3842d0;color:#fff;border-color:#3842d0}" +
      "#tas-overlay .tas-cmp{margin-top:6px;padding-top:6px;border-top:1px solid #2a2a3a}" +
      "#tas-overlay .cmp-hdr{font-size:10px;color:#7c7c92;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}" +
      "#tas-overlay .cmp-row{display:grid;grid-template-columns:auto auto 1fr auto;gap:6px;align-items:baseline;font-size:11px;margin-top:2px}" +
      "#tas-overlay .cmp-row .cl{color:#bcbccc;white-space:nowrap}" +
      "#tas-overlay .cmp-row .cp{color:#7c7c92;font-size:10px}" +
      "#tas-overlay .cmp-row .ct{font-weight:700;text-align:right}" +
      "#tas-overlay .cmp-row .cs{color:#9aa;text-align:right;white-space:nowrap}" +
      "#tas-overlay .cmp-row.ahead .ct{color:#5cff8a}" +
      "#tas-overlay .cmp-row.behind .ct{color:#ff6b6b}" +
      "#tas-overlay .cmp-row.me{opacity:.85}" +
      "#tas-overlay .cmp-row.me .cl{color:#7ad7ff;font-weight:700}" +
      "#tas-overlay .cmp-row.me .ct,#tas-overlay .cmp-row.me .cs{color:#7ad7ff}" +
      "#tas-overlay .tas-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:10px;color:#7c7c92;text-transform:uppercase;letter-spacing:.5px}" +
      "#tas-overlay.tainted{border-color:#a04240}" +
      "#tas-overlay .tas-taint{color:#ff8a8a;font-size:10px;margin-top:5px;display:none}" +
      "#tas-overlay.tainted .tas-taint{display:block}" +
      "#tas-panel{position:fixed;box-sizing:border-box;top:8px;left:8px;z-index:2147483645;width:360px;height:min(82vh,720px);min-width:300px;min-height:150px;max-width:97vw;max-height:97vh;display:flex;flex-direction:column;overflow:hidden;font:12px ui-monospace,Consolas,Menlo,monospace;color:#e6e6ee;background:rgba(18,18,28,.96);border:1px solid #2a2a3a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5)}" +
      "#tas-panel.wide{width:min(720px,97vw)}" +
      "#tas-panel.wide .pb{flex-flow:row wrap;align-content:flex-start}" +
      "#tas-panel.wide .pb > .lbl,#tas-panel.wide .pb > .status{flex:1 1 100%}" +
      "#tas-panel.wide .pb > .stat,#tas-panel.wide .pb > textarea,#tas-panel.wide .pb > .row,#tas-panel.wide .pb > #tas-bf{flex:1 1 320px;min-width:300px}" +
      // Resize handles on every edge + corner (CSS `resize` only offers the corner).
      "#tas-panel .tas-rz{position:absolute;z-index:6}" +
      "#tas-panel .tas-rz:hover{background:rgba(30,163,196,.18)}" +
      "#tas-panel .tas-rz-n{top:0;left:14px;right:14px;height:6px;cursor:ns-resize}" +
      "#tas-panel .tas-rz-s{bottom:0;left:14px;right:14px;height:6px;cursor:ns-resize}" +
      "#tas-panel .tas-rz-e{right:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}" +
      "#tas-panel .tas-rz-w{left:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}" +
      "#tas-panel .tas-rz-ne{top:0;right:0;width:14px;height:14px;cursor:nesw-resize}" +
      "#tas-panel .tas-rz-nw{top:0;left:0;width:14px;height:14px;cursor:nwse-resize}" +
      "#tas-panel .tas-rz-sw{bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize}" +
      "#tas-panel .tas-rz-se{bottom:0;right:0;width:16px;height:16px;cursor:nwse-resize}" +
      "#tas-panel .tas-rz-se::after{content:'';position:absolute;right:3px;bottom:3px;width:8px;height:8px;background:repeating-linear-gradient(135deg,#4a4a5e 0 1.5px,transparent 1.5px 4px);pointer-events:none}" +
      "#tas-panel .ph{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#20202c;border-bottom:1px solid #2a2a3a;border-radius:10px 10px 0 0;cursor:move}" +
      "#tas-panel .ph b{font-size:13px}" +
      "#tas-panel .ph .sp{flex:1}" +
      "#tas-panel .ph .pill{font-size:10px;color:#9aa;background:#0f0f17;border:1px solid #2a2a3a;border-radius:10px;padding:1px 7px}" +
      "#tas-panel .pb{padding:10px;margin-right:6px;overflow:auto;display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0}" +
      "#tas-panel textarea{width:100%;box-sizing:border-box;height:230px;resize:vertical;background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:6px;padding:8px;font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre;tab-size:2}" +
      "#tas-panel .row{display:flex;gap:6px;flex-wrap:wrap}" +
      "#tas-panel button{background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;padding:5px 10px;font:12px ui-monospace,Consolas,monospace;cursor:pointer}" +
      "#tas-panel button:hover{background:#33334a}" +
      "#tas-panel button.warn{background:#a04240;border-color:#a04240}" +
      "#tas-panel button.go{background:#1ea3c4;border-color:#1ea3c4;color:#06222a}" +
      "#tas-panel .status{font-size:11px;color:#9aa;min-height:14px;white-space:pre-wrap}" +
      "#tas-panel .lbl{font-size:10px;color:#7c7c92;text-transform:uppercase;letter-spacing:.5px}" +
      "#tas-panel .stat{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px;color:#bcbccc}" +
      "#tas-panel .stat .k{color:#7c7c92}" +
      "#tas-panel select{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:6px;padding:4px 6px;font:12px ui-monospace,Consolas,monospace}" +
      "#tas-panel .ph button{padding:3px 8px;position:relative;z-index:7}" +
      // toast
      "#tas-toast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%) translateY(10px);z-index:2147483647;background:rgba(20,20,30,.95);color:#e6e6ee;border:1px solid #3842d0;border-radius:8px;padding:8px 14px;font:13px ui-monospace,Consolas,monospace;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;max-width:70vw;text-align:center}" +
      "#tas-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}" +
      // rebind blink (used by the TAS rows injected into the game settings)
      "@keyframes tasblink{50%{opacity:.5}}" +
      // in-renderer modal (replaces native alert/confirm/prompt)
      "#tas-modal{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}" +
      "#tas-modal .tas-modal-box{min-width:280px;max-width:min(460px,92vw);max-height:80vh;overflow:auto;background:#15151f;border:1px solid #2a2a3a;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);color:#e6e6ee;font:13px ui-monospace,Consolas,monospace;padding:16px;display:flex;flex-direction:column;gap:10px}" +
      "#tas-modal .tas-modal-title{font-size:15px;font-weight:600;color:#fff}" +
      "#tas-modal .tas-modal-msg{font-size:12px;color:#bcbccc;white-space:pre-wrap;line-height:1.4}" +
      "#tas-modal .tas-modal-input{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:6px;padding:6px 8px;font:13px ui-monospace,Consolas,monospace}" +
      "#tas-modal .tas-modal-input:focus{outline:none;border-color:#3842d0}" +
      "#tas-modal .tas-modal-ta{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:6px;padding:6px 8px;font:12px ui-monospace,Consolas,monospace;resize:vertical;white-space:pre;overflow-wrap:normal;overflow-x:auto;line-height:1.45}" +
      "#tas-modal .tas-modal-ta:focus{outline:none;border-color:#3842d0}" +
      "#tas-modal .tas-modal-list{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow:auto;border:1px solid #2a2a3a;border-radius:6px;padding:4px;background:#0f0f17}" +
      "#tas-modal .tas-modal-item{padding:6px 8px;border-radius:4px;cursor:pointer;font-size:12px}" +
      "#tas-modal .tas-modal-item:hover{background:#2a2a3a}" +
      "#tas-modal .tas-modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}" +
      "#tas-modal .tas-modal-btns button{background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;padding:5px 14px;font:12px ui-monospace,Consolas,monospace;cursor:pointer}" +
      "#tas-modal .tas-modal-btns button:hover{background:#33334a}" +
      "#tas-modal .tas-modal-btns button.primary{background:#1ea3c4;border-color:#1ea3c4;color:#06222a;font-weight:bold}" +
      // savestate positions HUD (shown while driving)
      "#tas-pos{position:fixed;top:8px;left:8px;z-index:2147483644;width:224px;font:12px ui-monospace,Consolas,monospace;color:#e6e6ee;background:rgba(18,18,28,.96);border:1px solid #2a2a3a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}" +
      "#tas-pos .ph{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#20202c;border-bottom:1px solid #2a2a3a}" +
      "#tas-pos .ph b{font-size:12px}" +
      "#tas-pos .ph .sp{flex:1}" +
      "#tas-pos .ph button{padding:2px 8px;background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;cursor:pointer}" +
      "#tas-pos .pb{padding:8px;display:flex;flex-direction:column;gap:6px}" +
      "#tas-pos .row{display:flex;gap:6px;flex-wrap:wrap}" +
      "#tas-pos button{background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;padding:4px 8px;font:11px ui-monospace,Consolas,monospace;cursor:pointer}" +
      "#tas-pos button:hover{background:#33334a}" +
      "#tas-pos button.btn-min{padding:2px 7px;color:#9aa}" +
      "#tas-pos #pos-set{background:#1ea3c4;border-color:#1ea3c4;color:#06222a;font-weight:bold}" +
      "#tas-pos .poslist{display:flex;flex-direction:column;gap:3px;max-height:42vh;overflow:auto}" +
      "#tas-pos .posrow{display:flex;align-items:center;gap:6px}" +
      "#tas-pos .poslab{flex:1;font-size:11px;color:#cfcfe0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tas-pos .posempty{font-size:10px;color:#7c7c92;padding:2px}" +
      "#tas-pos .poshint{font-size:10px;color:#7c7c92}" +
      // TAS Board overlay
      "#tas-board{position:fixed;top:6vh;left:50%;transform:translateX(-50%);z-index:2147483645;width:min(520px,94vw);max-height:88vh;display:flex;flex-direction:column;font:12px ui-monospace,Consolas,monospace;color:#e6e6ee;background:rgba(16,16,24,.98);border:1px solid #2a2a3a;border-radius:12px;box-shadow:0 16px 60px rgba(0,0,0,.6);overflow:hidden}" +
      "#tas-board .bh{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#20202c;border-bottom:1px solid #2a2a3a}" +
      "#tas-board .bh b{font-size:13px}" +
      "#tas-board .bh .sp{flex:1}" +
      "#tas-board .bpill{font-size:10px;padding:2px 7px;border-radius:9px;background:#2a2a3a;color:#9ad}" +
      "#tas-board .bh button{padding:2px 9px;background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;cursor:pointer;font-size:14px}" +
      "#tas-board .bb{padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto}" +
      "#tas-board details{background:#191922;border:1px solid #2a2a3a;border-radius:8px;padding:4px 8px}" +
      "#tas-board summary{cursor:pointer;color:#bcbccc;font-size:11px;padding:2px 0}" +
      "#tas-board .bcfg{display:grid;grid-template-columns:auto 1fr;gap:6px 8px;align-items:center;padding:6px 2px 2px}" +
      "#tas-board .bcfg label{font-size:11px;color:#9aa}" +
      "#tas-board .bcfg .ck{display:flex;align-items:center;gap:6px;color:#ccd}" +
      "#tas-board .bcfg input[type=text],#tas-board .bcfg input:not([type]),#tas-board .bcfg select{grid-column:2}" +
      "#tas-board input,#tas-board select{background:#0e0e16;color:#e6e6ee;border:1px solid #33334a;border-radius:6px;padding:4px 6px;font:11px ui-monospace,Consolas,monospace}" +
      "#tas-board .brow{grid-column:1/3;display:flex;align-items:center;gap:8px;margin-top:4px}" +
      "#tas-board .bhint,#tas-board .bstatus{font-size:10px;color:#7c7c92}" +
      "#tas-board button{background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;padding:4px 9px;font:11px ui-monospace,Consolas,monospace;cursor:pointer}" +
      "#tas-board button:hover{background:#33334a}" +
      "#tas-board button.go{background:#1ea3c4;border-color:#1ea3c4;color:#06222a;font-weight:bold}" +
      "#tas-board button.btn-min{padding:2px 7px;color:#9aa}" +
      "#tas-board .btool{display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
      "#tas-board .blist{display:flex;flex-direction:column;gap:3px;min-height:40px}" +
      "#tas-board .brow2{display:flex;align-items:center;gap:8px;padding:4px 6px;background:#191922;border:1px solid #23232f;border-radius:7px}" +
      "#tas-board .brank{width:30px;color:#7c7c92;font-size:11px}" +
      "#tas-board .btime{width:78px;font-weight:bold;color:#eaeaf4}" +
      "#tas-board .catb{font-size:10px;padding:1px 6px;border-radius:8px;font-weight:bold;text-transform:uppercase}" +
      "#tas-board .bwho{flex:1;color:#bcbccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tas-board .bact{display:flex;gap:4px}" +
      "#tas-board .bempty{color:#7c7c92;font-size:11px;padding:6px 2px}" +
      // native twin leaderboard (reuses the game's .leaderboard-ui look). The game
      // root (#ui) is pointer-events:none, so re-enable it for the whole twin, and
      // give entries/tabs an explicit dark background (text is --text-color #fff).
      ".leaderboard-ui.tas-lb{margin-left:20px;pointer-events:auto}" +
      ".leaderboard-ui.tas-lb *{pointer-events:auto}" +
      ".leaderboard-ui.tas-lb > h2{color:#7ad7ff}" +
      ".leaderboard-ui.tas-lb > .tas-lb-sub{margin:0 10px 10px 10px;font-size:18px;text-align:center;opacity:.5}" +
      ".leaderboard-ui.tas-lb > .tas-lb-tabs{margin:10px 10px 10px 10px;gap:6px}" +
      ".leaderboard-ui.tas-lb > .tas-lb-tabs > button.page{padding:8px 0;flex:1 1 0;width:auto;background-color:var(--button-color);color:var(--text-color);border:none;font-size:18px;cursor:pointer}" +
      ".leaderboard-ui.tas-lb > .tas-lb-tabs > button.page:hover{background-color:var(--button-hover-color)}" +
      ".leaderboard-ui.tas-lb > .tas-lb-tabs > button.page.selected{background-color:var(--button-hover-color)}" +
      ".leaderboard-ui.tas-lb .main{display:flex;align-items:center;gap:0;cursor:pointer;background-color:var(--button-color);color:var(--text-color)}" +
      ".leaderboard-ui.tas-lb .main:hover{background-color:var(--button-hover-color)}" +
      ".leaderboard-ui.tas-lb .main > .image-container{flex:0 0 100px}" +
      ".leaderboard-ui.tas-lb .main > .left{flex:0 0 auto;display:flex;align-items:center}" +
      ".leaderboard-ui.tas-lb .main > .left > .position{color:var(--text-color)}" +
      ".leaderboard-ui.tas-lb .main > .right{flex:1 1 auto;display:flex;align-items:center;gap:10px;min-width:0;width:auto}" +
      ".leaderboard-ui.tas-lb .main > .right > .name-container > .name{color:var(--text-color)}" +
      ".leaderboard-ui.tas-lb .main > .right > .tas-lb-time{margin:0;padding:0 14px 0 0;font-size:28px;white-space:nowrap;color:var(--text-color)}" +
      ".leaderboard-ui.tas-lb .tas-lb-tag{flex:0 0 auto;font-size:12px;font-weight:bold;text-transform:uppercase;padding:3px 8px;border-radius:9px;color:#06222a}" +
      ".leaderboard-ui.tas-lb .tas-lb-tag.tag-driven{background:#39d98a}" +
      ".leaderboard-ui.tas-lb .tas-lb-tag.tag-edited{background:#7aa2ff}" +
      // bruteforce section
      "#tas-bf{border-top:1px solid #2a2a3a;margin-top:4px;padding-top:8px;display:flex;flex-direction:column;gap:8px}" +
      "#tas-bf .bfhead{display:flex;align-items:center;gap:8px;cursor:pointer}" +
      "#tas-bf .bfhead b{font-size:13px;flex:1}" +
      "#tas-bf .bfpill{font-size:10px;color:#9aa;background:#0f0f17;border:1px solid #2a2a3a;border-radius:10px;padding:1px 7px}" +
      "#tas-bf.collapsed .bfbody{display:none}" +
      "#tas-bf .bfbody{display:flex;flex-direction:column;gap:8px}" +
      "#tas-bf .grid{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center}" +
      "#tas-bf .grid label{font-size:11px;color:#9aa}" +
      "#tas-bf input,#tas-bf select{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:5px;padding:3px 6px;font:11px ui-monospace,Consolas,monospace;box-sizing:border-box;width:100%}" +
      "#tas-bf .mini{display:flex;gap:4px;flex-wrap:wrap}" +
      "#tas-bf .mini input{width:54px}" +
      "#tas-bf .trow{display:flex;gap:6px;align-items:center;margin-bottom:3px}" +
      "#tas-bf .trow .tlab{font-size:10px;color:#7c7c92;min-width:34px}" +
      "#tas-bf .trbox{display:flex;flex-direction:column;gap:5px;border:1px solid #2a2a3a;border-radius:6px;padding:7px 8px;margin-bottom:6px;background:#12121b}" +
      "#tas-bf .trbox .trline{display:grid;grid-template-columns:46px 1fr 1fr 1fr;gap:6px;align-items:center}" +
      "#tas-bf .trbox .trline .tlab{font-size:10px;color:#7c7c92;min-width:0}" +
      "#tas-bf .trbox .trfoot{display:flex;justify-content:space-between;align-items:center;gap:8px}" +
      "#tas-bf .trbox .trfoot label{font-size:11px;color:#cfcfe0;display:flex;gap:5px;align-items:center;margin:0}" +
      "#tas-bf .trbox .trfoot button{padding:3px 12px}" +
      "#tas-bf .bflog{height:96px;overflow:auto;background:#0f0f17;border:1px solid #2a2a3a;border-radius:6px;padding:6px;font:10px/1.4 ui-monospace,Consolas,monospace;color:#5cff8a;white-space:pre-wrap}" +
      // PB log: a population beating its own best is muted; only the lines that took the
      // OVERALL lead get the gold + ★ treatment (same yellow as the Best readout).
      "#tas-bf .bflog .pb{color:#5f7d6b}" +
      "#tas-bf .bflog .pb.gb{color:#ffe14a;font-weight:bold}" +
      "#tas-bf .bflog .pb.drop{color:#5a5a6a;font-style:italic}" +
      "#tas-bf .bflog .pb .rn{color:#4a4a5c}" +
      "#tas-bf .bflog .pb .pop{color:#6aa9c4}" +
      "#tas-bf .bflog .pb.gb .rn,#tas-bf .bflog .pb.gb .pop{color:#b09a3a}" +
      "#tas-bf .bflog .pb .sc{color:#8a9aa8}" +
      "#tas-bf .bflog .pb.gb .sc{color:#ffe14a}" +
      "#tas-bf .bflog .pb .dl{color:#5cff8a}" +
      "#tas-bf .bflog .pb .mt{color:#6a6a80}" +
      "#tas-bf .bfbest{background:#1a1a26;border:1px solid #3a3a4a;border-radius:6px;padding:5px 7px;color:#ffe14a;font:11px ui-monospace,Consolas,monospace;min-height:15px}" +
      "#tas-bf .bfstats{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:3px 10px;background:#0f0f17;border:1px solid #2a2a3a;border-radius:6px;padding:7px 9px;font:10px ui-monospace,Consolas,monospace;color:#d8d8e6}" +
      "#tas-bf .bfstats .k{color:#7c7c92}" +
      "#tas-bf .bfstart{background:#2d8c3c;border-color:#2d8c3c;color:#fff;font-weight:bold;flex:1}" +
      "#tas-bf .bfstart.stop{background:#a04240;border-color:#a04240}" +
      "#tas-bf .sub{font-size:10px;color:#7c7c92;text-transform:uppercase;letter-spacing:.4px;margin-top:2px}" +
      // Sectioned layout (E): collapsible <details> groups + `?` tooltip chips + a hint line.
      "#tas-bf .bfsec{border:1px solid #23232f;border-radius:6px;background:#101019;padding:2px 8px 8px}" +
      "#tas-bf .bfsec>summary{cursor:pointer;list-style:none;padding:6px 2px;font-size:11px;font-weight:600;color:#bcbccc;text-transform:uppercase;letter-spacing:.4px;user-select:none;display:flex;align-items:center;gap:6px}" +
      "#tas-bf .bfsec>summary::-webkit-details-marker{display:none}" +
      "#tas-bf .bfsec>summary::before{content:'▸';color:#6a6a80;font-size:9px}" +
      "#tas-bf .bfsec[open]>summary::before{content:'▾'}" +
      "#tas-bf .bfsec[open]>summary{margin-bottom:6px;border-bottom:1px solid #23232f}" +
      "#tas-bf .bfsec>*{margin-top:6px}" +
      "#tas-bf .hint{font-size:10px;color:#8a8a9c;line-height:1.4}" +
      // Auto-TAS section (pipeline front-end) — mirrors the BF section look
      "#tas-auto{border-top:1px solid #2a2a3a;margin-top:4px;padding-top:8px;display:flex;flex-direction:column;gap:8px}" +
      "#tas-auto .bfhead{display:flex;align-items:center;gap:8px;cursor:pointer}" +
      "#tas-auto .bfhead b{font-size:13px;flex:1}" +
      "#tas-auto .bfpill{font-size:10px;color:#9aa;background:#0f0f17;border:1px solid #2a2a3a;border-radius:10px;padding:1px 7px}" +
      "#tas-auto.collapsed .bfbody{display:none}" +
      "#tas-auto .bfbody{display:flex;flex-direction:column;gap:8px}" +
      "#tas-auto .hint{font-size:10px;color:#8a8a9c;line-height:1.4}" +
      "#tas-auto .grid{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center}" +
      "#tas-auto .grid label{font-size:11px;color:#9aa}" +
      "#tas-auto input{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:5px;padding:3px 6px;font:11px ui-monospace,Consolas,monospace;box-sizing:border-box;width:100%}" +
      "#tas-auto .mini{display:flex;gap:4px}" +
      "#tas-auto .bfstart{background:#2d8c3c;border-color:#2d8c3c;color:#fff;font-weight:bold;flex:1}" +
      "#tas-auto .bfstart.atstop{background:#8c2d2d;border-color:#8c2d2d}" +
      "#tas-auto .bflog{height:130px;overflow:auto;background:#0f0f17;border:1px solid #2a2a3a;border-radius:6px;padding:6px;font:10px/1.4 ui-monospace,Consolas,monospace;color:#9fd0ff;white-space:pre-wrap}" +
      "#tas-auto .atstatus{font-size:11px;color:#cfcfe0;line-height:1.4;min-height:14px}" +
      "#tas-bf .ck{font-size:11px;color:#cfcfe0;display:flex;gap:6px;align-items:center;margin-top:6px}" +
      "#tas-bf .ck input{width:auto}" +
      "#tas-bf .q{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#2a2a3a;color:#9aa;font-size:9px;cursor:help;flex:0 0 auto;margin-left:auto}" +
      "#tas-bf .q:hover{background:#3842d0;color:#fff}" +
      // savestate section
      "#tas-ss{border-top:1px solid #2a2a3a;margin-top:4px;padding-top:8px;display:flex;flex-direction:column;gap:8px}" +
      "#tas-ss .sshead{display:flex;align-items:center;gap:8px;cursor:pointer}" +
      "#tas-ss .sshead b{font-size:13px;flex:1}" +
      "#tas-ss .sspill{font-size:10px;color:#9aa;background:#0f0f17;border:1px solid #2a2a3a;border-radius:10px;padding:1px 7px}" +
      "#tas-ss.collapsed .ssbody{display:none}" +
      "#tas-ss .ssbody{display:flex;flex-direction:column;gap:8px}" +
      "#tas-ss .grid{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center}" +
      "#tas-ss .grid > label{font-size:11px;color:#9aa}" +
      "#tas-ss input,#tas-ss select{background:#0f0f17;color:#e6e6ee;border:1px solid #2a2a3a;border-radius:5px;padding:3px 6px;font:11px ui-monospace,Consolas,monospace;box-sizing:border-box;width:100%}" +
      "#tas-ss .mini{display:flex;gap:4px;flex-wrap:wrap}" +
      "#tas-ss button{background:#2a2a3a;color:#e6e6ee;border:1px solid #3a3a4a;border-radius:6px;padding:5px 10px;font:12px ui-monospace,Consolas,monospace;cursor:pointer}" +
      "#tas-ss button:hover{background:#33334a}" +
      "#tas-ss .ssarm{background:#1ea3c4;border-color:#1ea3c4;color:#06222a;font-weight:bold;flex:1}" +
      "#tas-ss .ssstatus{font-size:11px;color:#9aa;white-space:pre-wrap;min-height:14px}" +
      "#tas-ss .sub{font-size:10px;color:#7c7c92;letter-spacing:.2px;line-height:1.4}" +
      // game-settings overlay host (opens the real settings page from anywhere)
      "#tas-gs-host{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.62)}" +
      // TAS rows injected INTO the game's settings page
      ".settings-menu-ui .key-binding.tas-binding .button{animation:tasblink 1s infinite;color:#9cf}" +
      ".tas-hidden{display:none!important}";
    var s = document.createElement("style"); s.id = "tas-styles"; s.textContent = css; document.head.appendChild(s);
  }

  /* ---- Run comparison (D2): how MY run is doing vs EVERY other replay ---------------
   * The overlay shows one row per rival: the ms I'm ahead/behind AT MY CURRENT CHECKPOINT
   * (frame-accurate — from each replay's exact per-checkpoint split frames) and the live
   * speed difference at this instant. Returns an array of rows (or null).
   *
   * Viewer (watching / after Apply): every loaded replay's live state comes from
   * window.__TAS_viewAll(); its exact checkpoint splits from window.__TAS_replaySplits()
   * (computed once and cached, re-computed when the replay set / a replay's length changes
   * — e.g. after Apply). "Me" = the focused replay.
   * Live driving (racing ghosts, worker streaming): states from capture.latest, splits
   * built incrementally from the per-car `carstate` event. "Me" = the active car (st).  */
  var cmpLive = new Map();      // carId -> { cp:[frameAtEachCheckpoint], fin }
  var cmpSplits = null;         // cached [] from __TAS_replaySplits, indexed by replay i
  var cmpSplitsKey = "";        // replay-set signature the cache was built for
  function cmpReset(carId) { if (carId == null) cmpLive.clear(); else cmpLive.delete(carId); }
  function cmpInvalidate() { cmpSplits = null; cmpSplitsKey = ""; }  // force a split recompute (replay set changed)
  TAS._cmpInvalidate = cmpInvalidate;
  bus.on("createcar", function (carId) { cmpReset(carId); });
  bus.on("track", function () { cmpReset(null); cmpInvalidate(); });
  // Sample the live split tables from capture.latest. Called once per overlay render
  // (~60 Hz), NOT per streamed worker frame — the old per-`carstate` subscriber ran
  // thousands of times during the ghost pre-sim burst on reset and caused a lag spike.
  // Sampling at render rate captures checkpoint frames within ~1 frame during realtime
  // racing, which is plenty for a split readout, at negligible cost.
  function cmpSampleLive() {
    capture.latest.forEach(function (st, carId) {
      var rec = cmpLive.get(carId);
      // New car or a RESET (frame jumped backwards → run restarted) → fresh table.
      if (!rec || st.frames < (rec.lastFrame || 0) - 2) { rec = { cp: [], fin: null, lastFrame: -1 }; cmpLive.set(carId, rec); }
      if (st.frames === rec.lastFrame) return;   // nothing new since last sample
      rec.lastFrame = st.frames;
      var cp = st.nextCheckpointIndex | 0;
      while (rec.cp.length < cp) rec.cp.push(st.frames);
      if (st.finished && rec.fin == null) rec.fin = st.finishFrames;
    });
  }
  function cmpMs(ms) { ms = ms | 0; return (ms > 0 ? "+" : ms < 0 ? "−" : "±") + Math.abs(ms) + "ms"; }
  function cmpSpeedText(d) { var s = fmtSpeed(Math.abs(d)); return (d > 0 ? "+" : d < 0 ? "−" : "±") + s[0] + " " + s[1]; }
  // (Re)compute the replay split cache when the replay set or any length changes. Doesn't
  // cache an all-empty result (replays not built yet) so it retries until real splits land.
  function cmpEnsureSplits(va, me) {
    if (!window.__TAS_replaySplits) return null;
    var key = va.replays.map(function (r) { return r.i + ":" + (r.last == null ? "?" : r.last); }).join(",");
    // Reuse the cache only if the key matches AND the scan reached at least the frame we're
    // now watching — so a scan taken mid-re-sim (before the replay was fully built) can't
    // stick with partial splits; it self-heals once the sim has caught up.
    var live = me && me.state ? (me.state.frames | 0) : 0;
    var covers = cmpSplits && me && cmpSplits[me.i] && cmpSplits[me.i].last >= live;
    if (cmpSplits && cmpSplitsKey === key && covers) return cmpSplits;
    var sp = null; try { sp = window.__TAS_replaySplits(); } catch (e) { sp = null; }
    if (sp) { var any = false; for (var i = 0; i < sp.length; i++) if (sp[i] && sp[i].splits && sp[i].splits.length) { any = true; break; } if (any) { cmpSplits = sp; cmpSplitsKey = key; } else return sp; }
    return cmpSplits;
  }
  // One comparison row: my split at MY current checkpoint vs theirs (ms) + live speed diff.
  // `isMe` = the row for my own run (0 / 0, always shown as the reference).
  function cmpRow(label, mySplit, opSplit, myCp, mySpd, opState, isMe) {
    var row = { label: label, cp: myCp > 0 ? "cp" + myCp : "", me: !!isMe };
    if (isMe) { row.time = "±0ms"; row.speed = cmpSpeedText(0); row.cls = ""; return row; }
    if (opState) row.speed = cmpSpeedText(mySpd - Math.abs(opState.speedKmh));
    if (mySplit && myCp > 0 && mySplit.length >= myCp) {
      if (opSplit && opSplit.length >= myCp) { var d = mySplit[myCp - 1] - opSplit[myCp - 1]; row.time = cmpMs(d); row.cls = d <= 0 ? "ahead" : "behind"; }
      else { row.time = "ahead"; row.cls = "ahead"; }   // they never reached my current checkpoint
    }
    return (row.time || row.speed) ? row : null;
  }
  function computeCompare(st) {
    var out = [], i;
    // Viewer: show EVERY loaded replay (including the focused one = me, at 0/0).
    if (inReplayViewer() && window.__TAS_viewAll) {
      var va; try { va = window.__TAS_viewAll(); } catch (e) { va = null; }
      if (!va || !va.replays || !va.replays.length) return null;
      var rs = va.replays, me = null;
      for (i = 0; i < rs.length; i++) if (rs[i].focus) { me = rs[i]; break; }
      if (!me) me = rs[va.focus] || rs[0];
      var splits = cmpEnsureSplits(va, me);
      var myCp = me.state ? (me.state.nextCheckpointIndex | 0) : 0;
      var mySpd = me.state ? Math.abs(me.state.speedKmh) : 0;
      var mySplit = splits && splits[me.i] ? splits[me.i].splits : null;
      for (i = 0; i < rs.length; i++) {
        var op = rs[i], isMe = (op === me), opSplit = splits && splits[op.i] ? splits[op.i].splits : null;
        var nm = op.name || ("#" + (op.i + 1));          // real player nickname when available
        var row = cmpRow(nm + (isMe ? " ◄" : ""), mySplit, opSplit, myCp, mySpd, op.state, isMe);
        if (row) out.push(row);
      }
      return out.length ? out : null;
    }
    // Live driving. The player streams live, but the game DELETES each ghost's worker car
    // after pre-simulating its trajectory — so capture.latest loses the ghosts mid-drive.
    // The racing screen keeps each ghost's checkpoint splits + trajectory + nickname, exposed
    // as window.__TAS_race(currentFrame). Use that for the ghosts; the player stays live.
    if (!st || st.carId == null) return null;
    // While a ghost is the active car (the reset pre-sim, before you're driving) there's
    // nothing to compare yet — skip, so the HUD does no work during that burst.
    var activeInfo = capture.cars.get(st.carId);
    if (activeInfo && activeInfo.hasRecording) return null;
    var myId = (capture.playerCarId != null && capture.latest.has(capture.playerCarId)) ? capture.playerCarId : st.carId;
    var myState = capture.latest.get(myId) || st;
    var myCp2 = myState.nextCheckpointIndex | 0, mySpd2 = Math.abs(myState.speedKmh), myFrame = myState.frames | 0;
    var myRec = cmpLive.get(myId), mySplit2 = myRec ? myRec.cp : null;
    out.push(cmpRow("you", null, null, myCp2, mySpd2, null, true));   // my own 0/0 reference row
    var ghosts = null; try { if (window.__TAS_race) ghosts = window.__TAS_race(myFrame); } catch (e) { ghosts = null; }
    if (ghosts && ghosts.length) {
      // Ghost splits are the exact per-checkpoint frames the game precomputed; g.state is the
      // ghost's CarState at MY current frame (same race clock) → the live speed delta.
      var gn = 0;
      for (i = 0; i < ghosts.length; i++) {
        var g = ghosts[i]; if (!g) continue; gn++;
        var row = cmpRow(g.name || ("ghost " + gn), mySplit2, g.splits, myCp2, mySpd2, g.state, false);
        if (row) out.push(row);
      }
    } else {
      // Fallback: ghosts still streaming through the worker (during the pre-sim) → capture.latest.
      var now = perfNow(), ids = []; capture.latest.forEach(function (s2, id) { ids.push(id); }); ids.sort(function (a, b) { return a - b; });
      var rivalN = 0;
      for (i = 0; i < ids.length; i++) {
        var id = ids[i]; if (id === myId) continue;
        var ts = capture.lastUpdateTs.get(id) || 0; if (now - ts > 500) continue;   // skip stale/dead cars
        var rec = cmpLive.get(id);
        var row2 = cmpRow("ghost " + (++rivalN), mySplit2, rec ? rec.cp : null, myCp2, mySpd2, capture.latest.get(id), false);
        if (row2) out.push(row2);
      }
    }
    return out.length ? out : null;
  }
  TAS.computeCompare = computeCompare;

  /* ---- Overlay ---- */
  function buildOverlay() {
    var el = document.createElement("div"); el.id = "tas-overlay";
    var WL = ["FL", "FR", "RL", "RR"];
    var wheelHtml = "";
    for (var i = 0; i < 4; i++) wheelHtml += '<div class="tas-w" data-w="' + i + '"><div class="lab"><span>' + WL[i] + '</span><span class="val">--</span></div><div class="tas-bar"><i></i></div></div>';
    el.innerHTML =
      '<div class="tas-hdr"><span>TAS · telemetry</span><span class="cp">CP --</span></div>' +
      '<div class="tas-spd"><span class="v">0</span><small class="unit">km/h</small></div>' +
      '<div class="tas-row"><span class="k">frame</span><span class="fr">--</span></div>' +
      '<div class="tas-row"><span class="k">time</span><span class="tm">--</span></div>' +
      '<div class="tas-row"><span class="k">steer</span><span class="st">0°</span></div>' +
      '<div class="tas-grip">' + wheelHtml + '</div>' +
      '<div class="tas-keys"><span data-k="w">W</span><span data-k="a">A</span><span data-k="s">S</span><span data-k="d">D</span><span data-k="r">R</span></div>' +
      '<div class="tas-cmp" style="display:none"></div>' +
      '<div class="tas-taint">⛔ upload blocked (tainted run)</div>';
    document.body.appendChild(el);

    var q = function (s) { return el.querySelector(s); };
    var vEl = q(".tas-spd .v"), unitEl = q(".tas-spd .unit"), frEl = q(".fr"), tmEl = q(".tm"), stEl = q(".st"), cpEl = q(".cp");
    var cmpEl = q(".tas-cmp"), cmpKey = "";
    var wheels = []; for (var w = 0; w < 4; w++) { var we = el.querySelector('.tas-w[data-w="' + w + '"]'); wheels.push({ box: we, val: we.querySelector(".val"), bar: we.querySelector("i") }); }
    var keyEls = {}; ["w", "a", "s", "d", "r"].forEach(function (k) { keyEls[k] = el.querySelector('.tas-keys span[data-k="' + k + '"]'); });

    var last = null, raf = 0;
    function render() {
      raf = 0; var st = last; if (!st) return;
      var sp = fmtSpeed(st.speedKmh); vEl.textContent = sp[0]; unitEl.textContent = sp[1];
      frEl.textContent = st.frames + (st.finished ? " ✓" : "");
      tmEl.textContent = fmtTime(st.finished && st.finishFrames != null ? st.finishFrames : st.frames);
      stEl.textContent = (st.steering * 180 / Math.PI).toFixed(1) + "°";
      cpEl.textContent = "CP " + st.nextCheckpointIndex;
      for (var i = 0; i < 4; i++) {
        var inContact = !!st.wheelContact[i];
        var grip = inContact ? Math.max(0, Math.min(1, st.wheelSkidInfo[i])) : 0;
        wheels[i].box.className = "tas-w" + (inContact ? "" : " air");
        wheels[i].val.textContent = inContact ? (grip * 100).toFixed(0) + "%" : "air";
        wheels[i].bar.style.width = (grip * 100).toFixed(0) + "%";
        wheels[i].bar.style.background = grip > .66 ? "#5cff8a" : grip > .33 ? "#ffd25c" : "#ff6b6b";
      }
      keyEls.w.className = st.controls.up ? "on" : "";
      keyEls.a.className = st.controls.left ? "on" : "";
      keyEls.s.className = st.controls.down ? "on" : "";
      keyEls.d.className = st.controls.right ? "on" : "";
      keyEls.r.className = st.controls.reset ? "on" : "";
      // Comparison rows vs every other replay (D2). Full frame rate — it's not a bottleneck.
      // One row per rival: split delta at my current checkpoint + live speed diff. The DOM is
      // rebuilt only when the row text actually changes (key compare).
      cmpSampleLive();
      var rows = computeCompare(st);
      if (rows && rows.length) {
        var key = "", html = '<div class="cmp-hdr">vs racers</div>';
        for (var ci = 0; ci < rows.length; ci++) {
          var rw = rows[ci];
          html += '<div class="cmp-row ' + (rw.cls || "") + (rw.me ? " me" : "") + '"><span class="cl">' + rw.label + '</span><span class="cp">' + (rw.cp || "") + '</span><span class="ct">' + (rw.time || "--") + '</span><span class="cs">' + (rw.speed || "") + '</span></div>';
          key += rw.label + rw.cp + rw.time + rw.speed + "|";
        }
        cmpEl.style.display = "";
        if (key !== cmpKey) { cmpKey = key; cmpEl.innerHTML = html; }
      } else { cmpEl.style.display = "none"; cmpKey = ""; }
    }
    bus.on("telemetry", function (st) { last = st; if (el.classList.contains("tas-hidden")) return; if (!raf) raf = requestAnimationFrame(render); });
    bus.on("settings", function () { if (!el.classList.contains("tas-hidden") && last && !raf) raf = requestAnimationFrame(render); });

    return {
      el: el,
      toggle: function () { el.classList.toggle("tas-hidden"); if (!el.classList.contains("tas-hidden") && last && !raf) raf = requestAnimationFrame(render); },
      setTainted: function (t) { el.classList.toggle("tainted", !!t); }
    };
  }

  /* ---- Panel + input editor ---- */
  function buildPanel() {
    var el = document.createElement("div"); el.id = "tas-panel";
    el.classList.add("tas-hidden"); // shown only in the replay viewer (installViewerContext)
    el.innerHTML =
      '<div class="ph"><b>PolyTrack TAS</b><span class="sp"></span><span class="pill" id="tas-pill">replay editor</span><button id="tas-settings-btn" title="Open the game Settings (TAS Tool section: keybinds &amp; options)">⚙</button><button id="tas-min" title="Hide">—</button></div>' +
      '<div class="pb">' +
        '<div class="lbl">Run telemetry</div>' +
        '<div class="stat">' +
          '<span class="k">frame</span><span id="tas-s-frame">--</span>' +
          '<span class="k">speed</span><span id="tas-s-speed">--</span>' +
          '<span class="k">checkpoint</span><span id="tas-s-cp">--</span>' +
          '<span class="k">finished</span><span id="tas-s-fin">--</span>' +
          '<span class="k">capture</span><span id="tas-s-cap">waiting for sim worker…</span>' +
        '</div>' +
        '<div class="lbl">Input editor  ·  <code>frame,keys</code> + <code>tap s e keys on off</code></div>' +
        '<textarea id="tas-editor" spellcheck="false" placeholder="# hold W, then tap the D (right) key: 10 frames on, 5 off\n0,w\ntap 1500 1700 wd 10 5\n2000,w"></textarea>' +
        '<div class="row">' +
          '<button id="tas-reload" title="(Re)load the viewed replay\'s inputs into the editor (discards edits)">Reload replay</button>' +
          '<button id="tas-compact" title="Shrink: dedupe + fold alternating inputs back into tap macros">Compact</button>' +
          '<button id="tas-stats">Stats</button>' +
          '<button id="tas-simtime" title="Simulate the editor inputs and show the finish time (no upload) — fast iteration">⏱ Time</button>' +
          '<button id="tas-copy">Copy</button>' +
        '</div>' +
        '<div class="row">' +
          '<button id="tas-save">Save</button>' +
          '<button id="tas-loadf">Load file</button>' +
          '<button id="tas-clear" class="warn">Clear</button>' +
        '</div>' +
        '<div class="row">' +
          '<button id="tas-apply" class="go" title="Re-simulate the viewed replay with your editor inputs — watch your edits play back in the viewer">Apply → replay</button>' +
        '</div>' +
        '<div class="row">' +
          '<button id="tas-uptas" class="go" title="Simulate the editor inputs to the finish line, read the finish time, and post it to the TAS leaderboard as a full-TAS run">Simulate finish → upload TAS</button>' +
        '</div>' +
        '<div class="status" id="tas-status">Open a replay (Watch) — its inputs load here; edit them, then Apply.</div>' +
      '</div>';
    document.body.appendChild(el);

    // Layout (tall/wide) + persisted geometry (position & size). The panel is
    // resizable from any edge or corner (custom handles below) and the body scrolls,
    // so it can never push content off-screen.
    function applyLayout() { el.classList.toggle("wide", settings.layout === "wide"); }
    function saveGeo() { try { localStorage.setItem("tas:panelGeo", JSON.stringify({ left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height })); } catch (e) {} }
    applyLayout();
    try { var geo = JSON.parse(localStorage.getItem("tas:panelGeo") || "null"); if (geo) { if (geo.left) { el.style.left = geo.left; el.style.right = "auto"; } if (geo.top) el.style.top = geo.top; if (geo.width) el.style.width = geo.width; if (geo.height) el.style.height = geo.height; } } catch (e) {}
    // Only reset the panel size when the tall/wide LAYOUT actually changes — not
    // on every settings emit (units, remember-editor, Interface size, decimals),
    // which would otherwise wipe a size the user set via the resize handle.
    var _prevLayout = settings.layout;
    bus.on("settings", function () { applyLayout(); if (settings.layout !== _prevLayout) { _prevLayout = settings.layout; el.style.width = ""; el.style.height = ""; saveGeo(); } });
    if (typeof ResizeObserver !== "undefined") { var _rt = null; new ResizeObserver(function () { if (_rt) clearTimeout(_rt); _rt = setTimeout(saveGeo, 300); }).observe(el); }

    var $ = function (id) { return el.querySelector("#" + id); };
    var editor = $("tas-editor"), status = $("tas-status");
    function setStatus(m) { status.textContent = m; }

    // Restore + persist editor content (opt-out via settings.rememberEditor).
    try { if (settings.rememberEditor) { var saved = localStorage.getItem("tas:editor"); if (saved != null) editor.value = saved; } } catch (e) {}
    var _saveT = null;
    editor.addEventListener("input", function () {
      if (!settings.rememberEditor) return;
      if (_saveT) clearTimeout(_saveT);
      _saveT = setTimeout(function () { try { localStorage.setItem("tas:editor", editor.value); } catch (e) {} }, 300);
    });
    // QoL: Ctrl/Cmd+Enter in the editor = Apply → replay (fast iterate without reaching for the button).
    editor.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.code === "Enter")) { e.preventDefault(); var b = $("tas-apply"); if (b) b.click(); }
    });

    // dragging by header
    (function () {
      var h = el.querySelector(".ph"), dragging = false, grabX = 0, grabY = 0;
      // Use getBoundingClientRect (actual px) so drag is correct at any UI scale;
      // style.left is CSS px that `zoom` multiplies, so divide the target by scale.
      h.addEventListener("mousedown", function (e) { if (e.target.tagName === "BUTTON") return; var r = el.getBoundingClientRect(); grabX = e.clientX - r.left; grabY = e.clientY - r.top; dragging = true; e.preventDefault(); });
      window.addEventListener("mousemove", function (e) { if (!dragging) return; var s = currentScale(); el.style.left = Math.max(0, (e.clientX - grabX) / s) + "px"; el.style.top = Math.max(0, (e.clientY - grabY) / s) + "px"; el.style.right = "auto"; });
      window.addEventListener("mouseup", function () { if (dragging) { dragging = false; saveGeo(); } });
    })();

    // Resizing by any edge or corner (custom handles — CSS `resize` only offers the
    // corner). Zoom-aware like the drag: getBoundingClientRect is post-zoom actual px,
    // style.left/top/width/height are pre-zoom CSS px, so deltas are divided by scale.
    // West/North edges move the opposite-fixed edge, so they adjust left/top too.
    (function () {
      var rz = null;
      ["n", "s", "e", "w", "ne", "nw", "sw", "se"].forEach(function (dir) {
        var g = document.createElement("div"); g.className = "tas-rz tas-rz-" + dir; el.appendChild(g);
        g.addEventListener("mousedown", function (e) {
          e.preventDefault(); e.stopPropagation();
          var r = el.getBoundingClientRect(), s = currentScale();
          rz = { dir: dir, s: s, mx: e.clientX, my: e.clientY, left: r.left / s, top: r.top / s, w: r.width / s, h: r.height / s };
          document.body.style.userSelect = "none";
        });
      });
      window.addEventListener("mousemove", function (e) {
        if (!rz) return;
        var s = rz.s, dx = (e.clientX - rz.mx) / s, dy = (e.clientY - rz.my) / s;
        var minW = 300, minH = 150, maxW = 0.97 * window.innerWidth / s, maxH = 0.97 * window.innerHeight / s;
        var left = rz.left, top = rz.top, w = rz.w, h = rz.h;
        if (rz.dir.indexOf("e") >= 0) w = Math.max(minW, Math.min(maxW, rz.w + dx));
        if (rz.dir.indexOf("s") >= 0) h = Math.max(minH, Math.min(maxH, rz.h + dy));
        if (rz.dir.indexOf("w") >= 0) { w = Math.max(minW, Math.min(maxW, rz.w - dx)); left = rz.left + rz.w - w; }
        if (rz.dir.indexOf("n") >= 0) { h = Math.max(minH, Math.min(maxH, rz.h - dy)); top = rz.top + rz.h - h; }
        if (left < 0) { w += left; left = 0; }   // keep the fixed (right) edge put
        if (top < 0) { h += top; top = 0; }      // keep the fixed (bottom) edge put
        el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = left + "px"; el.style.top = top + "px"; el.style.right = "auto";
      });
      window.addEventListener("mouseup", function () { if (rz) { rz = null; document.body.style.userSelect = ""; saveGeo(); } });
    })();

    function setEditor(v) { editor.value = v; if (settings.rememberEditor) { try { localStorage.setItem("tas:editor", v); } catch (e) {} } }

    $("tas-min").onclick = function () { el.classList.add("tas-hidden"); };
    $("tas-settings-btn").onclick = function () { openGameSettings(); };

    $("tas-reload").onclick = async function () {
      if (!inReplayViewer()) { setStatus("Open a replay (Watch) — the editor binds to the replay you're viewing."); return; }
      if ((editor.value || "").trim() && !(await tasConfirm("Reload the viewed replay's inputs into the editor? This discards your current edits."))) return;
      loadViewerReplayIntoEditor(true).then(function (ok) { if (!ok) setStatus("No replay available to load into the editor."); });
    };
    $("tas-compact").onclick = function () {
      try { setEditor(compactScript(editor.value)); setStatus("Compacted. " + describeScript()); refreshStats(); }
      catch (e) { setStatus("Compact failed: " + e); }
    };
    $("tas-stats").onclick = refreshStats;
    // ⏱ Time: headlessly simulate the editor inputs and report the finish time —
    // no upload, no leaving the viewer; lets you iterate on a TAS quickly.
    $("tas-simtime").onclick = async function () {
      var btn = $("tas-simtime"); if (btn.disabled) return;
      var rec; try { rec = scriptToRecording(editor.value || ""); } catch (e) { setStatus("Parse error — " + e); return; }
      if (rec.numberOfInputs() < 1) { setStatus("Editor has no inputs to simulate."); return; }
      if (!capture.init || !capture.lastCar || capture.lastCar.trackData == null) { setStatus("No track captured yet — open a replay (Watch) on this track first."); return; }
      var enc; try { enc = await rec.serialize(); } catch (e) { setStatus("Encode failed — " + e); return; }
      btn.disabled = true; setStatus("Simulating the editor inputs…");
      var horizon = Math.min(Recording.MAX_FRAMES, rec.numberOfFrames() + 30000);
      try { var fin = await boardSimulateFinish(enc, horizon); btn.disabled = false; setStatus("⏱ Finishes at " + fmtTime(fin.finishFrames) + "  (" + fin.finishFrames + " frames)"); }
      catch (e) { btn.disabled = false; setStatus("These inputs don't reach the finish — " + e.message + "."); }
    };
    $("tas-copy").onclick = function () { copyText(editor.value); setStatus("Copied script to clipboard."); };
    $("tas-clear").onclick = async function () { if (editor.value && !(await tasConfirm("Clear the editor?"))) return; setEditor(""); setStatus("Cleared."); };
    $("tas-save").onclick = function () { saveText(editor.value, "run.tas"); setStatus("Saved run.tas (browser download)."); };
    $("tas-loadf").onclick = function () { loadTextFile(function (txt) { setEditor(txt); setStatus("Loaded file."); refreshStats(); }); };
    // Apply → re-simulate the VIEWED replay with your edits. Hand the game a
    // copy of the loaded records with the bound replay's recording replaced by
    // the editor's compiled recording, and re-enter the viewer (the game
    // preloads + re-simulates it). You then watch your edited replay.
    $("tas-apply").onclick = async function () {
      if (!inReplayViewer()) { setStatus("Apply works in the Replay viewer — open a replay (Watch) first."); return; }
      var V = window.__TAS_view;
      if (!V || !V.records || !V.records.length || typeof V.enter !== "function") { setStatus("Replay-viewer hook unavailable — open a replay via Watch."); return; }
      var idx = (typeof TAS._viewerEditIdx === "number") ? TAS._viewerEditIdx : 0;
      if (idx < 0 || idx >= V.records.length) idx = 0;
      var rec;
      try { rec = scriptToRecording(editor.value || ""); } catch (e) { setStatus("Apply: parse error — " + e); return; }
      if (rec.numberOfInputs() < 1) { setStatus("Apply: the editor script has no inputs."); return; }
      var enc;
      try { enc = await rec.serialize(); } catch (e) { setStatus("Apply: encode failed — " + e); return; }
      // settings.recording must be a GAME Recording object (the viewer calls
      // .serialize() on it). Build one from our edited base64 using the existing
      // record's class (its static deserialize); our codec is byte-compatible.
      var cur = V.records[idx] && V.records[idx].recording;
      var GameRec = cur && cur.constructor;
      var newRec = null;
      try { if (GameRec && typeof GameRec.deserialize === "function") newRec = GameRec.deserialize(enc); } catch (e) { newRec = null; }
      if (!newRec) { setStatus("Apply: couldn't build a game recording object — try Reload replay, then Apply."); return; }
      var edited = V.records.map(function (s, i) { return i === idx ? Object.assign({}, s, { recording: newRec }) : s; });
      TAS._viewerBoundRecObj = newRec; // so the re-sim re-entry keeps the editor (macros/comments intact)
      // Capture scrub frame before re-simulation and delegate fast seek/pause
      // to the inbound physics worker message handler once frames arrive.
      var savedFrame = 0;
      try {
        var vs0 = window.__TAS_viewState && window.__TAS_viewState();
        if (vs0 && typeof vs0.frame === "number") savedFrame = vs0.frame | 0;
      } catch (e) {}
      var targetFrame = Math.max(0, savedFrame);
      TAS._applyRestoreFrame = targetFrame;
      TAS._applyRestored = false;
      TAS._applyStatusFn = setStatus;
      if (window.__TAS_viewSeek && window.__TAS_viewState && !window.__TAS_viewState.seek) {
        window.__TAS_viewState.seek = window.__TAS_viewSeek;
      }
      try {
        V.enter(V.trackMeta, V.trackData, V.category, edited);
        if (TAS._cmpInvalidate) TAS._cmpInvalidate();   // the edited replay changed → recompute splits
        setStatus("Re-simulating replay " + (idx + 1) + " with your edits (" + rec.numberOfFrames() + " frames)…");
      } catch (e) { setStatus("Apply failed: " + e); }
    };

    // Simulate the editor inputs to the finish line, read the real finish time,
    // and post it to the TAS leaderboard as a full-TAS run. Each failure mode is
    // reported so it's clear WHY a run can't be uploaded.
    $("tas-uptas").onclick = async function () {
      var btn = $("tas-uptas"); if (btn.disabled) return;
      var rec; try { rec = scriptToRecording(editor.value || ""); } catch (e) { setStatus("Parse error — " + e); return; }
      if (rec.numberOfInputs() < 1) { setStatus("The editor has no inputs to simulate."); return; }
      if (!capture.init || !capture.lastCar || capture.lastCar.trackData == null) { setStatus("No track loaded yet — open a replay (Watch) on this track first so the tool captures it."); return; }
      var trackId = TAS.currentTrackId || (gate.lastRun && gate.lastRun.track_id);
      if (!trackId) { setStatus("Track id unknown — open this track's leaderboard once (the game then tells the tool its id), then retry."); return; }
      var enc; try { enc = await rec.serialize(); } catch (e) { setStatus("Encode failed — " + e); return; }
      btn.disabled = true; setStatus("Simulating the editor inputs to the finish line…");
      var horizon = Math.min(Recording.MAX_FRAMES, rec.numberOfFrames() + 30000), fin;
      try { fin = await boardSimulateFinish(enc, horizon); }
      catch (e) { btn.disabled = false; setStatus("These inputs don't reach the finish — " + e.message + ". (The run must cross the finish line to be timed.)"); return; }
      var run = { track_id: trackId, category: "edited", frames: fin.finishFrames, recording: enc, car_style: (gate.lastRun && gate.lastRun.car_style) || capture.carStyle || "", nickname: uploadNickname(), user_id: TAS.userId || null };
      setStatus("Finishes at " + fmtTime(fin.finishFrames) + " — posting to the TAS leaderboard…");
      board.uploadIfBest(run).then(function (res) {
        btn.disabled = false;
        if (res.uploaded) { setStatus("Posted edited run — " + fmtTime(fin.finishFrames) + " as “" + run.nickname + "”" + (res.pb ? " (new PB!)" : "") + ". It's under the Edited tag."); if (TAS.lbTwin) TAS.lbTwin.refresh(); }
        else if (res.error) setStatus("Simulated OK (" + fmtTime(fin.finishFrames) + ") but upload was rejected: " + res.error);
        else setStatus("Simulated " + fmtTime(fin.finishFrames) + " — your existing best (" + fmtTime(res.prevBest) + ") is faster, so nothing was uploaded.");
      }).catch(function (e) { btn.disabled = false; setStatus("Simulated OK (" + fmtTime(fin.finishFrames) + ") but upload errored: " + e); });
    };

    // Upload block is automatic now (a savestate at frame N>0 taints the run);
    // there is no manual toggle. The overlay border shows the tainted state.
    if (TAS.overlay) TAS.overlay.setTainted(!!window.__TAS_tainted);

    function describeScript() {
      var rec = scriptToRecording(editor.value), n = rec.numberOfFrames();
      var inputs = 0; for (var k = 0; k < 5; k++) inputs += rec.ch[CHANNELS[k]].length;
      return inputs + " toggles · last frame " + n;
    }
    function refreshStats() {
      try {
        var entries = compileScript(editor.value);
        var first = entries.length ? entries[0].frame : "--", last = entries.length ? entries[entries.length - 1].frame : "--";
        setStatus("Script: " + entries.length + " state changes · frames " + first + "–" + last + " · " + describeScript());
      } catch (e) { setStatus("Parse error: " + e); }
    }

    // live telemetry into the panel
    var s = { frame: $("tas-s-frame"), speed: $("tas-s-speed"), cp: $("tas-s-cp"), fin: $("tas-s-fin"), cap: $("tas-s-cap") };
    bus.on("init", function () { s.cap.textContent = "sim worker attached ✓"; });
    var praf = 0, plast = null;
    bus.on("telemetry", function (st) { plast = st; if (el.classList.contains("tas-hidden")) return; if (!praf) praf = requestAnimationFrame(function () { praf = 0; var x = plast; if (!x) return; var sp = fmtSpeed(x.speedKmh); s.frame.textContent = x.frames; s.speed.textContent = sp[0] + " " + sp[1]; s.cp.textContent = String(x.nextCheckpointIndex); s.fin.textContent = x.finished ? ("yes (" + x.finishFrames + ")") : "no"; }); });

    return { el: el, body: el.querySelector(".pb"), toggle: function () { el.classList.toggle("tas-hidden"); if (!el.classList.contains("tas-hidden")) applyScale(); }, setStatus: setStatus, setEditor: setEditor, editor: editor, saveGeo: saveGeo };
  }

  /* ---- small helpers ---- */
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    else fallbackCopy(t);
  }
  function fallbackCopy(t) { try { var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); } catch (e) {} }
  function saveText(t, name) { try { var b = new Blob([t], { type: "text/plain" }); var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); } catch (e) {} }
  function loadTextFile(cb, accept) { var inp = document.createElement("input"); inp.type = "file"; inp.accept = accept || ".tas,.txt"; inp.onchange = function () { var f = inp.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { cb(String(r.result || "")); }; r.readAsText(f); }; inp.click(); }

  // Set to an action id while the settings UI is capturing a new key.
  var _rebinding = null;
  // Which PolyTrack action (if any) is bound to this key code — for the rebind
  // collision warning. Reads the game's own binding table from localStorage.
  function gameBindingFor(code) {
    try {
      var raw = localStorage.getItem("polytrack_v5_prod_key_bindings");
      if (!raw) return null;
      var arr = JSON.parse(raw);
      for (var i = 0; i < arr.length; i++) { var b = arr[i]; if (b && b[1] && (b[1][0] === code || b[1][1] === code)) return b[0]; }
    } catch (e) {}
    return null;
  }
  TAS.gameBindingFor = gameBindingFor;
  // Is this key code currently bound to any TAS action?
  function isTasBound(code) { if (!code) return false; var K = settings.keys; for (var k in K) if (K[k] === code) return true; return false; }
  function installHotkeys() {
    // Swallow the keyUP of every TAS-bound key too. The game reads its controls as
    // keydown+keyup PAIRS; if a TAS bind collides with a game bind and we ate only the
    // keydown, the lone keyup would latch the game's action on. Symmetric swallowing +
    // the rebind-time collision warning keep a colliding key doing ONLY the TAS action.
    window.addEventListener("keyup", function (e) {
      if (_rebinding) return;
      var t = e.target, typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (typing && !/^F\d{1,2}$/.test(e.code) && e.code !== "Escape") return; // mirror the keydown gate
      if (isTasBound(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener("keydown", function (e) {
      if (_rebinding) return; // the settings rebind capture owns the keystroke
      var t = e.target, typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      var code = e.code;
      // While typing in a field, let printable keys through to the field; still
      // honour function keys / Escape so e.g. F9 can toggle the panel mid-edit.
      if (typing && !/^F\d{1,2}$/.test(code) && code !== "Escape") return;
      var K = settings.keys;
      var matched = code && (code === K.overlay || code === K.panel || code === K.reload || code === K.settings || code === K.savestate || code === K.ssSet || code === K.ssReturn);
      if (!matched) return;
      // stopImmediatePropagation (not just stopPropagation): a game listener registered
      // earlier in this same capture pass would otherwise still fire on the key.
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return; // OS auto-repeat: swallow, but don't re-fire the action
      // Overlay (telemetry), upload-block and open-settings work anywhere. The
      // editor panel + replay-load + savestate are replay-viewer-only.
      if (code === K.overlay) { if (TAS.overlay) TAS.overlay.toggle(); }
      else if (code === K.panel) { if (!inReplayViewer()) toast("TAS editor is only in the Replay viewer — open a replay (Watch)."); else if (TAS.panel) TAS.panel.toggle(); }
      else if (code === K.reload) {
        if (!inReplayViewer()) { toast("Open a replay (Watch) — the editor binds to it."); }
        else loadViewerReplayIntoEditor(true).then(function (ok) { if (!ok) toast("No replay to load into the editor."); });
      }
      else if (code === K.settings) { openGameSettings(); }
      else if (code === K.savestate) { if (TAS.quickSavestate) TAS.quickSavestate(); }
      else if (code === K.ssSet) { ssSetPoint(); }
      else if (code === K.ssReturn) { ssGotoLast(); }
    }, true);
  }

  // (The standalone TAS settings modal was removed — all TAS keybinds and
  // options now live inside PolyTrack's own Settings page, injected by
  // installGameSettings(). The panel's ⚙ button + the "settings" hotkey open
  // that page via window.__TAS_settings.make(...).)

  // Build UI when the DOM is ready (the early patches above already ran).
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUI);
  else buildUI();

  TAS.log("core injected (v" + TAS.version + ", target game " + GAME_VERSION + ").");
})();
