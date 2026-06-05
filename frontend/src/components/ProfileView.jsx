import { useState, useEffect } from 'react';
import { apiGet } from '../apiClient';
import ProfileTab from './profile/ProfileTab.jsx';
import PreferencesTab from './profile/PreferencesTab.jsx';
import FairnessTab from './profile/FairnessTab.jsx';
import CalendarCard from './profile/CalendarCard.jsx';
import './ProfileView.css';

/* ─────────────────────────────────────────────
   ProfileView — 4-tab settings page
───────────────────────────────────────────── */
export default function ProfileView({
  profile: initialProfile,
  meetings,
  calendarStatus,
  onCalendarConnect,
  onCalendarDisconnect,
  onProfileUpdate,
  initialTab,
  expandFairness = false,
}) {
  const [profile, setProfile]         = useState(initialProfile);
  const [activeTab, setActiveTab]     = useState(initialTab || 'profile');
  const [disconnectConfirm, setDisconnectConfirm] = useState(null);
  const [stats, setStats]             = useState(null);

  useEffect(() => { apiGet('/api/profile/stats').then(setStats).catch(() => {}); }, []);

  const handleProfileUpdate = (updated) => {
    setProfile(updated);
    if (onProfileUpdate) onProfileUpdate(updated);
  };

  const confirmDisconnect = () => {
    if (disconnectConfirm) {
      onCalendarDisconnect(disconnectConfirm);
      setDisconnectConfirm(null);
    }
  };

  const TABS = [
    { id: 'profile',     label: 'Profile'     },
    { id: 'preferences', label: 'Preferences' },
    { id: 'calendar',    label: 'Calendar'    },
    { id: 'fairness',    label: 'Fairness'    },
  ];

  return (
    <div className="pv-wrap">

      {/* Disconnect confirmation */}
      {disconnectConfirm && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setDisconnectConfirm(null)}>
          <div className="modal-box confirm-box" style={{ maxWidth: '380px' }}>
            <div className="modal-head">
              <h3>Disconnect Calendar</h3>
              <button className="modal-close" onClick={() => setDisconnectConfirm(null)}>✕</button>
            </div>
            <div className="confirm-body">
              <p>Disconnect Google Calendar? Your meetings will no longer sync.</p>
              <div className="modal-actions">
                <button className="btn-danger" onClick={confirmDisconnect}>Disconnect</button>
                <button className="btn-cancel" onClick={() => setDisconnectConfirm(null)}>Keep Connected</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="pv-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`pv-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.badge && <span className="tab-badge" />}
          </button>
        ))}
      </div>

      {/* ──────────────── TAB CONTENT (key triggers re-animation on switch) ──────────────── */}
      <div key={activeTab} className="pv-tab-content">

        {activeTab === 'profile' && (
          <ProfileTab
            profile={profile}
            meetings={meetings}
            stats={stats}
            onProfileUpdate={handleProfileUpdate}
          />
        )}

        {activeTab === 'preferences' && (
          <PreferencesTab profile={profile} onProfileUpdate={handleProfileUpdate} />
        )}

        {activeTab === 'calendar' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <CalendarCard
              brand="google"
              name="Google Calendar"
              status={calendarStatus?.google}
              onConnect={onCalendarConnect}
              onDisconnect={() => setDisconnectConfirm('google')}
            />
          </div>
        )}

        {activeTab === 'fairness' && (
          <FairnessTab profile={profile} onProfileUpdate={handleProfileUpdate} defaultExpanded={expandFairness} />
        )}

      </div>{/* end pv-tab-content */}
    </div>
  );
}
