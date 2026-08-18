# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Full stack (Docker):**
```bash
docker-compose up --build          # frontend :80, backend :8000
```

**Frontend only (from `frontend/`):**
```bash
npm install && npm run dev         # Vite dev server at :5173
npm run lint                       # ESLint
npm run build                      # production build → dist/
```

**Backend only (from `backend/api/`):**
```bash
pip install -r requirements.txt
ENVIRONMENT=development uvicorn main:app --reload --port 8000
```

**Lambda package:**
```bash
python build_lambda.py             # → terraform/api_deployment.zip
```

**Terraform deploy (from `terraform/`):**
```bash
terraform apply -var="lab_role_arn=arn:aws:iam::975049889875:role/LabRole"
# api_deployment.zip must already exist in terraform/ before plan/apply
```

**Quick Lambda deploy (no Terraform):**
```bash
python build_lambda.py
aws lambda update-function-code --function-name smart_scheduler_api \
  --zip-file "fileb://terraform/api_deployment.zip" --region us-east-1
```

**Frontend deploy to Amplify (manual — NOT connected to GitHub):**
```bash
# Build (from frontend/)
VITE_API_URL=https://5xv230dk19.execute-api.us-east-1.amazonaws.com npm run build
# Zip dist/ using .NET ZipFile API (PowerShell Compress-Archive produces wrong structure → assets 404)
# Then: aws amplify create-deployment → PUT to zipUploadUrl → start-deployment
```

## Architecture

### Request Flow (Single Proxy Endpoint)

All frontend API calls go through a single endpoint — **`POST /api/proxy`** — not the individual REST routes. The Cognito JWT authorizer on `ANY /{proxy+}` can't validate Cognito *access* tokens and rejects the CORS pre-flight OPTIONS with 401, so `/api/proxy` uses **no** gateway authorizer: a dedicated no-auth `OPTIONS /{proxy+}` route answers the pre-flight, and the backend validates the access token itself.

- `apiClient.js` sends `POST /api/proxy` with the Cognito access token in the `Authorization: Bearer <jwt>` header and a JSON body `{ action, data }`. The token stays off the URL / out of access logs; the body has no URL-length limit.
- The backend's `/api/proxy` handler in `main.py` validates the token via `cognito-idp:GetUser` (see `src/common/auth.py:validate_access_token`), then calls `src/handlers/api/dispatcher.py:dispatch`.
- The response is always HTTP 200 — even for backend errors. Frontend must check `body.status === 'error'`.
- On a 401 the client force-refreshes the access token and retries the request once.
- `apiGet` / `apiPost` in `apiClient.js` are thin wrappers that map URL patterns to action strings (all ultimately `apiProxy` calls).

Key action strings (full list in `apiClient.js`):

| Action | Triggered by |
|---|---|
| `profile`, `meetings`, `calendar_status` | `apiGet` |
| `activity_feed`, `list_users`, `profile_stats` | `apiGet` |
| `get_public_profile:<userId>`, `shared_meetings:<userId>` | `apiGet` |
| `meeting_log:<id>`, `oauth_url:<provider>` | `apiGet` |
| `create_meeting`, `accept:<id>`, `book:<id>:<slot>` | `apiPost` |
| `cancel:<id>`, `edit:<id>`, `reschedule:<id>`, `decline:<id>` | `apiPost` |
| `book_custom:<id>`, `update_profile` | `apiPost` |
| `oauth_callback:<provider>`, `calendar_disconnect:<provider>` | `apiPost` |
| `score_slot`, `update_ics_url` | direct `apiProxy` calls |

There are also secondary REST endpoints (`/api/profile`, `/api/meetings`, etc.) with the JWT authorizer from API Gateway — these are a secondary path not used by the main frontend.

### Backend Package Structure (`backend/api/src/`)

