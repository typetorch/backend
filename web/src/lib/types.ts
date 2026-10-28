import type { PerfCompareResult, PerfSeriesResult } from "./perf";

/**
 * The analytics server's answers, as the explorer reads them. They mirror `analytics/src/queries/*.ts` and
 * `analytics/src/fleet/*` (a separate repo: copied, not imported). Keep them in step when a query changes.
 */

export type Device = "desktop" | "phone" | "tablet" | "console" | "vr" | "unknown";
export const DEVICES: Device[] = ["desktop", "phone", "tablet", "console", "vr", "unknown"];

/** What every query accepts (`analytics/src/sql/filters.ts`). */
export interface Filters {
	from?: string;
	to?: string;
	art?: string | string[];
	branch?: string | string[];
	channel?: string | string[];
	dev?: Device | Device[];
	players?: "new" | "returning";
	variant?: { experiment: string; variant: string | string[] };
	sexp?: string | string[];
	place?: number;
}

export interface Rate {
	rate: number;
	count: number;
	of: number;
}

export interface OverviewDay {
	date: string;
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeHours: number;
}

/** One step of a window of a day or less (1 min, 5 min or 1 h). */
export interface OverviewBucket {
	t: number;
	time: string;
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeHours: number;
}

export interface OverviewResult {
	from: string;
	to: string;
	players: number;
	newPlayers: number;
	returningPlayers: number;
	sessions: number;
	events: number;
	playtimeHours: number;
	avgSessionMinutes: number;
	playtimePerPlayerMinutes: number;
	days: OverviewDay[];
	/** The chart step for the window (a day for windows over a day; older backends leave it out). */
	bucketMs?: number;
	/** Windows of a day or less: the same numbers per step, by the time a session started (empty steps left out). */
	buckets?: OverviewBucket[];
}

export interface RobloxResult {
	from: string;
	to: string;
	players: number;
	firstPlayBounce: Rate & { seconds: number };
	qualifiedPlays: Rate & { minutes: number };
	d1Retention: Rate;
	d7Retention: Rate;
	playtimePerUserMinutes: number;
	playDaysPerUser: number;
	payerConversion: Rate;
	robuxPerUser: number;
	robuxPerPayer: number;
	purchases: number;
}

export interface RetentionCohort {
	date: string;
	size: number;
	kept: Record<string, number | null>;
	keptPlayers: Record<string, number | null>;
}

export interface RetentionResult {
	from: string;
	to: string;
	days: number[];
	cohorts: RetentionCohort[];
	average: Record<string, number | null>;
}

export interface FunnelStep {
	step: number;
	label: string | null;
	reached: number;
	ofStart: number;
	fromPrevious: number;
	logged: number;
	medianSecondsFromStart: number | null;
}

export type FunnelResult =
	| { funnel: null; funnels: { name: string; players: number; events: number }[] }
	| { funnel: string; players: number; steps: FunnelStep[]; biggestDrop: { step: number; lost: number; share: number } | null };

/** The `playtime-funnel` query: players whose playtime reached each threshold (total in the range, or first session). */
export interface PlaytimeFunnelResult {
	measure: "total" | "first";
	players: number;
	sessionCapHours: number;
	steps: { seconds: number; label: string; reached: number; ofTotal: number; fromPrevious: number }[];
	biggestDrop: { seconds: number; lost: number; share: number } | null;
}

/** One player at a funnel step (the `funnel-players` query). */
export interface FunnelPlayer {
	pid: string;
	/** Logged funnels: when they reached the step (reached) or their last step (dropped). Null for playtime funnels. */
	at: string | null;
	/** Logged funnels: their furthest step and when they first logged it. */
	lastStep: number | null;
	lastStepAt: string | null;
	/** Playtime funnels: their playtime, seconds. */
	playtimeSeconds?: number;
	lastAt: string | null;
	uid?: number;
	name?: string;
	displayName?: string;
}

/** The `funnel-players` query: the players who reached (or dropped off at) one step; at most 200. */
export interface FunnelPlayers {
	funnel: string | null;
	measure: "total" | "first" | null;
	step: number;
	mode: "reached" | "dropped";
	total: number;
	more: number;
	players: FunnelPlayer[];
}

/** The `funnel-progress` query: how far given players got in each funnel. */
export interface FunnelProgress {
	pid: string;
	funnel: string;
	step: number;
	label: string | null;
	/** The furthest step's place among the funnel's steps (1-based), of how many. */
	reached: number;
	of: number;
	/** reached / of, 0-1. */
	share: number;
	/** When they first logged that furthest step (ISO). */
	reachedAt?: string;
}

export interface FunnelProgressResult {
	funnels: { name: string; steps: { step: number; label: string | null }[] }[];
	progress: FunnelProgress[];
}

export interface TimelineEvent {
	time: string;
	t: number;
	kind: string;
	name: string;
	sid: string;
	state: string | null;
	art: string;
	src: string | null;
	props: unknown;
}

export interface TimelineSession {
	sid: string;
	start: string;
	end: string;
	minutes: number;
	events: number;
	firstSession: boolean;
	art: string;
	dev: string | null;
}

export interface TimelineResult {
	pid: string;
	/** The UserId, when the server knows it. */
	uid?: number;
	sessions: TimelineSession[];
	events: TimelineEvent[];
	truncated: boolean;
}

export interface GraphNode {
	id: string;
	visits: number;
	players?: number;
	/** Total time in this state before moving on, ms (one session: all the time in it). */
	dwellMs: number;
	/** Top 5 custom / purchase / currency event names logged in this state. */
	events?: { kind: string; name: string; count: number }[];
	/** Funnel steps logged in this state. */
	steps?: { funnel: string; step: string; index: number | null; count: number; players: number }[];
}

/** One visit of a one-session graph, in order. */
export interface PathStep {
	step: number;
	state: string;
	at: string;
	ms: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	count: number;
	players?: number;
	dwellMs: number;
	share: number;
}

export interface GraphData {
	kind: "player" | "flow";
	facet: string;
	pid?: string;
	/** One session's graph. */
	sid?: string;
	/** Key moments are nodes too (ids starting with "@"). */
	moments?: boolean;
	nodes: GraphNode[];
	edges: GraphEdge[];
	hiddenEdges: number;
	/** One session: the visits in order; ended = it's over (the path ends in left). */
	path?: PathStep[];
	ended?: boolean;
}

