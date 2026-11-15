/**
 * A minimal S3 server for the queue bucket tests (plans/35 C): path-style PUT / GET / HEAD / DELETE, ListObjectsV2 and
 * multipart uploads, on Bun.serve, so Bun's own S3Client talks to it as it would to R2. Signatures aren't checked (only
 * that a SigV4 header names the access key). `down` makes every call fail with a 503; credentials are made up.
 */
export const FAKE_ACCESS_KEY = "AKFAKEQUEUE0001";
export const FAKE_SECRET = "fake-queue-secret-0123456789abcdef";
export const FAKE_BUCKET = "tt-queue";

export interface FakeS3 {
	endpoint: string;
	objects: Map<string, Uint8Array>;
	/** "<METHOD> <key or ?list>" per request. */
	requests: string[];
	down: boolean;
	/** Keys under a prefix, sorted. */
	keys(prefix?: string): string[];
	stop(): void;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function fakeS3(): FakeS3 {
	const objects = new Map<string, Uint8Array>();
	const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
	const requests: string[] = [];
	let uploadSeq = 0;
	const state = { down: false };
	const error = (status: number, code: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const [, bucket, ...rest] = url.pathname.split("/");
			const key = decodeURIComponent(rest.join("/"));
			const list = req.method === "GET" && url.searchParams.get("list-type") === "2";
			requests.push(`${req.method} ${list ? `?list ${url.searchParams.get("prefix") ?? ""}` : key}`);
			if (state.down) return error(503, "ServiceUnavailable");
			if (!(req.headers.get("authorization") ?? "").includes(`Credential=${FAKE_ACCESS_KEY}/`)) return error(403, "AccessDenied");
			if (bucket !== FAKE_BUCKET) return error(404, "NoSuchBucket");
			if (list) {
				const prefix = url.searchParams.get("prefix") ?? "";
				const max = Number(url.searchParams.get("max-keys") ?? 1000);
				const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
				const page = all.slice(0, max);
				const contents = page.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k)?.length ?? 0}</Size><LastModified>2026-11-15T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join("");
				return new Response(
					`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${all.length > page.length}</IsTruncated>${contents}</ListBucketResult>`,
					{ headers: { "content-type": "application/xml" } },
				);
			}
			const uploadId = url.searchParams.get("uploadId");
			if (req.method === "POST" && url.searchParams.has("uploads")) {
				const id = `up${++uploadSeq}`;
				uploads.set(id, { key, parts: new Map() });
				return new Response(`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
			}
			if (req.method === "PUT" && uploadId) {
				const upload = uploads.get(uploadId);
				if (!upload) return error(404, "NoSuchUpload");
				upload.parts.set(Number(url.searchParams.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
				return new Response(null, { status: 200, headers: { etag: `"p${url.searchParams.get("partNumber")}"` } });
			}
			if (req.method === "POST" && uploadId) {
				const upload = uploads.get(uploadId);
				if (!upload) return error(404, "NoSuchUpload");
				await req.arrayBuffer();
				const parts = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
				const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
				let at = 0;
				for (const p of parts) {
					whole.set(p, at);
					at += p.length;
				}
				objects.set(upload.key, whole);
				uploads.delete(uploadId);
				return new Response(`<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${xml(upload.key)}</Key><ETag>"m"</ETag></CompleteMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
			}
			if (req.method === "DELETE" && uploadId) {
				uploads.delete(uploadId);
				return new Response(null, { status: 204 });
			}
			if (req.method === "PUT") {
				objects.set(key, new Uint8Array(await req.arrayBuffer()));
				return new Response(null, { status: 200, headers: { etag: '"x"' } });
			}
			if (req.method === "GET" || req.method === "HEAD") {
				const body = objects.get(key);
				if (!body) return error(404, "NoSuchKey");
				return new Response(req.method === "HEAD" ? null : body, { headers: { "content-length": String(body.length), "content-type": "application/octet-stream", etag: '"x"' } });
			}
			if (req.method === "DELETE") {
				objects.delete(key);
				return new Response(null, { status: 204 });
			}
			return error(400, "InvalidRequest");
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}`,
		objects,
		requests,
		get down() {
			return state.down;
		},
		set down(value: boolean) {
			state.down = value;
		},
		keys: (prefix = "") => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
		stop: () => void server.stop(true),
	};
}

/** The queue settings for a role, pointing at a fake S3 server. */
export function queueEnv(s3: FakeS3, extra: Record<string, string> = {}): Record<string, string> {
	return { TYPETORCH_QUEUE_BUCKET: FAKE_BUCKET, TYPETORCH_QUEUE_ENDPOINT: s3.endpoint, TYPETORCH_QUEUE_ACCESS_KEY_ID: FAKE_ACCESS_KEY, TYPETORCH_QUEUE_SECRET_ACCESS_KEY: FAKE_SECRET, ...extra };
}
