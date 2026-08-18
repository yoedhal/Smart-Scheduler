from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError
from fastapi import HTTPException

from src.common.dynamo import get_db
from src.database import models


# ---------------------------------------------------------------------------
# UserRepository
# ---------------------------------------------------------------------------

class UserRepository:
    def __init__(self) -> None:
        self._db = get_db()

    def ensure_profile(self, user_id: str, email: str, display_name: str) -> None:
        if self._db.get(f"USER#{user_id}", "PROFILE"):
            return
        self._db.put(
            f"USER#{user_id}", "PROFILE",
            models.UserProfile(
                userId=user_id, email=email, displayName=display_name,
                timezone="UTC",
                workingHours={"start": "09:00", "end": "18:00"},
                workingDays=list(range(5)),
            ).model_dump(mode="json"),
        )
        self._db.put(
            f"USER#{user_id}", "FAIRNESS",
            models.FairnessState(
                userId=user_id, fairnessScore= 50.0,
                meetingLoadMetrics={
                    "meetings_this_week": 0,
                    "prime_slots_accepted": 0,
                    "cancellation_timestamps": [],
                },
                inconvenientMeetingsCount=0,
                lastWeekReset=datetime.now().isoformat(),
            ).model_dump(mode="json"),
        )

    def _maybe_reset_weekly(self, fairness_data: dict) -> dict:
        """Reset meetings_this_week if 7+ days have passed since last reset."""
        last_reset = fairness_data.get("lastWeekReset")
        if last_reset:
            days_since = (datetime.now() - datetime.fromisoformat(str(last_reset))).total_seconds() / 86400
            if days_since >= 7:
                metrics = dict(fairness_data.get("meetingLoadMetrics", {}))
                metrics["meetings_this_week"] = 0
                fairness_data = {**fairness_data, "meetingLoadMetrics": metrics,
                                 "lastWeekReset": datetime.now().isoformat()}
        else:
            fairness_data = {**fairness_data, "lastWeekReset": datetime.now().isoformat()}
        return fairness_data

    def get_profile(self, user_id: str) -> Optional[models.UserProfile]:
        data = self._db.get(f"USER#{user_id}", "PROFILE")
        return models.UserProfile(**data) if data else None

    def get_profile_raw(self, user_id: str) -> Optional[dict]:
        return self._db.get(f"USER#{user_id}", "PROFILE")

    def update_profile(self, user_id: str, updates: dict) -> Optional[models.UserProfile]:
        data = self._db.get(f"USER#{user_id}", "PROFILE")
        if not data:
            return None
        for k, v in updates.items():
            if k in models.UserProfile.model_fields and v is not None:
                data[k] = v
        self._db.put(f"USER#{user_id}", "PROFILE", data)
        return models.UserProfile(**data)

    def get_fairness(self, user_id: str) -> Optional[models.FairnessState]:
        data = self._db.get(f"USER#{user_id}", "FAIRNESS")
        return models.FairnessState(**data) if data else None

    def update_fairness_for_single(
        self,
        user_id: str,
        personal_impact: float,
        breakdown: Optional[dict] = None,
    ) -> None:
        """Update one participant's fairness using their personal impact value."""
        from src.core.fairness import engine
        try:
            fairness = self.get_fairness(user_id)
            if not fairness:
                self.ensure_profile(user_id, "", user_id[:8])
                fairness = self.get_fairness(user_id)
            if not fairness:
                return
            now = datetime.now().isoformat()
            raw = self._maybe_reset_weekly(fairness.model_dump(mode="json"))
            updated = engine.update_score_after_booking(
                {
                    "fairnessScore":      float(raw["fairnessScore"]),
                    "meetingLoadMetrics": raw["meetingLoadMetrics"],
                    "lastUpdatedAt":      raw.get("lastUpdatedAt", now),
                },
                personal_impact,
            )
            metrics = updated["meetingLoadMetrics"]
            delta = engine._impact_to_balance_delta(personal_impact)
            if breakdown is not None:
                breakdown = dict(breakdown)
                breakdown["delta"] = delta
            else:
                breakdown = {"delta": delta}
            metrics["last_booking_breakdown"] = breakdown
            self._db.put(f"USER#{user_id}", "FAIRNESS", {
                "userId": user_id,
                **updated,
                "meetingLoadMetrics": metrics,
                "inconvenientMeetingsCount": (
                    fairness.inconvenientMeetingsCount + updated["inconvenientMeetingsCount"]
                ),
                "lastWeekReset":   raw.get("lastWeekReset", now),
                "lastUpdatedAt":   now,
            })
        except Exception as exc:
            logger.warning(f"[fairness_update] failed for {user_id}: {exc}")

    def reverse_fairness_for_single(self, user_id: str) -> None:
        """Undo the last booking's fairness delta for one user."""
        from src.core.fairness import engine
        try:
            fairness = self.get_fairness(user_id)
            if not fairness:
                return
            breakdown = (fairness.meetingLoadMetrics or {}).get("last_booking_breakdown")
            if not breakdown:
                return
            delta = int(breakdown.get("delta", 0))
            if delta == 0:
                return
            now = datetime.now().isoformat()
            raw = self._maybe_reset_weekly(fairness.model_dump(mode="json"))
            metrics = dict(raw["meetingLoadMetrics"])
            balance = float(metrics.get("fairness_balance", 0.0))
            balance = max(-50.0, min(50.0, balance - delta))
            was_inconvenient = delta > 0
            metrics.update({
                "fairness_balance": round(balance, 1),
                "meetings_this_week": max(0, int(metrics.get("meetings_this_week", 1)) - 1),
                "inconvenient_count": max(0, int(metrics.get("inconvenient_count", 0)) - (1 if was_inconvenient else 0)),
                "convenient_count": max(0, int(metrics.get("convenient_count", 0)) - (0 if was_inconvenient else 1)),
                "last_booking_breakdown": None,
            })
            new_score = engine.calculate_user_score(metrics, raw.get("lastUpdatedAt"))
            self._db.put(f"USER#{user_id}", "FAIRNESS", {
                "userId": user_id,
                "fairnessScore": new_score,
                "meetingLoadMetrics": metrics,
                "inconvenientMeetingsCount": max(0, fairness.inconvenientMeetingsCount - (1 if was_inconvenient else 0)),
                "lastWeekReset": raw.get("lastWeekReset", now),
                "lastUpdatedAt": now,
            })
        except Exception as exc:
            logger.warning(f"[fairness_reversal] failed for {user_id}: {exc}")

    def update_fairness_on_cancel(self, user_id: str) -> None:
        """Add a cancellation timestamp to the organizer's fairness record (expires in 30 days)."""
        from src.core.fairness import engine
        fairness = self.get_fairness(user_id)
        if not fairness:
            return
        now = datetime.now().isoformat()
        raw = self._maybe_reset_weekly(fairness.model_dump(mode="json"))
        updated = engine.update_score_after_cancel(
            {"fairnessScore": float(raw["fairnessScore"]),
             "meetingLoadMetrics": raw["meetingLoadMetrics"],
             "lastUpdatedAt": raw.get("lastUpdatedAt", now)},
        )
        self._db.put(f"USER#{user_id}", "FAIRNESS", {
            "userId": user_id,
            **updated,
            "inconvenientMeetingsCount": fairness.inconvenientMeetingsCount,
            "lastWeekReset": raw.get("lastWeekReset", now),
            "lastUpdatedAt": now,
        })

    def has_oauth_tokens(self, user_id: str, provider: str) -> bool:
        return bool(self._db.get(f"USER#{user_id}", f"OAUTH#{provider}"))

    def get_by_emails(self, emails: List[str]) -> List[dict]:
        normalised = {e.strip().lower() for e in emails if e.strip()}
        if not normalised:
            return []
        all_profiles = self._db.scan(FilterExpression=Attr("SK").eq("PROFILE"))
        return [p for p in all_profiles if p.get("email", "").lower() in normalised]

    def get_by_ids(self, user_ids: List[str]) -> Dict[str, dict]:
        result: Dict[str, dict] = {}
        for uid in user_ids:
            profile = self._db.get(f"USER#{uid}", "PROFILE")
            result[uid] = (
                {"name": profile.get("displayName", uid[:8] + "..."), "email": profile.get("email", "")}
                if profile
                else {"name": uid[:8] + "...", "email": ""}
            )
        return result

    def get_all_users(self, exclude_user_id: str) -> list:
        all_profiles = self._db.scan(FilterExpression=Attr("SK").eq("PROFILE"))
        result = []
        for p in all_profiles:
            uid = p.get("userId", "")
            if uid and uid != exclude_user_id:
                fairness = self._db.get(f"USER#{uid}", "FAIRNESS")
                p["fairness_score"] = float(fairness.get("fairnessScore", 100)) if fairness else 100.0
                result.append(p)
            if len(result) >= 50:
                break
        return result

    def get_shared_meetings(self, user_a_id: str, user_b_id: str) -> dict:
        a_parts = {
            item.get("meetingId")
            for item in self._db.query_prefix(f"USER#{user_a_id}", "PART#")
            if item.get("meetingId")
        }
        b_parts = {
            item.get("meetingId")
            for item in self._db.query_prefix(f"USER#{user_b_id}", "PART#")
            if item.get("meetingId")
        }
        shared_ids = a_parts & b_parts
        recent_titles = []
        for mid in list(shared_ids)[:5]:
            m = self._db.get(f"MEET#{mid}", "META")
            if m and m.get("status") == "confirmed":
                recent_titles.append(m.get("title", ""))
        return {"count": len(shared_ids), "recentTitles": recent_titles[:3]}

    def get_stats(self, user_id: str, meetings: List[models.MeetingRequest]) -> dict:
        total_organised = sum(1 for m in meetings if m.creatorUserId == user_id)
        total_accepted = sum(1 for m in meetings if m.status == "confirmed")
        total_cancelled = sum(1 for m in meetings if m.status == "cancelled")
        fairness_item = self._db.get(f"USER#{user_id}", "FAIRNESS")
        current_score = float(fairness_item.get("fairnessScore", 100)) if fairness_item else 100.0
        load_metrics = (fairness_item or {}).get("meetingLoadMetrics", {})
        return {
            "total_organized": total_organised,
            "total_accepted": total_accepted,
            "total_cancelled": total_cancelled,
            "current_fairness_score": round(current_score, 1),
            "meetings_this_week": int(float(load_metrics.get("meetings_this_week", 0))),
        }