export type Facet = "all" | "zone" | "screen" | "activity";
export const FACETS: Facet[] = ["all", "zone", "screen", "activity"];

export interface VariantStats {
	variant: string;
	players: number;
	returned: { rate: number; count: number };
	payers: { rate: number; count: number };
	playtimeMinutes: number;
	robuxPerPlayer: number;
	sessionsPerPlayer: number;
}

export interface Comparison {
	variant: string;
	metric: "returned" | "payers" | "playtime" | "robux" | "sessions";
	control: number;
	value: number;
	diff: number;
	lift: number | null;
	sure: number;
	method: string;
	words: string;
}

export type ExperimentResult =
	| { experiment: null; experiments: { experiment: string; variant: string; players: number; forced?: number; variantCount?: number | null }[] }
	| {
			experiment: string;
			scope: "player" | "server";
			control: string | null;
			variants: VariantStats[];
			comparisons: Comparison[];
			mixedPlayers: number;
	  };

/** One experiment's override, as the server's settings file has it (GET /v1/experiments). */
export interface ExperimentOverride {
	active?: boolean;
	/** A weight per variant, in the game's order (the first is the control). */
	weights?: number[];
	/** Forced for everyone. */
	variant?: string;
}

export interface ExperimentOverrides {
	/** settings-file: from data/settings.json; none: no file or no experiments in it; unreadable: the file does not parse. */
	source: "settings-file" | "none" | "unreadable";
	experiments: Record<string, ExperimentOverride>;
}

/** One player in one variant of an experiment (GET /v1/experiments/<key>/players). */
export interface ExperimentPlayer {
	pid: string;
	variant: string;
	/** From the window's experiment rows: random (hash of the pid), forced (by the settings), or unknown (assigned before the window). */
	how: "random" | "forced" | "unknown";
	assignedAt: string | null;
	firstAt: string;
	lastAt: string;
	events: number;
	/** Seen in more than one variant in the window (one row per variant). */
	mixed: boolean;
	uid?: number;
	name?: string;
	displayName?: string;
}

export interface ExperimentPlayers {
	experiment: string;
	variant: string | null;
	variants: { variant: string; players: number; forced: number }[];
	total: number;
	more: number;
	players: ExperimentPlayer[];
}

export interface ConfusionResult {
	firstSessions: number;
	players: number;
	earlyLeave: { zone: string; sessions: number; early: number; share: number }[];
	screenLoops: { screen: string; sessions: number; loopSessions: number; share: number; opens: number }[];
	backAndForth: { a: string; b: string; sessions: number; flagged: number; share: number }[];
	recordings: {
		available: boolean;
		reason?: string;
		sessions?: number;
		failedSessions?: number;
		idle?: { zone: string; count: number; avgSeconds: number }[];
		cameraSpin?: { zone: string; count: number }[];
		repeatedClicks?: { button: string; count: number; avgPresses: number }[];
	};
}

export interface TopEventsResult {
	events: { kind: string; name: string; count: number; players: number }[];
}

export interface PlayerSummary {
	pid: string;
	firstSeen: string;
	lastSeen: string;
	sessions: number;
	events: number;
	playtimeMinutes: number;
	/** Robux spent in the range (server-sent purchase rows, each once); 0 for none. Older backends leave it out. */
	robux?: number;
	newInRange: boolean;
	/** The UserId, when the server knows it (identity rows). */
	uid?: number;
}

export interface PlayersResult {
	players: PlayerSummary[];
}

/** One bucket of a player's numbers (a UTC day; a minute, 5 minutes or an hour for windows up to a day); sessions count where they start. */
export interface PlayerBucket {
	start: string;
	sessions: number;
	minutes: number;
	robux: number;
	purchases: number;
}

export interface PlayerSessionRow {
	sid: string;
	start: string;
	end: string;
	minutes: number;
	events: number;
	firstSession: boolean;
	dev: string | null;
	art: string;
}

export interface PlayerPurchase {
	time: string;
	t: number;
	/** The purchase kind (`product`, `gamepass`, ...). */
	kind: string;
	product: string | null;
	robux: number | null;
	where: string | null;
	sid: string | null;
}

/** The `player-stats` query: one player's spending, playtime and sessions over the filter range. */
export interface PlayerStatsResult {
	pid: string;
	uid?: number;
	window: { from: string; to: string; bucket: "minute" | "5 minutes" | "hour" | "day"; bucketMs: number; days: number; clamped: boolean };
	totals: {
		sessions: number;
		events: number;
		playtimeMinutes: number;
		avgSessionMinutes: number;
		medianSessionMinutes: number;
		playtimePerDayMinutes: number;
		activeDays: number;
		robux: number;
		purchases: number;
		firstSeen: string | null;
		lastSeen: string | null;
	};
	series: PlayerBucket[];
	sessions: PlayerSessionRow[];
	sessionsTruncated: boolean;
	purchases: PlayerPurchase[];
	purchasesTruncated: boolean;
}

/** GET /v1/place: the game's name, live players and icon (asked from Roblox by the backend, cached 60 s). */
export type PlaceCardInfo =
	| { configured: false }
	| {
			configured: true;
			/** ok, partial (one of the two Roblox APIs answered), unavailable (Roblox didn't answer). */
			roblox: "ok" | "partial" | "unavailable";
			cached?: boolean;
			placeId: number | null;
			universeId: number | null;
			name: string | null;
			playing: number | null;
			/** An https icon on *.rbxcdn.com. */
			icon: string | null;
			/** https://www.roblox.com/games/<placeId>, or null while the PlaceId isn't known. */
			url: string | null;
	  };

/** GET /v1/identity/<pid>/profile: the UserId and its Roblox names and headshot (looked up by the backend). */
export interface PlayerProfile {
	pid: string;
	linked: boolean;
	uid?: number;
	/** ok, partial (one of the two Roblox APIs answered), not-found, unavailable (Roblox didn't answer). */
	roblox?: "ok" | "partial" | "not-found" | "unavailable";
	cached?: boolean;
	name?: string | null;
	displayName?: string | null;
	avatar?: string | null;
}

export interface ValueCount {
	value: string;
	events: number;
	lastSeen: string;
}

