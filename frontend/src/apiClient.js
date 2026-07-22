/**
 * apiClient.js
 *
 * API client for Smart Scheduler.
 *
 * TRANSPORT:
 * All calls POST to /api/proxy with `Authorization: Bearer <accessToken>` and
 * a JSON body { action, data }. The browser preflights this (non-simple
 * request); the no-auth `OPTIONS /{proxy+}` route on the HTTP API answers the
 * preflight with 2xx + CORS headers, bypassing the Cognito JWT authorizer that
 * sits on `ANY /{proxy+}` and would otherwise 401 the OPTIONS. The backend
 * validates the Cognito *access* token via cognito-idp:GetUser (no IAM needed)
 * and dispatches on the `action` field.
 *
 * (Historical note: calls previously tunnelled through GET /health with the
 * token + payload in the query string to dodge the preflight entirely. That
 * workaround is retired now that the OPTIONS route handles preflight; /health
 * remains as a plain health check and transitional fallback.)
 */

import { fetchAuthSession } from 'aws-amplify/auth';
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

/** Returns the Cognito access token. Pass forceRefresh=true to force a new token. */
async function getAccessToken(forceRefresh = false) {
    try {
        const session = await fetchAuthSession({ forceRefresh });
        return session.tokens?.accessToken?.toString() ?? '';
    } catch (e) {
        console.error('[apiClient] Could not retrieve access token:', e);
        return '';
    }
}

/**
 * Core proxy call.
 * POST /api/proxy  with  Authorization: Bearer <accessToken>  and JSON body
 * { action, data }.
 *
 * The token rides in the Authorization header (off the URL, out of access
 * logs) and the payload in the body (no URL-length limit). The preflight this
 * triggers is answered by the no-auth `OPTIONS /{proxy+}` route; the backend
 * validates the access token itself via cognito-idp:GetUser.
 *
 * On a 401, automatically retries once with a force-refreshed token in case
 * the access token had just expired.
 */
