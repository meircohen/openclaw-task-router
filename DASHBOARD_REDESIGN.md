# OpenClaw Router Dashboard v2 — Redesign Spec

> Date: 2026-02-19
> Author: Claude (Oz)
> Status: Implementation Ready

---

## 1. Information Architecture

### Primary Navigation (6 Views)

| View       | Purpose                          | Data Sources                     | Refresh   |
|------------|----------------------------------|----------------------------------|-----------|
| **Queue**  | Live task queue + running jobs   | `/api/queue`, `/api/stats`       | SSE + 5s  |
| **Costs**  | Spend tracking, budgets, savings | `/api/costs?period=month`        | 60s       |
| **Health** | Backend status, circuit breakers | `/api/backends`, `/api/alerts`, `/api/breakers`, `/api/health/backends` | SSE + 15s |
| **Plans**  | Plan creation, DAG viewer        | `/api/plan`, `/api/plans/pending`| SSE       |
| **History**| Task history, search, export     | `/api/history`                   | On-demand |
| **Settings**| Config editor, scheduler control | `/api/config`, `/api/scheduler`  | On-demand |

### Information Hierarchy (Per View)

```
Queue:
  ├── KPI Strip (running, queued, success rate, alerts, tokens/hr)
  ├── Live Task Table (sortable, filterable)
  │   └── Row: status badge, description, backend, priority, time, actions
  └── Dead Letter Queue (collapsible)

Costs:
  ├── KPI Strip (today, this month, projected, saved by subs)
  ├── Chart Row 1: Daily Spend (bar) | Cost by Backend (doughnut)
  └── Chart Row 2: Running Total vs Budget (line) | Subscription Savings (area)

Health:
  ├── Backend Cards Grid (4x1 → 2x2 → 1x4 responsive)
  │   └── Card: status, success rate, sparkline, usage bar, cooldown
  ├── Circuit Breaker States
  └── Alerts Table (level, message, time, ack button)

Plans:
  ├── Create Plan Form (description, type, complexity)
  ├── Pending Plans List (from both persistent + in-memory)
  └── Plan Detail: stats strip + DAG visualization + approve/cancel

History:
  ├── Filter Bar (date range, backend, limit, search, export)
  └── Results Table (time, result, backend, type, duration, tokens, cost)

Settings:
  ├── Config Editor (editable) | Config Preview (read-only)
  └── Quick Actions (pause/resume scheduler, ping backends)
```

---

## 2. Component Hierarchy

```
<App>
├── <CommandBar>                    # Cmd+K palette (Linear-inspired)
├── <TopBar>
│   ├── <Logo>                     # "OpenClaw" monospace, green accent
│   ├── <NavTabs>                  # 6 tabs, bottom-border active indicator
│   ├── <SSEIndicator>             # Live/Offline pill
│   └── <RefreshTimer>             # Countdown to next auto-refresh
├── <Content>
│   ├── <KPIStrip>                 # Reusable: array of stat boxes
│   │   └── <StatBox>             # Label, value, trend arrow, sparkline
│   ├── <DataTable>                # Reusable: sortable, filterable, virtual scroll
│   │   ├── <TableHeader>
│   │   ├── <TableRow>
│   │   └── <TableFooter>         # Pagination / count
│   ├── <ChartCard>                # Reusable: title + Chart.js canvas
│   ├── <BackendCard>              # Health card with metrics + sparkline
│   ├── <DAGViewer>                # Plan step visualization
│   ├── <FilterBar>                # Date pickers, selects, buttons
│   └── <ConfigEditor>             # Textarea with syntax highlighting
├── <Toast>                        # Notification system (bottom-right)
└── <CommandPalette>               # Cmd+K overlay (modal)
```

---

## 3. Layout Wireframes

### Desktop (≥1024px)

