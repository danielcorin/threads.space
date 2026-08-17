import { API_BASE } from './api';

export interface AgentIntegrationUrls {
	appUrl: string;
	apiBase: string;
	agentGuideUrl: string;
	apiDocsUrl: string;
	openApiUrl: string;
	wsEventsUrl: string;
}

const ONBOARDING_VERSION = 'v1';
export type AgentIntegrationPromptKind = 'generic' | 'hermes' | 'openclaw';

export interface AgentIntegrationPromptOption {
	id: AgentIntegrationPromptKind;
	label: string;
	description: string;
	prompt: string;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '');
}

function currentOrigin(): string {
	if (typeof location === 'undefined') return 'https://threads.example.com';
	return location.origin;
}

export function resolveAgentIntegrationUrls(origin = currentOrigin(), apiBase = API_BASE): AgentIntegrationUrls {
	const appUrl = trimTrailingSlash(origin);
	const absoluteApiBase = trimTrailingSlash(new URL(apiBase, `${appUrl}/`).toString());
	const agentGuideUrl = `${absoluteApiBase}/agents.txt`;

	return {
		appUrl,
		apiBase: absoluteApiBase,
		agentGuideUrl,
		apiDocsUrl: `${absoluteApiBase}/docs`,
		openApiUrl: `${absoluteApiBase}/openapi.json`,
		wsEventsUrl: `${absoluteApiBase}/ws-events.json`,
	};
}

function workspaceLines(urls: AgentIntegrationUrls): string[] {
	return [
		'Workspace:',
		`- App: ${urls.appUrl}/`,
		`- API base: ${urls.apiBase}`,
		`- Agent guide: ${urls.agentGuideUrl}`,
		`- REST OpenAPI: ${urls.openApiUrl}`,
		`- WebSocket events: ${urls.wsEventsUrl}`,
		`- API docs: ${urls.apiDocsUrl}`,
	];
}

function verificationLines(): string[] {
	return [
		'Verification:',
		'1. Prove the bot credential with GET /users/me.',
		'2. Send or ask me to send a human test message in Threads.',
		'3. Verify through the public Threads API that the trigger message was stamped with the process as status "processing", the UI status indicator clears to a terminal status, and a final message_type "response" has metadata.trigger_id.',
		'4. If the framework exposes tools, run one harmless terminal/shell command and verify a grouped tool_output row, full tool body, process tool_call activity, and final reply.',
	];
}

function securityLines(): string[] {
	return [
		'Security rules:',
		'- Do not store my admin token in source code, config files, shell history, or logs.',
		'- Do not print, log, or commit admin tokens, bot runtime tokens, passwords, or full environment dumps.',
		'- Store runtime tokens only in the framework secret/config store or environment variables.',
		'- If credentials are missing, ask me for the minimum credential needed instead of guessing.',
	];
}

function buildGenericPrompt(urls: AgentIntegrationUrls): string {
	return [
		'You are implementing Threads compatibility for an agent framework.',
		'',
		...workspaceLines(urls),
		'',
		'Goal: build a production-quality, framework-native Threads integration for the agent I point you at.',
		'',
		`First fetch and read ${urls.agentGuideUrl}. Treat it as the source of truth. Use ${urls.openApiUrl} and ${urls.wsEventsUrl} for exact schemas.`,
		'',
		'Implementation requirements:',
		'1. Use the framework native extension surface first: platform adapter, channel plugin, bot runtime plugin, connector, or equivalent.',
		'2. Do not implement a generic OpenAI-compatible bridge unless the framework has no native messaging/plugin/channel API. If blocked, write down the exact missing API, command, class, hook, or lifecycle event.',
		'3. Use an admin API token only to provision or reuse a bot user, mint the bot runtime token, and add the bot to a test channel. If I have not provided an admin token yet, ask me to create one in Threads Settings -> Developer -> API token.',
		'4. At runtime authenticate only as the bot with Authorization: Bearer <bot-token>.',
		`5. On startup, POST ${urls.apiBase}/processes/cleanup-by-bot before opening one WebSocket connection to ${urls.apiBase}/events; send {"type":"ping"} keepalives and reconnect with backoff.`,
		'6. Ignore your own messages and non-human message types. In channels respond on mention, autoRespondBotId, or explicit test mode; in DMs respond to human messages.',
		'7. Send final answers over REST with message_type "response" and metadata.trigger_id set to the triggering message id.',
		'8. Wrap accepted turns in Threads Processes API: create the process, immediately stamp the trigger message with POST /messages/:id/process status "processing" so the visible status indicator appears, record reply/tool/token activity when available, and close done/error/killed.',
		'9. Map real native tool/progress/thinking hooks to tool_output, progress, or thinking rows. Do not invent fake tool calls from generic status text.',
		'10. Listen for process_kill and cancel the framework run when the framework exposes cancellation.',
		'',
		...verificationLines(),
		'',
		...securityLines(),
		'',
		`If anything here conflicts with ${urls.agentGuideUrl} or ${urls.apiDocsUrl}, follow the hosted Threads docs.`,
	].join('\n');
}

