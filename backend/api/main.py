import logging
import os
from pathlib import Path
from typing import Optional

# Auto-load .env when running locally with uvicorn
if os.environ.get('ENVIRONMENT') == 'development':
    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).parent.parent.parent / '.env')
    except ImportError:
        pass

import json

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from src.common.auth import validate_access_token
from src.handlers.api.dispatcher import dispatch
from src.handlers.lambda_entry import sfn_router

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = FastAPI()

_FRONTEND_URL = os.environ.get('FRONTEND_URL', 'https://main.dhcxa23q98ibd.amplifyapp.com')

app.add_middleware(
    CORSMiddleware,
    allow_origins=[_FRONTEND_URL, 'http://localhost:5273', 'http://localhost:5173'],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------

_mangum = Mangum(app)


def handler(event, context):
    print(f"[handler] event: {event}")
    if 'sfn_action' in event:
        return sfn_router(event, context)
    return _mangum(event, context)


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/proxy")
async def api_proxy(request: Request, authorization: Optional[str] = Header(None)):
    """
    The frontend's sole authenticated transport. The Cognito access token rides
    in the Authorization header (off the URL and out of access logs) and the
    payload in the JSON body (no URL-length limit). Route has no gateway
    authorizer — we validate the access token here via cognito-idp:GetUser, then
    dispatch.

    Body: {"action": "<action>", "data": <object|string|null>}
    Always returns HTTP 200; check body.status === 'error' on the frontend.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON")

    action = body.get("action")
    data = body.get("data")
    # dispatch() expects data as a JSON string.
    if data is not None and not isinstance(data, str):
        data = json.dumps(data)

    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if not action or not token:
        raise HTTPException(status_code=400, detail="Missing action or Authorization token")

    try:
        identity = validate_access_token(token)
        if not identity:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return dispatch(action, identity, data)
    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return {"status": "error", "action": action, "message": f"Internal error: {exc}"}


# ---------------------------------------------------------------------------
# Google Calendar push-notification webhook (public, no JWT)
# ---------------------------------------------------------------------------

from src.database.repository import CalendarRepository as _CalendarRepo

_wh_cal_repo = _CalendarRepo()


@app.post("/webhook/google-calendar")
async def google_calendar_webhook(request: Request):
    """
    Public endpoint — no JWT required. Receives push notifications from Google
    Calendar and bumps the user's changeToken so the frontend's sync poll detects
    the change within ~5 s and re-fetches events.
    """
    resource_state = request.headers.get("X-Goog-Resource-State", "")
    channel_id     = request.headers.get("X-Goog-Channel-ID", "")

    # Google sends an initial "sync" notification when the watch is first registered.
    # Just acknowledge it — there are no actual changes yet.
    if resource_state == "sync":
        return {"status": "ok"}

    if channel_id:
        user_id = _wh_cal_repo.get_user_id_by_channel(channel_id)
        if user_id:
            _wh_cal_repo.bump_change_token(user_id)

    return {"status": "ok"}
