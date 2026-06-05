import { useState, useEffect, useRef } from 'react'
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
import DeclineWizard from './components/DeclineWizard';
import DashboardView from './components/DashboardView';
import { apiGet, apiPost, apiParseMeetingNL } from './apiClient';

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
  const [declineWizardId, setDeclineWizardId] = useState(null); // requestId being declined
  const [showPalette, setShowPalette]         = useState(false);
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
          await apiPost('/api/calendar/callback', { ...oauthPending, redirect_origin: window.location.origin });
          toast('Google Calendar connected successfully!', 'success');
          navigate('/profile', { state: { initialTab: 'calendar' } });
        } catch (err) {
          console.error('OAuth callback exchange failed:', err);
          toast(`Failed to connect Google Calendar: ${err.message}`, 'error');
        }
      }

      const [profileData, meetingsData, calStatus] = await Promise.all([
        apiGet('/api/profile'),
        apiGet('/api/meetings'),
        apiGet('/api/calendar/status').catch(() => null), // non-fatal
      ]);
      setProfile(profileData);
      setMeetings(Array.isArray(meetingsData) ? meetingsData : (meetingsData?.meetings ?? []));
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

  /** Auto-poll meetings every 60 seconds when logged in. */
  useEffect(() => {
    if (!profile) return;
    const id = setInterval(refreshMeetings, 60_000);
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

  /** AI meeting setup: parse a natural-language request, then open the create modal pre-filled. */
  const handleNewMeetingFromText = async (text) => {
    if (!isCalendarConnected) {
      toast('Connect your Google Calendar to create meetings.', 'info');
      navigate('/profile', { state: { initialTab: 'calendar' } });
      return;
    }
    try {
      const parsed = await apiParseMeetingNL(text);
      setMeetingPrefill({ parsed });
      setShowGlobalCreate(true);
      if (parsed.unmatchedHints?.length) {
        toast?.(`Couldn't match: ${parsed.unmatchedHints.join(', ')} — add manually`, 'info');
      }
    } catch (e) {
      toast?.(`AI parse failed: ${e.message || e}`, 'error');
    }
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
          <div style={{ textAlign: 'center', fontSize: '0.65rem', opacity: 0.35, marginTop: '0.4rem', letterSpacing: '0.05em' }}>v1.1</div>
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
                onNavigate={setActiveView}
                needsAction={needsAction}
                isCalendarConnected={isCalendarConnected}
                onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
                onNewMeeting={() => { setMeetingPrefill(null); setShowGlobalCreate(true); }}
                onNewMeetingFromText={handleNewMeetingFromText}
                onViewFairness={() => navigate('/profile', { state: { initialTab: 'fairness', expandFairness: true } })}
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
                  profile={profile}
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
                  expandFairness={location.state?.expandFairness}
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
          onNewMeetingFromText={async (text) => { setShowPalette(false); await handleNewMeetingFromText(text); }}
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
          onDecline={(requestId) => {
            setSelectedMeeting(null);
            setDeclineWizardId(requestId);
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

      {/* ── Decline Wizard (global — used by detail modal and elsewhere) ── */}
      {declineWizardId && (
        <DeclineWizard
          meeting={meetings.find(m => m.requestId === declineWizardId)}
          onSubmit={async (reason, comment) => {
            await apiPost(`/api/meetings/${declineWizardId}/decline`, { reason, comment });
            await refreshAll();
          }}
          onClose={() => setDeclineWizardId(null)}
        />
      )}
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