export interface ValuesResult {
	branch: ValueCount[];
	art: ValueCount[];
	channel: ValueCount[];
	dev: ValueCount[];
}

export interface EventRow {
	time: string;
	t: number;
	kind: string;
	name: string;
	pid: string | null;
	sid: string | null;
	job: string;
	state: string | null;
	art: string;
	branch: string | null;
	dev: string | null;
	src: string | null;
	props: unknown;
}

export interface EventsResult {
	events: EventRow[];
}

/** The Roblox page's numbers, as Creator Hub defines them (README "Roblox parity"). */
export interface BenchmarkPeriod {
	/** First day 00:00 UTC, and the end of the last full day (exclusive). */
	from: string;
	to: string;
	players: number;
	newUsers: number;
	dau: number;
	/** Distinct players in the 30 UTC days ending on the period's last day. */
	mau: number;
	sessions: number;
	/** Per day playtime / sessions, the mean of the days. */
	avgSessionMinutes: number | null;
	/** Per day playtime / DAU, the mean of the days. */
	avgPlaytimeMinutes: number | null;
	d1Retention: Rate & { cohortFrom: string; cohortTo: string };
	d7Retention: Rate & { cohortFrom: string; cohortTo: string };
	d30Retention: Rate & { cohortFrom: string; cohortTo: string };
	/** rate = the mean of daily paying DAU / DAU; count / of = payer-days / player-days. */
	payerConversion: Rate;
	arppu: number | null;
	arpdau: number | null;
	/** Robux spent (prices); revenue = robux x creatorShare. */
	robux: number;
	revenue: number;
	playThrough: Rate & { minutes: number };
}

export interface BenchmarksResult {
	days: number;
	creatorShare: number;
	current: BenchmarkPeriod;
	previous: BenchmarkPeriod;
}

export interface RealtimeWindow {
	sessions: number;
	avgSessionMinutes: number | null;
	clientErrors: number;
	errorsPerSession: number | null;
	clientFps: number | null;
	serverMemoryMb: number | null;
}

export interface RealtimeResult {
	hours: number;
	current: RealtimeWindow;
	previous: RealtimeWindow;
	ccu: { now: number; series: { hour: string; avg: number; peak: number }[]; currentAvg: number; previousAvg: number; currentPeak: number; previousPeak: number };
}

export interface TrendValues {
	newUsers: number;
	dau: number;
	sessionMinutes: number | null;
	playtimeMinutes: number | null;
	robux: number;
	revenue: number;
	d1: number | null;
}

export interface TrendsResult {
	from: string;
	to: string;
	window: number;
	creatorShare: number;
	sources: string[];
	days: { date: string; total: TrendValues; bySource: Record<string, TrendValues> }[];
}

export interface EconomyDay {
	date: string;
	earned: number;
	spent: number;
	net: number;
	/** The net added up from the range start to the end of this day (games log flows, not balances). */
	balance: number;
	players: number;
	activePlayers: number;
	earnedPerActive: number;
}

export interface EconomyFlow {
	reason: string;
	amount: number;
	rows: number;
	players: number;
	share: number;
}

export interface EconomyResult {
	from: string;
	to: string;
	currency: string | null;
	currencies: { currency: string; rows: number; earned: number; spent: number; players: number }[];
	totals: {
		earned: number;
		spent: number;
		net: number;
		rows: number;
		players: number;
		earners: number;
		spenders: number;
		activePlayers: number;
		earnedPerActive: number;
		spentPerActive: number;
		avgNetPerPlayer: number;
		medianNetPerPlayer: number;
		sinkRatio: number;
	};
	days: EconomyDay[];
	sources: EconomyFlow[];
	sinks: EconomyFlow[];
}

export interface MonetizationDay {
	date: string;
	robux: number;
	purchases: number;
	payers: number;
	activePlayers: number;
	arpdau: number;
}

export interface MonetizationProduct {
	kind: string;
	product: string | null;
	robux: number;
	purchases: number;
	payers: number;
	share: number;
}

export interface MonetizationResult {
	from: string;
	to: string;
	totals: {
		robux: number;
		purchases: number;
		payers: number;
		activePlayers: number;
		playerDays: number;
		payerConversion: number;
		arppu: number;
		arpdau: number;
		arpu: number;
		repeatPayers: number;
		repeatRate: number;
		purchasesPerPayer: number;
	};
	days: MonetizationDay[];
	products: MonetizationProduct[];
	firstPurchase: {
		newPlayers: number;
		payers: number;
		conversion: number;
		medianMinutes: number | null;
		avgMinutes: number | null;
		bySession: { session: string; payers: number; share: number }[];
	};
}

/** Every named query and its result. */
export interface QueryResults {
	overview: OverviewResult;
	roblox: RobloxResult;
	retention: RetentionResult;
	funnel: FunnelResult;
	"funnel-progress": FunnelProgressResult;
	"playtime-funnel": PlaytimeFunnelResult;
	"funnel-players": FunnelPlayers;
	timeline: TimelineResult;
	"player-graph": GraphData;
	"player-stats": PlayerStatsResult;
	flow: GraphData;
	experiment: ExperimentResult;
	"experiment-players": ExperimentPlayers;
	confusion: ConfusionResult;
	"top-events": TopEventsResult;
	servers: unknown;
	deployReport: unknown;
	players: PlayersResult;
	values: ValuesResult;
	events: EventsResult;
	benchmarks: BenchmarksResult;
	realtime: RealtimeResult;
	trends: TrendsResult;
	"perf-client": PerfSeriesResult;
	"perf-server": PerfSeriesResult;
	"perf-compare": PerfCompareResult;
	economy: EconomyResult;
	monetization: MonetizationResult;
}

export type QueryName = keyof QueryResults;

export interface QueryInfo {
	name: string;
	summary: string;
	defaultDays: number;
}

// Fleet (analytics/src/fleet) -------------------------------------------------------------------------------------------

