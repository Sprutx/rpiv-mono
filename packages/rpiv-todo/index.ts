/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, resolveCollapseKey } from "./config.ts";
import { I18N_NAMESPACE } from "./state/i18n-bridge.ts";
import { replayFromBranch } from "./state/replay.ts";
import {
	claimWidgetSurface,
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	getState,
	releaseWidgetSurfaces,
	replaceState,
	setActiveRenderSession,
	sid,
} from "./state/store.ts";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.ts";
import type { TodoOverlay } from "./todo-overlay.ts";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

/** Delay the overlay graph pre-warm until Pi's startup work has settled. */
export const PREWARM_DELAY_MS = 2000;

type TodoOverlayModule = typeof import("./todo-overlay.ts");
type TodoOverlayImporter = () => Promise<TodoOverlayModule>;

/**
 * Marker shared by the loader's poisoned-namespace error and the
 * `isStaleOverlayModuleError` predicate that lets handlers re-throw it while
 * swallowing transient load failures.
 */
const STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";

/** True for the loader's latched poisoned-namespace error (see below). */
export function isStaleOverlayModuleError(e: unknown): boolean {
	return String(e).includes(STALE_OVERLAY_MESSAGE);
}

/**
 * Memoize the overlay graph after a successful load, but drop a rejected
 * promise so a failed pre-warm does not permanently replay the same rejection.
 * The export guard turns jiti's poisoned-namespace failure into a useful restart
 * error instead of a bare "TodoOverlay is not a constructor" TypeError.
 */
