from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Decimal coercion — applied to every model that reads from DynamoDB
# ---------------------------------------------------------------------------

def _convert_decimals(obj: Any) -> Any:
    """Recursively convert DynamoDB Decimal values to int/float."""
    if isinstance(obj, Decimal):
        n = float(obj)
        return int(n) if n.is_integer() else n
    if isinstance(obj, dict):
        return {k: _convert_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_decimals(i) for i in obj]
    return obj


class BaseDBModel(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def convert_decimals(cls, data: Any) -> Any:
        return _convert_decimals(data) if isinstance(data, dict) else data


# ---------------------------------------------------------------------------
# Domain models
# ---------------------------------------------------------------------------

class UserProfile(BaseDBModel):
    userId: str
    email: str
    displayName: str
    bio: Optional[str] = ""
    role: Optional[str] = "Professional"
    department: Optional[str] = "General"
    skills: List[str] = []
    statusMessage: Optional[str] = "Focused & Ready"
    timezone: str = "Asia/Jerusalem"
    workingHours: Dict[str, str] = {"start": "09:00", "end": "18:00"}
    workingDays: List[int] = [0, 1, 2, 3, 4]
    lunchBreak: Optional[Dict[str, Any]] = Field(
        default_factory=lambda: {"start": "12:00", "duration": 60}
    )
    notificationPrefs: Dict[str, bool] = Field(
        default_factory=lambda: {"invites": True, "reminders": True, "digest": False}
    )
    showFairnessScore: bool = True
    createdAt: datetime = Field(default_factory=datetime.now)

class MeetingRequest(BaseDBModel):
    requestId: str
    creatorUserId: str
    participantUserIds: List[str]
    title: str
    description: Optional[str] = ""
    durationMinutes: int
    dateRangeStart: datetime
    dateRangeEnd: datetime
    # pending (no time booked) → awaiting (time booked, invitees still to accept)
    # → confirmed (every invitee accepted). Plus cancelled.
    status: str = "pending"
    selectedSlotStart: Optional[str] = None
    acceptedBy: List[str] = []
    declinedBy: List[str] = []
    # Per-user decline details: { userId: { reason, slotIso, declinedAt, comment? } }
    declineDetails: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    createdAt: datetime = Field(default_factory=datetime.now)
    updatedAt: Optional[datetime] = None
    cancelledAt: Optional[datetime] = None
    cancelledBy: Optional[str] = None
    externalEventIds: Dict[str, str] = Field(default_factory=dict)
    # Per-meeting scheduling preferences (set at creation, used for rescheduling)
    daysForward: Optional[int] = None
    preferredHours: Optional[List[int]] = None
    excludedWeekdays: Optional[List[int]] = None
    # AI strategic summary — populated inline after slot generation; null if AI unavailable
    aiMeetingScore: Optional[float] = None
    aiSummary: Optional[str] = None
    aiBestSlotIso: Optional[str] = None
    aiBestSlotReason: Optional[str] = None
    aiCalendarSuggestions: List[str] = Field(default_factory=list)
    aiMethod: Optional[str] = None
    aiModel: Optional[str] = None


class MeetingCreateSchema(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default="", max_length=2000)
    durationMinutes: int = Field(ge=15, le=480)
    participantIds: List[str] = []
    participantEmails: List[str] = []
    daysForward: int = Field(default=7, ge=1, le=90)
    dateRangeStart: Optional[str] = Field(default=None)          # "YYYY-MM-DD" — start from a specific date instead of today
    preferredHours: Optional[List[int]] = Field(default=None)    # e.g. [8,9,10,11] — restrict to morning only
    excludedWeekdays: Optional[List[int]] = Field(default=None)  # e.g. [0,4] — skip Monday and Friday


class MeetingEditSchema(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    durationMinutes: Optional[int] = None
    daysForward: Optional[int] = Field(default=None, ge=1, le=90)
    preferredHours: Optional[List[int]] = None
    excludedWeekdays: Optional[List[int]] = None


class MeetingDeclineSchema(BaseModel):
    reason: str = Field(pattern="^(personal|busy|other)$")
    comment: Optional[str] = Field(default=None, max_length=500)


class SuggestedTimeSlot(BaseDBModel):
    requestId: str
    startIso: datetime
    endIso: datetime
    score: float
    fairnessImpact: float
    conflictCount: int
    explanation: str
    aiScored: bool = False
    aiSuggestions: Optional[str] = None
    isPreferred: bool = False


class FairnessState(BaseDBModel):
    userId: str
    fairnessScore: float
    meetingLoadMetrics: Dict[str, Any]
    inconvenientMeetingsCount: int
    lastUpdatedAt: datetime = Field(default_factory=datetime.now)
    lastWeekReset: Optional[str] = None

