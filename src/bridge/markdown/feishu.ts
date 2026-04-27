import type { ToolCallInfo } from '../types.js';
import { localizeText } from '../i18n.js';

export interface FeishuCardNavContext {
  projectLabel: string;
  projectPath: string;
  sessionLabel: string;
}

const TOOL_ICON_BY_STATUS: Record<string, string> = {
  running: '\u{1F6E0}',
  complete: '\u2705',
  error: '\u274C',
};

const SUBAGENT_TOOL_NAMES = new Set([
  'spawn_agent',
  'wait_agent',
  'send_input',
  'resume_agent',
]);

type ToolProgressGroup = {
  name: string;
  summaries: string[];
  running: number;
  complete: number;
  error: number;
  total: number;
};

type ToolProgressOptions = {
  elapsedMs?: number;
};

type SubagentVisualStatus =
  | 'spawning'
  | 'running'
  | 'waiting_reply'
  | 'timed_out_retrying'
  | 'completed'
  | 'failed';

type SubagentActor = {
  key: string;
  label: string;
  detail?: string;
  status: SubagentVisualStatus;
  updatedAt: number;
};

type WaitStatusEntry = {
  key: string;
  detail: string;
  status: SubagentVisualStatus;
};

type SubagentWaitState = {
  status: SubagentVisualStatus;
  summary: string;
  detail?: string;
  updatedAt: number;
  targetKeys: string[];
  entries: WaitStatusEntry[];
};

type SubagentProgressView = {
  summaryLine: string;
  currentLines: string[];
  waitLine?: string;
  historyLines: string[];
};

