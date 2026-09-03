/* ============================================================================
   Prayas '26 — scroll engine

   One requestAnimationFrame loop owns all scroll-driven motion. It writes a
   handful of CSS custom properties on <html> and lets CSS do the compositing;
   nothing here touches an element's style directly except the video.

   Three separate knobs make the scroll slow and fluid:

     1. LENGTH     — how many viewport heights of scrolling one act runs for,
                     plus a shorter hold at the end where progress has already
                     reached 1 and everything is simply settling.
     2. SMOOTHING  — a frame-rate-independent exponential follow. A fixed
                     per-frame lerp runs twice as fast on a 120Hz display as on
                     a 60Hz one; this is time-based, so the feel is identical.
     3. EASING     — every beat is smoothstepped, so things ease in and out
                     rather than starting and stopping abruptly.
   ========================================================================= */

(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("js");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var CONFIG = {
    // Seconds for the smoothed scroll to close ~63% of the gap to the real
    // scroll position. The wireframe used a fixed 0.085-per-frame lerp, which
    // is this same feel at 60Hz — but time-based, so a 120Hz display does not
    // run it twice as fast.
    tau: 0.1875,

    // ---- act length ------------------------------------------------------
    // Both in viewport heights, straight off the wireframe.
    //
    //   actVh   the scroll distance progress is measured over: p goes 0 → 1
    //           across (actVh - 100)vh of scrolling.
    //   holdVh  extra pinned distance AFTER p hits 1. Kept at ZERO on purpose.
    //           Any hold here is dead scroll by definition: progress is
    //           already 1, so the video is parked on its last frame, the
    //           closing line is at full opacity and the burst has finished —
    //           the viewport simply stops responding until the pin releases.
    //           At 66 that was ~594px of nothing, which read as the scroll
    //           snagging. The closing beat now runs right up to the release,
    //           so she settles and the page keeps moving in one motion.
    //
    // This replaced a seconds x px/second sizing that worked out to ~20,000px
    // of track — near five times the wireframe's, which is what made every
    // beat feel like it took forever to arrive and forever to leave.
    // Progress is measured over (actVh - 100)vh, so this is not the round
    // number it looks like. The original pace was 460 => 3.6vh of run; this
    // is 3x that, so 3 x 3.6 = 10.8vh of run => actVh 1180. Change this one
    // value and nothing else: every beat below is normalised, so the dance
    // and both cards keep their exact proportions.
    // Set at boot and on every resize by applyPace() from `pace` below —
    // a phone needs a much shorter run than a desktop for the same act.
    actVh: 1180,
    holdVh: 0,

    // ---- pacing per device -----------------------------------------------
    // 1080vh of run (actVh 1180) is right for a wheel or a trackpad, where
    // one gesture covers a lot of ground. A thumb does not: the same act on
    // a phone took swipe after swipe to get through, which read as the page
    // being stuck rather than as a slow reveal.
    //
    // Every beat is normalised to progress, so shortening the run keeps the
    // dance and both cards in exactly the same proportions — they simply
    // arrive sooner. At the phone value card one still holds the stage for
    // ~46vh of scrolling and is on screen for ~138vh of it, which is enough
    // to read it without it outstaying its welcome.
    //
    // `tau` drops alongside: a shorter run means more change per pixel, and
    // the desktop follow starts to feel like lag behind a finger that is
    // already somewhere else. Tighter tracking reads as smoother here even
    // though it is technically less smoothing.
    pace: {
      phone:   { actVh: 560,  tau: 0.12 },
      tablet:  { actVh: 820,  tau: 0.15 },
      desktop: { actVh: 1180, tau: 0.1875 }
    },

    // Degrees the backdrop turns across the whole act.
    rotation: 54,

    // ---- the buta field --------------------------------------------------
    // Measured off the reference at a 1470px-wide viewport: emblems sit on a
    // POLAR lattice centred on the dancer — rings ~108px apart, ~150px of arc
    // between neighbours, alternate rings offset half a step so the rings
    // never line up into spokes.
    weave: {
      ringGap: 118,     // px between concentric rings
      arcGap:  164,     // px between neighbours along a ring
      innerR:  128,     // first ring; inside this the dancer covers everything
      size:    23,      // emblem width in px
      tilt:    0.38,    // how far each emblem turns toward its own radius,
                        // 0 = all upright, 1 = fully radial. The reference
                        // reads as a lean, not a rotation.
      centreY: 0.46     // the field's centre, as a fraction of viewport height
    },

    // All beats are in normalised act progress, 0 → 1.
    //
    // The cards TAKE TURNS. Card one holds the stage alone from 30% to 40%
    // and is gone by 50%; card two waits until 56%, holds 66% to 78%, and is
    // gone by 86%. The pause between them is the point — the dancer gets the
    // stage back before the next card claims it.
    //
    // Everything after card two is deliberately tight: the burst and the
    // closing line overlap, p reaches 1 almost immediately after, and the
    // 22vh hold hands straight over to the hackathon.
    //
    // The dancer herself has no beat at all. She is on screen from the first
    // frame — her entrance is a one-shot CSS animation on load, not something
    // scroll drives — and she never leaves; when the act ends the pin releases
    // and scrolling carries her off naturally.
    beats: {
      heroOut:  [0.05, 0.18],   // dims to 10%, never fully leaves
      // The travel here is deliberately small (10px). The stage clips its
      // overflow so the cards can slide in from off-stage, and on a short
      // viewport a longer rise took the eyebrow line straight off the top.
      // The dim to 10% is what carries this beat; the lift is only a nudge.
      heroY:    [0.05, 0.30],
      cueOut:   [0.02, 0.10],

      cardOneIn:  [0.20, 0.30],
      cardOneOut: [0.40, 0.50],
      cardTwoIn:  [0.56, 0.66],
      cardTwoOut: [0.78, 0.86],

      // The glow at her back. Opens just after card two starts arriving —
      // a beat behind cardTwoIn rather than exactly on it, so it reads as a
      // response to her rather than firing in lockstep — and closes well
      // ahead of the burst and the hackathon, so nothing overlaps the two.
      haloIn:  [0.58, 0.72],
      haloOut: [0.82, 0.92],

      burstIn:  [0.84, 0.93],
      burstOut: [0.97, 1.00],

      // Runs almost to the release. Landing it early left the last stretch
      // with nothing left to change.
      lockIn:   [0.88, 0.97]
    }
  };

  /* -- maths ---------------------------------------------------------------- */

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /** Smoothstep between two progress marks — eases in and out, never linear. */
  function seg(range, p) {
    var t = clamp01((p - range[0]) / (range[1] - range[0]));
    return t * t * (3 - 2 * t);
  }

  function n(v) { return Math.round(v * 1000) / 1000; }

  /* -- elements -------------------------------------------------------------- */

  var act = document.getElementById("act-one");
  var video = document.getElementById("dancer");
  if (!act) return;

  /* ==========================================================================
     Dancer plate

     The plate is scrubbed against scroll, never played. Three things have to
     be true for that to work, and each has its own failure mode:

       · metadata must be loaded    — preload="auto" often has it ready before
                                      this script runs, so checking readyState
                                      up front matters as much as listening
       · the element must be primed — iOS and Safari refuse to seek a <video>
                                      that has never been kicked, and the kick
                                      has to ride on a user gesture
       · one seek at a time         — writing currentTime every frame queues
                                      seeks faster than the decoder retires
                                      them, which is exactly what leaves the
                                      plate frozen. Wait for `seeked` first.

     If scrubbing still cannot work — a host that ignores Range requests, a
     stalled load, a codec the browser decodes but will not seek — fall back to
     looped playback. She then moves out of step with the scroll, which is far
     better than not moving at all.

     The fallback comes in two flavours, and the distinction matters:

       · FATAL      the element told us it cannot do this — a load error, or
                    seeks that are issued and never report back. Scrubbing is
                    off for good.
       · PROVISIONAL  metadata is simply taking its time. Loop so she is not
                    frozen on the poster, but hand scrubbing back the moment
                    the duration shows up.

     Treating slowness as fatal is what left her standing still: a plain
     five-second timer fired while the clip was still downloading, and because
     the fallback also cleared videoReady, armVideo() bailed out on every
     later event. One slow first load and the scrub never came back.
     ====================================================================== */

  var videoReady = false;
  var videoDuration = 0;
  var seeking = false;
  var seekIssuedAt = 0;
  var loopFallback = false;
  var scrubbingIsDead = false;         // set only by a FATAL fallback

  /* A seek that COMPLETES can still be far too slow to read as dancing. A
     phone decoding an alpha stream in software retires a seek in a couple of
     hundred milliseconds, which is four or five new frames a second: she
     visibly stutters instead of moving, and none of the checks below fire
     because every seek is technically working. So time them and give up on
     scrubbing if the decoder cannot keep pace.

     The first few are ignored — a cold decoder and a half-filled buffer make
     the opening seeks slow everywhere, including on desktop. */
  var SEEK_WARMUP  = 3;      // seeks to discard before judging
  var SEEK_SAMPLES = 6;      // seeks to average over
  var SEEK_BUDGET  = 200;    // ms; above this, scrubbing reads as a stutter
  var seekSeen = 0;
  var seekTotal = 0;

  function startLoopFallback(why, fatal) {
    if (!video || scrubbingIsDead) return;
    if (fatal) scrubbingIsDead = true;
    if (loopFallback) return;

    loopFallback = true;
    videoReady = false;
    video.loop = true;
    var pr = video.play();
    if (pr && typeof pr.catch === "function") pr.catch(function () {});
    if (window.console && console.info) {
      console.info("[prayas] dancer: looping instead of scrubbing (" + why +
                   (fatal ? "" : " — will resume scrubbing if it recovers") + ")");
    }
  }

  function endLoopFallback() {
    loopFallback = false;
    video.loop = false;
    try { video.pause(); } catch (e) {}
  }

  function armVideo() {
    if (scrubbingIsDead) return;

    var d = video.duration || 0;
    if (!isFinite(d) || d <= 0) return;

    videoDuration = d;
    // Metadata arrived after a provisional fallback: take scrubbing back.
    if (loopFallback) endLoopFallback();
    videoReady = true;
    lastWritten = null;                // force one render now that we can seek
  }

  function primeVideo() {
    var pr = video.play();
    if (pr && typeof pr.then === "function") {
      pr.then(function () { if (!loopFallback) video.pause(); }).catch(function () {});
    } else {
      try { video.pause(); } catch (e) {}
    }
  }

  /* iOS and Safari refuse to seek a <video> that has never been kicked, and
     the kick has to ride on a user gesture — so this cannot wait for the
     alpha probe to finish. On a phone the first touch usually lands inside
     the first second, which is often BEFORE the probe has settled, and a
     `once` listener attached afterwards has already missed it. That is what
     left her frozen on the poster: never primed, so every seek was quietly
     ignored, and the plate simply never moved.

     Wire it at parse time instead and remember that a gesture went by, so
     whichever happens second — the gesture or the probe — does the priming. */
  var gestureSeen = false;

  if (video) {
    ["pointerdown", "touchstart", "wheel", "keydown"].forEach(function (ev) {
      window.addEventListener(ev, function () {
        gestureSeen = true;
        if (video.src) primeVideo();
      }, { once: true, passive: true });
    });
  }

  /* -- which plate can this browser actually composite? -----------------------
     The plate is an alpha video now, and alpha support cannot be asked about.
     canPlayType() answers for the CODEC, not for the alpha channel, and both
     engines say "probably" to the format they then handle differently:

       Safari 18   VP9/WebM  "probably"  -> alpha channel DISCARDED, opaque box
                   HEVC/MP4  "probably"  -> alpha honoured
       Chrome 151  VP9/WebM  "probably"  -> alpha honoured
                   HEVC/MP4  ""          -> (decodes anyway on some platforms)

     A <source> list would hand Safari the WebM and leave a dark green plate
     on screen with no error to catch. So ask in pixels instead: decode one
     16x16 frame whose right half is fully transparent, draw it to a canvas,
     and read the alpha back. ~830 bytes of base64, inline, one decode, no
     network request.

     Verified against Safari 18.6 (WebKit 605) and Chrome 151. */

  var PROBE_WEBM = "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJBEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEpTbuMU6uEHFO7a1OsggIr7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEBEAAAAAAAAFlSua8yuAQAAAAAAAEPXgQFzxYgK7M2IrNzsT5yBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDglLCBELqBEJqBAlPAgQFVsIRVuYEBElTDZ0CAc3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2Mi4xMi4xMDFzc9pjwItjxYgK7M2IrNzsT2fIpUWjh0VOQ09ERVJEh5hMYXZjNjIuMjguMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0MDAwMDAwMAAfQ7Z19+eBAKDyocGBAAAAgkmDQgAA8AD2ADgkHBgAAAAgAAAflf///lGUp////cQ8AJT////YHD////8DnCH////9tQB////+ni4AAHWhrKaq7oEBpaWCSYNCAADwAPYAOCQcGAAAACAAAB7////90r0U////6/qRQAAAHFO7a5G7j7OBALeK94EB8YIBr/CBAw==";

  /** Decode the probe and report whether its transparent half stayed transparent. */
  function detectAlphaVideo(done) {
    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(ok);
    }

    var v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    // A detached element decodes fine in Safari 18 and Chrome 151, but that
    // is not guaranteed anywhere, and an element in the document is the case
    // engines actually optimise for. Park it off-screen rather than hiding it:
    // display:none or visibility:hidden would licence a browser to skip the
    // decode entirely, which is the one thing this must not do.
    v.setAttribute("aria-hidden", "true");
    v.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px";

    v.addEventListener("loadeddata", function () {
      // One frame decoded is not the same as one frame presented; give the
      // compositor a beat before reading pixels back.
      setTimeout(function () {
        var ok = false;
        try {
          var c = document.createElement("canvas");
          c.width = c.height = 16;
          var g = c.getContext("2d");
          g.clearRect(0, 0, 16, 16);
          g.drawImage(v, 0, 0, 16, 16);
          var clear = g.getImageData(13, 8, 1, 1).data;   // the transparent half
          var solid = g.getImageData(3, 8, 1, 1).data;    // the opaque half
          // Both halves have to read correctly. A canvas that was never
          // painted also reports alpha 0, and would otherwise pass.
          ok = clear[3] < 24 && solid[3] > 231;
        } catch (e) {}
        if (v.parentNode) v.parentNode.removeChild(v);
        finish(ok);
      }, 120);
    });

    v.addEventListener("error", function () {
      if (v.parentNode) v.parentNode.removeChild(v);
      finish(false);
    });

    var timer = setTimeout(function () {
      if (v.parentNode) v.parentNode.removeChild(v);
      finish(false);
    }, 4000);

    v.src = PROBE_WEBM;
    (document.body || document.documentElement).appendChild(v);
    v.load();
  }

  /** Point the plate at a source this browser will composite, then wire it up. */
  function selectPlateSource(onChosen) {
    var webm = video.getAttribute("data-webm");
    var mp4 = video.getAttribute("data-mp4");

    detectAlphaVideo(function (webmAlphaWorks) {
      var src = webmAlphaWorks ? webm : mp4;

      // Nothing to fall back to: the poster is already the pre-keyed figure,
      // so leaving src unset is a complete, correct plate — not a blank box.
      if (!src || (!webmAlphaWorks && !video.canPlayType("video/mp4; codecs=\"hvc1\""))) {
        scrubbingIsDead = true;
        if (window.console && console.info) {
          console.info("[prayas] dancer: no source composites alpha here — holding the poster");
        }
        return;
      }

      if (window.console && console.info) {
        console.info("[prayas] dancer: " + (webmAlphaWorks ? "VP9/WebM" : "HEVC/MP4") + " alpha");
      }
      video.preload = "auto";
      video.src = src;
      video.load();
      onChosen();
    });
  }

  function wirePlate() {
    if (video.readyState >= 1 && video.duration) armVideo();
    video.addEventListener("loadedmetadata", armVideo);
    video.addEventListener("durationchange", armVideo);
    video.addEventListener("canplay", armVideo);
    video.addEventListener("seeked", function () {
      if (seeking) {
        seekSeen++;
        if (seekSeen > SEEK_WARMUP) {
          seekTotal += performance.now() - seekIssuedAt;
          var judged = seekSeen - SEEK_WARMUP;
          if (judged >= SEEK_SAMPLES) {
            var mean = seekTotal / judged;
            if (mean > SEEK_BUDGET) {
              startLoopFallback("seeks average " + Math.round(mean) +
                                "ms — too slow to read as motion", true);
            }
            seekSeen = SEEK_WARMUP;      // reset the window and keep watching
            seekTotal = 0;
          }
        }
      }
      seeking = false;
    });
    video.addEventListener("error", function () { startLoopFallback("load error", true); });

    primeVideo();
    if (gestureSeen) primeVideo();      // a gesture already went by; use it

    /* Metadata that has NOT ARRIVED YET is not metadata that will never
       arrive. Poll instead of setting one blind timer: give up early only if
       the element has actually stopped fetching, and otherwise let a slow
       connection have a full half-minute. Either way the fallback stays
       provisional, so armVideo() can hand scrubbing straight back. */
    var waited = 0;
    var metaWatch = setInterval(function () {
      if (videoReady || scrubbingIsDead) { clearInterval(metaWatch); return; }

      waited += 1;
      var stillFetching = video.networkState === 2;   // NETWORK_LOADING

      if (!stillFetching && waited >= 6) {
        clearInterval(metaWatch);
        startLoopFallback("load stalled with no metadata", false);
      } else if (waited >= 30) {
        clearInterval(metaWatch);
        startLoopFallback("metadata still not in after 30s", false);
      }
    }, 1000);
  }

  if (video) selectPlateSource(wirePlate);

  /* -- state ---------------------------------------------------------------- */

  var smoothed = window.scrollY || 0;
  var lastTime = 0;
  var lastWritten = null;

  /* ==========================================================================
     The buta field

     A polar lattice cannot come out of a repeating background image — the
     rings have to be laid out — so it is built once here and rebuilt on
     resize. Nothing in the scroll loop touches it; the whole field is turned
     by a single CSS rotate on the parent.
     ====================================================================== */

  var weave = document.getElementById("weave");

  /* Deterministic hash noise. Every emblem gets the same jitter on every
     load and on every resize, so the field never reshuffles under the user. */
  function noise(i, k) {
    var v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  function buildWeave() {
    if (!weave) return;

    var W = CONFIG.weave;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = vw / 2;
    var cy = vh * W.centreY;

    root.style.setProperty("--stage-x", "50%");
    root.style.setProperty("--stage-y", W.centreY * 100 + "%");

    // Far enough to cover the corner the centre is furthest from, plus the
    // slack the parent's rotation needs so no corner ever swings empty.
    var reach = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy)) + W.size;

    var html = "";
    var ring = 0;

    for (var r = W.innerR; r < reach; r += W.ringGap, ring++) {
      var count = Math.max(4, Math.round(2 * Math.PI * r / W.arcGap));
      var step = 360 / count;
      var offset = (ring % 2) * step / 2;      // half-step stagger, ring to ring

      for (var i = 0; i < count; i++) {
        var seed = ring * 97 + i;
        var deg = offset + i * step + (noise(seed, 1) - 0.5) * step * 0.34;
        var rad = deg * Math.PI / 180;
        var rr = r + (noise(seed, 2) - 0.5) * W.ringGap * 0.3;

        var x = cx + Math.cos(rad) * rr;
        var y = cy + Math.sin(rad) * rr;
        if (x < -W.size || x > vw + W.size || y < -W.size || y > vh + W.size) continue;

        // Lean toward the radius. deg is measured from due east, so a fully
        // radial emblem is rotated (deg + 90). Wrap that to the SHORTEST
        // signed turn before damping it — without the wrap, an emblem at
        // due-left works out to +102 deg where its mirror on the right gets
        // +34, and the field leans lopsided.
        var radial = (deg + 90 + 180) % 360;
        if (radial < 0) radial += 360;
        radial -= 180;
        var tilt = radial * W.tilt + (noise(seed, 3) - 0.5) * 10;
        var size = W.size * (0.82 + noise(seed, 4) * 0.42);

        html += '<i class="buta" style="' +
          "--x:" + Math.round(x) + "px;" +
          "--y:" + Math.round(y) + "px;" +
          "--w:" + Math.round(size) + "px;" +
          "--a:" + Math.round(tilt) + "deg;" +
          "--buta-o:" + (0.16 + noise(seed, 5) * 0.16).toFixed(2) +
          '"></i>';
      }
    }

    weave.innerHTML = html;
  }

  /* Which pacing this viewport gets. Read on every resize, not just at boot,
     so turning a tablet from portrait to landscape re-paces the act instead
     of keeping whatever it booted with. */
  var phoneQ  = window.matchMedia("(max-width: 760px)");
  var tabletQ = window.matchMedia("(max-width: 1024px) and (pointer: coarse)");

  function applyPace() {
    var p = phoneQ.matches  ? CONFIG.pace.phone
          : tabletQ.matches ? CONFIG.pace.tablet
          :                   CONFIG.pace.desktop;
    CONFIG.actVh = p.actVh;
    CONFIG.tau = p.tau;
  }

  /** Size the act: the progress run plus the end hold, both in viewport
      heights. The stage stays pinned for (actVh + holdVh - 100)vh. */
  function sizeAct() {
    act.style.height = (CONFIG.actVh + CONFIG.holdVh) / 100 * window.innerHeight + "px";
  }

  /** The distance p is measured over — deliberately SHORTER than the pin, so
      p saturates at 1 with CONFIG.holdVh still left to scroll. That tail is
      the settle: everything has landed and nothing is still moving. */
  function progressSpan() {
    return Math.max(1, CONFIG.actVh / 100 * window.innerHeight - window.innerHeight);
  }

  function write(name, value) { root.style.setProperty(name, value); }

  /** The furthest point the browser says it can seek to, or 0 for none. */
  function seekableEnd() {
    var s = video.seekable;
    return s && s.length ? s.end(s.length - 1) : 0;
  }

  function scrubTo(p) {
    if (!videoReady || loopFallback) return;

    /* A host that does not serve byte ranges looks like THIS from in here:
       the whole file is buffered, duration is known, readyState is 4 — and
       `seekable` is still empty, so every assignment to currentTime silently
       snaps back to 0 and she sits frozen on the first frame.

       Nothing above catches it: no error fires, and no seek is ever issued,
       so the "seeks are not being honoured" timeout below never even arms.
       Judge it only once the data is all in, because `seekable` is legitimately
       empty while a file is still arriving. */
    if (video.readyState >= 4 && seekableEnd() <= 0) {
      startLoopFallback("the response is not byte-range seekable", true);
      return;
    }

    // Linear across the whole act, exactly as the wireframe scrubbed it. The
    // previous smoothstep over a 0.02–0.88 slice made her rush the middle of
    // the dance and then stall for the last eighth of the scroll.
    var target = p * Math.max(0, videoDuration - 0.04);

    if (!seeking && Math.abs(video.currentTime - target) > 1 / 60) {
      seeking = true;
      seekIssuedAt = performance.now();
      try { video.currentTime = target; } catch (e) { seeking = false; }
    }

    // A seek that was issued and never reported back means the host is not
    // serving byte ranges. That one IS fatal — no amount of waiting fixes it.
    if (seeking && performance.now() - seekIssuedAt > 3000) {
      startLoopFallback("seeks are not being honoured", true);
    }
  }

  function render(p) {
    var b = CONFIG.beats;

    var heroOut = seg(b.heroOut, p);

    // Each card is (arrival) x (1 - departure). Both terms feed the offset as
    // well as the opacity, so a card slides back out the same side it came in
    // rather than just dissolving in place.
    var e1 = seg(b.cardOneIn, p) * (1 - seg(b.cardOneOut, p));
    var e2 = seg(b.cardTwoIn, p) * (1 - seg(b.cardTwoOut, p));

    // The glow at her back: opens after card two arrives, closed again
    // before the burst and the hackathon take over — see CONFIG.beats above.
    var halo = seg(b.haloIn, p) * (1 - seg(b.haloOut, p));

    // The stage is empty from 80% on; the corner wash opens up to fill it.
    var burst = seg(b.burstIn, p) * (1 - seg(b.burstOut, p) * 0.5);
    var lock  = seg(b.lockIn, p);

    write("--p", n(p));
    write("--rot", n(p * CONFIG.rotation) + "deg");

    // The logo dims as the scene fills up, but never leaves — it stays put,
    // just quieter, so the top of the stage doesn't read as empty once the
    // dancer and cards take over.
    write("--hero-o", n(1 - heroOut * 0.9));
    write("--hero-y", n(-seg(b.heroY, p) * 10) + "px");

    // The petal ring breathes outward and brightens on the burst. Its own
    // fade-up is a load animation, so --ring-o drives stroke-opacity rather
    // than opacity — otherwise the animation would clobber it.
    write("--ring-o", n(0.88 + 0.12 * burst));
    write("--ring-s", n(1 + 0.09 * burst));

    // Cards slide in from their own side of the stage, hold, then slide back.
    write("--e1-o", n(e1));
    write("--e1-x", n(-46 * (1 - e1)) + "px");
    write("--e2-o", n(e2));
    write("--e2-x", n(46 * (1 - e2)) + "px");

    write("--cue-o", n(1 - seg(b.cueOut, p)));

    // The closing line needs the bottom of the stage to itself. Only --lock-o
    // is written: CSS derives the dancer's lift from it, so a short landscape
    // viewport can ask for a bigger lift without the engine knowing about it.
    write("--lock-o", n(lock));

    write("--halo-o", n(halo));

    // Flat black at rest, like the reference. The glow exists for the burst.
    write("--glow-o", n(burst));
  }

  function frame(now) {
    var dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 1 / 60;
    lastTime = now;

    var target = window.scrollY || window.pageYOffset || 0;

    // Frame-rate-independent exponential smoothing: the fraction of the
    // remaining gap closed this frame depends on elapsed time, not on how many
    // frames the display happens to deliver.
    smoothed += (target - smoothed) * (1 - Math.exp(-dt / CONFIG.tau));
    if (Math.abs(target - smoothed) < 0.15) smoothed = target;

    var p = clamp01((smoothed - act.offsetTop) / progressSpan());

    if (lastWritten === null || Math.abs(p - lastWritten) > 0.0002) {
      render(p);
      lastWritten = p;
    }
    scrubTo(p);

    requestAnimationFrame(frame);
  }

  /* -- reduced motion -------------------------------------------------------
     CSS already unpins the stage and reveals everything; park the plate on a
     representative frame and stay out of the way. */
  function startStatic() {
    if (!video) return;
    var park = function () {
      try { video.currentTime = (video.duration || 0) * 0.4; } catch (e) {}
    };
    if (video.readyState >= 1) park();
    video.addEventListener("loadedmetadata", park, { once: true });
  }

  /* ==========================================================================
     Hackathon pointer glow

     Writes the pointer position, in px relative to the section, into two CSS
     custom properties. CSS does the rest — see .hack__glow. Coalesced onto
     one rAF so a 1000Hz mouse cannot force more than one write per frame.
     ====================================================================== */

  function wirePointerGlow() {
    var hack = document.getElementById("hackathon");
    if (!hack || reduceMotion.matches) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    var px = 0, py = 0, queued = false;

    function flush() {
      queued = false;
      hack.style.setProperty("--mx", px + "px");
      hack.style.setProperty("--my", py + "px");
    }

    hack.addEventListener("pointermove", function (e) {
      var box = hack.getBoundingClientRect();
      px = Math.round(e.clientX - box.left);
      py = Math.round(e.clientY - box.top);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }, { passive: true });
  }

  var resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      buildWeave();
      if (reduceMotion.matches) return;   // CSS owns the layout in that mode
      applyPace();
      sizeAct();
      lastWritten = null;
    }, 120);
  }

  function start() {
    // The field is decoration, not motion — it is built in every mode, and
    // reduced motion returns before the scroll rig is wired up, so it needs
    // its own resize hookup rather than relying on onResize below.
    buildWeave();
    wirePointerGlow();
    window.addEventListener("resize", onResize, { passive: true });

    if (reduceMotion.matches) { startStatic(); return; }
    applyPace();
    sizeAct();
    smoothed = window.scrollY || 0;
    render(clamp01((smoothed - act.offsetTop) / progressSpan()));
    requestAnimationFrame(frame);
  }

  start();

  if (typeof reduceMotion.addEventListener === "function") {
    reduceMotion.addEventListener("change", function () { location.reload(); });
  }
})();
