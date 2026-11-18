# The public demo (demo.typetorch.dev)

The real TypeTorch explorer (`web/src`, unchanged) over a backend that runs in the visitor's browser. No server, no
login: everybody is the game's owner, every page and action works, and changes stay in that browser. The data is an
anonymized sample of **The Prison** (14 days, 1,865 players): every pid, sid and JobId re-keyed with a salt that was
thrown away, fake place / universe ids (9876543210 / 1234567890), launch data blanked, no Roblox UserId or name
anywhere. It is hosted as static files on a Cloudflare Worker (`typetorch-demo`).

```
web/
  vite.demo.config.ts      the demo's Vite entry (root web/demo, builds web/dist-demo; tests: web/demo/test)
  demo/
    index.html, main.tsx   installs the mock backend, mounts the banner, then imports the real web/src/main.tsx
    banner.tsx             "Demo: ..." strip with Reset demo and the DuckDB loading state
    layout.css             keeps the banner on top and fits the explorer's shell (sidebar, header) under it
    mock/                  the backend in the browser (below)
    shims/                 browser stand-ins for the Node modules the backend's shared code imports (browser build only)
    scripts/prepare-data.ts  the data pack -> web/demo/public/data (gzip CSV, facts.json, manifest.json, maps)
    scripts/build-pack.ts    a game's analytics data -> an anonymized data pack (see "Rebuilding the data pack")
    test/                  vitest on Node: every named query on the pack, the router, every domain, every page (jsdom)
    deploy/                the Cloudflare project (cf): worker.ts, cloudflare.config.ts, wrangler.config.ts, headers.ts
    public/                generated (gitignored): favicons and data/
```

## How it works

- `mock/router.ts` replaces `window.fetch` for same-origin `/api/*` (everything else passes through) and `EventSource`
  for `/api/*` streams. Handlers register per method and path pattern; unknown routes answer
  `404 { error: "not in the demo" }` and warn once in the console. Answers wait 50-250 ms like a real server.
- `mock/analytics.ts`: `/v1/query/<name>` runs the backend's **real** query definitions (`src/queries`, imported from the
  backend source) on DuckDB-WASM; `/v1/sql` (read-only), `/v1/queries` and saved queries too.
- `mock/engine.ts` + `engine-wasm.ts`: DuckDB-WASM (bundle from jsDelivr, loaded on the first analytics call) over the
  pack's gzip CSV from `/data/`. The pack's days are moved forward so its last day is today (UTC); rows after "now"
  are hidden (views `events` / `recordings` over `_tt_events` / `_tt_recordings`).
- `mock/pack.ts`: precomputed facts (`facts.json`: jobs, players, artifacts, deploy reports, error kinds, vocabulary)
  for the non-analytics mocks, already shifted, so the fleet / error / player pages line up with the analytics pages
  without loading DuckDB.
- `mock/state.ts`: everything visitors change, in memory and localStorage; "Reset demo" clears it.
- Privacy in the browser: `deploy/headers.ts` sets a Content-Security-Policy that only allows the site itself and
  `cdn.jsdelivr.net`, so nothing (roblox.com avatars, the real backend, extensions.duckdb.org) can be reached even by
  mistake.

### Why CSV, and the JSON macro

DuckDB-WASM's core build has no Parquet, JSON or ICU: it would download those extensions from extensions.duckdb.org at
runtime, which the demo never does (autoloading is off and the CSP blocks it). So `prepare-data.ts` turns the Parquet
pack into gzip CSV (the core reader; `\N` is NULL, an empty field is an empty string), and the backend's
`json_extract_string(props, '$."key"')` calls are rewritten to `tt_json_extract_string`, a SQL macro (regex over flat
JSON objects; nested objects / arrays give NULL). The backend's own calls (a column and a constant key) get a fast path
first (a substring test, then `split_part` for a string value of a row without backslashes), with the same answers
(tested): the regex alone made the Experiments page take tens of seconds. Without ICU DuckDB works in UTC, like the
backend. Functions that need ICU (`date_trunc` / `strftime` on `TIMESTAMP WITH TIME ZONE`, `SET TimeZone`) fail in the
browser: the backend's queries don't use them (see the browser check in "Test").

The pack has feedback prompts but no answers, so the engine adds synthetic `feedback/submit` rows for about 60% of the
prompts (`feedbackStatement` in `mock/engine.ts`: a 5-star scale, half with a short text in the game's words).

The pack has no notification rows either. After the base setup, `syntheticSetup` (`mock/notify-rows.ts`) writes the
`kind = 'notify'` rows the Notifications page's analytics tabs read (notify-funnel, notify-optin, notify-queue): the
sends of `mock/notify.ts`'s world (the Inbox / Subscribers tabs) row for row (`want`, `planned`, `sent`, `failed` with
400 / 429 / 503, `skipped`, `optin_inferred`), the planner's other skips, `open` / `played` at the start of the player's
next real session, and the opt-in prompt (`optin_check` / `optin_shown` / `optin_closed`) in the players' early
sessions. Each world user (keyed by a demo UserId) is mapped to a pack pid inside the engine only; the rows carry pids,
never a UserId, and identity answers stay empty. Game-server rows sit inside a real session and take its context, so
session lengths don't change.