# ---------------------------------------------------------------------------
# MeetingRepository
# ---------------------------------------------------------------------------

class MeetingRepository:
    def __init__(self) -> None:
        self._db = get_db()

    def get_meta(self, request_id: str) -> Optional[dict]:
        return self._db.get(f"MEET#{request_id}", "META")

    def update_meta(self, request_id: str, data: dict) -> None:
        self._db.put(f"MEET#{request_id}", "META", data)

    def create_record(
        self, req_data: models.MeetingCreateSchema, creator_id: str
    ) -> models.MeetingRequest:
        req_id = f"m{uuid.uuid4().hex[:6]}"
        range_start = datetime.now()
        if getattr(req_data, "dateRangeStart", None):
            try:
                range_start = datetime.fromisoformat(req_data.dateRangeStart)
            except (ValueError, TypeError):
                pass
        meeting = models.MeetingRequest(
            requestId=req_id,
            creatorUserId=creator_id,
            participantUserIds=req_data.participantIds,
            title=req_data.title,
            description=getattr(req_data, "description", "") or "",
            durationMinutes=req_data.durationMinutes,
            dateRangeStart=range_start,
            dateRangeEnd=range_start + timedelta(days=req_data.daysForward),
            status="pending",
            daysForward=req_data.daysForward,
            preferredHours=getattr(req_data, "preferredHours", None),
            excludedWeekdays=getattr(req_data, "excludedWeekdays", None),
        )
        self._db.put(f"MEET#{req_id}", "META", meeting.model_dump(mode="json"))
        self._write_participation_records(meeting)
        return meeting

    def _write_participation_records(self, meeting: models.MeetingRequest) -> None:
        all_ids = list(set([meeting.creatorUserId] + (meeting.participantUserIds or [])))
        for uid in all_ids:
            if uid:
                self._db.put(f"USER#{uid}", f"PART#{meeting.requestId}", {
                    "meetingId": meeting.requestId,
                    "role": "creator" if uid == meeting.creatorUserId else "participant",
                    "addedAt": datetime.now().isoformat(),
                })

    def get_slot(self, request_id: str, slot_start_iso: str) -> Optional[dict]:
        return self._db.get(f"MEET#{request_id}", f"SLOT#{slot_start_iso}")

    def get_slots(self, request_id: str) -> List[models.SuggestedTimeSlot]:
        items = self._db.query_prefix(f"MEET#{request_id}", "SLOT#")
        slots = []
        for item in items:
            try:
                slots.append(models.SuggestedTimeSlot(**item))
            except Exception:
                pass
        slots.sort(key=lambda x: x.score, reverse=True)
        return slots

    def write_slot(self, request_id: str, slot_start_iso: str, slot_dict: dict) -> None:
        self._db.put(f"MEET#{request_id}", f"SLOT#{slot_start_iso}", slot_dict)

    def delete_slots(self, request_id: str) -> None:
        slots = self._db.query_prefix(f"MEET#{request_id}", "SLOT#")
        with self._db.table.batch_writer() as batch:
            for s in slots:
                batch.delete_item(Key={"PK": s["PK"], "SK": s["SK"]})

    def confirm_slot(self, request_id: str, slot_start_iso: str) -> None:
        """Conditional write — raises HTTP 409 if slot already confirmed."""
        try:
            self._db.table.update_item(
                Key={"PK": f"MEET#{request_id}", "SK": "META"},
                UpdateExpression="SET #st = :confirmed, selectedSlotStart = :slot, updatedAt = :now",
                ConditionExpression="attribute_not_exists(selectedSlotStart) OR #st = :pending",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":confirmed": "confirmed",
                    ":slot": slot_start_iso,
                    ":now": datetime.now().isoformat(),
                    ":pending": "pending",
                },
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise HTTPException(
                    status_code=409,
                    detail="This slot was just taken by someone else — please refresh and choose another",
                )
            raise

    def cancel(self, request_id: str, cancelled_by: str) -> Optional[dict]:
        meeting = self.get_meta(request_id)
        if not meeting:
            return None
        now = datetime.now().isoformat()
        meeting.update({
            "status": "cancelled",
            "cancelledAt": now,
            "cancelledBy": cancelled_by,
            "updatedAt": now,
        })
        self.update_meta(request_id, meeting)
        self.log_activity(request_id, "cancelled", cancelled_by)
        return meeting

    def edit(
        self,
        request_id: str,
        edited_by: str,
        title: Optional[str] = None,
        duration_minutes: Optional[int] = None,
        description: Optional[str] = None,
        days_forward: Optional[int] = None,
    ) -> Optional[dict]:
        meeting = self.get_meta(request_id)
        if not meeting:
            return None
        changes: dict = {}
        if title is not None and title != meeting.get("title"):
            changes["title"] = {"from": meeting.get("title"), "to": title}
            meeting["title"] = title
        if duration_minutes is not None and duration_minutes != meeting.get("durationMinutes"):
            changes["durationMinutes"] = {"from": meeting.get("durationMinutes"), "to": duration_minutes}
            meeting["durationMinutes"] = duration_minutes
        if description is not None and description != meeting.get("description", ""):
            changes["description"] = {"from": meeting.get("description", ""), "to": description}
            meeting["description"] = description
        if days_forward is not None and days_forward != meeting.get("daysForward", 7):
            changes["daysForward"] = {"from": meeting.get("daysForward", 7), "to": days_forward}
            meeting["daysForward"] = days_forward
        if not changes:
            return meeting
        meeting["updatedAt"] = datetime.now().isoformat()
        self.update_meta(request_id, meeting)
        self.log_activity(request_id, "edited", edited_by, changes)
        return meeting

    def log_activity(
        self, request_id: str, action: str, user_id: str, changes: Optional[dict] = None
    ) -> None:
        ts = datetime.now().isoformat()
        item: dict = {"action": action, "by": user_id, "at": ts}
        if changes:
            item["changes"] = json.dumps(changes)
        self._db.put(f"MEET#{request_id}", f"LOG#{ts}", item)

    def get_activity_log(self, request_id: str) -> List[dict]:
        items = self._db.query_prefix(f"MEET#{request_id}", "LOG#")
        return sorted(items, key=lambda x: x.get("at", ""))

    def get_user_meetings(self, user_id: str) -> List[models.MeetingRequest]:
        part_items = self._db.query_prefix(f"USER#{user_id}", "PART#")
        meeting_ids = {item.get("meetingId") for item in part_items if item.get("meetingId")}

        meetings: List[models.MeetingRequest] = []
        fetched_ids: set = set()

        for mid in meeting_ids:
            item = self._db.get(f"MEET#{mid}", "META")
            if item:
                try:
                    meetings.append(models.MeetingRequest(**item))
                    fetched_ids.add(mid)
                except Exception as exc:
                    print(f"[repository] Failed to parse meeting {mid}: {exc}")

        # Legacy fallback scan for meetings without participation index records
        legacy = self._db.scan(
            FilterExpression=(
                Attr("PK").begins_with("MEET#")
                & Attr("SK").eq("META")
                & (Attr("creatorUserId").eq(user_id) | Attr("participantUserIds").contains(user_id))
            )
        )
        for item in legacy:
            mid = item.get("requestId", "")
            if mid and mid not in fetched_ids:
                try:
                    m = models.MeetingRequest(**item)
                    meetings.append(m)
                    self._write_participation_records(m)
                except Exception as exc:
                    print(f"[repository] Failed to parse legacy meeting {item.get('PK')}: {exc}")

        meetings.sort(key=lambda x: x.createdAt, reverse=True)
        return meetings