```
src/
├── common/
│   ├── auth.py              # Token validation (validate_access_token, get_current_user_from_request)
│   ├── calendar_client.py   # Google Calendar OAuth2 + Outlook .ics integration
│   ├── dynamo.py            # DynamoDB client singleton (get_db())
│   ├── openai_client.py     # AI slot scoring + NL meeting parsing (gpt-4.1-nano, stdlib urllib only)
│   └── timezone.py          # get_tz_offset_hours()
├── core/
│   ├── fairness.py          # FairnessEngine class + global `engine` singleton
│   └── ai_fairness.py       # score_meeting_with_ai() — primary AI scorer (gpt-4.1-mini)
├── database/
│   ├── models.py            # Pydantic models (UserProfile, MeetingRequest, SuggestedTimeSlot, FairnessState, MeetingLogEntry)
│   └── repository.py        # UserRepository, MeetingRepository, CalendarRepository, AIFairnessRepository
└── handlers/
    ├── api/
    │   ├── dispatcher.py    # Routes action strings → handler functions
    │   ├── meetings.py      # handle_create_meeting, handle_book, handle_accept, etc.
    │   ├── profile.py       # handle_profile, handle_update_profile, handle_list_users, etc.
    │   ├── calendar.py      # handle_calendar_status, handle_oauth_url, handle_oauth_callback, etc.
    │   ├── _scheduling.py   # Slot generation helpers used by meetings.py
    │   └── _local_sim.py    # Local development simulator (no real AWS calls)
    ├── lambda_entry.py      # sfn_router() — Step Functions event dispatch
    └── workflow/
        ├── fetch_participants.py
        ├── generate_slots.py
        ├── calculate_fairness.py
        └── store_results.py
```

### Lambda Dual-Dispatch (`main.py:handler`)

1. **Step Functions invocations** — detected by `sfn_action` key → `sfn_router()` in `lambda_entry.py` → maps to the appropriate `workflow/` handler.
2. **API Gateway invocations** — everything else → Mangum → FastAPI → `/api/proxy` → `dispatcher.dispatch()`.

**Local development shortcut:** When `AWS_ACCOUNT_ID` is not set (local uvicorn), `handle_create_meeting` skips Step Functions entirely and calls `_local_sim.run_simulation()` synchronously. This mirrors the full SFN workflow but runs in-process.

### Action Dispatch (`dispatcher.py`)

Two lookup tables: `EXACT` (exact match) and `PREFIX` (prefix match). Adding a new action means adding an entry to one of these tables and implementing the handler in `meetings.py`, `profile.py`, or `calendar.py`.

Key actions:

| Action | Handler |
|---|---|
| `profile`, `update_profile`, `profile_stats`, `list_users`, `activity_feed` | `profile.py` |
| `meetings`, `create_meeting`, `score_slot`, `parse_meeting_nl` | `meetings.py` |
| `book:<id>:<slot>`, `accept:<id>`, `decline:<id>`, `cancel:<id>`, `edit:<id>`, `reschedule:<id>`, `book_custom:<id>`, `meeting_log:<id>` | `meetings.py` |
| `calendar_status`, `calendar_events`, `oauth_url:<p>`, `oauth_callback:<p>`, `calendar_disconnect:<p>`, `update_ics_url`, `register_calendar_watch`, `stop_calendar_watch`, `check_calendar_sync` | `calendar.py` |
| `reset_fairness`, `get_public_profile:<id>`, `shared_meetings:<id>` | `profile.py` |

### Step Functions Workflow

`SmartSchedulerWorkflow` (EXPRESS type) runs when a meeting is created:
`FetchParticipantData → GenerateCandidateSlots → CalculateFairnessScores → StoreResults`

Each step maps to a `sfn_*` function in `db.py`. The workflow is triggered from `main.py` when creating a meeting.

### AI Fairness Scoring (inline — `_scheduling._run_ai_inline`)

AI scoring runs **synchronously** within the same `create_meeting` / `reschedule` request, immediately after the heuristic SFN workflow completes. The result is returned directly in the meeting creation response — no async polling needed.

