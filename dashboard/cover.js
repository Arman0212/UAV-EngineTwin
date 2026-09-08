/**
 * ENGINE-TWIN: Cover chapter — scroll handover
 *
 * The cover and the console are two fixed layers of one document. This file
 * maps scroll position onto a handful of progress variables on :root; every
 * movement those variables cause is expressed in theme.css.
 *
 * That split is deliberate. Nothing here reads or writes layout, so no frame
 * can trigger a reflow: the browser only ever re-composites transform, opacity
 * and filter. It also means the choreography can be retimed by editing the
 * BEATS table below, without touching a single style.
 */

(() => {
  'use strict';

  const root = document.documentElement;
  const body = document.body;

  // Where each beat holds, in journey progress. Ranges overlap so one beat is
  // still leaving as the next arrives — a gap would read as a page change,
  // which is the exact thing this transition exists to avoid.
  // These ranges are tuned, not guessed. Simulating the journey with tighter
  // ranges showed three points where every beat had faded but the next had not
  // arrived — the screen went nearly empty, which reads as exactly the page
  // change this transition exists to remove. Each beat now still holds a third
  // of its presence as the next one reaches the same level.
  const BEATS = {
    A: { in: -0.20, hold: 0.00, out: 0.34 },   // masthead, on screen at rest
    B: { in:  0.13, hold: 0.40, out: 0.67 },   // thesis
    C: { in:  0.49, hold: 0.74, out: 0.93 }    // evidence
  };

  // The handover itself. The console begins arriving well before the cover has
  // finished leaving, so the two cross rather than hand off.
  const RECEDE = { from: 0.62, to: 1.00 };
  const REVEAL = { from: 0.52, to: 0.96 };

  // Past this the console is simply the site, and the journey is over.
  const SETTLE_AT = 0.995;

  const clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v);
  const ramp = (v, a, b) => (b === a) ? 1 : clamp01((v - a) / (b - a));

  // Smoothstep keeps the beats from arriving and leaving at constant speed,
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

  function maxScroll() {
    return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }

  function setPhase(next) {
    if (next === phase) return;
    phase = next;
    body.setAttribute('data-phase', next);

    // The 3D viewport is measured when the console is still behind the cover,
    // and on mobile the shell changes shape entirely when it settles. Tell the
    // renderer once it is live, or the model stays letterboxed.
    //
    // app.js declares engine3D with `let`, so it lives in the global lexical
    // scope rather than on `window` — reachable by name, but only once app.js
    // has actually run.
    if (next === 'app' && typeof engine3D !== 'undefined' && engine3D &&
        typeof engine3D.onWindowResize === 'function') {
      requestAnimationFrame(() => engine3D.onWindowResize());
    }
  }

  /**
   * Once the console is live, the scroll track collapses to nothing.
   *
   * Without this, a stray wheel gesture over a panel would drag the operator
   * back out to the cover mid-fault. Both layers are fixed, so removing the
   * track moves nothing on screen — the page simply stops having anywhere to
   * scroll, and `returnToCover()` is the only way back.
   */
  function lockTrack(locked) {
    if (locked === trackLocked) return;
    trackLocked = locked;
    root.style.setProperty('--track', locked ? '0px' : '');
  }

  function apply(p) {
    root.style.setProperty('--p', p.toFixed(4));
    root.style.setProperty('--pA', beatValue(p, BEATS.A).toFixed(4));
    root.style.setProperty('--pB', beatValue(p, BEATS.B).toFixed(4));
    root.style.setProperty('--pC', beatValue(p, BEATS.C).toFixed(4));
    root.style.setProperty('--pR', smooth(ramp(p, RECEDE.from, RECEDE.to)).toFixed(4));
    root.style.setProperty('--pApp', smooth(ramp(p, REVEAL.from, REVEAL.to)).toFixed(4));
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (trackLocked) return;               // nothing left to map

      const p = clamp01(window.scrollY / maxScroll());
      apply(p);

      if (p >= SETTLE_AT) {
        apply(1);
        setPhase('app');
        lockTrack(true);
      } else {
        setPhase('cover');
      }
    });
  }

  /** Reopens the journey and walks back to the top of it. */
  window.returnToCover = function returnToCover() {
    lockTrack(false);
    setPhase('cover');

    // Restore the scroll position the console was settled at, so the cover
    // reappears from where it went rather than jumping into frame.
    requestAnimationFrame(() => {
      window.scrollTo(0, maxScroll());
      apply(1);
      requestAnimationFrame(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      });
    });
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (!trackLocked) onScroll();
  }, { passive: true });

  // Browsers restore scroll position on reload, which would drop the visitor
  // mid-transition with no context. The journey always starts at its start.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  apply(0);
  setPhase('cover');
})();
