import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

/** Plugin budget/settings, deliberately separate from Pi's native retry policy. */
export type RetryConfig = {
	enabled: boolean;
	/** Consecutive continuations without success; 0 is unlimited. */
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	retryQuotaErrors: boolean;
	repairHistory: boolean;
	/** Consecutive identical terminal failures; 0 disables this guard. */
	repeatLimit: number;
	debugLog?: string;
};

const DEFAULTS: RetryConfig = {
	enabled: true, maxRetries: 0, baseDelayMs: 2000, maxDelayMs: 60000,
	retryQuotaErrors: false, repairHistory: true, repeatLimit: 30,
};

export function readConfig(settings: unknown): RetryConfig {
	const raw = (settings as { resilientRetry?: Partial<RetryConfig> } | undefined)?.resilientRetry;
	const num = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
	return {
		enabled: raw?.enabled !== false,
		maxRetries: num(raw?.maxRetries, DEFAULTS.maxRetries),
		baseDelayMs: num(raw?.baseDelayMs, DEFAULTS.baseDelayMs),
		maxDelayMs: num(raw?.maxDelayMs, DEFAULTS.maxDelayMs),
		retryQuotaErrors: raw?.retryQuotaErrors === true,
		repairHistory: raw?.repairHistory !== false,
		repeatLimit: num(raw?.repeatLimit, DEFAULTS.repeatLimit),
		debugLog: typeof raw?.debugLog === "string" && raw.debugLog ? raw.debugLog : undefined,
	};
}

// Pi's non-retryable quota/billing errors remain opt-in for this fallback policy.
const QUOTA = new RegExp([
	"GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance",
	"insufficient_quota", "out of budget", "quota exceeded", "billing",
	"subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded",
].join("|"), "i");

// An ordinary 400/503 says nothing about replay-ID validity. Only explicit loss arms repair.
const SESSION_IDS_DEAD = [
	/created under a different azure openai resource/i,
	/belongs to a different upstream account/i,
	/replayed conversation state belongs to a different/i,
	/(?:previous_response_id|item|session)[^.]{0,40}(?:not found|does not exist|unknown|invalid|expired)/i,
];

function backoff(config: RetryConfig, attempt: number): number {
	if (config.baseDelayMs === 0) return 0;
	const ceiling = Math.min(Number.MAX_SAFE_INTEGER, config.maxDelayMs);
	let delay = Math.min(config.baseDelayMs, ceiling);
	// Saturate while doubling: avoid an overflowing exponent times a tiny finite base.
	for (let n = 1; n < attempt && delay < ceiling; n++) delay = Math.min(delay * 2, ceiling);
	return delay;
}

type DecisionState = { attempt: number; sameErrorCount: number; errorFingerprint?: string };
export type RetryDecision = DecisionState & (
	| { retry: true; delayMs: number; repair: boolean }
	| { retry: false; reason: "disabled" | "policy declined" | "same error repeated" | "budget exhausted" }
);

/** One budget per owning session: only terminal failures after Pi recovery consume it. */
export class RetryBudget {
	readonly config: RetryConfig;
	private consecutive = 0;
	private lastFingerprint = "";
	private sameErrorCount = 0;

	constructor(config: RetryConfig) {
		this.config = Object.freeze({ ...config });
	}

	get attempts(): number { return this.consecutive; }

	reset(): void {
		this.consecutive = 0;
		this.lastFingerprint = "";
		this.sameErrorCount = 0;
	}