function buildHermesPrompt(urls: AgentIntegrationUrls): string {
	return [
		'You are implementing Threads as a native Hermes Agent gateway platform.',
		'',
		...workspaceLines(urls),
		'',
		`First fetch and read ${urls.agentGuideUrl}. Use ${urls.openApiUrl} and ${urls.wsEventsUrl} for exact schemas.`,
		'',
		'Hermes-specific requirements:',
		'1. Build a Hermes platform plugin, not an external OpenAI-compatible bridge.',
		'2. Use the installed Hermes plugin docs/types for this Hermes version.',
		'3. Install into the Hermes user plugin root, commonly ~/.hermes/plugins/platforms/threads/, $HERMES_HOME/plugins/platforms/threads/, or the configured Hermes data/plugin directory.',
		'4. Include plugin.yaml with kind: platform.',
		'5. Implement a gateway.platforms.base.BasePlatformAdapter adapter.',
		'6. On startup, POST /processes/cleanup-by-bot with the bot token before connect() opens Threads /events; then filter accepted human messages and forward them through the native inbound message path.',
		'7. send(...) translates Hermes final outbound messages to Threads REST messages/replies with message_type "response" and metadata.trigger_id.',
		'8. Implement edit_message(...). Hermes uses editable progress bubbles for tool progress; leaving the base edit_message in place can drop or mis-group tool traces.',
		'9. Create a Threads process before handing the turn to Hermes, then immediately call POST /messages/:id/process with status "processing" for the triggering message so the Threads status indicator appears. Record reply/tool/token activity when available and close the process accurately.',
		'10. Map real Hermes tool progress to tool_output or thinking. Keep generic status/refusal/provider errors as progress or an error response; do not count them as tool calls.',
		'11. When using OpenRouter Anthropic models, set an explicit Hermes model.max_tokens cap such as 8192 unless the operator intentionally configured a larger budget.',
		'12. Configure Threads display progress when possible: display.platforms.threads.tool_progress: verbose and display.platforms.threads.tool_preview_length: 0, so tool bodies are not truncated before Threads receives them.',
		'13. Register the platform with ctx.register_platform(name="threads", ...) and env-driven enablement for THREADS_API_URL, THREADS_BOT_TOKEN, THREADS_BOT_USER_ID, THREADS_BOT_USERNAME, and optional THREADS_HOME_CHANNEL.',
		'',
		...verificationLines(),
		'',
		...securityLines(),
	].join('\n');
}

