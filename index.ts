import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Keeps retrying a failed provider request that Pi's built-in retry refuses to retry.
 *
 * Pi retries only errors matching its retryable pattern and skips quota/billing errors.
 * Everything else — 400s, unmapped upstream errors, quota wording — ends the run.
 * This extension hooks `agent_before_settle`, the last boundary that can force one more
 * model request, and continues the run with a hidden custom message.
 */

type RetryConfig = {
	/** Cap on consecutive retries without a successful request. 0 disables the cap. */
	maxRetries: number;
	/** First backoff delay. */
	baseDelayMs: number;
	/** Backoff ceiling; every delay is clamped to this. */
	maxDelayMs: number;
	/** Also retry errors Pi classifies as quota/billing (it never retries those). */
	retryQuotaErrors: boolean;
	/**
	 * Allow dropping replay-only item ids, but only after the upstream explicitly reports that
	 * the session's items belong to a resource this node cannot resolve. Ordinary retries keep
	 * the history intact so the model keeps its memory.
	 */
	repairHistory: boolean;
	/**
	 * Stop after this many consecutive attempts that fail with the same error and never
	 * reach the model. Unlimited retries are only safe while the failure keeps changing;
	 * an identical failure repeating forever means the request itself cannot succeed.
	 */
	repeatLimit: number;
	/**
	 * Print every retry into the conversation so it is visible in the UI. The notices are
	 * stripped from the outgoing payload, so the model never pays for them.
	 */
	visibleRetry: boolean;
	/** Append a JSON line per decision to this path. Diagnoses silent non-retries. */
	debugLog?: string;
};

const DEFAULTS: RetryConfig = {
	// Unlimited by default: a relay routes each attempt to a different upstream, so a finite
	// budget can give up on a node that would have worked. The status line plus Escape bound
	// the cost of an outage.
	maxRetries: 0,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	retryQuotaErrors: false,
	repairHistory: true,
	repeatLimit: 30,
	visibleRetry: true,
};

/**
 * Quota and billing errors. Retrying usually cannot fix them, so they are opt-in.
 * Kept in sync with pi-coding-agent's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.
 */
const QUOTA = new RegExp([
	"GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance",
	"insufficient_quota", "out of budget", "quota exceeded", "billing",
	"subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded",
].join("|"), "i");

/**
 * The upstream explicitly says the session's history items belong to another resource or
 * account, so this node can never resolve them. Only then is dropping ids worth losing the
 * model's cross-turn memory: retrying the same ids would fail forever.
 *
 * Matched narrowly on purpose. A generic 400, a rate limit or an unmapped error says nothing
 * about id validity, and stripping ids for those would degrade every retry for no reason.
 */
const SESSION_IDS_DEAD = [
	/created under a different azure openai resource/i,
	/belongs to a different upstream account/i,
	/replayed conversation state belongs to a different/i,
	/(?:previous_response_id|item|session)[^.]{0,40}(?:not found|does not exist|unknown|invalid|expired)/i,
];

function sessionIdsAreDead(error: string | undefined): boolean {
	if (!error) return false;
	return SESSION_IDS_DEAD.some(pattern => pattern.test(error));
}

function backoff(config: RetryConfig, attempt: number): number {
	const raw = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER, config.maxDelayMs);
}

/**
 * A relay routes each attempt to a different upstream, so even a "deterministic" rejection
 * may succeed on the next node. Nothing is excluded on error text alone; the retry budget
 * is what bounds the cost.
 */
function shouldRetry(error: string | undefined, config: RetryConfig): boolean {
	if (!error) return false;
	if (QUOTA.test(error)) return config.retryQuotaErrors;
	return true;
}

const RETRY_MARKER = "pi-resilient-retry";

/** True for an assistant turn that produced nothing — the failed attempt being retried. */
function isFailedAttempt(item: Record<string, unknown>): boolean {
	if (item.role !== "assistant") return false;
	const content = item.content;
	if (Array.isArray(content)) return content.length === 0;
	return content === "" || content === undefined;
}

