import { useState, useEffect, useRef, useMemo } from 'react';
import { Routes, Route, NavLink, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { Amplify } from 'aws-amplify';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import './styles/app.css';

import awsConfig from './aws-exports';
import { apiGet, apiPost, apiParseMeetingNL } from './apiClient';
import { useToast } from './context/ToastContext.jsx';
import { Ico } from './ui/Primitives.jsx';
import { initials, needsMyAction, awaitsMyPick } from './lib/meetings';

import AuthScreen from './components/AuthScreen.jsx';
import OverviewView from './views/OverviewView.jsx';
import MeetingsView from './views/MeetingsView.jsx';
import CalendarView from './views/CalendarView.jsx';
import PeopleView from './views/PeopleView.jsx';
import SettingsView from './views/SettingsView.jsx';
import MeetingDetailModal from './components/MeetingDetailModal.jsx';
import CreateMeetingModal from './components/CreateMeetingModal.jsx';
import DeclineWizard from './components/DeclineWizard.jsx';
import PublicProfile from './components/PublicProfile.jsx';
import CommandPalette from './components/CommandPalette.jsx';

Amplify.configure(awsConfig);

const NAV = [
  { id: 'dashboard', path: '/',         label: 'Overview' },
  { id: 'meetings',  path: '/meetings', label: 'Meetings' },
  { id: 'calendar',  path: '/calendar', label: 'Calendar' },
  { id: 'people',    path: '/people',   label: 'People'   },
  { id: 'profile',   path: '/profile',  label: 'Settings' },
];

/** Theme lives above the auth gate so the sign-in screen can toggle it too. */
function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ss-theme', theme);
  }, [theme]);
  return [theme, setTheme];
}