```
┌──────────────────────────────────────────────────────────────┐
│ ⚡ OpenClaw Router    [Queue][Costs][Health][Plans][Hist][⚙]  ● Live │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐         │
│  │ Run  │  │ Queue│  │ Rate │  │ Alert│  │ Tok/h│         │
│  │  3   │  │  12  │  │ 94.2%│  │  0   │  │ 24K  │         │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Status │ Description          │ Backend │ Pri │ Time  │   │
│  ├────────┼──────────────────────┼─────────┼─────┼───────┤   │
│  │ ● RUN  │ Refactor auth module │ claude  │ URG │ 2m ago│   │
│  │ ○ QUE  │ Update tests         │ codex   │ NRM │ 5m ago│   │
│  │ ○ QUE  │ Generate report      │ api     │ BKG │ 8m ago│   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Mobile (iPhone, <768px)

```
┌────────────────────────┐
│ ⚡ OpenClaw       ● Live│
├────────────────────────┤
│ [Queue][Cost][HP][▼ +2]│  ← horizontal scroll tabs
├────────────────────────┤
│ ┌────┐ ┌────┐ ┌────┐  │  ← KPI strip scrolls horizontal
│ │ R:3│ │Q:12│ │94% │  │
│ └────┘ └────┘ └────┘  │
├────────────────────────┤
│ ┌──────────────────┐   │
│ │ ● Refactor auth  │   │  ← Task cards (not table rows)
│ │   claude · URG   │   │
│ │   2m ago    [⋯]  │   │
│ └──────────────────┘   │
│ ┌──────────────────┐   │
│ │ ○ Update tests   │   │
│ │   codex · NRM    │   │
│ │   5m ago    [⋯]  │   │
│ └──────────────────┘   │
│                        │
│         ← swipe →      │  ← Swipe between views
└────────────────────────┘
```

### Costs View (Desktop)

```
┌──────────────────────────────────────────────────────────────┐
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                    │
│  │Today │  │Month │  │Proj. │  │Saved │                    │
│  │$0.42 │  │$8.12 │  │$12.8 │  │$234  │                    │
│  └──────┘  └──────┘  └──────┘  └──────┘                    │
│                                                              │
│  ┌───────────────────────┐  ┌───────────────────────┐       │
│  │  Daily Spend          │  │  Cost by Backend      │       │
│  │  ▅▃▇▄▅▂▆▃▅▇▄▃       │  │      ╭──╮             │       │
│  │  ▃▂▃▂▃▁▃▂▃▃▂▂       │  │    ╭─╯  ╰─╮           │       │
│  │  ─────────────────    │  │    ╰──────╯           │       │
│  └───────────────────────┘  └───────────────────────┘       │
│                                                              │
│  ┌───────────────────────┐  ┌───────────────────────┐       │
│  │  Running Total        │  │  Subscription Savings │       │
│  │  ╱─────────── budget  │  │  ╱──────────────      │       │
│  │ ╱      ╱─────         │  │ ╱   ╱────             │       │
│  └───────────────────────┘  └───────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

### Health View (Desktop)

```
┌──────────────────────────────────────────────────────────────┐
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────┐│
│  │ Claude Code  │ │ Codex       │ │ API         │ │ Local  ││
│  │ ● online     │ │ ● online    │ │ ⚠ throttled │ │● online││
│  │ 96.2% ▅▆▇▇▅▆│ │ 88.4% ▃▅▆▇▅│ │ 72.1% ▂▃▂▃▂│ │100%   ││
│  │ ▓▓▓▓▓░░ 62% │ │ ▓▓░░ 2/3   │ │ $4.2/$10   │ │ 24 tsk ││
│  │ Cool: Ready  │ │ Cool: 3m   │ │ sonnet-4.6  │ │        ││
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────┘│
│                                                              │
│  Circuit Breakers                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ claude-code: CLOSED ✓  codex: CLOSED ✓               │   │
│  │ api: HALF-OPEN ⚠       local: CLOSED ✓               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Alerts                                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ⚠ WARN │ API rate limit approaching │ 10m ago │ [Ack]│   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Color System

### Base Palette (Dark Theme)

```
Background Layers:
  --bg-base:     #0a0a0f     (deepest — page background)
  --bg-surface:  #12121a     (cards, panels)
  --bg-elevated: #1a1a26     (hover states, dropdowns)
  --bg-overlay:  #222233     (modals, command palette)

Borders:
  --border:      #1e1e2e     (default)
  --border-hover:#2a2a3e     (hover)
  --border-focus:#00ff88     (focus rings)

Text:
  --text-primary:   #e8e8f0   (main content)
  --text-secondary: #6b6b80   (labels, dimmed)
  --text-tertiary:  #44445a   (disabled, hints)
```

### Status Colors

```
Success / Online:    #00ff88  (green — primary accent)
Info / Running:      #3b82f6  (blue)
Warning / Throttled: #f59e0b  (amber)
Danger / Error:      #ef4444  (red)
Neutral / Queued:    #6b6b80  (gray)
```

### Backend Colors

```
Claude Code:  #a855f7  (purple)
Codex:        #3b82f6  (blue)
API:          #f59e0b  (amber)
Local:        #10b981  (emerald)
```

### Status Badge Backgrounds (15% opacity of status color)

```
.badge.online    →  rgba(0, 255, 136, 0.12)  text: #00ff88
.badge.running   →  rgba(59, 130, 246, 0.12)  text: #3b82f6
.badge.throttled →  rgba(245, 158, 11, 0.12)  text: #f59e0b
.badge.error     →  rgba(239, 68, 68, 0.12)   text: #ef4444
.badge.queued    →  rgba(107, 107, 128, 0.12)  text: #6b6b80
```

---

## 5. Typography

```
Hierarchy:
  --font-sans:  'Inter', -apple-system, BlinkMacSystemFont, sans-serif
  --font-mono:  'JetBrains Mono', 'SF Mono', 'Fira Code', monospace

