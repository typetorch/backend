/**
 * The login page: Sign in with Roblox (owners, and read-only viewers) first, Sign in with typetorch.dev when the backend
 * turns it on, the admin token last (hidden when the backend turns it off).
 */
import { Globe, KeyRound, LayoutDashboard, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { loginErrorText } from "@/lib/auth";
import type { LoginOptions } from "@/lib/types";

/** The reason the backend left in the address after Roblox sign-in, read once. */
export function takeLoginError(): string | null {
	try {
		const url = new URL(window.location.href);
		const code = url.searchParams.get("login_error");
		if (!code) return null;
		url.searchParams.delete("login_error");
		window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
		return loginErrorText(code);
	} catch {
		return null;
	}
}

function tokenError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 429) return "Too many wrong tries. Wait a few minutes and try again.";
		if (error.status === 401) return "That is not the admin token.";
		if (error.status === 404) return "This backend does not take the admin token here.";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function LoginPage({ options, initialError, onSignedIn }: { options: LoginOptions; initialError?: string | null; onSignedIn(): void }) {
	const [error, setError] = useState<string | null>(initialError ?? null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!token.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.login(token.trim());
			setToken("");
			onSignedIn();
		} catch (e) {
			setError(tokenError(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<img src="/favicon.svg" alt="" className="mb-2 size-12" />
					<CardTitle>TypeTorch</CardTitle>
					<CardDescription>Sign in to the backend explorer.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					{options.roblox ? (
						<Button asChild className="w-full" size="lg">
							<a href="/v1/auth/roblox/start">
								<LogIn />
								Sign in with Roblox
							</a>
						</Button>
					) : null}
					{options.typetorch ? (
						<Button asChild className="w-full" size="lg" variant={options.roblox ? "outline" : "default"}>
							<a href="/auth/typetorch/start">
								<Globe />
								Sign in with typetorch.dev
							</a>
						</Button>
					) : null}
					{options.typetorch && options.dashboard ? (
						<div className="text-center">
							<a href={options.dashboard} rel="noopener" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
								<LayoutDashboard className="size-3.5" aria-hidden />
								TypeTorch Dashboard
							</a>
						</div>
					) : null}
					{(options.roblox || options.typetorch) && options.token ? <div className="text-center text-xs text-muted-foreground">or</div> : null}
					{options.token ? (
						<form className="space-y-2" onSubmit={submit}>
							<Label htmlFor="admin-token" className="text-xs text-muted-foreground">
								Admin token
							</Label>
							<Input id="admin-token" type="password" autoComplete="off" spellCheck={false} placeholder="paste the admin token" value={token} onChange={(e) => setToken(e.target.value)} />
							<Button type="submit" variant={options.roblox || options.typetorch ? "outline" : "default"} className="w-full" disabled={busy || !token.trim()}>
								<KeyRound />
								{busy ? "Checking" : "Sign in with the token"}
							</Button>
						</form>
					) : null}
					{!options.roblox && !options.token && !options.typetorch ? <p className="text-sm text-muted-foreground">No login is turned on for this backend.</p> : null}
				</CardContent>
			</Card>
		</div>
	);
}
