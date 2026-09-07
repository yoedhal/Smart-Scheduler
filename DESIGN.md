# DESIGN.md — Frontend Design Brief

A working brief for designing and redesigning the Smart Scheduler frontend. Read this
before touching any UI code. It describes what the product is, what the design system
currently is, what's wrong with it, and the rules any redesign must respect.

Companion doc: [CLAUDE.md](CLAUDE.md) covers architecture, API, and backend. This file
covers only the visual and interaction layer.

---

## 1. What this product is

Smart Scheduler finds meeting times that are **fair**, not just available.

Every user carries a **fairness score** (0–100, 50 = neutral). It's a credit/debt balance:
taking a 7am or weekend slot earns credit, taking prime-time costs you. The app proposes
candidate slots, scores them with a deterministic fairness engine, then re-scores them
with AI, and shows the organizer which slot is best *for the group*.

**The design consequence:** this is not another calendar app. The differentiator is the
fairness signal and the AI reasoning behind slot choice. If the UI looks like a generic
calendar with a number bolted on, the design has failed. The scoring should feel like the
spine of the product, not a badge.

**Who uses it:** knowledge workers scheduling 2–10 person meetings across timezones. They
open the app to do one of three things: decide on a pending meeting, respond to an
invite, or check whether they're being scheduled unfairly. Everything else is secondary.

---

## 2. Stack and constraints

| | |
|---|---|
| Framework | React 19, function components + hooks only |
| Routing | react-router-dom 7 (`/`, `/calendar`, `/meetings`, `/people`, `/profile`) |
| Styling | **Plain CSS files + CSS custom properties.** No Tailwind, no CSS-in-JS, no CSS modules |
| Icons | `lucide-react` (already installed) |
| Auth UI | `@aws-amplify/ui-react` `<Authenticator>` wraps the whole app |
| Build | Vite 7 |
| State | Lifted to `AppContent` in `App.jsx`, passed via props. No Redux/Zustand/Context store (except `ToastContext`) |

### Hard constraints — do not violate without asking

- **Do not add a CSS framework or component library.** No Tailwind, no MUI, no shadcn, no
  styled-components. The design system is CSS variables in `src/index.css`. Extend it.
- **Do not add a state management library.** Props are fine at this size.
- **Do not restyle the Amplify `<Authenticator>` login screen** unless explicitly asked —
  it's third-party markup and theming it is a separate job.
- **Both themes must work.** Dark is default; light is toggled via
  `document.documentElement[data-theme="light"]`. Every new color must be defined as a
  token in *both* blocks in `index.css`. Never hardcode a hex in a component.
- **Keep the bundle lean.** No chart library, no animation library, no date library.
  Existing charts are hand-rolled inline SVG; `Intl`/`Date` handles formatting.
- Backend contracts are fixed. The UI may reshape data for display but must not require
  new API fields without flagging it.

---

## 3. Current design system (ground truth)

Everything below already exists in [`src/index.css`](frontend/src/index.css). Treat these
as the starting vocabulary — refine them, but keep the token names stable so existing CSS
doesn't break.

### Color tokens

```
Backgrounds     --bg-base --bg-surface --bg-card --bg-raised --bg-overlay
Borders         --border --border-focus
Text            --text-primary --text-secondary --text-muted
Accent          --accent (#38bdf8 sky) --accent-dim --accent-hover
                --purple (#a78bfa) --purple-dim
Semantic        --success (#34d399) --warning (#fbbf24) --danger (#f87171)
Special         --gold (#f5c842, fairness) --glass --glass-border
```

Light theme redefines all of these under `[data-theme="light"]`; accent shifts sky-blue →
`#2563eb`, purple → `#7c3aed`.

### Scale tokens

```
Radius      --radius-sm 6px  --radius-md 10px  --radius-lg 16px  --radius-xl 24px
Shadow      --shadow-card  --shadow-raised  --shadow-modal
Motion      --transition 0.15s ease
Type        --text-xs .70 / --text-sm .813 / --text-base .938 / --text-md 1.063
            / --text-lg 1.25 / --text-xl 1.563 / --text-2xl 2rem
Font        Inter, system-ui fallback. Body line-height 1.6, headings 1.15
```

### Fairness color ramp — [`src/fairnessColor.js`](frontend/src/fairnessColor.js)

```
≥75  #22c55e  "Excellent"        ≥50  #84cc16  "Good"
≥30  #eab308  "Below average"    <30  #ef4444  "Needs attention"
```

This ramp is semantically load-bearing and appears in the hero ring, sparkline, profile,
people list, and public profile. If you change it, change it in one place and audit every
consumer. **Note the accessibility problem:** it encodes meaning in hue alone.