# ---------------------------------------------------------------------------
# CalendarRepository
# ---------------------------------------------------------------------------

class CalendarRepository:
    def __init__(self) -> None:
        self._db = get_db()

    def get_oauth_tokens(self, user_id: str, provider: str) -> Optional[dict]:
        return self._db.get(f"USER#{user_id}", f"OAUTH#{provider}")

    def save_oauth_tokens(self, user_id: str, provider: str, tokens: dict) -> None:
        item = {
            "provider": provider,
            "accessToken": tokens.get("access_token", ""),
            "refreshToken": tokens.get("refresh_token", ""),
            "expiresAt": tokens.get("expires_at", ""),
            "scopes": tokens.get("scope", ""),
            "calendarEmail": tokens.get("calendar_email", ""),
            "connectedAt": datetime.now().isoformat(),
        }
        self._db.put(f"USER#{user_id}", f"OAUTH#{provider}", item)

    def delete_oauth_tokens(self, user_id: str, provider: str) -> None:
        self._db.delete(f"USER#{user_id}", f"OAUTH#{provider}")

    def get_connected_calendars(self, user_id: str) -> dict:
        tokens = self.get_oauth_tokens(user_id, "google")
        return {
            "google": (
                {"connected": True, "email": tokens.get("calendarEmail", ""),
                 "connectedAt": tokens.get("connectedAt", "")}
                if tokens
                else {"connected": False, "email": ""}
            )
        }

    def get_ics_url(self, user_id: str) -> str:
        profile = self._db.get(f"USER#{user_id}", "PROFILE")
        return (profile or {}).get("icsUrl", "")

    def save_oauth_state(self, user_id: str, provider: str, state: str) -> None:
        self._db.put(f"USER#{user_id}", f"OAUTH_STATE#{state}", {
            "provider": provider,
            "state": state,
            "ttlExpiry": int(time.time()) + 1800,
        })

    def validate_and_consume_oauth_state(self, user_id: str, state: str) -> Optional[str]:
        item = self._db.get(f"USER#{user_id}", f"OAUTH_STATE#{state}")
        if not item:
            return None
        if item.get("ttlExpiry", 0) < int(time.time()):
            return None
        self._db.delete(f"USER#{user_id}", f"OAUTH_STATE#{state}")
        return item.get("provider")

    # --- Watch channel (Google Calendar push notifications) ---

    def save_watch_channel(self, user_id: str, channel_id: str, resource_id: str, expires_at: str) -> None:
        """Store the active watch channel and create a reverse-lookup record."""
        self._db.put(f"USER#{user_id}", "GCAL_WATCH", {
            "channelId":   channel_id,
            "resourceId":  resource_id,
            "expiresAt":   expires_at,
            "changeToken": "0",
        })
        # Reverse lookup so the webhook handler can resolve channelId → userId
        self._db.put(f"GCAL_CHANNEL#{channel_id}", "LOOKUP", {
            "userId":     user_id,
            "channelId":  channel_id,
            "resourceId": resource_id,
        })

    def get_watch_channel(self, user_id: str) -> Optional[dict]:
        return self._db.get(f"USER#{user_id}", "GCAL_WATCH")

    def delete_watch_channel(self, user_id: str) -> None:
        channel = self.get_watch_channel(user_id)
        if channel:
            self._db.delete(f"GCAL_CHANNEL#{channel['channelId']}", "LOOKUP")
        self._db.delete(f"USER#{user_id}", "GCAL_WATCH")

    def get_user_id_by_channel(self, channel_id: str) -> Optional[str]:
        item = self._db.get(f"GCAL_CHANNEL#{channel_id}", "LOOKUP")
        return item.get("userId") if item else None

    def bump_change_token(self, user_id: str) -> None:
        """Increment changeToken so the frontend's sync poll detects a new webhook notification."""
        channel = self.get_watch_channel(user_id)
        if not channel:
            return
        channel["changeToken"] = str(int(time.time() * 1000))
        self._db.put(f"USER#{user_id}", "GCAL_WATCH", channel)

    def get_change_token(self, user_id: str) -> str:
        channel = self.get_watch_channel(user_id)
        return (channel or {}).get("changeToken", "0")