export interface FleetServer {
	job: string;
	serverType: string | null;
	branch: string | null;
	channel?: string | null;
	artifact: string | null;
	players: number | null;
	maxPlayers: number | null;
	startedAt: string | null;
	lastWrite?: string | null;
	lastSeen?: string | null;
	ageSeconds?: number;
	appliedSeq: number | null;
	generation: number | null;
	health: string | null;
	lastError: string | null;
	kernel: string | null;
	experiment: boolean | null;
	placeId?: number | null;
	/** The place version the server runs (heartbeat `pv`); null or missing from older kernels. */
	placeVersion?: number | null;
	serverVersion?: number | null;
	/** Kernel 0.4.0: the heartbeat's budget summary `bu` (requests per minute next to Roblox's limits; fleet API only). */
	budget?: ServerBudget | null;
	/**
	 * Kernel 0.4.2 (fleet API only; null or missing when unknown, e.g. an older kernel or backend): server TPS averaged
	 * since the previous heartbeat and its slowest second, physics FPS, total memory and the Lua heap in MB.
	 */
	tps?: number | null;
	tpsMin?: number | null;
	physFps?: number | null;
	memMb?: number | null;
	luaMb?: number | null;
	/** Why the server needs a look (backend fleet/health.ts); empty or missing when nothing tripped. */
	reasons?: HealthReason[];
}

/** One signal behind a server's health: its reading and the line it crossed. */
export interface HealthReason {
	signal: "health" | "tps" | "memory" | "heartbeat";
	label: string;
	value: number | string;
	threshold: number | string;
	unit: string | null;
	op: "<" | ">" | "!=";
}

/** Kernel 0.4.0 `bu`: ds DataStore (r read, w write, lr/lw limits, br/bw budget left), ms MemoryStore units, h HTTP, mg MessagingService, by per caller, mem MB. */
export interface ServerBudget {
	p?: number;
	ds?: { r?: number; w?: number; l?: number; x?: number; lr?: number; lw?: number; br?: number; bw?: number };
	ms?: { u?: number; l?: number };
	h?: { r?: number; l?: number };
	mg?: { p?: number; lp?: number; s?: number; ls?: number };
	by?: Partial<Record<"k" | "d" | "a" | "g" | "f", number>>;
	mem?: { t?: number; h?: number };
}

/**
 * Plans/25: what the server page knows about one JobId (any age). "gone": the servers row is gone (kept 30 days) but
 * alerts, deploy reports, debug bundles or metrics still name the JobId.
 */
export type ServerState = "live" | "closed" | "lost" | "gone" | "unknown";

/** Plans/25: the remote debug session of one server, as the backend sees it. */
export interface DebugStatus {
	watched: boolean;
	watchedUntil?: number;
	/** The server polled in the last 15 s. */
	connected: boolean;
	lastPollAt?: number;
}

/** POST /v1/fleet/servers/<job>/watch. */
export interface WatchReply extends DebugStatus {
	job: string;
	/**
	 * Plans/25 "Instant wake": a wake message went out to this server lately (the backend has an Open Cloud messaging key),
	 * so it should poll within seconds. Absent (backends before it) or false: it polls at its next heartbeat.
	 */
	wake?: boolean;
}

/**
 * GET /v1/fleet/servers/<job>: its servers row of any age (rows go 30 days after a server is gone), its state, the debug
 * session and its history (missing from backends before debug bundles).
 */
export interface FleetServerDetail {
	server: (FleetServer & { closedAt?: string | null; lostAt?: string | null; firstSeen?: string }) | null;
	state: ServerState;
	debug: DebugStatus;
	history?: ServerHistory;
}

/** What the fleet still holds about a JobId, newest first. */
export interface ServerHistory {
	alerts: FleetAlert[];
	reports: FleetServerReport[];
	bundles: BundleSummary[];
	/** Generation starts from its bundles' deploy history. */
	swaps: BundleSwap[];
	/** The time range its metrics cover (raw points and 5-minute rollups), unix ms. */
	metrics: { from: number | null; to: number | null };
}

/** One deploy report of one server. */
export interface FleetServerReport {
	seq: number;
	branch: string | null;
	artifact: string | null;
	job: string;
	result: string;
	error: string | null;
	seconds: number | null;
	at: number;
	generation?: number | null;
	kernel?: string | null;
	players?: number | null;
}

/** Kernel 0.5.3: a debug bundle's summary (GET /v1/fleet/servers/<job>/bundles). */
export interface BundleSummary {
	id: string;
	job: string;
	/** What made the kernel send it: an alert code, start_failed, health_rollback, players_moved, closing, manual. */
	code: string;
	level: "critical" | "warning" | "info";
	message: string;
	closing: boolean;
	at: number;
	time: string;
	kernel: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	players: number;
	size: number;
	stage?: string | null;
	error?: string | null;
}

export interface BundleSwap {
	at: number;
	name: string | null;
	artifact: string | null;
	branch: string | null;
	reason: string | null;
	loadSeconds: number | null;
	swapSeconds: number | null;
	bundle: string;
}

/**
 * GET /v1/fleet/bundles/<id>: the summary and the posted JSON. Every section is the kernel's, untrusted: the page shows
 * it as text only. `playerLogs` is missing for the read-only role (`playerLogsHidden`).
 */
export interface DebugBundle extends BundleSummary {
	body: BundleBody;
	playerLogsHidden?: boolean;
}

export interface BundleBody {
	/** `triggers`: every trigger that joined this bundle (those within 3 s of the first). */
	failure?: { stage?: unknown; error?: unknown; report?: unknown; triggers?: unknown } | null;
	server?: Record<string, unknown> | null;
	deploy?: Record<string, unknown> | null;
	fallback?: Record<string, unknown> | null;
	alerts?: unknown[] | null;
	players?: unknown[] | null;
	serverLog?: unknown[] | null;
	playerLogs?: Record<string, unknown> | null;
	[key: string]: unknown;
}

/** GET /v1/fleet/servers?gone=1: a closed or lost server. */
export type GoneServer = FleetServer & { closedAt: string | null; lostAt: string | null; state: "closed" | "lost"; firstSeen?: string };

/** GET /v1/fleet/debug/audit: one queued command (never its answer, never a player's UserId). */
export interface DebugAuditEntry {
	at: number;
	/** "roblox:<UserId>" (an owner) or "token". */
	who: string;
	ip: string;
	op: string;
	job: string;
	/** Sizes and plain numbers only. */
	args: string;
	id: string;
}

/** The read-only remote debug ops (v1). */
export type RemoteOp = "status" | "builds" | "budget" | "logs" | "players" | "player.logs" | "errors" | "modules" | "state" | "assets" | "network" | "dex.children" | "dex.props";

