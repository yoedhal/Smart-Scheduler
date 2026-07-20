"""
SFN State: FetchParticipantData

Input:  request_id, creator_id, participant_ids, date_range_start,
        date_range_end, duration_minutes, tz_offset_hours
Output: adds participant_states, participant_profiles

Retry / error handling is declared in the Step Functions state machine
definition — no try/except needed here.
"""
import logging

from src.database.repository import UserRepository

logger = logging.getLogger(__name__)
_user_repo = UserRepository()


def handler(payload: dict) -> dict:
    request_id = payload.get("request_id", "?")
    creator_id = payload.get("creator_id", "")
    participant_ids = payload.get("participant_ids", [])
    all_ids = list(set([creator_id] + participant_ids))

    logger.info(
        f"[sfn:fetch_participants] START request_id={request_id} "
        f"creator={creator_id} participants={participant_ids} total_ids={len(all_ids)}"
    )

    participant_states = []
    participant_profiles = []
    missing_state = []
    missing_profile = []

    for uid in all_ids:
        state = _user_repo.get_fairness(uid)
        if state:
            participant_states.append(state.model_dump(mode="json"))
            logger.info(
                f"[sfn:fetch_participants] fairness uid={uid} "
                f"score={state.fairnessScore:.1f} "
                f"meetings_this_week={state.meetingLoadMetrics.get('meetings_this_week', 0)}"
            )
        else:
            missing_state.append(uid)
            logger.warning(f"[sfn:fetch_participants] no fairness record for uid={uid} — using defaults")

        profile = _user_repo.get_profile_raw(uid)
        if profile:
            participant_profiles.append({
                "userId": uid,
                "displayName": profile.get("displayName", ""),
                "email": profile.get("email", ""),
                "timezone": profile.get("timezone", "UTC"),
                "workingHours": profile.get("workingHours", {"start": "09:00", "end": "18:00"}),
                "workingDays": profile.get("workingDays", [0, 1, 2, 3, 4]),
                "lunchBreak": profile.get("lunchBreak", {"start": "12:00", "duration": 60}),
            })
            logger.info(
                f"[sfn:fetch_participants] profile uid={uid} "
                f"tz={profile.get('timezone', 'UTC')} "
                f"working_days={profile.get('workingDays', [0,1,2,3,4])} "
                f"hours={profile.get('workingHours', {})}"
            )
        else:
            missing_profile.append(uid)
            logger.warning(f"[sfn:fetch_participants] no profile for uid={uid} — using defaults")

    payload["participant_states"] = participant_states
    payload["participant_profiles"] = participant_profiles

    logger.info(
        f"[sfn:fetch_participants] DONE request_id={request_id} "
        f"states={len(participant_states)} profiles={len(participant_profiles)} "
        f"missing_state={missing_state} missing_profile={missing_profile}"
    )
    return payload
