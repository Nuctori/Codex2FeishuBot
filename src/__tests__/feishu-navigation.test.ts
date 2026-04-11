import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { FeishuAdapter } from '../../node_modules/claude-to-im/src/lib/bridge/adapters/feishu-adapter.js';
import { initBridgeContext } from '../../node_modules/claude-to-im/src/lib/bridge/context.js';
import { _testOnly as bridgeTestOnly } from '../../node_modules/claude-to-im/src/lib/bridge/bridge-manager.js';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { sseEvent } from '../sse-utils.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', 'D:\\projects\\default'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

function initTestContext(store: JsonFileStore): void {
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
}

function makeNavCallbackMessage(callbackData: string, callbackMessageId = 'om_nav_1') {
  return {
    messageId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    address: {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'ou_user_1',
      displayName: 'Tester',
    },
    text: '',
    timestamp: Date.now(),
    callbackData,
    callbackMessageId,
    updateId: 1,
  };
}

describe('Feishu navigation cards', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('encodes and decodes project paths for callback payloads', () => {
    const projectPath = 'D:\\projects\\alpha-service';
    const encoded = bridgeTestOnly.encodeCardToken(projectPath);
    assert.equal(bridgeTestOnly.decodeCardToken(encoded), projectPath);
  });

  it('groups sessions by project and marks the current project first', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha1 = store.createSession('alpha-1', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    store.createSession('beta-1', 'gpt-5', undefined, 'D:\\projects\\beta-service');
    const alpha2 = store.createSession('alpha-2', 'gpt-5', undefined, 'D:\\projects\\alpha-service');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: alpha2.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    const groups = bridgeTestOnly.buildProjectGroups(binding);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].path, 'D:\\projects\\alpha-service');
    assert.equal(groups[0].current, true);
    assert.equal(groups[0].sessions[0].id, alpha2.id);
    assert.equal(groups[0].sessions[1].id, alpha1.id);
    assert.equal(groups[1].path, 'D:\\projects\\beta-service');
  });

  it('normalizes windows drive-letter casing when grouping projects', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    store.createSession('alpha-1', 'gpt-5', undefined, 'd:\\projects\\alpha-service');
    const alpha2 = store.createSession('alpha-2', 'gpt-5', undefined, 'D:\\projects\\alpha-service');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: alpha2.id,
      workingDirectory: 'd:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    const groups = bridgeTestOnly.buildProjectGroups(binding);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].path, 'D:\\projects\\alpha-service');
  });

  it('does not list archived sessions in project groups', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const archived = store.createSession('archived', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const active = store.createSession('active', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    store.archiveSession(archived.id);

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: active.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    const groups = bridgeTestOnly.buildProjectGroups(binding);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].sessions.length, 1);
    assert.equal(groups[0].sessions[0].id, active.id);
  });

  it('builds project and session cards with navigation callbacks', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha = store.createSession('alpha-1', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const alphaFollowup = store.createSession('alpha-2', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const beta = store.createSession('beta-1', 'gpt-5', undefined, 'D:\\projects\\beta-service');
    store.createSession('gamma-1', 'gpt-5', undefined, 'E:\\other\\gamma-service');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: alphaFollowup.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    store.addMessage(alpha.id, 'user', 'please inspect the payment timeout');
    store.addMessage(alpha.id, 'assistant', 'I checked the last deploy and found a null config value.');
    store.addMessage(alphaFollowup.id, 'user', 'continue the current deployment investigation');
    store.addMessage(beta.id, 'assistant', 'beta project background result');

    store.updateChannelBinding(binding.id, {
      openSessionIds: [alphaFollowup.id, alpha.id, beta.id],
      sessionSeenCounts: {
        [alphaFollowup.id]: 1,
        [alpha.id]: 1,
        [beta.id]: 0,
      },
    } as any);
    const dockBinding = store.getChannelBinding('feishu', 'chat-1')!;
    const groups = bridgeTestOnly.buildProjectGroups(dockBinding);
    const workspaceGroups = bridgeTestOnly.buildProjectGroups(dockBinding, 'workspace');
    const projectCard = bridgeTestOnly.buildFeishuProjectListCard(groups, dockBinding, 'global');
    const responseCard = bridgeTestOnly.buildFeishuResponseCard(dockBinding, 'pong');
    const replyNavCard = bridgeTestOnly.buildFeishuReplyNavCard(dockBinding);
    const sessionsCard = bridgeTestOnly.buildFeishuProjectSessionsCard(groups[0], dockBinding.codepilotSessionId, dockBinding);
    const sessionPreviewCard = bridgeTestOnly.buildFeishuSessionPreviewCard(alpha.id, dockBinding.codepilotSessionId);
    const statusCard = bridgeTestOnly.buildFeishuStatusCard(dockBinding);

    assert.match(projectCard, /nav:project:/);
    assert.match(projectCard, /Projects|alpha-service/);
    assert.match(projectCard, /Open Sessions/);
    assert.match(projectCard, /Workspace/);
    assert.match(projectCard, /Global/);
    assert.match(projectCard, /Sessions/);
    assert.equal(workspaceGroups.some((group: any) => group.path === 'D:\\projects\\beta-service'), true);
    assert.equal(groups.some((group: any) => group.path === 'E:\\other\\gamma-service'), true);
    assert.equal(workspaceGroups.some((group: any) => group.path === 'E:\\other\\gamma-service'), false);
    assert.match(responseCard, /alpha-service/);
    assert.match(responseCard, /alpha-2/);
    assert.match(responseCard, /pong/);
    assert.match(responseCard, /Sessions/);
    assert.doesNotMatch(responseCard, /Projects/);
    assert.match(replyNavCard, /Current Project/);
    assert.match(replyNavCard, /All Projects/);
    assert.match(sessionsCard, /nav:bind:/);
    assert.match(sessionsCard, /Open Sessions/);
    assert.match(sessionsCard, /Projects/);
    assert.match(sessionsCard, /Workspace/);
    assert.match(sessionsCard, /nav:peek:/);
    assert.match(sessionsCard, /nav:archive:/);
    assert.match(sessionsCard, new RegExp(`"session_id":"${alpha.id}"`));
    assert.match(sessionsCard, /Use|Current/);
    assert.match(sessionsCard, /msg/);
    assert.match(sessionsCard, new RegExp(alpha.id.slice(0, 8)));
    assert.ok(sessionPreviewCard);
    assert.match(sessionPreviewCard!, /collapsible_panel/);
    assert.match(sessionPreviewCard!, /Recent Context/);
    assert.match(sessionPreviewCard!, /2 msgs/);
    assert.match(statusCard, /nav:projects/);
    assert.match(statusCard, /collapsible_panel/);
    assert.match(statusCard, /Open Sessions/);
    assert.match(statusCard, /nav:dock:select:/);
    assert.match(statusCard, /nav:dock:close:/);
    assert.match(statusCard, /2 projects/);
    assert.match(statusCard, /2 unread/);
    assert.match(statusCard, /alpha-s…\//);
    assert.match(statusCard, /beta-se…\//);
    assert.match(statusCard, new RegExp(dockBinding.codepilotSessionId.slice(0, 8)));
  });

  it('supports paged context previews with total counts and pager callbacks', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const session = store.createSession('Long thread', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    for (let index = 1; index <= 15; index++) {
      store.addMessage(session.id, index % 2 === 0 ? 'assistant' : 'user', `message ${index}`);
    }

    const statusCard = (bridgeTestOnly.buildFeishuStatusCard as any)(binding, 0);
    const previewCardPage1 = (bridgeTestOnly.buildFeishuSessionPreviewCard as any)(session.id, binding.codepilotSessionId, 1);

    assert.match(statusCard, /Recent Context/);
    assert.match(statusCard, /6-15 \/ 15 msg|11-15 \/ 15 msg/);
    assert.match(statusCard, /nav:status:1/);
    assert.ok(previewCardPage1);
    assert.match(previewCardPage1!, /1-5 \/ 15 msg/);
    assert.match(previewCardPage1!, /nav:peek:.*:0/);
  });

  it('renders structured assistant context as a readable summary instead of raw json', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const session = store.createSession('Structured thread', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    store.addMessage(session.id, 'assistant', JSON.stringify([
      { type: 'text', text: '我先把这个判断是对的，先看为什么没跑。' },
      { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'git status --short' } },
      { type: 'tool_result', tool_use_id: 'tool_1', content: 'Done', is_error: false },
    ]));

    const statusCard = (bridgeTestOnly.buildFeishuStatusCard as any)(binding, 0);
    const statusCardWithDetail = (bridgeTestOnly.buildFeishuStatusCard as any)(binding, 0, 0);
    assert.match(statusCard, /我先把这个判断是对的/);
    assert.match(statusCard, /Bash/);
    assert.match(statusCard, /\*\*1\. Assistant\*\*/);
    assert.match(statusCard, /collapsible_panel/);
    assert.doesNotMatch(statusCard, /nav:ctx:status:0:0/);
    assert.doesNotMatch(statusCard, /\[\{\"type\":\"text\"/);
    assert.doesNotMatch(statusCard, /"content":"Open"/);
    assert.match(statusCardWithDetail, /full content/);
    assert.match(statusCardWithDetail, /nav:ctxclear:status:0/);
    assert.doesNotMatch(statusCardWithDetail, /\*\*1\. Assistant\*\*/);
  });

  it('restores structured card action payloads when callback_data is missing', async () => {
    const adapter = new FeishuAdapter() as any;
    const queued: Array<{ callbackData?: string }> = [];
    adapter.enqueue = (message: { callbackData?: string }) => queued.push(message);

    await adapter.handleCardAction({
      token: 'token_structured_bind',
      action: { value: { nav: 'bind', session_id: '8dce3400-c58a-4b65-8355-1cce7e1d79bd' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_2' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 1);
    assert.equal(queued[0].callbackData, 'nav:bind:8dce3400-c58a-4b65-8355-1cce7e1d79bd');

    await adapter.handleCardAction({
      token: 'token_structured_dock',
      action: { value: { nav: 'dock_select', session_id: '8dce3400-c58a-4b65-8355-1cce7e1d79bd' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_3' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 2);
    assert.equal(queued[1].callbackData, 'nav:dock:select:8dce3400-c58a-4b65-8355-1cce7e1d79bd');

    await adapter.handleCardAction({
      token: 'token_structured_projects',
      action: { value: { nav: 'projects', scope: 'workspace' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_4' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 3);
    assert.equal(queued[2].callbackData, 'nav:projects:workspace');
  });

  it('treats a resolved card patch without code as successful in-place update', async () => {
    const adapter = new FeishuAdapter();
    const patchCalls: Array<{ path: { message_id: string }; data: { content: string } }> = [];
    let createCalls = 0;

    (adapter as any).restClient = {
      im: {
        message: {
          patch: async (payload: { path: { message_id: string }; data: { content: string } }) => {
            patchCalls.push(payload);
            return { data: {} };
          },
          create: async () => {
            createCalls++;
            return { data: { message_id: 'new-message' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '{"schema":"2.0"}',
      parseMode: 'CardJson',
      updateMessageId: 'om_xxx',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_xxx');
    assert.equal(patchCalls.length, 1);
    assert.equal(createCalls, 0);
  });

  it('does not create a second card when an in-place update fails', async () => {
    const sendCalls: Array<{ updateMessageId?: string }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: { updateMessageId?: string }) {
        sendCalls.push({ updateMessageId: message.updateMessageId });
        return { ok: false, error: 'patch failed', httpStatus: 400 };
      },
    } as any;

    const ok = await bridgeTestOnly.sendFeishuNavigationCard(
      fakeAdapter,
      { channelType: 'feishu', chatId: 'chat-1' },
      '{"schema":"2.0"}',
      'om_xxx',
    );

    assert.equal(ok, false);
    assert.deepEqual(sendCalls, [{ updateMessageId: 'om_xxx' }]);
  });

  it('uses CardKit v1 for streaming card create, content, and finalize', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: { data: { type: string; data: string } }) => {
              calls.push(`create:${payload.data.type}`);
              return { data: { card_id: 'card_1' } };
            },
            settings: async (payload: { path: { card_id: string }; data: { settings: string; sequence: number } }) => {
              calls.push(`settings:${payload.path.card_id}:${payload.data.sequence}:${payload.data.settings}`);
              return { data: {} };
            },
            update: async (payload: { path: { card_id: string }; data: { card: { type: string; data: string }; sequence: number } }) => {
              calls.push(`update:${payload.path.card_id}:${payload.data.sequence}:${payload.data.card.type}`);
              return { data: {} };
            },
          },
          cardElement: {
            content: async (payload: { path: { card_id: string; element_id: string }; data: { content: string; sequence: number } }) => {
              calls.push(`content:${payload.path.card_id}:${payload.path.element_id}:${payload.data.sequence}`);
              return { data: {} };
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => ({ data: { message_id: 'om_stream_1' } }),
        },
      },
    };
    adapter.lastIncomingMessageId.set('chat-1', 'om_user_1');

    await adapter.onStreamText('chat-1', 'hello stream');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalized = await adapter.onStreamEnd('chat-1', 'completed', 'final answer');

    assert.equal(finalized, true);
    assert.ok(calls.some((entry) => entry === 'create:card_json'));
    assert.ok(calls.some((entry) => entry.startsWith('content:card_1:streaming_content:')));
    assert.ok(calls.some((entry) => entry.includes('settings:card_1:') && entry.includes('"streaming_mode":false')));
    assert.ok(calls.some((entry) => entry.startsWith('update:card_1:') && entry.endsWith(':card_json')));
  });

  it('deduplicates repeated card action callbacks by token', async () => {
    const adapter = new FeishuAdapter() as any;
    const queued: Array<{ messageId: string; callbackData?: string; callbackMessageId?: string }> = [];
    adapter.enqueue = (message: { messageId: string; callbackData?: string; callbackMessageId?: string }) => {
      queued.push(message);
    };

    const payload = {
      token: 'card_action_token_1',
      action: { value: { callback_data: 'nav:projects' } },
      context: {
        open_chat_id: 'chat-1',
        open_message_id: 'om_card_1',
      },
      operator: { open_id: 'ou_user_1' },
    };

    const first = await adapter.handleCardAction(payload);
    const second = await adapter.handleCardAction(payload);

    assert.equal(queued.length, 1);
    assert.equal(queued[0].messageId, 'card_action_token_1');
    assert.equal(queued[0].callbackData, 'nav:projects');
    assert.equal(queued[0].callbackMessageId, 'om_card_1');
    assert.ok(first);
    assert.ok(second);
  });

  it('runs the full project-session navigation flow through callback handling', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha1 = store.createSession('Investigate payment timeout', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const alpha2 = store.createSession('Continue deploy audit', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const beta1 = store.createSession('Beta onboarding', 'gpt-5', undefined, 'D:\\projects\\beta-service');
    store.addMessage(alpha1.id, 'user', 'please inspect the payment timeout');
    store.addMessage(alpha1.id, 'assistant', 'I found a null config value in the deploy pipeline.');
    store.addMessage(alpha2.id, 'user', 'continue the deployment investigation');
    store.addMessage(beta1.id, 'user', 'check the beta project');

    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: alpha2.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
      mode: 'code',
    });

    const sends: Array<{
      text: string;
      parseMode?: string;
      updateMessageId?: string;
      replyToMessageId?: string;
    }> = [];
    const acked: number[] = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: {
        text: string;
        parseMode?: string;
        updateMessageId?: string;
        replyToMessageId?: string;
      }) {
        sends.push(message);
        return { ok: true, messageId: message.updateMessageId || `msg_${sends.length}` };
      },
      acknowledgeUpdate(updateId: number) {
        acked.push(updateId);
      },
    } as any;

    const projectListMsg = makeNavCallbackMessage('nav:projects', 'om_projects');
    await bridgeTestOnly.handleMessage(fakeAdapter, projectListMsg);
    assert.equal(sends.at(-1)?.parseMode, 'CardJson');
    assert.equal(sends.at(-1)?.updateMessageId, 'om_projects');
    assert.match(sends.at(-1)!.text, /Projects/);
    assert.match(sends.at(-1)!.text, /alpha-service/);
    assert.match(sends.at(-1)!.text, /beta-service/);

    const openProjectMsg = makeNavCallbackMessage(
      `nav:project:${bridgeTestOnly.encodeCardToken('D:\\projects\\alpha-service')}`,
      'om_project_alpha',
    );
    await bridgeTestOnly.handleMessage(fakeAdapter, openProjectMsg);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_project_alpha');
    assert.match(sends.at(-1)!.text, /Investigate payment timeout/);
    assert.match(sends.at(-1)!.text, /Continue deploy audit/);
    assert.match(sends.at(-1)!.text, /nav:bind:/);

    const previewMsg = makeNavCallbackMessage(`nav:peek:${alpha1.id}`, 'om_preview_alpha1');
    await bridgeTestOnly.handleMessage(fakeAdapter, previewMsg);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_preview_alpha1');
    assert.match(sends.at(-1)!.text, /Recent Context/);
    assert.match(sends.at(-1)!.text, /payment timeout/);
    assert.match(sends.at(-1)!.text, /I found a null config value/);

    const bindMsg = makeNavCallbackMessage(`nav:bind:${alpha1.id}`, 'om_bind_alpha1');
    await bridgeTestOnly.handleMessage(fakeAdapter, bindMsg);
    const rebound = store.getChannelBinding('feishu', 'chat-1');
    assert.equal(rebound?.codepilotSessionId, alpha1.id);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_bind_alpha1');
    assert.match(sends.at(-1)!.text, /Current Session/);
    assert.match(sends.at(-1)!.text, new RegExp(alpha1.id.slice(0, 8)));

    store.updateChannelBinding(rebound!.id, {
      openSessionIds: [alpha1.id, beta1.id],
      sessionSeenCounts: {
        [alpha1.id]: 2,
        [beta1.id]: 0,
      },
    } as any);

    const dockSelectMsg = makeNavCallbackMessage(`nav:dock:select:${beta1.id}`, 'om_dock_select_beta1');
    await bridgeTestOnly.handleMessage(fakeAdapter, dockSelectMsg);
    const dockSelected = store.getChannelBinding('feishu', 'chat-1');
    assert.equal(dockSelected?.codepilotSessionId, beta1.id);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_dock_select_beta1');
    assert.match(sends.at(-1)!.text, /Open Sessions/);
    assert.match(sends.at(-1)!.text, new RegExp(beta1.id.slice(0, 8)));

    const dockCloseMsg = makeNavCallbackMessage(`nav:dock:close:${beta1.id}`, 'om_dock_close_beta1');
    await bridgeTestOnly.handleMessage(fakeAdapter, dockCloseMsg);
    const dockClosed = store.getChannelBinding('feishu', 'chat-1');
    assert.equal(dockClosed?.codepilotSessionId, alpha1.id);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_dock_close_beta1');
    assert.match(sends.at(-1)!.text, new RegExp(alpha1.id.slice(0, 8)));

    const archiveCurrentMsg = makeNavCallbackMessage(`nav:archive:${alpha1.id}`, 'om_archive_alpha1');
    await bridgeTestOnly.handleMessage(fakeAdapter, archiveCurrentMsg);
    const afterArchiveBinding = store.getChannelBinding('feishu', 'chat-1');
    assert.ok(afterArchiveBinding);
    assert.notEqual(afterArchiveBinding!.codepilotSessionId, alpha1.id);
    assert.equal(store.listSessions().some((session) => session.id === alpha1.id), false);
    assert.equal((store.getSession(alpha1.id) as { archived_at?: string } | null)?.archived_at != null, true);
    assert.equal(afterArchiveBinding!.workingDirectory, 'D:\\projects\\alpha-service');
    assert.equal(sends.at(-1)?.updateMessageId, 'om_archive_alpha1');
    assert.match(sends.at(-1)!.text, /Continue deploy audit|Bridge: Tester/);
    assert.doesNotMatch(sends.at(-1)!.text, new RegExp(alpha1.id.slice(0, 8)));

    const statusMsg = makeNavCallbackMessage('nav:status', 'om_status');
    await bridgeTestOnly.handleMessage(fakeAdapter, statusMsg);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_status');
    assert.match(sends.at(-1)!.text, /Current Session/);
    assert.match(sends.at(-1)!.text, /alpha-service/);

    assert.deepEqual(acked, [1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('does not send a second reply card after a streaming card finalized', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(sseEvent('text', 'streamed answer'));
              controller.enqueue(sseEvent('result', { usage: { input_tokens: 1, output_tokens: 1 } }));
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission() {
          return false;
        },
      },
      lifecycle: {},
    });

    const session = store.createSession('alpha-1', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    const sends: Array<{ text?: string; parseMode?: string }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      onMessageStart() {},
      onMessageEnd() {},
      onStreamText() {},
      async onStreamEnd() {
        return true;
      },
      async send(message: { text?: string; parseMode?: string }) {
        sends.push({ text: message.text, parseMode: message.parseMode });
        return { ok: true, messageId: 'om_sent_1' };
      },
    } as any;

    await bridgeTestOnly.handleMessage(fakeAdapter, {
      messageId: 'evt_stream_1',
      address: {
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'ou_user_1',
      },
      text: 'hello',
      timestamp: Date.now(),
    });

    assert.equal(sends.length, 0);
  });
});
