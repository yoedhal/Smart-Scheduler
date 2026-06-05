import { useState } from 'react';
import FairnessBreakdown from './FairnessBreakdown.jsx';
import { fairnessColor, fairnessLabel } from '../../fairnessColor';

export default function FairnessTab({ profile, onProfileUpdate, defaultExpanded = false }) {
  const [showFairnessExplainer, setShowFairnessExplainer] = useState(defaultExpanded);

  const score      = Math.round(profile.fairness_score ?? 100);
  const scoreColor = fairnessColor(score);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      {/* Score card */}
      <div className="pv-card">
        <h3>Fairness Score</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', marginTop: '1rem', flexWrap: 'wrap' }}>
          {/* Circular progress */}
          <div style={{ position: 'relative', width: '96px', height: '96px', flexShrink: 0 }}>
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="40" fill="none" stroke="var(--bg-raised)" strokeWidth="8" />
              <circle
                cx="48" cy="48" r="40"
                fill="none"
                stroke={scoreColor}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 40}`}
                strokeDashoffset={`${2 * Math.PI * 40 * (1 - score / 100)}`}
                transform="rotate(-90 48 48)"
                style={{ transition: 'stroke-dashoffset 1s ease' }}
              />
            </svg>
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: '1.4rem', fontWeight: 800, color: scoreColor }}>{score}</span>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>/ 100</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
              {fairnessLabel(score)}
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
              Top {Math.max(1, 100 - score + 5)}% of your organization
            </div>
            <span style={{
              display: 'inline-block', padding: '0.2rem 0.65rem',
              borderRadius: '20px', fontSize: '0.72rem', fontWeight: 700,
              background: `${scoreColor}1f`,
              color: scoreColor,
              border: `1px solid ${scoreColor}33`,
            }}>
              {score >= 75 ? 'Top performer' : score >= 50 ? 'On track' : score >= 30 ? 'Building credit' : 'At risk'}
            </span>
          </div>
        </div>
      </div>

      {/* Score breakdown */}
      <FairnessBreakdown profile={profile} score={score} onUpdated={p => onProfileUpdate?.(p)} />

      {/* How scoring works explainer */}
      <div className="pv-card">
        <button
          onClick={() => setShowFairnessExplainer(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            width: '100%', padding: 0,
            color: 'var(--text-primary)', fontFamily: 'inherit',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 600 }}>How is my score calculated?</h3>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{showFairnessExplainer ? '▲' : '▼'}</span>
        </button>
        {showFairnessExplainer && (
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {[
              { label: '50 = neutral starting point', desc: 'Everyone starts at 50. Above 50 means you\'re owed a good slot; below 50 means you\'ve been getting good slots.' },
              { label: '+15 for a weekend meeting', desc: 'Accepting a meeting on the weekend is a significant sacrifice — you earn priority for next time.' },
              { label: '+8 for an off-peak meeting', desc: 'Accepting early morning or late afternoon slots earns you credit.' },
              { label: '−4 for standard working hours', desc: 'A normal meeting at a convenient time has a small cost — others who sacrificed should get priority.' },
              { label: '−10 for prime-time meeting', desc: 'Getting a 10am–3pm weekday slot is a great deal — your score drops so others get priority next.' },
              { label: '−5 for cancelling a meeting', desc: 'Cancellations penalise your balance since you disrupted others\' schedules.' },
              { label: 'Balance drifts toward 0 over time', desc: 'Old history fades at 2%/day so your score naturally resets if you stop scheduling.' },
            ].map((item, i) => (
              <div key={i} style={{
                display: 'flex', gap: '0.75rem', padding: '0.6rem 0.8rem',
                background: 'var(--bg-raised)', borderRadius: 'var(--radius-sm)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{item.label}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
