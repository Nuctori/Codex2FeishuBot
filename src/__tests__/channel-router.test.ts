import assert from 'node:assert/strict';
import test from 'node:test';

import { initBridgeContext } from '../bridge/context.js';
import { resolve } from '../bridge/channel-router.js';
import { JsonFileStore } from '../store.js';

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', 'D:\\projects\\default'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

test('resolve isolates bindings by bindingKey for the same chat', () => {
  const store = new JsonFileStore(makeSettings());
  initBridgeContext({
    store,
    llm: {
      streamChat() {
        throw new Error('Not implemented in test');
      },
    },
    permissions: {
      resolvePendingPermission() {
        return false;
      },
    },
    lifecycle: {},
  });

  const alice = resolve({
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'ou_alice',
    bindingKey: 'chat-1::ou_alice',
    displayName: 'Alice',
  });
  const bob = resolve({
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'ou_bob',
    bindingKey: 'chat-1::ou_bob',
    displayName: 'Bob',
  });

  assert.notEqual(alice.id, bob.id);
  assert.notEqual(alice.codepilotSessionId, bob.codepilotSessionId);
  assert.equal(store.getChannelBinding('feishu', 'chat-1', 'chat-1::ou_alice')?.id, alice.id);
  assert.equal(store.getChannelBinding('feishu', 'chat-1', 'chat-1::ou_bob')?.id, bob.id);
  assert.equal(store.getChannelBinding('feishu', 'chat-1'), null);
});