### Existing motion vocabulary

`viewEnter` (route change, 180ms) · `modalCardEnter` (280ms, `cubic-bezier(.16,1,.3,1)`) ·
`cardEnter` (list stagger) · `tabEnter` · `skeletonShimmer` (1.4s) · `toastSlideIn/Out` ·
`btnSpin`. Reuse these names rather than inventing parallel ones.

### CSS file layout

| File | Lines | Scope |
|---|---|---|
| [`src/index.css`](frontend/src/index.css) | 263 | Tokens, resets, toasts, shared keyframes |
| [`src/App.css`](frontend/src/App.css) | 1093 | Layout shell, sidebar, dashboard, stat cards, buttons |
| [`components/MeetingDashboard.css`](frontend/src/components/MeetingDashboard.css) | 1577 | Meeting list, cards, slots, modals, wizard |
| [`components/ProfileView.css`](frontend/src/components/ProfileView.css) | 1104 | Profile tabs, fairness breakdown, calendar cards |
| [`components/CalendarView.css`](frontend/src/components/CalendarView.css) | 525 | Week grid, events, tooltips |
| [`components/PeopleView.css`](frontend/src/components/PeopleView.css) | 392 | Directory grid |
| [`components/PublicProfile.css`](frontend/src/components/PublicProfile.css) | 312 | Public profile modal |

Class prefixes by area: `pv-` profile · `cv-` calendar · `mc-` meeting card ·
`pp-` public profile · `people-` directory · `slot-`/`slt-` slots · `palette-` ⌘K ·
`dash-` dashboard · `md-`/`mdm-` meeting detail modal.

---

## 4. What's wrong today

These are the concrete problems a redesign should solve. Ranked by impact.

### 4.1 The design system isn't enforced

There are **~40 class names defined in more than one CSS file** — `.btn-primary`,
`.btn-cancel`, `.modal-overlay`, `.empty-state`, `.dash-card-head`, `.ai-setup`,
`.count-chip` and more are each declared in two or three places with drifting values.
Whichever file imports last wins, which makes styling unpredictable and means "fixing a
button" fixes it in one view and breaks it in another.

**Fix direction:** extract genuinely shared primitives into a single owned file and delete
the duplicates. Candidates: button variants, modal shell (overlay + card + head + actions),
empty state, pill/chip/badge, card shell, skeleton, form field. Everything else stays
view-scoped behind its prefix.

### 4.2 Inline styles are doing design-system work

`style={{...}}` appears **300+ times** across components — 36 in `PreferencesTab.jsx`,
30 in `WizardStep2.jsx`, 27 in `MeetingCard.jsx`, 19 in `DashboardView.jsx`. Many carry
hardcoded colors (`'#60a5fa'`, `'rgba(251,191,36,0.06)'`) that bypass the token system and
therefore **do not respond to the light/dark toggle**.

Legitimate inline styles: values computed at runtime (a conic-gradient from a live score,
a bar height, a stagger `animationDelay`). Everything else belongs in CSS. Runtime values
should be passed as CSS custom properties (`style={{ '--score-color': c }}`) — the codebase
already does this correctly in the fairness hero, so follow that pattern.

### 4.3 Accessibility is close to absent

The entire app has **4 `aria-label`s and 1 `aria-hidden`**. Specifically:

- Meeting cards expand/collapse via `onClick` on a `<div>` — no `<button>`, no keyboard
  access, no `aria-expanded`. Same for `.mini-item`, `.insight-banner`, `.sidebar-user`,
  and slot selection.
- No modal has `role="dialog"`, `aria-modal`, focus trapping, or focus restore on close.
  There are 6+ modal surfaces (detail, create wizard, edit, decline wizard, public
  profile, command palette).
- No visible `:focus-visible` ring convention. `--border-focus` exists but is barely used.
- Status is communicated by color-only dots (`.mc-status-dot`) and the fairness ramp.
- Text contrast: `--text-muted` is currently aliased to `--text-secondary` with the real
  muted value commented out — someone hit a contrast problem and patched it by deleting the
  tier. The scale needs to be rebuilt properly, not collapsed.

**Target: WCAG 2.1 AA.** Every interactive element reachable and operable by keyboard,
4.5:1 contrast on body text and 3:1 on large text/UI borders in *both* themes, status never
conveyed by color alone.

### 4.4 Responsive behavior is ad hoc

Nine `@media` queries across six breakpoints — 480, 560, 600, 640, 768, 900px — chosen per
file with no shared scale. The week calendar grid and the meeting card's slot picker are
the weakest on narrow screens.

