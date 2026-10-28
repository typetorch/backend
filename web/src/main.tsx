import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "@/components/AppShell";
import { AUTH_KEY, AuthGate } from "@/components/AuthGate";
import { ErrorState } from "@/components/common";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import "./index.css";

const queryClient = new QueryClient({
	// A session that ended while the page was open: ask the backend who we are again, which shows the login page.
	queryCache: new QueryCache({
		onError: (error, query) => {
			if (error instanceof ApiError && error.unauthorized && query.queryKey[0] !== AUTH_KEY[0]) void queryClient.invalidateQueries({ queryKey: AUTH_KEY });
		},
	}),
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			refetchOnWindowFocus: false,
			// Input errors (4xx) won't get better on a retry.
			retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
		},
	},
});

/** Pages load on first visit (keeps the first bundle small: charts and graphs come with their pages). */
const page = (load: () => Promise<{ default: React.ComponentType }>) => async () => ({ Component: (await load()).default });

const router = createBrowserRouter([
	{
		path: "/",
		element: (
			<AuthGate>
				<AppShell />
			</AuthGate>
		),
		errorElement: (
			<div className="p-6">
				<ErrorState error={new Error("This page failed to render. Reload, or go back to the overview.")} />
			</div>
		),
		children: [
			{ index: true, lazy: page(() => import("@/pages/Overview")) },
			{ path: "roblox", lazy: page(() => import("@/pages/Roblox")) },
			{ path: "economy", lazy: page(() => import("@/pages/Economy")) },
			{ path: "monetization", lazy: page(() => import("@/pages/Monetization")) },
			{ path: "retention", lazy: page(() => import("@/pages/Retention")) },
			{ path: "funnels", lazy: page(() => import("@/pages/Funnels")) },
			{ path: "players", lazy: page(() => import("@/pages/Players")) },
			{ path: "flow", lazy: page(() => import("@/pages/Flow")) },
			{ path: "experiments", lazy: page(() => import("@/pages/Experiments")) },
			{ path: "first-session", lazy: page(() => import("@/pages/FirstSession")) },
			{ path: "events", lazy: page(() => import("@/pages/Events")) },
			{ path: "fleet", lazy: page(() => import("@/pages/Fleet")) },
			{ path: "performance", lazy: page(() => import("@/pages/Performance")) },
			// Plans/25: one fleet server and its read-only remote debug (lit as Fleet in the sidebar: its `also: ["/servers"]`).
			{ path: "servers/:jobId", lazy: page(() => import("@/pages/Server")) },
			{ path: "errors", lazy: page(() => import("@/pages/Errors")) },
			{ path: "query", lazy: page(() => import("@/pages/Query")) },
			{ path: "settings", lazy: page(() => import("@/pages/Settings")) },
			{ path: "backend", lazy: page(() => import("@/pages/BackendStats")) },
			{ path: "*", lazy: page(() => import("@/pages/NotFound")) },
		],
	},
]);

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		</ThemeProvider>
	</StrictMode>,
);
