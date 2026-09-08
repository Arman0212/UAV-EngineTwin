/**
 * ENGINE-TWIN: Cover chapter — infinity-scroll introduction
 *
 * The cover and the console are two fixed layers of one document. This file
 * maps scroll position onto progress variables on :root; theme.css expresses
 * every movement. Nothing here reads layout, so no frame triggers a reflow —
 * the browser only re-composites transform, opacity and filter.
 *
 * Beat ranges are generated rather than hand-tabulated. With twenty-plus
 * chapters a hand-written table drifts out of balance the moment one is
 * inserted, and an uneven gap between two beats is exactly what reads as a
 * page change.
 */

(() => {
  'use strict';

  const root = document.documentElement;
  const body = document.body;

  /* ------------------------------------------------------------------
   * BEAT GEOMETRY
   *
   * Beats are spaced evenly across the journey and each one lives well
   * into its neighbours' territory. OVERLAP is the fraction of the gap a
   * beat keeps fading over: at 0.85 a beat is still carrying 40% of the
   * frame at the moment its successor reaches the same level, so the
   * screen is never close to empty between chapters.
   * ---------------------------------------------------------------- */
  const BEAT_COUNT = 22;
  const OVERLAP = 0.85;
  const SPAN = 1 / (BEAT_COUNT - 1);

  const BEATS = {};
  for (let i = 1; i <= BEAT_COUNT; i++) {
    const hold = (i - 1) * SPAN;
    BEATS[i] = {
      in: hold - SPAN * OVERLAP,
      hold,
      // The closing beat holds past the end of the journey so it stays put
      // once there is nothing left to scroll.
      out: (i === BEAT_COUNT) ? hold + SPAN : hold + SPAN * OVERLAP
    };
  }

  // Altitude readout. The journey is a climb — this is a UAV project, and
  // tying descent-through-the-page to ascent-through-the-envelope is the one
  // metaphor the subject actually supplies.
  const CEILING_FT = 30000;

  const clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v);
  const ramp = (v, a, b) => (b === a) ? 1 : clamp01((v - a) / (b - a));

  // Smoothstep keeps beats from arriving and leaving at constant speed,
  // which is what separates "cinematic" from "linked to a scrollbar".
  const smooth = (t) => t * t * (3 - 2 * t);

  /** A beat fades in, holds, then fades out — one value, 0..1. */
  function beatValue(p, beat) {
    if (p <= beat.hold) return smooth(ramp(p, beat.in, beat.hold));
    return 1 - smooth(ramp(p, beat.hold, beat.out));
  }

  let phase = null;
  let trackLocked = false;
  let countersAnimated = false;
  let liveBeat = 0;

  const beatEls = {};
  let altFill = null;
  let altReadout = null;

  function cacheNodes() {
    for (let i = 1; i <= BEAT_COUNT; i++) {
      beatEls[i] = document.querySelector('.beat-' + i);
    }
    altFill = document.getElementById('alt-fill');
    altReadout = document.getElementById('alt-readout');
  }

  function maxScroll() {
    return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }

  function setPhase(next) {
    if (next === phase) return;
    phase = next;
    body.setAttribute('data-phase', next);

    // The 3D viewport is measured while the console is still behind the cover.
    // Tell the renderer once it is live, or the model stays letterboxed.
    if (next === 'app' && typeof engine3D !== 'undefined' && engine3D &&
        typeof engine3D.onWindowResize === 'function') {
      requestAnimationFrame(() => engine3D.onWindowResize());
    }
  }

  /**
   * Once the console is live the scroll track collapses to nothing.
   * Without this, a stray wheel gesture would drag the operator back to the
   * cover mid-fault. Both layers are fixed, so removing the track moves
   * nothing on screen.
   */
  function lockTrack(locked) {
    if (locked === trackLocked) return;
    trackLocked = locked;
    root.style.setProperty('--track', locked ? '0px' : '');
  }

  /* ------------------------------------------------------------------
   * COUNTER ANIMATION
   * When the statistics beat becomes visible, the numbers count up.
   * ---------------------------------------------------------------- */
  function animateCounters() {
    if (countersAnimated) return;
    countersAnimated = true;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const els = document.querySelectorAll('.stat-number[data-target]');

    els.forEach(el => {
      const target = parseFloat(el.dataset.target);
      const isFloat = target % 1 !== 0;
      const render = (v) => {
        if (target >= 1000) el.textContent = Math.round(v).toLocaleString();
        else if (isFloat) el.textContent = v.toFixed(target < 10 ? 2 : 1);
        else el.textContent = Math.round(v);
      };

      if (reduced) { render(target); return; }

      const duration = 1400;
      const start = performance.now();
      function tick(now) {
        const t = Math.min((now - start) / duration, 1);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        render(target * eased);
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  /* ------------------------------------------------------------------
   * RENDER LOOP
   *
   * Two problems made the journey feel rough, and they are different:
   *
   *  1. COST. Writing --p1..--p22 on :root invalidated style for the entire
   *     document every frame. Each chapter now owns its own --v, so a write
   *     touches one element instead of all of them, and only chapters near
   *     the playhead are written to or painted at all.
   *
   *  2. CADENCE. A wheel notch moves the page ~100px in one jump. Mapping
   *     that straight onto progress makes the chapters step rather than
   *     glide, which reads as jerky even at a solid 60fps. So the rendered
   *     position chases the scroll position instead of equalling it, and the
   *     easing between them is what the eye actually reads as smoothness.
   * ---------------------------------------------------------------- */

  // How quickly the render catches the scroll. Lower is heavier and smoother;
  // too low and the page feels detached from the wheel.
  const CHASE = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 1.0    // no easing: render exactly where the scroll is
    : 0.12;
  const EPSILON = 0.00015;      // below this, stop rendering entirely
  const NEAR_RANGE = 2;         // chapters kept painted either side of the playhead

  let pTarget = 0;
  let pRender = 0;
  let running = false;
  let nearFrom = -1, nearTo = -1;

  const lastV = new Array(BEAT_COUNT + 1).fill(-1);

  /** Marks which chapters are close enough to be worth painting. */
  function setNearWindow(centre) {
    const from = Math.max(1, centre - NEAR_RANGE);
    const to = Math.min(BEAT_COUNT, centre + NEAR_RANGE);
    if (from === nearFrom && to === nearTo) return;

    for (let i = 1; i <= BEAT_COUNT; i++) {
      const el = beatEls[i];
      if (!el) continue;
      const shouldBeNear = i >= from && i <= to;
      const wasNear = i >= nearFrom && i <= nearTo;
      if (shouldBeNear === wasNear) continue;
      el.classList.toggle('is-near', shouldBeNear);
      // A chapter leaving the window is fully cleared, so it cannot be left
      // frozen at a partial opacity when the playhead jumps.
      if (!shouldBeNear && lastV[i] !== 0) {
        el.style.setProperty('--v', '0');
        lastV[i] = 0;
      }
    }
    nearFrom = from; nearTo = to;
  }

  function render(p) {
    // One global write, for the things that genuinely span the whole cover:
    // the parallax plates, the progress rail and the altitude gauge.
    root.style.setProperty('--p', p.toFixed(4));

    const centre = Math.round(p / SPAN) + 1;
    setNearWindow(centre);

    let best = 0, bestVal = 0;
    for (let i = nearFrom; i <= nearTo; i++) {
      const el = beatEls[i];
      if (!el) continue;
      const v = beatValue(p, BEATS[i]);
      // Skip the write when nothing visible changed.
      if (Math.abs(v - lastV[i]) > 0.002) {
        el.style.setProperty('--v', v.toFixed(4));
        lastV[i] = v;
      }
      if (v > bestVal) { bestVal = v; best = i; }
    }

    // The dominant chapter releases its staggered reveal.
    if (best !== liveBeat && bestVal > 0.55) {
      if (beatEls[liveBeat]) beatEls[liveBeat].classList.remove('is-live');
      if (beatEls[best]) beatEls[best].classList.add('is-live');
      liveBeat = best;
    }

    if (altFill) altFill.style.setProperty('--alt', p.toFixed(4));
    if (altReadout) {
      const ft = Math.round(p * CEILING_FT / 100) * 100;
      altReadout.textContent = ft.toLocaleString();
    }

    if (beatValue(p, BEATS[8]) > 0.35 && !countersAnimated) animateCounters();
  }

  function frame() {
    const delta = pTarget - pRender;

    if (Math.abs(delta) < EPSILON) {
      pRender = pTarget;
      render(pRender);
      running = false;              // settled — stop burning frames
      return;
    }

    pRender += delta * CHASE;
    render(pRender);
    requestAnimationFrame(frame);
  }

  function kick() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }

  /** Jumps straight to a position without easing, for resets. */
  function snapTo(p) {
    pTarget = pRender = p;
    render(p);
  }

  function onScroll() {
    if (trackLocked) return;
    pTarget = clamp01(window.scrollY / maxScroll());
    kick();
  }

  /* ------------------------------------------------------------------
   * COVER -> APP TRANSITION
   * ---------------------------------------------------------------- */
  window.enterApp = function enterApp() {
    const cover = document.getElementById('cover');
    const appShell = document.getElementById('app-shell');
    if (!cover || !appShell) return;

    const btn = document.getElementById('btn-enter-app');
    if (btn) btn.disabled = true;

    cover.classList.add('cover-exit');
    appShell.classList.add('app-entering');

    setTimeout(() => {
      setPhase('app');
      lockTrack(true);
      cover.classList.remove('cover-exit');
      appShell.classList.remove('app-entering');
      if (btn) btn.disabled = false;
    }, 750);
  };

  /* ------------------------------------------------------------------
   * APP -> COVER RETURN
   * ---------------------------------------------------------------- */
  window.returnToCover = function returnToCover() {
    lockTrack(false);
    setPhase('cover');

    countersAnimated = false;
    document.querySelectorAll('.stat-number[data-target]').forEach(el => {
      el.textContent = '0';
    });

    requestAnimationFrame(() => {
      window.scrollTo(0, maxScroll());
      snapTo(1);
      requestAnimationFrame(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      });
    });
  };

  /** Jumps the journey to a chapter, used by the chapter rail. */
  window.goToBeat = function goToBeat(n) {
    if (trackLocked) return;
    const target = clamp01((n - 1) * SPAN) * maxScroll();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
  };

  /* ------------------------------------------------------------------
   * EVENT WIRING
   * ---------------------------------------------------------------- */
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { if (!trackLocked) onScroll(); },
                          { passive: true });

  // Gate the staggered-reveal styles on JS having run. If this file fails to
  // load, every chapter still renders its content rather than staying blank.
  root.classList.add('cover-js');

  cacheNodes();

  // Browsers restore scroll position on reload; the journey always starts fresh.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  snapTo(0);
  setPhase('cover');
})();
