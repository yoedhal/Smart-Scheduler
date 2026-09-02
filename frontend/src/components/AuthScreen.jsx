import { Authenticator } from '@aws-amplify/ui-react';
import { Ico } from '../ui/Primitives.jsx';

/**
 * Sign-in screen. The left panel is the editorial statement; the right hosts
 * Amplify's Cognito flow untouched — sign-up, confirmation codes, password
 * reset and MFA all still run through it, restyled via `.auth-r` in app.css.
 */
export default function AuthScreen({ theme, setTheme }) {
  return (
    <div className="auth">
      <div className="auth-l">
        <div className="lockup">
          <span className="lockup-mark"><img src="/Smart-Scheduler.png" alt="" /></span>
          <span className="lockup-name">Smart Scheduler</span>
        </div>

        <div>
          <h1 className="auth-stat">Somebody always takes the <i>bad</i> meeting slot.</h1>
          <p className="auth-note">
            Smart Scheduler keeps score. It reads everyone's calendar, ranks every possible time by
            how much it costs each person, and remembers who compromised last time.
          </p>
        </div>
      </div>

      <div className="auth-r">
        <div className="auth-form">
          {/* Left exactly as configured before: sign-up fields are inferred from
              the Cognito pool, so the flow is unchanged — only the skin is new. */}
          <Authenticator />

          <p className="auth-fine">
            Connecting a calendar is optional to sign in, but nothing gets scored without one.
            Smart Scheduler reads availability only. Event titles and attendees never leave your calendar.
          </p>

          <div className="auth-foot">
            <span className="eyebrow">Smart Scheduler</span>
            <button
              className="icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              <Ico n={theme === 'dark' ? 'sun' : 'moon'} s={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
