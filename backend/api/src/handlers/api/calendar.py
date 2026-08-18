from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone

from src.common import calendar_client
from fastapi import HTTPException

from src.database.repository import CalendarRepository, UserRepository

logger = logging.getLogger(__name__)

_cal_repo = CalendarRepository()
_user_repo = UserRepository()


def handle_calendar_events(identity: dict, data: str | None) -> list:
    try:
        params = json.loads(data) if data else {}
        time_min = params.get("timeMin", "")
        time_max = params.get("timeMax", "")
        if not time_min or not time_max:
            return []
        user_id = identity["user_id"]
        events = calendar_client.get_google_events(user_id, time_min, time_max)
        ics_url = _cal_repo.get_ics_url(user_id)
        if ics_url:
            for ev in calendar_client.get_ics_events(ics_url, time_min, time_max):
                ev["source"] = "ics"
                events.append(ev)
        return events
    except Exception as exc:
        logger.warning(f"[calendar_events] {exc}")
        return []


def handle_calendar_status(identity: dict) -> dict:
    try:
        result = _cal_repo.get_connected_calendars(identity["user_id"])
        ics_url = _cal_repo.get_ics_url(identity["user_id"])
        result["ics"] = {"connected": bool(ics_url), "url": ics_url}
        return result
    except Exception as exc:
        logger.warning(f"[calendar_status] {exc}")
        return {
            "google": {"connected": False, "email": ""},
            "ics": {"connected": False, "url": ""},
        }


def handle_oauth_url(identity: dict, action: str, data: str | None = None) -> dict:
    provider = action.split(":", 1)[1]
    redirect_origin = None
    if data:
        try:
            redirect_origin = json.loads(data).get('redirect_origin')
        except Exception:
            pass
    if provider == "google":
        if not calendar_client._gid():
            raise HTTPException(
                status_code=503,
                detail="Google Calendar not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Lambda environment.",
            )
        return {"url": calendar_client.get_google_auth_url(identity["user_id"], redirect_origin), "provider": "google"}
    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


def handle_oauth_callback(identity: dict, action: str, data: str | None) -> dict:
    provider = action.split(":", 1)[1]
    if not data:
        raise HTTPException(status_code=400, detail="Missing callback data")
    try:
        cb = json.loads(data)
        code = cb.get("code", "")
        raw_state = cb.get("state", "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid callback data: {exc}")

    if not code:
        raise HTTPException(status_code=400, detail="Missing OAuth code")

    state_parts = raw_state.split(":", 2)
    user_id = identity["user_id"]
    if len(state_parts) != 3 or state_parts[0] != provider or state_parts[1] != user_id:
        raise HTTPException(status_code=400, detail="Invalid state parameter")

    nonce = state_parts[2]
    validated_provider = _cal_repo.validate_and_consume_oauth_state(user_id, nonce)
    if not validated_provider:
        raise HTTPException(status_code=400, detail="Invalid or expired state. Please try connecting again.")

    redirect_origin = cb.get('redirect_origin')

    if provider == "google":
        try:
            tokens = calendar_client.exchange_google_code(code, redirect_origin)
        except Exception as exc:
            logger.error(f"[oauth_callback] Google token exchange failed for {user_id}: {exc}")
            raise HTTPException(status_code=400, detail=f"Token exchange failed: {exc}")
        calendar_email = calendar_client.get_google_user_email(tokens.get("access_token", ""))
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))
        _cal_repo.save_oauth_tokens(user_id, "google", {
            "access_token": tokens.get("access_token", ""),
            "refresh_token": tokens.get("refresh_token", ""),
            "expires_at": expires_at.isoformat(),
            "scope": tokens.get("scope", ""),
            "calendar_email": calendar_email,
        })
        return {"status": "success", "provider": "google", "email": calendar_email}

    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


def handle_disconnect(identity: dict, action: str) -> dict:
    provider = action.split(":", 1)[1]
    user_id = identity["user_id"]
    if provider == "google":
        channel = _cal_repo.get_watch_channel(user_id)
        if channel:
            calendar_client.stop_google_watch(user_id, channel["channelId"], channel["resourceId"])
            _cal_repo.delete_watch_channel(user_id)
    _cal_repo.delete_oauth_tokens(user_id, provider)
    return {"status": "success", "provider": provider, "connected": False}


def handle_register_watch(identity: dict) -> dict:
    """Register (or renew) a Google Calendar push-notification watch channel."""
    user_id = identity["user_id"]
    existing = _cal_repo.get_watch_channel(user_id)
    if existing:
        expires_at = existing.get("expiresAt", "")
        try:
            exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < exp - timedelta(hours=24):
                return {"status": "active", "expiresAt": expires_at}
        except Exception:
            pass
        # Existing channel is expired or expiring soon — stop it and re-register
        calendar_client.stop_google_watch(user_id, existing["channelId"], existing["resourceId"])
        _cal_repo.delete_watch_channel(user_id)

    if not calendar_client.WEBHOOK_BASE_URL:
        logger.warning("[register_watch] WEBHOOK_BASE_URL not set — push notifications disabled; frontend will fall back to polling")

    channel_id = secrets.token_urlsafe(16)
    result = calendar_client.register_google_watch(user_id, channel_id)
    if not result:
        return {"status": "unavailable"}

    expiration_ms = int(result.get("expiration", 0))
    expires_at = (
        datetime.fromtimestamp(expiration_ms / 1000, tz=timezone.utc).isoformat()
        if expiration_ms else ""
    )
    _cal_repo.save_watch_channel(user_id, result["id"], result["resourceId"], expires_at)
    return {"status": "registered", "expiresAt": expires_at}


def handle_check_sync(identity: dict) -> dict:
    """Return the current changeToken so the frontend can detect webhook-triggered updates."""
    return {"changeToken": _cal_repo.get_change_token(identity["user_id"])}