Usage:
  Labels, navigation, headings     →  var(--font-sans)
  Data values, metrics, code, IDs  →  var(--font-mono)
  Stat box values                  →  var(--font-mono), 1.8rem, weight 700
  Table cells                      →  var(--font-mono), 0.8rem
  Card titles                      →  var(--font-sans), 0.85rem, weight 600
  Nav tabs                         →  var(--font-sans), 0.8rem, weight 500
  KPI labels                       →  var(--font-sans), 0.7rem, uppercase, tracking 0.08em
  Body text                        →  var(--font-sans), 0.85rem, line-height 1.5

Scale: 0.7rem → 0.75rem → 0.8rem → 0.85rem → 0.95rem → 1.1rem → 1.6rem → 2rem
```

---

## 6. Animation Patterns

### Transitions

```
Micro-interactions:
  - Nav tab switch:     border-color 150ms ease
  - Card hover:         border-color 200ms ease, transform 150ms
  - Button hover:       background 150ms ease, color 150ms
  - Badge pulse:        opacity 2s infinite (running tasks only)
  - Toast enter:        translateY(10px→0) + opacity(0→1), 300ms ease-out
  - Toast exit:         opacity(1→0), 200ms ease-in
  - Page transition:    opacity(0→1) + translateY(4px→0), 200ms ease

Loading States:
  - Skeleton shimmer:   linear-gradient sweep, 1.5s infinite
  - Spinner:            rotate 0.8s linear infinite (12px ring)
  - Data refresh:       brief opacity flash (0.7→1), 300ms

Chart Animations:
  - Initial render:     Chart.js default progressive draw
  - Data update:        300ms transition (no full re-render)

SSE Live Updates:
  - New queue item:     fadeIn + slideDown, 300ms
  - Status change:      background flash (green/red pulse), 500ms
  - Connection lost:    indicator color transition, 300ms
```

---

## 7. Mobile-First Responsive Strategy

### Breakpoints

```
xs:  < 480px   (iPhone SE)
sm:  480-767px (iPhone 14/15)
md:  768-1023px (iPad portrait)
lg:  ≥ 1024px  (desktop)
```

### iPhone Optimizations

```
Touch Targets:
  - Minimum 44px height for all interactive elements
  - 12px padding minimum on buttons
  - Tab buttons: 44px height, 14px horizontal padding
  - Table rows: 48px height on mobile (larger tap target)

Viewport:
  <meta name="viewport" content="width=device-width, initial-scale=1.0,
        maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  - Safe area insets for notch/home indicator
  - env(safe-area-inset-bottom) padding on bottom elements

Navigation:
  - Horizontal scroll tabs (no wrapping, momentum scroll)
  - Active tab auto-scrolls into view
  - Bottom sheet for overflow actions (not dropdowns)

Tables → Cards:
  - On mobile, tables transform to stacked cards
  - Each card shows key info in 2-3 lines
  - Swipe-left reveals action buttons (cancel, reprioritize)

Charts:
  - Reduce height to 180px on mobile
  - Doughnut chart: legend moves below chart
  - Horizontal scroll for wide charts

KPI Strip:
  - Horizontal scroll with snap points
  - 3 visible at a time, scroll for more

Gestures:
  - Pull-to-refresh on queue and health views
  - Swipe between views (touch event handler)
  - Long-press on queue items for context menu