function isRetryNotice(item: Record<string, unknown>): boolean {
	if (typeof item.content === "string") return item.content.includes(RETRY_MARKER);
	return JSON.stringify(item.content ?? "").includes(RETRY_MARKER);
}

/**
 * Remove retry notices and the failed attempt from the outgoing payload. The notices stay in
 * the session so the UI can show them, but the model never sees them: the request it receives
 * is the original one, which also keeps the prompt-cache prefix stable.
 */
function stripRetryNoise(payload: unknown): { payload: unknown; removed: number } | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	let removed = 0;
	const filter = (list: unknown): unknown[] | undefined => {
		if (!Array.isArray(list)) return undefined;
		return list.filter(entry => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
			const item = entry as Record<string, unknown>;
			if (!isRetryNotice(item) && !isFailedAttempt(item)) return true;
			removed++;
			return false;
		});
	};
	const messages = filter(body.messages);
	const input = filter(body.input);
	if (!messages && !input) return undefined;
	const next = { ...body };
	if (messages) next.messages = messages;
	if (input) next.input = input;
	return removed > 0 ? { payload: next, removed } : undefined;
}

function readConfig(settings: unknown): RetryConfig {
	const raw = (settings as { resilientRetry?: Partial<RetryConfig> } | undefined)?.resilientRetry;
	const num = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
	return {
		maxRetries: num(raw?.maxRetries, DEFAULTS.maxRetries),
		baseDelayMs: num(raw?.baseDelayMs, DEFAULTS.baseDelayMs),
		maxDelayMs: num(raw?.maxDelayMs, DEFAULTS.maxDelayMs),
		retryQuotaErrors: raw?.retryQuotaErrors === true,
		repairHistory: raw?.repairHistory !== false,
		repeatLimit: num(raw?.repeatLimit, DEFAULTS.repeatLimit),
		// Accepts the legacy "first"/"always"/"never" strings too.
		visibleRetry: (raw?.visibleRetry as unknown) === false || (raw?.visibleRetry as unknown) === "never" ? false : DEFAULTS.visibleRetry,
		debugLog: typeof raw?.debugLog === "string" && raw.debugLog ? raw.debugLog : undefined,
	};
}

const REPLAYABLE_ROLES = new Set(["user", "assistant", "system", "developer"]);

/** A history item whose payload alone carries its meaning, so its id can be dropped. */
function isCompleteReplayable(item: Record<string, unknown>): boolean {
	const kind = typeof item.type === "string" ? item.type : "message";
	switch (kind) {
		case "message":
			return REPLAYABLE_ROLES.has(item.role as string) &&
				(typeof item.content === "string" || Array.isArray(item.content));
		case "function_call":
			return typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string";
		case "custom_tool_call":
			return typeof item.call_id === "string" && typeof item.name === "string" && typeof item.input === "string";
		case "function_call_output":
		case "custom_tool_call_output":
			return typeof item.call_id === "string" &&
				(typeof item.output === "string" || Array.isArray(item.output));
		default:
			return false;
	}
}

/**
 * Drop the optional `id` of complete history items so a different upstream node can accept
 * the replayed conversation. Message bodies, tool pairs, `call_id` and reasoning items all
 * survive, so the model keeps its cross-turn state.
 */
function repairPayload(payload: unknown): { payload: unknown; removed: number } | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	if (!Array.isArray(body.input)) return undefined;
	let removed = 0;
	const kept = body.input.map(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
		const item = entry as Record<string, unknown>;
		if (typeof item.id !== "string" || !item.id) return entry;
		if (item.status !== undefined && item.status !== "completed") return entry;
		if (!isCompleteReplayable(item)) return entry;
		const { id: _dropped, ...rest } = item;
		removed++;
		return rest;
	});
	return removed > 0 ? { payload: { ...body, input: kept }, removed } : undefined;
}