/** A queued command and, once answered, its result (kept 3 minutes on the backend, in memory only). */
export interface RemoteCommand {
	id: string;
	op: string;
	state: "queued" | "sent" | "done" | "failed" | "expired";
	createdAt: number;
	expiresAt: number;
	sentAt?: number;
	doneAt?: number;
	ms?: number;
	result?: unknown;
	error?: string;
	/** Secrets the kernel replaced with <redacted> in the answer. */
	redacted?: number;
}

// Remote debug answers (plans/25). The shapes the kernel (RemoteDebug.luau, Kernel.server.luau ops) and the framework
// (src/devtools/remote-debug.ts, the dev menu's readers) send; copied, not imported. Every field is optional where an
// older kernel or framework may leave it out: the page shows what is there.

/** A log line: `t` = unix seconds. Server ring (op logs) and a client's ring (op player.logs). */
export interface RemoteLogEntry {
	i: number;
	t: number;
	kind: "output" | "info" | "warning" | "error";
	text: string;
}

/** op logs: the newest `limit` entries after `since`, oldest first; `last` = the newest index (for "Fetch newer"). */
export interface RemoteLogs {
	entries: RemoteLogEntry[];
	last: number;
}

/** op player.logs. */
export interface RemotePlayerLogs {
	userId: number;
	name: string;
	entries: RemoteLogEntry[];
}

/** op players: one player in the server. */
export interface RemotePlayer {
	userId: number;
	name: string;
	displayName?: string;
	/** Dev by the kernel's access rule (and why, and the role). */
	dev?: boolean;
	reason?: string;
	role?: string;
	accountAge?: number;
	pingMs?: number;
	/** How this client's generation start went (the kernel's client report). */
	client?: { generation?: string; ok?: boolean; error?: string; at?: number; [key: string]: unknown };
}

export interface RemotePlayers {
	players: RemotePlayer[];
	max?: number;
}

/** op status: the kernel's status() (Server > Status) and the heartbeat's fleet status. Read loosely. */
export interface RemoteStatus {
	status?: {
		jobId?: string;
		placeId?: number;
		placeVersion?: number;
		serverType?: string;
		branch?: string;
		channel?: string;
		rules?: string;
		pinned?: boolean;
		uptime?: number;
		generation?: { name?: string; number?: number; uptime?: number; artifact?: { id?: string; [key: string]: unknown } };
		players?: number;
		maxPlayers?: number;
		kernelVersion?: string;
		kernelBuild?: string;
		memoryMb?: number;
		luaHeapKb?: number;
		appliedSeq?: number;
		signedOnly?: boolean;
		health?: { state?: string; [key: string]: unknown };
		remoteDebug?: { state?: string; polls?: number; commands?: number; answered?: number; refused?: number; redacted?: number; lastError?: string };
		[key: string]: unknown;
	};
	fleet?: Record<string, unknown>;
}

/** op builds: Server > Branch. Branch heads, the known builds (one DataStore read) and this server's last deploy reports. */
export interface RemoteBuilds {
	branches?: { name: string; channel?: string; artifactId?: string; assetId?: number; commit?: string; seq?: number; deployedAt?: number; by?: unknown }[];
	artifacts?: {
		branch?: string;
		artifactId?: string;
		assetId?: number;
		seq?: number;
		commit?: string;
		/** Unix seconds (the kernel's deployment entries call it `at`). */
		at?: number;
		channel?: string;
		live?: boolean;
		running?: boolean;
		verified?: unknown;
	}[];
	artifactsError?: string;
	/** The fleet report format: s seq, b branch, a artifact, r result, e error, d seconds, t unix s, g generation, k kernel. */
	reports?: { s?: number; b?: string; a?: string; r?: string; e?: string; d?: number; t?: number; g?: number; k?: string }[];
}

/** op budget: Server > Budget (kernel 0.4.0 api:budget()). */
export interface RemoteBudget {
	missing?: boolean;
	players?: number;
	window?: number;
	kinds?: Record<string, { rows?: { name: string; used: number; limit: number; left?: number }[]; callers?: Record<string, number> }>;
	detail?: { caller: string; kind: string; op: string; perMinute: number; total: number }[];
	memory?: { total?: number; luaHeap?: number; heapKb?: number; tags?: { name: string; mb: number }[] };
	generations?: { name: string; modules: number; running: boolean }[];
	refused?: number;
}

/** op errors: the error reports' counters and the busiest templates (never a raw message). */
export interface RemoteErrors {
	enabled?: boolean;
	missing?: boolean;
	kinds?: number;
	waiting?: number;
	seen?: { server: number; client: number };
	sent?: number;
	requests?: number;
	failed?: number;
	rejected?: number;
	dropped?: Record<string, number>;
	lastError?: string;
	lastOkAt?: number;
	top?: { fp: string; template: string; total: number; realm: "server" | "client" }[];
}

/** op modules: the running modules and the persist store summary (Modules tab). */
export interface RemoteModules {
	modules?: { name: string; dependencies?: string[]; loadOrder?: number; initMs?: number }[];
	state?: {
		modules?: { name: string; dependencies?: string[]; loadOrder?: number; initMs?: number; hooks?: string[] }[];
		persist?: { key: string; kind: string; entries: number; preview: string }[];
	};
}

/** One query of op state (Modules > State). root "" = the list of roots; path = segments below the root. */
export interface StateQuery {
	root: string;
	path: string[];
	page?: number;
	filter?: string;
	keep?: string[];
}

export interface StateEntry {
	key: string;
	/** The path segment that opens it (for a root: its token). */
	seg: string;
	type: string;
	preview: string;
	expandable: boolean;
	cycle?: boolean;
}

/** One answer of op state (one per query, in order). */
export interface StateReply {
	type: string;
	preview: string;
	size: number;
	capped?: boolean;
	truncated?: boolean;
	matched: number;
	entries: StateEntry[];
	page: number;
	pages: number;
	hasMore: boolean;
	missing?: boolean;
	tooDeep?: boolean;
}

