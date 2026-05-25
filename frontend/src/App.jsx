import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, NavLink, useNavigate, useLocation, Navigate } from 'react-router-dom'
import { LayoutDashboard, Calendar, CalendarCheck, Users, User, Sun, Moon } from 'lucide-react'
import { useToast } from './context/ToastContext.jsx'
import './App.css'
import MeetingDashboard from './components/MeetingDashboard';
import CalendarView from './components/CalendarView';
import ProfileView from './components/ProfileView';
import PeopleView from './components/PeopleView';
import PublicProfile from './components/PublicProfile';
import MeetingDetailModal from './components/MeetingDetailModal';
import CommandPalette from './components/CommandPalette';
import CreateMeetingModal from './components/CreateMeetingModal';
import { apiGet, apiPost } from './apiClient';

import { Amplify } from 'aws-amplify';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import awsConfig from './aws-exports';

Amplify.configure(awsConfig);

function AppContent() {
  const { user, signOut } = useAuthenticator((context) => [context.user]);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [profile, setProfile]             = useState(null);
  const [meetings, setMeetings]           = useState([]);
  const [calendarStatus, setCalendarStatus] = useState({ google: { connected: false, email: '' } });
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [retryCount, setRetryCount]       = useState(0);
  const [targetProfile, setTargetProfile] = useState(null); // for viewing other user profiles
  const [sidebarOpen, setSidebarOpen]     = useState(false);
  const [theme, setTheme]                 = useState(() => localStorage.getItem('theme') || 'dark');
  const [meetingPrefill, setMeetingPrefill] = useState(null); // email string to prefill
  const [showGlobalCreate, setShowGlobalCreate] = useState(false); // global create modal (from calendar / people / ⌘K)
  const [selectedMeeting, setSelectedMeeting] = useState(null); // for MeetingDetailModal
  const [showPalette, setShowPalette]         = useState(false);
  const [activities, setActivities]           = useState([]);
  const [users, setUsers]                     = useState([]);
  // helper so child components can still call setActiveView('meetings') etc.
  const setActiveView = (view) => navigate(`/${view === 'dashboard' ? '' : view}`);
  const oauthProcessed = useRef(false);

  // Apply + persist theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Capture OAuth callback params from URL on component mount (before they disappear).
  // State initializer runs only once — safe to use window.location here.
  const [oauthPending] = useState(() => {
    const params       = new URLSearchParams(window.location.search);
    const oauthError   = params.get('error');
    const oauthErrDesc = params.get('error_description');
    if (oauthError) {
      window.history.replaceState({}, '', window.location.pathname);
      return { oauthError, oauthErrDesc };
    }
    const code  = params.get('code');
    const state = params.get('state');
    if (code && state) {
      const provider = state.split(':')[0];
      if (provider === 'google') {
        // Clean the URL immediately so a page refresh doesn't re-trigger
        window.history.replaceState({}, '', window.location.pathname);
        return { code, state, provider };
      }
    }
    return null;
  });

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);

    const run = async () => {
      // Process OAuth callback first (if the user just came back from Google)
      if (oauthPending?.oauthError && !oauthProcessed.current) {
        oauthProcessed.current = true;
        const desc = oauthPending.oauthErrDesc?.replace(/\+/g, ' ') || oauthPending.oauthError;
        toast(`Calendar connection failed: ${desc}`, 'error');
      }
      if (oauthPending && !oauthPending.oauthError && !oauthProcessed.current) {
        oauthProcessed.current = true;
        try {
          await apiPost('/api/calendar/callback', oauthPending);
          toast('Google Calendar connected successfully!', 'success');
          navigate('/profile', { state: { initialTab: 'calendar' } });
        } catch (err) {
          console.error('OAuth callback exchange failed:', err);
        }
      }

      const [profileData, meetingsData, calStatus, activityData] = await Promise.all([
        apiGet('/api/profile'),
        apiGet('/api/meetings'),
        apiGet('/api/calendar/status').catch(() => null), // non-fatal
        apiGet('/api/activity').catch(() => []),          // non-fatal
      ]);
      setProfile(profileData);
      setMeetings(Array.isArray(meetingsData) ? meetingsData : (meetingsData?.meetings ?? []));
      if (calStatus) setCalendarStatus(calStatus);
      setActivities(Array.isArray(activityData) ? activityData : []);
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

  const [lastRefreshed, setLastRefreshed] = useState(null);

  /** Refreshes profile (fairness score), meetings list, and calendar status. */
  const refreshAll = () =>
    Promise.all([
      apiGet('/api/profile'),
      apiGet('/api/meetings'),
      apiGet('/api/calendar/status').catch(() => null),
    ])
      .then(([profileData, meetingsData, calStatus]) => {
        setProfile(profileData);
        setMeetings(Array.isArray(meetingsData) ? meetingsData : (meetingsData?.meetings ?? []));
        if (calStatus) setCalendarStatus(calStatus);
        setLastRefreshed(new Date());
      })
      .catch(err => console.error('Refresh failed', err));

  /** Refresh meetings only (lightweight polling interval). */
  const refreshMeetings = () =>
    apiGet('/api/meetings')
      .then(data => {
        setMeetings(Array.isArray(data) ? data : (data?.meetings ?? []));
        setLastRefreshed(new Date());
      })
      .catch(() => {}); // silent failure during background polling

  /** Auto-poll meetings every 30 seconds when logged in. */
  useEffect(() => {
    if (!profile) return;
    const id = setInterval(refreshMeetings, 30_000);
    return () => clearInterval(id);
  }, [profile?.id]);

  /** Global ⌘K / Ctrl+K → open command palette. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowPalette(p => !p);
      }
      if (e.key === 'Escape') setShowPalette(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** Lazy-load users list once (for CommandPalette people search). */
  useEffect(() => {
    if (!profile || users.length > 0) return;
    apiGet('/api/users').then(data => setUsers(Array.isArray(data) ? data : [])).catch(() => {});
  }, [profile?.id]);

  /** Refresh meetings whenever the calendar route becomes active. */
  useEffect(() => {
    if (location.pathname === '/calendar' && profile) {
      apiGet('/api/meetings')
        .then(data => setMeetings(Array.isArray(data) ? data : (data?.meetings ?? [])))
        .catch(err => console.error('Calendar refresh failed', err));
    }
  }, [location.pathname, profile?.id]);

  /** Open Google Calendar OAuth flow (redirects the page). */
  const handleCalendarConnect = async (provider) => {
    try {
      const result = await apiGet(`/api/calendar/oauth_url?provider=${provider}`);
      if (result?.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      if (err.message?.toLowerCase().includes('not configured')) {
        toast('Google OAuth credentials not yet configured. Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to the Lambda environment variables.', 'info');
      } else {
        toast('Failed to connect Google Calendar. Please try again.', 'error');
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

  const isCalendarConnected = calendarStatus?.google?.connected === true;

  /** Navigate to /meetings with a pre-filled participant email. */
  const handleScheduleWith = (email) => {
    if (!isCalendarConnected) {
      toast('Connect your Google Calendar to create meetings.', 'info');
      navigate('/profile', { state: { initialTab: 'calendar' } });
      return;
    }
    setMeetingPrefill(email);
    setShowGlobalCreate(true);
  };

  /** Calendar click-to-create: open global create modal without navigating. */
  const handleCreateAt = (isoDatetime) => {
    if (!isCalendarConnected) {
      toast('Connect your Google Calendar to create meetings.', 'info');
      navigate('/profile', { state: { initialTab: 'calendar' } });
      return;
    }
    setMeetingPrefill({ datetime: isoDatetime });
    setShowGlobalCreate(true);
  };

  /** Open another user's public profile. */
  const handleParticipantClick = async (userId) => {
    if (userId === profile?.id) {
      setActiveView('profile');
      return;
    }
    try {
      const data = await apiGet(`/api/profile/${userId}`);
      setTargetProfile(data);
    } catch (err) {
      console.error('Failed to load target profile:', err);
    }
  };

  /* Badge counts */
  const needsAction = meetings.filter(
    m => m.userRole === 'participant' &&
         (m.status === 'confirmed' || m.status === 'pending') &&
         !(m.acceptedBy || []).includes(profile?.id)
  ).length;
  const meetingsBadge = (meetings.filter(m => m.status === 'pending' && m.userRole === 'organizer').length + needsAction) || null;

  const navItems = [
    { id: 'dashboard', path: '/',          label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
    { id: 'calendar',  path: '/calendar',  label: 'Calendar',  icon: <Calendar size={16} /> },
    { id: 'meetings',  path: '/meetings',  label: 'Meetings',  icon: <CalendarCheck size={16} />, badge: meetingsBadge },
    { id: 'people',    path: '/people',    label: 'People',    icon: <Users size={16} /> },
    { id: 'profile',   path: '/profile',   label: 'Profile',   icon: <User size={16} /> },
  ];

  const displayName = profile?.name || profile?.displayName || '';
  const initials = displayName
    ? displayName.split(' ').filter(Boolean).map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '??';

  return (
    <div className="layout">
      {/* ── Mobile header ── */}
      <div className="mobile-header">
        <button className="hamburger-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
          <span /><span /><span />
        </button>
        <span className="mobile-logo">Smart Scheduler</span>
      </div>

      {/* Sidebar overlay for mobile */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* ── Sidebar ── */}
      <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-logo" style={{ cursor: 'pointer' }} onClick={() => setShowPalette(true)} title="Open command palette (⌘K)">
          <div className="logo-mark">S</div>
          <div className="logo-text">
            Smart<br />Scheduler
            <div className="logo-kbd-hint">⌘K</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              onClick={() => setSidebarOpen(false)}
              title={item.label}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.badge > 0 && (
                <span className="nav-badge">{item.badge}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          {profile && (
            <div
              className="sidebar-user"
              onClick={() => { navigate('/profile'); setSidebarOpen(false); }}
              style={{ cursor: 'pointer' }}
              title="View profile"
            >
              <div className="sidebar-avatar">{initials}</div>
              <div className="sidebar-user-info">
                <div className="sidebar-user-name">{profile.name}</div>
                <div className="sidebar-user-role">Fairness: {Number.isFinite(Number(profile.fairness_score)) ? Math.round(Number(profile.fairness_score)) : '—'}</div>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              className="theme-toggle-btn"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button onClick={signOut} className="signout-btn" style={{ flex: 1 }}>Sign Out</button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        {loading && (
          <div className="loading-screen">
            <div className="skeleton-sidebar">
              {[1,2,3,4].map(i => <div key={i} className="skeleton-nav-item" />)}
            </div>
            <div className="skeleton-main">
              <div className="skeleton-header" />
              <div className="skeleton-cards">
                {[1,2,3].map(i => <div key={i} className="skeleton-card" />)}
              </div>
              <div className="skeleton-table" />
            </div>
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
          <Routes>
            <Route path="/" element={
              <DashboardView
                profile={profile}
                meetings={meetings}
                activities={activities}
                onNavigate={setActiveView}
                needsAction={needsAction}
                isCalendarConnected={isCalendarConnected}
                onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
                onNewMeeting={() => { setMeetingPrefill(null); setShowGlobalCreate(true); }}
              />
            } />

            <Route path="/calendar" element={
              <div className="view-wrap">
                <div className="view-header">
                  <h2>Calendar</h2>
                  <p className="view-subtitle">Visual overview of your confirmed meetings</p>
                </div>
                <CalendarView
                  meetings={meetings}
                  calendarStatus={calendarStatus}
                  onMeetingClick={(m) => setSelectedMeeting(m)}
                  onCreateAt={handleCreateAt}
                />
              </div>
            } />

            <Route path="/meetings" element={
              <div className="view-wrap">
                <MeetingDashboard
                  meetings={meetings}
                  onRefresh={refreshAll}
                  onMeetingUpdate={(requestId, updates) =>
                    setMeetings(prev => prev.map(m => m.requestId === requestId ? { ...m, ...updates } : m))
                  }
                  currentUserId={profile.id}
                  onParticipantClick={handleParticipantClick}
                  lastRefreshed={lastRefreshed}
                  isCalendarConnected={isCalendarConnected}
                  onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
                  onNewMeetingClick={() => {
                    if (!isCalendarConnected) {
                      toast('Connect your Google Calendar to create meetings.', 'info');
                      navigate('/profile', { state: { initialTab: 'calendar' } });
                      return;
                    }
                    setMeetingPrefill(null);
                    setShowGlobalCreate(true);
                  }}
                />
              </div>
            } />

            <Route path="/people" element={
              <div className="view-wrap">
                <PeopleView
                  meetings={meetings}
                  onScheduleWith={handleScheduleWith}
                  onViewProfile={(userId) => handleParticipantClick(userId)}
                />
              </div>
            } />

            <Route path="/profile" element={
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
                  onProfileUpdate={setProfile}
                  initialTab={location.state?.initialTab}
                />
              </div>
            } />

            {/* Fallback → dashboard */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      
      {/* ── Public Profile Modal (Global) ── */}
      {targetProfile && (
        <PublicProfile
          profile={targetProfile}
          onClose={() => setTargetProfile(null)}
          onScheduleWith={handleScheduleWith}
          currentUserId={profile?.id}
        />
      )}

      {/* ── Command Palette (Global, ⌘K) ── */}
      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNavigate={setActiveView}
          onNewMeeting={() => { setMeetingPrefill(null); setShowGlobalCreate(true); setShowPalette(false); }}
          signOut={signOut}
          meetings={meetings}
          users={users}
        />
      )}

      {/* ── Global Create Meeting Modal ── */}
      {showGlobalCreate && (
        <CreateMeetingModal
          prefill={meetingPrefill}
          onClose={() => { setShowGlobalCreate(false); setMeetingPrefill(null); }}
          onCreated={() => { setShowGlobalCreate(false); setMeetingPrefill(null); navigate('/meetings'); refreshAll(); }}
          onRefresh={refreshAll}
        />
      )}

      {/* ── Meeting Detail Modal (Global, from Calendar click) ── */}
      {selectedMeeting && (
        <MeetingDetailModal
          meeting={selectedMeeting}
          currentUserId={profile?.id}
          onClose={() => setSelectedMeeting(null)}
          onAccept={async (requestId) => {
            try { await apiPost(`/api/meetings/${requestId}/accept`, {}); await refreshAll(); }
            catch (err) { console.error('Accept failed:', err); }
          }}
          onDecline={async (requestId) => {
            try { await apiPost(`/api/meetings/${requestId}/decline`, {}); await refreshAll(); }
            catch (err) { console.error('Decline failed:', err); toast('Failed to decline meeting', 'error'); }
          }}
          onCancel={() => {
            setSelectedMeeting(null);
            navigate('/meetings');
          }}
          onReschedule={() => {
            setSelectedMeeting(null);
            navigate('/meetings');
          }}
          onEdit={() => {
            setSelectedMeeting(null);
            navigate('/meetings');
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   DashboardView — enhanced home with analytics
───────────────────────────────────────────── */
const ACTIVITY_ACTION_META = {
  created:     { dot: 'var(--accent)',   verb: 'created' },
  booked:      { dot: 'var(--success)',  verb: 'confirmed a time for' },
  accepted:    { dot: 'var(--success)',  verb: 'accepted' },
  declined:    { dot: 'var(--danger)',   verb: 'declined' },
  cancelled:   { dot: 'var(--danger)',   verb: 'cancelled' },
  rescheduled: { dot: 'var(--warning)', verb: 'rescheduled' },
  edited:      { dot: '#a78bfa',         verb: 'edited' },
};

const fmtRel = (iso) => {
  const diff = new Date() - new Date(iso);
  const min = Math.floor(diff / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24)   return `${h}h ago`;
  if (h < 48)   return 'yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

function ActivityFeed({ activities }) {
  const ACTION_META = ACTIVITY_ACTION_META;
  if (!activities || activities.length === 0) {
    return <p className="empty-hint">No recent activity yet.</p>;
  }
  return (
    <div className="activity-feed">
      {activities.map((entry, i) => {
        const meta = ACTION_META[entry.action] || { dot: 'var(--text-muted)', verb: entry.action };
        return (
          <div key={i} className="activity-row">
            <div className="activity-dot" style={{ background: meta.dot }} />
            <div className="activity-body">
              <span className="activity-actor">{entry.actorName || 'Someone'}</span>
              {' '}{meta.verb}{' '}
              <span className="activity-meeting">"{entry.meetingTitle}"</span>
            </div>
            <span className="activity-time">{fmtRel(entry.at)}</span>
          </div>
        );
      })}
    </div>
  );
}

function DashboardView({ profile, meetings, activities, onNavigate, needsAction, isCalendarConnected, onConnectCalendar, onNewMeeting }) {
  const myPending    = meetings.filter(m => m.status === 'pending' && m.userRole === 'organizer');
  const confirmed    = meetings.filter(m => m.status === 'confirmed');
  const total        = meetings.length;
  const organized    = meetings.filter(m => m.userRole === 'organizer').length;
  const invited      = meetings.filter(m => m.userRole === 'participant').length;
  const score        = Number.isFinite(Number(profile.fairness_score)) ? Math.round(Number(profile.fairness_score)) : 100;
  const scoreColor   = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
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

      {/* Stats grid */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-body">
            <div className="stat-value" style={{ color: scoreColor }}>{score}</div>
            <div className="stat-label">Fairness Score</div>
            <div className="stat-subtext">
              {score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : 'Below average'}
            </div>
          </div>
          <div className="stat-bar-track">
            <div className="stat-bar-fill" style={{ width: `${score}%`, background: scoreColor }} />
          </div>
          <details className="score-explainer">
            <summary>How is this calculated?</summary>
            <div className="score-explainer-body">
              Starts at 100. Reduced by meetings this week (−2 each) and cancellations (−5 each). Boosted by accepting inconvenient slots (+3 each). Time slots are scored 0–100 by time of day, day of week, participant load, and fairness balance.
            </div>
          </details>
        </div>

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
                return `${x}%,${y}`;
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

      {/* Activity Feed */}
      <div className="dash-card" style={{ marginBottom: '1.25rem' }}>
        <div className="dash-card-head">
          <h3>Recent Activity</h3>
        </div>
        <ActivityFeed activities={activities} />
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

export default function App() {
  return (
    <Authenticator.Provider>
      <Authenticator>
        <AppContent />
      </Authenticator>
    </Authenticator.Provider>
  );
}