```

---

## 8. Specific Inspiration from Each Reference

### Vercel

- **Minimal dark UI**: Near-black background (#000) with pure white text creates maximum contrast. We adopt #0a0a0f (slightly warmer).
- **Deployment status indicators**: Small colored dots (green/yellow/red) inline with text. Clean, not noisy.
- **Real-time log streaming**: Monospace, dark background, auto-scroll with "jump to bottom" button. Inspires our SSE connection feedback.
- **Card border glow on hover**: Subtle border-color change, not shadow. We use this for all `.card:hover`.
- **Function-level breadcrumbs**: Clean typographic hierarchy. We use this for plan step breadcrumbs.

### Linear

- **Keyboard-first UX**: Cmd+K command palette for power users. We implement a command palette overlay.
- **Speed perception**: Instant page switches (no loading spinners for cached data). We use optimistic UI updates from SSE.
- **Task card density**: Compact rows with status, assignee, priority in one line. Our queue table follows this density.
- **Subtle animations**: No jarring movements. Page transitions are 150ms fade+slide. We adopt this timing.
- **Icon-based status**: Small, meaningful icons instead of text badges. We use colored dots + short text.

### Railway

- **Resource monitoring cards**: Each service gets a card with name, status, and mini usage graph. Direct inspiration for our backend health cards.
- **Usage graphs inline**: Sparklines embedded in cards, not separate chart pages. We embed sparklines in backend cards.
- **Clean metric layout**: Label on left, value on right, divider between rows. Our `.metric` class follows this exactly.
- **Purple accent palette**: Railway uses purple as primary. We use it for Claude Code backend identity.
- **Deploy timeline**: Vertical timeline with status dots. Inspires our plan DAG visualization.

### Grafana

- **Data density**: Panels pack maximum information per pixel. Our KPI strip targets this density.
- **Time range selector**: Quick presets (1h, 6h, 24h, 7d, 30d) + custom range. We add time range presets to History and Costs views.
- **Panel grid system**: Flexible grid that adapts from 4-col to 1-col. Our `.grid-*` classes mirror this.
- **Threshold visualization**: Color bands on charts showing warn/critical zones. We add budget threshold lines to cost charts.
- **Auto-refresh indicator**: Shows countdown timer to next refresh. We add this to the top bar.

### Bull Board (BullMQ)

- **Queue state visualization**: Clear counts for waiting/active/completed/failed with colored badges. Direct model for our queue stats strip.
- **Job detail drill-down**: Click a job to see full payload, logs, retry history. We make queue rows expandable.
- **Retry controls**: One-click retry, bulk retry for failed jobs. We add retry buttons to failed tasks.
- **Dead letter queue**: Separate section for permanently failed jobs. We add DLQ display to queue view.
- **Progress tracking**: Visual progress bar for long-running jobs. We add progress indicators to running tasks.

### Render

- **Service health grid**: Grid of service cards with green/yellow/red indicators. Directly inspires backend cards layout.
- **Mobile-friendly tables**: Tables collapse to cards on mobile with key info visible. We implement this pattern.
- **Deploy status timeline**: Each deploy shows a timeline with steps. Inspires plan execution visualization.
- **Clean button hierarchy**: Primary (filled), secondary (outlined), danger (red outline). We adopt this button system.
- **Responsive breakpoints**: Clean transitions without layout jumps. We use CSS grid with `minmax()` for smooth reflow.

---

## 9. Key Interactions

### Keyboard Shortcuts

| Key        | Action                     |
|------------|----------------------------|
| `1-6`      | Switch to view 1-6         |
| `Cmd+K`    | Open command palette        |
| `R`        | Refresh current view        |
| `Esc`      | Close modal/palette         |
| `J/K`      | Navigate table rows         |
| `Enter`    | Expand selected row         |
| `?`        | Show keyboard help          |

### Click Interactions

- **Queue row** → Expand to show full task details + logs
- **Backend card** → Toggle expanded view with detailed metrics
- **Plan step** → Highlight dependencies in DAG
- **Alert row** → Acknowledge with single click
- **Stat box** → Navigate to relevant view
- **Chart** → Chart.js default tooltips on hover

### Touch/Swipe (Mobile)

- **Swipe left on queue item** → Reveal cancel button
- **Pull down on view** → Refresh data
- **Tap stat box** → Navigate to detail view
- **Horizontal scroll** → Tab navigation, KPI strip
- **Long press** → Context menu on queue items

### SSE Real-time Updates

- `connected` → Set indicator to green "Live"
- `status` → Auto-refresh queue view
- `queue-update` → Refresh queue, flash new/changed items
- `plan-created` → Toast notification
- `plan-executed` → Toast + auto-refresh plans view
- `config-updated` → Toast + reload config
- `breaker-update` → Flash circuit breaker state change
- `health-update` → Update backend card
- `scheduler-update` → Update pause/resume state

---

## Implementation Notes

- Single HTML file, no build step, no framework
- Chart.js v4.4.x via CDN
- Inter font via Google Fonts CDN (with system font fallback)
- JetBrains Mono via Google Fonts CDN (with system font fallback)
- All CSS custom properties for theming
- Progressive enhancement: works without JS for basic layout
- Service worker NOT included (keep it simple)
- Target: 2500-3500 lines total
