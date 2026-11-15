/**
 * Browser stand-ins for the Node built-ins the backend's shared modules import at the top (node:fs, node:path, node:crypto,
 * node:url, node:os, node:fs/promises). vite.demo.config.ts points those imports here for the browser build only (tests run
 * on Node with the real ones). The demo only calls the pure parts of those modules (query definitions, input checks,
 * shapes): anything that would touch files or keys throws, so a mock that reaches it fails loudly instead of pretending.
 * Add a name here when a newly imported backend module needs one.
 */
const unavailable = (name: string) => () => {
	throw new Error(`${name} is not available in the demo (browser build)`);
};

// node:fs
export const existsSync = () => false;
export const readdirSync = () => [];
export const statSync = unavailable("fs.statSync");
export const readFileSync = unavailable("fs.readFileSync");
export const writeFileSync = unavailable("fs.writeFileSync");
export const appendFileSync = unavailable("fs.appendFileSync");
export const mkdirSync = unavailable("fs.mkdirSync");
export const renameSync = unavailable("fs.renameSync");
export const rmSync = unavailable("fs.rmSync");
export const unlinkSync = unavailable("fs.unlinkSync");
export const chmodSync = unavailable("fs.chmodSync");
export const openSync = unavailable("fs.openSync");
export const closeSync = unavailable("fs.closeSync");
export const fsyncSync = unavailable("fs.fsyncSync");
export const writeSync = unavailable("fs.writeSync");
export const statfsSync = unavailable("fs.statfsSync");
export const createReadStream = unavailable("fs.createReadStream");
export const createWriteStream = unavailable("fs.createWriteStream");
// node:fs/promises
export const readFile = unavailable("fs.readFile");
export const writeFile = unavailable("fs.writeFile");
export const copyFile = unavailable("fs.copyFile");
export const link = unavailable("fs.link");
export const mkdir = unavailable("fs.mkdir");
export const readdir = unavailable("fs.readdir");
export const rename = unavailable("fs.rename");
export const rm = unavailable("fs.rm");
export const stat = unavailable("fs.stat");
export const open = unavailable("fs.open");

// node:path (POSIX, enough for building names)
export const sep = "/";
export function join(...parts: string[]): string {
	return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
export function resolve(...parts: string[]): string {
	return join("/", ...parts);
}
export function dirname(path: string): string {
	const i = path.replace(/\/+$/, "").lastIndexOf("/");
	return i <= 0 ? (path.startsWith("/") ? "/" : ".") : path.slice(0, i);
}
export function basename(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() ?? "";
}
export function extname(path: string): string {
	const b = basename(path);
	const i = b.lastIndexOf(".");
	return i > 0 ? b.slice(i) : "";
}
export function relative(from: string, to: string): string {
	return to.startsWith(from) ? to.slice(from.length).replace(/^\//, "") : to;
}

// node:crypto
export const createHash = unavailable("crypto.createHash");
export const createHmac = unavailable("crypto.createHmac");
export const timingSafeEqual = unavailable("crypto.timingSafeEqual");
export const createPrivateKey = unavailable("crypto.createPrivateKey");
export const createPublicKey = unavailable("crypto.createPublicKey");
export const generateKeyPairSync = unavailable("crypto.generateKeyPairSync");
export const sign = unavailable("crypto.sign");
export const verify = unavailable("crypto.verify");
export function randomBytes(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}

// node:url
export function fileURLToPath(url: string | URL): string {
	return new URL(String(url)).pathname;
}

// node:os
export const tmpdir = () => "/tmp";
export const platform = () => "browser";
export const EOL = "\n";

export default {};
