/* ==========================================================================
   RektBench :: terminal command router
   Turns every existing link/form in the site into a terminal command.
   Clicking a link "types" the equivalent command and fetches the page
   over AJAX; typing a command does the same thing directly.
   ========================================================================== */

(function () {
  "use strict";

  var output   = document.getElementById("terminal-output");
  var input    = document.getElementById("terminal-input");
  var promptEl = document.getElementById("prompt-user");

  // Static word -> path commands. Kept in sync with OpenBench/urls.py and
  // the old sidebar. Anything not listed here still works via `open <url>`
  // or by clicking a link (which resolves itself automatically).
  var ROUTES = {
    "index":       "/index/",
    "home":        "/index/",
    "greens":      "/greens/",
    "search":      "/search/",
    "users":       "/users/",
    "events":      "/events/",
    "errors":      "/errors/",
    "machines":    "/machines/",
    "networks":    "/networks/",
    "login":       "/login/",
    "register":    "/register/",
    "logout":      "/logout/",
    "profile":     "/profile/",
    "newtest":     "/newTest/",
    "new-test":    "/newTest/",
    "newtune":     "/newTune/",
    "new-tune":    "/newTune/",
    "newdatagen":  "/newDatagen/",
    "new-datagen": "/newDatagen/",
    "newnetwork":  "/newNetwork/",
    "new-network": "/newNetwork/",
    "scripts":     "/scripts/"
  };

  // Dynamic commands that take an argument: `user grantnet` -> /user/grantnet/
  var DYNAMIC = {
    "user":    function (a) { return "/user/" + a + "/"; },
    "test":    function (a) { return "/test/" + a + "/"; },
    "tune":    function (a) { return "/tune/" + a + "/"; },
    "datagen": function (a) { return "/datagen/" + a + "/"; },
    "event":   function (a) { return "/event/" + a + "/"; },
    "machine": function (a) { return "/machines/" + a + "/"; },
    "network": function (a) { return "/networks/" + a + "/"; }
  };

  // Reverse map, longest path first, so we can turn a clicked href back
  // into a readable command for the echo line.
  var REVERSE = Object.keys(ROUTES)
    .filter(function (k) { return !["home", "new-test", "new-tune", "new-datagen", "new-network"].includes(k); })
    .map(function (k) { return { cmd: k, path: ROUTES[k] }; })
    .sort(function (a, b) { return b.path.length - a.path.length; });

  var history = [];
  var historyIndex = 0;

  // --------------------------------------------------------------------
  // CSRF helper. Django checks the X-CSRFToken header (or the
  // csrfmiddlewaretoken field) against the csrftoken cookie, so any POST
  // we build ourselves -- not just ones that came from a real <form> --
  // needs this attached.
  // --------------------------------------------------------------------
  function getCsrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  // Builds a POST body matching every field /search/ expects (the view
  // reads several of these unconditionally, so all of them have to be
  // present even when left at their form defaults) with the given
  // overrides applied on top.
  function buildSearchFormData(overrides) {
    var defaults = {
      "keywords": "",
      "author": "",
      "engine": "",
      "opening-book": "",
      "test-mode": "",
      "syzygy-wdl": "",
      "tc-type": "",
      "tc-value-select": "=",
      "tc-value-input": "",
      "threads-select": ">=",
      "threads-input": "1"
    };
    var merged = Object.assign({}, defaults, overrides || {});
    var data = new FormData();
    Object.keys(merged).forEach(function (k) { data.append(k, merged[k]); });

    // Checkboxes: checked by default on the real form (all statuses
    // shown except deleted tests), so mirror that here.
    ["show-greens", "show-blues", "show-yellows", "show-stopped", "show-reds"].forEach(function (k) {
      data.append(k, "");
    });

    data.append("csrfmiddlewaretoken", getCsrfToken());
    return data;
  }

  function runEngineSearch(name) {
    var data = buildSearchFormData({ "engine": name });
    fetchAndRender(ROUTES.search, "POST", data, "engine " + name);
  }

  // --------------------------------------------------------------------
  // Procedural typing/machine sound effects, built from oscillators and
  // filtered noise -- no sample files, so most of this has nothing to
  // fetch and nothing that can 404. uiClick() is the one exception: it
  // plays a real recorded sample (window.CLICK_SOUND_URL), fetched once
  // and decoded into an AudioBuffer, then triggered on demand.
  // --------------------------------------------------------------------
  var SoundFX = (function () {
    var ctx = null;
    var muted = (function () {
      try { return localStorage.getItem("rektbench_sound_muted") === "1"; }
      catch (e) { return false; }
    })();

    function getCtx() {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    // One second of white noise, generated once per context and reused
    // (via a random read offset each time) for every noiseHit() call, so
    // degauss/power thumps and disk clicks don't each allocate a buffer.
    var noiseBuffer = null;
    function getNoiseBuffer(c) {
      if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
        var size = c.sampleRate * 1;
        noiseBuffer = c.createBuffer(1, size, c.sampleRate);
        var data = noiseBuffer.getChannelData(0);
        for (var i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
      }
      return noiseBuffer;
    }

    // Fetches + decodes the recorded click sample exactly once, however
    // many clicks happen before it's ready; every uiClick() call awaits
    // the same promise. Missing file / decode failure just means clicks
    // stay silent rather than throwing.
    var clickBuffer = null;
    var clickBufferPromise = null;
    function getClickBuffer(c) {
      if (clickBuffer) return Promise.resolve(clickBuffer);
      if (clickBufferPromise) return clickBufferPromise;
      if (!window.CLICK_SOUND_URL) return Promise.resolve(null);
      clickBufferPromise = fetch(window.CLICK_SOUND_URL)
        .then(function (res) { return res.arrayBuffer(); })
        .then(function (data) { return c.decodeAudioData(data); })
        .then(function (decoded) { clickBuffer = decoded; return decoded; })
        .catch(function () { clickBufferPromise = null; return null; });
      return clickBufferPromise;
    }

    // A short filtered burst of noise -- a "hit" of static/click, used
    // under the power on/off whines and (more sharply) for disk-access
    // ticks and typewriter strikes. dur is the decay time in seconds;
    // attack is how long the gain takes to reach full volume (shorter =
    // snappier/crisper transient, longer = softer/rounder onset).
    function noiseHit(c, now, filterType, filterFreq, q, gainAmt, dur, attack) {
      var src = c.createBufferSource();
      src.buffer = getNoiseBuffer(c);

      var filt = c.createBiquadFilter();
      filt.type = filterType || "lowpass";
      filt.frequency.value = filterFreq || 1000;
      filt.Q.value = q || 1;

      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(gainAmt, now + (attack != null ? attack : 0.004));
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      src.connect(filt);
      filt.connect(g);
      g.connect(c.destination);

      var offset = Math.random() * Math.max(0, src.buffer.duration - dur - 0.02);
      src.start(now, offset, dur + 0.02);
    }

    // A typewriter strike, built entirely from filtered noise -- no
    // oscillators, no discernible pitch. Two noise layers per strike: a
    // very short, tightly bandpassed "tick" (the type slug touching
    // down) with a near-instant attack for a crisp, defined transient,
    // and a slightly longer, lowpassed "thud" a couple of milliseconds
    // behind it (the frame/lever resonance) sitting well underneath so
    // it adds body without smearing the tick's edge.
    function strike(c, now, tickFreq, tickGain, tickDur, thudFreq, thudGain, thudDur) {
      noiseHit(c, now, "bandpass", tickFreq, 3.2, tickGain, tickDur, 0.0012);
      if (thudGain) {
        noiseHit(c, now + 0.003, "lowpass", thudFreq, 0.7, thudGain, thudDur, 0.006);
      }
    }

    return {
      // Every keystroke jitters its tick frequency (~3400-4700Hz before
      // filtering -- higher and tighter-Q than before, for definition)
      // so a fast typist hears variation instead of one sound repeating
      // mechanically.
      key: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        strike(c, c.currentTime,
          3400 + Math.random() * 1300, 0.05, 0.009,
          230 + Math.random() * 80, 0.032, 0.022);
      },
      space: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        strike(c, c.currentTime, 2600, 0.055, 0.011, 190, 0.058, 0.05);
      },
      backspace: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        strike(c, c.currentTime, 4200, 0.045, 0.007, 300, 0.025, 0.015);
      },
      enter: function () {
        // Carriage return, redesigned: a soft two-note bell chime (pure
        // sine partials, fast attack + natural exponential decay) in
        // place of the old harsh high-Q noise ring, with a muted,
        // heavily lowpassed lever-thunk underneath for body. Reads as a
        // gentle "ding" rather than a piercing resonance.
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        var now = c.currentTime;

        function chime(freq, gainAmt, dur, startOffset) {
          var osc = c.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freq;
          var g = c.createGain();
          var t = now + (startOffset || 0);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(gainAmt, t + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(g);
          g.connect(c.destination);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        }

        chime(1046.5, 0.035, 0.14, 0);      // C6
        chime(784, 0.02, 0.12, 0.015);      // G5, a beat later, softer
        noiseHit(c, now + 0.02, "lowpass", 160, 0.6, 0.035, 0.05, 0.008);
      },
      toggleMute: function () {
        muted = !muted;
        try { localStorage.setItem("rektbench_sound_muted", muted ? "1" : "0"); } catch (e) {}
        return muted;
      },
      isMuted: function () { return muted; },

      // Creates/resumes the AudioContext, without playing anything.
      // Browsers refuse to run a Web Audio context until the page has
      // seen an actual user gesture (click/keydown/touch) -- the
      // automatic boot sequence fires its beeps with no such gesture
      // behind them, so without this they'd stay silent until *something*
      // else on the page happened to trigger a sound first. See the
      // early listener near the top of the file that calls this on the
      // very first interaction of any kind.
      unlock: function () { getCtx(); },

      // A single short "tick" of a drive head stepping -- a tight,
      // high-pass burst of noise. Quiet and cheap enough to repeat every
      // hundred-odd ms while a request is in flight (see DiskActivity).
      diskTick: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        noiseHit(c, c.currentTime, "bandpass", 1400 + Math.random() * 1400, 4, 0.02, 0.018);
      },

      // Plays the recorded click sample for buttons/links (see the
      // delegated listener near "UI click sound" below). Trimmed down
      // further with a gain node (a recorded sample sits far louder
      // than the tiny synthesized effects elsewhere in here), softened
      // with a lowpass to take the edge off the sample's high end, and
      // given a few-ms gain ramp instead of an instant on -- starting a
      // buffer at full volume from sample zero is itself a small sharp
      // transient, so easing in a touch makes it read as softer.
      uiClick: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        getClickBuffer(c).then(function (buf) {
          if (!buf || muted) return;
          var now = c.currentTime;
          var src = c.createBufferSource();
          src.buffer = buf;
          var filt = c.createBiquadFilter();
          filt.type = "lowpass";
          filt.frequency.value = 3200;
          var g = c.createGain();
          g.gain.setValueAtTime(0.0001, now);
          g.gain.linearRampToValueAtTime(0.05, now + 0.003);
          src.connect(filt);
          filt.connect(g);
          g.connect(c.destination);
          src.start(now);
        });
      },

      // Short confirm blip used for the "...OK" markers during boot.
      bootBeep: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        var now = c.currentTime;
        var osc = c.createOscillator();
        osc.type = "square";
        osc.frequency.value = 1300;
        var g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.03, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        osc.connect(g);
        g.connect(c.destination);
        osc.start(now);
        osc.stop(now + 0.1);
      },

      // Tube discharging: a fast descending whine plus a low relay thunk,
      // roughly matching the visual collapse-to-a-line-then-black.
      powerOff: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        var now = c.currentTime;

        var osc = c.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(2600, now);
        osc.frequency.exponentialRampToValueAtTime(55, now + 0.4);
        var filt = c.createBiquadFilter();
        filt.type = "lowpass";
        filt.frequency.value = 3200;
        var g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.05, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
        osc.connect(filt);
        filt.connect(g);
        g.connect(c.destination);
        osc.start(now);
        osc.stop(now + 0.44);

        noiseHit(c, now, "lowpass", 140, 1.1, 0.09, 0.09);
      },

      // Tube powering up: a low decaying "boiiing" (degauss coil) under a
      // rising whine as the flyback transformer spins up, plus a click.
      powerOn: function () {
        if (muted) return;
        var c = getCtx();
        if (!c) return;
        var now = c.currentTime;

        var osc = c.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(90, now);
        var lfo = c.createOscillator();
        lfo.frequency.value = 13;
        var lfoGain = c.createGain();
        lfoGain.gain.value = 38;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        var g = c.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.055, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
        osc.connect(g);
        g.connect(c.destination);
        osc.start(now);
        lfo.start(now);
        osc.stop(now + 0.52);
        lfo.stop(now + 0.52);

        var whine = c.createOscillator();
        whine.type = "sawtooth";
        whine.frequency.setValueAtTime(80, now + 0.06);
        whine.frequency.exponentialRampToValueAtTime(1600, now + 0.42);
        var wfilt = c.createBiquadFilter();
        wfilt.type = "lowpass";
        wfilt.frequency.value = 2400;
        var wg = c.createGain();
        wg.gain.setValueAtTime(0.0001, now + 0.06);
        wg.gain.linearRampToValueAtTime(0.03, now + 0.16);
        wg.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
        whine.connect(wfilt);
        wfilt.connect(wg);
        wg.connect(c.destination);
        whine.start(now + 0.06);
        whine.stop(now + 0.52);

        noiseHit(c, now, "lowpass", 160, 1.0, 0.07, 0.08);
      }
    };
  })();

  // Browsers won't let a Web Audio context make sound until the page has
  // had a genuine user gesture. The boot sequence below fires its beeps
  // automatically on load, with nothing behind them yet -- so grab the
  // very first click/keydown/touch anywhere on the page (whatever it is,
  // even one unrelated to sound) and use it to unlock audio immediately,
  // to catch as much of an in-progress boot sequence as possible.
  (function () {
    function unlockOnce() {
      SoundFX.unlock();
      document.removeEventListener("pointerdown", unlockOnce, true);
      document.removeEventListener("keydown", unlockOnce, true);
      document.removeEventListener("touchstart", unlockOnce, true);
    }
    document.addEventListener("pointerdown", unlockOnce, true);
    document.addEventListener("keydown", unlockOnce, true);
    document.addEventListener("touchstart", unlockOnce, true);
  })();

  function scrollToBottom() {
    output.scrollTop = output.scrollHeight;
  }

  // --------------------------------------------------------------------
  // Drive-activity light + ticking, running for the lifetime of any
  // fetchAndRender() call. start()/stop() are reference-counted so two
  // requests in flight at once (e.g. a click fired just before a typed
  // command resolves) don't let one's completion turn the light off
  // early for the other.
  // --------------------------------------------------------------------
  var DiskActivity = (function () {
    var led = null;
    var flickerTimer = null;
    var tickTimer = null;
    var active = 0;

    function getLed() {
      if (!led) led = document.getElementById("crt-disk-led");
      return led;
    }

    function scheduleFlicker() {
      var el = getLed();
      if (!el) return;
      el.classList.add("is-lit");
      var onFor = 50 + Math.random() * 90;
      flickerTimer = setTimeout(function () {
        el.classList.remove("is-lit");
        var offFor = 40 + Math.random() * 170;
        flickerTimer = setTimeout(scheduleFlicker, offFor);
      }, onFor);
    }

    function scheduleTicks() {
      var delay = 90 + Math.random() * 220;
      tickTimer = setTimeout(function () {
        SoundFX.diskTick();
        scheduleTicks();
      }, delay);
    }

    return {
      start: function () {
        active++;
        if (active > 1) return;
        scheduleFlicker();
        scheduleTicks();
      },
      stop: function () {
        active = Math.max(0, active - 1);
        if (active > 0) return;
        clearTimeout(flickerTimer);
        clearTimeout(tickTimer);
        flickerTimer = tickTimer = null;
        var el = getLed();
        if (el) el.classList.remove("is-lit");
      }
    };
  })();

  function processTimestamps(container) {
    var opts1 = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    var opts2 = { month: "short", day: "2-digit" };
    var ts = container.getElementsByClassName("timestamp");
    for (var i = 0; i < ts.length; i++) {
      var n = parseFloat(ts[i].textContent);
      if (!isNaN(n)) ts[i].textContent = new Date(1000 * n).toLocaleString(undefined, opts1);
    }
    var ds = container.getElementsByClassName("datestamp");
    for (var j = 0; j < ds.length; j++) {
      var m = parseFloat(ds[j].textContent);
      if (!isNaN(m)) ds[j].textContent = new Date(1000 * m).toLocaleString(undefined, opts2);
    }
  }

  function pathToCommand(path) {
    try {
      var url = new URL(path, window.location.origin);
      path = url.pathname + url.search;
    } catch (e) {}
    for (var i = 0; i < REVERSE.length; i++) {
      if (path === REVERSE[i].path || path === REVERSE[i].path.slice(0, -1)) {
        return REVERSE[i].cmd;
      }
    }
    return "open " + path;
  }

  function printLine(text, cls) {
    var div = document.createElement("div");
    div.className = "term-note" + (cls ? " " + cls : "");
    div.textContent = text;
    output.appendChild(div);
    scrollToBottom();
  }

  function printBlock(commandLabel, node) {
    var block = document.createElement("div");
    block.className = "term-block";

    var cmdLine = document.createElement("div");
    cmdLine.className = "term-cmd";
    var prompt = document.createElement("span");
    prompt.className = "prompt";
    prompt.textContent = promptEl.textContent;
    cmdLine.appendChild(prompt);
    cmdLine.appendChild(document.createTextNode(commandLabel));
    block.appendChild(cmdLine);

    if (node) {
      var pageWrap = document.createElement("div");
      pageWrap.className = "term-page";
      pageWrap.appendChild(node);
      block.appendChild(pageWrap);
      processTimestamps(pageWrap);
    }

    output.appendChild(block);
    scrollToBottom();
    return block;
  }

  // Printed the instant a command is fired off, before the response comes
  // back, so slower queries (e.g. `engine <name>`, which does a non-trivial
  // DB lookup) don't leave the terminal looking stalled. fetchAndRender
  // fills the same block in place once the real page arrives, or swaps in
  // an error line if the request fails.
  function printPendingBlock(commandLabel) {
    var block = document.createElement("div");
    block.className = "term-block is-pending";

    var cmdLine = document.createElement("div");
    cmdLine.className = "term-cmd";
    var prompt = document.createElement("span");
    prompt.className = "prompt";
    prompt.textContent = promptEl.textContent;
    cmdLine.appendChild(prompt);
    cmdLine.appendChild(document.createTextNode(commandLabel));
    block.appendChild(cmdLine);

    var loading = document.createElement("div");
    loading.className = "term-loading";
    loading.innerHTML =
      "querying database" +
      '<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span>';
    block.appendChild(loading);

    output.appendChild(block);
    scrollToBottom();
    return block;
  }

  function extractPage(doc) {
    var el = doc.getElementById("page-block");
    if (el) return el;
    // Fallback: whole body if the response wasn't one of our templates
    return doc.body;
  }

  // Every fetched response is a full re-render of base.html server-side,
  // so it always carries the current login state -- but the terminal
  // "chrome" (input-line prompt, titlebar username, window.CURRENT_USER)
  // lives outside #page-block and is only ever painted once, at the
  // initial full page load. Without this, logging in or out updates the
  // session and the page content immediately, but the prompt/titlebar
  // keep showing the old user until an actual browser refresh. Pull the
  // real value out of the fetched doc's own inline script (rather than
  // trusting visible text, which could theoretically be styled/altered)
  // and repaint the chrome from it after every navigation.
  function extractCurrentUser(doc) {
    var scripts = doc.querySelectorAll("script:not([src])");
    for (var i = 0; i < scripts.length; i++) {
      var m = /window\.CURRENT_USER\s*=\s*(?:"([^"]*)"|null)/.exec(scripts[i].textContent);
      if (m) return m[1] || null;
    }
    return undefined; // no such script in the response; leave chrome alone
  }

  function syncUserChrome(username) {
    window.CURRENT_USER = username;
    var label = (username || "guest") + "@rektbench";
    promptEl.textContent = label + ":~$";
    var titlebarUser = document.getElementById("titlebar-username");
    if (titlebarUser) titlebarUser.textContent = label;
  }

  // Many page templates ship their own {% block scripts %} that sets up
  // form behaviour (create test/tune/datagen, network sorting, copy
  // buttons, ...). Those scripts often do
  //   document.addEventListener('DOMContentLoaded', fn)
  // which would never fire again once the real DOMContentLoaded event has
  // already happened. While we (re-)run a page's scripts we temporarily
  // make that pattern fire immediately instead of registering for an
  // event that's already in the past, without disturbing any other
  // listener in the app.
  function withImmediateReadyEvents(work) {
    var origDocAdd = document.addEventListener;
    var origWinAdd = window.addEventListener;
    function patched(origFn, target) {
      return function (type, handler) {
        if (type === "DOMContentLoaded" || type === "load") {
          try { handler.call(target); } catch (e) { /* page script error, ignore */ }
          return;
        }
        return origFn.apply(this, arguments);
      };
    }
    document.addEventListener = patched(origDocAdd, document);
    window.addEventListener = patched(origWinAdd, window);
    try { work(); } finally {
      document.addEventListener = origDocAdd;
      window.addEventListener = origWinAdd;
    }
  }

  // Runs a page's <head> scripts (the ones contributed via
  // {% block scripts %}) in order, waiting for external <script src> to
  // load before moving on to inline scripts that depend on them.
  function runPageScripts(doc, done) {
    var scripts = Array.prototype.slice.call(doc.head.querySelectorAll("script"));

    // Some of these carry ids (the {{ ... |json_script:"..." }} data
    // blocks, e.g. "json-config") that a previous visit to the same page
    // may have left lying around in document.body. Rename any stale
    // copies out of the way first -- same trick as deconflictIds() for
    // the visible page content -- so getElementById() calls made by the
    // scripts we're about to run resolve to the fresh copy, not a
    // leftover one from earlier in the session.
    for (var s = 0; s < scripts.length; s++) {
      var id = scripts[s].id;
      if (!id) continue;
      var stale = document.querySelectorAll('[id="' + id.replace(/"/g, "") + '"]');
      for (var j = 0; j < stale.length; j++) stale[j].id = "stale-" + id + "-" + s + "-" + Date.now();
    }

    (function next(i) {
      if (i >= scripts.length) { done(); return; }
      var old = scripts[i];
      var el = document.createElement("script");
      for (var a = 0; a < old.attributes.length; a++) {
        el.setAttribute(old.attributes[a].name, old.attributes[a].value);
      }
      if (old.src) {
        withImmediateReadyEvents(function () {
          el.onload = el.onerror = function () { next(i + 1); };
          document.body.appendChild(el);
        });
      } else {
        el.textContent = old.textContent;
        // Leave this in the DOM (don't remove it right away): later
        // scripts in this same batch -- e.g. create_workload.js, loaded
        // async via <script src> -- read it back out with
        // getElementById() once *they* finish loading, which can be
        // well after this synchronous pass is done.
        withImmediateReadyEvents(function () {
          document.body.appendChild(el);
        });
        next(i + 1);
      }
    })(0);
  }

  // Two different terminal commands can land on the same page template
  // twice in one session (e.g. `newtest` visited twice), which would
  // otherwise leave two elements sharing an id in the scrollback. Rename
  // ids on the earlier copy so `getElementById` in freshly-run scripts
  // resolves to the block that was just added.
  function deconflictIds(freshRoot) {
    var ids = freshRoot.querySelectorAll("[id]");
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i].id;
      if (!id) continue;
      var stale = output.querySelectorAll('[id="' + id.replace(/"/g, "") + '"]');
      for (var j = 0; j < stale.length; j++) stale[j].id = "stale-" + id + "-" + i + "-" + Date.now();
    }
  }

  function fetchAndRender(url, method, body, commandLabel) {
    var opts = { method: method || "GET", credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } };
    if (body) opts.body = body;
    if ((method || "GET").toUpperCase() !== "GET") opts.headers["X-CSRFToken"] = getCsrfToken();

    var pending = printPendingBlock(commandLabel);
    DiskActivity.start();

    return fetch(url, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          return { res: res, text: text };
        });
      })
      .then(function (r) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(r.text, "text/html");
        var page = extractPage(doc);
        var frag = document.createElement("div");
        while (page.firstChild) frag.appendChild(page.firstChild);

        deconflictIds(frag);

        var pageWrap = document.createElement("div");
        pageWrap.className = "term-page";
        pageWrap.appendChild(frag);

        var loadingEl = pending.querySelector(".term-loading");
        if (loadingEl) pending.replaceChild(pageWrap, loadingEl);
        else pending.appendChild(pageWrap);
        pending.classList.remove("is-pending");
        processTimestamps(pageWrap);
        scrollToBottom();

        runPageScripts(doc, function () { /* page behaviour wired up */ });

        var newTitle = doc.querySelector("title");
        if (newTitle) document.title = newTitle.textContent;

        var freshUser = extractCurrentUser(doc);
        if (freshUser !== undefined) syncUserChrome(freshUser);

        var finalPath = r.res.url ? new URL(r.res.url).pathname : url;
        window.history.pushState({ path: finalPath }, "", finalPath);
        DiskActivity.stop();
        return pending;
      })
      .catch(function (err) {
        var loadingEl = pending.querySelector(".term-loading");
        var errorLine = document.createElement("div");
        errorLine.className = "term-note term-error";
        errorLine.textContent = "connection lost: " + err.message;
        if (loadingEl) pending.replaceChild(errorLine, loadingEl);
        else pending.appendChild(errorLine);
        pending.classList.remove("is-pending");
        scrollToBottom();
        DiskActivity.stop();
      });
  }

  function navigate(url, commandLabel) {
    commandLabel = commandLabel || pathToCommand(url);
    return fetchAndRender(url, "GET", null, commandLabel);
  }

  function submitForm(form, submitter) {
    var method = (form.getAttribute("method") || "GET").toUpperCase();
    var action = form.getAttribute("action") || window.location.pathname;
    var data = new FormData(form);
    if (submitter && submitter.name) data.append(submitter.name, submitter.value || "");

    var label = pathToCommand(action) + " --submit";

    if (method === "GET") {
      var params = new URLSearchParams(data).toString();
      var url = action + (params ? "?" + params : "");
      navigate(url, label);
    } else {
      fetchAndRender(action, "POST", data, label);
    }
  }

  // ---------------------------------------------------------------- //
  // UI click sound. Delegated to the document so it also covers buttons
  // and links injected later via fetch, and deliberately independent of
  // the routing listener below it: this one just wants to know "was
  // something clickable clicked", not whether it's internal/external/a
  // download/etc.
  // ---------------------------------------------------------------- //

  document.addEventListener("click", function (e) {
    if (e.target.closest("a[href], button, input[type='submit'], input[type='button'], [role='button']")) {
      SoundFX.uiClick();
    }
  });

  // ---------------------------------------------------------------- //
  // Link + form interception, delegated so it also covers content that
  // gets injected later via fetch.
  // ---------------------------------------------------------------- //

  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a) return;

    var href = a.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;

    var url;
    try { url = new URL(href, window.location.href); } catch (err) { return; }

    if (url.origin !== window.location.origin) return; // external: normal browser nav
    if (href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0) return;

    e.preventDefault();
    navigate(url.pathname + url.search);
    input.focus();
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    e.preventDefault();
    var submitter = e.submitter;
    submitForm(form, submitter);
    input.focus();
  });

  // ---------------------------------------------------------------- //
  // Command line
  // ---------------------------------------------------------------- //

  function printHelp() {
    var lines = [
      "available commands:",
      "",
      "  index | greens | search | users | events | errors | machines | networks",
      "  login | register | logout | profile",
      "  newtest | newtune | newdatagen | newnetwork | scripts",
      "  user <name>   test <id>   tune <id>   datagen <id>",
      "  event <id>    machine <id>   network <engine>",
      "  engine <name>   find tests run against a given engine",
      "  open <path>   go back with your browser's back button",
      "  clear         wipe the screen",
      "  help          show this message",
      "",
      "or just click any link on the page \u2014 it types the command for you."
    ];
    lines.forEach(function (l) { printLine(l); });
  }

  function runCommand(raw) {
    var trimmed = raw.trim();
    if (!trimmed) return;

    history.push(trimmed);
    historyIndex = history.length;

    var parts = trimmed.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var arg = parts.slice(1).join(" ");

    if (cmd === "clear" || cmd === "cls") {
      output.innerHTML = "";
      return;
    }

    if (cmd === "help" || cmd === "?") {
      printBlock(trimmed, null);
      printHelp();
      return;
    }

    if (cmd === "whoami") {
      printBlock(trimmed, null);
      printLine(window.CURRENT_USER || "guest");
      return;
    }

    if (cmd === "open" && arg) {
      navigate(arg, trimmed);
      return;
    }

    if (ROUTES[cmd] && !arg) {
      navigate(ROUTES[cmd], trimmed);
      return;
    }

    if (DYNAMIC[cmd] && arg) {
      navigate(DYNAMIC[cmd](arg), trimmed);
      return;
    }

    if (cmd === "search" && arg) {
      navigate(ROUTES.search, trimmed);
      return;
    }

    if (cmd === "engine" && arg) {
      runEngineSearch(arg);
      return;
    }

    printBlock(trimmed, null);
    printLine("command not found: " + cmd + " (try 'help')", "term-error");
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      SoundFX.enter();
      var val = input.value;
      input.value = "";
      runCommand(val);
    } else if (e.key === "ArrowUp") {
      SoundFX.key();
      if (historyIndex > 0) {
        historyIndex--;
        input.value = history[historyIndex] || "";
        e.preventDefault();
      }
    } else if (e.key === "ArrowDown") {
      SoundFX.key();
      if (historyIndex < history.length) {
        historyIndex++;
        input.value = history[historyIndex] || "";
        e.preventDefault();
      }
    } else if (e.key === "Backspace") {
      SoundFX.backspace();
    } else if (e.key === " ") {
      SoundFX.space();
    } else if (e.key.length === 1) {
      // any printable character (letters, digits, punctuation, etc.)
      SoundFX.key();
    }
  });

  document.addEventListener("click", function (e) {
    if (e.target.closest(".term-page") || e.target.closest("a") || e.target.closest("button") || e.target.closest("input") || e.target.closest("select") || e.target.closest("textarea")) return;
    input.focus();
  });

  window.addEventListener("popstate", function (e) {
    var path = (e.state && e.state.path) || window.location.pathname;
    navigate(path, pathToCommand(path));
  });

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // Types a single boot line into the scrollback one character at a time,
  // with a soft keystroke sound per character and a trailing blinking
  // cursor -- like watching the machine "type" its own POST log. Lines
  // flagged `ok` get their "OK" appended a beat after the rest of the
  // text, with its own little confirm blip, instead of typed inline.
  function typeBootLine(entry, done, reduced) {
    var div = document.createElement("div");
    div.className = "term-note boot-line";
    var textNode = document.createTextNode("");
    var cursor = document.createElement("span");
    cursor.className = "boot-cursor";
    div.appendChild(textNode);
    div.appendChild(cursor);
    output.appendChild(div);
    scrollToBottom();

    var text = entry.text;
    var i = 0;

    function finish() {
      cursor.remove();
      setTimeout(done, reduced ? 0 : 25);
    }

    (function step() {
      if (i < text.length) {
        var ch = text.charAt(i);
        textNode.textContent += ch;
        if (ch === " ") SoundFX.space(); else SoundFX.key();
        i++;
        scrollToBottom();
        setTimeout(step, reduced ? 0 : 1.5 + Math.random() * 3);
        return;
      }
      if (entry.ok) {
        setTimeout(function () {
          var ok = document.createElement("span");
          ok.className = "boot-ok";
          ok.textContent = "OK";
          div.insertBefore(ok, cursor);
          SoundFX.bootBeep();
          scrollToBottom();
          finish();
        }, reduced ? 0 : 55);
      } else {
        finish();
      }
    })();
  }

  // Wordmark shown once at the top of every boot log, dropped in as a
  // single block (not typed character-by-character like the lines below
  // it) with a quick materialize + confirm blip, the way a monitor's
  // own splash logo appears ahead of its POST text.
  var BOOT_LOGO = [
    " ___ ___ _  _______ ___ ___ _  _  ___ _  _ ",
    "| _ \\ __| |/ /_   _| _ ) __| \\| |/ __| || |",
    "|   / _|| ' <  | | | _ \\ _|| .` | (__| __ |",
    "|_|_\\___|_|\\_\\ |_| |___/___|_|\\_|\\___|_||_|"
  ].join("\n");

  function printBootLogo(done, reduced) {
    var pre = document.createElement("pre");
    pre.className = "boot-ascii-logo";
    pre.textContent = BOOT_LOGO;
    output.appendChild(pre);
    scrollToBottom();
    if (!reduced) SoundFX.bootBeep();
    setTimeout(done, reduced ? 0 : 200);
  }

  // Boot log lines, typed character-by-character into the scrollback with
  // a soft keystroke sound and a blinking cursor, "...OK" markers popping
  // in a beat after the rest of the line with their own confirm blip.
  var BOOT_LOG_LINES = [
    { text: "REKTBENCH TERMINAL v2.0" },
    { text: "chess engine testing framework \u2014 booting session\u2026" },
    { text: "loading kernel modules ......... ", ok: true },
    { text: "establishing uplink ............ ", ok: true },
    { text: "type 'help' for a list of commands" },
    { text: "" }
  ];

  function runBootLog(done, reduced) {
    function step(i) {
      if (i >= BOOT_LOG_LINES.length) { done(); return; }
      typeBootLine(BOOT_LOG_LINES[i], function () { step(i + 1); }, reduced);
    }
    printBootLogo(function () { step(0); }, reduced);
  }

  // Full "the tube just switched on" sequence: CRT flash/sound, then the
  // POST log types itself out. Used both when the monitor is switched
  // back on after being switched off (see initPowerToggle), and on the
  // first load of a fresh tab/session (see the DOMContentLoaded handler
  // below) -- a plain reload of the same tab should not replay it.
  function playPowerOnSequence(done) {
    var shell = document.querySelector(".crt-shell");
    var reduced = prefersReducedMotion();

    function afterFlash() {
      runBootLog(done, reduced);
    }

    if (!shell) { afterFlash(); return; }

    shell.classList.add("is-powering-on");
    SoundFX.powerOn();
    setTimeout(function () {
      shell.classList.remove("is-powering-on");
      afterFlash();
    }, reduced ? 0 : 300);
  }

  function revealInitialPage() {
    var initial = document.getElementById("page-block");
    if (!initial) return;
    var frag = document.createElement("div");
    while (initial.firstChild) frag.appendChild(initial.firstChild);
    initial.remove();
    var label = pathToCommand(window.location.pathname);
    printBlock(label, frag);
    input.focus();
  }

  function initSoundToggle() {
    var btn = document.getElementById("sound-toggle");
    if (!btn) return;
    function render() {
      var muted = SoundFX.isMuted();
      btn.innerHTML = muted
        ? '<i class="fa-solid fa-volume-xmark"></i>'
        : '<i class="fa-solid fa-volume-high"></i>';
      btn.classList.toggle("is-muted", muted);
      btn.title = muted ? "Sound effects off (click to enable)" : "Sound effects on (click to mute)";
    }
    btn.addEventListener("click", function () {
      var nowMuted = SoundFX.toggleMute();
      render();
      if (!nowMuted) SoundFX.key();
      input.focus();
    });
    render();
  }

  // The physical power button on the bezel. Purely a display toggle: it
  // blanks the tube and mutes the glow, it doesn't tear down or stop the
  // app underneath, so flipping it back on just un-hides everything
  // exactly where it was -- but it does it with the full CRT tube
  // collapse/expand animation, matching power-supply sounds, and (only
  // on the way back on) a replayed POST log, same as a real monitor
  // being switched off and back on.
  function initPowerToggle() {
    var btn = document.getElementById("crt-power-toggle");
    var shell = document.querySelector(".crt-shell");
    if (!btn || !shell) return;

    var STORAGE_KEY = "rektbench_crt_off";
    var OFF_ANIM_MS = 260;
    var animating = false;

    function setSteady(isOff) {
      shell.classList.toggle("is-off", isOff);
      btn.setAttribute("aria-pressed", isOff ? "true" : "false");
      btn.title = isOff ? "Turn monitor on" : "Turn monitor off";
      try { localStorage.setItem(STORAGE_KEY, isOff ? "1" : "0"); } catch (e) {}
    }

    var startOff = false;
    try { startOff = localStorage.getItem(STORAGE_KEY) === "1"; } catch (e) {}
    shell.classList.toggle("is-off", startOff);
    btn.setAttribute("aria-pressed", startOff ? "true" : "false");
    btn.title = startOff ? "Turn monitor on" : "Turn monitor off";

    btn.addEventListener("click", function () {
      if (animating) return;
      var reduced = prefersReducedMotion();
      var turningOff = !shell.classList.contains("is-off");
      animating = true;

      if (turningOff) {
        SoundFX.powerOff();
        shell.classList.add("is-powering-off");
        setTimeout(function () {
          shell.classList.remove("is-powering-off");
          setSteady(true);
          animating = false;
        }, reduced ? 0 : OFF_ANIM_MS);
      } else {
        shell.classList.remove("is-off");
        var savedOutput = output.innerHTML;
        output.innerHTML = "";
        playPowerOnSequence(function () {
          output.innerHTML = savedOutput;
          scrollToBottom();
          setSteady(false);
          animating = false;
          input.focus();
        });
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    window.history.replaceState({ path: window.location.pathname }, "", window.location.pathname);
    initSoundToggle();
    initPowerToggle();

    // Boot up once per tab: the first time the site is opened here, play
    // the full POST log before showing the page. sessionStorage survives
    // a plain reload of this same tab (so reloading doesn't replay the
    // boot), but it's gone again once the tab/window is closed and the
    // site is reopened, so the next fresh visit boots again.
    var BOOTED_KEY = "rektbench_booted";
    var alreadyBooted = false;
    try { alreadyBooted = sessionStorage.getItem(BOOTED_KEY) === "1"; } catch (e) {}

    var shell = document.querySelector(".crt-shell");
    var monitorOff = shell && shell.classList.contains("is-off");

    if (alreadyBooted || monitorOff) {
      revealInitialPage();
      return;
    }

    try { sessionStorage.setItem(BOOTED_KEY, "1"); } catch (e) {}

    playPowerOnSequence(function () {
      output.innerHTML = "";
      revealInitialPage();
    });
  });
})();
