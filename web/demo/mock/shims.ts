/**
 * What the backend's shared code expects from Node that a browser lacks. src/recording.ts decodes recording chunks with
 * `Uint8Array.from(Buffer.from(base64, "base64"))`; this Buffer covers that (base64 / utf8 / hex in, Uint8Array out, and
 * toString back). Only installed when there is no Buffer (Node keeps its own).
 */

type Encoding = "base64" | "utf8" | "utf-8" | "hex" | "latin1" | "binary";

class DemoBuffer extends Uint8Array {
	static override from(value: unknown, encodingOrMap?: unknown): DemoBuffer {
		if (typeof value === "string") return DemoBuffer.fromString(value, (encodingOrMap as Encoding | undefined) ?? "utf8");
		if (value instanceof ArrayBuffer) return new DemoBuffer(value);
		if (ArrayBuffer.isView(value)) return new DemoBuffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
		if (Array.isArray(value)) return new DemoBuffer(value as number[]);
		throw new TypeError("Buffer.from: unsupported value in the demo shim");
	}

	static isBuffer(value: unknown): boolean {
		return value instanceof DemoBuffer;
	}

	static byteLength(value: string, encoding: Encoding = "utf8"): number {
		return DemoBuffer.fromString(value, encoding).length;
	}

	private static fromString(text: string, encoding: Encoding): DemoBuffer {
		if (encoding === "base64") {
			const clean = text.replace(/[^A-Za-z0-9+/_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
			const bin = atob(clean + "===".slice((clean.length + 3) % 4));
			const out = new DemoBuffer(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		if (encoding === "hex") {
			const out = new DemoBuffer(Math.floor(text.length / 2));
			for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
			return out;
		}
		if (encoding === "latin1" || encoding === "binary") {
			const out = new DemoBuffer(text.length);
			for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
			return out;
		}
		const bytes = new TextEncoder().encode(text);
		return new DemoBuffer(bytes.buffer as ArrayBuffer);
	}

	override toString(encoding: Encoding = "utf8"): string {
		if (encoding === "base64") {
			let bin = "";
			for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i] as number);
			return btoa(bin);
		}
		if (encoding === "hex") return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
		if (encoding === "latin1" || encoding === "binary") return Array.from(this, (b) => String.fromCharCode(b)).join("");
		return new TextDecoder().decode(this);
	}
}

export function installShims(): void {
	const g = globalThis as { Buffer?: unknown };
	if (typeof g.Buffer === "undefined") g.Buffer = DemoBuffer;
}
