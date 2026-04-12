/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

interface CodexConfigDefaults {
  providerName?: string;
  providerLabel?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: string;
}

interface CodexConfigProviderOverride {
  name?: string;
  base_url?: string;
  wire_api?: string;
  env_key?: string;
}

interface CodexConfigOverrides {
  model_provider?: string;
  model_providers?: Record<string, CodexConfigProviderOverride>;
  features?: {
    plugins?: boolean;
  };
}

const CODEX_HOME_SEED_FILES = ['config.toml', 'auth.json', 'cap_sid'];
const DEFAULT_CODEX_FIRST_EVENT_TIMEOUT_MS = 45_000;
const DEFAULT_CODEX_IDLE_TIMEOUT_MS = 5 * 60_000;

type StreamItemState = {
  announcedToolUses: Set<string>;
  insertedCommandBlocks: Set<string>;
};

function createStreamItemState(): StreamItemState {
  return {
    announcedToolUses: new Set<string>(),
    insertedCommandBlocks: new Set<string>(),
  };
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCodexFirstEventTimeoutMs(): number {
  return parsePositiveIntEnv('CTI_CODEX_FIRST_EVENT_TIMEOUT_MS', DEFAULT_CODEX_FIRST_EVENT_TIMEOUT_MS);
}

function getCodexIdleTimeoutMs(): number {
  return parsePositiveIntEnv('CTI_CODEX_IDLE_TIMEOUT_MS', DEFAULT_CODEX_IDLE_TIMEOUT_MS);
}

function formatTimeoutMs(timeoutMs: number): string {
  if (timeoutMs < 60_000) {
    return `${Math.max(1, Math.round(timeoutMs / 1000))}s`;
  }
  const minutes = Math.floor(timeoutMs / 60_000);
  const seconds = Math.round((timeoutMs % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function resolveSandboxMode(): string {
  return process.env.CTI_CODEX_SANDBOX_MODE || 'workspace-write';
}

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  if (process.env.CTI_CODEX_APPROVAL_POLICY) {
    return process.env.CTI_CODEX_APPROVAL_POLICY;
  }
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

function shouldDisableCodexPlugins(): boolean {
  return process.env.CTI_CODEX_DISABLE_PLUGINS !== 'false';
}

function shouldForceGlobalCodexProvider(): boolean {
  return process.env.CTI_CODEX_FORCE_GLOBAL_PROVIDER !== 'false';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldIsolateCodexHome(): boolean {
  return process.env.CTI_CODEX_ISOLATE_HOME !== 'false';
}

function resolveConfiguredCodexHomePath(): string {
  const ctiHome = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
  return process.env.CTI_CODEX_HOME || path.join(ctiHome, 'codex-home');
}

function resolveUserCodexHomePath(): string {
  return path.join(os.homedir(), '.codex');
}

function resolveEffectiveCodexHomePath(): string {
  if (!shouldIsolateCodexHome()) {
    return process.env.CODEX_HOME || process.env.CTI_CODEX_HOME || resolveUserCodexHomePath();
  }
  return resolveConfiguredCodexHomePath();
}

function ensureIsolatedCodexHome(): string {
  const codexHome = resolveConfiguredCodexHomePath();
  const userCodexHome = resolveUserCodexHomePath();
  fs.mkdirSync(codexHome, { recursive: true });

  for (const fileName of CODEX_HOME_SEED_FILES) {
    const sourcePath = path.join(userCodexHome, fileName);
    const targetPath = path.join(codexHome, fileName);
    if (!fs.existsSync(sourcePath)) continue;

    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch {
      // Best effort: the bridge can still rely on env-based auth.
    }
  }

  return codexHome;
}

function buildCodexProcessEnv(apiKey?: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  if (shouldIsolateCodexHome()) {
    env.CODEX_HOME = ensureIsolatedCodexHome();
  } else {
    env.CODEX_HOME = resolveEffectiveCodexHomePath();
  }

  // Some project-local Codex configs require OPENAI_API_KEY even when the bridge
  // resolved a compatible key from another env var such as LOCAL_OPENAI_API_KEY.
  if (apiKey) {
    if (!env.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = apiKey;
    }
    env.CTI_CODEX_BRIDGE_API_KEY = apiKey;
  }

  return env;
}

function listExecutableCandidates(command: string): string[] {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return `${result.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isSdkManagedCandidate(candidate: string): boolean {
  const normalized = candidate.toLowerCase().replaceAll('/', path.sep);
  return normalized.includes(`${path.sep}node_modules${path.sep}@openai${path.sep}codex-sdk${path.sep}`);
}

function isWindowsStoreAlias(candidate: string): boolean {
  const normalized = candidate.toLowerCase().replaceAll('/', path.sep);
  return normalized.includes(`${path.sep}windowsapps${path.sep}`);
}

function isSpawnableCodexCandidate(candidate: string): boolean {
  try {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveGlobalCodexExecutablePath(): string | undefined {
  const envOverride = process.env.CTI_CODEX_EXECUTABLE || process.env.CODEX_EXECUTABLE;
  if (envOverride && fs.existsSync(envOverride) && isSpawnableCodexCandidate(envOverride)) {
    return envOverride;
  }

  if (process.platform === 'win32') {
    const exeCandidates = listExecutableCandidates('codex.exe');
    const preferredExe = exeCandidates.find((candidate) => (
      candidate.toLowerCase().endsWith('codex.exe')
      && !isWindowsStoreAlias(candidate)
      && !isSdkManagedCandidate(candidate)
      && isSpawnableCodexCandidate(candidate)
    ));
    if (preferredExe) return preferredExe;

    // On Windows, PATH often resolves to non-spawnable shims or WindowsApps aliases.
    // Falling back to the SDK-managed binary is more reliable than forcing an override.
    return undefined;
  }

  const plainCandidates = listExecutableCandidates('codex');
  const preferredPlain = plainCandidates.find((candidate) => {
    return !isSdkManagedCandidate(candidate) && isSpawnableCodexCandidate(candidate);
  });
  return preferredPlain || undefined;
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function shouldResetThreadStateOnError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    shouldRetryFreshThread(message) ||
    lower.includes('apply_patch verification failed') ||
    lower.includes('failed to find expected lines') ||
    (lower.includes('verification failed') && lower.includes('apply_patch')) ||
    (lower.includes('patch') && lower.includes('expected lines'))
  );
}

function parseTomlString(line: string): string | undefined {
  const match = line.match(/=\s*"([^"]*)"/);
  return match?.[1];
}

function loadCodexConfigDefaults(): CodexConfigDefaults {
  const configHome = shouldIsolateCodexHome()
    ? ensureIsolatedCodexHome()
    : resolveEffectiveCodexHomePath();
  const configPath = path.join(configHome, 'config.toml');
  let content: string;

  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }

  const providerMatch = content.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
  if (!providerMatch) return {};

  const providerName = providerMatch[1];
  const lines = content.split(/\r?\n/);
  const sectionHeader = `[model_providers.${providerName}]`;
  const section: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      if (trimmed === sectionHeader) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (inSection) section.push(line);
  }

  if (section.length === 0) return {};

  let baseUrl: string | undefined;
  let envKey: string | undefined;
  let wireApi: string | undefined;
  let providerLabel: string | undefined;
  for (const line of section) {
    const trimmed = line.trim();
    if (trimmed.startsWith('base_url')) {
      baseUrl = parseTomlString(trimmed);
    } else if (trimmed.startsWith('env_key')) {
      envKey = parseTomlString(trimmed);
    } else if (trimmed.startsWith('wire_api')) {
      wireApi = parseTomlString(trimmed);
    } else if (trimmed.startsWith('name')) {
      providerLabel = parseTomlString(trimmed);
    }
  }

  return {
    providerName,
    providerLabel,
    apiKey: envKey ? process.env[envKey] || undefined : undefined,
    baseUrl,
    wireApi,
  };
}

function buildCommandPreviewText(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  return `\n\n\`\`\`bash\n${trimmed}\n\`\`\`\n\n`;
}

function summarizeCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return 'Running command';
  const compact = trimmed.replace(/\s+/g, ' ');
  return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
}

function summarizeOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split(/\r?\n/).find(Boolean) || trimmed;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  private buildCodexOptions(configDefaults: CodexConfigDefaults): Record<string, unknown> {
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || configDefaults.apiKey
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL
      || configDefaults.baseUrl
      || undefined;
    const codexPathOverride = resolveGlobalCodexExecutablePath();
    const config: CodexConfigOverrides = {};

    if (shouldForceGlobalCodexProvider() && (baseUrl || apiKey)) {
      config.model_provider = 'cti_bridge';
      config.model_providers = {
        cti_bridge: {
          ...(configDefaults.providerLabel ? { name: configDefaults.providerLabel } : {}),
          ...(baseUrl ? { base_url: baseUrl } : {}),
          wire_api: configDefaults.wireApi || 'responses',
          ...(apiKey ? { env_key: 'CTI_CODEX_BRIDGE_API_KEY' } : {}),
        },
      };
    }

    if (shouldDisableCodexPlugins()) {
      config.features = { plugins: false };
    }

    return {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
      env: buildCodexProcessEnv(apiKey),
    };
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    const configDefaults = loadCodexConfigDefaults();

    const CodexClass = this.sdk.Codex;
    const codexOptions = this.buildCodexOptions(configDefaults);
    if (codexOptions.codexPathOverride) {
      console.log(`[codex-provider] Using global Codex executable: ${String(codexOptions.codexPathOverride)}`);
    } else {
      console.warn('[codex-provider] Global Codex executable not found; falling back to SDK-managed binary');
    }
    this.codex = new CodexClass(codexOptions);

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          const streamState = createStreamItemState();
          let clearWatchdogs = () => {};
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              sandboxMode: resolveSandboxMode(),
              approvalPolicy,
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            const runAbortController = new AbortController();
            const externalAbortSignal = params.abortController?.signal;
            if (externalAbortSignal) {
              if (externalAbortSignal.aborted) {
                runAbortController.abort(externalAbortSignal.reason);
              } else {
                externalAbortSignal.addEventListener('abort', () => {
                  runAbortController.abort(externalAbortSignal.reason);
                }, { once: true });
              }
            }

            const firstEventTimeoutMs = getCodexFirstEventTimeoutMs();
            const idleTimeoutMs = getCodexIdleTimeoutMs();
            let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            let timeoutMessage: string | null = null;

            clearWatchdogs = () => {
              if (firstEventTimer) {
                clearTimeout(firstEventTimer);
                firstEventTimer = null;
              }
              if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
              }
            };

            const abortForTimeout = (message: string) => {
              if (timeoutMessage) return;
              timeoutMessage = message;
              if (!runAbortController.signal.aborted) {
                runAbortController.abort(new Error(message));
              }
            };

            const armFirstEventWatchdog = () => {
              if (firstEventTimeoutMs <= 0) return;
              if (firstEventTimer) clearTimeout(firstEventTimer);
              firstEventTimer = setTimeout(() => {
                abortForTimeout(`Codex timed out waiting ${formatTimeoutMs(firstEventTimeoutMs)} for the first event.`);
              }, firstEventTimeoutMs);
            };

            const armIdleWatchdog = () => {
              if (idleTimeoutMs <= 0) return;
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                abortForTimeout(`Codex stream was idle for ${formatTimeoutMs(idleTimeoutMs)}.`);
              }, idleTimeoutMs);
            };

            const markEventProgress = () => {
              if (firstEventTimer) {
                clearTimeout(firstEventTimer);
                firstEventTimer = null;
              }
              armIdleWatchdog();
            };

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;

            while (true) {
              clearWatchdogs();
              armFirstEventWatchdog();

              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input, {
                  signal: runAbortController.signal,
                });

                for await (const event of events) {
                  sawAnyEvent = true;
                  markEventProgress();
                  if (runAbortController.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.started': {
                      const item = event.item as Record<string, unknown>;
                      self.handleStartedItem(controller, item, streamState);
                      break;
                    }

                    case 'item.updated': {
                      const item = event.item as Record<string, unknown>;
                      self.handleUpdatedItem(controller, item, streamState);
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item, streamState);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (timeoutMessage) {
                  self.threadIds.delete(params.sessionId);
                  throw new Error(timeoutMessage);
                }
                const shouldResetThread = shouldResetThreadStateOnError(message);
                if (shouldResetThread) {
                  self.threadIds.delete(params.sessionId);
                }
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldResetThread) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                if (shouldResetThread && sawAnyEvent) {
                  throw new Error(
                    `Codex session context drifted and was reset. Please retry the request.\n${message}`,
                  );
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            clearWatchdogs();
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map an in-progress Codex item to SSE events.
   */
  private handleStartedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    streamState: StreamItemState = createStreamItemState(),
  ): void {
    this.handleActiveItem(controller, item, streamState);
  }

  /**
   * Map an updated Codex item to SSE events while it is still running.
   */
  private handleUpdatedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    streamState: StreamItemState = createStreamItemState(),
  ): void {
    this.handleActiveItem(controller, item, streamState);
  }

  /**
   * Map an active Codex item to SSE events.
   */
  private handleActiveItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    streamState: StreamItemState = createStreamItemState(),
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const status = item.status as string | undefined;

        if (!streamState.insertedCommandBlocks.has(toolId)) {
          const previewText = buildCommandPreviewText(command);
          if (previewText) {
            controller.enqueue(sseEvent('text', previewText));
            streamState.insertedCommandBlocks.add(toolId);
          }
        }

        if (status === 'in_progress' && !streamState.announcedToolUses.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: 'Bash',
            input: { command },
            summary: summarizeCommand(command),
          }));
          streamState.announcedToolUses.add(toolId);
        }
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const status = item.status as string | undefined;

        if (status === 'in_progress' && !streamState.announcedToolUses.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: `mcp__${server}__${tool}`,
            input: args,
          }));
          streamState.announcedToolUses.add(toolId);
        }
        break;
      }
    }
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    streamState: StreamItemState = createStreamItemState(),
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        if (!streamState.insertedCommandBlocks.has(toolId)) {
          const previewText = buildCommandPreviewText(command);
          if (previewText) {
            controller.enqueue(sseEvent('text', previewText));
            streamState.insertedCommandBlocks.add(toolId);
          }
        }

        if (!streamState.announcedToolUses.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: 'Bash',
            input: { command },
            summary: summarizeCommand(command),
          }));
          streamState.announcedToolUses.add(toolId);
        }

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
          summary: isError ? `Command failed (${exitCode ?? 'error'})` : 'Command completed',
          detail: summarizeOutput(resultContent),
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        if (!streamState.announcedToolUses.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: `mcp__${server}__${tool}`,
            input: args,
            summary: tool || server || 'Running tool',
          }));
          streamState.announcedToolUses.add(toolId);
        }

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
          summary: error ? `${tool || server || 'Tool'} failed` : `${tool || server || 'Tool'} completed`,
          detail: summarizeOutput(error?.message || resultText || ''),
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}

export const __internal = {
  buildCodexProcessEnv,
  loadCodexConfigDefaults,
  resolveConfiguredCodexHomePath,
  resolveEffectiveCodexHomePath,
  resolveGlobalCodexExecutablePath,
  shouldDisableCodexPlugins,
};
