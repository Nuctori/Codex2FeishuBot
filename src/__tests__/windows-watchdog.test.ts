import assert from 'node:assert/strict';
import test from 'node:test';

import { createWatchdogController } from '../windows-watchdog.js';

type FakeChild = {
  killed: boolean;
  once: (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  kill: () => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function makeFakeChild(): FakeChild {
  let handler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  return {
    killed: false,
    once(_event, nextHandler) {
      handler = nextHandler;
    },
    kill() {
      this.killed = true;
      handler?.(0, 'SIGTERM');
    },
    exit(code, signal = null) {
      handler?.(code, signal);
    },
  };
}

test('restarts the child after an unexpected exit', async () => {
  const children: FakeChild[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  let spawnCount = 0;
  let releaseDelay!: () => void;
  let resolveSecondSpawn!: () => void;
  const delayGate = new Promise<void>((resolve) => {
    releaseDelay = resolve;
  });
  const secondSpawned = new Promise<void>((resolve) => {
    resolveSecondSpawn = resolve;
  });

  const controller = createWatchdogController(() => {
    spawnCount += 1;
    const child = makeFakeChild();
    children.push(child);
    return child as never;
  }, {
    delay: async () => {
      await delayGate;
    },
    onChildSpawn: () => {
      if (spawnCount === 2) {
        resolveSecondSpawn();
      }
    },
    writeStatus: (info) => statuses.push(info as Record<string, unknown>),
  });

  const runPromise = controller.run();
  await Promise.resolve();
  children[0]!.exit(1, null);
  await Promise.resolve();
  releaseDelay();
  await secondSpawned;
  await controller.stop('test stop');
  children[1]!.exit(0, 'SIGTERM');
  await runPromise;

  assert.equal(spawnCount, 2);
  assert.equal(controller.getRestartCount(), 1);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.lastExitReason, 'watchdog_restart: code=1 signal=null');
});

test('does not restart after stop is requested', async () => {
  const children: FakeChild[] = [];
  let spawnCount = 0;

  const controller = createWatchdogController(() => {
    spawnCount += 1;
    const child = makeFakeChild();
    children.push(child);
    return child as never;
  }, {
    delay: async () => {
      throw new Error('delay should not be called after stop');
    },
  });

  const runPromise = controller.run();
  await Promise.resolve();
  await controller.stop('manual stop');
  children[0]!.exit(0, 'SIGTERM');
  await runPromise;

  assert.equal(spawnCount, 1);
  assert.equal(controller.getRestartCount(), 0);
});