**Fix direction:** pick 2–3 breakpoints, name them as a documented convention, and apply
them consistently. Mobile is a real use case: responding to an invite happens on a phone.

### 4.5 Visual hierarchy competes with itself

`DashboardView` stacks, in order: hero + button, connect banner, action banner, giant
fairness ring, AI text box, three stat cards, a sparkline card, a two-column card grid, and
two insight banners. Every block is a similarly-weighted bordered card, so nothing reads as
primary. The user's actual question — *"what needs me right now?"* — is answered by a thin
banner between two larger decorative blocks.

**Fix direction:** decide what the dashboard is *for* and demote everything else. One
primary surface, one secondary, the rest compressed or moved.

### 4.6 Emoji as iconography

Emoji are used as UI icons in dashboard insights (`📈 ⏳ 🎯 🔔 ⭐ 📅`), meeting card meta
(`⏱ 👤`), and error banners (`⚠️`). They render inconsistently across platforms, can't be
color-coordinated, and clash with the `lucide-react` icons used everywhere else.
`lucide-react` is already a dependency — use it.

### 4.7 Sparkline is fabricated data

`DashboardView` labels a chart "Fairness Score — Last 7 Days" and displays "+N pts this
week", but the series is synthesized on the client via
`startScore = score + thisWeek * 2` interpolated to today. There is no historical series
behind it. Presenting invented numbers as measurements is a trust problem, not just a
design one. Either surface real history (the backend stores `USER#<id>/AIFAIRHIST#<ts>`)
or remove the chart. Do not restyle it as-is.

---

## 5. Design direction

Some of this is opinion — argue with it if you have a better idea, but say so explicitly
rather than silently diverging.

**Tone:** calm, dense, professional. This is a tool people open several times a day to make
a decision quickly. Closer to Linear or Height than to Notion or a consumer calendar. Dark
mode is the primary experience and should be designed first.

**Principles:**

1. **The decision is the interface.** Every screen should make the next action obvious
   within two seconds. Pending decisions and awaiting-response invites outrank analytics.
2. **Fairness is explained, never asserted.** A number with no reasoning is noise. Any
   score shown should be one interaction away from *why* — the AI already produces
   `bestSlotReason`, `summary`, and `calendarSuggestions`. That reasoning is the product;
   surface it.
3. **Density over decoration.** Prefer showing more real information in less space to
   padding out thin content with large cards. Reserve visual weight for the one thing that
   matters on each screen.
4. **One system, applied consistently.** A button, a card, a modal, an empty state, a badge
   should look and behave identically everywhere. Consistency is worth more here than local
   cleverness.
5. **Motion clarifies, never entertains.** Keep it under 250ms, use it to show where things
   came from, and honor `prefers-reduced-motion` (currently unhandled anywhere).

---

## 6. Screen inventory

| Route | Component | Purpose | Priority |
|---|---|---|---|
| `/` | [`DashboardView.jsx`](frontend/src/components/DashboardView.jsx) | Triage: what needs me, how am I doing, quick create (incl. natural-language input) | **High** — worst hierarchy problems |
| `/meetings` | [`MeetingDashboard.jsx`](frontend/src/components/MeetingDashboard.jsx) + [`MeetingCard.jsx`](frontend/src/components/MeetingCard.jsx) | The core workflow: review meetings, pick slots, accept/decline/reschedule | **High** — most complex, biggest CSS file |
| `/calendar` | [`CalendarView.jsx`](frontend/src/components/CalendarView.jsx) | Week grid of confirmed meetings + synced Google/ICS events; click-to-create | Medium — weakest on mobile |
| `/people` | [`PeopleView.jsx`](frontend/src/components/PeopleView.jsx) | Directory, fairness at a glance, schedule-with | Medium |
| `/profile` | [`ProfileView.jsx`](frontend/src/components/ProfileView.jsx) + `profile/*` | Tabbed: profile, preferences, fairness breakdown, calendar connections | Medium |
| global | [`CreateMeetingModal.jsx`](frontend/src/components/CreateMeetingModal.jsx) + `createMeeting/WizardStep1-3` | 3-step creation wizard | **High** — primary conversion path |
| global | [`MeetingDetailModal.jsx`](frontend/src/components/MeetingDetailModal.jsx) + `meetingDetail/*` | Detail + actions + `AiAnalysisPanel` | High |
| global | [`CommandPalette.jsx`](frontend/src/components/CommandPalette.jsx) | ⌘K nav, search, NL meeting creation | Low — works well |
| global | [`DeclineWizard.jsx`](frontend/src/components/DeclineWizard.jsx) | Structured decline reason capture | Low |
| global | [`PublicProfile.jsx`](frontend/src/components/PublicProfile.jsx) | Another user's public profile modal | Low |
| shell | [`App.jsx`](frontend/src/App.jsx) | 220px sidebar, nav w/ badge counts, user block, theme toggle, mobile hamburger | Medium |

