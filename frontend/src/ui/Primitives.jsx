import { useState, useEffect } from 'react';
import { tier } from '../lib/meetings';

/* ─────────────────────────────────────────────
   Shared primitives for the editorial design system.
   Single hairline icon set, score bars, avatar stacks,
   numbered section heads — all token-driven.
───────────────────────────────────────────── */

const PATHS = {
  dashboard: <path d="M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z" />,
  meetings: <><rect x="3" y="4.5" width="18" height="16" rx="1" /><path d="M8 2.5v4M16 2.5v4M3 9.5h18" /><path d="M9 14.5l2 2 4-4" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16" rx="1" /><path d="M8 2.5v4M16 2.5v4M3 9.5h18" /></>,
  people: <><path d="M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20" /><circle cx="10" cy="8" r="3.5" /><path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.7a3.5 3.5 0 0 1 0 6.6" /></>,
  profile: <><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1.1z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  bell: <><path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5" /><path d="M13.7 19.5a2 2 0 0 1-3.4 0" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8" />,
  arrow: <path d="M5 12h13M13 6l6 6-6 6" />,
  back: <path d="M19 12H6M11 6l-6 6 6 6" />,
  spark: <><path d="M12 3l1.7 4.9L18.5 9l-4.8 1.6L12 15.5l-1.7-4.9L5.5 9l4.8-1.1z" /><path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></>,
  refresh: <><path d="M20.5 11a8.5 8.5 0 0 0-14.6-4.6L3.5 8.7" /><path d="M3.5 13a8.5 8.5 0 0 0 14.6 4.6l2.4-2.3" /><path d="M3.5 4.5v4.2h4.2M20.5 19.5v-4.2h-4.2" /></>,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  ban: <><circle cx="12" cy="12" r="8.5" /><path d="M6 18L18 6" /></>,
  pencil: <><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  trash: <><path d="M4 6.5h16M9.5 6.5V4h5v2.5" /><path d="M6.5 6.5l1 13.5h9l1-13.5" /><path d="M10.5 10.5v6M13.5 10.5v6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.3l3.3 2" /></>,
  chevron: <path d="M6 9.5l6 6 6-6" />,
  prev: <path d="M14.5 5.5l-7 6.5 7 6.5" />,
  next: <path d="M9.5 5.5l7 6.5-7 6.5" />,
  link: <><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.7 1.7" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.7-1.7" /></>,
  download: <><path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5" /><path d="M4 19.5h16" /></>,
  alert: <><path d="M12 3.5L2.5 20h19z" /><path d="M12 9.5v5M12 17.2v.3" /></>,
  logout: <><path d="M9.5 20H5.5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5.5 4h4" /><path d="M15.5 16.5l4.5-4.5-4.5-4.5M20 12H9.5" /></>,
  copy: <><rect x="8.5" y="8.5" width="12" height="12" rx="1.5" /><path d="M5.5 15.5h-.5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 3.5h9A1.5 1.5 0 0 1 15.5 5v.5" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></>,
  cmd: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
};

export function Ico({ n, s = 15 }) {
  const d = PATHS[n];
  if (!d) return null;
  return (
    <svg
      width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >{d}</svg>
  );
}

/**
 * Counts up to `to` on mount. Only the eased progress is stateful, so the
 * displayed value stays derived from `to` — a later data refresh shows the new
 * number immediately instead of re-animating, and hidden tabs skip the ramp.
 */
export function Count({ to, ms = 620 }) {
  const [progress, setProgress] = useState(() => (document.visibilityState === 'visible' ? 0 : 1));
  useEffect(() => {
    if (document.visibilityState !== 'visible') return;
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      setProgress(1 - Math.pow(1 - k, 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ms]);
  return <>{Math.round(to * progress)}</>;
}

/** Overlapping avatar row. `people` is [{ id, name, initials }]. */
export function Stack({ people, max = 4 }) {
  const show = people.slice(0, max);
  const rest = people.length - show.length;
  if (!people.length) return <span className="score-na">-</span>;
  return (
    <div className="stack">
      {show.map(p => <div key={p.id} className="mono-av" title={p.name}>{p.initials}</div>)}
      {rest > 0 && <div className="mono-av">+{rest}</div>}
    </div>
  );
}

/** Fairness value 0–100 with a tinted bar. Renders a dash when unscored. */
export function Score({ v }) {
  if (v == null || Number.isNaN(v)) return <span className="score-na">-</span>;
  const n = Math.round(v);
  const t = tier(n);
  return (
    <div className="score">
      <span className={`score-n ${t}`}>{n}</span>
      <span className="score-b"><i className={`f-${t}`} style={{ width: `${Math.max(0, Math.min(100, n))}%` }} /></span>
    </div>
  );
}

export function SecHead({ n, title, aside }) {
  return (
    <div className="sec-head">
      {n && <span className="sec-n">{n}</span>}
      <span className="sec-t">{title}</span>
      {aside && <span className="sec-x">{aside}</span>}
    </div>
  );
}

export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      className={`sw${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    ><i /></button>
  );
}

export function StatusDot({ status }) {
  return <i className={`dot ${status}`} />;
}
