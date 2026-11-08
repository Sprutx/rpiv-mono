import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import registerTodo from "./index.ts";
import { EMPTY_STATE } from "./state/state.ts";
import { getActiveRenderSession, getRenderState, getState } from "./state/store.ts";
import { __resetState } from "./todo.ts";

// Capture the extension's registered handlers + tool + command. Each registerTodo()
// call builds a fresh closure (fresh overlay slots), so isolation between tests
// is automatic given __resetState() clears the store.
function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const sessionStart = captured.events.get("session_start")?.[0];
	const sessionShutdown = captured.events.get("session_shutdown")?.[0];
	const tool = captured.tools.get("todo");
	const cmd = captured.commands.get("todos");
	if (!sessionStart) throw new Error("session_start handler not registered");
	if (!sessionShutdown) throw new Error("session_shutdown handler not registered");
	if (!tool) throw new Error("todo tool not registered");
	if (!cmd) throw new Error("todos command not registered");
	return { sessionStart, sessionShutdown, tool, cmd };
}

beforeEach(() => __resetState());
afterEach(() => __resetState());

describe("rpiv-todo — per-session todo store isolation (Phase 1 baseline)", () => {
	it("a child session_start (empty branch) leaves the parent's committed task intact", async () => {
		const { sessionStart, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		// Parent comes online (empty branch → EMPTY_STATE in the parent slot) and
		// creates a task.
		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);

		// A child session starts (empty branch). Its replay writes the CHILD slot
		// only — the parent slot is untouched.
		await sessionStart({} as never, child as never);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);
		expect(getState("child").tasks).toEqual([]);
	});

	it("a child todo call mutates only the child's slot; the parent's /todos still shows only the parent's task", async () => {
		const { sessionStart, tool, cmd } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		await sessionStart({} as never, child as never);

		// Child creates its own task → lands in the CHILD slot only.
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "child-task" } as never,
			undefined as never,
			undefined as never,
			child as never,
		);
		expect(getState("child").tasks.map((t) => t.subject)).toEqual(["child-task"]);
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["parent-task"]);

		// Parent's /todos reads the parent slot — shows only the parent's task.
		await cmd.handler("", parent as never);
		const parentNotify = parent.ui.notify as ReturnType<typeof vi.fn>;
		expect(parentNotify).toHaveBeenCalledTimes(1);
		expect(parentNotify.mock.calls[0][1]).toBe("info");
		expect(parentNotify.mock.calls[0][0]).toContain("parent-task");
		expect(parentNotify.mock.calls[0][0]).not.toContain("child-task");

		// Child's /todos reads the child slot — shows only the child's task.
		await cmd.handler("", child as never);
		const childNotify = child.ui.notify as ReturnType<typeof vi.fn>;
		expect(childNotify.mock.calls[0][0]).toContain("child-task");
		expect(childNotify.mock.calls[0][0]).not.toContain("parent-task");
	});

	it("the render pointer stays on the parent slot even after a child creates tasks (creator-ownership)", async () => {
		const { sessionStart, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);

		// Child comes online and creates a task in its own slot.
		await sessionStart({} as never, child as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "child-task" } as never,
			undefined as never,
			undefined as never,
			child as never,
		);

		// Creator-ownership: the render slot is still the parent's. The first UI
		// session claims the pointer before lazy overlay loading, and a child cannot
		// re-set it.
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent-task"]);
		// Sanity: the child's task DID land in its own slot.
		expect(getState("child").tasks.map((t) => t.subject)).toEqual(["child-task"]);
	});

	it("session_shutdown evicts the shutting-down session's own slot (fresh EMPTY_STATE copy)", async () => {
		const { sessionStart, sessionShutdown, tool } = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });

		await sessionStart({} as never, parent as never);
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "parent-task" } as never,
			undefined as never,
			undefined as never,
			parent as never,
		);
		expect(getState("parent").tasks).toHaveLength(1);

		await sessionShutdown({} as never, parent as never);

		// Slot evicted; a subsequent read returns a fresh EMPTY_STATE copy.
		const after = getState("parent");
		expect(after.tasks).toEqual([]);
		expect(after.nextId).toBe(1);
		expect(after.tasks).not.toBe(EMPTY_STATE.tasks);
	});
});

