/** Installs the demo backend in the page: the Node shims, every handler, and the fetch / EventSource interceptors. */
import "./handlers";
import { installInterceptors } from "./router";
import { installShims } from "./shims";

export function installDemo(): void {
	installShims();
	installInterceptors();
}
