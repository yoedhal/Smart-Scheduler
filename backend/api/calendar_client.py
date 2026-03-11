"""
calendar_client.py — Google Calendar & Microsoft Outlook OAuth integration.

Uses only Python stdlib (urllib.request / urllib.parse / json) so the Lambda
ZIP stays small.  No google-auth, no msal, no requests/httpx.

OAuth Flow:
  1. Frontend calls action=oauth_url:google  → gets redirect URL
  2. User is redirected to Google/Microsoft consent screen
  3. Provider redirects back to FRONTEND_URL/?code=...&state=...
  4. Frontend calls action=oauth_callback:google with {code, state}
  5. Backend exchanges code → stores tokens in DynamoDB
  6. On subsequent API calls, tokens are used to read/write calendar events
"""

import json
import os
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from typing import List, Optional

import db   # local module

# ---------------------------------------------------------------------------
# Config (from Lambda environment variables)
# ---------------------------------------------------------------------------

FRONTEND_URL         = os.environ.get('FRONTEND_URL', 'https://main.dswqybh1v4bo.amplifyapp.com')
GOOGLE_CLIENT_ID     = os.environ.get('GOOGLE_CLIENT_ID', '')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', '')
MS_CLIENT_ID         = os.environ.get('MICROSOFT_CLIENT_ID', '')
MS_CLIENT_SECRET     = os.environ.get('MICROSOFT_CLIENT_SECRET', '')

# Redirect URI — Use the base URL directly (the React app handles query params on mount)
REDIRECT_URI = FRONTEND_URL if FRONTEND_URL.endswith('/') else FRONTEND_URL + '/'

GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token'
GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
GOOGLE_USERINFO   = 'https://www.googleapis.com/oauth2/v3/userinfo'
GOOGLE_CALENDAR   = 'https://www.googleapis.com/calendar/v3'

MS_TENANT       = 'common'
MS_AUTH_URL     = f'https://login.microsoftonline.com/{MS_TENANT}/oauth2/v2.0/authorize'
MS_TOKEN_URL    = f'https://login.microsoftonline.com/{MS_TENANT}/oauth2/v2.0/token'
MS_GRAPH        = 'https://graph.microsoft.com/v1.0'


# ---------------------------------------------------------------------------
# Generic HTTP helpers
# ---------------------------------------------------------------------------

def _http_get(url: str, headers: dict = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def _http_post(url: str, data: dict, headers: dict = None) -> dict:
    encoded = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=encoded, headers=headers or {})
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


# ---------------------------------------------------------------------------
# Google Calendar OAuth
# ---------------------------------------------------------------------------

def get_google_auth_url(user_id: str) -> str:
    """Build the Google OAuth2 authorization URL and store state nonce."""
    import secrets
    state = secrets.token_urlsafe(24)
    db.save_oauth_state(user_id, 'google', state)

    params = urllib.parse.urlencode({
        'client_id':     GOOGLE_CLIENT_ID,
        'redirect_uri':  REDIRECT_URI,
        'response_type': 'code',
        'scope':         'openid email https://www.googleapis.com/auth/calendar',
        'access_type':   'offline',
        'prompt':        'consent',
        'state':         f'google:{user_id}:{state}',
    })
    return f"{GOOGLE_AUTH_URL}?{params}"


def exchange_google_code(code: str) -> dict:
    """Exchange authorization code for access + refresh tokens."""
    return _http_post(GOOGLE_TOKEN_URL, {
        'code':          code,
        'client_id':     GOOGLE_CLIENT_ID,
        'client_secret': GOOGLE_CLIENT_SECRET,
        'redirect_uri':  REDIRECT_URI,
        'grant_type':    'authorization_code',
    })


def refresh_google_token(refresh_token: str) -> dict:
    """Refresh an expired Google access token."""
    return _http_post(GOOGLE_TOKEN_URL, {
        'refresh_token': refresh_token,
        'client_id':     GOOGLE_CLIENT_ID,
        'client_secret': GOOGLE_CLIENT_SECRET,
        'grant_type':    'refresh_token',
    })


def get_google_user_email(access_token: str) -> str:
    """Fetch the Google account email via userinfo endpoint."""
    try:
        info = _http_get(GOOGLE_USERINFO, headers={'Authorization': f'Bearer {access_token}'})
        return info.get('email', '')
    except Exception:
        return ''