describe("rpiv-todo — foreground overlay policy (Slice 2)", () => {
	const PARENT = "parent-session";
	const CHILD = "child-session";
	const WIDGET_KEY = "rpiv-todos";

	function widgetSpy(ctx: ReturnType<typeof createMockCtx>) {
		return ctx.ui.setWidget as unknown as ReturnType<typeof vi.fn>;
	}

	function setup() {
		const { pi, captured } = createMockPi();
		registerTodo(pi);
		const start = captured.events.get("session_start")?.[0] as
			| ((e: unknown, ctx: unknown) => Promise<void>)
			| undefined;
		const shutdown = captured.events.get("session_shutdown")?.[0] as
			| ((e: unknown, ctx: unknown) => Promise<void>)
			| undefined;
		const toolEnd = captured.events.get("tool_execution_end")?.[0] as
			| ((event: { toolName: string; isError: boolean }) => Promise<void>)
			| undefined;
		const tool = captured.tools.get("todo");
		return { captured, start, shutdown, toolEnd, tool };
	}

	it("first hasUI session_start claims the foreground and renders its slot", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });

		await start?.({}, parentCtx);
		expect(getActiveRenderSession()).toBe(PARENT);

		// Create a parent task; pump tool_execution_end so the overlay renders it.
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Overlay registered a widget on the parent ui and renders the parent slot.
		expect(widgetSpy(parentCtx)).toHaveBeenCalled();
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
	});

	it("a child session_start (distinct sid, hasUI) does not claim foreground or rebind the overlay", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child session_start — distinct sid, hasUI true, its own ui. It binds its
		// own slot but has no tasks, so nothing is drawn on its ui.
		await start?.({}, childCtx);

		// Foreground unchanged; overlay still renders the parent slot.
		expect(getActiveRenderSession()).toBe(PARENT);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
		// No child tasks → no widget on the child ui, and the parent's stays.
		expect(widgetSpy(childCtx)).not.toHaveBeenCalled();
		expect(widgetSpy(parentCtx)).not.toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("a child todo call writes the child's slot; the overlay still shows the parent's todos", async () => {
		const { start, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child starts with its own ui and runs its own todo.
		await start?.({}, childCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "child task" } as never,
			undefined as never,
			undefined as never,
			childCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child slot holds the child task; the render pointer (renderCall) stays on
		// the parent. A child with its own ui draws its own widget.
		expect(getState(CHILD).tasks.map((t) => t.subject)).toEqual(["child task"]);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
		expect(widgetSpy(childCtx)).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
	});

	it("a child session_shutdown does not dispose the foreground overlay", async () => {
		const { start, shutdown, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		const childCtx = createMockCtx({ hasUI: true, sessionId: CHILD });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// Child shuts down — distinct sid; the teardown gate skips it.
		await shutdown?.({}, childCtx);

		// Foreground pointer + parent slot intact; no dispose call on the parent ui.
		expect(getActiveRenderSession()).toBe(PARENT);
		expect(getRenderState().tasks.map((t) => t.subject)).toEqual(["parent task"]);
		expect(widgetSpy(parentCtx)).not.toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("the foreground's own session_shutdown disposes the overlay and clears foreground", async () => {
		const { start, shutdown, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		await shutdown?.({}, parentCtx);

		// Dispose path fires setWidget(KEY, undefined); pointer cleared; slot evicted.
		expect(widgetSpy(parentCtx)).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		expect(getActiveRenderSession()).toBe("");
		expect(getState(PARENT).tasks).toEqual([]);
	});

	it("foreground shutdown still clears the pointer + evicts the slot when dispose() throws (try/finally)", async () => {
		const { start, shutdown, toolEnd, tool } = setup();
		const parentCtx = createMockCtx({ hasUI: true, sessionId: PARENT });
		// dispose()'s first act is setWidget(KEY, undefined); simulate a stale ui
		// proxy by throwing there (registration passes a factory fn → no throw).
		widgetSpy(parentCtx).mockImplementation((_key: string, factory: unknown) => {
			if (factory === undefined) throw new Error("stale ui proxy");
		});

		await start?.({}, parentCtx);
		await tool?.execute?.(
			"tc",
			{ action: "create", subject: "parent task" } as never,
			undefined as never,
			undefined as never,
			parentCtx as never,
		);
		await toolEnd?.({ toolName: "todo", isError: false });

		// The dispose throw propagates (genuine errors are not swallowed), but the
		// finally guarantees the foreground pointer is cleared and the slot evicted —
		// so the next hasUI session_start can reclaim a clean foreground.
		await expect(shutdown?.({}, parentCtx)).rejects.toThrow("stale ui proxy");
		expect(getActiveRenderSession()).toBe("");
		expect(getState(PARENT).tasks).toEqual([]);
	});

	it("a headless launcher (hasUI:false) never constructs an overlay, nor does a headless child", async () => {
		const { start } = setup();
		const headlessCtx = createMockCtx({ hasUI: false, sessionId: PARENT });
		const childHeadlessCtx = createMockCtx({ hasUI: false, sessionId: CHILD });

		await start?.({}, headlessCtx);
		await start?.({}, childHeadlessCtx);

		// No foreground claimed; no widget registered on either ui.
		expect(getActiveRenderSession()).toBe("");
		expect(widgetSpy(headlessCtx)).not.toHaveBeenCalled();
		expect(widgetSpy(childHeadlessCtx)).not.toHaveBeenCalled();
	});
});

describe("rpiv-todo — one overlay per session in a multi-session host", () => {
	const WIDGET_KEY = "rpiv-todos";
	const identityTheme = { fg: (_c: string, s: string) => s } as never;
	type Ctx = ReturnType<typeof createMockCtx>;

	function widgetSpy(ctx: Ctx) {
		return ctx.ui.setWidget as unknown as ReturnType<typeof vi.fn>;
	}

	// Render the widget a session registered, the way the host would.
	function renderWidget(ctx: Ctx): string {
		const call = widgetSpy(ctx).mock.calls.find(([key, content]) => key === WIDGET_KEY && content !== undefined);
		if (!call) throw new Error("no widget registered");
		const factory = call[1] as (
			tui: { requestRender: () => void },
			theme: never,
		) => { render: (width: number) => string[] };
		return factory({ requestRender: () => {} }, identityTheme)
			.render(200)
			.join("\n");
	}

	// Pi calls the extension factory once per session runner: every session gets
	// its own closure, and only the module state (the store) is shared.
	function runner() {
		const { pi, captured } = createMockPi();
		registerTodo(pi);
		const start = captured.events.get("session_start")?.[0] as (e: unknown, ctx: unknown) => Promise<void>;
		const shutdown = captured.events.get("session_shutdown")?.[0] as (e: unknown, ctx: unknown) => Promise<void>;
		const toolEnd = captured.events.get("tool_execution_end")?.[0] as (
			event: { toolName: string; isError: boolean },
			ctx?: unknown,
		) => Promise<void>;
		const tool = captured.tools.get("todo");
		if (!tool) throw new Error("todo tool not registered");
		const create = async (ctx: Ctx, subject: string) => {
			await tool.execute?.(
				"tc",
				{ action: "create", subject } as never,
				undefined as never,
				undefined as never,
				ctx as never,
			);
			await toolEnd({ toolName: "todo", isError: false }, ctx);
		};
		return { start, shutdown, create };
	}

	beforeEach(() => __resetState());

	it("a second session with its own ui renders its own tasks, not the first session's", async () => {
		const runA = runner();
		const runB = runner();
		const first = createMockCtx({ hasUI: true, sessionId: "first" });
		const second = createMockCtx({ hasUI: true, sessionId: "second" });

		await runA.start({}, first);
		await runB.start({}, second);
		await runA.create(first, "first task");
		await runB.create(second, "second task");

		expect(widgetSpy(first)).toHaveBeenCalledTimes(1);
		expect(widgetSpy(second)).toHaveBeenCalledTimes(1);
		expect(renderWidget(first)).toContain("first task");
		expect(renderWidget(first)).not.toContain("second task");
		expect(renderWidget(second)).toContain("second task");
		expect(renderWidget(second)).not.toContain("first task");
	});

	it("a todo call in one session does not touch another session's widget", async () => {
		const runA = runner();
		const runB = runner();
		const first = createMockCtx({ hasUI: true, sessionId: "first" });
		const second = createMockCtx({ hasUI: true, sessionId: "second" });

		await runA.start({}, first);
		await runB.start({}, second);
		await runB.create(second, "second task");

		expect(widgetSpy(first)).not.toHaveBeenCalled();
		expect(widgetSpy(second)).toHaveBeenCalledTimes(1);
	});

	it("shutting down the first session keeps the second session's widget", async () => {
		const runA = runner();
		const runB = runner();
		const first = createMockCtx({ hasUI: true, sessionId: "first" });
		const second = createMockCtx({ hasUI: true, sessionId: "second" });

		await runA.start({}, first);
		await runB.start({}, second);
		await runA.create(first, "first task");
		await runB.create(second, "second task");

		await runA.shutdown({}, first);

		expect(widgetSpy(first)).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		expect(widgetSpy(second)).not.toHaveBeenCalledWith(WIDGET_KEY, undefined);
		expect(renderWidget(second)).toContain("second task");
	});

	it("a session resumed with persisted tasks after another session shows its widget on start", async () => {
		const runA = runner();
		const runB = runner();
		const first = createMockCtx({ hasUI: true, sessionId: "first" });
		await runA.start({}, first);
		await runA.create(first, "first task");

		const resumed = createMockCtx({
			hasUI: true,
			sessionId: "resumed",
			branch: buildSessionEntries([
				makeTodoToolResult({
					action: "create",
					params: { subject: "resumed task" },
					tasks: [{ id: 1, subject: "resumed task", status: "pending" }],
					nextId: 2,
				}),
			]),
		});
		await runB.start({}, resumed);

		expect(renderWidget(resumed)).toContain("resumed task");
		expect(renderWidget(first)).not.toContain("resumed task");
	});

	it("one closure that sees two sessions still gives each its own widget", async () => {
		const run = runner();
		const first = createMockCtx({ hasUI: true, sessionId: "first" });
		const second = createMockCtx({ hasUI: true, sessionId: "second" });

		await run.start({}, first);
		await run.start({}, second);
		await run.create(first, "first task");
		await run.create(second, "second task");

		expect(renderWidget(first)).toContain("first task");
		expect(renderWidget(first)).not.toContain("second task");
		expect(renderWidget(second)).toContain("second task");
	});

	it("a child that relays the parent's ui surface never takes over the parent's widget", async () => {
		const parentRun = runner();
		const childRun = runner();
		const parent = createMockCtx({ hasUI: true, sessionId: "parent" });
		// Pi spreads the host ui per runner: a distinct object, the same setWidget.
		const child = createMockCtx({ hasUI: true, sessionId: "child" });
		(child as { ui: unknown }).ui = { ...parent.ui };

		await parentRun.start({}, parent);
		await parentRun.create(parent, "parent task");
		await childRun.start({}, child);
		await childRun.create(child, "child task");

		// Only the parent's single registration reached the shared surface.
		expect(widgetSpy(parent)).toHaveBeenCalledTimes(1);
		expect(renderWidget(parent)).toContain("parent task");
		expect(renderWidget(parent)).not.toContain("child task");

		await childRun.shutdown({}, child);
		expect(widgetSpy(parent)).not.toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("after the parent shuts down, the next session on the same surface takes it over", async () => {
		const oldRun = runner();
		const newRun = runner();
		const old = createMockCtx({ hasUI: true, sessionId: "old" });
		const next = createMockCtx({ hasUI: true, sessionId: "next" });
		(next as { ui: unknown }).ui = { ...old.ui };

		await oldRun.start({}, old);
		await oldRun.create(old, "old task");
		await oldRun.shutdown({}, old);
		await newRun.start({}, next);
		await newRun.create(next, "next task");

		const last = widgetSpy(old).mock.calls.at(-1);
		expect(last?.[0]).toBe(WIDGET_KEY);
		expect(typeof last?.[1]).toBe("function");
		const factory = last?.[1] as (t: { requestRender: () => void }, th: never) => { render: (w: number) => string[] };
		expect(
			factory({ requestRender: () => {} }, identityTheme)
				.render(200)
				.join("\n"),
		).toContain("next task");
	});
});