export default function registerResilientRetry(pi: ExtensionAPI): void {
	let consecutive = 0;
	let lastFingerprint = "";
	let sameErrorCount = 0;
	let enabled = true;
	let config = DEFAULTS;
	let cancelled = false;
	let wake: (() => void) | undefined;
	// Armed only while a retry this extension started is in flight.
	let repairArmed = false;
	let repairedTotal = 0;

	const STATUS_KEY = "resilient-retry";

	/** Records why a decision was taken; silent non-retries are otherwise unexplainable. */
	const debug = (entry: Record<string, unknown>) => {
		if (!config.debugLog) return;
		try {
			appendFileSync(config.debugLog, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
		} catch {
			// A debug sink must never break a run.
		}
	};

	const clearUi = (ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	// Settings live on `pi`, not on the event context, and are ready before any run.
	pi.on("session_start", () => {
		const settings = pi.getSettings() as { resilientRetry?: { enabled?: boolean } } & Parameters<typeof readConfig>[0];
		enabled = settings.resilientRetry?.enabled !== false;
		config = readConfig(settings);
		consecutive = 0;
		lastFingerprint = "";
		sameErrorCount = 0;
		cancelled = false;
		debug({ event: "session_start", enabled, config: { ...config, debugLog: config.debugLog } });
	});

	// A retry in flight must not swallow the user's Escape or /stop.
	pi.on("session_shutdown", () => {
		cancelled = true;
		wake?.();
	});

	// Repair only the request this extension retried, so ordinary requests keep their exact
	// history and prompt-cache prefix. Disarmed as soon as one request has been repaired.
	pi.on("before_provider_request", (event) => {
		// Notices are printed for the user but never reach the model.
		const stripped = stripRetryNoise(event.payload);
		let payload = stripped ? stripped.payload : event.payload;
		if (stripped) debug({ event: "retry_log_stripped", removed: stripped.removed });

		if (repairArmed && config.repairHistory) {
			repairArmed = false;
			const repaired = repairPayload(payload);
			if (repaired) {
				repairedTotal += repaired.removed;
				payload = repaired.payload;
				debug({ event: "history_repaired", removed: repaired.removed });
			}
		}
		return stripped || payload !== event.payload ? payload : undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const messages = event.context.contextMessages as { role: string; stopReason?: string; errorMessage?: string }[];
		const last = [...messages].reverse().find(message => message.role === "assistant");
		const seen = {
			event: "agent_before_settle",
			outcome: event.outcome,
			stopReason: last?.stopReason,
			error: (last?.errorMessage ?? "").slice(0, 160),
			aborted: ctx.signal?.aborted === true,
			hasUI: ctx.hasUI,
			enabled,
		};

		if (!enabled || event.outcome !== "error") {
			debug({ ...seen, decision: "skip: not an error outcome" });
			return undefined;
		}
		// An explicit abort (Escape, /stop) is a user decision, never a retry.
		if (ctx.signal?.aborted) {
			debug({ ...seen, decision: "skip: run aborted" });
			return undefined;
		}
		if (last?.stopReason !== "error" || !shouldRetry(last.errorMessage, config)) {
			debug({ ...seen, decision: "skip: policy declined" });
			clearUi(ctx);
			return undefined;
		}
		const fingerprint = (last.errorMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
		if (fingerprint === lastFingerprint) sameErrorCount++;
		else {
			lastFingerprint = fingerprint;
			sameErrorCount = 1;
		}
		if (config.repeatLimit > 0 && sameErrorCount > config.repeatLimit) {
			debug({ ...seen, decision: "skip: same error repeated", sameErrorCount });
			clearUi(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`同一错误已连续出现 ${sameErrorCount} 次，重试无法解决，已停止。${(last.errorMessage ?? "").slice(0, 200)}`, "error");
			}
			return undefined;
		}
		if (config.maxRetries > 0 && consecutive >= config.maxRetries) {
			debug({ ...seen, decision: "skip: budget exhausted", consecutive });
			clearUi(ctx);
			if (ctx.hasUI) ctx.ui.notify(`上游连续失败 ${consecutive} 次，已停止重试。${last.errorMessage?.slice(0, 200) ?? ""}`, "error");
			return undefined;
		}

		consecutive++;
		const delay = backoff(config, consecutive);
		const budget = config.maxRetries > 0 ? `/${config.maxRetries}` : "";
		// Only a reported dead session justifies trading memory for a replayable history.
		const deadSession = config.repairHistory && sessionIdsAreDead(last.errorMessage);
		debug({ ...seen, decision: "retry", attempt: consecutive, delayMs: delay, repair: deadSession });

		// A footer status is always visible and survives the wait, unlike a notification.
		if (ctx.hasUI) {
			const why = deadSession ? " · 会话 id 已失效，将剥离历史 id" : "";
			ctx.ui.setStatus(STATUS_KEY, `⏳ 上游报错，重试第 ${consecutive}${budget} 次 · 等待 ${Math.round(delay / 1000)}s${why} · Esc 取消`);
			ctx.ui.setWorkingMessage(`等待重试（第 ${consecutive}${budget} 次）· ${Math.round(delay / 1000)}s`);
		}

		// Sleep in slices so an abort during the wait is honoured within one slice.
		cancelled = false;
		const deadline = Date.now() + delay;
		while (Date.now() < deadline && !cancelled && !ctx.signal?.aborted) {
			const slice = Math.min(250, deadline - Date.now());
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, slice);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
		wake = undefined;
		if (cancelled || ctx.signal?.aborted) {
			debug({ event: "retry_cancelled", attempt: consecutive, cancelled, aborted: ctx.signal?.aborted === true });
			clearUi(ctx);
			return undefined;
		}

		// History stays byte-identical unless the upstream said the ids are unusable.
		repairArmed = deadSession;

		if (config.visibleRetry) {
			// One real user message makes the retry visible; Percho renders neither notify,
			// setStatus nor custom_message. Cost is one short message per outage.
			const notice = `↻ pi-resilient-retry：上游请求失败，自动重试中（第 ${consecutive}${budget} 次）${deadSession ? "，已剥离失效的历史 id" : ""}。Repeat the previous request unchanged; do not answer the user, do not call tools.`;
			try {
				await pi.sendUserMessage(notice, { deliverAs: "followUp" });
			} catch (error) {
				debug({ event: "retry_send_failed", attempt: consecutive, error: String(error).slice(0, 120) });
				clearUi(ctx);
			}
			return undefined;
		}

		// Silent retry: drop the failed attempt from model context instead of appending anything.
		// The continuation then runs from the last user turn, so a retry adds no tokens and the
		// conversation does not grow with each attempt.
		const failed = [...event.context.contextEntries]
			.reverse()
			.find(entry => entry.messages.includes(last as never));
		if (!failed) {
			debug({ event: "retry_no_target", attempt: consecutive });
			clearUi(ctx);
			return undefined;
		}
		return {
			continue: true,
			entries: [{ type: "context_edit" as const, targetId: failed.sourceEntry.id, replacement: null }],
		};
	});

	// Any request that is not an error means the upstream recovered.
	pi.on("agent_end", (event, ctx) => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		if (last?.role === "assistant" && last.stopReason !== "error") {
			if (consecutive > 0 && ctx.hasUI) {
				const repaired = repairedTotal > 0 ? `，并清理 ${repairedTotal} 个历史 id` : "";
				ctx.ui.notify(`上游已恢复（重试 ${consecutive} 次后成功${repaired}）`, "info");
				ctx.ui.setWorkingMessage();
			}
			consecutive = 0;
			repairedTotal = 0;
			lastFingerprint = "";
			sameErrorCount = 0;
			clearUi(ctx);
		}
	});
}
