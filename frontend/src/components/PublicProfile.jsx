import { useState, useEffect } from 'react';
import { apiGet } from '../apiClient';
import { X, Users, CalendarPlus } from 'lucide-react';
import './PublicProfile.css';
import { fairnessColor } from '../fairnessColor';

export default function PublicProfile({ profile, onClose, onScheduleWith, currentUserId }) {
  const [sharedMeetings, setSharedMeetings] = useState(null);

  useEffect(() => {
    if (profile?.id && currentUserId && profile.id !== currentUserId) {
      apiGet(`/api/users/${profile.id}/shared_meetings`)
        .then(setSharedMeetings)
        .catch(() => {});
    }
  }, [profile?.id, currentUserId]);

  const displayName = profile.name || profile.displayName || '';
  const initials = displayName
    ? displayName.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '??';

  const score = Math.round(profile.fairness_score ?? profile.score ?? 100);
  const scoreColor = fairnessColor(score);

  return (
    <div className="pp-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="pp-modal">
        <button className="pp-close" onClick={onClose}><X size={14} /></button>

        <div className="pp-head">
          <div className="pp-avatar">{initials}</div>
          <div className="pp-info">
            <h2 className="pp-name">{displayName || 'Unknown'}</h2>
            <div className="pp-badges">
              <span className="pp-role">{profile.role || 'Teammate'}</span>
              <span className="pp-dept">{profile.department || 'Smart Co.'}</span>
            </div>
            {(profile.status || profile.statusMessage) && (
              <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.4rem' }}>
                {profile.status || profile.statusMessage}
              </div>
            )}
            {sharedMeetings?.count > 0 && (
              <div style={{ fontSize: '0.74rem', color: 'var(--accent-color)', marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <Users size={12} />{sharedMeetings.count} meeting{sharedMeetings.count !== 1 ? 's' : ''} together
              </div>
            )}
          </div>
          <div className="pp-gauge">
             <div className="pp-gauge-val" style={{ color: scoreColor }}>{score}</div>
             <div className="pp-gauge-label">FAIRNESS</div>
          </div>
        </div>

        <div className="pp-body">
          <section className="pp-section">
            <label>BIO</label>
            <p>{profile.bio || "This user hasn't added a bio yet."}</p>
          </section>

          <section className="pp-section">
            <label>SKILLS</label>
            <div className="pp-skills">
              {(profile.skills || []).map(s => <span key={s} className="pp-skill">{s}</span>)}
              {(profile.skills || []).length === 0 && <span className="empty-hint">No skills listed</span>}
            </div>
          </section>

          {onScheduleWith && (
            <section className="pp-section">
              <label>QUICK ACTIONS</label>
              <div className="pp-quick-actions">
                <button
                  className="pp-action-btn pp-schedule-btn"
                  onClick={() => { onClose(); onScheduleWith(profile.email); }}
                >
                  <CalendarPlus size={13} style={{ marginRight: '0.3rem', verticalAlign: 'middle' }} />Schedule Meeting
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