export function hasComplexMarkdown(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true;
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

export function preprocessFeishuMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateInline(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function parseDelimitedParts(text: string): string[] {
  return text
    .split(/\s*[·•|]\s*|\s*,\s*/)
    .map(part => part.trim())
    .filter(Boolean);
}

function shortAgentLabel(value: string): string {
  const normalized = value.trim();
  if (!normalized) return localizeText('Subagent', '子代理');
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(normalized)) return normalized.slice(0, 8);
  return truncateInline(normalized, 24);
}

function extractSpawnAgentIdentity(tool: ToolCallInfo): { key: string; label: string; detail?: string } {
  const detail = tool.detail?.trim() || '';
  const summary = tool.summary?.trim() || '';
  const parts = parseDelimitedParts(detail);
  const spawnedMatch = summary.match(/^Spawned\s+(.+)$/i);
  const label = parts[0] || spawnedMatch?.[1]?.trim() || localizeText('Subagent', '子代理');
  const key = parts.length > 1 ? parts[parts.length - 1] : label || tool.id;
  const detailText = parts.length > 1
    ? parts.slice(1).join(' · ')
    : detail || undefined;
  return {
    key: key || tool.id,
    label: shortAgentLabel(label || key || tool.id),
    detail: detailText ? truncateInline(detailText, 42) : undefined,
  };
}

function extractAgentTargets(tool: ToolCallInfo): string[] {
  const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : null;
  if (Array.isArray(input?.targets)) {
    return input.targets.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  if (typeof input?.target === 'string' && input.target.trim()) {
    return [input.target.trim()];
  }
  if (tool.name.trim() === 'wait_agent') {
    const detail = tool.detail?.trim() || '';
    if (detail && !detail.includes(':')) {
      return parseDelimitedParts(detail);
    }
  }
  return [];
}

function getActorStatusPriority(status: SubagentVisualStatus): number {
  switch (status) {
    case 'failed':
      return 5;
    case 'timed_out_retrying':
      return 4;
    case 'waiting_reply':
      return 3;
    case 'running':
      return 2;
    case 'spawning':
      return 1;
    case 'completed':
    default:
      return 0;
  }
}

function upsertActor(
  actors: Map<string, SubagentActor>,
  key: string,
  patch: Partial<SubagentActor> & { status: SubagentVisualStatus; updatedAt: number },
): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  const existing = actors.get(normalizedKey);
  const nextLabel = patch.label?.trim() || existing?.label || shortAgentLabel(normalizedKey);
  const nextDetail = patch.detail?.trim() || existing?.detail;
  const next: SubagentActor = {
    key: normalizedKey,
    label: nextLabel,
    detail: nextDetail || undefined,
    status: patch.status,
    updatedAt: patch.updatedAt,
  };

  if (
    !existing
    || patch.updatedAt >= existing.updatedAt
    || getActorStatusPriority(patch.status) >= getActorStatusPriority(existing.status)
  ) {
    actors.set(normalizedKey, next);
  }
}

function parseWaitEntryStatus(detail: string): SubagentVisualStatus {
  if (/\b(pending|waiting|running)\b/i.test(detail)) return 'waiting_reply';
  if (/\b(timeout|timed out|retry)\b/i.test(detail)) return 'timed_out_retrying';
  if (/\b(failed|error)\b/i.test(detail)) return 'failed';
  return 'completed';
}

function parseWaitEntries(tool: ToolCallInfo): WaitStatusEntry[] {
  const detail = tool.detail?.trim() || '';
  if (!detail || !detail.includes(':')) return [];
  return detail
    .split(/\s*·\s*/)
    .map((part) => {
      const match = part.match(/^([^:]+):\s*(.+)$/);
      if (!match) return null;
      const key = match[1].trim();
      const value = match[2].trim();
      if (!key || !value) return null;
      return {
        key,
        detail: value,
        status: parseWaitEntryStatus(value),
      } satisfies WaitStatusEntry;
    })
    .filter((entry): entry is WaitStatusEntry => Boolean(entry));
}

function deriveWaitState(tool: ToolCallInfo): SubagentWaitState {
  const summary = tool.summary?.trim() || localizeText('Waiting on subagents', '正在等待子代理');
  const detail = tool.detail?.trim() || '';
  const entries = parseWaitEntries(tool);
  const targetKeys = Array.from(new Set([
    ...extractAgentTargets(tool),
    ...entries.map(entry => entry.key),
  ]));

  let status: SubagentVisualStatus;
  if (tool.status === 'error') {
    status = 'failed';
  } else if (/timed out waiting/i.test(summary)) {
    status = 'timed_out_retrying';
  } else if (tool.status === 'running' || /\b(pending|waiting)\b/i.test(summary)) {
    status = 'waiting_reply';
  } else if (entries.some(entry => entry.status === 'failed')) {
    status = 'failed';
  } else if (entries.some(entry => entry.status === 'timed_out_retrying')) {
    status = 'timed_out_retrying';
  } else if (entries.some(entry => entry.status === 'waiting_reply')) {
    status = 'waiting_reply';
  } else {
    status = 'completed';
  }

  return {
    status,
    summary,
    detail: detail || undefined,
    updatedAt: tool.updatedAt || 0,
    targetKeys,
    entries,
  };
}

function iconForSubagentStatus(status: SubagentVisualStatus): string {
  switch (status) {
    case 'failed':
      return '❌';
    case 'timed_out_retrying':
      return '🟠';
    case 'waiting_reply':
      return '🟡';
    case 'completed':
      return '✅';
    case 'spawning':
      return '🟣';
    case 'running':
    default:
      return '🟢';
  }
}

function labelForSubagentStatus(status: SubagentVisualStatus): string {
  switch (status) {
    case 'failed':
      return localizeText('Failed', '失败');
    case 'timed_out_retrying':
      return localizeText('Retrying after timeout', '超时后重试中');
    case 'waiting_reply':
      return localizeText('Waiting for reply', '等待回复');
    case 'completed':
      return localizeText('Completed', '已完成');
    case 'spawning':
      return localizeText('Starting', '启动中');
    case 'running':
    default:
      return localizeText('Running', '运行中');
  }
}

function summarizeSubagentCounts(actors: SubagentActor[]): string[] {
  const counts = {
    active: actors.filter(actor => actor.status === 'running' || actor.status === 'spawning').length,
    waiting: actors.filter(actor => actor.status === 'waiting_reply').length,
    retrying: actors.filter(actor => actor.status === 'timed_out_retrying').length,
    failed: actors.filter(actor => actor.status === 'failed').length,
    done: actors.filter(actor => actor.status === 'completed').length,
  };

  const parts: string[] = [];
  if (counts.active > 0) parts.push(localizeText(`${counts.active} active`, `${counts.active} 个运行中`));
  if (counts.waiting > 0) parts.push(localizeText(`${counts.waiting} waiting`, `${counts.waiting} 个等待中`));
  if (counts.retrying > 0) parts.push(localizeText(`${counts.retrying} retrying`, `${counts.retrying} 个重试中`));
  if (counts.failed > 0) parts.push(localizeText(`${counts.failed} failed`, `${counts.failed} 个异常`));
  if (counts.done > 0) parts.push(localizeText(`${counts.done} done`, `${counts.done} 个已完成`));
  if (parts.length === 0) {
    parts.push(localizeText(`${actors.length} tracked`, `${actors.length} 个已跟踪`));
  }
  return parts;
}

function renderActorLine(actor: SubagentActor): string {
  const parts = [
    `**${actor.label}**`,
    labelForSubagentStatus(actor.status),
  ];
  if (actor.detail && actor.detail !== actor.label) {
    parts.push(truncateInline(actor.detail, 42));
  }
  return `- ${iconForSubagentStatus(actor.status)} ${parts.join(' · ')}`;
}

function renderHistoryLine(tool: ToolCallInfo): string {
  const status: SubagentVisualStatus = tool.status === 'error'
    ? 'failed'
    : tool.name.trim() === 'wait_agent' && /timed out waiting/i.test(tool.summary || '')
      ? 'timed_out_retrying'
      : tool.status === 'running'
        ? 'running'
        : 'completed';
  const summary = truncateInline(tool.summary || tool.name || localizeText('Subagent event', '子代理事件'), 72);
  const detail = truncateInline(tool.detail || '', 40);
  return detail
    ? `- ${iconForSubagentStatus(status)} ${summary} · ${detail}`
    : `- ${iconForSubagentStatus(status)} ${summary}`;
}

function buildSubagentProgressView(tools: ToolCallInfo[], options?: ToolProgressOptions): SubagentProgressView | null {
  const relevant = tools
    .filter(isSubagentTool)
    .map((tool, index) => ({ ...tool, updatedAt: tool.updatedAt ?? index + 1 }));
  if (relevant.length === 0) return null;

  const actors = new Map<string, SubagentActor>();
  let latestWait: SubagentWaitState | null = null;

  for (const tool of relevant.slice().sort((left, right) => (left.updatedAt || 0) - (right.updatedAt || 0))) {
    const updatedAt = tool.updatedAt || 0;
    const name = tool.name.trim();

    if (name === 'spawn_agent') {
      const identity = extractSpawnAgentIdentity(tool);
      upsertActor(actors, identity.key, {
        label: identity.label,
        detail: identity.detail,
        status: tool.status === 'error' ? 'failed' : tool.status === 'running' ? 'spawning' : 'running',
        updatedAt,
      });
      continue;
    }

    if (name === 'send_input' || name === 'resume_agent') {
      const targets = extractAgentTargets(tool);
      for (const target of targets) {
        upsertActor(actors, target, {
          status: tool.status === 'error' ? 'failed' : 'running',
          updatedAt,
        });
      }
      continue;
    }

    if (name === 'wait_agent') {
      const waitState = deriveWaitState(tool);
      latestWait = !latestWait || waitState.updatedAt >= latestWait.updatedAt ? waitState : latestWait;

      if (waitState.entries.length > 0) {
        for (const entry of waitState.entries) {
          upsertActor(actors, entry.key, {
            detail: truncateInline(entry.detail, 42),
            status: entry.status,
            updatedAt,
          });
        }
      } else {
        for (const target of waitState.targetKeys) {
          upsertActor(actors, target, {
            status: waitState.status,
            updatedAt,
          });
        }
      }
    }
  }

  const actorList = Array.from(actors.values()).sort((left, right) => {
    const statusDelta = getActorStatusPriority(right.status) - getActorStatusPriority(left.status);
    if (statusDelta !== 0) return statusDelta;
    return right.updatedAt - left.updatedAt;
  });

  const headerParts = [
    `**${localizeText('Subagents', '子代理')}**`,
    ...summarizeSubagentCounts(actorList),
  ];
  if (typeof options?.elapsedMs === 'number' && options.elapsedMs >= 0) {
    const hasLiveWork = actorList.some(actor => actor.status !== 'completed')
      || (latestWait && latestWait.status !== 'completed');
    if (hasLiveWork) headerParts.push(formatElapsed(options.elapsedMs));
  }

  const currentLines = actorList
    .filter(actor => actor.status !== 'completed')
    .slice(0, 4)
    .map(renderActorLine);

  if (currentLines.length === 0 && actorList.length > 0) {
    currentLines.push(...actorList.slice(0, 2).map(renderActorLine));
  }

  const waitLine = latestWait && latestWait.status !== 'completed'
    ? `- ${iconForSubagentStatus(latestWait.status)} **${localizeText('Main session', '主会话')}** · ${truncateInline(latestWait.summary, 64)}${latestWait.detail ? ` · ${truncateInline(latestWait.detail, 36)}` : ''}`
    : undefined;

  const historyLines = relevant
    .slice()
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    .slice(0, 4)
    .map(renderHistoryLine);

  return {
    summaryLine: headerParts.join(' · '),
    currentLines,
    waitLine,
    historyLines,
  };
}

function buildSubagentStatusMarkdown(tools: ToolCallInfo[], options?: ToolProgressOptions): string {
  const view = buildSubagentProgressView(tools, options);
  if (!view) return '';

  const sections = [view.summaryLine];
  if (view.currentLines.length > 0) sections.push(...view.currentLines);
  if (view.waitLine) sections.push(view.waitLine);
  if (view.historyLines.length > 0) {
    sections.push(`**${localizeText('Recent events', '最近事件')}**`);
    sections.push(...view.historyLines);
  }
  return sections.join('\n');
}

function buildSubagentProgressElements(
  tools: ToolCallInfo[],
  options?: ToolProgressOptions,
): Array<Record<string, unknown>> {
  const view = buildSubagentProgressView(tools, options);
  if (!view) return [];

  const elements: Array<Record<string, unknown>> = [{
    tag: 'markdown',
    content: view.summaryLine,
    text_align: 'left',
    text_size: 'normal',
  }];

  const currentBlockLines = [...view.currentLines];
  if (view.waitLine) currentBlockLines.push(view.waitLine);
  if (currentBlockLines.length > 0) {
    elements.push({
      tag: 'markdown',
      content: currentBlockLines.join('\n'),
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (view.historyLines.length > 0) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      border: {
        color: 'grey',
        corner_radius: '6px',
      },
      header: {
        title: {
          tag: 'markdown',
          content: `**${localizeText('Recent subagent events', '子代理最近事件')}** · ${view.historyLines.length}`,
        },
        icon_position: 'follow_text',
        icon_expanded_angle: -180,
      },
      padding: '6px',
      vertical_spacing: '4px',
      elements: [{
        tag: 'markdown',
        content: view.historyLines.join('\n'),
        text_align: 'left',
        text_size: 'normal',
      }],
    });
  }

  return elements;
}

function isSubagentTool(tool: ToolCallInfo): boolean {
  return SUBAGENT_TOOL_NAMES.has(tool.name.trim());
}

export function hasRunningSubagentTools(tools: ToolCallInfo[]): boolean {
  return tools.some(tool => isSubagentTool(tool) && tool.status === 'running');
}

export function buildSubagentProgressMarkdown(tools: ToolCallInfo[], options?: ToolProgressOptions): string {
  const relevant = tools.filter(isSubagentTool);
  if (relevant.length === 0) return '';

  const runningCount = relevant.filter(tool => tool.status === 'running').length;
  const headerParts = [
    `**${localizeText('Subagents', '子代理')}**`,
    runningCount > 0
      ? localizeText(`${runningCount} active`, `${runningCount} 个进行中`)
      : localizeText(`${relevant.length} tracked`, `${relevant.length} 个已跟踪`),
  ];
  if (runningCount > 0 && typeof options?.elapsedMs === 'number' && options.elapsedMs >= 0) {
    headerParts.push(formatElapsed(options.elapsedMs));
  }

  const lines = relevant
    .slice()
    .sort((left, right) => {
      const rank = (tool: ToolCallInfo): number => {
        if (tool.status === 'running') return 0;
        if (tool.status === 'error') return 1;
        return 2;
      };
      const rankDelta = rank(left) - rank(right);
      if (rankDelta !== 0) return rankDelta;
      return (right.updatedAt || 0) - (left.updatedAt || 0);
    })
    .slice(0, 4)
    .map((tool) => {
      const icon = TOOL_ICON_BY_STATUS[tool.status] || TOOL_ICON_BY_STATUS.running;
      const summary = truncateInline(
        tool.summary || tool.name || localizeText('Subagent task', '子代理任务'),
        72,
      );
      const detail = truncateInline(tool.detail || '', 42);
      return detail ? `- ${icon} ${summary} · ${detail}` : `- ${icon} ${summary}`;
    });

  if (relevant.length > 4) {
    lines.push(`- ${localizeText(`+${relevant.length - 4} more`, `还有 ${relevant.length - 4} 个`)}`);
  }

  return [headerParts.join(' · '), ...lines].join('\n');
}

export function buildGenericToolProgressMarkdown(tools: ToolCallInfo[]): string {
  const genericTools = tools.filter(tool => !isSubagentTool(tool));
  if (genericTools.length === 0) return '';

  const groups = new Map<string, ToolProgressGroup>();
  for (const toolCall of genericTools) {
    const name = toolCall.name.trim() || localizeText('Tool', '工具');
    const key = name.toLowerCase();
    const group = groups.get(key) ?? {
      name,
      summaries: [],
      running: 0,
      complete: 0,
      error: 0,
      total: 0,
    };
    group.total += 1;
    group[toolCall.status] += 1;

    const summary = toolCall.summary?.trim();
    if (summary && !group.summaries.includes(summary)) {
      group.summaries.push(summary);
    }
    groups.set(key, group);
  }

  const renderGroup = (group: ToolProgressGroup): string => {
    const icon = group.error > 0
      ? TOOL_ICON_BY_STATUS.error
      : group.running > 0
        ? TOOL_ICON_BY_STATUS.running
        : TOOL_ICON_BY_STATUS.complete;

    if (group.total === 1) {
      const suffix = group.summaries[0] ? ` · ${group.summaries[0]}` : '';
      return `${icon} \`${group.name}\`${suffix}`;
    }

    const statusParts: string[] = [];
    if (group.complete > 0) statusParts.push(localizeText(`${group.complete} ok`, `${group.complete} 成功`));
    if (group.error > 0) statusParts.push(localizeText(`${group.error} failed`, `${group.error} 失败`));
    if (group.running > 0) statusParts.push(localizeText(`${group.running} running`, `${group.running} 进行中`));

    return `${icon} \`${group.name}\` x${group.total}${statusParts.length > 0 ? ` (${statusParts.join(', ')})` : ''}`;
  };

  return Array.from(groups.values())
    .sort((left, right) => {
      if (left.error !== right.error) return right.error - left.error;
      if (left.running !== right.running) return right.running - left.running;
      if (left.total !== right.total) return right.total - left.total;
      return left.name.localeCompare(right.name, 'en');
    })
    .map(renderGroup)
    .join('\n');
}

export function buildToolProgressMarkdown(tools: ToolCallInfo[], options?: ToolProgressOptions): string {
  const sections: string[] = [];
  const subagentMd = buildSubagentStatusMarkdown(tools, options);
  const genericMd = buildGenericToolProgressMarkdown(tools);
  if (subagentMd) sections.push(subagentMd);
  if (genericMd) sections.push(genericMd);
  return sections.join('\n\n');
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

export function buildStreamingContent(text: string, tools: ToolCallInfo[], options?: ToolProgressOptions): string {
  const sections: string[] = [];
  const toolMd = buildToolProgressMarkdown(tools, options);
  if (toolMd) {
    sections.push(toolMd);
  }
  if (text) {
    sections.push(text);
  }
  return sections.join('\n\n') || localizeText('\u{1F9E0} Thinking...', '\u{1F9E0} 正在思考...');
}

function normalizeFooterStatus(status: string): string {
  return status
    .replace(/^.*Completed$/i, localizeText('\u2705 Completed', '\u2705 已完成'))
    .replace(/^.*Interrupted$/i, localizeText('\u26A0\uFE0F Interrupted', '\u26A0\uFE0F 已中断'))
    .replace(/^.*Error$/i, localizeText('\u274C Error', '\u274C 出错'));
}

function buildNavElements(navContext?: FeishuCardNavContext | null): Array<Record<string, unknown>> {
  if (!navContext) return [];

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{
            tag: 'markdown',
            content: `**${navContext.projectLabel}**`,
            text_size: 'normal',
          }],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: localizeText('Sessions', '会话') },
            type: 'primary',
            size: 'small',
            value: {
              callback_data: `nav:project:${Buffer.from(navContext.projectPath, 'utf8').toString('base64url')}`,
              nav: 'project',
              project_path: navContext.projectPath,
            },
          }],
        },
      ],
    },
    {
      tag: 'markdown',
      content: `\`${navContext.projectPath}\``,
      text_size: 'notation',
    },
  ];

  if (navContext.sessionLabel) {
    elements.push({
      tag: 'markdown',
      content: navContext.sessionLabel,
      text_size: 'notation',
    });
  }

  elements.push({ tag: 'hr' });
  return elements;
}

