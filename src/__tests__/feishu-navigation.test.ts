import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { FeishuAdapter } from '../bridge/adapters/feishu-adapter.js';
import { initBridgeContext } from '../bridge/context.js';
import { _testOnly as bridgeTestOnly } from '../bridge/bridge-manager.js';
import { buildToolProgressMarkdown } from '../bridge/markdown/feishu.js';

import { CTI_HOME } from '../config.js';
import { JsonFileStore } from '../store.js';
import { sseEvent } from '../sse-utils.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const TEST_CODEX_HOME = path.join(CTI_HOME, 'codex-home');
const TEST_WORKSPACES_DIR = path.join(CTI_HOME, 'workspace-fixtures');

function ensureDir(targetPath: string): string {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function createWorkspaceFixture(name: string, projectNames: string[] = []): {
  root: string;
  codexHome: string;
  projects: Record<string, string>;
} {
  const root = ensureDir(path.join(TEST_WORKSPACES_DIR, name));
  const codexHome = ensureDir(path.join(root, '.codex'));
  const projects = Object.fromEntries(
    projectNames.map((projectName) => [projectName, ensureDir(path.join(root, projectName))]),
  );
  return { root, codexHome, projects };
}

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_locale', 'zh-CN'],
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

function writeCodexSession(
  id: string,
  threadName: string,
  cwd: string,
  updatedAt = '2026-04-11T00:00:00.000Z',
  messages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  codexHome = TEST_CODEX_HOME,
): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.appendFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt })}\n`,
    'utf8',
  );
  const sessionDir = path.join(codexHome, 'sessions', '2026', '04', '11');
  fs.mkdirSync(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({
      timestamp: updatedAt,
      type: 'session_meta',
      payload: { id, cwd, timestamp: updatedAt },
    }),
    ...messages.map((message, index) => JSON.stringify({
      timestamp: updatedAt,
      type: 'event_msg',
      payload: {
        type: message.role === 'user' ? 'user_message' : 'agent_message',
        message: message.content,
        index,
      },
    })),
  ];
  fs.writeFileSync(path.join(sessionDir, `rollout-${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
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
    fs.rmSync(TEST_CODEX_HOME, { recursive: true, force: true });
    fs.rmSync(TEST_WORKSPACES_DIR, { recursive: true, force: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    process.env.CTI_CODEX_DISCOVERY_ROOTS = [TEST_CODEX_HOME, TEST_WORKSPACES_DIR].join(path.delimiter);
    (bridgeTestOnly.clearCodexDiscoveryCache as () => void)();
  });

  it('encodes and decodes project paths for callback payloads', () => {
    const projectPath = 'D:\\projects\\alpha-service';
    const encoded = bridgeTestOnly.encodeCardToken(projectPath);
    assert.equal(bridgeTestOnly.decodeCardToken(encoded), projectPath);
  });

  it('groups sessions by project and marks the current project first', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha1 = store.createSession('alpha-1', 'gpt-5', undefined, 'D:\\projects\\alpha-service', undefined, {
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:10:00.000Z',
    });
    store.createSession('beta-1', 'gpt-5', undefined, 'D:\\projects\\beta-service', undefined, {
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:05:00.000Z',
    });
    const alpha2 = store.createSession('alpha-2', 'gpt-5', undefined, 'D:\\projects\\alpha-service', undefined, {
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:20:00.000Z',
    });

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

  it('keeps same project path sessions separated by workspace home', () => {
    const sharedProject = ensureDir(path.join(TEST_WORKSPACES_DIR, 'shared-project'));
    const repoCodexHome = ensureDir(path.join(sharedProject, '.codex'));
    writeCodexSession(
      'aaaa1111-1111-4111-8111-111111111111',
      'Global codex session',
      sharedProject,
      '2026-04-11T00:00:00.000Z',
      [],
      TEST_CODEX_HOME,
    );
    writeCodexSession(
      'bbbb2222-2222-4222-8222-222222222222',
      'Repo codex session',
      sharedProject,
      '2026-04-11T00:10:00.000Z',
      [],
      repoCodexHome,
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const current = store.createSession('Bridge current', 'gpt-5', undefined, sharedProject, undefined, {
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:20:00.000Z',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: current.id,
      workingDirectory: sharedProject,
      model: 'gpt-5',
    });

    const groups = bridgeTestOnly.buildProjectGroups(binding);
    const sharedGroups = groups.filter((group: any) => group.path === sharedProject);
    const projectCard = bridgeTestOnly.buildFeishuProjectListCard(groups, binding, 'global');

    assert.equal(sharedGroups.length, 2);
    assert.equal(sharedGroups[0].current, true);
    assert.equal(sharedGroups.some((group: any) => group.workspacePath === repoCodexHome), true);
    assert.equal(sharedGroups.some((group: any) => group.workspacePath === TEST_CODEX_HOME), true);
    assert.match(projectCard, new RegExp(bridgeTestOnly.encodeCardToken(repoCodexHome)));
    assert.match(projectCard, new RegExp(bridgeTestOnly.encodeCardToken(TEST_CODEX_HOME)));
  });

  it('discovers codex workspaces and groups them with bridge sessions', () => {
    const firebook = createWorkspaceFixture('firebook-workspace', ['firebookstore-dotnet']);
    const koishi = createWorkspaceFixture('koishi-workspace', ['KoishiNavigationWorkArea']);
    const looseProject = ensureDir(path.join(TEST_WORKSPACES_DIR, 'loose', 'mi-band'));
    writeCodexSession('11111111-1111-4111-8111-111111111111', 'Mi Band debug', looseProject);
    writeCodexSession(
      '22222222-2222-4222-8222-222222222222',
      'Koishi mobile card',
      koishi.projects.KoishiNavigationWorkArea,
      '2026-04-11T00:00:00.000Z',
      [],
      koishi.codexHome,
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const bridgeSession = store.createSession('Firebook backend', 'gpt-5', undefined, firebook.projects['firebookstore-dotnet']);
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: bridgeSession.id,
      workingDirectory: firebook.projects['firebookstore-dotnet'],
      model: 'gpt-5',
    });

    const allGroups = bridgeTestOnly.buildProjectGroups(binding);
    const workspaces = bridgeTestOnly.buildWorkspaceGroups(binding);
    const koishiCard = bridgeTestOnly.buildFeishuProjectListCard(
      bridgeTestOnly.buildProjectGroups(binding, 'global', koishi.codexHome),
      binding,
      'global',
      koishi.codexHome,
    );

    assert.equal(allGroups.some((group: any) => group.path === looseProject), true);
    assert.equal(allGroups.some((group: any) => group.path === koishi.projects.KoishiNavigationWorkArea), true);
    assert.equal(workspaces.some((group: any) => group.path === TEST_CODEX_HOME), true);
    assert.equal(workspaces.some((group: any) => group.path === koishi.codexHome), true);
    assert.equal(workspaces.some((group: any) => group.path === firebook.codexHome), true);
    assert.match(koishiCard, /Workspace|工作区/);
    assert.match(koishiCard, /koishi-workspace/);
    assert.doesNotMatch(koishiCard, /mi-band/);
    assert.match(koishiCard, /nav:workspace:/);
  });

  it('does not invent workspace groups for projects outside real .codex homes', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const looseA = ensureDir(path.join(TEST_WORKSPACES_DIR, 'loose-a'));
    const looseB = ensureDir(path.join(TEST_WORKSPACES_DIR, 'loose-b'));
    const current = store.createSession('Firebook backend', 'gpt-5', undefined, looseA);
    store.createSession('Loose project', 'gpt-5', undefined, looseB);
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: current.id,
      workingDirectory: current.working_directory,
      model: 'gpt-5',
    });

    const workspaces = bridgeTestOnly.buildWorkspaceGroups(binding);
    assert.equal(workspaces.some((group: any) => group.path === looseA), false);
    assert.equal(workspaces.some((group: any) => group.path === looseB), false);
  });

  it('reads native codex message counts and context previews', () => {
    writeCodexSession(
      '44444444-4444-4444-8444-444444444444',
      'Native preview thread',
      'D:\\hardware\\mi-band',
      '2026-04-11T00:00:00.000Z',
      [
        { role: 'user', content: 'first native question' },
        { role: 'assistant', content: 'first native answer' },
        { role: 'user', content: 'second native question' },
      ],
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const bridgeSession = store.createSession('Firebook backend', 'gpt-5', undefined, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: bridgeSession.id,
      workingDirectory: 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet',
      model: 'gpt-5',
    });

    const group = bridgeTestOnly.buildProjectGroups(binding).find((item: any) => item.path === 'D:\\hardware\\mi-band');
    assert.ok(group);

    const sessionsCard = bridgeTestOnly.buildFeishuProjectSessionsCard(group, binding.codepilotSessionId, binding);
    const previewCard = bridgeTestOnly.buildFeishuSessionPreviewCard('44444444-4444-4444-8444-444444444444', binding.codepilotSessionId);

    assert.match(sessionsCard, /3 (msgs|条消息)/);
    assert.match(sessionsCard, /(Created|创建) 2026-04-11/);
    assert.match(sessionsCard, /(Updated|更新) 2026-04-11/);
    assert.ok(previewCard);
    assert.match(previewCard!, /first native question/);
    assert.match(previewCard!, /first native answer/);
  });

  it('prefers native codex metadata for mirrored current sessions', () => {
    writeCodexSession(
      '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf',
      'Firebook current thread',
      'D:/lua/fireBookStore-backend/firebookstore-dotnet',
      '2026-04-11T10:00:00.000Z',
      [
        { role: 'user', content: 'continue firebook work' },
        { role: 'assistant', content: 'working in firebook repo' },
      ],
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const mirrored = store.createSession('old koishi title', '', undefined, 'D:\\cs\\KoishiNavigationWorkArea');
    store.updateSdkSessionId(mirrored.id, '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: mirrored.id,
      sdkSessionId: '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf',
      workingDirectory: 'D:\\cs\\KoishiNavigationWorkArea',
      model: '',
    });

    const statusCard = bridgeTestOnly.buildFeishuStatusCard(binding);
    const projectCard = bridgeTestOnly.buildFeishuProjectListCard(bridgeTestOnly.buildProjectGroups(binding), binding, 'global');
    const refreshedBinding = store.getChannelBinding('feishu', 'chat-1')!;

    assert.match(statusCard, /firebookstore-dotnet|continue firebook work/);
    assert.match(statusCard, /firebookstore-dotnet/);
    assert.doesNotMatch(statusCard, /KoishiNavigationWorkArea/);
    assert.match(projectCard, /firebookstore-dotnet/);
    assert.equal(refreshedBinding.workingDirectory, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
  });

  it('deduplicates multiple bridge mirrors that point to the same native codex session', () => {
    writeCodexSession(
      '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf',
      'Firebook current thread',
      'D:/lua/fireBookStore-backend/firebookstore-dotnet',
      '2026-04-11T10:00:00.000Z',
      [
        { role: 'user', content: 'continue firebook work' },
        { role: 'assistant', content: 'working in firebook repo' },
      ],
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const olderMirror = store.createSession('Codex 019d78cc', '', undefined, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    store.updateSdkSessionId(olderMirror.id, '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf');
    store.addMessage(olderMirror.id, 'user', 'older local context');
    store.addMessage(olderMirror.id, 'assistant', 'older local answer');

    const currentMirror = store.createSession('Codex 019d78cc', '', undefined, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    store.updateSdkSessionId(currentMirror.id, '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: currentMirror.id,
      sdkSessionId: '019d78cc-9b78-7cc0-ba7c-6deeb2a409bf',
      workingDirectory: 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet',
      model: '',
    });

    const groups = bridgeTestOnly.buildProjectGroups(binding);
    const firebook = groups.find((group: any) => group.path === 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    assert.ok(firebook);
    assert.equal(firebook.sessions.length, 1);
    assert.equal(firebook.sessions[0].id, currentMirror.id);
  });

  it('builds project and session cards with navigation callbacks', () => {
    const workspace = createWorkspaceFixture('card-workspace', ['alpha-service', 'beta-service']);
    const externalProject = ensureDir(path.join(TEST_WORKSPACES_DIR, 'external', 'gamma-service'));

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha = store.createSession('alpha-1', 'gpt-5', undefined, workspace.projects['alpha-service']);
    const alphaFollowup = store.createSession('alpha-2', 'gpt-5', undefined, workspace.projects['alpha-service']);
    const beta = store.createSession('beta-1', 'gpt-5', undefined, workspace.projects['beta-service']);
    store.createSession('gamma-1', 'gpt-5', undefined, externalProject);

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: alphaFollowup.id,
      workingDirectory: workspace.projects['alpha-service'],
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
    assert.match(projectCard, /Projects|项目|alpha-service/);
    assert.match(projectCard, /Open Sessions|已打开会话/);
    assert.match(projectCard, /All|全部|Workspace|工作区/);
    assert.match(projectCard, /nav:workspace:|All \*|全部 \*/);
    assert.equal(workspaceGroups.some((group: any) => group.path === workspace.projects['beta-service']), true);
    assert.equal(groups.some((group: any) => group.path === externalProject), true);
    assert.equal(workspaceGroups.some((group: any) => group.path === externalProject), false);
    assert.match(projectCard, /Current Session|当前会话/);
    assert.match(projectCard, /alpha-2/);
    assert.match(responseCard, /alpha-service/);
    assert.match(responseCard, /alpha-2/);
    assert.match(responseCard, /pong/);
    assert.match(responseCard, /Current Session|当前会话/);
    assert.match(responseCard, /nav:peek:/);
    assert.match(responseCard, /Sessions|会话/);
    assert.doesNotMatch(responseCard, /Projects(?!.*alpha-service)|项目(?!.*alpha-service)/);
    assert.match(replyNavCard, /Current Session|当前会话/);
    assert.match(replyNavCard, /alpha-2/);
    assert.match(replyNavCard, /nav:peek:/);
    assert.match(replyNavCard, /Current Project|当前项目/);
    assert.match(replyNavCard, /All Projects|全部项目/);
    assert.match(sessionsCard, /nav:bind:/);
    assert.match(sessionsCard, /Open Sessions|已打开会话/);
    assert.match(sessionsCard, /Projects|项目/);
    assert.match(sessionsCard, /projects|项目|nav:workspace:/);
    assert.match(sessionsCard, /nav:peek:/);
    assert.match(sessionsCard, /nav:archive:/);
    assert.match(sessionsCard, /"content":"(New|新建)"/);
    assert.match(sessionsCard, /"content":"(Status|状态)"/);
    assert.doesNotMatch(sessionsCard, /Current Session|当前会话/);
    assert.match(sessionsCard, new RegExp(`"session_id":"${alpha.id}"`));
    assert.match(sessionsCard, /Use|Current|切换|当前/);
    assert.match(sessionsCard, /msg|消息/);
    assert.match(sessionsCard, new RegExp(alpha.id.slice(0, 8)));
    assert.ok(sessionPreviewCard);
    assert.match(sessionPreviewCard!, /collapsible_panel/);
    assert.match(sessionPreviewCard!, /Recent Context|最近上下文/);
    assert.match(sessionPreviewCard!, /2 (msgs|条消息)/);
    assert.match(statusCard, /nav:projects/);
    assert.match(statusCard, /collapsible_panel/);
    assert.match(statusCard, /Open Sessions|已打开会话/);
    assert.match(statusCard, /nav:dock:select:/);
    assert.match(statusCard, /nav:dock:close:/);
    assert.match(statusCard, /2 (projects|个项目|项目)/);
    assert.match(statusCard, /2 (unread|未读)/);
    assert.match(statusCard, /alpha-s/);
    assert.match(statusCard, /beta-se/);
    assert.match(statusCard, new RegExp(dockBinding.codepilotSessionId.slice(0, 8)));
  });

  it('shows five project sessions per page with pager controls and no duplicate current panel', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const sessionIds: string[] = [];
    for (let index = 1; index <= 7; index++) {
      const minute = String(index).padStart(2, '0');
      const session = store.createSession(`alpha-${index}`, 'gpt-5', undefined, 'D:\\projects\\alpha-service', undefined, {
        createdAt: `2026-04-11T00:${minute}:00.000Z`,
        updatedAt: `2026-04-11T01:${minute}:00.000Z`,
      });
      sessionIds.push(session.id);
    }

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: sessionIds.at(-1)!,
      workingDirectory: 'D:\\projects\\alpha-service',
      model: 'gpt-5',
    });

    const group = bridgeTestOnly.buildProjectGroups(binding)[0];
    assert.ok(group);

    const page0 = bridgeTestOnly.buildFeishuProjectSessionsCard(group, binding.codepilotSessionId, binding, 'workspace', undefined, 0);
    const page1 = bridgeTestOnly.buildFeishuProjectSessionsCard(group, binding.codepilotSessionId, binding, 'workspace', undefined, 1);

    assert.equal((page0.match(/nav:bind:/g) || []).length, 5);
    assert.equal((page1.match(/nav:bind:/g) || []).length, 2);
    assert.match(page0, /1\/2/);
    assert.match(page1, /2\/2/);
    assert.match(page0, /nav:project:.*:1/);
    assert.match(page1, /"content":"(Newer|更新的|较新)"/);
    assert.match(page0, /alpha-7/);
    assert.match(page0, /alpha-3/);
    assert.doesNotMatch(page0, /alpha-2/);
    assert.match(page1, /alpha-2/);
    assert.match(page1, /alpha-1/);
    assert.match(page0, /"content":"(New|新建)"/);
    assert.doesNotMatch(page0, /Current Session|当前会话/);
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

    assert.match(statusCard, /Recent Context|最近上下文/);
    assert.match(statusCard, /6-15 \/ 15 (msg|条消息|消息)|11-15 \/ 15 (msg|条消息|消息)/);
    assert.match(statusCard, /nav:status:1/);
    assert.ok(previewCardPage1);
    assert.match(previewCardPage1!, /1-5 \/ 15 (msg|条消息|消息)/);
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
    assert.match(statusCard, /\*\*1\. (Assistant|助手)\*\*/);
    assert.match(statusCard, /collapsible_panel/);
    assert.doesNotMatch(statusCard, /nav:ctx:status:0:0/);
    assert.doesNotMatch(statusCard, /\[\{\"type\":\"text\"/);
    assert.doesNotMatch(statusCard, /"content":"Open"/);
    assert.match(statusCardWithDetail, /full content|完整内容/);
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

    await adapter.handleCardAction({
      token: 'token_structured_workspace',
      action: { value: { nav: 'workspace', workspace_path: 'D:\\cs' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_5' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 4);
    assert.equal(queued[3].callbackData, `nav:workspace:${Buffer.from('D:\\cs', 'utf8').toString('base64url')}`);

    await adapter.handleCardAction({
      token: 'token_structured_project_page',
      action: { value: { nav: 'project', project_path: 'D:\\projects\\alpha-service', workspace_path: 'D:\\projects', page: 2 } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_6' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 5);
    assert.equal(
      queued[4].callbackData,
      `nav:project:${Buffer.from('D:\\projects\\alpha-service', 'utf8').toString('base64url')}:${Buffer.from('D:\\projects', 'utf8').toString('base64url')}:2`,
    );

    await adapter.handleCardAction({
      token: 'token_structured_project_new',
      action: { value: { nav: 'project_new', project_path: 'D:\\projects\\alpha-service', workspace_path: 'D:\\projects' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om_card_7' },
      operator: { open_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 6);
    assert.equal(
      queued[5].callbackData,
      `nav:new:${Buffer.from('D:\\projects\\alpha-service', 'utf8').toString('base64url')}:${Buffer.from('D:\\projects', 'utf8').toString('base64url')}`,
    );
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

  it('aggregates repeated Bash tool calls into a compact progress summary', () => {
    const markdown = buildToolProgressMarkdown([
      { id: 'tool-1', name: 'Bash', status: 'complete' },
      { id: 'tool-2', name: 'Bash', status: 'complete' },
      { id: 'tool-3', name: 'Bash', status: 'complete' },
      { id: 'tool-4', name: 'Bash', status: 'complete' },
      { id: 'tool-5', name: 'Bash', status: 'complete' },
      { id: 'tool-6', name: 'Bash', status: 'complete' },
      { id: 'tool-7', name: 'Bash', status: 'complete' },
      { id: 'tool-8', name: 'Bash', status: 'error' },
    ]);

    assert.match(markdown, /`Bash` x8/);
    assert.match(markdown, /7 (ok|成功)/);
    assert.match(markdown, /1 (failed|失败)/);
    assert.equal((markdown.match(/`Bash`/g) || []).length, 1);
  });

  it('shows the command summary for a single tool call', () => {
    const markdown = buildToolProgressMarkdown([
      { id: 'tool-1', name: 'Bash', status: 'complete', summary: 'git status --short' },
    ]);

    assert.match(markdown, /`Bash`/);
    assert.match(markdown, /git status --short/);
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

  it('ignores unauthorized card action callbacks', async () => {
    const adapter = new FeishuAdapter() as any;
    const queued: Array<{ messageId: string; callbackData?: string }> = [];
    adapter.enqueue = (message: { messageId: string; callbackData?: string }) => {
      queued.push(message);
    };
    adapter.isAuthorized = () => false;

    const result = await adapter.handleCardAction({
      token: 'card_action_token_unauthorized',
      action: { value: { callback_data: 'nav:projects' } },
      context: {
        open_chat_id: 'chat-1',
        open_message_id: 'om_card_unauthorized',
      },
      operator: { open_id: 'ou_intruder' },
    });

    assert.equal(queued.length, 0);
    assert.ok(result);
    assert.match(JSON.stringify(result), /无权|not authorized|没有权限/i);
  });

  it('uses sender user_id fallback for authorized card actions when open_id is absent', async () => {
    const adapter = new FeishuAdapter() as any;
    const queued: Array<{ address: { bindingKey?: string; userId?: string }; callbackData?: string }> = [];
    adapter.enqueue = (message: { address: { bindingKey?: string; userId?: string }; callbackData?: string }) => {
      queued.push(message);
    };

    const result = await adapter.handleCardAction({
      token: 'card_action_token_user_id_only',
      action: { value: { callback_data: 'nav:projects' } },
      context: {
        open_chat_id: 'chat-1',
        open_message_id: 'om_card_user_id_only',
      },
      operator: { user_id: 'ou_user_1' },
    });

    assert.equal(queued.length, 1);
    assert.equal(queued[0].address.userId, 'ou_user_1');
    assert.equal(queued[0].address.bindingKey, 'chat-1::ou_user_1');
    assert.equal(queued[0].callbackData, 'nav:projects');
    assert.ok(result);
  });

  it('routes permission callbacks through bindingKey-scoped permission links', async () => {
    const store = new JsonFileStore(makeSettings());
    let resolved: { permissionRequestId: string; behavior: string } | null = null;
    initBridgeContext({
      store,
      llm: {
        streamChat() {
          throw new Error('Not implemented in test');
        },
      },
      permissions: {
        resolvePendingPermission(permissionRequestId: string, decision: { behavior: string }) {
          resolved = { permissionRequestId, behavior: decision.behavior };
          return true;
        },
      },
      lifecycle: {},
    });

    store.insertPermissionLink({
      permissionRequestId: 'perm-binding-key',
      channelType: 'feishu',
      chatId: 'chat-1::ou_user_1',
      messageId: 'om_perm_1',
      toolName: 'Edit',
      suggestions: '',
    });

    const sends: Array<{ text: string }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: { text: string }) {
        sends.push(message);
        return { ok: true, messageId: `msg_${sends.length}` };
      },
      acknowledgeUpdate() {},
    } as any;

    await bridgeTestOnly.handleMessage(fakeAdapter, {
      messageId: 'evt_perm_1',
      address: {
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'ou_user_1',
        bindingKey: 'chat-1::ou_user_1',
      },
      text: '',
      timestamp: Date.now(),
      callbackData: 'perm:allow:perm-binding-key',
      callbackMessageId: 'om_perm_1',
      updateId: 1,
    });

    assert.deepEqual(resolved, { permissionRequestId: 'perm-binding-key', behavior: 'allow' });
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /权限回复已记录|Permission response recorded/);
  });

  it('detects numeric permission shortcuts using bindingKey-scoped pending links', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    store.insertPermissionLink({
      permissionRequestId: 'perm-shortcut',
      channelType: 'feishu',
      chatId: 'chat-1::ou_user_1',
      messageId: 'om_perm_shortcut',
      toolName: 'Edit',
      suggestions: '',
    });

    assert.equal(
      bridgeTestOnly.isNumericPermissionShortcut('feishu', '1', {
        chatId: 'chat-1',
        bindingKey: 'chat-1::ou_user_1',
      }),
      true,
    );
    assert.equal(
      bridgeTestOnly.isNumericPermissionShortcut('feishu', '1', {
        chatId: 'chat-1',
      }),
      false,
    );
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
    assert.match(sends.at(-1)!.text, /Projects|项目/);
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
    assert.match(sends.at(-1)!.text, /Recent Context|最近上下文/);
    assert.match(sends.at(-1)!.text, /payment timeout/);
    assert.match(sends.at(-1)!.text, /I found a null config value/);

    const bindMsg = makeNavCallbackMessage(`nav:bind:${alpha1.id}`, 'om_bind_alpha1');
    await bridgeTestOnly.handleMessage(fakeAdapter, bindMsg);
    const rebound = store.getChannelBinding('feishu', 'chat-1');
    assert.equal(rebound?.codepilotSessionId, alpha1.id);
    assert.equal(sends.at(-1)?.updateMessageId, 'om_bind_alpha1');
    assert.match(sends.at(-1)!.text, /Current Session|当前会话/);
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
    assert.match(sends.at(-1)!.text, /Open Sessions|已打开会话/);
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
    assert.match(sends.at(-1)!.text, /Current Session|当前会话/);
    assert.match(sends.at(-1)!.text, /alpha-service/);

    assert.deepEqual(acked, [1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('creates and binds a new session from the project card', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const existing = store.createSession('Existing alpha session', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const other = store.createSession('Beta session', 'gpt-5', undefined, 'D:\\projects\\beta-service');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: other.id,
      workingDirectory: 'D:\\projects\\beta-service',
      model: 'gpt-5',
      mode: 'code',
    });

    const sends: Array<{
      text: string;
      parseMode?: string;
      updateMessageId?: string;
    }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: {
        text: string;
        parseMode?: string;
        updateMessageId?: string;
      }) {
        sends.push(message);
        return { ok: true, messageId: message.updateMessageId || `msg_${sends.length}` };
      },
      acknowledgeUpdate() {},
    } as any;

    await bridgeTestOnly.handleMessage(
      fakeAdapter,
      makeNavCallbackMessage(
        `nav:new:${bridgeTestOnly.encodeCardToken('D:\\projects\\alpha-service')}`,
        'om_project_new_alpha',
      ),
    );

    const rebound = store.getChannelBinding('feishu', 'chat-1');
    assert.ok(rebound);
    assert.equal(rebound!.workingDirectory, 'D:\\projects\\alpha-service');
    assert.notEqual(rebound!.codepilotSessionId, other.id);
    assert.notEqual(rebound!.codepilotSessionId, existing.id);
    assert.equal(sends.at(-1)?.parseMode, 'CardJson');
    assert.equal(sends.at(-1)?.updateMessageId, 'om_project_new_alpha');
    assert.match(sends.at(-1)!.text, /Open Sessions|已打开会话/);
    assert.match(sends.at(-1)!.text, /alpha-service/);
    assert.match(sends.at(-1)!.text, new RegExp(rebound!.codepilotSessionId.slice(0, 8)));
    assert.doesNotMatch(sends.at(-1)!.text, /Current Session|当前会话/);
  });

  it('falls back to project text instead of claiming missing project when a card update fails', async () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const alpha1 = store.createSession('Investigate payment timeout', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    const alpha2 = store.createSession('Continue deploy audit', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
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
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: {
        text: string;
        parseMode?: string;
        updateMessageId?: string;
        replyToMessageId?: string;
      }) {
        sends.push(message);
        if (message.parseMode === 'CardJson' && message.updateMessageId === 'om_project_alpha') {
          return { ok: false, error: 'rate limited' };
        }
        return { ok: true, messageId: message.updateMessageId || `msg_${sends.length}` };
      },
      acknowledgeUpdate() {},
    } as any;

    await bridgeTestOnly.handleMessage(
      fakeAdapter,
      makeNavCallbackMessage(`nav:project:${bridgeTestOnly.encodeCardToken('D:\\projects\\alpha-service')}`, 'om_project_alpha'),
    );

    assert.equal(sends[0]?.parseMode, 'CardJson');
    const htmlFallback = [...sends].reverse().find((item) => item.parseMode === 'HTML');
    assert.ok(htmlFallback);
    assert.match(htmlFallback!.text, /alpha-service/);
    assert.match(htmlFallback!.text, /Projects|项目/);
    assert.doesNotMatch(htmlFallback!.text, /Project not found|项目不存在/);
  });

  it('binds a discovered codex session by creating a bridge mirror with sdk session id', async () => {
    writeCodexSession(
      '33333333-3333-4333-8333-333333333333',
      '小米手环的会话',
      'D:\\hardware\\mi-band',
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const current = store.createSession('Bridge current', 'gpt-5', undefined, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: current.id,
      workingDirectory: current.working_directory,
      model: 'gpt-5',
      mode: 'code',
    });

    const sends: Array<{ text: string; updateMessageId?: string }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: { text: string; updateMessageId?: string }) {
        sends.push(message);
        return { ok: true, messageId: message.updateMessageId || `msg_${sends.length}` };
      },
      acknowledgeUpdate() {},
    } as any;

    await bridgeTestOnly.handleMessage(
      fakeAdapter,
      makeNavCallbackMessage('nav:bind:33333333-3333-4333-8333-333333333333', 'om_bind_codex'),
    );

    const rebound = store.getChannelBinding('feishu', 'chat-1');
    assert.ok(rebound);
    assert.notEqual(rebound!.codepilotSessionId, '33333333-3333-4333-8333-333333333333');
    assert.equal(rebound!.sdkSessionId, '33333333-3333-4333-8333-333333333333');
    assert.equal(rebound!.workingDirectory, 'D:\\hardware\\mi-band');

    const mirrored = store.getSession(rebound!.codepilotSessionId) as any;
    assert.equal(mirrored?.sdk_session_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(mirrored?.name, '小米手环的会话');
    assert.equal(sends.at(-1)?.updateMessageId, 'om_bind_codex');
    assert.match(sends.at(-1)!.text, /Current Session|当前会话/);
    assert.match(sends.at(-1)!.text, /mi-band/);
  });

  it('bind command accepts a discovered codex session id by creating a bridge mirror', async () => {
    writeCodexSession(
      '019d56b8-6a5a-79d1-a1a2-0bacb6f0a304',
      'Review codex-feishu-bridge Feishu use',
      'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet',
    );

    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const current = store.createSession('Bridge current', 'gpt-5', undefined, 'D:\\projects\\alpha-service');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: current.id,
      workingDirectory: current.working_directory,
      model: 'gpt-5',
      mode: 'code',
    });

    const sends: Array<{ text: string; parseMode?: string }> = [];
    const fakeAdapter = {
      channelType: 'feishu',
      async send(message: { text: string; parseMode?: string }) {
        sends.push(message);
        return { ok: true, messageId: `msg_${sends.length}` };
      },
      acknowledgeUpdate() {},
    } as any;

    await bridgeTestOnly.handleMessage(fakeAdapter, {
      messageId: 'evt_bind_1',
      timestamp: Date.now(),
      text: '/bind 019d56b8-6a5a-79d1-a1a2-0bacb6f0a304',
      address: {
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'ou_user_1',
        displayName: 'Tester',
      },
    });

    const rebound = store.getChannelBinding('feishu', 'chat-1');
    assert.ok(rebound);
    assert.notEqual(rebound!.codepilotSessionId, '019d56b8-6a5a-79d1-a1a2-0bacb6f0a304');
    assert.equal(rebound!.sdkSessionId, '019d56b8-6a5a-79d1-a1a2-0bacb6f0a304');
    assert.equal(rebound!.workingDirectory, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');

    const mirrored = store.getSession(rebound!.codepilotSessionId) as any;
    assert.equal(mirrored?.sdk_session_id, '019d56b8-6a5a-79d1-a1a2-0bacb6f0a304');
    assert.equal(mirrored?.name, 'Review codex-feishu-bridge Feishu use');
    assert.equal(sends.at(-1)?.parseMode, 'CardJson');
    assert.match(sends.at(-1)!.text, /Current Session|当前会话/);
  });

  it('clears stale sdk session ids from both binding and session after an error update', () => {
    const store = new JsonFileStore(makeSettings());
    initTestContext(store);

    const current = store.createSession('Bridge current', 'gpt-5', undefined, 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet');
    store.updateSdkSessionId(current.id, '019d7fe8-b40f-71a0-863c-898605508a34');

    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: current.id,
      sdkSessionId: '019d7fe8-b40f-71a0-863c-898605508a34',
      workingDirectory: 'D:\\lua\\fireBookStore-backend\\firebookstore-dotnet',
      model: 'gpt-5',
    });

    bridgeTestOnly.applySdkSessionUpdate(binding, '');

    const clearedBinding = store.getChannelBinding('feishu', 'chat-1') as any;
    const clearedSession = store.getSession(current.id) as any;
    assert.equal(clearedBinding?.sdkSessionId, '');
    assert.equal(clearedSession?.sdk_session_id, '');

    bridgeTestOnly.buildFeishuStatusCard(clearedBinding);
    assert.equal((store.getChannelBinding('feishu', 'chat-1') as any)?.sdkSessionId, '');
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