/** op assets: the last hot-asset sync (Modules > Assets). */
export interface RemoteAssets {
	manifest?: "none" | "ok" | "invalid" | "unread";
	from?: string;
	errors?: string[];
	running?: boolean;
	ms?: number;
	timedOut?: boolean;
	entries?: { key: string; id: number; wanted?: number; n?: number; version?: number; live: boolean; source?: string; error?: string; ms?: number }[];
	unmanaged?: string[];
}

/** op network: per-remote counters. */
export interface RemoteNetwork {
	remotes: { path: string; inbound: number; outbound: number; rejected: number; errors: number }[];
	supported: boolean;
}

/** op dex.children: one page per node asked. `parent` 0 = game. */
export interface DexRow {
	id: number;
	name: string;
	className: string;
	childCount: number;
	parent: number;
}

export interface DexChildrenPage {
	id: number;
	rows: DexRow[];
	total: number;
	offset: number;
	/** The id is no longer valid (destroyed, or the server forgot it). */
	gone?: boolean;
}

/** op dex.props: one instance's properties, attributes and tags (read-only). */
export interface DexPropRow {
	name: string;
	category: string;
	kind: string;
	text: string;
	readOnly?: boolean;
	deprecated?: boolean;
	enumType?: string;
	/** Instance values: the referenced instance's id. */
	ref?: number;
}

export interface DexProps {
	id: number;
	name: string;
	className: string;
	path: string;
	props: DexPropRow[];
	attrs: DexPropRow[];
	tags: string[];
}

export interface FleetServers {
	servers: FleetServer[];
	players: number;
	byArtifact: { artifact: string; servers: number; players: number }[];
	byHealth: Record<string, number>;
}

export interface FleetAlert {
	id: number;
	at: number;
	level: "critical" | "warning" | "info";
	code: string;
	message: string;
	branch?: string | null;
	artifact?: string | null;
	job?: string | null;
	seq?: number | null;
	acked: boolean;
	source?: "game" | "cli" | "server";
	createdAt?: string;
	details?: Record<string, unknown> | null;
}

export interface FleetReportResult {
	result: string;
	servers: number;
	players: number;
	medianSeconds: number | null;
	maxSeconds: number | null;
}

export interface FleetReports {
	seq: number | null;
	branch: string | null;
	artifact: string | null;
	startedAt: string | null;
	firstReport?: string | null;
	lastReport?: string | null;
	reported: number;
	results: FleetReportResult[];
	errors: { error: string; servers: number; exampleJob: string }[];
	behind: FleetServer[];
	stuck: string[];
	reports?: { seq: number; job: string; result: string; error: string | null; seconds: number | null; at: number; kernel?: string | null }[];
}

export interface Health {
	ok: boolean;
	runtime?: string;
	uptimeSeconds?: number;
	rssMb?: number;
	analytics?: { loaderLagSeconds: number; live: { events: number; recordings: number }; loadedRows: number };
	fleet?: { servers: number; alerts: number; unacked: number; streams: number };
}

/** pid <-> UserId on the analytics server (identity rows). */
export interface Identity {
	pid: string;
	uid: number;
	firstSeen: string;
	lastSeen: string;
}

export interface BackfillResult {
	scanned: number;
	added: number;
	known: number;
	nextPageToken?: string;
}

export interface SqlResult {
	columns: { name: string; type: string }[];
	rows: unknown[][];
	truncated: boolean;
	ms: number;
}

export interface StoragePart {
	key: string;
	label: string;
	bytes: number;
	files: number;
	oldest?: string;
	newest?: string;
	days?: number;
}

export interface StorageReport {
	at: string;
	cacheSeconds: number;
	totalBytes: number;
	parts: StoragePart[];
	rows: { liveEvents: number; liveRecordings: number; parquetEvents: number; parquetRecordings: number } | null;
	growth: { todayBytes: number; avgPerDayBytes: number | null; days: { date: string; bytes: number }[] } | null;
	disk: DiskStatus | null;
}

/** The disk the data folder is on (GET /v1/storage, GET /v1/admin/backups): free space and the warning level. */
export interface DiskStatus {
	freeBytes: number;
	totalBytes: number;
	/** Free space as a percent of the disk. */
	freePercent: number;
	/** warning under warnFreePercent free, critical under criticalFreePercent (0 = that level is off). */
	level: "ok" | "warning" | "critical";
	warnFreePercent: number;
	criticalFreePercent: number;
	at: string;
}

// Sign-in (GET /v1/auth/check) -----------------------------------------------------------------------------------------

/** Who is signed in: the admin token, or a Roblox owner or viewer. */
export type AuthUser = { kind: "token" } | { kind: "roblox"; userId: number; name: string; displayName?: string; avatar?: string; login?: "typetorch.dev" };

/** "admin" reads and manages; "web" is read-only (a Roblox viewer); "game" is the API key (no explorer). */
export type AuthRole = "admin" | "web" | "game";

export interface AuthInfo {
	ok: true;
	role: AuthRole;
	/** "cookie" = an explorer session; "bearer" = a token in the request (the dev proxy adds one). */
	via: "bearer" | "cookie";
	user?: AuthUser;
	version?: string;
	/** The TypeTorch Dashboard (the typetorch.dev broker's origin), while Sign in with typetorch.dev is on. */
	dashboard?: string;
	/** An owner signed in with typetorch.dev on a browser that was never trusted: read-only until it is (never for viewers). */
	untrustedOwner?: boolean;
	/** With untrustedOwner: whether the admin token can trust this browser here (POST /auth/device); else the CLI's bless. */
	trustWithToken?: boolean;
}

/** Which logins the backend offers (the body of a 401 from the auth check). */
export interface LoginOptions {
	token: boolean;
	roblox: boolean;
	/** Sign in with typetorch.dev (on unless the backend sets TYPETORCH_CENTRAL_LOGIN=off). */
	typetorch?: boolean;
	/** The TypeTorch Dashboard (the typetorch.dev broker's origin), while Sign in with typetorch.dev is on. */
	dashboard?: string;
}

/** A browser blessed for full admin through typetorch.dev (GET /v1/admin/devices). */
export interface BlessedDevice {
	id: string;
	created: string;
	used: string;
	via: "admin token" | "signing key";
	agent?: string;
	/** This browser. */
	current?: boolean;
}

