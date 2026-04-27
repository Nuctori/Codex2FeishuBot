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
  const subagentMd = buildSubagentProgressMarkdown(tools, options);
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
  const subagentMd = buildSubagentProgressMarkdown(tools, options);
  const genericMd = buildGenericToolProgressMarkdown(tools);
  const bodyMd = preprocessFeishuMarkdown(text).trim()
    || (options?.fallbackThinking ? localizeText('Thinking...', '正在思考...') : '');

  if (subagentMd) {
    elements.push({
      tag: 'markdown',
      content: subagentMd,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (genericMd) {
    if (subagentMd) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: genericMd,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  if (bodyMd) {
    if (subagentMd || genericMd) elements.push({ tag: 'hr' });
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