function AppContent({ theme, setTheme }) {
  const { user, signOut } = useAuthenticator((context) => [context.user]);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [profile, setProfile]                   = useState(null);
  const [meetings, setMeetings]                 = useState([]);
  const [calendarStatus, setCalendarStatus]     = useState({ google: { connected: false, email: '' } });
  const [users, setUsers]                       = useState([]);
  const [loading, setLoading]                   = useState(true);
  const [error, setError]                       = useState(null);
  const [retryCount, setRetryCount]             = useState(0);
  const [refreshing, setRefreshing]             = useState(false);
  const [lastRefreshed, setLastRefreshed]       = useState(null);
  const [sidebarOpen, setSidebarOpen]           = useState(false);
  const [targetProfile, setTargetProfile]       = useState(null);
  const [meetingPrefill, setMeetingPrefill]     = useState(null);
  const [showGlobalCreate, setShowGlobalCreate] = useState(false);
  const [drafting, setDrafting] = useState(null);   // meeting being generated, if any
  const [selectedMeeting, setSelectedMeeting]   = useState(null);
  const [declineWizardId, setDeclineWizardId]   = useState(null);
  const [showPalette, setShowPalette]           = useState(false);
  const oauthProcessed = useRef(false);

  const setActiveView = (view) => navigate(`/${view === 'dashboard' ? '' : view}`);

  /* Capture OAuth callback params before React Router cleans the URL. */
  const [oauthPending] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    const oauthErrDesc = params.get('error_description');
    if (oauthError) {
      window.history.replaceState({}, '', window.location.pathname);
      return { oauthError, oauthErrDesc };
    }
    const code = params.get('code');
    const state = params.get('state');
    if (code && state && state.split(':')[0] === 'google') {
      window.history.replaceState({}, '', window.location.pathname);
      return { code, state, provider: 'google' };
    }
    return null;
  });

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError(null);

    const run = async () => {
      if (oauthPending?.oauthError && !oauthProcessed.current) {
        oauthProcessed.current = true;
        const desc = oauthPending.oauthErrDesc?.replace(/\+/g, ' ') || oauthPending.oauthError;
        toast(`Calendar connection failed: ${desc}`, 'error');
      }
      if (oauthPending && !oauthPending.oauthError && !oauthProcessed.current) {
        oauthProcessed.current = true;
        try {
          await apiPost('/api/calendar/callback', { ...oauthPending, redirect_origin: window.location.origin });
          toast('Google Calendar connected.', 'success');
          navigate('/profile', { state: { initialTab: 'calendar' } });
        } catch (err) {
          toast(`Failed to connect Google Calendar: ${err.message}`, 'error');
        }
      }

      const [profileData, meetingsData, calStatus] = await Promise.all([
        apiGet('/api/profile'),
        apiGet('/api/meetings'),
        apiGet('/api/calendar/status').catch(() => null),
      ]);
      setProfile(profileData);
      setMeetings(Array.isArray(meetingsData) ? meetingsData : (meetingsData?.meetings ?? []));
      if (calStatus) setCalendarStatus(calStatus);
      setLastRefreshed(new Date());
      setLoading(false);
    };

    run().catch(err => {
      if (err.message?.includes('401')) {
        setLoading(false);
        signOut();
      } else {
        setError(err.message || 'Connection error: check API Gateway');
        setLoading(false);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryCount]);

  /** Reload profile, meetings and calendar status together. */
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

  const refreshMeetings = () =>
    apiGet('/api/meetings')
      .then(data => {
        setMeetings(Array.isArray(data) ? data : (data?.meetings ?? []));
        setLastRefreshed(new Date());
      })
      .catch(() => {}); // silent during background polling

  /* Fairness moves when anyone books or cancels, so the meter needs its own tick. */
  const refreshProfile = () =>
    apiGet('/api/profile')
      .then(setProfile)
      .catch(() => {}); // silent during background polling

  /**
   * AI fairness scoring can land after the create response returns. Poll
   * briefly so the AI panel appears within seconds instead of on the 60s tick.
   */
  const pollMeetingForAi = (requestId, { attempts = 10, intervalMs = 3000 } = {}) => {
    if (!requestId) return;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const data = await apiGet('/api/meetings');
        const list = Array.isArray(data) ? data : (data?.meetings ?? []);
        setMeetings(list);
        setLastRefreshed(new Date());
        if (list.find(m => m.requestId === requestId)?.aiMethod) return;
      } catch { /* transient — keep trying */ }
      if (tries < attempts) setTimeout(tick, intervalMs);
    };
    setTimeout(tick, intervalMs);
  };

  /* Auto-poll meetings and fairness every 60 seconds. */
  useEffect(() => {
    if (!profile) return;
    const id = setInterval(() => { refreshMeetings(); refreshProfile(); }, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  /* ⌘K / Ctrl+K opens the command palette. */
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

  /* Directory, loaded once — powers People, the palette and participant pickers. */
  useEffect(() => {
    if (!profile || users.length > 0) return;
    apiGet('/api/users').then(data => setUsers(Array.isArray(data) ? data : [])).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  /* Refresh meetings when the calendar route becomes active. */
  useEffect(() => {
    if (location.pathname === '/calendar' && profile) {
      apiGet('/api/meetings')
        .then(data => setMeetings(Array.isArray(data) ? data : (data?.meetings ?? [])))
        .catch(err => console.error('Calendar refresh failed', err));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, profile?.id]);

  /* Close the mobile drawer on navigation. */
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const isCalendarConnected = calendarStatus?.google?.connected === true;

  const requireCalendar = () => {
    if (isCalendarConnected) return true;
    toast('Connect your Google Calendar to create meetings.', 'info');
    navigate('/profile', { state: { initialTab: 'calendar' } });
    return false;
  };

  const handleCalendarConnect = async (provider) => {
    try {
      const result = await apiGet(`/api/calendar/oauth_url?provider=${provider}`);
      if (result?.url) window.location.href = result.url;
    } catch (err) {
      if (err.message?.toLowerCase().includes('not configured')) {
        toast('Google OAuth is not configured on the backend yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).', 'info');
      } else {
        toast('Failed to start the Google Calendar connection.', 'error');
      }
    }
  };

  const handleCalendarDisconnect = async (provider) => {
    try {
      await apiPost('/api/calendar/disconnect', { provider });
      const updated = await apiGet('/api/calendar/status').catch(() => null);
      if (updated) setCalendarStatus(updated);
      toast('Calendar disconnected.', 'info');
    } catch {
      toast('Failed to disconnect the calendar.', 'error');
    }
  };

  const handleNewMeeting = () => {
    if (!requireCalendar()) return;
    setMeetingPrefill(null);
    setShowGlobalCreate(true);
  };

  const handleScheduleWith = (email) => {
    if (!requireCalendar()) return;
    setMeetingPrefill(email);
    setShowGlobalCreate(true);
  };

  const handleCreateAt = (isoDatetime) => {
    if (!requireCalendar()) return;
    setMeetingPrefill({ datetime: isoDatetime });
    setShowGlobalCreate(true);
  };

  /** Parse a plain-language request, then open Create pre-filled. */
  const handleNewMeetingFromText = async (text) => {
    if (!requireCalendar()) return;
    const parsed = await apiParseMeetingNL(text);
    setMeetingPrefill({ parsed });
    setShowGlobalCreate(true);
    if (parsed.unmatchedHints?.length) {
      toast(`Couldn't match: ${parsed.unmatchedHints.join(', ')}. Add them manually`, 'info');
    }
  };

  /**
   * The wizard closes the moment "Find times" is pressed: the organiser lands on
   * Meetings and watches a placeholder row while slot generation and AI scoring
   * run. `drafting` holds just enough of the payload to render that row.
   */
  const handleCreateMeeting = async (payload) => {
    setShowGlobalCreate(false);
    setMeetingPrefill(null);
    setDrafting({
      title: payload.title,
      /* Invitees are picked as people but sent as ids or emails, so neither list
         alone is the headcount. */
      invited: Math.max(payload.participantIds?.length || 0, payload.participantEmails?.length || 0),
    });
    setActiveView('meetings');
    try {
      const meeting = await apiPost('/api/meetings/create', payload);
      await refreshAll();
      toast(`Times are ready for “${payload.title}”. Pick one to book it.`, 'success');
      pollMeetingForAi(meeting?.requestId);
    } catch (err) {
      toast(err?.message || 'Could not create the meeting.', 'error');
    } finally {
      setDrafting(null);
    }
  };

  const handleParticipantClick = async (userId) => {
    if (!userId || userId === profile?.id) { setActiveView('profile'); return; }
    try {
      setTargetProfile(await apiGet(`/api/profile/${userId}`));
    } catch {
      toast('Could not load that profile.', 'error');
    }
  };

  const handleAccept = async (requestId) => {
    try {
      await apiPost(`/api/meetings/${requestId}/accept`, {});
      toast('Meeting accepted.', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message || 'Failed to accept.', 'error');
    }
  };

  /* Badges */
  const needsAction = useMemo(
    () => meetings.filter(m => needsMyAction(m, profile?.id)).length,
    [meetings, profile?.id],
  );
  const pendingPicks = useMemo(
    () => meetings.filter(m => awaitsMyPick(m, profile?.id)).length,
    [meetings, profile?.id],
  );
  const meetingsBadge = needsAction + pendingPicks;

  const displayName = profile?.name || profile?.displayName || '';
  const scoreLabel = Number.isFinite(Number(profile?.fairness_score))
    ? Math.round(Number(profile.fairness_score))
    : '-';

  /* Keep the modal's meeting in sync with refreshed data. */
  const activeMeeting = selectedMeeting
    ? meetings.find(m => m.requestId === selectedMeeting.requestId) || selectedMeeting
    : null;

  const doRefresh = async () => {
    setRefreshing(true);
    try { await refreshAll(); } finally { setRefreshing(false); }
  };

  return (
    <div className="shell">
      <div className={`side-veil${sidebarOpen ? ' on' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`side${sidebarOpen ? ' open' : ''}`}>
        <div className="side-top">
          <div className="lockup">
            <span className="lockup-mark">
              <img src="/Smart-Scheduler.png" alt="" />
            </span>
            <span className="lockup-name">Smart Scheduler</span>
          </div>
          <div className="lockup-sub">Workspace</div>
        </div>

        <nav className="side-nav">
          <div className="nav-head">Menu</div>
          {NAV.map(n => (
            <NavLink
              key={n.id}
              to={n.path}
              end={n.path === '/'}
              className={({ isActive }) => `nav-i${isActive ? ' on' : ''}`}
            >
              <Ico n={n.id} s={15} />
              <span>{n.label}</span>
              {n.id === 'meetings' && meetingsBadge > 0 && <span className="nav-c">{meetingsBadge}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="side-foot">
          <button className="me" onClick={() => navigate('/profile')}>
            <div className="mono-av fill">{initials(displayName)}</div>
            <div>
              <div className="me-name">{displayName || 'Your profile'}</div>
              <div className="me-meta">Fairness {scoreLabel}</div>
            </div>
          </button>
          <button className="side-out" onClick={signOut}>
            <Ico n="logout" s={14} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="mobile-bar">
          <button className="burger" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
            <span /><span /><span />
          </button>
          <span className="lockup-name">Smart Scheduler</span>
        </div>

        <div className="bar">
          <div className="bar-l">
            <button className="find" onClick={() => setShowPalette(true)}>
              <Ico n="search" s={14} />
              <span>Search meetings and people</span>
              <span className="kb">⌘K</span>
            </button>
          </div>
          <div className="bar-r">
            <button
              className={`icon-btn${refreshing ? ' spinning' : ''}`}
              onClick={doRefresh}
              disabled={refreshing}
              title={lastRefreshed ? `Updated ${lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}
            >
              <Ico n="refresh" s={15} />
            </button>
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              <Ico n={theme === 'dark' ? 'sun' : 'moon'} s={15} />
            </button>
          </div>
        </div>

        {loading && (
          <div className="sk-page">
            <div className="sk" style={{ height: 44, width: 280, marginBottom: 28 }} />
            <div className="sk-row">
              {[0, 1, 2, 3].map(i => <div key={i} className="sk" style={{ height: 118, flex: 1 }} />)}
            </div>
            <div className="sk" style={{ height: 300, marginTop: 28 }} />
          </div>
        )}

        {error && (
          <div className="page">
            <div className="notice">
              <Ico n="alert" s={16} />
              <span><b>Could not reach the API.</b> {error}</span>
              <button className="btn s sm" onClick={() => { setError(null); setRetryCount(n => n + 1); }}>
                <Ico n="refresh" s={12} /> Retry
              </button>
            </div>
          </div>
        )}

        {!loading && profile && (
          <Routes>
            <Route path="/" element={
              <OverviewView
                profile={profile}
                meetings={meetings}
                needsAction={needsAction}
                pendingPicks={pendingPicks}
                isCalendarConnected={isCalendarConnected}
                onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
                onNewMeeting={handleNewMeeting}
                onNewMeetingFromText={handleNewMeetingFromText}
                onOpenMeeting={setSelectedMeeting}
                onNavigate={setActiveView}
              />
            } />

            <Route path="/meetings" element={
              <MeetingsView
                meetings={meetings}
                drafting={drafting}
                currentUserId={profile.id}
                needsAction={needsAction}
                isCalendarConnected={isCalendarConnected}
                onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
                onNewMeeting={handleNewMeeting}
                onOpenMeeting={setSelectedMeeting}
              />
            } />

            <Route path="/calendar" element={
              <CalendarView
                meetings={meetings}
                calendarStatus={calendarStatus}
                onOpenMeeting={setSelectedMeeting}
                onCreateAt={handleCreateAt}
                onConnectCalendar={() => navigate('/profile', { state: { initialTab: 'calendar' } })}
              />
            } />

            <Route path="/people" element={
              <PeopleView
                users={users}
                meetings={meetings}
                currentUserId={profile.id}
                onScheduleWith={handleScheduleWith}
                onViewProfile={handleParticipantClick}
              />
            } />

            <Route path="/profile" element={
              <SettingsView
                profile={profile}
                meetings={meetings}
                calendarStatus={calendarStatus}
                theme={theme}
                setTheme={setTheme}
                onCalendarConnect={handleCalendarConnect}
                onCalendarDisconnect={handleCalendarDisconnect}
                onProfileUpdate={setProfile}
                onSignOut={signOut}
                initialTab={location.state?.initialTab}
              />
            } />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>

      {targetProfile && (
        <PublicProfile
          profile={targetProfile}
          currentUserId={profile?.id}
          onClose={() => setTargetProfile(null)}
          onScheduleWith={handleScheduleWith}
        />
      )}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNavigate={setActiveView}
          onNewMeeting={() => { setShowPalette(false); handleNewMeeting(); }}
          onNewMeetingFromText={async (text) => {
            setShowPalette(false);
            try { await handleNewMeetingFromText(text); }
            catch (e) { toast(e?.message || 'The AI parser is unavailable right now.', 'error'); }
          }}
          onOpenMeeting={(m) => { setShowPalette(false); setSelectedMeeting(m); }}
          onOpenPerson={(uid) => { setShowPalette(false); handleParticipantClick(uid); }}
          signOut={signOut}
          meetings={meetings}
          users={users}
        />
      )}

      {showGlobalCreate && (
        <CreateMeetingModal
          prefill={meetingPrefill}
          users={users}
          currentUserId={profile?.id}
          onClose={() => { setShowGlobalCreate(false); setMeetingPrefill(null); }}
          onSubmit={handleCreateMeeting}
        />
      )}

      {activeMeeting && (
        <MeetingDetailModal
          meeting={activeMeeting}
          currentUserId={profile?.id}
          allMeetings={meetings}
          isCalendarConnected={isCalendarConnected}
          onClose={() => setSelectedMeeting(null)}
          onRefresh={refreshAll}
          onAccept={handleAccept}
          onDecline={(requestId) => { setSelectedMeeting(null); setDeclineWizardId(requestId); }}
          onParticipantClick={handleParticipantClick}
        />
      )}

      {declineWizardId && (
        <DeclineWizard
          meeting={meetings.find(m => m.requestId === declineWizardId)}
          onSubmit={async (reason, comment) => {
            const result = await apiPost(`/api/meetings/${declineWizardId}/decline`, { reason, comment });
            await refreshAll();
            return result;
          }}
          onClose={() => setDeclineWizardId(null)}
        />
      )}
    </div>
  );
}

/** Gate: the editorial sign-in screen until Cognito reports authenticated. */
function AuthGate({ theme, setTheme }) {
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);
  if (authStatus !== 'authenticated') return <AuthScreen theme={theme} setTheme={setTheme} />;
  return <AppContent theme={theme} setTheme={setTheme} />;
}

export default function App() {
  const [theme, setTheme] = useTheme();
  return (
    <Authenticator.Provider>
      <AuthGate theme={theme} setTheme={setTheme} />
    </Authenticator.Provider>
  );
}
