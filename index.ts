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
	maxRetries: 0,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	retryQuotaErrors: false,
};

const CONTINUATION = "The previous provider request failed. Repeat it unchanged. Do not answer the user, do not call tools, do not explain the failure.";

/**
 * Allow-list: retrying cannot fix these, so they stay out of the default policy.
 * Kept in sync with pi-coding-agent's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.
 */
const NON_RETRYABLE = new RegExp([
	"GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance",
	"insufficient_quota", "out of budget", "quota exceeded", "billing",
	"subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded",
].join("|"), "i");

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function backoff(config: RetryConfig, attempt: number): number {
	const raw = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Math.min(Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER, config.maxDelayMs);
}

/**
 * Everything Pi gives up on gets another attempt, except the cases retrying cannot fix.
 * Deny-list rather than Pi's allow-list: a 400 or an unmapped upstream message is still
 * usually transient behind a routing proxy, and the retry budget bounds the cost.
 */
function shouldRetry(error: string | undefined, config: RetryConfig): boolean {
	if (!error) return false;
	if (NON_RETRYABLE.test(error)) return config.retryQuotaErrors;
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
	let lastNotified = "";

	// Settings live on `pi`, not on the event context, and are ready before any run.
	pi.on("session_start", () => {
		const settings = pi.getSettings() as { resilientRetry?: { enabled?: boolean } } & Parameters<typeof readConfig>[0];
		enabled = settings.resilientRetry?.enabled !== false;
		config = readConfig(settings);
		consecutive = 0;
		lastNotified = "";
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled || event.outcome !== "error") return undefined;
		// An explicit abort (Escape, /stop) is a user decision, never a retry.
		if (ctx.signal?.aborted) return undefined;

		const messages = event.context.contextMessages as { role: string; stopReason?: string; errorMessage?: string }[];
		const last = [...messages].reverse().find(message => message.role === "assistant");
		if (last?.stopReason !== "error" || !shouldRetry(last.errorMessage, config)) return undefined;
		if (config.maxRetries > 0 && consecutive >= config.maxRetries) return undefined;

		consecutive++;
		const delay = backoff(config, consecutive);
		if (ctx.hasUI) {
			const line = `上游报错，${Math.round(delay / 1000)}s 后重试（第 ${consecutive}${config.maxRetries > 0 ? `/${config.maxRetries}` : ""} 次）`;
			// Same text on every attempt would spam the transcript; only re-notify on change.
			if (line !== lastNotified) {
				lastNotified = line;
				ctx.ui.notify(line, "info");
			}
		}
		await sleep(delay);
		if (ctx.signal?.aborted) return undefined;

		return {
			continue: true,
			entries: [{ type: "custom_message" as const, customType: "resilient-retry", content: CONTINUATION, display: false }],
		};
	});

	// Any request that is not an error means the upstream recovered.
	pi.on("agent_end", (event) => {
		const last = event.messages.filter(message => message.role === "assistant").at(-1);
		if (last?.role === "assistant" && last.stopReason !== "error") {
			consecutive = 0;
			lastNotified = "";
		}
	});
}
