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
  let ticking = false;
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
   * SCROLL -> PROGRESS MAPPING
   * ---------------------------------------------------------------- */
  function apply(p) {
    root.style.setProperty('--p', p.toFixed(4));

    let best = 0, bestVal = 0;
    for (let i = 1; i <= BEAT_COUNT; i++) {
      const v = beatValue(p, BEATS[i]);
      root.style.setProperty('--p' + i, v.toFixed(4));
      if (v > bestVal) { bestVal = v; best = i; }
    }

    // The dominant beat gets `.is-live`, which is what releases its staggered
    // reveal. Content-heavy chapters unfold as you scroll into them rather
    // than arriving all at once, which is the whole point of a long journey.
    if (best !== liveBeat && bestVal > 0.55) {
      if (beatEls[liveBeat]) beatEls[liveBeat].classList.remove('is-live');
      if (beatEls[best]) beatEls[best].classList.add('is-live');
      liveBeat = best;
    }

    // Altitude rail — the persistent thread through the whole descent.
    const ft = Math.round(p * CEILING_FT / 100) * 100;
    if (altFill) altFill.style.setProperty('--alt', p.toFixed(4));
    if (altReadout) altReadout.textContent = ft.toLocaleString();

    if (beatValue(p, BEATS[8]) > 0.35 && !countersAnimated) animateCounters();
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (trackLocked) return;
      apply(clamp01(window.scrollY / maxScroll()));
      // No auto-transition — the Continue button handles the handover.
    });
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
      apply(1);
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
  apply(0);
  setPhase('cover');
})();
