import { useEffect, useRef, useState } from 'react';
import { fairnessLabel } from '../lib/meetings';

/* Ring geometry inside a 128-unit box. The stroke is 9 wide, so r=54 keeps the
   outer edge just inside the viewBox. */
const R = 54;
const CIRC = 2 * Math.PI * R;

const clamp = (n) => Math.max(0, Math.min(100, n));
const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion:reduce)').matches;

/**
 * Diverging hue centred on 50, the balance point: bright yellow at rest, warming
 * through orange to red as credit piles up, cooling through lime to green as debt
 * does. Only the hue is computed here; index.css picks the lightness per theme.
 */
const hueFor = (score) => {
  const drift = clamp(score) - 50;
  return drift >= 0
    ? 48 - 42 * (drift / 50)
    : 48 + 97 * (-drift / 50);
};

/** 1 at the balance point, 0 at either extreme. Lifts the yellow so it stays bright. */
const restFor = (score) => 1 - Math.abs(clamp(score) - 50) / 50;

/**
 * Tweens from whatever is on screen to `value`, so a refreshed score reads as
 * movement rather than a jump. Mount ramps from 0; a hidden tab skips the ramp.
 */
function useTween(value, ms = 900) {
  const still = reduced();
  const [shown, setShown] = useState(() =>
    (document.visibilityState === 'visible' && !still ? 0 : value));
  const current = useRef(shown);

  useEffect(() => {
    const from = current.current;
    if (still || from === value) return;
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, still]);

  /* Declared after the tween effect so it records the frame just committed. */
  useEffect(() => { current.current = shown; }, [shown]);

  return still ? value : shown;
}

/**
 * Circular fairness gauge, the centrepiece of the overview. `score` is 0–100,
 * `balance` the credit/debt figure behind it. A move since the last load is
 * flagged for a few seconds.
 */
export default function FairnessMeter({ score, balance = 0, onClick }) {
  const value = clamp(Math.round(score));
  const shown = useTween(value);

  const [delta, setDelta] = useState(0);
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    const moved = value - previous.current;
    previous.current = value;
    setDelta(moved);
    const t = setTimeout(() => setDelta(0), 8000);
    return () => clearTimeout(t);
  }, [value]);

  const body = (
    <>
      <div className="eyebrow">Fairness score</div>

      <div className="meter-ring">
        <svg viewBox="0 0 128 128" aria-hidden="true">
          <g transform="rotate(-90 64 64)">
            <circle className="meter-track" cx="64" cy="64" r={R} />
            <circle
              className="meter-fill" cx="64" cy="64" r={R}
              strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - clamp(shown) / 100)}
            />
          </g>
          {/* Notch at the 50 mark, which sits at the bottom of the sweep. */}
          <line className="meter-tick" x1="64" y1={64 + R - 7} x2="64" y2={64 + R + 7} />
        </svg>
        <div className="meter-c">
          <div className="meter-n">{Math.round(shown)}</div>
          <div className="meter-u">/ 100</div>
        </div>
      </div>

      <div className="meter-t">
        {fairnessLabel(value)}
        {delta !== 0 && (
          <span className="meter-d">{delta > 0 ? '▲' : '▼'} {Math.abs(delta)} just now</span>
        )}
      </div>

      <p className="meter-p">
        {balance > 0
          ? `${balance} points of credit banked. Awkward slots you accepted are owed back to you.`
          : balance < 0
            ? `${Math.abs(balance)} points of debt. The convenient slots you took are paid off over time.`
            : 'Level with everyone else. 50 is the resting point, and the balance decays 2% a day.'}
      </p>
      <div className="meter-f">Moves every time a meeting is booked or cancelled</div>
    </>
  );

  const label = `Fairness score ${value} out of 100, ${fairnessLabel(value).toLowerCase()}`;
  const hue = { '--h': hueFor(shown), '--y': restFor(shown) };  // travels with the sweep

  if (!onClick) return <div className="meter" style={hue} role="img" aria-label={label}>{body}</div>;
  return (
    <button
      type="button" className="meter click" style={hue}
      onClick={onClick} aria-label={`${label}. Open profile`}
    >{body}</button>
  );
}
