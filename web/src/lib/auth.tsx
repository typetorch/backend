/** Who is signed in, for the header and anything that needs to know. Provided by AuthGate once the backend says yes. */
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "./api";
import type { AuthInfo, AuthUser, LoginOptions } from "./types";

const AuthContext = createContext<AuthInfo | null>(null);
export const AuthProvider = AuthContext.Provider;

export function useAuth(): AuthInfo | null {
	return useContext(AuthContext);
}

/** Whether this page was opened from the CLI's trust link (`/?blessed=1`, read once by AuthGate). */
const BlessedContext = createContext(false);
export const BlessedProvider = BlessedContext.Provider;
export function useBlessedOnLoad(): boolean {
	return useContext(BlessedContext);
}

/** Reads and removes `blessed=1` from the address (the backend's redirect after the CLI's trust link). */
export function takeBlessed(): boolean {
	try {
		const url = new URL(window.location.href);
		if (!url.searchParams.has("blessed")) return false;
		const on = url.searchParams.get("blessed") === "1";
		url.searchParams.delete("blessed");
		window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		return on;
	} catch {
		return false;
	}
}

/** The offers on the login page: the backend's list from the 401 body, else the token form only. */
export function loginOptionsOf(body: unknown): LoginOptions {
	const login = (body as { login?: Partial<LoginOptions> } | undefined)?.login;
	const dashboard = login?.typetorch ? dashboardUrl(login.dashboard) : undefined;
	return { token: login?.token ?? true, roblox: login?.roblox ?? false, ...(login?.typetorch ? { typetorch: true } : {}), ...(dashboard ? { dashboard } : {}) };
}

/**
 * The TypeTorch Dashboard link: the origin the backend names, only when it is a plain https origin (http on loopback, for a
 * local broker). Anything else (a path, credentials, another scheme) gets no link.
 */
export function dashboardUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 256) return undefined;
	try {
		const url = new URL(value);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
		if (url.username || url.password || url.origin !== value.replace(/\/$/, "")) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** The plain sentences for the `login_error` the backend puts in the address after a failed Roblox or typetorch.dev sign-in. */
export const LOGIN_ERRORS: Record<string, string> = {
	not_owner: "That Roblox account is not an owner or a viewer of this game.",
	denied: "Sign-in was cancelled.",
	state: "That sign-in link expired or was already used. Try again.",
	failed: "Sign-in did not work. Try again in a moment.",
	not_blessed: "This browser is not trusted for owners yet. Trust it once with the admin token or `typetorch backend bless`.",
	bless: "That trust link expired, was already used or is not signed by this game's key.",
};

export function loginErrorText(code: string | null | undefined): string | null {
	if (!code) return null;
	return LOGIN_ERRORS[code] ?? "Sign-in did not work. Try again.";
}

/** A short label for the header: "OwnerName", "admin token". */
export function userLabel(user: AuthUser | undefined, via?: string): string {
	if (user?.kind === "roblox") return user.displayName ?? user.name;
	if (via === "bearer") return "admin token (proxy)";
	return "admin token";
}

/** The session can only read (the web role): the pages that change something stay out, the rest is the same. */
export function isReadOnly(auth: Pick<AuthInfo, "role"> | null | undefined): boolean {
	return auth?.role === "web";
}

/** Ends the cookie session, forgets every cached answer and reloads at the top (the login page). */
export async function signOut(client: QueryClient): Promise<void> {
	try {
		await api.logout();
	} finally {
		client.clear();
		window.location.assign("/");
	}
}