---

## 7. Component primitives to standardize

Design these once, as a documented set, then apply them across all views. This is the
deliverable that pays off most.

- **Button** — primary, secondary, ghost, danger; sizes sm/md; loading state (spinner
  exists as `.btn-spinner`), disabled state, icon-only variant with required label.
  Currently ~14 ad-hoc `.btn-*` classes, several defined twice.
- **Card** — one shell with an optional head (title + right-aligned meta/pill) and body.
  Currently `.dash-card`, `.stat-card`, `.mc`, `.pv-card`, `.people-card` all reinvent it.
- **Modal** — overlay + card + header w/ close + scrollable body + sticky action row.
  Must include `role="dialog"`, `aria-modal`, focus trap, `Esc` to close, focus restore.
  Currently `.modal-*`, `.pp-*`, `.mdm-*`, `.palette-*` are four separate implementations.
- **Badge / pill / chip** — status (pending, confirmed, cancelled), role (organizer,
  invited), count. Must pair color with text or shape, never color alone.
- **Fairness display** — one component, three sizes: ring (hero), bar (inline/breakdown),
  dot+number (list). Single source of color and label.
- **Empty state** — icon, one line of explanation, one action. Currently `.empty-state`,
  `.empty-state-sm`, `.empty-hint`, `.cv-empty` all differ.
- **Form field** — label, control, help text, error text, required marker. The create
  wizard and preferences tab currently style inputs independently.
- **Skeleton** — the shimmer exists; standardize the shapes (line, block, card, row).
- **Slot** — a candidate time slot with score, conflict marker, and selected state. Appears
  in `SlotList`, `SlotCalendar`, and the custom picker with three different treatments.

---

## 8. Accessibility requirements

Non-negotiable for any redesigned surface:

- Every interactive element is a real `<button>`/`<a>`, or has `role` + `tabIndex` +
  keyboard handlers. No bare clickable `<div>`s.
- Visible `:focus-visible` ring, one consistent treatment, meeting 3:1 against its
  background in both themes.
- Modals: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, focus moves in on
  open and returns to the trigger on close, `Esc` closes, focus is trapped while open.
- Expandable regions carry `aria-expanded` + `aria-controls`.
- Toasts live in an `aria-live="polite"` region (`role="alert"` for errors).
- Icon-only buttons have `aria-label`; decorative icons/emoji have `aria-hidden="true"`.
- Status is never color-only — pair with an icon, label, or shape.
- Contrast: 4.5:1 body text, 3:1 large text and UI boundaries, verified in **both** themes.
- `@media (prefers-reduced-motion: reduce)` disables transforms and shimmer.
- Rebuild the three-tier text scale (`--text-primary` / `--text-secondary` /
  `--text-muted`) so all three pass contrast, instead of collapsing muted into secondary.

---

## 9. How to work on this

**Ask before starting** if the ask is broad ("redesign the frontend"). Specifically: which
screens, whether token/color changes are in scope, and whether structural JSX changes are
allowed or CSS-only.

**Preferred order** for a full redesign — each step is independently shippable:

1. Tokens and primitives — fix the text scale, de-duplicate shared CSS, build the component
   set. No visual redesign yet; this is the foundation.
2. Accessibility pass on the primitives (buttons, modals, focus) — cheapest here.
3. Screen-by-screen, highest priority first: `/meetings` → `/` → create wizard → the rest.
4. Responsive pass on a settled breakpoint scale.

**When proposing a design**, show it — build the screen and let it be looked at, rather
than describing it in prose. There is no Storybook; run `npm run dev` from `frontend/` and
work against the real app.

**Verify before claiming done:**
- `npm run lint` passes
- `npm run build` succeeds
- Both themes checked — toggle in the sidebar footer
- Keyboard-only pass over the changed screen
- Narrow viewport (375px) checked

**No test suite exists.** Nothing catches a visual regression automatically, so changes to
shared CSS need every consumer checked by hand. That's exactly why the duplicated classes
in §4.1 should be consolidated before anything else.

**Flag, don't silently absorb:** if a design change would need a new backend field, change
the fairness algorithm's meaning, or alter an API contract, say so and stop.
