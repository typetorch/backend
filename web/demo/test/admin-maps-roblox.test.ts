/** The admin, maps and Roblox mocks: every api.* function of the domain through the mock router, writes and privacy. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { decodeGeometry, LOBBY, mapsApi } from "@/lib/maps";
import { ENV_ONLY as BACKEND_ENV_ONLY, SETTINGS as BACKEND_SETTINGS } from "../../../src/server/runtime-settings.ts";
import { ENV_ONLY, resetAdminLimits, SETTING_DEFS } from "../mock/admin";
import { setClock } from "../mock/data";
import { EXPORT_MS } from "../mock/maps";
import { resetPackCache } from "../mock/pack";
import { PRODUCTS } from "../mock/roblox";
import { describeWithPack, installTestFetch, setupDemo, teardownDemo, TEST_NOW, testApi } from "./harness";

/** Moves the demo clock (the pack follows). */
function at(ms: number) {
	setClock(() => ms);
	resetPackCache();
}

/** Every answer stays off Roblox: no roblox.com link, no CDN image, no avatar. */
function expectPrivate(value: unknown) {
	const text = JSON.stringify(value);
	expect(text).not.toMatch(/roblox\.com\/users|rbxcdn\.com|thumbnails\.roblox|"avatar"|"icon":"http/);
}

describe("settings definitions", () => {
	it("match the backend's runtime settings (src/server/runtime-settings.ts)", () => {
		const pick = (d: object) => {
			const x = d as Record<string, unknown>;
			return { key: x.key, env: x.env, group: x.group, kind: x.kind, label: x.label, help: x.help, options: x.options ? [...(x.options as string[])] : undefined, min: x.min, max: x.max, unit: x.unit, zero: x.zero, maxEntries: x.maxEntries };
		};
		expect(SETTING_DEFS.map(pick)).toEqual(BACKEND_SETTINGS.map(pick));
		expect([...ENV_ONLY]).toEqual([...BACKEND_ENV_ONLY]);
	});
});

describeWithPack("admin, maps and Roblox mocks", () => {
	let restoreFetch: () => void = () => {};
	beforeAll(async () => {
		await setupDemo();
		resetAdminLimits();
		restoreFetch = installTestFetch();
	});
	afterAll(() => {
		restoreFetch();
		at(TEST_NOW);
		teardownDemo();
	});

	it("shows every runtime setting with its source, and the history", async () => {
		const api = testApi();
		const view = await api.settings();
		expect(view.enabled).toBe(true);
		expect(view.settings.length).toBe(SETTING_DEFS.length);
		const webhook = view.settings.find((s) => s.key === "alertWebhookUrl");
		expect(webhook && "set" in webhook && webhook.set).toBe(true);
		expect(JSON.stringify(view)).not.toContain("demo-placeholder");
		const rules = view.settings.find((s) => s.key === "backendAlerts");
		expect(rules?.rules?.rules.length).toBe(11);
		const drop = view.settings.find((s) => s.key === "errorDropRules");
		expect(drop && "value" in drop && Array.isArray(drop.value) && drop.value.length).toBeGreaterThan(0);
		expect(view.settings.find((s) => s.key === "notify.dryRun")?.source).toBe("dashboard");
		expect(view.audit.length).toBeGreaterThan(0);
		expect(view.centralLogin?.fingerprint).toMatch(/^tt1-[a-z2-7]{32}$/);
		expect(view.envOnly).toContain("TYPETORCH_ADMIN_TOKEN");
	});

	it("saves settings, refuses bad values and the lockout, resets to the environment", async () => {
		const api = testApi();
		const saved = await api.saveSettings({ ipPerMinute: 8000, keepDays: 0 });
		expect(saved.changed).toEqual(["ipPerMinute", "keepDays"]);
		const ip = saved.settings.find((s) => s.key === "ipPerMinute");
		expect(ip && "value" in ip ? ip.value : null).toBe(8000);
		expect(ip?.source).toBe("dashboard");
		expect(saved.audit[0]).toMatchObject({ action: "change", set: ["ipPerMinute", "keepDays"] });

		await expect(api.saveSettings({ ipPerMinute: 5 })).rejects.toMatchObject({ status: 400, message: "ipPerMinute must be from 100 to 1000000" });
		await expect(api.saveSettings({ nope: 1 })).rejects.toMatchObject({ status: 400 });
		await expect(api.saveSettings({ adminAllowIps: ["10.0.0.0/8"] })).rejects.toMatchObject({ status: 409 });
		const allowed = await api.saveSettings({ adminAllowIps: "203.0.113.0/24, 10.0.0.0/8" });
		expect(allowed.changed).toEqual(["adminAllowIps"]);

		const reset = await api.saveSettings({ ipPerMinute: null, adminAllowIps: null });
		expect(reset.changed).toEqual(["adminAllowIps", "ipPerMinute"]);
		expect(reset.settings.find((s) => s.key === "ipPerMinute")?.source).toBe("default");
		const again = await api.saveSettings({ keepDays: 0 });
		expect(again.changed).toEqual([]);
	});

	it("shares error drop rules and notification switches with their pages", async () => {
		const api = testApi();
		await api.saveSettings({ errorDropRules: [{ id: "escape-spam", expr: 'message contains "EscapeZone"', on: true }] });
		const rules = await api.errorDropRules();
		expect(rules.rules.map((r) => r.id)).toEqual(["escape-spam"]);
		await expect(api.saveSettings({ errorDropRules: [{ id: "bad", expr: "message contains", on: true }] })).rejects.toMatchObject({ status: 400 });

		await api.saveSettings({ "notify.rate": 120, "notify.kinds.comeback.enabled": false });
		const status = await api.notifyStatus();
		expect(status.rate).toBe(120);
		const view = await api.settings();
		const kinds = view.settings.find((s) => s.key === "notify.kinds");
		expect(kinds && "value" in kinds ? kinds.value : null).toEqual({ comeback: false });
		await api.saveSettings({ "notify.kinds.comeback.enabled": null, "notify.rate": null });
		expect((await api.notifyStatus()).rate).toBe(50);
	});

	it("sends test alerts (3 a minute) and records them", async () => {
		const api = testApi();
		resetAdminLimits();
		for (let i = 0; i < 3; i++) expect(await api.testAlert()).toEqual({ ok: true, status: 204 });
		await expect(api.testAlert()).rejects.toMatchObject({ status: 429 });
		const view = await api.settings();
		expect(view.audit[0]).toMatchObject({ action: "test-alert", result: "sent (HTTP 204)" });
		resetAdminLimits();
	});

	it("reports the alert rules from the saved setting", async () => {
		const api = testApi();
		const status = await api.alertRules();
		expect(status.on).toBe(true);
		expect(status.rules.length).toBe(11);
		expect(status.rules.every((r) => r.note.length > 0)).toBe(true);
		expect(status.rules.find((r) => r.id === "ccuDrop")?.state).not.toBe("off");
		await api.saveSettings({ backendAlerts: { rules: { ccuDrop: { on: false } } } });
		expect((await api.alertRules()).rules.find((r) => r.id === "ccuDrop")?.state).toBe("off");
		await api.saveSettings({ backendAlerts: null });
	});

	it("answers backend stats for every window, the same for the same second", async () => {
		const api = testApi();
		for (const window of ["1m", "5m", "15m", "1h"] as const) {
			const s = await api.backendStats(window);
			expect(s.window).toBe(window);
			expect(s.seconds.length).toBe(120);
			expect(s.minutes.length).toBe(60);
			// "1m" at a minute's first second holds only the minute just started (like the backend).
			if (window !== "1m") expect(s.routes.length).toBeGreaterThan(5);
			expect(s.rates.requests).toBeGreaterThan(0);
			expect(s.latency.recent.p50).toBeGreaterThan(0);
			if (window !== "1m") expect(s.latency.window.p50).toBeGreaterThan(0);
			expect(s.sample?.rssMb).toBeGreaterThan(300);
			expect(s.uptimeSeconds).toBeGreaterThan(3 * 86_400);
		}
		expect(await api.backendStats("5m")).toEqual(await api.backendStats("5m"));
		await expect(api.backendStats("2h" as never)).rejects.toMatchObject({ status: 400 });
	});

	it("pages the audit log with facets and filters, newest first", async () => {
		const api = testApi();
		const first = await api.audit({ facets: true, limit: 20 });
		expect(first.entries.length).toBe(20);
		expect(first.next).toBeTypeOf("number");
		expect(first.keepDays).toBeGreaterThan(0);
		const ids = first.entries.map((e) => e.id);
		expect([...ids].sort((a, b) => b - a)).toEqual(ids);
		expect(first.facets?.actions.map((a) => a.action)).toEqual(expect.arrayContaining(["sign-in", "deploy.start", "backup.create", "settings.change"]));
		const second = await api.audit({ limit: 20, before: first.next as number });
		expect(second.entries[0]?.id).toBeLessThan(first.entries[19]?.id as number);
		const deploys = await api.audit({ action: "deploy.*", limit: 500 });
		expect(deploys.entries.length).toBeGreaterThan(10);
		expect(deploys.entries.every((e) => e.action === "deploy.start" && e.actorKind === "api-key")).toBe(true);
		const seqs = deploys.entries.map((e) => (e.details as { seq: number }).seq);
		expect(Math.max(...seqs)).toBe(224);
		const failed = await api.audit({ outcome: "failed", limit: 500 });
		expect(failed.entries.every((e) => e.outcome === "failed")).toBe(true);
		// The changes made above are in it, newest first.
		const changes = await api.audit({ action: "settings.change", limit: 5 });
		expect(changes.entries[0]?.actor).toBe("roblox user -1 (demo_owner)");
		await expect(api.audit({ outcome: "nope" as never })).rejects.toMatchObject({ status: 400 });
		for (const e of first.entries) if (e.userId !== null) expect(e.userId).toBe(-1);
	});

	it("lists backups, backs up now and downloads a tar", async () => {
		const api = testApi();
		const status = await api.backups();
		expect(status.keep).toBe(3);
		expect(status.backups.length).toBe(3);
		expect(status.backups[0]?.name).toMatch(/^typetorch-backup-\d{8}T\d{6}Z$/);
		expect(status.disk?.level).toBe("ok");
		const after = await api.backupNow();
		expect(after.backups[0]?.reason).toBe("manual");
		expect(after.last?.reason).toBe("manual");
		const file = await api.downloadBackup();
		expect(file.name).toMatch(/^typetorch-backup-.*\.tar$/);
		const bytes = new Uint8Array(await file.blob.arrayBuffer());
		expect(bytes.byteLength % 512).toBe(0);
		expect(new TextDecoder().decode(bytes.subarray(257, 262))).toBe("ustar");
		await expect(api.backupNow()).rejects.toMatchObject({ status: 429 });
		resetAdminLimits();
		const audit = await api.audit({ action: "backup.*", limit: 5 });
		expect(audit.entries[0]?.action).toBe("backup.download");
	});

	it("lists and revokes trusted browsers", async () => {
		const api = testApi();
		const devices = await api.devices();
		expect(devices.length).toBe(3);
		expect(devices.filter((d) => d.current).length).toBe(1);
		const other = devices.find((d) => !d.current) as (typeof devices)[number];
		const left = await api.revokeDevice(other.id);
		expect(left.map((d) => d.id)).not.toContain(other.id);
		await expect(api.revokeDevice(other.id)).rejects.toMatchObject({ status: 404 });
		await expect(api.revokeDevice("zz")).rejects.toMatchObject({ status: 400 });
	});

	it("measures the data folder from the pack", async () => {
		const api = testApi();
		const s = await api.storage();
		expect(s.totalBytes).toBe(s.parts.reduce((n, p) => n + p.bytes, 0));
		const events = s.parts.find((p) => p.key === "events");
		// The pack's last day is today (still in the live table): 13 day files before it.
		expect(events?.days).toBe(13);
		expect(s.rows?.parquetEvents).toBeGreaterThan(400_000);
		expect(s.growth?.days.length).toBe(8);
		expect(s.disk?.freePercent).toBeGreaterThan(50);
	});

	it("names The Prison's products without icons", async () => {
		const api = testApi();
		const gamepass = PRODUCTS.filter((p) => p.type === "gamepass").map((p) => p.id);
		const product = PRODUCTS.filter((p) => p.type === "product").map((p) => p.id);
		const items = await api.robloxProducts({ gamepass, product: [...product, 42] });
		expect(items.length).toBe(gamepass.length + product.length + 1);
		expect(items.filter((i) => i.status === "ok").every((i) => i.name && i.icon === null)).toBe(true);
		expect(items.find((i) => i.id === 42)?.status).toBe("not_found");
		expect(items.find((i) => i.id === 1626862412)).toMatchObject({ name: "Double Cash", price: 199 });
		await expect(api.robloxProducts({})).rejects.toMatchObject({ status: 400 });
	});

	it("answers Creator Hub's acquisition for 7, 14 and 28 days", async () => {
		const api = testApi();
		for (const days of [7, 14, 28]) {
			const a = await api.robloxAcquisition(days);
			expect(a.days).toBe(days);
			expect(a.daily.length).toBe(2 * days);
			expect(a.current.daysWithData).toBe(days);
			expect(a.current.impressions).toBeGreaterThan(a.current.qualifiedPlays);
			expect(a.current.qualifiedPlays).toBeGreaterThan(0);
			expect(a.current.playThroughHome).toBeGreaterThan(0.01);
			expect(a.sources.length).toBe(5);
			expect(a.daily.at(-1)?.day).toBe("2026-11-14");
		}
		await expect(api.robloxAcquisition(5)).rejects.toMatchObject({ status: 400 });
	});

	it("answers Creator Hub's demographics, with Roblox's filters", async () => {
		const api = testApi();
		const all = await api.robloxDemographics({});
		// The last 28 days from now: their 27 full UTC days that are over.
		expect(all.window.days).toBe(27);
		for (const card of Object.values(all.breakdowns)) {
			expect("rows" in card && card.rows.length).toBeGreaterThan(0);
			if ("rows" in card) expect(card.total).toBeGreaterThan(0);
		}
		const country = all.breakdowns.Country;
		expect("rows" in country && country.rows[0]?.value).toBe("US");
		const phones = await api.robloxDemographics({ dev: "phone", country: "US", players: "new" });
		expect(phones.applied.map((a) => a.dimension)).toEqual(["Platform", "IsNewUser", "Country"]);
		const platform = phones.breakdowns.Platform;
		expect("rows" in platform && platform.rows.map((r) => r.value)).toEqual(["Phone"]);
		const allTotal = "rows" in all.breakdowns.Gender ? all.breakdowns.Gender.total : 0;
		const phoneTotal = "rows" in phones.breakdowns.Gender ? phones.breakdowns.Gender.total : 0;
		expect(phoneTotal).toBeLessThan(allTotal);
		const vr = await api.robloxDemographics({ dev: "vr" });
		expect(vr.notApplied[0]?.filter).toBe("device");
		await expect(api.robloxDemographics({ dev: "toaster" })).rejects.toMatchObject({ status: 400 });
	});

	it("lists The Prison's map, serves its geometry with an ETag and simulates an export", async () => {
		const view = await mapsApi.list();
		expect(view.configured).toBe(true);
		expect(view.maps.map((m) => m.name)).toEqual([LOBBY]);
		expect(view.latest?.placeId).toBe(9876543210);
		expect(view.latest?.at).toBeLessThanOrEqual(TEST_NOW);
		expect(view.placeVersion.outOfDate).toBe(false);
		expect(view.export.state).toBe("idle");
		const map = view.maps[0] as (typeof view.maps)[number];
		const geometry = await mapsApi.geometry(LOBBY);
		expect(geometry).toBeTruthy();
		const raw = await fetch(`/api/v1/maps/${encodeURIComponent(LOBBY)}/geometry`);
		expect(raw.headers.get("etag")).toBe(`"${map.hash}"`);
		const bytes = new Uint8Array(await raw.arrayBuffer());
		expect(bytes.byteLength).toBe(map.bytes);
		expect(decodeGeometry(bytes)).toBeTruthy();
		const cached = await fetch(`/api/v1/maps/${encodeURIComponent(LOBBY)}/geometry`, { headers: { "if-none-match": `"${map.hash}"` } });
		expect(cached.status).toBe(304);
		await expect(mapsApi.geometry("Yard")).rejects.toMatchObject({ status: 404 });

		const started = await mapsApi.export();
		expect(started.export.state).toBe("running");
		await expect(mapsApi.export()).rejects.toMatchObject({ status: 409 });
		at(TEST_NOW + 5_000);
		expect((await mapsApi.list()).export.step).toBe("running in the place");
		at(TEST_NOW + EXPORT_MS + 1_000);
		const done = await mapsApi.list();
		expect(done.export.state).toBe("done");
		expect(done.latest?.at).toBe(TEST_NOW + EXPORT_MS);
		expect(done.history.length).toBe(view.history.length + 1);
		await expect(mapsApi.export()).rejects.toMatchObject({ status: 429 });
		const audit = await testApi().audit({ action: "maps.*", outcome: "ok", limit: 5 });
		expect(audit.entries.map((e) => e.action)).toEqual(["maps.export.done", "maps.export"]);
		expect((await testApi().audit({ action: "maps.export", outcome: "refused", limit: 5 })).entries.map((e) => e.status)).toEqual([429, 409]);
		at(TEST_NOW);
	});

	it("saves and removes map overrides", async () => {
		const set = await mapsApi.setOverride("Cell Block", { offset: [12.345, 0, -4] });
		expect(set.override).toMatchObject({ offset: [12.35, 0, -4], by: "roblox user -1 (demo_owner)" });
		expect((await mapsApi.list()).overrides["Cell Block"]?.offset).toEqual([12.35, 0, -4]);
		await expect(mapsApi.setOverride(LOBBY, { offset: [1, 2, 3] })).rejects.toMatchObject({ status: 400 });
		await expect(mapsApi.setOverride("Cell Block", { offset: [1, 2] as never })).rejects.toBeInstanceOf(ApiError);
		expect((await mapsApi.removeOverride("cell-block")).override).toBeNull();
		expect((await mapsApi.list()).overrides).toEqual({});
	});

	it("keeps every answer off Roblox", async () => {
		const api = testApi();
		expectPrivate(await api.settings());
		expectPrivate(await api.audit({ limit: 500 }));
		expectPrivate(await api.robloxProducts({ gamepass: [1525207977], product: [3476606134] }));
		expectPrivate(await api.robloxDemographics({}));
		expectPrivate(await mapsApi.list());
		expectPrivate(await api.devices());
	});
});