export function makeTodoOverlayLoader(
	importOverlay: TodoOverlayImporter = () => import("./todo-overlay.ts"),
): TodoOverlayImporter {
	let memo: Promise<TodoOverlayModule> | undefined;

	return async (): Promise<TodoOverlayModule> => {
		memo ??= importOverlay();
		const current = memo;
		let mod: TodoOverlayModule;
		try {
			mod = await current;
		} catch (error) {
			// Clear only OUR rejected promise: a late catch from a concurrent
			// awaiter must never clobber a fresh retry another caller installed.
			if (memo === current) memo = undefined;
			throw error;
		}
		if (typeof mod.TodoOverlay !== "function") {
			// Deliberately latched: the memo keeps this resolved-but-poisoned
			// namespace, so every subsequent load re-throws instead of retrying.
			// Re-importing would hand back the same cached jiti namespace — a
			// retry can never heal this; only the restart the error asks for can.
			const keys = JSON.stringify(Object.keys(mod));
			throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${keys})`);
		}
		return mod;
	};
}

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Render a caught `unknown` as a human-readable message — the `instanceof Error`
 * dance collapsed to one place. Local copy of the `formatError` in
 * packages/rpiv-workflow/internal-utils.ts:56-58 (that module disclaims its
 * public surface, so the cross-package import is not available). M2 boundary
 * duplication: tracked as a documented-constant seam.
 */
function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export default function (pi: ExtensionAPI, importOverlay: TodoOverlayImporter = () => import("./todo-overlay.ts")) {
	const loadTodoOverlay = makeTodoOverlayLoader(importOverlay);

	// One overlay per UI-bearing session. Pi calls this factory once per session
	// runner, but a multi-session host (pi-web) runs many runners in one process
	// and they share this module's state. Gating the overlay on the shared render
	// pointer left every session but the first without a widget. Each slot binds
	// its session's own ui and renders its own task slot. The generation
	// invalidates in-flight overlay imports when the session is re-bound or shut
	// down. A closure normally holds one slot; the Map keeps a closure that sees
	// several sessions (tests, embedders) correct too.
	type OverlaySlot = { uiCtx: ExtensionUIContext; overlay?: TodoOverlay; generation: number };
	const slots = new Map<string, OverlaySlot>();
	let generationCounter = 0;

	// The widget surface a ui writes to. Pi wraps each runner's ui (`{...ui}`), so
	// the object identity differs per session even when two sessions share one
	// host UI; the `setWidget` function survives the spread and identifies the
	// surface. Ownership lives in the shared store (`claimWidgetSurface`), so a
	// child in another closure that relays the parent's UI is still refused.
	const surfaceOf = (ui: ExtensionUIContext): unknown => ui.setWidget ?? ui;

	async function updateTodoOverlay(id: string, resetCompletedDisplayState = false): Promise<void> {
		const slot = slots.get(id);
		if (!slot) return;
		const generation = slot.generation;
		const hasVisibleTasks = getState(id).tasks.some((task) => task.status !== "deleted");
		if (!slot.overlay && !hasVisibleTasks) return;

		const { TodoOverlay } = await loadTodoOverlay();
		if (slots.get(id) !== slot || slot.generation !== generation) return;

		slot.overlay ??= new TodoOverlay(() => getState(id));
		slot.overlay.setUICtx(slot.uiCtx);
		if (resetCompletedDisplayState) slot.overlay.resetCompletedDisplayState();
		slot.overlay.update();
	}

	// Session id of an event ctx, or undefined when the ctx is absent or stale.
	const ctxSid = (ctx: unknown): string | undefined => {
		if (!ctx) return undefined;
		try {
			return sid(ctx as Parameters<typeof sid>[0]);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			return undefined;
		}
	};

	// Sessions an event refers to: the ctx's own session when it has a slot, else
	// every bound session (a host or test that fires the event without a ctx).
	const targetSessions = (ctx: unknown): string[] => {
		const id = ctxSid(ctx);
		if (id !== undefined) return slots.has(id) ? [id] : [];
		return [...slots.keys()];
	};

	registerTodoTool(pi);
	registerTodosCommand(pi);

	// Collapse/expand hotkey for the todo overlay. The key is resolved once at
	// factory scope from config (register-once contract: a config change needs
	// `/reload` to re-bind, same as lane-switcher's env hotkey) and the binding is
	// skipped entirely when collapseKey is "off". The handler toggles the overlay of
	// the session that received the key. No-op in headless mode, before the overlay
	// has loaded, or when the widget isn't currently registered (auto-hidden on an
	// empty list).
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI) return;
				for (const id of targetSessions(ctx)) {
					const overlay = slots.get(id)?.overlay;
					if (overlay?.isRegistered()) overlay.toggleCollapse();
				}
			},
		});
	}

	// Re-key a session's slot from its branch, then refresh that session's overlay.
	// Shared by session_compact and session_tree. A stale ctx (auto-compaction races
	// session disposal: pi-core invalidates the runner while still emitting the
	// event, so `ctx` may be a dead proxy whose getters throw) keeps current state —
	// the replacement session's session_start replays it. Other errors are real
	// replay bugs and must propagate.
	const replayAndRefresh = async (
		ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
	): Promise<void> => {
		let id: string | undefined;
		try {
			id = sid(ctx);
			replaceState(id, replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			id = undefined;
		}
		if (id !== undefined && slots.has(id)) await updateTodoOverlay(id, true);
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = sid(ctx);
			// Every session replays into its OWN data slot (Phase 1 isolation).
			replaceState(id, replayFromBranch(ctx));
		} catch (e) {
			// Parity with compact/tree/shutdown: session_start is the fresh-ctx event
			// so the stale risk is low, but a stale/throwing ctx has nothing to bind —
			// swallow the known stale error and bail; let real replay bugs propagate.
			if (!isStaleCtxError(e)) throw e;
			return;
		}
		if (!ctx.hasUI) return;
		// The first UI-bearing session_start claims the ctx-less render pointer that
		// the tool's renderCall reads (Pi's ToolRenderContext carries no session).
		if (getActiveRenderSession() === "") setActiveRenderSession(id);
		const uiCtx = ctx.ui;
		if (!claimWidgetSurface(surfaceOf(uiCtx), id)) return;
		const generation = ++generationCounter;
		const existing = slots.get(id);
		if (existing) {
			existing.uiCtx = uiCtx;
			existing.generation = generation;
		} else {
			slots.set(id, { uiCtx, generation });
		}
		await updateTodoOverlay(id, true);
	});

	pi.on("session_compact", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await replayAndRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Best-effort sid: disposal can race a stale ctx (like compact). An
		// unknown/stale sid resolves to "": this closure then tears down every
		// session it bound, the safe pre-isolation default that disposes as before.
		let s: string;
		try {
			s = sid(ctx);
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			s = "";
		}
		// The shutting-down session's own data slot is always evicted.
		evictSession(s);
		const targets = s === "" ? [...slots.keys()] : [s];
		const ownsPointer = s === "" ? targets.includes(getActiveRenderSession()) : s === getActiveRenderSession();
		const overlays: TodoOverlay[] = [];
		for (const id of targets) {
			const slot = slots.get(id);
			// Drop the slot first: a pending overlay import sees the missing slot
			// and never binds a replaced session's ui.
			slots.delete(id);
			releaseWidgetSurfaces(id);
			if (slot?.overlay) overlays.push(slot.overlay);
		}
		// `dispose()`'s first act is setWidget(KEY, undefined) on a possibly-stale ui
		// proxy, which can throw. try/finally guarantees the render pointer is
		// cleared regardless, so the next hasUI session_start can reclaim it.
		try {
			for (const overlay of overlays) overlay.dispose();
		} finally {
			if (ownsPointer) clearActiveRenderSession();
		}
	});

	// Reads the session slot at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		for (const id of targetSessions(ctx)) {
			try {
				await updateTodoOverlay(id);
			} catch (e) {
				// The tool itself succeeded — a transient overlay-load failure only
				// costs this one refresh, and the loader's cleared memo lets the next
				// update retry. Don't surface that as an extension error. The latched
				// stale-namespace error still propagates: it never self-heals, and the
				// user needs its restart guidance.
				if (isStaleOverlayModuleError(e)) throw e;
				console.warn(`[rpiv-todo] overlay refresh failed (will retry on next update): ${formatError(e)}`);
			}
		}
	});

	// Evaluate the lazy graph after startup while Pi's boot-time dependency paths
	// are still stable. This loads no widget and constructs no overlay; those stay
	// deferred until a session has visible tasks. A rejected pre-warm is
	// intentionally swallowed after loadTodoOverlay clears its memo, allowing the
	// first real update to retry. unref avoids holding an embedder open.
	const prewarmTimer = setTimeout(() => void loadTodoOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();

	pi.on("agent_start", async (_event, ctx) => {
		for (const id of targetSessions(ctx)) slots.get(id)?.overlay?.hideCompletedTasksFromPreviousTurn();
	});
}