function buildOpenClawPrompt(urls: AgentIntegrationUrls): string {
	return [
		'You are implementing Threads as a native OpenClaw channel plugin.',
		'',
		...workspaceLines(urls),
		'',
		`First fetch and read ${urls.agentGuideUrl}. Use ${urls.openApiUrl} and ${urls.wsEventsUrl} for exact schemas.`,
		'',
		'OpenClaw-specific requirements:',
		'1. Build a channel plugin, not an external OpenAI-compatible bridge.',
		'2. Use the installed OpenClaw channel plugin SDK/docs/types for this OpenClaw version.',
		'3. Include openclaw.plugin.json with channels: ["threads"].',
		'4. Include package.json with OpenClaw extension metadata pointing to the built module.',
		'5. Resolve channel account config from OpenClaw config first, falling back to THREADS_API_URL, THREADS_BOT_TOKEN, THREADS_BOT_USER_ID, THREADS_BOT_USERNAME, THREADS_CHANNEL_ID, and THREADS_HOME_CHANNEL.',
		'6. On startup, POST /processes/cleanup-by-bot with the bot token before inbound holds one Threads /events WebSocket and submits accepted human messages into OpenClaw native channel ingress/runtime.',
		'7. Use stable conversation/thread keys from Threads room/channel/thread identity, for example threads:<room.type>:<room.id> and event.threadId || event.id.',
		'8. Use OpenClaw mention/channel helpers when available; do not rely on text parsing alone when Threads provides mentions and autoRespondBotId.',
		'9. Outbound sends OpenClaw final responses back to Threads REST with message_type "response" and metadata.trigger_id.',
		'10. Wrap each accepted turn in Threads Processes API, immediately stamp the trigger message with POST /messages/:id/process status "processing" for the visible status indicator, and close status accurately.',
		'11. Wire dispatcher/run callbacks on the object the installed runtime actually consumes. Verify callbacks fire during a real tool run.',
		'12. Use callbacks such as onToolStart, onItemEvent, onPlanUpdate, onCommandOutput, onPatchSummary, and onReasoningStream when available.',
		'13. De-duplicate repeated lifecycle callbacks. Keep generic notices such as "Reply started" as progress, not tool_output. Count only real tool/command callbacks as Threads tool_call activity.',
		'14. If the selected model is an OpenRouter model with a very large discovered output cap, pin provider catalog metadata to a sane maxTokens value such as 8192 for validation.',
		'15. Enable/pin the plugin using the current OpenClaw plugin install mechanism and verify with the framework plugin inspection command.',
		'',
		...verificationLines(),
		'',
		...securityLines(),
	].join('\n');
}

export function buildAgentIntegrationPrompts(urls = resolveAgentIntegrationUrls()): AgentIntegrationPromptOption[] {
	return [
		{
			id: 'generic',
			label: 'Generic',
			description: 'Use with Codex, Claude Code, or another coding agent when the framework is not Hermes or OpenClaw.',
			prompt: buildGenericPrompt(urls),
		},
		{
			id: 'hermes',
			label: 'Hermes',
			description: 'Builds a Hermes gateway platform adapter with process and tool-progress reporting.',
			prompt: buildHermesPrompt(urls),
		},
		{
			id: 'openclaw',
			label: 'OpenClaw',
			description: 'Builds an OpenClaw channel plugin with native runtime callbacks and Threads traces.',
			prompt: buildOpenClawPrompt(urls),
		},
	];
}

export function buildAgentIntegrationPrompt(urls = resolveAgentIntegrationUrls(), kind: AgentIntegrationPromptKind = 'generic'): string {
	return buildAgentIntegrationPrompts(urls).find((option) => option.id === kind)?.prompt ?? buildGenericPrompt(urls);
}

export function agentOnboardingSeenKey(userId: string, host = typeof location === 'undefined' ? 'unknown-host' : location.host): string {
	return `threads.agentOnboarding.seen.${ONBOARDING_VERSION}.${host}.${userId}`;
}

export function hasSeenAgentOnboarding(userId: string): boolean {
	if (typeof localStorage === 'undefined') return false;
	try {
		return localStorage.getItem(agentOnboardingSeenKey(userId)) === '1';
	} catch {
		return false;
	}
}

export function markAgentOnboardingSeen(userId: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(agentOnboardingSeenKey(userId), '1');
	} catch {
		// Non-fatal: the modal can still close for this session.
	}
}