## Writing handlers (for the domain files)

One file per domain, imported once from `mock/handlers.ts`: `fleet.ts`, `players-errors-live.ts`,
`admin-maps-roblox.ts` (the foundation's are `auth.ts` and `analytics.ts`).

```ts
import type { FleetServers } from "@/lib/types";            // type every answer from web/src/lib (tsc catches drift)
import { pack } from "./pack";                                 // facts: jobs, players, artifacts, errors, vocabulary
import { now, shiftMs } from "./data";                         // the demo clock; the day shift for times inside props
import { fakeName, rng } from "./rng";                         // seeded randomness, fake names
import { fail, HttpError, json, route, stream } from "./router";
import { nextId, slice } from "./state";                       // persisted writable state

const acks = slice<Record<string, number>>("fleet.acks", () => ({}));   // "<domain>.<what>", JSON only, seed once

route<FleetServers>("GET", "/v1/fleet/servers", async (req) => {
	const p = await pack();
	const branch = req.query.get("branch");
	if (branch && !["prod", "dev"].includes(branch)) throw new HttpError(400, "unknown branch");
	const r = rng(`fleet:servers:${branch ?? "all"}`);               // stable per seed
	return { servers: p.jobs.filter((j) => j.live).map(...), players: ... };
});
route("POST", "/v1/things/:id", (req) => json(201, { thing: req.params.id, body: req.body }));
stream("/v1/fleet/stream", (req, sink) => {
	sink.send("hello", { at: new Date(now()).toISOString() });
	const timer = setInterval(() => sink.send("server", {...}), 15_000);
	return () => clearInterval(timer);
});
```

- **Requests**: `req.params` (decoded `:name` segments, `*` for a final wildcard), `req.query` (URLSearchParams),
  `req.body` (parsed JSON or undefined), `req.text`, `req.headers`, `req.method`, `req.path` (after `/api`).
- **Answers**: return the JSON body (200), or a `Response` (`json(status, body)`, `fail(status, "message", extra)` for the
  backend's `{ error, ...extra }`, binary `new Response(bytes, ...)`). `throw new HttpError(status, message, extra)`
  works anywhere. Copy the real route's status codes and messages from `src/server/*.ts`, `src/fleet/*http*.ts`,
  `src/notify/routes.ts`. The most literal pattern wins (`/v1/maps/export` over `/v1/maps/:name`); a duplicate
  registration throws.
- **Data**: `await pack()` gives the pack's facts with times shifted (live jobs: `p.jobs.filter((j) => j.live)`). Times
  inside raw `props` strings are not shifted: add `shiftMs()` (ms) or `shiftSeconds()`. For anything else,
  `sql("SELECT ... FROM events ...")` from `./engine` (loads DuckDB-WASM: prefer facts for fleet-like pages) or
  `runNamedQuery(name, filters, options)` / `runSql(sql)` from `./analytics`.
- **Determinism**: seed `rng()` with what the answer is about; use `now()` (never `Date.now()`) so tests can pin time.
- **Privacy**: no real UserId, username or roblox.com URL. The demo owner is UserId -1 (`DEMO_OWNER`, like Studio's
  first test player; `prepare-data` rewrites the maps index's "by" to it), so no id in the demo can be someone's account. Names come from `fakeName(pid, team)` ("Inmate_4821").
  Where a type needs a UserId use `fakeUserId(pid)` (negative, can't be a real account) and leave every avatar /
  thumbnail / icon URL out or null (the explorer only shows `*.rbxcdn.com` images, and the CSP blocks them anyway).
  Identity answers: UserIds are never mapped to pids in the demo ("user ids not mapped").
- **Vocabulary**: errors, logs, alerts and notifications speak The Prison's language: inmates, guards, medics, the
  warden, escapes, arrests, lockpicks, quests (`p.vocabulary.props.quest`), shop items (`.item`), weapons, cash.
- **Owner-only**: everybody is an owner (`role: "admin"`), so owner-only routes answer as for an owner.

### Decisions that differ from the backend (on purpose)

- `player.logs` (remote debug, `mock/fleet-remote.ts`) accepts any non-zero whole UserId; the backend wants 1 or more.
  The players op answers the negative `fakeUserId()` ids, and every player's Logs button must work.
- The notification pages need positive digit UserIds (the explorer refuses others), so the notify world uses 13-digit
  ids from 9,000,000,000,000 up, far past any real account, shown as text only (no profile link, no avatar).
- The Roblox products route (`mock/roblox.ts`) uses The Prison's public game pass / developer product ids as they appear
  in the pack's purchase events (catalog data, not player data; the banner names the game anyway). Names are invented,
  icons are null.
- `GET /v1/live-events?refresh=1` acts as if the owner had signed the schedule, and an experiment change is applied to
  the stored overrides at once (the backend only prepares the CLI commands); the answers say so.
- Story beats not in the pack: seq 217's smallest server fails to start (a critical `deploy_failed` alert and a
  `start_failed` bundle; 219 is the fix); while fewer than 3 prod servers are live, the most recent prod servers of the
  last 6 h keep running, and the newest dev server stays up as degraded. The analytics pages show those servers as ended.
- Not modelled: `serverVersion` (always null), the IP database's credit link (null: no link to db-ip.com), a remote
  command's 5 s expiry (commands are always answered on a live server), and events with `px` / `pz` props (the pack has
  none, so the Recordings "positioned events" layers and the `map-positions` cells are empty; the recordings' own layers
  work, and the Prison's only exported map is the lobby, which the Maps page draws without event cells).

## Data, build, test, deploy

All from `web/`:

```sh
bun install                 # also in the repo root (the scripts use the backend's @duckdb/node-api)
bun run demo:data           # pack -> demo/public/data (skipped when up to date; --force to redo)
bun run demo:dev            # http://localhost:5174, no backend needed
bun run demo:build          # data + tsc -p demo/tsconfig.json + vite build -> dist-demo
bun run demo:test           # vitest -c vite.demo.config.ts (suites needing the pack skip without it)
cd demo/deploy && bun install && node node_modules/cf/bin/cf deploy --dry-run   # checks the Worker (Node 22.18+)
bun run demo:deploy         # build, then `cf deploy` (the real deploy; Node 22.18+, cf logged in)
```

The DuckDB-WASM version is pinned exactly in `web/package.json` (`1.33.1-dev57.0`, the package's `latest` tag: DuckDB 1.5,
the backend's engine; the last non-dev release, 1.32.0, is DuckDB 1.4) and its bundle URLs come from that version
(`getJsDelivrBundles`). The bundle is loaded without SRI (the worker is started from a blob that imports it, and the
.wasm is fetched by DuckDB itself); the CSP limits scripts and connections to the site and cdn.jsdelivr.net.

The pack is looked up in `--pack <dir>`, `TYPETORCH_DEMO_DATA`, `web/demo/data/` or `../../.demo-data` (next to the
repo). It never goes into git (`demo/public/`, `demo/data/` and `dist-demo/` are ignored).

Tests: `demo/test/harness.ts` has `setupDemo({ engine? })` (pinned clock `TEST_NOW`, no latency, fresh state, the
prepared data; `engine: true` opens DuckDB on Node), `testApi()` (the explorer's `createApi` over the mock router: call
any `api.*` function), `installTestFetch()` (for code that calls `fetch` itself, like `lib/maps.ts`), `mockFetch`, and
`describeWithPack` (skips without the data). The Node engine is native DuckDB pinned to UTC with the same setup and
macro; the browser (no ICU) was checked by hand: open the demo, then run every named query from the console.

Whole-demo checks (they need the pack):

- `pages.test.tsx` (jsdom): mounts the real explorer (`web/src/main.tsx` and its router) over the mocks and visits every
  route and tab (Server tabs, Notifications tabs, Recordings tabs, a player, an error, a deploy...). It fails on any
  non-2xx `/api` answer, error boundary, "Could not load" alert, console error or unhandled rejection. jsdom has no
  WebGL, so the map canvases only log that (ignored). `DEMO_PAGES_REPORT=<file>` writes a per-page log (time, text,
  empty states).
- `links.test.ts`: ids line up across domains (every live / gone server, deploy, alert bundle, error kind and the pids
  and JobIds in the analytics answers open where the explorer links them).
- `query-filters.test.ts`: every named query with the filter bar's presets, compare window, device, new / returning,
  variant, country and branch; the 7d and 30d windows must have data. Also checks the fast JSON path against the macro.
- `wasm.test.ts`: every named query on DuckDB-WASM (the package's Node build, the same .wasm) against native DuckDB.
  A few queries (timeline, player-graph, flow, confusion, recording-replay, quit-autopsy, events, player-events) order
  rows with equal timestamps differently on the two engines (native DuckDB even varies between runs): for those the
  test checks the same data and answer keys, not the exact rows.
- `notify-rows.test.ts`: the notification analytics tabs have data, game-server notify rows sit inside real sessions,
  backend rows look like the backend's, and no row carries a UserId.

## Rebuilding the data pack

```sh
bun demo/scripts/build-pack.ts --source <copy of a backend's data/> --out <pack dir> \
  --place <real place id> --universe <real universe id> [--from YYYY-MM-DD] [--percent 25]
```

It samples players, re-keys every pid / sid / JobId (and ids inside props) with a one-time salt, swaps the place and
universe ids for fake ones, blanks launch data, strips player names from error messages and from the recordings' strings (the tutorial NPC is named after the player; `scripts/scrub.ts`, applied again by `demo:data`), and refuses to write when any
original id survives. Copy the maps export (`maps/index.json` as `maps-index.json`, and the `<sha256>.ttmp` files) next
to the output after replacing the ids and names in the index, then `bun run demo:data --force`.