def _ensure_fresh_google_token(user_id: str) -> Optional[str]:
    """Return a valid access token, refreshing if needed. None if not connected."""
    tokens = db.get_oauth_tokens(user_id, 'google')
    if not tokens:
        return None

    expires_at = tokens.get('expiresAt', '')
    access_token = tokens.get('accessToken', '')
    refresh_token = tokens.get('refreshToken', '')

    # Refresh if expires within 5 minutes
    try:
        expires_ts = datetime.fromisoformat(expires_at).timestamp()
        if time.time() + 300 > expires_ts:
            refreshed = refresh_google_token(refresh_token)
            access_token = refreshed['access_token']
            new_expires = datetime.fromtimestamp(time.time() + refreshed.get('expires_in', 3600)).isoformat()
            db.save_oauth_tokens(user_id, 'google', {
                'access_token':  access_token,
                'refresh_token': refresh_token,   # Google doesn't always return a new one
                'expires_at':    new_expires,
                'scope':         tokens.get('scopes', ''),
                'calendar_email': tokens.get('calendarEmail', ''),
            })
    except Exception:
        pass   # Use existing token, let the API call fail if truly expired

    return access_token


def get_google_events(user_id: str, time_min: str, time_max: str) -> List[dict]:
    """Fetch Google Calendar events for the user in the given ISO time range."""
    token = _ensure_fresh_google_token(user_id)
    if not token:
        return []
    try:
        params = urllib.parse.urlencode({
            'timeMin':      time_min,
            'timeMax':      time_max,
            'singleEvents': 'true',
            'orderBy':      'startTime',
        })
        url = f"{GOOGLE_CALENDAR}/calendars/primary/events?{params}"
        resp = _http_get(url, headers={'Authorization': f'Bearer {token}'})
        events = []
        for ev in resp.get('items', []):
            start = ev.get('start', {}).get('dateTime') or ev.get('start', {}).get('date', '')
            end   = ev.get('end',   {}).get('dateTime') or ev.get('end',   {}).get('date', '')
            events.append({
                'summary': ev.get('summary', 'Busy'),
                'start':   start,
                'end':     end,
            })
        return events
    except Exception:
        return []


def create_google_event(user_id: str, title: str, start_iso: str, end_iso: str,
                        attendee_emails: List[str] = None) -> bool:
    """Create a Google Calendar event after booking. Returns True on success."""
    token = _ensure_fresh_google_token(user_id)
    if not token:
        return False
    try:
        event_body = {
            'summary': title,
            'start':   {'dateTime': start_iso, 'timeZone': 'Asia/Jerusalem'},
            'end':     {'dateTime': end_iso,   'timeZone': 'Asia/Jerusalem'},
            'attendees': [{'email': e} for e in (attendee_emails or [])],
        }
        data = json.dumps(event_body).encode()
        url  = f"{GOOGLE_CALENDAR}/calendars/primary/events"
        req  = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=10):
            return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Microsoft Outlook OAuth
# ---------------------------------------------------------------------------

def get_microsoft_auth_url(user_id: str) -> str:
    """Build the Microsoft OAuth2 authorization URL."""
    import secrets
    state = secrets.token_urlsafe(24)
    db.save_oauth_state(user_id, 'microsoft', state)

    params = urllib.parse.urlencode({
        'client_id':     MS_CLIENT_ID,
        'redirect_uri':  REDIRECT_URI,
        'response_type': 'code',
        'response_mode': 'query',
        'scope':         'openid email offline_access Calendars.ReadWrite',
        'state':         f'microsoft:{user_id}:{state}',
    })
    return f"{MS_AUTH_URL}?{params}"


def exchange_microsoft_code(code: str) -> dict:
    """Exchange authorization code for Microsoft tokens."""
    return _http_post(MS_TOKEN_URL, {
        'code':          code,
        'client_id':     MS_CLIENT_ID,
        'client_secret': MS_CLIENT_SECRET,
        'redirect_uri':  REDIRECT_URI,
        'grant_type':    'authorization_code',
    })


def refresh_microsoft_token(refresh_token: str) -> dict:
    """Refresh an expired Microsoft access token."""
    return _http_post(MS_TOKEN_URL, {
        'refresh_token': refresh_token,
        'client_id':     MS_CLIENT_ID,
        'client_secret': MS_CLIENT_SECRET,
        'grant_type':    'refresh_token',
        'scope':         'openid email offline_access Calendars.ReadWrite',
    })