- **Trigger**: `_scheduling.run_or_schedule` calls `_run_ai_inline()` after `SmartSchedulerWorkflow` (or its local fallback) stores slots. Failures are caught and logged; the meeting flow continues with heuristic scores already in DynamoDB.
- **AI is primary**: `src/core/ai_fairness.py` calls **gpt-4.1-mini** and the AI score **replaces** the heuristic score as the primary `score` field on each slot. The heuristic score is preserved in the `explanation` text as a fallback reference.
- **Storage**:
  - Each slot's `score` and `aiScore` fields are updated in DynamoDB with the AI value
  - `MEET#<id> / META` — `aiAnalysis` dict added (bestSlot, bestSlotReason, summary, calendarSuggestions, meetingFairnessScore)
  - `MEET#<id> / AIHIST#<ts>` — audit trail (TTL 90 days) via `AIFairnessRepository`
  - `USER#<id> / AIFAIRHIST#<ts>` — per-user fairness trajectory (TTL 365 days), feeds back into the next AI call as historical context
- **Privacy**: calendar event titles/locations/attendee emails are stripped before sending to OpenAI; only start/end/duration/attendee-count is sent.
- **Cost guard**: participants capped at 25, events per participant capped at 40, history entries capped at 20 — bounded context window per call.
- **Failure mode**: if `OPENAI_API_KEY` is unset or the API errors, `_run_ai_inline` returns `None` and the meeting is returned with heuristic-only scores. Handler logs use the `[ai_inline]` prefix.
### AI Scoring (`src/common/openai_client.py`)

Uses `gpt-4.1-nano` via stdlib `urllib` (no OpenAI SDK in the Lambda ZIP). A single batched API call per meeting scores all candidate slots and produces a strategic summary. Hard-fails with `OpenAIScoreError` on any error — the deterministic fairness engine always runs first and AI scoring is additive. Requires `OPENAI_API_KEY` in Lambda env.

Two public entry points:
- `score_slots_with_ai(slots, participant_context)` — called by `calculate_fairness.py` in the SFN workflow
- `parse_meeting_intent(text, today_iso, known_users)` — called by `handle_parse_meeting_nl` in `meetings.py` to extract structured fields from a natural-language meeting request (`apiParseMeetingNL` in the frontend)

### Fairness Engine (`src/core/fairness.py`)

