import { useState, useEffect, useRef } from 'react'
import './App.css'
import MeetingDashboard from './components/MeetingDashboard';
import CalendarView from './components/CalendarView';
import ProfileView from './components/ProfileView';
import { apiGet, apiPost } from './apiClient';

import { Amplify } from 'aws-amplify';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import awsConfig from './aws-exports';

Amplify.configure(awsConfig);

function AppContent() {
  const { user, signOut } = useAuthenticator((context) => [context.user]);
  const [profile, setProfile]             = useState(null);
  const [meetings, setMeetings]           = useState([]);
  const [calendarStatus, setCalendarStatus] = useState({ google: { connected: false, email: '' }, microsoft: { connected: false, email: '' } });
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [activeView, setActiveView]       = useState('dashboard');
  const [retryCount, setRetryCount]       = useState(0);
  const [calendarToast, setCalendarToast] = useState(null); // { type: 'success'|'error'|'info', msg } | null
  const oauthProcessed = useRef(false);

  // Capture OAuth callback params from URL on component mount (before they disappear).
  // State initializer runs only once — safe to use window.location here.
  const [oauthPending] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (code && state) {
      const provider = state.split(':')[0];
      if (provider === 'google' || provider === 'microsoft') {
        // Clean the URL immediately so a page refresh doesn't re-trigger
        window.history.replaceState({}, '', window.location.pathname);
        return { code, state, provider };
      }
    }
    return null;
  });

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError(null);

    const run = async () => {
      // Process OAuth callback first (if the user just came back from Google/Microsoft)
      if (oauthPending && !oauthProcessed.current) {
        oauthProcessed.current = true;
        try {
          await apiPost('/api/calendar/callback', oauthPending);
          const provider = oauthPending.provider;
          const label = oauthPending.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
          setCalendarToast({ type: 'success', msg: `${label} connected successfully!` });
          setTimeout(() => setCalendarToast(null), 5000);
          setActiveView('profile'); // navigate straight to profile to show connected calendar
        } catch (err) {
          console.error('OAuth callback exchange failed:', err);
          const label = oauthPending.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
          setCalendarToast({ type: 'error', msg: `Failed to connect ${label}: ${err.message || 'Unknown error. Check browser console for details.'}` });
          setTimeout(() => setCalendarToast(null), 10000);
          setActiveView('profile');
        }
      }

      const [profileData, meetingsData, calStatus] = await Promise.all([
        apiGet('/api/profile'),
        apiGet('/api/meetings'),
        apiGet('/api/calendar/status').catch(() => null), // non-fatal
      ]);
      setProfile(profileData);
      setMeetings(meetingsData);
      if (calStatus) setCalendarStatus(calStatus);
      setLoading(false);
    };

    run().catch(err => {
      console.error('Load error:', err);
      if (err.message?.includes('401')) {
        setLoading(false);
        signOut();
      } else {
        setError(err.message || 'Connection error — check API Gateway');
        setLoading(false);
      }
    });
  }, [user, retryCount]);

  /** Refreshes profile (fairness score), meetings list, and calendar status. */
  const refreshAll = () =>
    Promise.all([
      apiGet('/api/profile'),
      apiGet('/api/meetings'),
      apiGet('/api/calendar/status').catch(() => null),
    ])
      .then(([profileData, meetingsData, calStatus]) => {
        setProfile(profileData);
        setMeetings(meetingsData);
        if (calStatus) setCalendarStatus(calStatus);
      })
      .catch(err => console.error('Refresh failed', err));

  /** Show a toast notification. */
  const showCalendarToast = (type, msg) => {
    setCalendarToast({ type, msg });
    setTimeout(() => setCalendarToast(null), 6000);
  };

  /** Open Google / Microsoft OAuth flow (redirects the page). */
  const handleCalendarConnect = async (provider) => {
    try {
      const result = await apiGet(`/api/calendar/oauth_url?provider=${provider}`);
      if (result?.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      const label = provider === 'google' ? 'Google' : 'Microsoft';
      if (err.message?.toLowerCase().includes('not configured')) {
        showCalendarToast('info',
          `${label} OAuth credentials not yet configured. Add ${provider === 'google' ? 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET' : 'MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET'} to the Lambda environment variables.`
        );
      } else {
        showCalendarToast('error', `Failed to connect ${label}. Please try again.`);
        console.error('Failed to get OAuth URL:', err);
      }
    }
  };

  /** Disconnect a calendar provider. */
  const handleCalendarDisconnect = async (provider) => {
    try {
      await apiPost('/api/calendar/disconnect', { provider });
      const updated = await apiGet('/api/calendar/status').catch(() => null);
      if (updated) setCalendarStatus(updated);
    } catch (err) {
      console.error('Failed to disconnect calendar:', err);
    }
  };

  /* Badge counts */
  const needsAction = meetings.filter(
    m => m.userRole === 'participant' && m.status === 'confirmed' &&
         !(m.acceptedBy || []).includes(profile?.id)
  ).length;
  const meetingsBadge = (meetings.filter(m => m.status === 'pending' && m.userRole === 'organizer').length + needsAction) || null;

  const navItems = [
    { id: 'dashboard', emoji: '🏠', label: 'Dashboard' },
    { id: 'calendar',  emoji: '🗓️', label: 'Calendar'  },
    { id: 'meetings',  emoji: '📋', label: 'Meetings', badge: meetingsBadge },
    { id: 'profile',   emoji: '👤', label: 'Profile'   },
  ];

  const initials = profile?.name
    ? profile.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '??';

  return (
    <div className="layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">S</div>
          <div className="logo-text">Smart<br />Scheduler</div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${activeView === item.id ? 'active' : ''}`}
              onClick={() => setActiveView(item.id)}
              title={item.label}
            >
              <span className="nav-emoji">{item.emoji}</span>
              <span className="nav-label">{item.label}</span>
              {item.badge > 0 && (
                <span className="nav-badge">{item.badge}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          {profile && (
            <div
              className="sidebar-user"
              onClick={() => setActiveView('profile')}
              style={{ cursor: 'pointer' }}
              title="View profile"
            >
              <div className="sidebar-avatar">{initials}</div>
              <div className="sidebar-user-info">
                <div className="sidebar-user-name">{profile.name}</div>
                <div className="sidebar-user-role">Score: {Math.round(profile.fairness_score ?? 100)}</div>
              </div>
            </div>
          )}
          <button onClick={signOut} className="signout-btn">Sign Out</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {/* Calendar toast notification */}
        {calendarToast && (() => {
          const styles = {
            success: { bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.3)',   color: '#4ade80', icon: '✅' },
            error:   { bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.3)',   color: '#f87171', icon: '❌' },
            info:    { bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.3)',  color: '#38bdf8', icon: 'ℹ️' },
          };
          const s = styles[calendarToast.type] || styles.info;
          return (
            <div style={{
              position: 'fixed', top: '1.5rem', right: '1.5rem', zIndex: 9999,
              padding: '0.8rem 1.2rem', borderRadius: '12px', fontSize: '0.84rem',
              fontWeight: 500, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              background: s.bg, border: `1px solid ${s.border}`, color: s.color,
              maxWidth: '380px', lineHeight: 1.5,
              display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
            }}>
              <span style={{ flexShrink: 0 }}>{s.icon}</span>
              <span>{calendarToast.msg}</span>
            </div>
          );
        })()}

        {loading && (
          <div className="loading-screen">
            <div className="spinner" />
            <span>Connecting to AWS…</span>
          </div>
        )}

        {error && (
          <div className="error-banner">
            <span>⚠️ <strong>Error:</strong> {error}</span>
            <button
              className="retry-btn"
              onClick={() => { setError(null); setRetryCount(n => n + 1); }}
            >
              ↺ Retry
            </button>
          </div>
        )}

        {!loading && profile && (
          <>
            {activeView === 'dashboard' && (
              <DashboardView
                profile={profile}
                meetings={meetings}
                onNavigate={setActiveView}
                needsAction={needsAction}
              />
            )}

            {activeView === 'calendar' && (
              <div className="view-wrap">
                <div className="view-header">
                  <h2>Calendar</h2>
                  <p className="view-subtitle">Visual overview of your confirmed meetings</p>
                </div>
                <CalendarView meetings={meetings} />
              </div>
            )}

            {activeView === 'meetings' && (
              <div className="view-wrap">
                <MeetingDashboard
                  meetings={meetings}
                  onRefresh={refreshAll}
                  currentUserId={profile.id}
                />
              </div>
            )}

            {activeView === 'profile' && (
              <div className="view-wrap">
                <div className="view-header">
                  <h2>Profile & Settings</h2>
                  <p className="view-subtitle">Account details, fairness analytics & calendar integrations</p>
                </div>
                <ProfileView
                  profile={profile}
                  meetings={meetings}
                  calendarStatus={calendarStatus}
                  onCalendarConnect={handleCalendarConnect}
                  onCalendarDisconnect={handleCalendarDisconnect}
                />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────────────────────────
   DashboardView — enhanced home with analytics
───────────────────────────────────────────── */
function DashboardView({ profile, meetings, onNavigate, needsAction }) {
  const myPending    = meetings.filter(m => m.status === 'pending' && m.userRole === 'organizer');
  const confirmed    = meetings.filter(m => m.status === 'confirmed');
  const total        = meetings.length;
  const organized    = meetings.filter(m => m.userRole === 'organizer').length;
  const invited      = meetings.filter(m => m.userRole === 'participant').length;
  const score        = Math.round(profile.fairness_score ?? 100);
  const scoreColor   = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
  const thisWeek     = profile.details?.meetings_this_week ?? 0;

  // Simple fairness trend (mock: assume linear improvement pattern)
  const trend = Array.from({ length: 7 }, (_, i) =>
    Math.max(40, score - (7 - i) * 5 + Math.random() * 8)
  );
  const trendMax = Math.max(...trend, 100);
  const trendMin = Math.min(...trend, 0);
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
          <h1 className="dash-greeting">Welcome back, {profile.name.split(' ')[0]} 👋</h1>
          <p className="dash-subtitle">Your scheduling hub — analytics, meetings & insights</p>
        </div>
        <button className="btn-primary" onClick={() => onNavigate('meetings')}>
          + New Meeting
        </button>
      </div>

      {/* Action banner */}
      {needsAction > 0 && (
        <div
          className="insight-banner"
          style={{ marginBottom: '1.5rem', cursor: 'pointer', borderColor: 'rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.06)' }}
          onClick={() => onNavigate('meetings')}
        >
          <span>🔔</span>
          <span>
            <strong>{needsAction}</strong> meeting{needsAction > 1 ? 's' : ''} awaiting your acceptance.{' '}
            <span style={{ color: 'var(--accent-color)' }}>View →</span>
          </span>
        </div>
      )}

      {/* Enhanced stats grid */}
      <div className="stats-row enhanced">
        <div className="stat-card highlight">
          <div className="stat-icon">⚖️</div>
          <div className="stat-body">
            <div className="stat-value" style={{ color: scoreColor }}>{score}</div>
            <div className="stat-label">Fairness Score</div>
            <div className="stat-subtext">
              {score >= 80 ? '🌟 Excellent' : score >= 60 ? '📈 Good' : '⚠️ Below average'}
            </div>
          </div>
          <div className="stat-bar-track">
            <div className="stat-bar-fill" style={{ width: `${score}%`, background: scoreColor, borderRadius: '2px' }} />
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">📅</div>
          <div className="stat-body">
            <div className="stat-value">{total}</div>
            <div className="stat-label">Total Meetings</div>
            <div className="stat-subtext">{organized} organized · {invited} invited</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-body">
            <div className="stat-value">{confirmed.length}</div>
            <div className="stat-label">Confirmed</div>
            <div className="stat-subtext">{myPending.length} pending selection</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-body">
            <div className="stat-value">{thisWeek}</div>
            <div className="stat-label">This Week</div>
            <div className="stat-subtext">Next 7 days</div>
          </div>
        </div>
      </div>

      {/* Fairness trend mini-chart */}
      <div className="dash-card" style={{ marginBottom: '1.75rem' }}>
        <div className="dash-card-head">
          <h3>📊 Fairness Trend (7 days)</h3>
          <span className="pill" style={{ background: scoreColor + '20', color: scoreColor, border: `1px solid ${scoreColor}40` }}>
            +{Math.round(trend[6] - trend[0])} pts
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.35rem', height: '60px', paddingTop: '1rem' }}>
          {trend.map((val, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${((val - trendMin) / trendRange) * 100}%`,
                background: `rgba(56, 189, 248, ${0.4 + (val / 100) * 0.6})`,
                borderRadius: '6px 6px 0 0',
                transition: 'all 0.3s ease',
                cursor: 'pointer',
                minHeight: '4px',
              }}
              title={`Day ${i + 1}: ${Math.round(val)}`}
              onMouseEnter={e => e.target.style.opacity = '1'}
              onMouseLeave={e => e.target.style.opacity = '0.8'}
            />
          ))}
        </div>
      </div>

      {/* Two-col grid */}
      <div className="dash-grid">
        {/* Pending selections */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>⏳ Pending Selections</h3>
            <span className="pill warning">{myPending.length}</span>
          </div>
          {myPending.length === 0 ? (
            <p className="empty-hint">All caught up — no pending slot selections. ✅</p>
          ) : (
            <div className="mini-list">
              {myPending.slice(0, 4).map(m => (
                <div key={m.requestId} className="mini-item" onClick={() => onNavigate('meetings')} style={{ cursor: 'pointer' }}>
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

        {/* Upcoming confirmed */}
        <div className="dash-card">
          <div className="dash-card-head">
            <h3>📅 Upcoming Meetings</h3>
            <span className="pill success">{confirmed.length}</span>
          </div>
          {confirmed.length === 0 ? (
            <p className="empty-hint">No confirmed meetings yet. Create one!</p>
          ) : (
            <div className="mini-list">
              {confirmed.slice(0, 4).map(m => (
                <div key={m.requestId} className="mini-item" onClick={() => onNavigate('calendar')} style={{ cursor: 'pointer' }}>
                  <span className="mini-dot confirmed" />
                  <div className="mini-body">
                    <div className="mini-title">{m.title}</div>
                    <div className="mini-meta">
                      {m.selectedSlotStart
                        ? new Date(m.selectedSlotStart).toLocaleDateString('en-US', {
                            weekday: 'short', month: 'short', day: 'numeric',
                            hour: '2-digit', minute: '2-digit',
                          })
                        : `${m.durationMinutes}m`}
                    </div>
                  </div>
                  <span className="mini-arrow" style={{ color: 'var(--success)' }}>✓</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Smart insights */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {insights.slice(0, 2).map((ins, i) => (
          <div key={i} className="insight-banner" style={{ cursor: 'pointer' }}>
            <span>{ins.emoji}</span>
            <span>{ins.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Authenticator.Provider>
      <Authenticator>
        <AppContent />
      </Authenticator>
    </Authenticator.Provider>
  );
}
