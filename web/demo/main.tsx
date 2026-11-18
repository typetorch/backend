/**
 * The demo's entry: the mock backend goes in first (fetch, EventSource, the Node shims), then the banner, then the real
 * explorer (web/src/main.tsx, unchanged), which mounts itself on #root.
 */
import { installDemo } from "./mock/install";
import { mountBanner } from "./banner";
// The explorer's styles up front, so the banner is styled before the app loads.
import "@/index.css";

installDemo();
mountBanner(document.getElementById("demo-banner") as HTMLElement);
void import("@/main");