/** The Settings page's read-only line about Sign in with typetorch.dev (set in the environment only). */
export interface CentralLoginInfo {
	on: boolean;
	issuer?: string;
	fingerprint?: string;
	/** TYPETORCH_CENTRAL_LOGIN_UNBLESSED: admin (the default: no trusted browser needed), web (read-only) or refuse. */
	unblessed?: "admin" | "web" | "refuse";
	blessKeys?: number;
}

// Error logs (GET /v1/errors) ------------------------------------------------------------------------------------------

export interface ErrorWindow {
	from: string;
	to: string;
	bucketSeconds: number;
	buckets: number;
}

export interface ErrorKind {
	fp: string;
	template: string;
	/** First line of the sample stack. */
	topFrame: string | null;
	realm: "server" | "client" | string;
	count: number;
	players: number;
	firstAt: string;
	lastAt: string;
	total: number;
	/** Counts per bucket across the window, oldest first. */
	spark: number[];
}

export interface ErrorList {
	window: ErrorWindow;
	kinds: ErrorKind[];
	totals: { count: number; kinds: number; players: number };
	more: number;
	/** Builds (artifact ids) with errors in the window under the other filters, most recently seen first. */
	builds?: { build: string; n: number; lastAt: string }[];
}

/** GET /v1/errors/<fp>/players: who hit one kind in the window (at most 200), most occurrences first. */
export interface ErrorPlayer {
	pid: string;
	/** The UserId and Roblox names when the server knows them. */
	uid?: number;
	name?: string;
	displayName?: string;
	/** Occurrences in the reports (one minute of one server) that named the player: an upper bound when several players share a minute. */
	count: number;
	/** UTC days they hit it in the window. */
	days: number;
	firstAt: string;
	lastAt: string;
	realms: string[];
}

export interface ErrorPlayers {
	fp: string;
	window: { from: string; to: string };
	players: ErrorPlayer[];
	total: number;
	more: number;
	/** Occurrences in reports that named no player, per side. */
	withoutPlayer: { realm: string; count: number; firstAt: string; lastAt: string }[];
}

/** One error kind a player hit (GET /v1/players/<pid>/errors). */
export interface PlayerErrorKind {
	fp: string;
	template: string;
	topFrame: string | null;
	/** "server" and/or "client": where the reports naming the player came from. */
	realms: string[];
	/** Occurrences in the reports (one minute of one server) that named the player: an upper bound when several players share a minute. */
	count: number;
	days: number;
	firstAt: string;
	lastAt: string;
	/** All-time occurrences of the kind, every player. */
	total: number;
}

export interface PlayerErrors {
	pid: string;
	window: { from: string; to: string };
	errors: PlayerErrorKind[];
	total: number;
	more: number;
}

export interface ErrorDetail {
	kind: { fp: string; template: string; stack: string | null; realm: string; firstAt: string; lastAt: string; total: number };
	window: ErrorWindow;
	count: number;
	players: number;
	series: { t: string; n: number }[];
	byBuild: { build: string; n: number }[];
	byBranch: { branch: string; n: number }[];
	byRealm: { realm: string; n: number }[];
}

// Runtime settings (GET / PATCH /v1/admin/settings) --------------------------------------------------------------------

/** "dashboard" = saved on the Settings page; "env" = the environment; "default" = neither (the built-in default). */
export type SettingSource = "env" | "dashboard" | "default";
export type SettingKind = "secret" | "choice" | "levels" | "ips" | "users" | "switch" | "number" | "alertRules";

/** One threshold of a backend alert rule (or a general value: repeatMinutes, perHour). */
export interface AlertParamDef {
	key: string;
	env: string;
	label: string;
	unit: string;
	min: number;
	max: number;
	default: number;
	zero?: string;
}

export type AlertLevelName = "critical" | "warning" | "info";

export interface AlertRuleDef {
	id: string;
	code: string;
	env: string;
	group: "errors" | "players" | "ingest" | "backend" | "disk";
	label: string;
	help: string;
	level: AlertLevelName;
	on: boolean;
	needs: ("analytics" | "fleet")[];
	params: AlertParamDef[];
}

/** The backend alert rules' definitions (on the backendAlerts setting). */
export interface AlertRulesMeta {
	general: AlertParamDef[];
	rules: AlertRuleDef[];
}

/** The backendAlerts setting's value. */
export interface BackendAlertSettings {
	on: boolean;
	repeatMinutes: number;
	perHour: number;
	rules: Record<string, { on: boolean; level: AlertLevelName; params: Record<string, number> }>;
}

/** GET /v1/admin/alert-rules: what each rule saw on the last run. */
export interface AlertRulesStatus {
	on: boolean;
	tickSeconds: number;
	lastRunAt: string | null;
	lastRunMs: number | null;
	raised: number;
	deduped: number;
	throttled: number;
	failed: number;
	rules: { id: string; state: "off" | "unavailable" | "waiting" | "ok" | "firing"; note: string; lastRaisedAt: string | null }[];
}

interface SettingBase {
	key: string;
	/** The environment variable that gives the default. */
	env: string;
	group: "alerts" | "backendAlerts" | "access" | "limits" | "retention";
	label: string;
	help: string;
	kind: SettingKind;
	source: SettingSource;
	options?: string[];
	min?: number;
	max?: number;
	/** What 0 means, when 0 is allowed outside min..max ("forever"). */
	zero?: string;
	unit?: string;
	maxEntries?: number;
	/** alertRules: the rule definitions. */
	rules?: AlertRulesMeta;
}

/** A secret (the alert webhook): only whether it is set, never the value. */
export interface SecretSetting extends SettingBase {
	kind: "secret";
	set: boolean;
	/** Whether the environment has one (what "Reset to env" brings back). */
	fallbackSet: boolean;
}

export interface ValueSetting extends SettingBase {
	kind: Exclude<SettingKind, "secret">;
	value: unknown;
	/** The environment's value (or the default): what "Reset to env" brings back. */
	fallback: unknown;
	fallbackSource: "env" | "default";
}

export type RuntimeSetting = SecretSetting | ValueSetting;

export interface SettingsAuditEntry {
	at: string;
	who: string;
	via: "bearer" | "session";
	action: "change" | "test-alert";
	set?: string[];
	reset?: string[];
	result?: string;
}

