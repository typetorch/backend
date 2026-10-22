# TypeTorch web: the backend explorer

The TypeTorch backend's web explorer: overview, Roblox numbers, retention, funnels, players (profile, timeline and node
graph, errors), flow, experiments, first-session signals, events, the live fleet and one server's page (remote debug,
debug bundles, offline history), error logs, performance, raw queries / read-only SQL, and the runtime settings. Vite +
React + TypeScript + Tailwind + shadcn/ui; no SSR.

It lives in the backend repo (`web/`) and ships with it: `bun run web:install && bun run web:build` in the repo root (or
the Docker image) builds it into `web/dist`, and the backend serves it at `/`, where people sign in (the admin token,
Sign in with Roblox, or Sign in with typetorch.dev; see the backend README). This README is about working on it.

## Run it

Needs Bun (package manager), Node 22.12+ (runs Vite: `scripts/vite.mjs`, because Vite's restart hangs under Bun) and a
backend to talk to.

```sh
bun install
bun run dev -- --game <game repo>                     # http://localhost:5173
bun run build && bun run preview -- --game <game repo>   # serve dist/ at http://localhost:4173
```

From the backend repo's root, `bun run web:dev -- --game <game repo>` is the same as `bun run dev` here.

The dev and preview servers proxy `/api/...` to the backend (`server/proxy.ts`, wired up in `vite.config.ts`):

- **Token:** `TYPETORCH_ADMIN_TOKEN` from the game repo's `.env` (`--game`); `TYPETORCH_ENV_FILE` names another file, and a
  `TYPETORCH_ADMIN_TOKEN` in the environment wins over both.
- **Backend URL:** `--url <url>` (or `TYPETORCH_BACKEND_URL`), else the game's `typetorch.json` `backend.url` (the old
  `fleet.url` is still read), else `http://127.0.0.1:8787`. The token only goes to https URLs or to this machine.
- `--port <n>` picks another port.

Without a token every `/api` call answers 503 (the script warns at start when there is no `--game`).

**The token never reaches the browser.** The page calls `/api/...`; the proxy forwards it to the backend and adds
`Authorization: Bearer <admin token>`. With the proxy there is no login page: `GET /v1/auth/check` answers `admin`. Because
any other page open in the same browser could also send requests to localhost, a guard runs first: only the routes in
`ALLOWED_ROUTES` (`server/proxy.ts`: the queries, SQL, rollups, storage, identity lookups and backfill, error kinds, the
live stream, the fleet lists, marks and streams, one server's page with its metrics and remote debug watch / commands /
answers and the debug audit, `GET /v1/admin/settings`, `GET /v1/auth/check`, `GET /healthz`), only from the explorer's own
origin (Sec-Fetch-Site / Origin), JSON bodies only. Erasure, ingest, alert acks, the owner list and settings changes
(`PATCH /v1/admin/settings`, the test alert) are never forwarded. The servers listen on localhost only.

## Pages