Single `FairnessEngine` class, global `engine` singleton. Key concepts:
- **User score** (0–100): credit/debt balance model. `score = 50 + balance` (clamped 0–100). 50 = neutral. Balance shifts on each booking:
  - weekend/very-off-hours slot → +15 (sacrifice rewarded)
  - off-peak slot → +8
  - standard working-hours slot → −4
  - prime-time slot → −10 (great deal costs you)
  - cancellation → −5 (penalty for breaking others' plans)
  - Balance drifts toward 0 at 2%/day (max 30%) so old history fades.
- **Slot score** (0–100): `time_score − load_penalty + equity_bonus − conflict_penalty`
  - `time_score` = avg of `HOUR_WEIGHTS × day_weight × 100` across all participant local times
  - `load_penalty` = up to −30 based on participants' meetings this week
  - `equity_bonus` = ±15 (rewards slots where high-fairness participants get convenient time)
  - `conflict_penalty` = 12 pts per participant with a calendar conflict, capped at 36

### DynamoDB Access Pattern (`src/database/repository.py`)

Single-table design (`SmartScheduler_V1`). Three repository classes: `UserRepository`, `MeetingRepository`, `CalendarRepository`. Key schema:
- `PK=USER#<id>`, `SK=PROFILE` — user profile
- `PK=USER#<id>`, `SK=FAIRNESS` — fairness scores / load metrics
- `PK=USER#<id>`, `SK=PART#<requestId>` — participation index (used to look up a user's meetings)
- `PK=USER#<id>`, `SK=OAUTH#<provider>` — OAuth tokens (Google/Microsoft)
- `PK=USER#<id>`, `SK=GCAL_WATCH` — active Google Calendar push-notification channel
- `PK=MEET#<requestId>`, `SK=META` — meeting metadata (`MeetingRequest`)
- `PK=MEET#<requestId>`, `SK=SLOT#<startIso>` — candidate time slots (`SuggestedTimeSlot`)
- `PK=MEET#<requestId>`, `SK=LOG#<timestamp>` — audit log entries
- `PK=MEET#<requestId>`, `SK=AIHIST#<ts>` — AI scoring audit trail (TTL 90 days)
- `PK=USER#<id>`, `SK=AIFAIRHIST#<ts>` — per-user AI fairness trajectory (TTL 365 days)
- `PK=GCAL_CHANNEL#<channelId>`, `SK=LOOKUP` — reverse lookup: channelId → userId

`BaseDBModel` in `models.py` has a `model_validator` that recursively converts `Decimal` → `int`/`float` on every DynamoDB read. All writes must convert floats → `Decimal` before storing.

### Frontend State Management (`App.jsx`)

State is lifted to `AppContent` in `App.jsx`. No global store — all data flows via props. Key state:
- `profile`, `meetings`, `calendarStatus` — loaded on mount via `Promise.all`, meetings auto-polled every 60s.
- `targetProfile` — public profile modal (global, controlled from any route).
- `showGlobalCreate` / `meetingPrefill` — global create modal triggered from calendar, people view, or `⌘K` palette.
- `selectedMeeting` — drives `MeetingDetailModal`.
- OAuth callback params captured in `useState` initializer on mount (before React Router cleans the URL).

Key components in `frontend/src/components/`:
- `MeetingDashboard.jsx` — main scheduling UI (meeting list, status, actions)
- `MeetingDetailModal.jsx` — detail/action modal for a single meeting
- `CreateMeetingModal.jsx` — meeting creation flow with slot selection
- `CalendarView.jsx` — calendar display
- `PeopleView.jsx` — user directory / people search
- `ProfileView.jsx` — current user profile & fairness metrics
- `PublicProfile.jsx` — public-facing profile view
- `CommandPalette.jsx` — `⌘K` global command palette

`frontend/src/context/ToastContext.jsx` provides a global toast notification context.

### Calendar Integration (`src/common/calendar_client.py`)

Supports Google Calendar (OAuth2) and Microsoft Outlook (.ics feed URL). Google push notifications land at `POST /webhook/google-calendar` (public, no JWT) and bump a `changeToken` in DynamoDB, which the frontend polls to detect changes.

## Key Env Vars

| Variable | Where set | Purpose |
|---|---|---|
| `TABLE_NAME` | Lambda / `.env` | DynamoDB table name |
| `AWS_ACCOUNT_ID` | Lambda | Used to construct SFN ARN; **absent locally** → `_local_sim` path |
| `FRONTEND_URL` | Lambda | CORS allow-origin |
| `OPENAI_API_KEY` | Lambda | gpt-4.1-mini for inline AI scoring + NL meeting parsing; absent → heuristic-only fallback |
| `AI_FAIRNESS_MODEL` | Lambda | Defaults to `gpt-4.1-mini`; override to pin a different model |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Lambda | Google Calendar OAuth |
| `ENVIRONMENT` | local only | Set to `development` for local uvicorn + `.env` loading |
| `VITE_API_URL` | frontend `.env.local` | Backend URL for the Vite dev server (default: `http://localhost:8000`) |

### Local `.env` file

When `ENVIRONMENT=development`, `main.py` auto-loads `Smart-Scheduler/.env` (three directories above `backend/api/main.py`). Minimum required keys for local development:

```
TABLE_NAME=SmartScheduler_V1
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...   # if using temporary credentials (e.g. AWS Academy)
```

To point the Vite dev server at a local backend, create `frontend/.env.local`:
```
VITE_API_URL=http://localhost:8000
```

## Tests

There is no test suite. No pytest files exist in `backend/` and no Jest/Vitest files in `frontend/src/`.

## Terraform Notes

- No `terraform.tfvars` — always pass `lab_role_arn` via `-var=`.
- `lifecycle { ignore_changes = [target] }` on API Gateway (import drift).
- `lifecycle { ignore_changes = [explicit_auth_flows] }` on Cognito client.
- Lambda ARN for Step Functions is constructed at runtime from env vars to avoid circular Terraform dependency.
- `api_deployment.zip` must exist in `terraform/` before `terraform plan/apply` — run `python build_lambda.py` first.
- `frontend/src/aws-exports.js` is **not** managed by Terraform — update it manually after any Cognito pool/client recreation.