function buildCardElements(
  text: string,
  tools: ToolCallInfo[],
  navContext?: FeishuCardNavContext | null,
  footer?: { status: string; elapsed: string } | null,
  options?: ToolProgressOptions & { fallbackThinking?: boolean },
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [...buildNavElements(navContext)];
  const subagentElements = buildSubagentProgressElements(tools, options);
  const genericMd = buildGenericToolProgressMarkdown(tools);
  const bodyMd = preprocessFeishuMarkdown(text).trim()
    || (options?.fallbackThinking ? localizeText('Thinking...', '正在思考...') : '');

  if (subagentElements.length > 0) elements.push(...subagentElements);

  if (genericMd) {
    if (subagentElements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: genericMd,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (bodyMd) {
    if (subagentElements.length > 0 || genericMd) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: bodyMd,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(normalizeFooterStatus(footer.status));
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return elements;
}

export function buildStreamingCardJson(
  text: string,
  tools: ToolCallInfo[],
  navContext?: FeishuCardNavContext | null,
  options?: ToolProgressOptions,
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: buildCardElements(text, tools, navContext, null, {
        ...options,
        fallbackThinking: true,
      }),
    },
  });
}

export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
  navContext?: FeishuCardNavContext | null,
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: buildCardElements(text, tools, navContext, footer, {
        fallbackThinking: false,
      }),
    },
  });
}

export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: localizeText('Allow', '\u5141\u8BB8\u4E00\u6B21'), type: 'primary', action: 'allow' },
    { label: localizeText('Allow Session', '\u5141\u8BB8\u672C\u4F1A\u8BDD'), type: 'default', action: 'allow_session' },
    { label: localizeText('Deny', '\u62D2\u7EDD'), type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((button) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: button.type,
      size: 'medium',
      value: { callback_data: `perm:${button.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: localizeText('Permission Required', '\u9700\u8981\u6743\u9650\u786E\u8BA4') },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        {
          tag: 'markdown',
          content: localizeText(
            'This request will expire in 5 minutes',
            '\u8BE5\u8BF7\u6C42\u5C06\u5728 5 \u5206\u949F\u540E\u8FC7\u671F',
          ),
          text_size: 'notation',
        },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: localizeText(
            'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
            '\u4E5F\u53EF\u4EE5\u56DE\u590D\uFF1A`1` \u5141\u8BB8\u4E00\u6B21 \u00B7 `2` \u5141\u8BB8\u672C\u4F1A\u8BDD \u00B7 `3` \u62D2\u7EDD',
          ),
          text_size: 'notation',
        },
      ],
    },
  });
}