def _ensure_fresh_microsoft_token(user_id: str) -> Optional[str]:
    """Return a valid Microsoft access token, refreshing if needed."""
    tokens = db.get_oauth_tokens(user_id, 'microsoft')
    if not tokens:
        return None

    expires_at   = tokens.get('expiresAt', '')
    access_token = tokens.get('accessToken', '')
    refresh_token = tokens.get('refreshToken', '')

    try:
        expires_ts = datetime.fromisoformat(expires_at).timestamp()
        if time.time() + 300 > expires_ts:
            refreshed    = refresh_microsoft_token(refresh_token)
            access_token = refreshed['access_token']
            new_expires  = datetime.fromtimestamp(
                time.time() + refreshed.get('expires_in', 3600)
            ).isoformat()
            db.save_oauth_tokens(user_id, 'microsoft', {
                'access_token':   access_token,
                'refresh_token':  refreshed.get('refresh_token', refresh_token),
                'expires_at':     new_expires,
                'scope':          tokens.get('scopes', ''),
                'calendar_email': tokens.get('calendarEmail', ''),
            })
    except Exception:
        pass

    return access_token


def get_microsoft_events(user_id: str, time_min: str, time_max: str) -> List[dict]:
    """Fetch Microsoft Graph calendar events for the user."""
    token = _ensure_fresh_microsoft_token(user_id)
    if not token:
        return []
    try:
        params = urllib.parse.urlencode({'startDateTime': time_min, 'endDateTime': time_max})
        url    = f"{MS_GRAPH}/me/calendarView?{params}"
        resp   = _http_get(url, headers={
            'Authorization': f'Bearer {token}',
            'Prefer':        'outlook.timezone="Asia/Jerusalem"',
        })
        events = []
        for ev in resp.get('value', []):
            events.append({
                'summary': ev.get('subject', 'Busy'),
                'start':   ev.get('start', {}).get('dateTime', ''),
                'end':     ev.get('end',   {}).get('dateTime', ''),
            })
        return events
    except Exception:
        return []


def create_microsoft_event(user_id: str, title: str, start_iso: str, end_iso: str,
                           attendee_emails: List[str] = None) -> bool:
    """Create an Outlook Calendar event after booking."""
    token = _ensure_fresh_microsoft_token(user_id)
    if not token:
        return False
    try:
        event_body = {
            'subject': title,
            'start':   {'dateTime': start_iso, 'timeZone': 'Asia/Jerusalem'},
            'end':     {'dateTime': end_iso,   'timeZone': 'Asia/Jerusalem'},
            'attendees': [
                {'emailAddress': {'address': e}, 'type': 'required'}
                for e in (attendee_emails or [])
            ],
        }
        data = json.dumps(event_body).encode()
        url  = f"{MS_GRAPH}/me/events"
        req  = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=10):
            return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Unified helpers (used by fairness engine + booking flow)
# ---------------------------------------------------------------------------

def get_user_busy_slots(user_id: str, date_start: datetime, date_end: datetime) -> List[dict]:
    """
    Returns a unified list of busy time windows from the user's connected calendars.
    Tries Google first, then Microsoft. Returns [] if no calendar connected.
    Each entry: {"start": ISO string, "end": ISO string, "summary": string}
    """
    time_min = date_start.isoformat() + 'Z'
    time_max = date_end.isoformat() + 'Z'

    events = get_google_events(user_id, time_min, time_max)
    if not events:
        events = get_microsoft_events(user_id, time_min, time_max)
    return events


def write_meeting_to_calendars(creator_id: str, participant_ids: List[str],
                                title: str, start_iso: str, end_iso: str):
    """
    Best-effort: write a confirmed meeting to every participant's connected calendar.
    Never raises — failures are silently ignored.
    """
    all_ids = list({creator_id} | set(participant_ids))
    # Collect attendee emails for invites
    attendee_emails = []
    for uid in all_ids:
        tokens_g = db.get_oauth_tokens(uid, 'google')
        tokens_m = db.get_oauth_tokens(uid, 'microsoft')
        email = (tokens_g or tokens_m or {}).get('calendarEmail', '')
        if email:
            attendee_emails.append(email)

    for uid in all_ids:
        try:
            if db.get_oauth_tokens(uid, 'google'):
                create_google_event(uid, title, start_iso, end_iso, attendee_emails)
            elif db.get_oauth_tokens(uid, 'microsoft'):
                create_microsoft_event(uid, title, start_iso, end_iso, attendee_emails)
        except Exception:
            pass