export interface SettingsView {
	/** False when TYPETORCH_RUNTIME_SETTINGS=off: the environment applies and changes are refused. */
	enabled: boolean;
	settings: RuntimeSetting[];
	/** Environment variables that can't change here (change them on Coolify and redeploy). */
	envOnly: string[];
	audit: SettingsAuditEntry[];
	/** The caller's address as the server sees it, and whether this is a Roblox session. */
	you: { ip: string; roblox: boolean };
	robloxSignIn: boolean;
	/** Sign in with typetorch.dev (missing on backends before it). */
	centralLogin?: CentralLoginInfo;
	/** On a save: the keys that changed, and browser token sessions ended (token login turned off). */
	changed?: string[];
	sessionsEnded?: number;
}

export interface TestAlertResult {
	ok: boolean;
	status?: number;
	error?: string;
}

/** One entry of Roblox's game server logs (GET /v1/roblox/servers/<job>/logs; Open Cloud, beta, read loosely). */
export interface RobloxServerLog {
	time: string | null;
	/** As Roblox spells it (an error or a warning). */
	severity: string | null;
	message: string | null;
	/** Identical messages Roblox folded into this entry, when it says. */
	count: number | null;
	stack: string | null;
	placeVersion: number | null;
	/** Roblox's other plain fields. */
	fields: Record<string, string | number | boolean>;
}

export interface RobloxServerLogs {
	jobId: string;
	placeId: number;
	placeVersion: number;
	logs: RobloxServerLog[];
	nextPageToken: string | null;
	cached: boolean;
}

/** GET /v1/roblox/products: a game pass or developer product, asked from Roblox by the backend (cached 1 h). */
export interface RobloxProductInfo {
	type: "gamepass" | "product";
	id: number;
	/** ok: Roblox answered; not_found: Roblox has no such item; unavailable: Roblox didn't answer. */
	status: "ok" | "not_found" | "unavailable";
	name: string | null;
	/** Robux; null when Roblox gives none (e.g. off sale). */
	price: number | null;
	forSale: boolean | null;
	/** An https icon on Roblox's CDN (*.rbxcdn.com). */
	icon: string | null;
}

// Backend stats (GET /v1/admin/stats): the server's own metrics for the explorer's Backend stats page -------------------

export interface LatencySummary {
	count: number;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	max: number | null;
	avg: number | null;
}

export type RouteGroup = "ingest" | "errors-in" | "fleet-in" | "long-poll" | "stream" | "query" | "sql" | "rollups" | "errors" | "fleet" | "roblox" | "auth" | "admin" | "health" | "explorer" | "other";

/** One second (or one minute) of the server's work. */
export interface StatsBucket {
	at: number;
	requests: number;
	status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
	latency: LatencySummary;
	duckdb: { queries: number; latency: LatencySummary; rowsLoaded: number };
	sqlite: { reads: number; writes: number };
	ingest: { rows: number; bytes: number };
	memory: { rssMb: number; heapMb: number; heapTotalMb: number; externalMb: number } | null;
	cpuPercent: number | null;
	loopLagMs: number | null;
}

export interface RouteStats {
	group: RouteGroup;
	requests: number;
	errors: number;
	latency: LatencySummary;
}

export type StatsWindow = "1m" | "5m" | "15m" | "1h";

export interface BackendStats {
	now: number;
	uptimeSeconds: number;
	state: "ready" | "handover" | "failed" | "stopping";
	version: string;
	runtime: string;
	/** Per second, averaged over the last `seconds` whole seconds. */
	rates: { seconds: number; requests: number; errors: number; duckQueries: number; rowsIn: number; rowsLoaded: number; sqliteReads: number; sqliteWrites: number };
	sample: { rssMb: number; heapMb: number; heapTotalMb: number; externalMb: number; cpuPercent: number; loopLagMs: number } | null;
	latency: { recent: LatencySummary; window: LatencySummary };
	duckdb: { recent: LatencySummary; window: LatencySummary };
	totals: { requests: number; errors: number; duckQueries: number; rowsIn: number; bytesIn: number; rowsLoaded: number; sqliteReads: number; sqliteWrites: number; since: number };
	/** Per second, the last 2 minutes (a missing second: nothing happened). */
	seconds: StatsBucket[];
	/** Per minute, the last hour. */
	minutes: StatsBucket[];
	window: StatsWindow;
	routes: RouteStats[];
}

/** One entry of the audit log (GET /v1/admin/audit): who did what on the admin side. */
export interface AuditEntry {
	id: number;
	at: string;
	/** "admin token", "roblox user <id> (<name>)", "typetorch.dev user <id> (<name>)", "api key", "anonymous", "server (scheduled)". */
	actor: string;
	actorKind: "token" | "roblox" | "typetorch.dev" | "api-key" | "roblox-webhook" | "anonymous" | "system";
	userId: number | null;
	role: "admin" | "web" | "game" | "none";
	via: "bearer" | "cookie" | "signature" | "none";
	ip: string;
	/** sign-in, sign-out, settings.change, access.owners, alert.ack, erasure, backup.download, ... or "<METHOD> <route>". */
	action: string;
	outcome: "ok" | "failed" | "refused";
	status: number | null;
	/** What changed (never a secret: the server redacts them). */
	details: Record<string, unknown> | null;
}

export interface AuditPage {
	entries: AuditEntry[];
	/** The `before` of the next (older) page, or null. */
	next: number | null;
	keepDays: number;
	facets?: { actors: { actor: string; kind: string; entries: number }[]; actions: { action: string; entries: number }[] };
}

export interface AuditFilters {
	actor?: string;
	action?: string;
	outcome?: AuditEntry["outcome"];
	before?: number;
	limit?: number;
}

/** One local backup (GET /v1/admin/backups). */
export interface BackupInfo {
	name: string;
	createdAt: string | null;
	reason: "scheduled" | "manual" | "download" | null;
	bytes: number | null;
	files: number | null;
	duckdb: boolean | null;
}

export interface BackupsStatus {
	dir: string;
	keep: number;
	/** Hours between scheduled backups; 0 = none. */
	everyHours: number;
	running: boolean;
	last: { at: string; ok: boolean; reason: string; name?: string; error?: string } | null;
	next: string | null;
	backups: BackupInfo[];
	/** The data disk (null before the first check, or where it can't be measured). */
	disk: DiskStatus | null;
}