async function apiProxy(action, data = null, _isRetry = false) {
    const token = await getAccessToken(_isRetry);
    if (!token) throw new Error('Not authenticated');

    const res = await fetch(`${API_BASE}/api/proxy`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action, data }),
    });
    if (!res.ok) {
        // If 401 and we haven't retried yet, force-refresh the token and try once more
        if (res.status === 401 && !_isRetry) {
            console.warn('[apiClient] Got 401, refreshing token and retrying…');
            return apiProxy(action, data, true);
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status} at action=${action}`);
    }
    // The health endpoint always returns HTTP 200 (to avoid CORS-blocked 5xx).
    // Check the body's status field to detect backend errors.
    const body = await res.json();
    if (body?.status === 'error') {
        throw new Error(body.message || `Server error at action=${action}`);
    }
    return body;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

export async function apiGet(path) {
    if (path === '/api/profile') return apiProxy('profile');
    if (path === '/api/meetings') return apiProxy('meetings');
    if (path === '/api/calendar/status') return apiProxy('calendar_status');

    // /api/calendar/events?timeMin=...&timeMax=...
    const calEventsMatch = path.match(/^\/api\/calendar\/events\?(.+)$/);
    if (calEventsMatch) {
        const p = new URLSearchParams(calEventsMatch[1]);
        return apiProxy('calendar_events', { timeMin: p.get('timeMin'), timeMax: p.get('timeMax') });
    }

    // /api/meetings/<id>/log
    const logMatch = path.match(/^\/api\/meetings\/([^/]+)\/log$/);
    if (logMatch) return apiProxy(`meeting_log:${logMatch[1]}`);

    // /api/calendar/oauth_url?provider=<provider>
    const oauthUrlMatch = path.match(/^\/api\/calendar\/oauth_url\?provider=(.+)$/);
    if (oauthUrlMatch) return apiProxy(`oauth_url:${oauthUrlMatch[1]}`, { redirect_origin: window.location.origin });

    if (path === '/api/profile/stats') return apiProxy('profile_stats');

    if (path === '/api/users') return apiProxy('list_users');

    // /api/users/<userId>/shared_meetings
    const sharedMatch = path.match(/^\/api\/users\/([^/]+)\/shared_meetings$/);
    if (sharedMatch) return apiProxy(`shared_meetings:${sharedMatch[1]}`);

    // /api/profile/<userId>
    const publicProfileMatch = path.match(/^\/api\/profile\/([^/]+)$/);
    if (publicProfileMatch) return apiProxy(`get_public_profile:${publicProfileMatch[1]}`);

    return apiProxy(path);
}

export async function apiPost(path, body) {
    if (path === '/api/meetings/create') return apiProxy('create_meeting', body);

    // /api/meetings/<id>/accept
    const acceptMatch = path.match(/^\/api\/meetings\/([^/]+)\/accept$/);
    if (acceptMatch) return apiProxy(`accept:${acceptMatch[1]}`);

    // /api/meetings/<id>/book/<slot>  (slot may be URL-encoded)
    const bookMatch = path.match(/^\/api\/meetings\/([^/]+)\/book\/(.+)$/);
    if (bookMatch) return apiProxy(`book:${bookMatch[1]}:${decodeURIComponent(bookMatch[2])}`);

    // /api/meetings/<id>/decline
    const declineMatch = path.match(/^\/api\/meetings\/([^/]+)\/decline$/);
    if (declineMatch) return apiProxy(`decline:${declineMatch[1]}`, body);

    // /api/meetings/<id>/cancel
    const cancelMatch = path.match(/^\/api\/meetings\/([^/]+)\/cancel$/);
    if (cancelMatch) return apiProxy(`cancel:${cancelMatch[1]}`);

    // /api/meetings/<id>/edit
    const editMatch = path.match(/^\/api\/meetings\/([^/]+)\/edit$/);
    if (editMatch) return apiProxy(`edit:${editMatch[1]}`, body);

    // /api/meetings/<id>/reschedule
    const rescheduleMatch = path.match(/^\/api\/meetings\/([^/]+)\/reschedule$/);
    if (rescheduleMatch) return apiProxy(`reschedule:${rescheduleMatch[1]}`);

    // /api/calendar/callback — OAuth authorization code exchange
    if (path === '/api/calendar/callback') return apiProxy(`oauth_callback:${body.provider}`, body);

    // /api/calendar/disconnect
    if (path === '/api/calendar/disconnect') return apiProxy(`calendar_disconnect:${body.provider}`);

    // /api/meetings/<id>/book_custom
    const bookCustomMatch = path.match(/^\/api\/meetings\/([^/]+)\/book_custom$/);
    if (bookCustomMatch) return apiProxy(`book_custom:${bookCustomMatch[1]}`, body);

    // /api/profile/fairness/reset
    if (path === '/api/profile/fairness/reset') return apiProxy('reset_fairness');

    // /api/profile/update
    if (path === '/api/profile/update') return apiProxy('update_profile', body);

    return apiProxy(path, body);
}

/** Score a manually selected time slot for fairness (no side effects). */
export async function apiScoreSlot(startIso, durationMinutes, participantIds = []) {
    return apiProxy('score_slot', { startIso, durationMinutes, participantIds });
}

/** Parse a free-text meeting request into prefill fields. */
export async function apiParseMeetingNL(text) {
    return apiProxy('parse_meeting_nl', { text });
}

/** Register (or renew) a Google Calendar push-notification watch channel. */
export async function apiRegisterCalendarWatch() {
    return apiProxy('register_calendar_watch');
}

/**
 * Returns { changeToken } — an opaque string that increments each time Google
 * fires a webhook notification. The frontend compares this against its cached
 * value to decide whether to re-fetch calendar events.
 */
export async function apiCheckCalendarSync() {
    return apiProxy('check_calendar_sync');
}
