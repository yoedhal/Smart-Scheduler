import { useMemo, useState } from 'react';
import { fairnessColor, fairnessLabel } from '../fairnessColor';

export default function DashboardView({ profile, meetings, onNavigate, needsAction, isCalendarConnected, onConnectCalendar, onNewMeeting, onNewMeetingFromText, onViewFairness }) {
  const [aiText, setAiText] = useState('');
  const [aiParsing, setAiParsing] = useState(false);

  const submitAi = async () => {
    const text = aiText.trim();
    if (!text || aiParsing) return;
    setAiParsing(true);
    try {
      await onNewMeetingFromText?.(text);
      setAiText('');
    } finally {
      setAiParsing(false);
    }
  };

  const myPending    = meetings.filter(m => m.status === 'pending' && m.userRole === 'organizer');
  const confirmed    = meetings.filter(m => m.status === 'confirmed');
  const total        = meetings.length;
  const organized    = meetings.filter(m => m.userRole === 'organizer').length;
  const invited      = meetings.filter(m => m.userRole === 'participant').length;
  const score        = Number.isFinite(Number(profile.fairness_score)) ? Math.round(Number(profile.fairness_score)) : 100;
  const scoreColor   = fairnessColor(score);
  const thisWeek     = profile.details?.meetings_this_week ?? 0;

  // Deterministic fairness trend — linear from (score + thisWeek*2) 6 days ago to score today
  const trend = useMemo(() => {
    const startScore = Math.min(100, score + thisWeek * 2);
    return Array.from({ length: 7 }, (_, i) => {
      const t = i / 6;
      return Math.max(0, Math.min(100, startScore + (score - startScore) * t));
    });
  }, [score, thisWeek]);

  // Day labels: last 7 days including today
  const dayLabels = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return days[d.getDay()];
    });
  }, []);

  const trendMax = Math.max(...trend, score + 1);
  const trendMin = Math.min(...trend, Math.max(0, score - 1));
  const trendRange = trendMax - trendMin || 1;

  // Insights based on score and activity
  const insights = [];
  if (score < 60) insights.push({ emoji: '📈', text: 'Boost your score by accepting meetings at less convenient times.' });
  if (myPending.length > 0) insights.push({ emoji: '⏳', text: `You have ${myPending.length} pending decision${myPending.length > 1 ? 's' : ''}. Decide today!` });
  if (confirmed.length > 5) insights.push({ emoji: '🎯', text: 'You\'re very busy! Consider scheduling breaks between meetings.' });
  if (needsAction > 0) insights.push({ emoji: '🔔', text: `${needsAction} meeting${needsAction > 1 ? 's' : ''} await your response.` });
  if (insights.length === 0) insights.push({ emoji: '⭐', text: 'Everything is running smoothly!' });

  return (
    <div className="dashboard">
      {/* Hero */}
      <div className="dash-hero">
        <div>
          <h1 className="dash-greeting">Welcome back, {(profile.name || profile.displayName || 'there').split(' ')[0]}</h1>
          <p className="dash-subtitle">Your scheduling hub — analytics, meetings & insights</p>
        </div>
        {isCalendarConnected ? (
          <button className="btn-primary" onClick={onNewMeeting}>+ New Meeting</button>
        ) : (
          <button className="btn-primary" style={{ opacity: 0.5 }} onClick={onConnectCalendar} title="Connect your Google Calendar to create meetings">
            + New Meeting
          </button>
        )}
      </div>
      {!isCalendarConnected && (
        <div className="insight-banner" style={{ marginBottom: '1rem', borderColor: 'rgba(96,165,250,0.25)', background: 'rgba(96,165,250,0.06)', cursor: 'pointer' }} onClick={onConnectCalendar}>
          <span style={{ color: '#60a5fa' }}>📅</span>
          <span>
            <strong>Connect Google Calendar</strong> to create or approve meetings.{' '}
            <span style={{ color: 'var(--accent)' }}>Go to Calendar settings →</span>
          </span>
        </div>
      )}

      {/* Action banner */}
      {needsAction > 0 && (
        <div
          className="insight-banner"
          style={{ marginBottom: '1.5rem', cursor: 'pointer', borderColor: 'rgba(251,191,36,0.25)', background: 'rgba(251,191,36,0.06)' }}
          onClick={() => onNavigate('meetings')}
        >
          <span style={{ color: 'var(--warning)' }}>&#9679;</span>
          <span>
            <strong>{needsAction}</strong> meeting{needsAction > 1 ? 's' : ''} awaiting your acceptance.{' '}
            <span style={{ color: 'var(--accent)' }}>View →</span>
          </span>
        </div>
      )}

      {/* Fairness Score — dominant hero */}
      <div className="fairness-hero" style={{ '--score-color': scoreColor }}>
        <div className="fairness-hero-ring" style={{ background: `conic-gradient(${scoreColor} ${score * 3.6}deg, rgba(255,255,255,0.07) 0deg)` }}>
          <div className="fairness-hero-ring-inner">
            <div className="fairness-hero-score" style={{ color: scoreColor }}>{score}</div>
            <div className="fairness-hero-max">/ 100</div>
          </div>
        </div>
        <div className="fairness-hero-body">
          <div className="fairness-hero-label">Fairness Score</div>
          <div className="fairness-hero-status" style={{ color: scoreColor }}>
            {fairnessLabel(score)}
          </div>
          <p className="fairness-hero-desc">
            Your scheduling fairness across all meetings. Starts at 50 (neutral) — it rises when you
            accept weekend or off-peak slots and dips for prime-time slots and cancellations.
          </p>
          <button type="button" className="fairness-hero-link" onClick={onViewFairness}>
            How is this calculated? →
          </button>
        </div>
      </div>

      {/* AI meeting setup */}
      <div className="ai-setup">
        <textarea
          className="ai-setup-input"
          value={aiText}
          onChange={(e) => setAiText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAi(); } }}
          placeholder="30 min sync with Dana next Tuesday afternoon"
          rows={3}
          disabled={aiParsing}
        />
        <div className="ai-setup-footer">
          <span className="ai-setup-hint"> Describe a meeting in plain language</span>
          {aiText.trim() ? (
            <button
              className="btn-primary ai-setup-btn ai-setup-btn--icon"
              onClick={submitAi}
              disabled={aiParsing}
              aria-label="Set up with AI"
              title="Set up with AI"
            >
              {aiParsing ? (
                <span className="ai-setup-spinner" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>
          ) : (
            <button className="btn-primary ai-setup-btn" onClick={submitAi} disabled>
              Set up with AI
            </button>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-body">
            <div className="stat-value">{total}</div>
            <div className="stat-label">Total Meetings</div>
            <div className="stat-subtext">{organized} organized · {invited} invited</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-body">
            <div className="stat-value">{confirmed.length}</div>
            <div className="stat-label">Confirmed</div>
            <div className="stat-subtext">{myPending.length} pending selection</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-body">
            <div className="stat-value">{thisWeek}</div>
            <div className="stat-label">This Week</div>
            <div className="stat-subtext">Next 7 days</div>
          </div>
        </div>
      </div>

      {/* Fairness trend */}
      <div className="dash-card" style={{ marginBottom: '1.25rem' }}>
        <div className="dash-card-head">
          <h3>Fairness Score — Last 7 Days</h3>
          <span className="pill" style={{ background: scoreColor + '22', color: scoreColor, border: `1px solid ${scoreColor}44` }}>
            {Math.round(trend[6] - trend[0]) >= 0 ? '+' : ''}{Math.round(trend[6] - trend[0])} pts this week
          </span>
        </div>
        <div style={{ position: 'relative', paddingLeft: '2.5rem' }}>
          {/* Y-axis labels */}
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: '1.5rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'right', width: '2rem' }}>
            <span>{Math.round(trendMax)}</span>
            <span>{Math.round((trendMax + trendMin) / 2)}</span>
            <span>{Math.round(trendMin)}</span>
          </div>
          <svg width="100%" height="60" style={{ display: 'block' }}>
            {(() => {
              const pts = trend.map((v, i) => {
                const x = (i / (trend.length - 1)) * 100;
                const y = 60 - ((v - trendMin) / trendRange) * 55;
                return `${x},${y}`;
              }).join(' ');
              return (
                <>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.7"
                  />
                  {trend.map((v, i) => {
                    const x = (i / (trend.length - 1)) * 100;
                    const y = 60 - ((v - trendMin) / trendRange) * 55;
                    return (
                      <circle key={i} cx={`${x}%`} cy={y} r="3" fill="var(--accent)" opacity="0.8">
                        <title>{dayLabels[i]}: {Math.round(v)}</title>
                      </circle>
                    );
                  })}
                </>
              );
            })()}
          </svg>
          {/* X-axis day labels */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.2rem', fontSize: '0.62rem', color: 'var(--text-muted)' }}>
            {dayLabels.map((label, i) => <span key={i}>{label}</span>)}
          </div>
        </div>
      </div>

      {/* Two-col grid */}
      <div className="dash-grid">
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>Pending Selections</h3>
            <span className="pill warning">{myPending.length}</span>
          </div>
          {myPending.length === 0 ? (
            <p className="empty-hint">All caught up — no pending slot selections.</p>
          ) : (
            <div className="mini-list">
              {myPending.slice(0, 4).map(m => (
                <div key={m.requestId} className="mini-item" onClick={() => onNavigate('meetings')}>
                  <span className="mini-dot pending" />
                  <div className="mini-body">
                    <div className="mini-title">{m.title}</div>
                    <div className="mini-meta">{m.durationMinutes}m · {m.slots?.length ?? 0} slots</div>
                  </div>
                  <span className="mini-arrow">›</span>
                </div>
              ))}
              {myPending.length > 4 && (
                <button className="see-all" onClick={() => onNavigate('meetings')}>
                  View all {myPending.length} →
                </button>
              )}
            </div>
          )}
        </div>

        <div className="dash-card">
          <div className="dash-card-head">
            <h3>Upcoming Meetings</h3>
            <span className="pill success">{confirmed.length}</span>
          </div>
          {confirmed.length === 0 ? (
            <p className="empty-hint">No confirmed meetings yet. Create one!</p>
          ) : (
            <div className="mini-list">
              {confirmed.slice(0, 4).map(m => (
                <div key={m.requestId} className="mini-item" onClick={() => onNavigate('calendar')}>
                  <span className="mini-dot confirmed" />
                  <div className="mini-body">
                    <div className="mini-title">{m.title}</div>
                    <div className="mini-meta">
                      {m.selectedSlotStart
                        ? new Date(m.selectedSlotStart).toLocaleDateString('en-US', {
                            weekday: 'short', month: 'short', day: 'numeric',
                          })
                        : `${m.durationMinutes}m`}
                    </div>
                  </div>
                  <span className="mini-arrow" style={{ color: 'var(--success)', fontSize: '0.75rem' }}>✓</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recommendations */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {insights.slice(0, 2).map((ins, i) => (
          <div key={i} className="insight-banner">
            <span>{ins.emoji}</span>
            <span>{ins.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