	next(error: string | undefined): RetryDecision {
		const fingerprint = error
			? createHash("sha256").update(error.replace(/\s+/g, " ").trim()).digest("hex")
			: undefined;
		const decline = (reason: Extract<RetryDecision, { retry: false }>["reason"]): RetryDecision => ({
			retry: false, reason, attempt: this.consecutive, sameErrorCount: this.sameErrorCount, errorFingerprint: fingerprint,
		});
		if (!this.config.enabled) return decline("disabled");
		if (!error || (QUOTA.test(error) && !this.config.retryQuotaErrors)) return decline("policy declined");
		if (fingerprint === this.lastFingerprint) this.sameErrorCount++;
		else { this.lastFingerprint = fingerprint!; this.sameErrorCount = 1; }
		if (this.config.repeatLimit > 0 && this.sameErrorCount > this.config.repeatLimit) return decline("same error repeated");
		if (this.config.maxRetries > 0 && this.consecutive >= this.config.maxRetries) return decline("budget exhausted");
		this.consecutive++;
		return {
			retry: true, attempt: this.consecutive, sameErrorCount: this.sameErrorCount, errorFingerprint: fingerprint,
			delayMs: backoff(this.config, this.consecutive),
			repair: this.config.repairHistory && SESSION_IDS_DEAD.some(pattern => pattern.test(error)),
		};
	}
}

/** Abortable, monotonic wait; timer chunks avoid Node's 32-bit timeout overflow. */
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (!Number.isFinite(delayMs) || delayMs < 0) return Promise.reject(new RangeError("Invalid retry delay"));
	if (signal?.aborted) return Promise.resolve(false);
	if (delayMs === 0) return Promise.resolve(true);
	return new Promise(resolve => {
		const deadline = performance.now() + delayMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (ready: boolean) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve(ready);
		};
		const abort = () => finish(false);
		const tick = () => {
			const remaining = deadline - performance.now();
			if (remaining <= 0) finish(true);
			else timer = setTimeout(tick, Math.min(remaining, 2147483647));
		};
		signal?.addEventListener("abort", abort, { once: true });
		tick();
	});
}

const REPLAYABLE_ROLES = new Set(["user", "assistant", "system", "developer"]);
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
			return typeof item.call_id === "string" && (typeof item.output === "string" || Array.isArray(item.output));
		default:
			return false;
	}
}

/** Request copy only: drop optional IDs of complete items, never their bodies or call IDs. */
export function repairPayload(payload: unknown): { payload: unknown; removed: number } | undefined {
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

const LOG_LABELS = {
	event: new Set(["session_start", "agent_before_settle", "retry_wait_start", "retry_cancelled", "retry_request",
		"history_repaired", "retry_no_target", "retry_recovered"]),
	decision: new Set(["retry", "skip: not an error outcome", "skip: run aborted", "skip: policy declined",
		"skip: same error repeated", "skip: budget exhausted", "skip: disabled"]),
	outcome: new Set(["completed", "error", "aborted"]),
	stopReason: new Set(["stop", "length", "toolUse", "error", "aborted"]),
};

/** Best-effort metadata only: never persist raw errors, payloads, headers, keys or paths. */
export function writeRetryLog(config: RetryConfig, entry: Record<string, unknown>): void {
	if (!config.debugLog) return;
	try {
		if (typeof entry.event !== "string" || !LOG_LABELS.event.has(entry.event)) return;
		const safe: Record<string, unknown> = {};
		for (const [key, values] of Object.entries(LOG_LABELS)) {
			if (typeof entry[key] === "string" && values.has(entry[key])) safe[key] = entry[key];
		}
		for (const key of ["attempt", "attempts", "sameErrorCount", "delayMs", "removed", "repairedTotal"]) {
			const value = entry[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
		}
		for (const key of ["enabled", "hasUI", "aborted", "cancelled", "repair"]) {
			if (typeof entry[key] === "boolean") safe[key] = entry[key];
		}
		if (typeof entry.errorFingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.errorFingerprint)) {
			safe.errorFingerprint = entry.errorFingerprint;
		}
		if (entry.event === "session_start") {
			const { enabled, maxRetries, baseDelayMs, maxDelayMs, retryQuotaErrors, repairHistory, repeatLimit } = config;
			safe.config = { enabled, maxRetries, baseDelayMs, maxDelayMs, retryQuotaErrors, repairHistory, repeatLimit };
		}
		appendFileSync(config.debugLog, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...safe })}\n`, { mode: 0o600 });
	} catch {
		// Logging cannot prevent a continuation or cancellation.
	}
}
