import { useState, useEffect } from 'react';
import { apiGet } from '../apiClient';
import { Ico } from '../ui/Primitives.jsx';
import { initials, fairnessLabel, fairnessVar, tier } from '../lib/meetings';

export default function PublicProfile({ profile, currentUserId, onClose, onScheduleWith }) {
  const [shared, setShared] = useState(null);

  useEffect(() => {
    if (!profile?.id || !currentUserId || profile.id === currentUserId) return;
    apiGet(`/api/users/${profile.id}/shared_meetings`).then(setShared).catch(() => {});
  }, [profile?.id, currentUserId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = profile.name || profile.displayName || 'Unknown';
  const raw = profile.score ?? profile.fairness_score;
  const score = raw == null ? null : Math.round(raw);

  return (
    <div className="veil" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mod" style={{ width: 540 }}>
        <div className="mod-h">
          <div>
            <div className="eyebrow">{profile.role || 'Teammate'}{profile.department ? ` · ${profile.department}` : ''}</div>
            <h2>{name}</h2>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>

        <div className="mod-b">
          <div className="pp-hero">
            <div className="pp-av">{initials(name)}</div>
            <div>
              <div className="f-name">{profile.status || profile.statusMessage || 'No status set'}</div>
              {shared?.count > 0 && (
                <div className="f-hint" style={{ marginTop: 6 }}>
                  {shared.count} meeting{shared.count === 1 ? '' : 's'} with you
                  {shared.recentTitles?.length ? ` · ${shared.recentTitles.slice(0, 2).join(', ')}` : ''}
                </div>
              )}
            </div>
            {score != null && (
              <div className="pp-sc">
                <div className="pp-sc-n" style={{ color: fairnessVar(score) }}>{score}</div>
                <div className="eyebrow">Fairness</div>
              </div>
            )}
          </div>

          {score != null && (
            <div className="f-row">
              <div className="f-lab">Standing</div>
              <div style={{ paddingTop: 8 }}>
                <div className="gauge-t" style={{ marginTop: 0 }}>
                  <i className={`f-${tier(score)}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
                </div>
                <div className="f-hint">
                  {fairnessLabel(score)} · above 50 means they're owed a convenient slot
                </div>
              </div>
            </div>
          )}

          <div className="f-row">
            <div className="f-lab">Bio</div>
            <div style={{ paddingTop: 7, fontSize: 13, lineHeight: 1.65, color: 'var(--ink-2)' }}>
              {profile.bio || 'No bio yet.'}
            </div>
          </div>

          <div className="f-row">
            <div className="f-lab">Skills</div>
            <div style={{ paddingTop: 4 }}>
              {(profile.skills || []).length === 0 ? (
                <span className="f-hint" style={{ margin: 0 }}>None listed.</span>
              ) : (
                <div className="chip-row">
                  {profile.skills.map(s => <span key={s} className="chip">{s}</span>)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mod-f">
          <button className="btn g" onClick={onClose}>Close</button>
          {/* The public-profile payload omits email, so fall back to the id —
              the create modal resolves either against the directory. */}
          {onScheduleWith && (profile.email || profile.id) && (
            <button className="btn p" onClick={() => { onClose(); onScheduleWith(profile.email || profile.id); }}>
              <Ico n="plus" s={13} /> Schedule with {name.split(' ')[0]}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
