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
};

const DEFAULTS: RetryConfig = {
	// A finite default: an unlimited retry on a failure the upstream repeats forever turns
	// one bad request into an unbounded request storm. Raise it when you mean it.
	maxRetries: 20,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	retryQuotaErrors: false,
};

const CONTINUATION = "The previous provider request failed. Repeat it unchanged. Do not answer the user, do not call tools, do not explain the failure.";

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
 * Deterministic rejections: the identical request fails identically every time, so a retry
 * only burns time and tokens. Observed in the wild as a pooled upstream answering with a
 * different resource than the one that minted the conversation history.
 */
const DETERMINISTIC = new RegExp([
	"created under a different azure openai resource",
	"belongs to a different upstream account",
	"invalid_request_error", "invalid api key", "unauthorized", "authentication", "permission_denied",
	"context_length_exceeded", "maximum context length",
].join("|"), "i");

function backoff(config: RetryConfig, attempt: number): number {
	const raw = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER, config.maxDelayMs);
}

/**
 * Pi gives up on far more than it retries. This extension picks up what Pi refuses, except
 * failures where repeating the identical request cannot change the outcome.
 * Deny-list rather than Pi's allow-list, because an unmapped upstream message is usually
 * still transient behind a routing proxy, and the retry budget bounds the cost.
 */
function shouldRetry(error: string | undefined, config: RetryConfig): boolean {
	if (!error) return false;
	if (DETERMINISTIC.test(error)) return false;
	if (QUOTA.test(error)) return config.retryQuotaErrors;
	return true;
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
	};
}

export default function registerResilientRetry(pi: ExtensionAPI): void {
	let consecutive = 0;
	let enabled = true;
	let config = DEFAULTS;
	let cancelled = false;
	let wake: (() => void) | undefined;

	const STATUS_KEY = "resilient-retry";

	const clearUi = (ctx: { hasUI: boolean; ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	// Settings live on `pi`, not on the event context, and are ready before any run.
	pi.on("session_start", () => {
		const settings = pi.getSettings() as { resilientRetry?: { enabled?: boolean } } & Parameters<typeof readConfig>[0];
		enabled = settings.resilientRetry?.enabled !== false;
		config = readConfig(settings);
		consecutive = 0;
		cancelled = false;
	});

	// A retry in flight must not swallow the user's Escape or /stop.
	pi.on("session_shutdown", () => {
		cancelled = true;
		wake?.();
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled || event.outcome !== "error") return undefined;
		// An explicit abort (Escape, /stop) is a user decision, never a retry.
		if (ctx.signal?.aborted) return undefined;

		const messages = event.context.contextMessages as { role: string; stopReason?: string; errorMessage?: string }[];
		const last = [...messages].reverse().find(message => message.role === "assistant");
		if (last?.stopReason !== "error" || !shouldRetry(last.errorMessage, config)) {
			clearUi(ctx);
			return undefined;
		}
		if (config.maxRetries > 0 && consecutive >= config.maxRetries) {
			clearUi(ctx);
			if (ctx.hasUI) ctx.ui.notify(`上游连续失败 ${consecutive} 次，已停止重试。${last.errorMessage?.slice(0, 200) ?? ""}`, "error");
			return undefined;
		}

		consecutive++;
		const delay = backoff(config, consecutive);
		const budget = config.maxRetries > 0 ? `/${config.maxRetries}` : "";

		// A footer status is always visible and survives the wait, unlike a notification.
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, `⏳ 上游报错，重试第 ${consecutive}${budget} 次 · 等待 ${Math.round(delay / 1000)}s · Esc 取消`);
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
			clearUi(ctx);
			return undefined;
		}

		return {
			continue: true,
			entries: [{ type: "custom_message" as const, customType: "resilient-retry", content: CONTINUATION, display: false }],
		};
	});

	// Any request that is not an error means the upstream recovered.
	pi.on("agent_end", (event, ctx) => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		if (last?.role === "assistant" && last.stopReason !== "error") {
			if (consecutive > 0 && ctx.hasUI) {
				ctx.ui.notify(`上游已恢复（重试 ${consecutive} 次后成功）`, "info");
				ctx.ui.setWorkingMessage();
			}
			consecutive = 0;
			clearUi(ctx);
		}
	});
}
