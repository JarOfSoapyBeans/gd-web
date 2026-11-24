/*
 * DashMods: a small mod menu for the Geometry Dash web port.
 *
 * Loaded before the game starts, so it can wrap the clock and audio the engine uses:
 *   - The engine reads time through performance.now() / Date.now() on every call,
 *     so scaling those scales the whole game (speedhack) or stops it (freeze).
 *   - Music runs through Module.__gdAudio (Web Audio). Source playback rates and the
 *     engine's music-position function (chPos) are scaled by the same factor, so
 *     music stays in sync with the slowed or frozen game.
 */
(function () {
  "use strict";
  if (window.__dashMods) return;

  // ------------------------------------------------------------------ storage
  const STORE_KEY = "dashmods.v1";
  let store = { enabled: {}, settings: {} };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) store = Object.assign(store, JSON.parse(raw));
  } catch (e) {}
  let saveTimer = 0;
  function persistNow() {
    clearTimeout(saveTimer); saveTimer = 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 150);
  }
  // Never lose a setting changed right before the page is reloaded or closed.
  window.addEventListener("pagehide", () => { if (saveTimer) persistNow(); });

  // ------------------------------------------------------------------ blocked-song cleanup
  // Newgrounds answers blocked downloads with a short "hotlinking disabled" clip (always the
  // same 41,796-byte file). The game saves downloaded songs in IndexedDB, so a clip saved
  // before the fix kept playing. Remove any saved copy of that clip before the game restores
  // its files (the song then shows as not downloaded and can be downloaded again).
  const NG_CLIP = { size: 41796, sha1: "fd2ee6296668da16f1fc1a80eb402eb824083f6b" };
  async function isNgClip(bytes) {
    if (!bytes || bytes.byteLength !== NG_CLIP.size) return false;
    const d = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("") === NG_CLIP.sha1;
  }
  const removedClips = [];
  try {
    // Same version and store as the game uses, so opening it here never leaves it half set up.
    const q = indexedDB.open("gdwasm_saves", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("files");
    q.onsuccess = () => {
      const db = q.result, found = [];
      const tx = db.transaction("files", "readonly");
      tx.objectStore("files").openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        if (/\.(mp3|ogg)$/i.test(String(c.key)) && c.value && c.value.byteLength === NG_CLIP.size) found.push([c.key, c.value]);
        c.continue();
      };
      tx.oncomplete = async () => {
        const bad = [];
        for (const [k, v] of found) if (await isNgClip(v)) bad.push(k);
        if (!bad.length) return db.close();
        const del = db.transaction("files", "readwrite");
        for (const k of bad) del.objectStore("files").delete(k);
        del.oncomplete = () => { db.close(); removedClips.push(...bad); console.log("[DashMods] removed blocked song clips:", bad); };
      };
    };
  } catch (e) {}

  // ------------------------------------------------------------------ clock
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  const dateOffset = realDateNow() - realNow();
  const clock = {
    speed: 1,          // speedhack multiplier
    holds: new Set(),  // reasons the game should be frozen ("step", "menu")
    parked: false,     // true only while the engine is actually held in its frame wait
    baseReal: realNow(),
    baseVirt: realNow(),
  };
  function factor() { return clock.parked ? 0 : clock.speed; }
  function virtNow() {
    return clock.baseVirt + (realNow() - clock.baseReal) * factor();
  }
  function rebaseClock() {
    const v = virtNow();
    clock.baseReal = realNow();
    clock.baseVirt = v;
  }
  performance.now = function () { return virtNow(); };
  Date.now = function () { return Math.floor(virtNow() + dateOffset); };

  // ------------------------------------------------------------------ audio
  const audio = { follow: true, factor: 1, sources: new Set(), patchedChPos: false };
  const paramDesc = Object.getOwnPropertyDescriptor(AudioParam.prototype, "value");
  const ACProto = (window.BaseAudioContext || window.AudioContext || {}).prototype;
  if (ACProto && ACProto.createBufferSource && paramDesc) {
    const origCreate = ACProto.createBufferSource;
    ACProto.createBufferSource = function () {
      const node = origCreate.apply(this, arguments);
      const param = node.playbackRate;
      let wanted = paramDesc.get.call(param);
      Object.defineProperty(param, "value", {
        configurable: true,
        get() { return wanted; },
        set(v) { wanted = v; paramDesc.set.call(param, v * audio.factor); },
      });
      node.__dmWanted = () => wanted;
      audio.sources.add(node);
      node.addEventListener("ended", () => audio.sources.delete(node));
      const origStart = node.start;
      node.start = function () {
        const r = origStart.apply(node, arguments);
        // Report only the first start of a channel: resuming from a pause restarts every
        // paused channel (old play/quit sounds included), which must not count as new sounds.
        if (audio.onStart.length) queueMicrotask(() => {
          try {
            const A = gdAudio();
            if (!A) return;
            let ch = null;
            for (const id in A.channels) if (A.channels[id] && A.channels[id].src === node) { ch = A.channels[id]; break; }
            if (!ch || seenChannels.has(ch)) return;
            seenChannels.add(ch);
            const name = soundName(node.buffer);
            if (name) audio.onStart.forEach((f) => f(name));
          } catch (e) {}
        });
        return r;
      };
      return node;
    };
  }
  function gdAudio() { return window.Module && window.Module.__gdAudio; }
  // Which game sound file a buffer belongs to ("playSound_01.ogg", ...).
  audio.onStart = [];
  const seenChannels = new WeakSet();
  const bufNames = new WeakMap();
  function soundName(buf) {
    if (!buf) return "";
    if (bufNames.has(buf)) return bufNames.get(buf);
    const A = gdAudio();
    if (A && A.sounds) for (const k in A.sounds) {
      const s = A.sounds[k];
      if (s && s.buf && s.name) bufNames.set(s.buf, String(s.name).split(/[\\/]/).pop());
    }
    return bufNames.get(buf) || "";
  }
  function rawChPos(A, ch, f) {
    const ctx = A.ctx;
    if (!ch || !ctx) return 0;
    if (ch.paused || ch.pausedByGroup) return ch.pausedAt;
    if (!ch.src || !ch.when) return ch.base;
    let t = (ctx.currentTime - ch.when) * ch.pitch * f * 1e3 + ch.base;
    const s = A.sounds[ch.sound];
    const len = (s && s.len) || 0;
    if (len && t > len) t = ch.loop ? t % len : len;
    return Math.max(0, t);
  }
  function patchChPos() {
    const A = gdAudio();
    if (!A || audio.patchedChPos) return;
    A.chPos = function (ch) { return Math.round(rawChPos(A, ch, audio.factor)); };
    audio.patchedChPos = true;
  }
  function applyAudio() {
    patchChPos();
    const next = clock.parked ? 0 : (audio.follow ? clock.speed : 1);
    if (next === audio.factor) return;
    const A = gdAudio();
    if (A && A.ctx) {
      // Re-anchor every playing channel so its reported position stays continuous.
      for (const id in A.channels) {
        const ch = A.channels[id];
        if (ch && ch.src && ch.when && !ch.paused && !ch.pausedByGroup) {
          ch.base = rawChPos(A, ch, audio.factor);
          ch.when = A.ctx.currentTime;
        }
      }
    }
    audio.factor = next;
    for (const n of audio.sources) {
      try { paramDesc.set.call(n.playbackRate, n.__dmWanted() * next); } catch (e) {}
    }
  }
  const audioPoll = setInterval(() => {
    if (gdAudio()) { patchChPos(); clearInterval(audioPoll); }
  }, 250);

  // ------------------------------------------------------------------ frame gate
  // The engine waits for each frame in gd_js_yield_frame (gd_web.js). If the clock is
  // stopped while the engine is running, it spins in that wait and starves the page.
  // So freezing parks the engine inside that wait until it's unfrozen or stepped.
  // gd_web.js is added to the page as an inline <script>, so rewrite it as it's inserted
  // (an inline script runs when it's inserted, so this is the last moment to change it).
  const YIELD_MARK = "function __asyncjs__gd_js_yield_frame(target_ms){return Asyncify.handleAsync(async()=>{";
  const YIELD_HOOK = "var __dmP=window.__dmYield&&window.__dmYield(target_ms);if(__dmP)await __dmP;";
  const gate = { hooked: false, waiters: [], yields: 0, lastTarget: 0 };
  const insertFns = { appendChild: Node.prototype.appendChild, insertBefore: Node.prototype.insertBefore };
  // Second hook: once the engine's files are mounted but before the game starts, give mods
  // (the texture pack) a chance to change files. The engine waits for window.__dmBeforeStart.
  const START_MARK = 'initRuntime();Module["onRuntimeInitialized"]?.();';
  const START_HOOK = 'initRuntime();try{if(window.__dmBeforeStart)await window.__dmBeforeStart(FS)}catch(e){console.error("[DashMods] before start",e)}Module["onRuntimeInitialized"]?.();';
  function patchScript(node) {
    if (gate.hooked || !node || node.nodeName !== "SCRIPT" || node.src) return;
    let text = node.text;
    if (text && text.indexOf(YIELD_MARK) >= 0) {
      text = text.replace(YIELD_MARK, YIELD_MARK + YIELD_HOOK);
      if (text.indexOf(START_MARK) >= 0) { text = text.replace(START_MARK, START_HOOK); gate.startHooked = true; }
      node.text = text;
      gate.hooked = true;
      Node.prototype.appendChild = insertFns.appendChild; // done; restore
      Node.prototype.insertBefore = insertFns.insertBefore;
    }
  }
  Node.prototype.appendChild = function (node) {
    patchScript(node);
    return insertFns.appendChild.call(this, node);
  };
  Node.prototype.insertBefore = function (node, ref) {
    patchScript(node);
    return insertFns.insertBefore.call(this, node, ref);
  };
  // The clock is stopped only once the engine is parked here: it also reads the clock
  // in the middle of a frame, and stopping it there would leave it waiting forever.
  window.__dmYield = function (target) {
    gate.yields++;
    gate.lastTarget = target;
    if (!clock.holds.size) return null;
    if (!clock.parked) { rebaseClock(); clock.parked = true; applyAudio(); }
    return new Promise((res) => gate.waiters.push(res));
  };
  function releaseGate() {
    if (clock.parked) { rebaseClock(); clock.parked = false; applyAudio(); }
    const w = gate.waiters;
    gate.waiters = [];
    for (const f of w) f();
  }

  // Time + audio together.
  function setSpeed(s) {
    rebaseClock();
    clock.speed = Math.max(0.05, Math.min(10, s));
    applyAudio();
  }
  function hold(reason, on) {
    // Without the frame gate, stopping the game would hang the page, so refuse.
    if (on && !gate.hooked) return false;
    if (on) clock.holds.add(reason); else clock.holds.delete(reason);
    if (!clock.holds.size) releaseGate();
    return true;
  }
  function stepFrame(ms) {
    // Move game time forward one step, then let one engine frame run (it parks again
    // at its next frame wait because the hold is still on).
    if (!clock.holds.size || !clock.parked) return;
    clock.baseVirt += ms;
    releaseGate();
  }

  // ------------------------------------------------------------------ hotkeys
  const hotkeys = []; // { id, code: () => string, run: () => void }
  let capturingKey = null; // set while a keybind setting is listening
  const isMenuEvent = (e) => e.target && e.target.closest && e.target.closest("#dm-root");

  window.addEventListener("keydown", (e) => {
    if (capturingKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      capturingKey(e);
      return;
    }
    if (isMenuEvent(e) || ui.isOpen()) {
      // While the menu is open, keys must not reach the game.
      e.stopImmediatePropagation();
      if (e.code === "Escape") { e.preventDefault(); ui.closeTop(); return; }
      const typing = e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (!typing && !e.repeat && e.code === menuMod.get("openKey")) { e.preventDefault(); ui.closeAll(); }
      return;
    }
    if (e.repeat) {
      if (hotkeys.some((h) => h.code() === e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    for (const h of hotkeys) {
      if (h.code() && h.code() === e.code) {
        e.preventDefault(); e.stopImmediatePropagation();
        h.run();
        return;
      }
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (isMenuEvent(e) || ui.isOpen() || hotkeys.some((h) => h.code() && h.code() === e.code)) {
      e.stopImmediatePropagation();
    }
  }, true);

  const KEY_NAMES = {
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "Space",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  };
  function keyLabel(code) {
    if (!code) return "None";
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  }

  // ------------------------------------------------------------------ mod registry
  const mods = [];
  function defineMod(def) {
    const mod = Object.assign({ settings: [], tags: [], hotkeys: [] }, def);
    if (!(mod.id in store.enabled)) store.enabled[mod.id] = !!mod.defaultEnabled;
    store.settings[mod.id] = store.settings[mod.id] || {};
    mod.get = (k) => {
      const v = store.settings[mod.id][k];
      if (v !== undefined) return v;
      const s = mod.settings.find((x) => x.key === k);
      return s ? s.default : undefined;
    };
    mod.set = (k, v) => {
      store.settings[mod.id][k] = v;
      persist();
      if (mod.enabled() && mod.onSetting) mod.onSetting(k, v);
    };
    mod.enabled = () => !!store.enabled[mod.id];
    mod.setEnabled = (on) => {
      if (mod.locked) return;
      store.enabled[mod.id] = !!on;
      persistNow();
      try { on ? mod.onEnable && mod.onEnable() : mod.onDisable && mod.onDisable(); } catch (e) { console.error(e); }
    };
    for (const hk of mod.hotkeys) {
      // hk.when (optional): only take the key while this returns true; otherwise it goes to the game
      hotkeys.push({ code: () => (mod.enabled() && (!hk.when || hk.when()) ? mod.get(hk.setting) : ""), run: hk.run });
    }
    mods.push(mod);
    return mod;
  }

  // ------------------------------------------------------------------ overlay helpers
  const hud = { el: null, slots: {} };
  function hudSlot(id, pos) {
    if (!hud.el) return null;
    let el = hud.slots[id];
    if (!el) {
      el = document.createElement("div");
      el.className = "dm-hud";
      hud.el.appendChild(el);
      hud.slots[id] = el;
    }
    el.dataset.pos = pos || "top-left";
    return el;
  }
  function removeHud(id) {
    const el = hud.slots[id];
    if (el) { el.remove(); delete hud.slots[id]; }
  }
  let toastTimer = 0;
  function toast(text) {
    const el = document.getElementById("dm-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1200);
  }

  // ------------------------------------------------------------------ mods
  const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];

  const menuMod = defineMod({
    id: "dashmods.menu",
    name: "DashMods",
    version: "1.0.0",
    author: "gd-web",
    icon: "◆",
    color: "#6c4cf5",
    locked: true,
    defaultEnabled: true,
    tags: ["interface"],
    short: "The mod menu itself.",
    desc: "Lists every mod, lets you turn them on and off, and holds their settings. Everything is saved in this browser.",
    settings: [
      { key: "openKey", type: "key", label: "Open menu key", default: "Tab" },
      { key: "showButton", type: "bool", label: "Show menu button", default: true,
        help: "You can still open the menu with the key when it's hidden." },
      { key: "buttonPos", type: "select", label: "Menu button position", default: "right",
        options: [["right", "Right edge tab"], ["bottom-left", "Bottom-left corner"]] },
      { key: "freezeWhileOpen", type: "bool", label: "Pause game while menu is open", default: true },
    ],
    hotkeys: [{ setting: "openKey", run: () => ui.toggle() }],
    onSetting(k) {
      // k is undefined after "Reset to defaults"
      if (!k || k === "showButton" || k === "buttonPos") ui.refreshButton();
      if ((!k || k === "freezeWhileOpen") && ui.isOpen()) hold("menu", !!menuMod.get("freezeWhileOpen"));
    },
  });

  const speedMod = defineMod({
    id: "dashmods.speedhack",
    name: "Speedhack",
    version: "1.0.0",
    author: "gd-web",
    icon: "»",
    color: "#2fb4ff",
    tags: ["gameplay", "practice"],
    short: "Slow the game down (or speed it up) to practice hard parts.",
    desc: "Changes how fast the whole game runs. Music follows the same speed by default, so it stays in sync. Use the hotkeys to change speed while playing.",
    settings: [
      { key: "speed", type: "range", label: "Speed", default: 0.75, min: 0.1, max: 2, step: 0.05, unit: "×" },
      { key: "audio", type: "bool", label: "Music follows speed", default: true },
      { key: "keyDown", type: "key", label: "Slower key", default: "BracketLeft" },
      { key: "keyUp", type: "key", label: "Faster key", default: "BracketRight" },
      { key: "keyReset", type: "key", label: "Toggle 1× key", default: "Backslash" },
      { key: "showHud", type: "bool", label: "Show speed on screen", default: true },
    ],
    hotkeys: [
      { setting: "keyDown", run: () => speedMod.nudge(-0.05) },
      { setting: "keyUp", run: () => speedMod.nudge(0.05) },
      { setting: "keyReset", run: () => speedMod.toggleNormal() },
    ],
    bypass: false,
    nudge(d) {
      const v = Math.round(Math.max(0.1, Math.min(2, this.get("speed") + d)) * 100) / 100;
      this.bypass = false;
      this.set("speed", v);
      toast("Speed " + v.toFixed(2) + "×");
    },
    toggleNormal() {
      this.bypass = !this.bypass;
      this.apply();
      toast(this.bypass ? "Speed 1× (normal)" : "Speed " + this.get("speed").toFixed(2) + "×");
    },
    apply() {
      audio.follow = !!this.get("audio");
      setSpeed(this.enabled() && !this.bypass ? this.get("speed") : 1);
      if (this.enabled() && this.get("showHud")) {
        const el = hudSlot("speed", "top-center");
        if (el) el.textContent = (this.bypass ? 1 : this.get("speed")).toFixed(2) + "×";
      } else {
        removeHud("speed");
      }
    },
    onEnable() { this.apply(); },
    onDisable() { this.apply(); },
    onSetting() { this.apply(); },
  });

  const stepMod = defineMod({
    id: "dashmods.frame-stepper",
    name: "Frame Stepper",
    version: "1.0.0",
    author: "gd-web",
    icon: "❚❚",
    color: "#ff9f1c",
    tags: ["gameplay", "practice"],
    short: "Freeze the game and move it forward one frame at a time.",
    desc: "Press the freeze key to stop time, then the step key to advance a single frame. Great for studying exactly where a jump has to happen. Music pauses while frozen.",
    settings: [
      { key: "keyFreeze", type: "key", label: "Freeze / unfreeze key", default: "KeyF" },
      { key: "keyStep", type: "key", label: "Step one frame key", default: "KeyG" },
      { key: "stepFps", type: "select", label: "Frame size", default: "60",
        options: [["60", "1/60 s"], ["120", "1/120 s"], ["240", "1/240 s (physics tick)"]] },
    ],
    hotkeys: [
      { setting: "keyFreeze", run: () => stepMod.toggle() },
      { setting: "keyStep", run: () => stepMod.step() },
    ],
    frozen: false,
    toggle() {
      if (!this.frozen && hold("step", true) === false) return toast("Freeze isn't available");
      if (this.frozen) hold("step", false);
      this.frozen = !this.frozen;
      this.draw();
      toast(this.frozen ? "Frozen" : "Unfrozen");
    },
    step() {
      if (!this.frozen) {
        if (hold("step", true) === false) return toast("Freeze isn't available");
        this.frozen = true;
        this.draw();
      }
      stepFrame(1000 / Number(this.get("stepFps")));
    },
    draw() {
      if (this.enabled() && this.frozen) hudSlot("frozen", "top-center-2").textContent = "❚❚ FROZEN";
      else removeHud("frozen");
    },
    onDisable() { this.frozen = false; hold("step", false); this.draw(); },
  });

  const fpsMod = defineMod({
    id: "dashmods.fps-counter",
    name: "FPS Counter",
    version: "1.0.0",
    author: "gd-web",
    icon: "60",
    color: "#2ecc71",
    tags: ["interface"],
    short: "Shows how many frames per second the game is running at.",
    desc: "Displays the game's real frame rate in a corner of the screen.",
    settings: [
      { key: "pos", type: "select", label: "Position", default: "bottom-right",
        options: POSITIONS.map((p) => [p, p.replace("-", " ")]) },
    ],
    timer: 0,
    start() {
      this.stop();
      const M = () => window.Module;
      let lastFrames = null, lastT = realNow(), rafCount = 0, run = true;
      const raf = () => { rafCount++; if (run) requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      this.timer = setInterval(() => {
        const el = hudSlot("fps", this.get("pos"));
        const t = realNow(), dt = (t - lastT) / 1000;
        let fps = rafCount / dt;
        try {
          if (M() && M()._gd_frames_get) {
            const f = M()._gd_frames_get();
            if (lastFrames !== null && f >= lastFrames) fps = (f - lastFrames) / dt;
            lastFrames = f;
          }
        } catch (e) {}
        lastT = t; rafCount = 0;
        if (el) el.textContent = Math.round(fps) + " FPS";
      }, 500);
      this.stopRaf = () => { run = false; };
    },
    stop() { clearInterval(this.timer); if (this.stopRaf) this.stopRaf(); removeHud("fps"); },
    onEnable() { this.start(); },
    onDisable() { this.stop(); },
    onSetting() { this.start(); },
  });

  // ------------------------------------------------------------------ startpos switcher
  // How it works:
  //  1. Every downloaded level passes through fetch (downloadGJLevel22). If it has start
  //     positions (object 31), all but the selected one get the "Disable" flag (kA21), the
  //     level data is padded to a fixed length, and the download checksum is recomputed.
  //  2. Switching rewrites every copy of that level data in the game's memory with the
  //     version for the new selection (same length, so it can be overwritten in place).
  //  3. The game only reads level data when a level starts, so the mod then pauses, exits
  //     to the level page and presses Play, by queueing the same mouse/key messages the
  //     page sends for real input.
  const LV = {
    toBytes(s) {
      s = s.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
      s += "=".repeat((4 - (s.length % 4)) % 4);
      return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    },
    toB64(b) {
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_");
    },
    async inflate(bytes) {
      // Tolerates the zero padding after the gzip data.
      const ds = new DecompressionStream("gzip");
      const w = ds.writable.getWriter();
      w.write(bytes).catch(() => {}); w.close().catch(() => {});
      const r = ds.readable.getReader(), parts = [];
      try { for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); } } catch (e) {}
      let n = 0; for (const p of parts) n += p.length;
      const out = new Uint8Array(n); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
    async decode(ls) { return new TextDecoder().decode(await LV.inflate(LV.toBytes(ls))); },
    async encode(txt) {
      const s = new Blob([new TextEncoder().encode(txt)]).stream().pipeThrough(new CompressionStream("gzip"));
      return LV.toB64(new Uint8Array(await new Response(s).arrayBuffer()));
    },
    async sha1(s) {
      const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
      return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
    },
    hash(L) { // downloadGJLevel22 checksum
      if (L.length < 41) return LV.sha1(L + "xI25fpAapCQg");
      const m = Math.floor(L.length / 40); let h = "";
      for (let i = 0; i < 40; i++) h += L[i * m];
      return LV.sha1(h + "xI25fpAapCQg");
    },
    isStartPos: (o) => /^1,31(,|$)/.test(o),
    prop(o, key) {
      const f = o.split(",");
      for (let i = 0; i < f.length - 1; i += 2) if (f[i] === key) return f[i + 1];
      return null;
    },
    setDisabled(o, dis) {
      const f = o.split(",");
      for (let i = 0; i < f.length - 1; i += 2) if (f[i] === "kA21") { f[i + 1] = dis ? "1" : "0"; return f.join(","); }
      return o + ",kA21," + (dis ? "1" : "0");
    },
    // Start positions in level order (by x): [{ i: object index, x }]
    startPositions(txt) {
      const objs = txt.split(";"), list = [];
      for (let i = 1; i < objs.length; i++) if (LV.isStartPos(objs[i])) list.push({ i, x: Number(LV.prop(objs[i], "2")) || 0 });
      return list.sort((a, b) => a.x - b.x);
    },
    // sel 0 = level start (all disabled), sel k = k-th start position enabled
    variant(txt, list, sel) {
      const objs = txt.split(";");
      list.forEach((p, k) => { objs[p.i] = LV.setDisabled(objs[p.i], k + 1 !== sel); });
      return objs.join(";");
    },
  };

  const DB = {
    open() {
      if (!this.p) this.p = new Promise((res, rej) => {
        const q = indexedDB.open("dashmods", 3);
        q.onupgradeneeded = () => {
          for (const name of ["levels", "backups", "textures"]) if (!q.result.objectStoreNames.contains(name)) q.result.createObjectStore(name);
        };
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      return this.p;
    },
    async get(k, st = "levels") { const db = await this.open(); return new Promise((res) => { const r = db.transaction(st).objectStore(st).get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
    async put(k, v, st = "levels") { const db = await this.open(); return new Promise((res) => { const t = db.transaction(st, "readwrite"); t.objectStore(st).put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); },
    async all() { const db = await this.open(); return new Promise((res) => { const r = db.transaction("levels").objectStore("levels").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }); },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MENU_SOUNDS = /^(menuLoop|playSound|quitSound|explode|achievement|endStart|highscoreGet|reward|counter|chest|door|unlock|gold|secret|magicExplosion|grunt|quit|crystal)/i;

  const spMod = defineMod({
    id: "dashmods.startpos-switcher",
    name: "Startpos Switcher",
    version: "1.0.0",
    author: "gd-web",
    icon: "⚑",
    color: "#14b8a6",
    tags: ["gameplay", "practice"],
    short: "Use Q and E to jump between a level's start positions.",
    desc: "For online levels that contain start positions (many practice copies do). In a level, press Q / E to go to the previous / next start position; the level restarts from there. Position 0 is the normal level start. Quick presses add up, so pressing E three times jumps three positions with one restart. Your choice is remembered per level. Progress doesn't count when you start from a start position, just like in the real game. Note: turn this on before opening a level's page, since the level is prepared while it downloads.",
    settings: [
      { key: "keyPrev", type: "key", label: "Previous start position key", default: "KeyQ" },
      { key: "keyNext", type: "key", label: "Next start position key", default: "KeyE" },
      { key: "autoRestart", type: "bool", label: "Restart automatically after switching", default: true,
        help: "Off: switching only takes effect the next time you exit and press Play." },
      { key: "showHud", type: "bool", label: "Show start position on screen", default: true },
    ],
    hotkeys: [
      { setting: "keyPrev", when: () => spMod.canSwitch(), run: () => spMod.nudge(-1) },
      { setting: "keyNext", when: () => spMod.canSwitch(), run: () => spMod.nudge(1) },
    ],
    levels: new Map(),   // id -> level record (this session)
    active: null,        // level record the player is in
    inLevel: false,
    currentSong: "",
    pendingSel: null,
    busy: false,
    timer: 0,

    // ---- level records
    async record(id, name, song, txt, sel, padTo) {
      const list = LV.startPositions(txt);
      const lv = { id, name, song, txt, list, n: list.length, sel: Math.min(sel || 0, list.length), padTo, variants: new Map() };
      this.levels.set(id, lv);
      return lv;
    },
    async variantStr(lv, sel) {
      if (lv.variants.has(sel)) return lv.variants.get(sel);
      let s = await LV.encode(LV.variant(lv.txt, lv.list, sel));
      if (s.length > lv.padTo) return null;
      s += "A".repeat(lv.padTo - s.length);
      lv.variants.set(sel, s);
      return s;
    },
    persist(lv) {
      DB.put(String(lv.id), { id: lv.id, name: lv.name, song: lv.song, txt: lv.txt, sel: lv.sel, padTo: lv.padTo, t: Date.now() });
    },

    // ---- download rewrite (called from the fetch wrapper)
    async rewrite(text) {
      const cut = text.indexOf("#");
      const main = cut >= 0 ? text.slice(0, cut) : text;
      const hashes = cut >= 0 ? text.slice(cut + 1).split("#") : [];
      const parts = main.split(":");
      if (parts.length < 4) return text;
      const d = {};
      for (let i = 0; i + 1 < parts.length; i += 2) d[parts[i]] = parts[i + 1];
      if (!d["1"] || !d["4"]) return text;
      const txt = await LV.decode(d["4"]);
      if (!txt || !LV.startPositions(txt).length) return text;
      const id = d["1"];
      const saved = await DB.get(String(id)).catch(() => null);
      const sel = saved && saved.txt === txt ? saved.sel : 0;
      const base = await LV.encode(txt);
      const padTo = base.length + 512 + Math.ceil(base.length * 0.02);
      const lv = await this.record(id, d["2"] || "", saved && saved.txt === txt ? saved.song : "", txt, sel, padTo);
      const ls = await this.variantStr(lv, lv.sel);
      if (!ls) return text;
      let out = "";
      for (let i = 0; i + 1 < parts.length; i += 2) out += (i ? ":" : "") + parts[i] + ":" + (parts[i] === "4" ? ls : parts[i + 1]);
      if (hashes.length) hashes[0] = await LV.hash(ls);
      lv.fresh = !lv.song;
      this.active = lv;
      this.persist(lv);
      console.log(`[DashMods] startpos: level ${id} has ${lv.n} start positions; using ${lv.sel}`);
      return [out].concat(hashes).join("#");
    },

    // ---- memory
    matcher(lv, strings) {
      let pre = strings[0];
      for (const s of strings) { let k = 0; while (k < pre.length && k < s.length && pre[k] === s[k]) k++; pre = pre.slice(0, k); }
      pre = pre.slice(0, 64);
      if (pre.length < 8) pre = strings[0].slice(0, 8);
      const KEY = Math.min(96, lv.padTo);
      const byKey = new Map();
      for (const s of strings) { const k = s.slice(0, KEY); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); }
      const dec = new TextDecoder("latin1");
      // which of our versions is stored at address p (or null)
      const at = (H, p) => {
        if (p < 0 || p + lv.padTo > H.length) return null;
        const cands = byKey.get(dec.decode(H.subarray(p, p + KEY)));
        if (!cands) return null;
        for (const s of cands) {
          let ok = true;
          for (let k = KEY; k < s.length; k++) if (H[p + k] !== s.charCodeAt(k)) { ok = false; break; }
          if (ok) return s;
        }
        return null;
      };
      return { pre, KEY, at, dec };
    },
    // Scan memory a slice at a time while the game is idle, so it doesn't cause lag.
    async scanInBackground(lv) {
      if (lv.scanning) return lv.scanning;
      const gen = (lv.gen = (lv.gen || 0) + 1);
      lv.scanning = (async () => {
        const strings = await this.allVariants(lv);
        const H0 = window.HEAPU8;
        if (!H0 || !strings.length) return;
        const m = this.matcher(lv, strings), SL = 4 << 20, found = [];
        const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 500 }) : setTimeout(r, 16)));
        for (let off = 0; off < H0.length; ) {
          const dl = await idle();
          do {
            const H = window.HEAPU8;
            const chunk = m.dec.decode(H.subarray(off, Math.min(H.length, off + SL)));
            for (let i = chunk.indexOf(m.pre); i >= 0; i = chunk.indexOf(m.pre, i + 1)) {
              const p = off + i;
              if (found.includes(p)) continue;
              if (m.at(H, p)) found.push(p);
            }
            off += SL - m.KEY;
          } while (off < H0.length && dl && dl.timeRemaining && dl.timeRemaining() > 6);
        }
        if (lv.gen === gen) lv.cache = found;
      })().finally(() => { lv.scanning = null; });
      return lv.scanning;
    },
    findCopies(lv, strings) {
      // One pass over the game's memory: find the shared start of our versions of this
      // level, then check which version (if any) is stored at each hit.
      const H = window.HEAPU8;
      if (!H || !strings.length) return [];
      let pre = strings[0];
      for (const s of strings) { let k = 0; while (k < pre.length && k < s.length && pre[k] === s[k]) k++; pre = pre.slice(0, k); }
      pre = pre.slice(0, 64);
      if (pre.length < 8) pre = strings[0].slice(0, 8);
      const KEY = Math.min(96, lv.padTo);
      const byKey = new Map();
      for (const s of strings) { const k = s.slice(0, KEY); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); }
      const dec = new TextDecoder("latin1"), CH = 32 << 20, hits = [];
      for (let off = 0; off < H.length; off += CH - KEY) {
        const chunk = dec.decode(H.subarray(off, Math.min(H.length, off + CH)));
        for (let i = chunk.indexOf(pre); i >= 0; i = chunk.indexOf(pre, i + 1)) {
          const p = off + i;
          if (hits.length && hits[hits.length - 1].p === p) continue;
          if (p + lv.padTo > H.length) continue;
          const head = dec.decode(H.subarray(p, p + KEY));
          const cands = byKey.get(head);
          if (!cands) continue;
          for (const s of cands) {
            let ok = true;
            for (let k = KEY; k < s.length; k++) if (H[p + k] !== s.charCodeAt(k)) { ok = false; break; }
            if (ok) { hits.push({ p, s }); break; }
          }
        }
      }
      return hits;
    },
    async allVariants(lv) {
      const out = [];
      for (let k = 0; k <= lv.n; k++) { const s = await this.variantStr(lv, k); if (s) out.push(s); }
      return out;
    },
    async writeSel(lv, sel) {
      const target = await this.variantStr(lv, sel);
      if (!target) return 0;
      const strings = await this.allVariants(lv);
      const H = window.HEAPU8;
      // Fast path: addresses found by an earlier scan (still holding one of our versions).
      let addrs = [];
      if (lv.cache && lv.cache.length) {
        const m = this.matcher(lv, strings);
        addrs = lv.cache.filter((p) => m.at(H, p));
      }
      if (!addrs.length) addrs = this.findCopies(lv, strings).map((h) => h.p);
      for (const p of addrs) for (let k = 0; k < target.length; k++) H[p + k] = target.charCodeAt(k);
      lv.gen = (lv.gen || 0) + 1;   // a background search still running is now out of date
      lv.cache = addrs;
      return addrs.length;
    },

    // ---- which level is being played
    onSound(name) {
      if (/^playSound/i.test(name)) {
        this.inLevel = true; this.lastPlay = realNow();
        if (this.fast) this.endFast();
        // Find the level data in memory now (in idle time) so the first switch is quick.
        const lv = this.active;
        if (this.enabled() && lv && !(lv.cache && lv.cache.length)) setTimeout(() => { if (this.matches(lv)) this.scanInBackground(lv); }, 1500);
      }
      else if (/^quitSound/i.test(name)) this.inLevel = false;
      this.draw();
    },
    // The level's song: the newest live audio channel that isn't a menu sound or effect.
    songNow() {
      const A = gdAudio();
      if (!A) return { name: "", ch: null };
      let best = null, bestId = -1;
      for (const id in A.channels) {
        const c = A.channels[id], s = c && A.sounds[c.sound];
        if (!s || c.ended || !s.name || (s.len || 0) < 15000) continue;
        const name = String(s.name).split(/[\\/]/).pop();
        if (MENU_SOUNDS.test(name)) continue;
        if (Number(id) > bestId) { bestId = Number(id); best = { name, ch: c }; }
      }
      return best || { name: "", ch: null };
    },
    curSong() { return this.inLevel ? this.songNow().name : ""; },
    matches(lv) {
      if (!lv || !this.inLevel) return false;
      const song = this.curSong();
      if (lv.song && song) return lv.song === song;
      if (!lv.song && song && lv.fresh) { lv.song = song; this.knownSongs.add(song); this.persist(lv); }
      return true;
    },
    canSwitch() {
      if (!this.inLevel || ui.isOpen()) return false;
      if (this.active && this.matches(this.active)) return true;
      // Level loaded from an earlier session's save: allowed if we know a level with this song.
      return !!this.curSong() && this.knownSongs.has(this.curSong());
    },
    knownSongs: new Set(),
    async findActiveFromStorage() {
      const all = (await DB.all()).filter((r) => r.song === this.curSong()).sort((a, b) => b.t - a.t).slice(0, 4);
      for (const r of all) {
        const lv = this.levels.get(r.id) || await this.record(r.id, r.name, r.song, r.txt, r.sel, r.padTo);
        const hits = this.findCopies(lv, await this.allVariants(lv));
        if (hits.length) {
          const s = hits[0].s;
          for (const [k, v] of lv.variants) if (v === s) lv.sel = k;
          this.active = lv;
          return lv;
        }
      }
      return null;
    },

    // ---- switching
    nudge(d) {
      const lv = this.active && this.matches(this.active) ? this.active : null;
      const n = lv ? lv.n : 0;
      const base = this.pendingSel != null ? this.pendingSel : lv ? lv.sel : 0;
      this.pendingSel = lv ? ((base + d) % (n + 1) + n + 1) % (n + 1) : d;
      this.pendingDelta = (this.pendingDelta || 0) + d;
      this.draw();
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.apply(), 200);
    },
    async apply() {
      if (this.busy) { this.timer = setTimeout(() => this.apply(), 200); return; }
      this.busy = true;
      try {
        let lv = this.active && this.matches(this.active) ? this.active : null;
        if (!lv) {
          toast("Finding this level…");
          await sleep(30);
          lv = await this.findActiveFromStorage();
          if (!lv) { toast("No start positions known for this level"); return; }
          const n = lv.n;
          this.pendingSel = ((lv.sel + (this.pendingDelta || 0)) % (n + 1) + n + 1) % (n + 1);
        }
        const sel = this.pendingSel;
        if (sel == null || sel === lv.sel) return;
        if (clock.holds.size) { toast("Unfreeze the game first"); return; }
        toast("Switching to " + this.label(lv, sel) + "…");
        await sleep(30); // let the toast paint; the memory search blocks for a moment
        const n = await this.writeSel(lv, sel);
        if (!n) { toast("Couldn't find this level in memory. Re-open its page and try again"); return; }
        lv.sel = sel;
        this.persist(lv);
        if (this.get("autoRestart")) await this.restart();
        else toast(this.label(lv, sel) + " – exit and press Play to use it");
      } catch (e) {
        console.error("[DashMods] startpos", e);
        toast("Start position switch failed");
      } finally {
        this.pendingSel = null; this.pendingDelta = 0; this.busy = false; this.draw();
      }
    },
    // The pause menu pauses the music's audio group. (Other groups can stay flagged as paused
    // after a restart, and dying only pauses the song's own channel, so check just that one.)
    pauseMenuOpen() {
      const A = gdAudio();
      if (!A || !A.groups) return false;
      const { ch } = this.songNow();
      const g = A.groups[ch && ch.group != null ? ch.group : 1];
      return !!(g && g.paused);
    },
    // During a switch, run the game clock fast (menu fades run on game time) and cover the
    // screen, then put everything back as soon as the level starts again.
    startFast(text) {
      this.fast = { speed: clock.speed, follow: audio.follow };
      audio.follow = false;
      setSpeed(Math.min(10, Math.max(1, clock.speed) * 6));
      let ov = document.getElementById("dm-switch");
      if (!ov) {
        ov = document.createElement("div");
        ov.id = "dm-switch";
        ov.className = "dm-out";
        ui.root.appendChild(ov);
      }
      ov.textContent = "⚑ " + text;
      ov.classList.add("show");
    },
    endFast() {
      const f = this.fast;
      if (!f) return;
      this.fast = null;
      audio.follow = f.follow;
      setSpeed(f.speed);
      const ov = document.getElementById("dm-switch");
      if (ov) setTimeout(() => { if (!this.fast) ov.classList.remove("show"); }, 120);
    },
    async restart() {
      const M = window.Module;
      this.startFast(this.label(this.active, this.active.sel));
      try { await this.restartSteps(M); } finally { setTimeout(() => this.endFast(), 400); }
    },
    async restartSteps(M) {
      const t0 = realNow(), tl = (this.timeline = []);
      const mark = (what) => tl.push([what, Math.round(realNow() - t0)]);
      const slow = 1 / Math.max(0.1, clock.speed); // menu transitions run on game time
      const click = async (fx, fy) => {
        const x = Math.round(fx * 1919), y = Math.round(fy * 1079), lp = (x & 0xffff) | (y << 16);
        M.gdCursorPos = [x, y];
        M.gdInputQueue.push([0x200, 0, lp]); await sleep(50);
        M.gdInputQueue.push([0x201, 1, lp]); await sleep(80);
        M.gdInputQueue.push([0x202, 0, lp]);
      };
      const esc = async () => {
        M.gdInputQueue.push([0x100, 27, 0x00010001]); await sleep(80);
        M.gdInputQueue.push([0x101, 27, 0xc0010001 | 0]);
      };
      const until = async (cond, ms) => { const end = realNow() + ms; while (!cond() && realNow() < end) await sleep(40); return cond(); };
      // Esc pauses; Esc again in the pause menu exits to the level page. Each step waits for
      // the game to actually get there, since menu animations take longer on slow machines.
      if (!this.pauseMenuOpen()) {
        await esc();
        await until(() => this.pauseMenuOpen(), 3000);
        mark("paused:" + this.pauseMenuOpen());
        await sleep(300);   // real time: right after a level starts the pause menu needs a moment before Esc works
      }
      // If the game wasn't actually paused, the first Esc only pauses it; a short first wait
      // keeps that case quick before the second Esc.
      for (let tries = 0; tries < 3 && this.inLevel; tries++) {
        await esc();
        await until(() => !this.inLevel, tries === 0 ? 1500 : 4000);
        mark("exit try " + tries + ": left=" + !this.inLevel);
      }
      if (this.inLevel) { toast("Couldn't restart automatically – exit and press Play"); return; }
      await sleep(Math.max(900 * slow, 400));     // level page fades in
      const before = this.lastPlay || 0;
      // Play; if the click lands before the page is ready, click again (still on the level page).
      for (let tries = 0; tries < 3 && (this.lastPlay || 0) === before; tries++) {
        await click(0.5, 0.342);
        await until(() => (this.lastPlay || 0) !== before, tries < 2 ? 1500 : 4000);
      }
      mark("replayed:" + ((this.lastPlay || 0) !== before));
      if ((this.lastPlay || 0) === before) toast("Couldn't restart automatically – exit and press Play");
    },

    // ---- display
    label(lv, sel) { return sel === 0 ? "Level start" : `Start pos ${sel}/${lv.n}`; },
    draw() {
      const lv = this.active;
      const show = this.enabled() && this.get("showHud") && lv && this.matches(lv);
      if (!show) return removeHud("startpos");
      const sel = this.pendingSel != null ? this.pendingSel : lv.sel;
      const el = hudSlot("startpos", "bottom-center");
      if (el) el.textContent = "⚑ " + this.label(lv, sel) + (this.pendingSel != null ? " …" : "") + "   Q ◀ ▶ E";
    },
    onEnable() { this.draw(); },
    onDisable() { removeHud("startpos"); },
    onSetting() { this.draw(); },
  });
  audio.onStart.push((name) => spMod.onSound(name));
  DB.all().then((rs) => rs.forEach((r) => r.song && spMod.knownSongs.add(r.song))).catch(() => {});

  // While a backup is being restored, nothing may write the game's save store, or the game
  // (still running with the old progress) could overwrite it before the page reloads.
  const saveBlock = { on: false };
  {
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      if (saveBlock.on && this.name === "files" && this.transaction && this.transaction.db && this.transaction.db.name === "gdwasm_saves" && !saveBlock.allow) {
        return this.get("__dashmods_ignored__");   // a harmless request, so the caller's handlers still run
      }
      return origPut.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------------ smooth autosave
  // The page asks the game to save every 10 seconds. Geometry Dash encodes and compresses
  // its whole save file (including every downloaded level) to do that, which freezes a
  // frame or more, so while you're playing a level the save waits until you pause, leave
  // the level, switch tabs, or 3 minutes have passed.
  const saveMod = defineMod({
    id: "dashmods.smooth-autosave",
    name: "Smooth Autosave",
    version: "1.0.0",
    author: "gd-web",
    icon: "💾",
    color: "#64748b",
    tags: ["performance"],
    defaultEnabled: true,
    short: "Stops the 10-second autosave from causing lag spikes while you play.",
    desc: "The game saves every 10 seconds, and with big levels downloaded each save can freeze the game for a moment. With this on, saving waits while you're playing a level and happens as soon as you pause, leave the level, switch tabs or close the page (or after 3 minutes at most).",
    settings: [],
    pending: false,
    lastSave: 0,
    allowedNow() {
      return document.visibilityState === "hidden" || !spMod.inLevel || spMod.pauseMenuOpen() || realNow() - this.lastSave > 180000;
    },
  });
  (function hookSave() {
    // The engine replaces its exported functions during start-up, so wait until the game
    // has started, and re-apply the hook if it's ever replaced again.
    const M = window.Module;
    if (!M || !window.__gdGameStarted || typeof M._gd_request_save !== "function") return setTimeout(hookSave, 500);
    let orig = null;
    const wrapper = function () {
      if (saveBlock.on) return;
      if (saveMod.enabled() && !saveMod.allowedNow()) { saveMod.pending = true; return; }
      saveMod.pending = false;
      saveMod.lastSave = realNow();
      return orig.apply(this, arguments);
    };
    const install = () => { if (M._gd_request_save !== wrapper) { orig = M._gd_request_save; M._gd_request_save = wrapper; } };
    install();
    saveMod.lastSave = realNow();
    setInterval(() => {
      install();
      if (saveMod.pending && (!saveMod.enabled() || saveMod.allowedNow())) M._gd_request_save();
    }, 500);
    document.addEventListener("visibilitychange", () => { if (saveMod.pending && document.visibilityState === "hidden") M._gd_request_save(); });
  })();

  // ------------------------------------------------------------------ fast loading
  const fastMod = defineMod({
    id: "dashmods.fast-loading",
    name: "Fast Loading",
    version: "1.0.0",
    author: "gd-web",
    icon: "⚡",
    color: "#f59e0b",
    tags: ["performance"],
    defaultEnabled: true,
    short: "Keeps the game's files in your browser so it starts much faster next time.",
    desc: "The game downloads about 366 MB of files every time you open it, because the place they're hosted only lets browsers keep them for 5 minutes. With this on, they're stored in your browser after the first full load, so later visits start from your own disk. Turn it off (or use Clear) to free the space.",
    settings: [
      { key: "size", type: "action", label: "Space used by cached game files", button: "Check", run: async () => toast("Cached game files: " + (await fastMod.cachedMB()) + " MB") },
      { key: "clear", type: "action", label: "Delete cached game files", button: "Clear", run: async () => { await fastMod.clear(); toast("Cached game files deleted"); } },
    ],
    async cachedMB() {
      if (!window.caches) return 0;
      const c = await caches.open("gd-files-v1");
      let total = 0;
      for (const req of await c.keys()) { const r = await c.match(req); total += Number(r.headers.get("content-length")) || 0; }
      return Math.round(total / 1048576);
    },
    async clear() { if (window.caches) await caches.delete("gd-files-v1"); },
    async onEnable() {
      if (!("serviceWorker" in navigator)) return;
      // The page has a <base> pointing at GitHub, so give the full address of the worker.
      try { await navigator.serviceWorker.register(location.origin + "/sw.js", { scope: location.origin + "/" }); }
      catch (e) { console.warn("[DashMods] service worker not registered:", e.message); }
    },
    async onDisable() {
      if ("serviceWorker" in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      await this.clear();
    },
  });

  // ------------------------------------------------------------------ save backup
  const SAVE_DB = "gdwasm_saves";
  function saveStore(mode, fn) {
    return new Promise((resolve, reject) => {
      const q = indexedDB.open(SAVE_DB, 1);
      q.onupgradeneeded = () => q.result.createObjectStore("files");
      q.onerror = () => reject(q.error);
      q.onsuccess = () => {
        const db = q.result, tx = db.transaction("files", mode), st = tx.objectStore("files");
        let out;
        Promise.resolve(fn(st)).then((v) => { out = v; });
        tx.oncomplete = () => { db.close(); resolve(out); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  function readSaveFiles(filter) {
    return saveStore("readonly", (st) => new Promise((res) => {
      const files = {};
      st.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return res(files);
        if (filter(String(c.key))) files[c.key] = c.value;
        c.continue();
      };
    }));
  }
  const isProgress = (k) => /\.dat$/i.test(k);
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const backupMod = defineMod({
    id: "dashmods.save-backup",
    name: "Save Backup",
    version: "1.0.0",
    author: "gd-web",
    icon: "⇩",
    color: "#22c55e",
    tags: ["tools"],
    locked: true,
    defaultEnabled: true,
    short: "Download your progress as a file and restore it later or on another computer.",
    desc: "Your progress lives only in this browser. Download a backup to keep it safe, or to move it to another browser or computer and restore it there. Restoring replaces the progress in this browser and reloads the game; your progress from before the restore is kept so you can undo it.",
    settings: [
      { key: "dl", type: "action", label: "Download backup (progress and your levels)", button: "Download", run: () => backupMod.download(false) },
      { key: "dlSongs", type: "action", label: "Download backup including downloaded songs", help: "Much bigger file, but you won't need to download the songs again.", button: "Download", run: () => backupMod.download(true) },
      { key: "restore", type: "action", label: "Restore from a backup file", button: "Choose file…", run: () => backupMod.pickFile() },
      { key: "undo", type: "action", label: "Undo the last restore", button: "Undo", run: () => backupMod.undo() },
    ],
    async download(withSongs) {
      // Make sure the newest progress is in storage first.
      try { saveMod.pending = false; window.Module && window.Module._gd_request_save && window.Module._gd_request_save(); } catch (e) {}
      await sleep(1500);
      const files = await readSaveFiles((k) => isProgress(k) || (withSongs && /\.(mp3|ogg)$/i.test(k)));
      if (!Object.keys(files).length) return toast("Nothing to back up yet");
      const data = { format: "gd-web-backup", version: 1, created: new Date().toISOString(), files: {} };
      for (const k in files) data.files[k] = toB64(new Uint8Array(files[k]));
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "geometry-dash-backup-" + new Date().toISOString().slice(0, 10) + (withSongs ? "-with-songs" : "") + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast("Backup downloaded (" + Math.max(1, Math.round(blob.size / 1024)) + " KB)");
    },
    pickFile() {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".json,application/json";
      inp.onchange = async () => { const f = inp.files && inp.files[0]; if (f) await this.restoreFile(f); };
      inp.click();
    },
    async restoreFile(file) {
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { return toast("That file isn't a backup"); }
      if (!data || data.format !== "gd-web-backup" || !data.files || !Object.keys(data.files).some(isProgress)) return toast("That file isn't a Geometry Dash backup");
      const when = data.created ? new Date(data.created).toLocaleString() : "an unknown date";
      const ok = await ui.confirm("Restore backup?", `This replaces the progress in this browser with the backup from ${when}. The game will reload. (You can undo this afterwards.)`, "Restore");
      if (!ok) return;
      const files = {};
      for (const k in data.files) files[k] = fromB64(data.files[k]);
      await this.apply(files, true);
    },
    async undo() {
      const prev = await DB.get("before-restore", "backups");
      if (!prev || !prev.files) return toast("There's no restore to undo");
      const ok = await ui.confirm("Undo restore?", `Go back to the progress you had before the last restore (${new Date(prev.t).toLocaleString()})? The game will reload.`, "Undo");
      if (ok) await this.apply(prev.files, false);
    },
    async apply(files, keepUndo) {
      if (keepUndo) {
        const current = await readSaveFiles(isProgress);
        await DB.put("before-restore", { t: Date.now(), files: Object.fromEntries(Object.entries(current).map(([k, v]) => [k, new Uint8Array(v)])) }, "backups");
      }
      saveBlock.on = true;            // stop the running game from saving over it
      saveBlock.allow = true;
      try {
        await saveStore("readwrite", (st) => {
          if (Object.keys(files).some(isProgress)) for (const k of ["AppData/CCGameManager.dat", "AppData/CCLocalLevels.dat"]) if (!(k in files)) st.delete(k);
          for (const k in files) st.put(files[k], k);
        });
      } finally { saveBlock.allow = false; }
      toast("Restored – reloading…");
      setTimeout(() => location.reload(), 600);
    },
  });

  // ------------------------------------------------------------------ practice stats
  const fmtTime = (ms) => {
    const s = Math.max(0, ms / 1000), m = Math.floor(s / 60);
    return m ? `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}` : (s < 10 ? s.toFixed(1) : String(Math.floor(s))) + "s";
  };
  const statsMod = defineMod({
    id: "dashmods.practice-stats",
    name: "Practice Stats",
    version: "1.0.0",
    author: "gd-web",
    icon: "☠",
    color: "#a855f7",
    tags: ["practice", "interface"],
    short: "Counts attempts and deaths and times your runs while you play a level.",
    desc: "Shows attempts, deaths, time spent in the level (not counting pauses), how long your current attempt has lasted and your longest attempt. Counting keeps going when you restart the same level (for example with the Startpos Switcher) and starts over when you play a different one. Deaths are counted from the death sound, so they're only counted while sound effects play.",
    settings: [
      { key: "pos", type: "select", label: "Position", default: "top-right", options: POSITIONS.map((p) => [p, p.replace("-", " ")]) },
      { key: "showTime", type: "bool", label: "Show time in level", default: true },
      { key: "showRun", type: "bool", label: "Show current and longest attempt", default: true },
      { key: "keyReset", type: "key", label: "Reset stats key", default: "" },
    ],
    hotkeys: [{ setting: "keyReset", run: () => { statsMod.reset(statsMod.st.song); toast("Stats reset"); } }],
    st: null,
    reset(song) { this.st = { song: song || "", attempts: 1, deaths: 0, timeMs: 0, runStart: realNow(), best: 0, practice: false }; },
    onSound(name) {
      if (/^playSound/i.test(name)) this.entering = true;
      else if (/^explode_11/i.test(name) && this.st && spMod.inLevel) {
        const run = realNow() - this.st.runStart;
        this.st.best = Math.max(this.st.best, run);
        this.st.deaths++; this.st.attempts++;
        this.st.runStart = realNow();
      }
    },
    tick() {
      const now = realNow(), dt = now - (this.last || now);
      this.last = now;
      if (!spMod.inLevel) return removeHud("stats");
      const song = spMod.songNow().name;
      if (this.entering && song) {
        this.entering = false;
        // Practice mode plays its own music, so it counts as the same level as before.
        const practice = /^StayInsideMe/i.test(song);
        const same = this.st && (practice || this.st.song === song);
        if (!same) this.reset(song);
        else { this.st.attempts++; this.st.runStart = now; }
        this.st.practice = practice;
      }
      if (!this.st) this.reset(song);
      this.st.practice = /^StayInsideMe/i.test(song);
      const paused = spMod.pauseMenuOpen() || clock.holds.size;
      if (!paused) this.st.timeMs += dt * clock.speed;
      else this.st.runStart += dt;   // pauses don't count towards the current attempt
      const el = hudSlot("stats", this.get("pos"));
      if (!el) return;
      const st = this.st, parts = [`⟳ ${st.attempts}`, `☠ ${st.deaths}`];
      if (this.get("showTime")) parts.push(`⏱ ${fmtTime(st.timeMs)}`);
      let html = (st.practice ? "<small>PRACTICE</small> " : "") + parts.join("&nbsp;&nbsp;");
      if (this.get("showRun")) html += `<div class="dm-stats">run ${fmtTime(now - st.runStart)} · best ${fmtTime(st.best)}</div>`;
      el.innerHTML = html;
    },
    onEnable() { clearInterval(this.timer); this.last = realNow(); this.timer = setInterval(() => this.tick(), 200); },
    onDisable() { clearInterval(this.timer); removeHud("stats"); },
    onSetting() { this.tick(); },
  });
  audio.onStart.push((name) => statsMod.onSound(name));

  // ------------------------------------------------------------------ quality of life
  const fullMod = defineMod({
    id: "dashmods.fullscreen",
    name: "Fullscreen Key",
    version: "1.0.0",
    author: "gd-web",
    icon: "⛶",
    color: "#0ea5e9",
    tags: ["interface"],
    defaultEnabled: true,
    short: "Press a key to make the game fill your whole screen.",
    desc: "Toggles fullscreen for the game page. Esc or the same key leaves fullscreen.",
    settings: [{ key: "key", type: "key", label: "Fullscreen key", default: "F2" }],
    hotkeys: [{ setting: "key", run: () => fullMod.toggle() }],
    toggle() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => toast("Fullscreen isn't allowed here"));
    },
  });

  const autoPauseMod = defineMod({
    id: "dashmods.auto-pause",
    name: "Auto Pause",
    version: "1.0.0",
    author: "gd-web",
    icon: "⏸",
    color: "#ef4444",
    tags: ["gameplay"],
    defaultEnabled: true,
    short: "Pauses the level when you switch tabs or click away, so you don't die in the background.",
    desc: "The game keeps running when its tab is in the background. With this on, it pauses as soon as you switch tabs or windows while playing a level.",
    settings: [{ key: "onBlur", type: "bool", label: "Also pause when the window loses focus", default: true,
      help: "Off: only pause when the tab is hidden." }],
    pause() {
      if (!this.enabled() || !spMod.inLevel || spMod.busy || ui.isOpen()) return;
      if (spMod.pauseMenuOpen()) return;   // already paused: Esc would leave the level
      const M = window.Module;
      if (!M || !M.gdInputQueue) return;
      M.gdInputQueue.push([0x100, 27, 0x00010001]);
      setTimeout(() => M.gdInputQueue.push([0x101, 27, 0xc0010001 | 0]), 80);
    },
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") autoPauseMod.pause(); });
  window.addEventListener("blur", () => { if (autoPauseMod.get("onBlur")) autoPauseMod.pause(); });

  const cursorMod = defineMod({
    id: "dashmods.hide-cursor",
    name: "Hide Cursor",
    version: "1.0.0",
    author: "gd-web",
    icon: "➶",
    color: "#94a3b8",
    tags: ["interface"],
    short: "Hides the mouse pointer while you're playing a level.",
    desc: "The pointer disappears after a moment of not moving the mouse during a level, and comes back when you move it, pause or leave the level.",
    settings: [],
    moved: 0,
    tick() {
      const c = document.getElementById("canvas");
      if (!c) return;
      const hide = this.enabled() && spMod.inLevel && !spMod.pauseMenuOpen() && !ui.isOpen() && realNow() - this.moved > 1200;
      c.style.cursor = hide ? "none" : "";
    },
    onEnable() { clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 250); },
    onDisable() { clearInterval(this.timer); this.tick(); },
  });
  window.addEventListener("mousemove", () => { cursorMod.moved = realNow(); }, true);

  // ------------------------------------------------------------------ texture packs
  // The engine looks for every texture in /AppData/ before /Resources/ (like Windows GD's
  // texture-pack folder). So the mod writes replacement files into /AppData/ just before the
  // game starts (hook in gd_web.js) and never touches the originals; off = nothing written.
  const PNG = {
    crcTable: (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })(),
    crc(bytes, start, end) { let c = 0xffffffff; for (let i = start; i < end; i++) c = PNG.crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; },
    chunks(b) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
      for (let p = 8; p + 8 <= b.length; ) {
        const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        out.push({ type, start: p, data: b.subarray(p + 8, p + 8 + len) });
        p += 12 + len;
        if (type === "IEND") break;
      }
      return out;
    },
    async pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); },
    chunk(type, data) {
      const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      dv.setUint32(8 + data.length, PNG.crc(out, 4, 8 + data.length));
      return out;
    },
    // A broken image would crash the game's loader, so only ever hand it a real PNG.
    valid(b) {
      if (!b || b.length < 45) return false;
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return false;
      const ch = PNG.chunks(b);
      return ch.length >= 3 && ch[0].type === "IHDR" && ch.some((c) => c.type === "IDAT") && ch[ch.length - 1].type === "IEND";
    },
    concat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; },
    // Recolor a PNG with a color function f(r,g,b) -> [r,g,b] (in place on Uint8 arrays).
    async recolor(bytes, apply) {
      const ch = PNG.chunks(bytes), ihdr = ch.find((c) => c.type === "IHDR");
      if (!ihdr) return null;
      const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset);
      const w = dv.getUint32(0), h = dv.getUint32(4), depth = ihdr.data[8], type = ihdr.data[9], interlace = ihdr.data[12];
      if (depth !== 8 || interlace !== 0) return null;
      if (type === 3) {   // palette: just recolor the palette
        const plte = ch.find((c) => c.type === "PLTE");
        if (!plte) return null;
        const pal = new Uint8Array(plte.data);
        apply(pal, 0, pal.length, 3);
        return PNG.concat([bytes.subarray(0, 8)].concat(ch.map((c) => (c === plte ? PNG.chunk("PLTE", pal) : bytes.subarray(c.start, c.start + 12 + c.data.length)))));
      }
      const bpp = { 6: 4, 2: 3, 0: 1, 4: 2 }[type];
      if (!bpp || type === 0 || type === 4) return null;   // grayscale: nothing to recolor
      const raw = await PNG.pipe(PNG.concat(ch.filter((c) => c.type === "IDAT").map((c) => c.data)), new DecompressionStream("deflate"));
      const stride = w * bpp, px = new Uint8Array(h * stride);
      for (let y = 0; y < h; y++) {   // undo PNG row filters
        const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
        for (let x = 0; x < stride; x++) {
          const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
          let v = raw[src + x];
          if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
          else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
          px[dst + x] = v;
        }
      }
      apply(px, 0, px.length, bpp);
      const filtered = new Uint8Array(h * (stride + 1));   // re-filter with "sub" (good compression, cheap)
      for (let y = 0; y < h; y++) {
        const o = y * (stride + 1), s = y * stride;
        filtered[o] = 1;
        for (let x = 0; x < stride; x++) filtered[o + 1 + x] = px[s + x] - (x >= bpp ? px[s + x - bpp] : 0);
      }
      const idat = await PNG.pipe(filtered, new CompressionStream("deflate"));
      return PNG.concat([bytes.subarray(0, 8), PNG.chunk("IHDR", ihdr.data), PNG.chunk("IDAT", idat), PNG.chunk("IEND", new Uint8Array(0))]);
    },
  };

  // 3x4 color matrix from the recolor settings (same math as CSS filters).
  function colorMatrix(o) {
    const mul = (A, B) => { const R = []; for (let i = 0; i < 3; i++) { R[i] = []; for (let j = 0; j < 4; j++) R[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j] + (j === 3 ? A[i][3] : 0); } return R; };
    let M = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    const t = (o.hue * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    M = mul([[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0],
             [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0],
             [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0]], M);
    const sat = o.gray ? 0 : o.sat;
    M = mul([[0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat, 0],
             [0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat, 0],
             [0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat, 0]], M);
    const k = o.contrast, off = (0.5 - 0.5 * k) * 255;
    M = mul([[k * o.bright, 0, 0, off], [0, k * o.bright, 0, off], [0, 0, k * o.bright, off]], M);
    if (o.invert) M = mul([[-1, 0, 0, 255], [0, -1, 0, 255], [0, 0, -1, 255]], M);
    return M;
  }
  function makeApply(M) {
    const m = M.flat();
    return (bytes, start, end, step) => {
      // Write through a clamped view: a plain Uint8Array would wrap -92 around to 164.
      const a = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length);
      for (let i = start; i + 2 < end; i += step) {
        const r = a[i], g = a[i + 1], b = a[i + 2];
        a[i] = m[0] * r + m[1] * g + m[2] * b + m[3];
        a[i + 1] = m[4] * r + m[5] * g + m[6] * b + m[7];
        a[i + 2] = m[8] * r + m[9] * g + m[10] * b + m[11];
      }
    };
  }

  // Minimal .zip reader (stored and deflate entries).
  async function readZip(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip file");
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {}, dec = new TextDecoder();
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith("/")) continue;
      const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = b.subarray(ds, ds + csize);
      if (method === 0) files[name] = data.slice();
      else if (method === 8) files[name] = await PNG.pipe(data, new DecompressionStream("deflate-raw"));
    }
    return files;
  }

  const TEX_GROUPS = {
    objects: { label: "Blocks and objects", re: /^(GJ_GameSheet|GJ_GameSheet02|GJ_GameSheetGlow|GJ_GameSheetEditor)$/ },
    menus: { label: "Menus and buttons", re: /^(GJ_GameSheet03|GJ_GameSheet04|GJ_LaunchSheet|GJ_ShopSheet|GauntletSheet|WorldSheet|GJ_gradientBG|slidergroove|sliderBar|edit_barBG_001|GJ_square0\d|GJ_button_0\d)$/ },
    backgrounds: { label: "Backgrounds and grounds", re: /^(game_bg_\d+_001|game_mg_\d+_001|groundSquare_\d+_00\d|groundSquareShadow_001|floorLine_\d+_001)$/ },
    effects: { label: "Effects (fire, explosions, particles)", re: /^(FireSheet_01|PlayerExplosion_\d+|GJ_ParticleSheet|PixelSheet_01)$/ },
  };
  const texMod = defineMod({
    id: "dashmods.texture-pack",
    name: "Texture Pack",
    version: "1.0.0",
    author: "gd-web",
    icon: "🎨",
    color: "#ec4899",
    tags: ["visual"],
    short: "Recolor the game's textures, or load your own texture pack.",
    desc: "Two modes. Recolor changes the hue, saturation, brightness and contrast of the textures you pick. Custom pack uses a texture pack you upload (a .zip, or the image/.plist files), laid out like a normal Geometry Dash texture pack (for example GJ_GameSheet03-uhd.png with its .plist). Changes apply when the game reloads; the first load after a change takes longer while textures are prepared, after that they're cached. Turning the mod off brings back the original textures. Note: many level blocks, backgrounds and icons are white textures that each level colors itself, so recoloring mostly shows on menus, buttons, portals and decorations.",
    settings: [
      { key: "mode", type: "select", label: "Mode", default: "recolor", options: [["recolor", "Recolor the game's textures"], ["pack", "Use my uploaded pack"]] },
      { key: "hue", type: "range", label: "Hue shift (recolor)", default: 120, min: -180, max: 180, step: 5, unit: "°" },
      { key: "sat", type: "range", label: "Saturation (recolor)", default: 1, min: 0, max: 2, step: 0.05, unit: "×" },
      { key: "bright", type: "range", label: "Brightness (recolor)", default: 1, min: 0.3, max: 1.7, step: 0.05, unit: "×" },
      { key: "contrast", type: "range", label: "Contrast (recolor)", default: 1, min: 0.5, max: 1.5, step: 0.05, unit: "×" },
      { key: "invert", type: "bool", label: "Invert colors (recolor)", default: false },
      { key: "gray", type: "bool", label: "Black and white (recolor)", default: false },
      { key: "g_objects", type: "bool", label: "Recolor: " + TEX_GROUPS.objects.label, default: true },
      { key: "g_menus", type: "bool", label: "Recolor: " + TEX_GROUPS.menus.label, default: true },
      { key: "g_backgrounds", type: "bool", label: "Recolor: " + TEX_GROUPS.backgrounds.label, default: false },
      { key: "g_effects", type: "bool", label: "Recolor: " + TEX_GROUPS.effects.label, default: false, help: "Big files: the first load takes longer." },
      { key: "upload", type: "action", label: "Upload a texture pack (.zip or files)", help: "Replaces any pack you uploaded before.", button: "Choose…", run: () => texMod.pickPack() },
      { key: "packInfo", type: "action", label: "Uploaded pack", button: "Show", run: async () => { const m = await DB.get("pack-meta", "textures"); toast(m ? `${m.name}: ${m.count} files` : "No pack uploaded"); } },
      { key: "apply", type: "action", label: "Apply changes now (reloads the game)", button: "Apply", run: () => texMod.applyNow() },
    ],
    dirty: false,
    onEnable() { this.dirty = true; toast("Texture Pack on – press Apply in its settings, or reload"); },
    onDisable() { this.dirty = true; toast("Texture Pack off – reload to see the original textures"); },
    onSetting() { this.dirty = true; },
    async applyNow() {
      const ok = await ui.confirm("Apply textures?", "The game reloads to load the new textures. Your progress is saved first.", "Reload");
      if (!ok) return;
      try { saveMod.pending = false; window.Module && window.Module._gd_request_save && window.Module._gd_request_save(); } catch (e) {}
      toast("Saving and reloading…");
      setTimeout(() => location.reload(), 1500);
    },
    pickPack() {
      const inp = document.createElement("input");
      inp.type = "file"; inp.multiple = true; inp.accept = ".zip,.png,.plist,.fnt";
      inp.onchange = async () => {
        const list = [...(inp.files || [])];
        if (!list.length) return;
        toast("Reading pack…");
        const files = {};
        for (const f of list) {
          if (/\.zip$/i.test(f.name)) Object.assign(files, await readZip(await f.arrayBuffer()));
          else files[f.webkitRelativePath || f.name] = new Uint8Array(await f.arrayBuffer());
        }
        const usable = Object.keys(files).filter((k) => /\.(png|plist|fnt)$/i.test(k));
        if (!usable.length) return toast("No textures (.png/.plist/.fnt) found in that pack");
        const db = await DB.open();
        await new Promise((res) => {
          const tx = db.transaction("textures", "readwrite"), st = tx.objectStore("textures");
          st.clear();
          for (const k of usable) st.put(files[k], "pack:" + k);
          st.put({ name: list.length === 1 ? list[0].name : list.length + " files", count: usable.length, t: Date.now() }, "pack-meta");
          tx.oncomplete = res; tx.onerror = res;
        });
        this.set("mode", "pack");
        toast(`Pack saved (${usable.length} files) – press Apply`);
      };
      inp.click();
    },
    // ---- runs inside the engine's start-up, before the game reads any texture
    progress(text) {
      let ov = document.getElementById("dm-switch");
      if (!ov && ui.root) { ov = document.createElement("div"); ov.id = "dm-switch"; ov.className = "dm-out"; ui.root.appendChild(ov); }
      if (!ov) return;
      ov.textContent = text || "";
      ov.classList.toggle("show", !!text);
    },
    async beforeStart(FS) {
      // Remember which resolution the game asks for, so the next recolor targets it.
      const origOpen = FS.open;
      FS.open = function (path) {
        const m = /GJ_GameSheet03(-uhd|-hd)?\.png$/.exec(String(path));
        if (m) { try { localStorage.setItem("dashmods.texSuffix", m[1] || ""); } catch (e) {} FS.open = origOpen; }
        return origOpen.apply(this, arguments);
      };
      if (!this.enabled()) return;
      const write = (rel, data) => {
        const path = "/AppData/" + rel.replace(/^\/+/, "");
        const dir = path.slice(0, path.lastIndexOf("/"));
        try { FS.mkdirTree(dir); } catch (e) {}
        FS.writeFile(path, data);
      };
      if (this.get("mode") === "pack") return this.writePack(FS, write);
      return this.writeRecolor(FS, write);
    },
    async writePack(FS, write) {
      const db = await DB.open();
      const entries = await new Promise((res) => {
        const out = [], tx = db.transaction("textures"), st = tx.objectStore("textures");
        st.openCursor().onsuccess = (e) => { const c = e.target.result; if (!c) return; if (String(c.key).startsWith("pack:")) out.push([String(c.key).slice(5), c.value]); c.continue(); };
        tx.oncomplete = () => res(out);
      });
      // Match each file to the game's own path: drop leading folders until it names a real
      // resource (packs often put files under "resources/" or a pack-name folder).
      const exists = (rel) => { try { return FS.analyzePath("/Resources/" + rel).exists; } catch (e) { return false; } };
      let n = 0;
      for (const [name, data] of entries) {
        const parts = name.replace(/\\/g, "/").split("/").filter(Boolean);
        let rel = null;
        for (let i = 0; i < parts.length && !rel; i++) { const r = parts.slice(i).join("/"); if (exists(r)) rel = r; }
        if (/\.png$/i.test(name) && !PNG.valid(data)) { console.warn("[DashMods] pack: skipped broken image", name); continue; }
        write(rel || parts[parts.length - 1], data);
        n++;
      }
      console.log("[DashMods] texture pack: wrote", n, "files");
    },
    async writeRecolor(FS, write) {
      const o = { hue: +this.get("hue"), sat: +this.get("sat"), bright: +this.get("bright"), contrast: +this.get("contrast"), invert: !!this.get("invert"), gray: !!this.get("gray") };
      const groups = Object.keys(TEX_GROUPS).filter((g) => this.get("g_" + g));
      let suffix = "-uhd";
      try { const s = localStorage.getItem("dashmods.texSuffix"); if (s !== null) suffix = s; } catch (e) {}
      const key = JSON.stringify(["v2", o, groups, suffix]);
      const files = [];
      const all = FS.readdir("/Resources");
      for (const name of all) {
        if (!name.endsWith(suffix + ".png")) continue;
        const base = name.slice(0, name.length - suffix.length - 4);
        if (suffix === "" && /-(uhd|hd)$/.test(base)) continue;
        if (groups.some((g) => TEX_GROUPS[g].re.test(base))) files.push(name);
      }
      const db = await DB.open();
      const cached = await new Promise((res) => { const r = db.transaction("textures").objectStore("textures").get("recolor-key"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      const fromCache = cached === key;
      if (!fromCache) await new Promise((res) => { const tx = db.transaction("textures", "readwrite"), st = tx.objectStore("textures"); const rq = st.openCursor(); rq.onsuccess = (e) => { const c = e.target.result; if (!c) return; if (String(c.key).startsWith("rc:")) c.delete(); c.continue(); }; tx.oncomplete = res; });
      const apply = makeApply(colorMatrix(o));
      let done = 0;
      for (const name of files) {
        let out = null;
        if (fromCache) out = await DB.get("rc:" + name, "textures");
        if (!out) {
          this.progress(`🎨 Preparing textures… ${done + 1}/${files.length}`);
          await sleep(0);
          try { out = await PNG.recolor(FS.readFile("/Resources/" + name), apply); } catch (e) { console.warn("[DashMods] recolor failed for", name, e); }
          if (out && !PNG.valid(out)) { console.warn("[DashMods] skipped invalid recolor of", name); out = null; }
          if (out) await DB.put("rc:" + name, out, "textures");
        }
        if (out && PNG.valid(out)) write(name, out);
        done++;
      }
      if (!fromCache) await DB.put("recolor-key", key, "textures");
      this.progress("");
      console.log("[DashMods] recolor:", done, "textures", fromCache ? "(cached)" : "(prepared)");
    },
  });
  window.__dmBeforeStart = (FS) => texMod.beforeStart(FS);

  // Rewrite level downloads. Installed before the page's own proxy wrapper, which then
  // calls this one, so it sees the final proxied request.
  const nativeFetch = window.fetch;
  window.fetch = async function (input) {
    const res = await nativeFetch.apply(this, arguments);
    try {
      const url = String((input && input.url) || input);
      const len = res.headers.get("content-length");
      if (res.ok && /audio|ngfiles|\.mp3|\/ext\//i.test(url) && (len === String(NG_CLIP.size) || (len == null && !/downloadGJ|\.php/i.test(url)))) {
        if (await isNgClip(await res.clone().arrayBuffer())) {
          console.warn("[DashMods] blocked-song clip from", url, "- treating as a failed download");
          return new Response("hotlink clip", { status: 502 });
        }
      }
      if (!spMod.enabled() || !/downloadGJLevel22/.test(url) || !res.ok) return res;
      const text = await res.clone().text();
      const out = await spMod.rewrite(text);
      if (out === text) return res;
      if (spMod.active && spMod.active.song) spMod.knownSongs.add(spMod.active.song);
      const headers = new Headers(res.headers);
      headers.delete("content-length"); headers.delete("content-encoding");
      return new Response(out, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      console.error("[DashMods] startpos rewrite failed", e);
      return res;
    }
  };

  const JUMP_KEYS = ["Space", "ArrowUp", "KeyW"];
  const LEFT_KEYS = ["ArrowLeft", "KeyA"];
  const RIGHT_KEYS = ["ArrowRight", "KeyD"];
  const inputMod = defineMod({
    id: "dashmods.input-display",
    name: "Input Display",
    version: "1.0.0",
    author: "gd-web",
    icon: "⇧",
    color: "#ff4d6d",
    tags: ["interface", "practice"],
    short: "Shows your clicks and keys on screen, with a click counter.",
    desc: "Lights up when you jump or move, and counts clicks per second plus total clicks this session. Handy for checking your timing and for recordings.",
    settings: [
      { key: "pos", type: "select", label: "Position", default: "bottom-left",
        options: POSITIONS.map((p) => [p, p.replace("-", " ")]) },
      { key: "showCps", type: "bool", label: "Show clicks per second", default: true },
      { key: "showTotal", type: "bool", label: "Show total clicks", default: true },
      { key: "keyReset", type: "key", label: "Reset counter key", default: "" },
    ],
    hotkeys: [{ setting: "keyReset", run: () => { inputMod.total = 0; inputMod.draw(); toast("Click counter reset"); } }],
    state: { jump: false, left: false, right: false },
    pressedKeys: new Set(),
    pointerDown: false,
    times: [],
    total: 0,
    press() { this.total++; this.times.push(realNow()); },
    sync() {
      const k = this.pressedKeys;
      const jump = this.pointerDown || JUMP_KEYS.some((c) => k.has(c));
      if (jump && !this.state.jump) this.press();
      this.state.jump = jump;
      this.state.left = LEFT_KEYS.some((c) => k.has(c));
      this.state.right = RIGHT_KEYS.some((c) => k.has(c));
      this.draw();
    },
    draw() {
      if (!this.enabled()) return;
      const el = hudSlot("input", this.get("pos"));
      if (!el) return;
      const now = realNow();
      this.times = this.times.filter((t) => now - t < 1000);
      const s = this.state;
      const box = (on, label, wide) =>
        `<span class="dm-key${on ? " on" : ""}${wide ? " wide" : ""}">${label}</span>`;
      let html = `<div class="dm-keys">${box(s.left, "◀")}${box(s.jump, "JUMP", true)}${box(s.right, "▶")}</div>`;
      const stats = [];
      if (this.get("showCps")) stats.push(this.times.length + " CPS");
      if (this.get("showTotal")) stats.push(this.total + " clicks");
      if (stats.length) html += `<div class="dm-stats">${stats.join(" · ")}</div>`;
      el.innerHTML = html;
    },
    timer: 0,
    onEnable() { this.draw(); this.timer = setInterval(() => this.draw(), 200); },
    onDisable() { clearInterval(this.timer); removeHud("input"); },
    onSetting() { this.draw(); },
  });
  const onCanvas = (e) => e.target && e.target.id === "canvas";
  window.addEventListener("pointerdown", (e) => { if (onCanvas(e)) { inputMod.pointerDown = true; inputMod.sync(); } }, true);
  window.addEventListener("pointerup", () => { if (inputMod.pointerDown) { inputMod.pointerDown = false; inputMod.sync(); } }, true);
  window.addEventListener("keydown", (e) => {
    if (isMenuEvent(e) || e.repeat) return;
    inputMod.pressedKeys.add(e.code); inputMod.sync();
  }, true);
  window.addEventListener("keyup", (e) => { inputMod.pressedKeys.delete(e.code); inputMod.sync(); }, true);
  window.addEventListener("blur", () => { inputMod.pressedKeys.clear(); inputMod.pointerDown = false; inputMod.sync(); });

  // ------------------------------------------------------------------ UI
  const CSS = `
#dm-root{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:"Arial Black","Arial Rounded MT Bold",Arial,sans-serif;color:#fff;-webkit-user-select:none;user-select:none}
#dm-root *{box-sizing:border-box}
#dm-root .dm-out{text-shadow:0 2px 0 #000,0 -1px 0 #000,2px 0 0 #000,-2px 0 0 #000,1px 1px 0 #000,-1px -1px 0 #000}
#dm-btn{position:fixed;left:14px;bottom:14px;width:52px;height:52px;border-radius:14px;border:3px solid #1d1036;background:linear-gradient(#9b7bff,#5a37d6);box-shadow:0 4px 0 #1d1036,inset 0 2px 0 rgba(255,255,255,.35);pointer-events:auto;cursor:pointer;display:grid;place-items:center;opacity:.55;transition:opacity .15s,transform .1s}
#dm-btn:hover{opacity:1}#dm-btn:active{transform:translateY(2px);box-shadow:0 2px 0 #1d1036}
#dm-btn svg{width:30px;height:30px}
#dm-btn[data-pos=right]{left:auto;bottom:auto;right:0;top:42%;width:18px;height:64px;border-radius:12px 0 0 12px;border-right:0;box-shadow:inset 0 2px 0 rgba(255,255,255,.35);opacity:.6}
#dm-btn[data-pos=right] svg{width:13px;height:13px}
#dm-btn[data-pos=right]:active{transform:none}
#dm-shade{position:fixed;inset:0;background:rgba(0,0,0,.55);pointer-events:auto;display:none}
#dm-shade.open{display:block}
.dm-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:linear-gradient(#c97a3f,#a95f2c);border:4px solid #4a2410;border-radius:22px;box-shadow:0 8px 0 rgba(0,0,0,.35),inset 0 3px 0 rgba(255,255,255,.25);pointer-events:auto;display:flex;flex-direction:column}
.dm-main{width:min(820px,94vw);height:min(600px,88vh)}
.dm-head{display:flex;align-items:center;gap:12px;padding:14px 18px 10px}
.dm-title{font-size:30px;letter-spacing:1px;flex:1}
.dm-x{width:40px;height:40px;border-radius:50%;border:3px solid #3a0d0d;background:linear-gradient(#ff6b6b,#c62828);color:#fff;font-size:20px;cursor:pointer;box-shadow:0 3px 0 #3a0d0d}
.dm-bar{display:flex;gap:10px;padding:0 18px 10px;align-items:center}
.dm-search{flex:1;height:38px;border-radius:12px;border:3px solid #4a2410;background:#6e3a17;color:#fff;padding:0 12px;font:inherit;font-size:15px;outline:none}
.dm-search::placeholder{color:#d9b08c}
.dm-tab{height:38px;padding:0 14px;border-radius:12px;border:3px solid #4a2410;background:#8a4a1e;color:#fff;font:inherit;font-size:14px;cursor:pointer}
.dm-tab.on{background:linear-gradient(#7fe05a,#3ea21f);border-color:#1d4d0b}
.dm-list{flex:1;overflow:auto;margin:0 14px 14px;padding:8px;border-radius:14px;background:rgba(0,0,0,.25);box-shadow:inset 0 3px 8px rgba(0,0,0,.35)}
.dm-row{display:flex;align-items:center;gap:14px;padding:10px 12px;margin-bottom:8px;border-radius:12px;background:rgba(0,0,0,.22)}
.dm-row:nth-child(odd){background:rgba(0,0,0,.3)}
.dm-logo{width:54px;height:54px;flex:none;border-radius:12px;border:3px solid rgba(0,0,0,.6);display:grid;place-items:center;font-size:20px;box-shadow:inset 0 3px 0 rgba(255,255,255,.3)}
.dm-info{flex:1;min-width:0}
.dm-name{font-size:19px}
.dm-meta{font-family:Arial,sans-serif;font-weight:bold;font-size:12px;color:#ffe2b8;margin-top:2px}
.dm-short{font-family:Arial,sans-serif;font-size:13px;color:#fff3e4;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dm-view{height:36px;padding:0 16px;border-radius:12px;border:3px solid #1d4d0b;background:linear-gradient(#7fe05a,#3ea21f);color:#fff;font:inherit;font-size:14px;cursor:pointer;box-shadow:0 3px 0 #1d4d0b}
.dm-sw{width:58px;height:32px;border-radius:16px;border:3px solid #2b1206;background:#5b2d12;position:relative;cursor:pointer;flex:none;transition:background .15s}
.dm-sw::after{content:"";position:absolute;top:2px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 2px 0 rgba(0,0,0,.4);transition:left .15s}
.dm-sw.on{background:#43c21f}.dm-sw.on::after{left:28px}
.dm-sw.locked{opacity:.5;cursor:not-allowed}
.dm-pop{width:min(560px,92vw);max-height:86vh;padding-bottom:16px}
.dm-pop .dm-body{padding:0 20px;overflow:auto;font-family:Arial,sans-serif;font-size:14px;line-height:1.45}
.dm-tags{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}
.dm-tag{font-family:Arial,sans-serif;font-weight:bold;font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(0,0,0,.35);text-transform:uppercase;letter-spacing:.5px}
.dm-foot{display:flex;align-items:center;gap:10px;padding:14px 20px 0}
.dm-btn2{height:40px;padding:0 16px;border-radius:12px;border:3px solid #10305e;background:linear-gradient(#5aa9ff,#2563c9);color:#fff;font:inherit;font-size:14px;cursor:pointer;box-shadow:0 3px 0 #10305e}
.dm-btn2.grey{border-color:#333;background:linear-gradient(#9a9a9a,#666);box-shadow:0 3px 0 #333}
.dm-set{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.25);margin-bottom:8px}
.dm-set label{flex:1;font-weight:bold}
.dm-set .help{display:block;font-weight:normal;font-size:12px;color:#ffe2b8}
.dm-set input[type=range]{width:180px;accent-color:#43c21f}
.dm-set .val{width:58px;text-align:right;font-weight:bold}
.dm-set select{height:32px;border-radius:10px;border:3px solid #4a2410;background:#6e3a17;color:#fff;font-weight:bold;padding:0 6px}
.dm-keybtn{min-width:96px;height:34px;border-radius:10px;border:3px solid #4a2410;background:#6e3a17;color:#fff;font:inherit;font-size:13px;cursor:pointer}
.dm-keybtn.wait{background:#ffd54a;color:#4a2410}
.dm-hud{position:fixed;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.45);font-size:15px;pointer-events:none;text-shadow:0 2px 0 #000}
.dm-hud[data-pos=top-center]{top:10px;left:50%;transform:translateX(-50%)}.dm-hud[data-pos=top-center-2]{top:48px;left:50%;transform:translateX(-50%);color:#ffd54a}
.dm-hud[data-pos=top-left]{top:10px;left:80px}.dm-hud[data-pos=bottom-center]{bottom:14px;left:50%;transform:translateX(-50%);white-space:nowrap}.dm-hud[data-pos=top-right]{top:10px;right:10px}
.dm-hud[data-pos=bottom-left]{bottom:10px;left:10px}.dm-hud[data-pos=bottom-right]{bottom:10px;right:10px}
.dm-keys{display:flex;gap:6px}
.dm-key{min-width:34px;height:30px;padding:0 8px;border-radius:8px;border:2px solid rgba(255,255,255,.6);display:grid;place-items:center;font-size:12px;background:rgba(255,255,255,.08)}
.dm-key.wide{min-width:70px}.dm-key.on{background:#43c21f;border-color:#fff}
.dm-stats{font-size:12px;margin-top:5px;text-align:center}
#dm-toast{position:fixed;left:50%;top:92px;transform:translate(-50%,-20px);opacity:0;padding:8px 16px;border-radius:12px;background:rgba(0,0,0,.7);font-size:16px;transition:all .18s;pointer-events:none;text-shadow:0 2px 0 #000}
#dm-toast.show{opacity:1;transform:translate(-50%,0)}
#dm-switch{position:fixed;inset:0;display:grid;place-items:center;background:rgba(10,16,40,.92);font-size:30px;opacity:0;pointer-events:none;transition:opacity .08s}
#dm-switch.show{opacity:1}
.dm-empty{font-family:Arial,sans-serif;text-align:center;padding:30px;color:#ffe2b8}
`;

  const ICON = `<svg viewBox="0 0 32 32"><path d="M16 3l11 6.5v13L16 29 5 22.5v-13z" fill="#fff" stroke="#1d1036" stroke-width="2.5" stroke-linejoin="round"/><path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#6c4cf5"/></svg>`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  const ui = {
    root: null, shade: null, stack: [], filter: "", tab: "all",
    build() {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      this.root = h(`<div id="dm-root"><div id="dm-hudlayer"></div><div id="dm-toast" class="dm-out"></div><div id="dm-shade"></div></div>`);
      document.body.appendChild(this.root);
      hud.el = this.root.querySelector("#dm-hudlayer");
      this.shade = this.root.querySelector("#dm-shade");
      this.shade.addEventListener("pointerdown", (e) => { if (e.target === this.shade) this.closeTop(); });
      this.btn = h(`<button id="dm-btn" title="Mods (${esc(keyLabel(menuMod.get("openKey")))})">${ICON}</button>`);
      this.btn.addEventListener("click", () => this.toggle());
      this.root.appendChild(this.btn);
      this.refreshButton();
    },
    refreshButton() {
      if (!this.btn) return;
      this.btn.style.display = menuMod.get("showButton") ? "" : "none";
      this.btn.dataset.pos = menuMod.get("buttonPos");
    },
    isOpen() { return this.stack.length > 0; },
    toggle() { this.isOpen() ? this.closeAll() : this.openMain(); },
    push(el) {
      this.shade.appendChild(el);
      this.stack.push(el);
      this.shade.classList.add("open");
      hold("menu", !!menuMod.get("freezeWhileOpen"));
    },
    closeTop() {
      const el = this.stack.pop();
      if (el) el.remove();
      if (!this.stack.length) this.afterClose();
      else if (this.stack[this.stack.length - 1].refresh) this.stack[this.stack.length - 1].refresh();
    },
    closeAll() { while (this.stack.length) this.stack.pop().remove(); this.afterClose(); },
    afterClose() {
      this.shade.classList.remove("open");
      hold("menu", false);
      const c = document.getElementById("canvas");
      if (c) try { c.focus({ preventScroll: true }); } catch (e) {}
    },
    switchEl(mod) {
      const sw = h(`<div class="dm-sw${mod.enabled() ? " on" : ""}${mod.locked ? " locked" : ""}" role="switch"></div>`);
      sw.addEventListener("click", () => {
        if (mod.locked) return toast("The menu can't be turned off");
        mod.setEnabled(!mod.enabled());
        sw.classList.toggle("on", mod.enabled());
      });
      return sw;
    },
    openMain() {
      const panel = h(`<div class="dm-panel dm-main">
        <div class="dm-head"><div class="dm-title dm-out">Mods</div><button class="dm-x dm-out">✕</button></div>
        <div class="dm-bar">
          <input class="dm-search" placeholder="Search mods..." spellcheck="false">
          <button class="dm-tab dm-out" data-tab="all">All</button>
          <button class="dm-tab dm-out" data-tab="on">Enabled</button>
        </div>
        <div class="dm-list"></div></div>`);
      panel.querySelector(".dm-x").onclick = () => this.closeAll();
      const search = panel.querySelector(".dm-search");
      search.value = this.filter;
      search.oninput = () => { this.filter = search.value; panel.refresh(); };
      panel.querySelectorAll(".dm-tab").forEach((b) => (b.onclick = () => { this.tab = b.dataset.tab; panel.refresh(); }));
      panel.refresh = () => {
        panel.querySelectorAll(".dm-tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
        const list = panel.querySelector(".dm-list");
        list.innerHTML = "";
        const q = this.filter.trim().toLowerCase();
        const shown = mods.filter((m) =>
          (this.tab === "all" || m.enabled()) &&
          (!q || (m.name + " " + m.short + " " + m.tags.join(" ")).toLowerCase().includes(q)));
        if (!shown.length) list.appendChild(h(`<div class="dm-empty">No mods match.</div>`));
        for (const m of shown) {
          const row = h(`<div class="dm-row">
            <div class="dm-logo dm-out" style="background:${m.color}">${esc(m.icon)}</div>
            <div class="dm-info"><div class="dm-name dm-out">${esc(m.name)}</div>
              <div class="dm-meta">v${esc(m.version)} · by ${esc(m.author)}</div>
              <div class="dm-short">${esc(m.short)}</div></div>
            <button class="dm-view dm-out">View</button></div>`);
          row.querySelector(".dm-view").onclick = () => this.openMod(m);
          row.insertBefore(this.switchEl(m), row.querySelector(".dm-view"));
          list.appendChild(row);
        }
      };
      panel.refresh();
      this.push(panel);
      setTimeout(() => search.focus({ preventScroll: true }), 0);
    },
    openMod(m) {
      const pop = h(`<div class="dm-panel dm-pop">
        <div class="dm-head">
          <div class="dm-logo dm-out" style="background:${m.color}">${esc(m.icon)}</div>
          <div style="flex:1"><div class="dm-title dm-out" style="font-size:24px">${esc(m.name)}</div>
          <div class="dm-meta">v${esc(m.version)} · by ${esc(m.author)}</div></div>
          <button class="dm-x dm-out">✕</button></div>
        <div class="dm-body">
          <div class="dm-tags">${m.tags.map((t) => `<span class="dm-tag">${esc(t)}</span>`).join("")}</div>
          <div>${esc(m.desc)}</div>
          ${m.hotkeys.length ? `<div style="margin-top:10px"><b>Hotkeys:</b> ${m.hotkeys.map((hk) => {
            const s = m.settings.find((x) => x.key === hk.setting);
            return esc(s.label.replace(/ key$/, "")) + " <b>" + esc(keyLabel(m.get(hk.setting))) + "</b>";
          }).join(" · ")}</div>` : ""}
        </div>
        <div class="dm-foot"><button class="dm-btn2 dm-out" ${m.settings.length ? "" : "disabled"}>⚙ Settings</button>
          <div style="flex:1"></div><span class="dm-out" style="font-size:14px">Enabled</span></div></div>`);
      pop.querySelector(".dm-x").onclick = () => this.closeTop();
      pop.querySelector(".dm-btn2").onclick = () => this.openSettings(m);
      pop.querySelector(".dm-foot").appendChild(this.switchEl(m));
      pop.refresh = () => { const n = this.stack.indexOf(pop); if (n >= 0) { pop.remove(); this.stack.splice(n, 1); this.openMod(m); } };
      this.push(pop);
    },
    confirm(title, text, yes) {
      return new Promise((resolve) => {
        const pop = h(`<div class="dm-panel dm-pop">
          <div class="dm-head"><div class="dm-title dm-out" style="font-size:22px">${esc(title)}</div></div>
          <div class="dm-body">${esc(text)}</div>
          <div class="dm-foot"><button class="dm-btn2 grey dm-out">Cancel</button><div style="flex:1"></div>
          <button class="dm-btn2 dm-out">${esc(yes)}</button></div></div>`);
        const [no, ok] = pop.querySelectorAll(".dm-foot .dm-btn2");
        let done = false;
        const finish = (v) => { if (done) return; done = true; if (this.stack.includes(pop)) this.closeTop(); resolve(v); };
        no.onclick = () => finish(false);
        ok.onclick = () => finish(true);
        const obs = new MutationObserver(() => { if (!pop.isConnected) { obs.disconnect(); finish(false); } });
        obs.observe(this.shade, { childList: true });
        this.push(pop);
      });
    },
    openSettings(m) {
      const pop = h(`<div class="dm-panel dm-pop">
        <div class="dm-head"><div class="dm-title dm-out" style="font-size:22px">${esc(m.name)} settings</div>
        <button class="dm-x dm-out">✕</button></div><div class="dm-body"></div>
        <div class="dm-foot"><button class="dm-btn2 grey dm-out">Reset to defaults</button><div style="flex:1"></div>
        <button class="dm-btn2 dm-out">Done</button></div></div>`);
      const body = pop.querySelector(".dm-body");
      const draw = () => {
        body.innerHTML = "";
        for (const s of m.settings) {
          const row = h(`<div class="dm-set"><label>${esc(s.label)}${s.help ? `<span class="help">${esc(s.help)}</span>` : ""}</label></div>`);
          const v = m.get(s.key);
          if (s.type === "bool") {
            const sw = h(`<div class="dm-sw${v ? " on" : ""}"></div>`);
            sw.onclick = () => { m.set(s.key, !m.get(s.key)); sw.classList.toggle("on", m.get(s.key)); };
            row.appendChild(sw);
          } else if (s.type === "range") {
            const r = h(`<input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}">`);
            const dec = s.step >= 1 ? 0 : 2;
            const val = h(`<span class="val">${Number(v).toFixed(dec)}${s.unit || ""}</span>`);
            r.oninput = () => { val.textContent = Number(r.value).toFixed(dec) + (s.unit || ""); m.set(s.key, Number(r.value)); };
            row.appendChild(r); row.appendChild(val);
          } else if (s.type === "select") {
            const sel = h(`<select>${s.options.map(([k, l]) => `<option value="${esc(k)}"${k === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`);
            sel.onchange = () => m.set(s.key, sel.value);
            row.appendChild(sel);
          } else if (s.type === "key") {
            const b = h(`<button class="dm-keybtn">${esc(keyLabel(v))}</button>`);
            b.onclick = () => {
              b.classList.add("wait"); b.textContent = "Press a key…";
              capturingKey = (e) => {
                capturingKey = null; b.classList.remove("wait");
                if (e.code === "Escape") { b.textContent = keyLabel(m.get(s.key)); return; }
                const code = e.code === "Backspace" || e.code === "Delete" ? "" : e.code;
                m.set(s.key, code); b.textContent = keyLabel(code);
                if (m === menuMod) this.btn.title = "Mods (" + keyLabel(menuMod.get("openKey")) + ")";
              };
            };
            row.appendChild(b);
            row.querySelector("label").insertAdjacentHTML("beforeend", `<span class="help">Backspace clears it, Esc cancels.</span>`);
          } else if (s.type === "action") {
            const b = h(`<button class="dm-btn2 dm-out" style="flex:none">${esc(s.button || "Run")}</button>`);
            b.onclick = async () => {
              if (b.disabled) return;
              b.disabled = true;
              try { await s.run(m); } catch (e) { console.error("[DashMods]", e); toast("Something went wrong: " + e.message); }
              finally { b.disabled = false; }
            };
            row.appendChild(b);
          }
          body.appendChild(row);
        }
      };
      draw();
      pop.querySelector(".dm-x").onclick = () => this.closeTop();
      const [resetBtn, doneBtn] = pop.querySelectorAll(".dm-foot .dm-btn2");
      if (!m.settings.some((x) => x.type !== "action")) resetBtn.style.visibility = "hidden";
      resetBtn.onclick = () => {
        store.settings[m.id] = {};
        persist();
        if (m.enabled() && m.onSetting) m.onSetting();
        this.refreshButton();
        draw();
      };
      doneBtn.onclick = () => this.closeTop();
      this.push(pop);
    },
  };

  // ------------------------------------------------------------------ start
  function boot() {
    ui.build();
    setTimeout(() => {
      if (removedClips.length) toast(`Removed ${removedClips.length} broken song download${removedClips.length > 1 ? "s" : ""} – download ${removedClips.length > 1 ? "them" : "it"} again`);
    }, 4000);
    for (const m of mods) if (m.enabled() && !m.locked && m.onEnable) {
      try { m.onEnable(); } catch (e) { console.error("[DashMods]", m.id, e); }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__dashMods = { mods, clock, audio, gate, setSpeed, hold, stepFrame, ui, realNow };
})();
