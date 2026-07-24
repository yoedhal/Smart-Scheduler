"""
SFN router — called by main.handler when the Lambda event contains sfn_action.
Each Step Functions state sends: {"sfn_action": "<action>", "payload": {<state>}}
"""
from src.handlers.workflow import (
    calculate_fairness,
    fetch_participants,
    generate_slots,
    store_results,
)


def _run_ai_scoring(payload):
    # Lazy import so the SFN workflow steps don't pull in the scheduling/AI stack.
    from src.handlers.api._scheduling import run_ai_scoring_job
    return run_ai_scoring_job(payload)


_ACTION_MAP = {
    "fetch_participants":  fetch_participants.handler,
    "generate_slots":      generate_slots.handler,
    "calculate_fairness":  calculate_fairness.handler,
    "store_results":       store_results.handler,
    "run_ai_scoring":      _run_ai_scoring,
}


def sfn_router(event: dict, context) -> dict:
    action = event.get("sfn_action")
    payload = event.get("payload", event)

    handler_fn = _ACTION_MAP.get(action)
    if not handler_fn:
        raise ValueError(f"Unknown sfn_action: '{action}'")

    return handler_fn(payload)
