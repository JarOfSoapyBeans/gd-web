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
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
    }, 150);
  }

  // ------------------------------------------------------------------ clock
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  const dateOffset = realDateNow() - realNow();
  const clock = {
    speed: 1,          // speedhack multiplier
    holds: new Set(),  // reasons the game is frozen ("step", "menu")
    baseReal: realNow(),
    baseVirt: realNow(),
  };
  function factor() { return clock.holds.size ? 0 : clock.speed; }
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
      return node;
    };
  }
  function gdAudio() { return window.Module && window.Module.__gdAudio; }
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
    const next = clock.holds.size ? 0 : (audio.follow ? clock.speed : 1);
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

  // Time + audio together.
  function setSpeed(s) {
    rebaseClock();
    clock.speed = Math.max(0.05, Math.min(5, s));
    applyAudio();
  }
  function hold(reason, on) {
    rebaseClock();
    if (on) clock.holds.add(reason); else clock.holds.delete(reason);
    applyAudio();
  }
  function stepFrame(ms) {
    // Advance frozen game time by one step.
    clock.baseVirt += ms;
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
      persist();
      try { on ? mod.onEnable && mod.onEnable() : mod.onDisable && mod.onDisable(); } catch (e) { console.error(e); }
    };
    for (const hk of mod.hotkeys) {
      hotkeys.push({ code: () => (mod.enabled() ? mod.get(hk.setting) : ""), run: hk.run });
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
    author: "you",
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
        help: "The small button in the bottom-left corner. You can still use the key when it's hidden." },
      { key: "freezeWhileOpen", type: "bool", label: "Pause game while menu is open", default: true },
    ],
    hotkeys: [{ setting: "openKey", run: () => ui.toggle() }],
    onSetting(k) { if (k === "showButton") ui.refreshButton(); },
  });

  const speedMod = defineMod({
    id: "dashmods.speedhack",
    name: "Speedhack",
    version: "1.0.0",
    author: "you",
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
        const el = hudSlot("speed", "top-left");
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
    author: "you",
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
      this.frozen = !this.frozen;
      hold("step", this.frozen);
      this.draw();
      toast(this.frozen ? "Frozen" : "Unfrozen");
    },
    step() {
      if (!this.frozen) { this.frozen = true; hold("step", true); this.draw(); }
      stepFrame(1000 / Number(this.get("stepFps")));
    },
    draw() {
      if (this.enabled() && this.frozen) hudSlot("frozen", "top-right").textContent = "❚❚ FROZEN";
      else removeHud("frozen");
    },
    onDisable() { this.frozen = false; hold("step", false); this.draw(); },
  });

  const fpsMod = defineMod({
    id: "dashmods.fps-counter",
    name: "FPS Counter",
    version: "1.0.0",
    author: "you",
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

  const JUMP_KEYS = ["Space", "ArrowUp", "KeyW"];
  const LEFT_KEYS = ["ArrowLeft", "KeyA"];
  const RIGHT_KEYS = ["ArrowRight", "KeyD"];
  const inputMod = defineMod({
    id: "dashmods.input-display",
    name: "Input Display",
    version: "1.0.0",
    author: "you",
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
.dm-hud[data-pos=top-left]{top:10px;left:10px}.dm-hud[data-pos=top-right]{top:10px;right:10px}
.dm-hud[data-pos=bottom-left]{bottom:76px;left:10px}.dm-hud[data-pos=bottom-right]{bottom:10px;right:10px}
.dm-keys{display:flex;gap:6px}
.dm-key{min-width:34px;height:30px;padding:0 8px;border-radius:8px;border:2px solid rgba(255,255,255,.6);display:grid;place-items:center;font-size:12px;background:rgba(255,255,255,.08)}
.dm-key.wide{min-width:70px}.dm-key.on{background:#43c21f;border-color:#fff}
.dm-stats{font-size:12px;margin-top:5px;text-align:center}
#dm-toast{position:fixed;left:50%;top:18px;transform:translate(-50%,-20px);opacity:0;padding:8px 16px;border-radius:12px;background:rgba(0,0,0,.7);font-size:16px;transition:all .18s;pointer-events:none;text-shadow:0 2px 0 #000}
#dm-toast.show{opacity:1;transform:translate(-50%,0)}
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
    refreshButton() { if (this.btn) this.btn.style.display = menuMod.get("showButton") ? "" : "none"; },
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
            const val = h(`<span class="val">${Number(v).toFixed(2)}${s.unit || ""}</span>`);
            r.oninput = () => { val.textContent = Number(r.value).toFixed(2) + (s.unit || ""); m.set(s.key, Number(r.value)); };
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
          }
          body.appendChild(row);
        }
      };
      draw();
      pop.querySelector(".dm-x").onclick = () => this.closeTop();
      const [resetBtn, doneBtn] = pop.querySelectorAll(".dm-foot .dm-btn2");
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
    for (const m of mods) if (m.enabled() && !m.locked && m.onEnable) {
      try { m.onEnable(); } catch (e) { console.error("[DashMods]", m.id, e); }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.__dashMods = { mods, clock, audio, setSpeed, hold, ui, realNow };
})();