# ---------------------------------------------------------------------------
# AIFairnessRepository — persists AI-generated fairness verdicts + trend history
# ---------------------------------------------------------------------------

class AIFairnessRepository:
    """
    Storage layout (single-table):
      USER#<id>   / AIFAIRHIST#<iso_ts>    → per-user fairness trajectory (TTL: 365 days)
    """

    USER_HIST_TTL_DAYS = 365

    def __init__(self) -> None:
        self._db = get_db()

    def append_user_fairness_point(self, user_id: str, request_id: str, score: float) -> None:
        ts = datetime.now().isoformat()
        self._db.put(f"USER#{user_id}", f"AIFAIRHIST#{ts}", {
            "userId":      user_id,
            "requestId":   request_id,
            "score":       float(score),
            "recordedAt":  ts,
            "ttlExpiry":   int(time.time()) + (self.USER_HIST_TTL_DAYS * 86400),
        })

    def get_recent_fairness_trend(self, user_id: str, limit: int = 20) -> List[dict]:
        """
        Return up to `limit` most recent {recordedAt, score} entries for the user.
        Sorted newest-first.
        """
        items = self._db.query_prefix(f"USER#{user_id}", "AIFAIRHIST#")
        items.sort(key=lambda x: x.get("recordedAt", ""), reverse=True)
        return [
            {"recordedAt": it.get("recordedAt", ""), "score": float(it.get("score", 0.0))}
            for it in items[:limit]
        ]