All pages share the filter bar (date range: Last 1 hour, Last 6 hours, Today, 7 / 30 / 90 days in UTC days, or custom dates;
branch, artifact, device, new/returning, experiment variant); it lives in the URL, so a view can be bookmarked. The hour
presets send an exact ISO instant (on a whole minute). Charts step by the window (`windowBucketMs` in `lib/filters.ts`, the
backend's rule): up to an hour per minute, up to 6 hours per 5 minutes, up to a day per hour, longer per day.

| Page | What it shows | Query |
|---|---|---|
| Overview | players, new, returning, sessions, events, playtime; per-day bars (per minute, 5 minutes or hour for windows of a day or less); Storage: what the server keeps on disk (DuckDB live, Parquet history, raw, fleet, rows, today's growth), every 30 s | `overview`, `/v1/storage` |
| Roblox | Creator Hub's overview from our events: benchmark cards (playtime per DAU, D1, D7, payer conversion, ARPPU, after-join play-through; 7/14/28 days vs the period before; the 50th/90th you copy from Creator Hub, kept in this browser, with an estimated percentile), a realtime column (concurrent users and a 7-day line from heartbeats, session time, client errors per session, client fps, server memory vs the 24 h before), and 7-day moving averages per join source | `benchmarks`, `realtime`, `trends` |
| Retention | join-day cohorts x day 1/3/7/14/30 heatmap, weighted average, days not over shown as – | `retention` |
| Funnels | funnel picker, step bars (reached, of start, from previous, median time), biggest drop highlighted. "Compare with" puts a second funnel next to it (`compare` in the URL): both funnels' started / completed / biggest drop in one table, then each funnel's steps in its own column; a swap button | `funnel` |
| Players | recent players, search by part of a pid or by a UserId (the UserId shows next to the pid, linking to the Roblox profile; a "Find player" field in the top bar too; a backfill button when the server can read the DataStore links). Columns > Add funnel adds a progress column per funnel (a bar with the percentage over it: the player's furthest step as a share of the funnel's steps; several side by side, `funnels` in the URL). Under the list, the picked player's detail in one container: a profile card (Roblox headshot, display name and username from the backend, UserId, pid, first / last seen, sessions, total spending, playtime per day over the date range; "not linked" without a UserId), the player's progress in each funnel they started, then Spending (Robux per day and each purchase), Playtime (minutes per day, per day and per active day), Sessions (sessions per day, average and median length, each session; a click opens it in Timeline) and Timeline (the node graph for all sessions or one, and every session's events). Each chart has a Table toggle (the same numbers in the shared table); per hour, 5 minutes or minute when the range is a day or less. `view` and `show` are in the URL | `players`, `player-stats`, `player-graph`, `timeline`, `funnel-progress`, `GET /v1/identity/<pid>/profile` |
| Flow | the merged node graph for the filters, where sessions end, busiest moves, "Copy Mermaid" | `flow` |
| Experiments | per-variant numbers and the plain "how sure" sentences, per player or per server (A/B pins) | `experiment` |
| First session | early leaves per zone, screen loops, back-and-forth, idle / camera spins / repeated clicks from recordings | `confusion` |
| Events | top event names by kind, then the newest rows of a picked name (fleet rows without props) | `top-events`, `events` |
| Fleet | live servers (Health badge with the reasons a server is flagged), latest deploy, alerts, live event log, updated over the SSE stream, and a Recently gone table; every JobId links to its server page | fleet API |
| Server (`/servers/<JobId>`, under Fleet in the sidebar) | one server: header (branch, build, kernel, players, uptime, health, place version, last heartbeat), TPS / memory / players over the last hour, and while it runs, read-only remote debug tabs: Status (the kernel's status()), Logs (the server's log ring, Fetch newer; a player's client log), Players, State (Modules > State: roots, tables, pages, key filter), Dex (lazy tree from `game`, properties), Modules and Assets, Builds, Budget, Errors, Network, Audit. Until the server's first poll it says "Connecting" (its next heartbeat, up to 30 s), or "Waking server..." when the watch reply says a wake message went out (the backend's instant wake: it polls within seconds; the page re-reads the server every second meanwhile). A closed, lost or unknown server says so and sends no watch. Answers stay in the page (not the query cache, localStorage or the URL; these tables don't save their view) | `/v1/fleet/servers/<JobId>`, `.../metrics`, remote debug (backend README) |
| Errors | error kinds in the window (realm, branch, artifact filter, text search) with counts, players and sparklines; a row opens the kind in a side sheet (`?fp=`) with its stack, series and the players who hit it | `/v1/errors`, `/v1/errors/<fp>`, `/v1/errors/<fp>/players` |
| Performance | client fps / memory / ping and server TPS / memory / players over time, by device class, input, screen size, branch or build, p10 / p50 / p90 / p99 (p99 marked worst); orange / red flags on possible problems (`lib/perf-thresholds.ts`); deploy marks on every chart (hover: what it was; click: filter to that build); compare builds or before vs after a mark; live servers' TPS and memory with each one's history; a Step picker | `perf-client`, `perf-server`, `perf-compare`, `/v1/fleet/marks`, `/v1/fleet/servers/<job>/metrics` |
| Query | any named query with JSON filters/options (raw JSON), and read-only SQL over `events` / `recordings` | `/v1/query/*`, `/v1/sql` |
| Settings | the backend's runtime settings (alert webhook as set / not set, format and levels, admin allow list, token login, rate limits, retention): source badge per field (Dashboard / Env / Default), bounds checked before saving, Reset to env, Send test alert, recent changes, the env-only names. Through the dev proxy it is read only | `/v1/admin/settings` |

Graphs are drawn with React Flow and laid out by dagre (left to right; top to bottom in a narrow column), edges labelled
"count · average time before the move" (one session: #1, #2, ... in order), width by count, moves back to an earlier
state routed around the side. Each state shows what happened there (its top events and funnel steps; click it for the
list). "moments" adds key moments (funnel steps, purchases, personal_best, round_end) as small nodes on the path. A
graph with fewer than 3 states says so in one dim line, with a link to the player's events.

## Tables

Every table in the explorer is one component, `src/components/data-table/` (TanStack Table 8 for sorting, paging and column
visibility; filtering, saved views and export in `model.ts`). A table gives you, without page code:

- **Sort**: click a header (first click: biggest / newest first for numbers and dates, A to Z for text; again: the other way;
  again: off); shift-click adds a column to the sort. Sorting uses the column's **underlying value**, never the text it shows, so
  "47 / 60", "812 MB", "5 min ago" and "42%" sort as numbers and times. Missing values sort last in both directions.
- **Find**: a search box over the visible columns (every word must match, from 6 rows up), a filter button per column (a checklist
  for enum / boolean columns, a min and max for numbers, "last hour / 24 hours / 7 / 30 days" for dates, "contains" for text),
  chips for the active filters, and "12 of 340 rows".
- **Columns**: a Columns picker on every table (checkboxes, Reset columns), draggable widths (arrow keys too, double-click resets),
  a sticky header, horizontal scroll inside the table (never the page), pages of 25 to 500 rows.
- **Copy and export**: a row menu (Copy row as JSON, Copy cell), and Export: Download CSV or Copy as CSV or JSON of the current
  filtered and sorted view (visible columns, underlying values, formula-safe), Copy link to this view.
- **Remembered**: sort, search, filters, hidden columns and widths are kept per table id in localStorage, and written to the URL
  (`fleet-servers.sort=-players,job`, `fleet-servers.f.health=set:ok,failing`, `fleet-servers.cols=-kernel,+channel`). A link with a
  table's parameters wins over the saved view. Both are optional: without storage or a router the table still works.

```tsx
const COLUMNS: DataColumn<Server>[] = [
	{ id: "job", header: "Job", accessor: (s) => s.job, cell: (s) => shortId(s.job) },
	// Shown as "47 / 60", sorted and filtered by 47:
	{ id: "players", header: "Players", accessor: (s) => s.players, cell: (s) => `${s.players} / ${s.max}` },
	// Memory in MB with a unit hint; null sorts last:
	{ id: "memory", header: "Memory", hint: "MB", accessor: (s) => s.memMb, cell: (s) => `${s.memMb} MB` },
	{ id: "health", header: "Health", type: "enum", order: ["ok", "degraded", "failing"], accessor: (s) => s.health },
	{ id: "seen", header: "Seen", type: "date", accessor: (s) => s.lastSeen, cell: (s) => fmtAgo(s.lastSeen) },
	{ id: "channel", header: "Channel", type: "enum", accessor: (s) => s.channel, defaultHidden: true },
];

<DataTable id="fleet-servers" label="Live servers" columns={COLUMNS} data={servers} rowId={(s) => s.job}
	defaultSort={[{ id: "players", desc: true }]} onRowClick={open} empty={<EmptyState>No servers.</EmptyState>} />
```

`accessor` is the value (number for numbers, epoch ms / ISO string / Date for dates, `null` for none); `cell` is what shows. Other column
options: `type` (`text` `number` `date` `enum` `boolean`, guessed from the values when left out), `format` (plain text of the cell, for
search and filter labels), `searchText`, `filter` (`false` or a kind), `options` and `order` (enums), `firstSort`, `sortable`,
`hideable`, `defaultHidden`, `searchable`, `align`, `minWidth`, `className`, `hint`, `title`, `exportValue`. Table props: `id` (unique
in the app), `columns` and `data` (define the column array outside the component or in `useMemo`), `label`, `rowId`, `loading`, `empty`,
`defaultSort`, `pageSize`, `maxHeight`, `search`, `toolbar`, `onRowClick`, `isRowSelected`, `rowClassName`, `pinnedRows` (a total row
outside sorting and filtering), `rowJson`, `rowMenu`, `persist`, `urlSync`, `density`. Event rows have `EventTable`; SQL results build
their columns from DuckDB's types (`sqlColumns` in `pages/Query.tsx`).

## Development

```sh
bun run test        # vitest: API client, graph adapter, filters, proxy guard, the table (sorting, filters, saved view), page tests
bun run typecheck
bun run build       # dist/ (pages, charts and the graph view load on demand)
```

`src/lib/types.ts` mirrors the backend's query and route result types (`../src/queries`, `../src/fleet`, ...: copied,
not imported, since the explorer builds on its own); keep it in step when a query or route changes. `src/components/ui/` is shadcn/ui as generated (radix, nova preset); chart colors and
status colors are tokens in `src/index.css`.

## Open issues

- The proxy's `ALLOWED_ROUTES` has not kept up with every page: `GET /v1/place` (the sidebar's place card),
  `GET /v1/roblox/products` (product names), `GET /v1/experiments` and `/v1/experiments/<key>/players`,
  `GET /v1/errors/<fp>/players`, `GET /v1/players/<pid>/errors`, and the debug bundle routes are refused through it (403),
  so those parts stay empty under `bun run dev`. The explorer the backend serves at `/` has them all.
- `top-events` counts server rows (no pid) as one "player" (an analytics query quirk).
- Days are UTC everywhere (the server's day buckets).
