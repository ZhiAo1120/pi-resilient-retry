import { readConfig, RetryBudget, waitForRetry, repairPayload, writeRetryLog } from "./retry-core.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_TURN_LIMIT_ERROR = /session_turn_limit_exceeded/i;

function isSessionTurnLimitError(error: string | undefined): boolean {
	return typeof error === "string" && SESSION_TURN_LIMIT_ERROR.test(error);
}

/**
 * Keeps retrying provider failures that Pi's built-in retry gives up on.
 * `agent_before_settle` requests a context-only continuation; backoff runs after
 * native agent/turn start, so Pi and SDK clients show real activity while waiting.
 */

export default function registerResilientRetry(pi: ExtensionAPI): void {
	let config = readConfig(undefined);
	let policy = new RetryBudget(config);
	let shutdown = new AbortController();
	let cancelled = false;
	let retryDelay: number | undefined;
	let showingRetry = false;
	let runSignal: AbortSignal | undefined;
	let runHasUI = false;
	let abortUiListener: (() => void) | undefined;
	// Armed only while a retry this extension started is in flight.
	let repairArmed = false;
	let repairedTotal = 0;
	let turnLimitCompactionAttempted = false;
	let pendingTurnLimitCompaction: number | undefined;
	let sessionGeneration = 0;

	const debug = (entry: Record<string, unknown>) => writeRetryLog(config, entry);
	const clearUi = (ctx: ExtensionContext) => {
		if (showingRetry && ctx.hasUI) ctx.ui.setWorkingMessage();
		showingRetry = false;
	};
	const detachAbortUi = () => {
		if (abortUiListener) runSignal?.removeEventListener("abort", abortUiListener);
		abortUiListener = undefined;
	};
	pi.on("agent_start", (_event, ctx) => {
		detachAbortUi();
		runSignal = ctx.signal;
		runHasUI = ctx.hasUI;
		// Abort dispatch is synchronous, before SDK disposal invalidates this run's context.
		abortUiListener = () => clearUi(ctx);
		runSignal?.addEventListener("abort", abortUiListener, { once: true });
	});

	// The public settings getter is ready at session_start, not during factory loading.
	pi.on("session_start", () => {
		detachAbortUi();
		runSignal = undefined;
		shutdown.abort();
		shutdown = new AbortController();
		config = readConfig(pi.getSettings());
		policy = new RetryBudget(config);
		cancelled = false;
		retryDelay = undefined;
		repairArmed = false;
		repairedTotal = 0;
		turnLimitCompactionAttempted = false;
		pendingTurnLimitCompaction = undefined;
		sessionGeneration++;
		debug({ event: "session_start", enabled: config.enabled, config });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelled = true;
		retryDelay = undefined;
		repairArmed = false;
		pendingTurnLimitCompaction = undefined;
		sessionGeneration++;
		clearUi(ctx);
		if (runSignal && !runSignal.aborted) ctx.abort();
		shutdown.abort();
		detachAbortUi();
	});

	pi.on("context", async (event, ctx) => {
		const delay = retryDelay;
		retryDelay = undefined;
		if (delay !== undefined) {
			// Public agent_start AND turn_start have fired before this wait: native UI is working.
			const budget = config.maxRetries > 0 ? `/${config.maxRetries}` : "";
			if (ctx.hasUI) {
				ctx.ui.setWorkingMessage(`等待重试（第 ${policy.attempts}${budget} 次）· ${Math.round(delay / 1000)}s`);
				showingRetry = true;
			}
			debug({ event: "retry_wait_start", attempt: policy.attempts, delayMs: delay });
			const stopSignal = shutdown.signal;
			const runSignal = ctx.signal;
			const ready = await waitForRetry(delay, runSignal ? AbortSignal.any([stopSignal, runSignal]) : stopSignal);
			// A replaced session owns new state/UI; do not use its predecessor's context.
			if (stopSignal === shutdown.signal) {
				if (!ready || cancelled || runSignal?.aborted) {
					debug({ event: "retry_cancelled", attempt: policy.attempts, cancelled, aborted: runSignal?.aborted === true });
					repairArmed = false;
					// A directly disposed session has no live ctx after this await.
					if (!runSignal?.aborted) {
						if (cancelled) ctx.abort();
						clearUi(ctx);
					}
				} else {
					if (ctx.hasUI) ctx.ui.setWorkingMessage(`正在重试（第 ${policy.attempts}${budget} 次）`);
					debug({ event: "retry_request", attempt: policy.attempts });
				}
			}
		}

		// Old custom notices are identifiable before model conversion. Never filter ordinary
		// user/assistant/tool text by a package-name substring: that can erase real memory.
		const messages = event.messages.filter(message => message.role !== "custom" || message.customType !== "resilient-retry");
		return messages.length === event.messages.length ? undefined : { messages };
	});

	// Repair only the request this extension retried; normal requests retain their history.
	pi.on("before_provider_request", (event) => {
		if (!repairArmed || !config.repairHistory) return undefined;
		repairArmed = false;
		const repaired = repairPayload(event.payload);
		if (repaired) {
			repairedTotal += repaired.removed;
			debug({ event: "history_repaired", removed: repaired.removed });
			return repaired.payload;
		}
		return undefined;
	});

	pi.on("before_agent_start", event => {
		if (event.messageType === "user") turnLimitCompactionAttempted = false;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		// Disposal may invalidate ctx but still finish dispatching terminal events.
		if (runSignal?.aborted) {
			debug({ event: "agent_before_settle", decision: "skip: run aborted", aborted: true });
			return undefined;
		}
		const last = [...event.context.contextMessages].reverse().find(message => message.role === "assistant");
		const seen = {
			event: "agent_before_settle",
			outcome: event.outcome,
			stopReason: last?.stopReason,
			aborted: runSignal?.aborted === true,
			hasUI: runHasUI,
			enabled: config.enabled,
		};

		if (!config.enabled || event.outcome !== "error") {
			debug({ ...seen, decision: "skip: not an error outcome" });
			return undefined;
		}
		// An explicit host Stop is a user decision, never a retry.
		if (last?.stopReason !== "error") {
			debug({ ...seen, decision: "skip: policy declined" });
			return undefined;
		}

		// Only omit the failed request. Successful responses and tool results stay intact.
		const failed = [...event.context.contextEntries]
			.reverse()
			.find(entry => entry.messages.includes(last));
		if (!failed) {
			debug({ event: "retry_no_target", attempt: policy.attempts });
			return undefined;
		}

		if (isSessionTurnLimitError(last.errorMessage)) {
			if (turnLimitCompactionAttempted) {
				debug({ ...seen, decision: "skip: turn-limit compaction already attempted" });
				if (ctx.hasUI) ctx.ui.notify("The provider turn limit was reached again after automatic compaction. Stopping to avoid a retry loop; run /compact manually or start a new session.", "warning");
				return undefined;
			}
			turnLimitCompactionAttempted = true;
			pendingTurnLimitCompaction = sessionGeneration;
			debug({ ...seen, decision: "compact: provider turn limit" });
			return {
				entries: [...event.entries, { type: "context_edit", targetId: failed.sourceEntry.id, replacement: null }],
			};
		}

		const decision = policy.next(last.errorMessage);
		if (!decision.retry) {
			debug({ ...seen, ...decision, decision: `skip: ${decision.reason}` });
			return undefined;
		}
		debug({ ...seen, ...decision, decision: "retry" });
		retryDelay = decision.delayMs;
		repairArmed = decision.repair;
		return {
			continue: true,
			entries: [...event.entries, { type: "context_edit", targetId: failed.sourceEntry.id, replacement: null }],
		};
	});

	// Reset the consecutive-failure budget when the continued run succeeds or is aborted.
	pi.on("agent_end", (event, ctx) => {
		// Return UI ownership before SDK native backoff, whose controller is not this run signal.
		detachAbortUi();
		clearUi(ctx);
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		if (last?.role === "assistant" && last.stopReason !== "error") {
			if (policy.attempts > 0 && last.stopReason !== "aborted") {
				debug({ event: "retry_recovered", attempts: policy.attempts, repairedTotal });
			}
			policy.reset();
			repairedTotal = 0;
			detachAbortUi();
			clearUi(ctx);
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		const compactionGeneration = pendingTurnLimitCompaction;
		pendingTurnLimitCompaction = undefined;
		if (compactionGeneration !== undefined && compactionGeneration === sessionGeneration && !event.aborted && !runSignal?.aborted) {
			debug({ event: "turn_limit_compaction", decision: "started", attempt: 1 });
			const reportCompactionFailure = () => {
				if (compactionGeneration !== sessionGeneration || cancelled) return;
				debug({ event: "turn_limit_compaction", decision: "failed", attempt: 1 });
				if (ctx.hasUI) ctx.ui.notify("Automatic compaction for the provider turn limit failed. Run /compact manually before continuing.", "warning");
			};
			try {
				ctx.compact({
					customInstructions: "The latest provider request was rejected only because its conversation turn limit was reached. Preserve the user's current goal, requirements, completed work, and next steps. Do not treat the provider error as task output.",
					onComplete: () => {
						if (compactionGeneration !== sessionGeneration || cancelled) return;
						debug({ event: "turn_limit_compaction", decision: "succeeded", attempt: 1 });
						try {
							pi.sendMessage({
								customType: "resilient-retry-turn-limit",
								content: "The previous model request was rejected because the provider reached its per-conversation turn limit. The session has now been compacted. Continue the current task from the compacted checkpoint. Do not repeat successful tool calls or side effects. If the provider returns the same turn-limit error again, stop instead of retrying.",
								display: false,
							}, { triggerTurn: true });
						} catch {
							reportCompactionFailure();
						}
					},
					onError: reportCompactionFailure,
				});
			} catch {
				reportCompactionFailure();
			}
		}

		// Some adapters report an aborted request as error; the public run flag is authoritative.
		const aborted = event.aborted || runSignal?.aborted;
		if (aborted) {
			policy.reset();
			repairedTotal = 0;
		}
		retryDelay = undefined;
		repairArmed = false;
		detachAbortUi();
		if (!aborted) clearUi(ctx);
	});
}
