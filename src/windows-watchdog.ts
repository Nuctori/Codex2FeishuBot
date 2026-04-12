import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CTI_HOME = process.env.CTI_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.claude-to-im');
const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const WATCHDOG_PID_FILE = path.join(RUNTIME_DIR, 'bridge-watchdog.pid');
const STOP_FILE = path.join(RUNTIME_DIR, 'bridge.stop');
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(DIST_DIR, '..');
const DAEMON_ENTRY = path.join(DIST_DIR, 'daemon.mjs');
const RESTART_DELAY_MS = Math.max(1000, Number.parseInt(process.env.CTI_WATCHDOG_RESTART_DELAY_MS || '3000', 10) || 3000);

type StatusInfo = {
  running: boolean;
  pid?: number | null;
  watchdogPid?: number | null;
  runId?: string;
  startedAt?: string;
  stoppedAt?: string;
  channels?: string[];
  lastExitReason?: string;
  lastChildExitAt?: string;
  restartCount?: number;
};

function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readStatus(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeStatus(info: Partial<StatusInfo>): void {
  ensureRuntimeDir();
  const merged = { ...readStatus(), ...info };
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, STATUS_FILE);
}

function writeWatchdogPid(): void {
  ensureRuntimeDir();
  fs.writeFileSync(WATCHDOG_PID_FILE, String(process.pid), 'utf8');
}

function writeBridgePid(pid: number | undefined): void {
  ensureRuntimeDir();
  if (!pid) return;
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function clearBridgePid(): void {
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
}

function clearWatchdogPid(): void {
  try { fs.rmSync(WATCHDOG_PID_FILE, { force: true }); } catch { /* ignore */ }
}

function hasStopSignal(): boolean {
  return fs.existsSync(STOP_FILE);
}

function clearStopSignal(): void {
  try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }
}

function appendWatchdogLog(message: string): void {
  const logPath = path.join(CTI_HOME, 'logs', 'bridge-error.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] [watchdog] ${message}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWatchdogController(
  spawnChild: () => ChildProcess,
  hooks?: {
    onChildSpawn?: (child: ChildProcess) => void;
    onBeforeRestart?: (attempt: number) => void;
    onStop?: (reason: string) => void;
    delay?: (ms: number) => Promise<void>;
    shouldStop?: () => boolean;
    writeStatus?: (info: Partial<StatusInfo>) => void;
  },
) {
  let stopping = false;
  let child: ChildProcess | null = null;
  let restartCount = 0;

  const run = async (): Promise<void> => {
    while (!stopping) {
      child = spawnChild();
      hooks?.onChildSpawn?.(child);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child!.once('exit', (code, signal) => resolve({ code, signal }));
      });
      child = null;

      if (stopping || hooks?.shouldStop?.()) {
        break;
      }

      restartCount += 1;
      hooks?.writeStatus?.({
        running: false,
        pid: null,
        lastExitReason: `watchdog_restart: code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`,
        lastChildExitAt: new Date().toISOString(),
        restartCount,
      });
      clearBridgePid();
      hooks?.onBeforeRestart?.(restartCount);
      await (hooks?.delay || delay)(RESTART_DELAY_MS);
    }
  };

  const stop = async (reason = 'watchdog_stop'): Promise<void> => {
    stopping = true;
    hooks?.onStop?.(reason);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  };

  return {
    run,
    stop,
    getRestartCount: () => restartCount,
  };
}

function spawnDaemon(): ChildProcess {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: SKILL_DIR,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  writeBridgePid(child.pid);
  appendWatchdogLog(`spawned daemon child pid=${child.pid ?? 'unknown'}`);
  return child;
}

async function main(): Promise<void> {
  ensureRuntimeDir();
  clearStopSignal();
  writeWatchdogPid();
  writeStatus({
    watchdogPid: process.pid,
    lastExitReason: undefined,
  });

  const controller = createWatchdogController(spawnDaemon, {
    onBeforeRestart: (attempt) => appendWatchdogLog(`daemon exited unexpectedly; restarting attempt=${attempt}`),
    onStop: (reason) => appendWatchdogLog(`watchdog stopping: ${reason}`),
    shouldStop: hasStopSignal,
    writeStatus,
  });

  const shutdown = async (reason: string) => {
    await controller.stop(reason);
    writeStatus({
      running: false,
      pid: null,
      watchdogPid: null,
      lastExitReason: reason,
      stoppedAt: new Date().toISOString(),
    });
    clearBridgePid();
    clearWatchdogPid();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('watchdog_signal: SIGTERM'));
  process.on('SIGINT', () => void shutdown('watchdog_signal: SIGINT'));
  process.on('uncaughtException', (err) => {
    appendWatchdogLog(`uncaughtException: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    void shutdown(`watchdog_uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    appendWatchdogLog(`unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  });

  await controller.run();

  const reason = hasStopSignal() ? 'watchdog_stop_signal' : 'watchdog_child_loop_ended';
  writeStatus({
    running: false,
    pid: null,
    watchdogPid: null,
    lastExitReason: reason,
    stoppedAt: new Date().toISOString(),
  });
  clearBridgePid();
  clearWatchdogPid();
  clearStopSignal();
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  void main();
}
