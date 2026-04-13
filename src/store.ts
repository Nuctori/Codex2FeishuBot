/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from './bridge/host.js';
import type { ChannelBinding, ChannelType } from './bridge/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

type StoredBridgeSession = BridgeSession & {
  name?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string;
};

type SessionTimestamps = {
  createdAt?: string;
  updatedAt?: string;
};

type DockBindingState = {
  openSessionIds?: string[];
  sessionSeenCounts?: Record<string, number>;
};

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function getSessionSortTime(session: StoredBridgeSession): number {
  const candidates = [session.updated_at, session.created_at];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }
  return 0;
}

function pickEarlierTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime)) return right;
  if (Number.isNaN(rightTime)) return left;
  return leftTime <= rightTime ? left : right;
}

function pickLaterTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime)) return right;
  if (Number.isNaN(rightTime)) return left;
  return leftTime >= rightTime ? left : right;
}

function getStoredSdkSessionId(session: StoredBridgeSession): string | undefined {
  const value = (session as unknown as Record<string, unknown>)['sdk_session_id'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isWeakSessionName(name: string | undefined, session: StoredBridgeSession): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('Bridge:')) return true;
  if (trimmed === session.id) return true;
  if (trimmed === session.id.slice(0, 8)) return true;
  if (trimmed === `Session ${session.id.slice(0, 8)}`) return true;
  const sdkSessionId = getStoredSdkSessionId(session);
  if (sdkSessionId && trimmed === `Codex ${sdkSessionId.slice(0, 8)}`) return true;
  return false;
}

function getDockState(binding: ChannelBinding): DockBindingState {
  const raw = binding as unknown as DockBindingState;
  const openSessionIds = Array.isArray(raw.openSessionIds)
    ? raw.openSessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : undefined;
  const sessionSeenCounts = raw.sessionSeenCounts && typeof raw.sessionSeenCounts === 'object'
    ? Object.fromEntries(
        Object.entries(raw.sessionSeenCounts).filter(
          ([key, value]) => typeof key === 'string' && key.trim().length > 0 && typeof value === 'number' && Number.isFinite(value),
        ),
      )
    : undefined;
  return { openSessionIds, sessionSeenCounts };
}

function getBindingStorageKey(channelType: string, chatId: string, bindingKey?: string): string {
  return `${channelType}:${bindingKey?.trim() || chatId}`;
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, StoredBridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, StoredBridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);

    this.normalizeLoadedState();
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  private mergeSessionMessages(targetSessionId: string, sourceSessionId: string): void {
    const target = [...this.loadMessages(targetSessionId)];
    const source = this.loadMessages(sourceSessionId);
    if (source.length === 0) return;
    this.messages.set(targetSessionId, [...source, ...target]);
    this.persistMessages(targetSessionId);
  }

  private chooseCanonicalSession(sessions: StoredBridgeSession[]): StoredBridgeSession {
    const currentBindingSessionIds = new Set(
      Array.from(this.bindings.values()).map((binding) => binding.codepilotSessionId),
    );
    const dockReferenceCounts = new Map<string, number>();

    for (const binding of this.bindings.values()) {
      const dockState = getDockState(binding);
      for (const dockSessionId of dockState.openSessionIds ?? []) {
        dockReferenceCounts.set(dockSessionId, (dockReferenceCounts.get(dockSessionId) ?? 0) + 1);
      }
    }

    return [...sessions].sort((left, right) => {
      const leftBound = currentBindingSessionIds.has(left.id) ? 1 : 0;
      const rightBound = currentBindingSessionIds.has(right.id) ? 1 : 0;
      if (leftBound !== rightBound) return rightBound - leftBound;

      const leftDockRefs = dockReferenceCounts.get(left.id) ?? 0;
      const rightDockRefs = dockReferenceCounts.get(right.id) ?? 0;
      if (leftDockRefs !== rightDockRefs) return rightDockRefs - leftDockRefs;

      const sortDelta = getSessionSortTime(right) - getSessionSortTime(left);
      if (sortDelta !== 0) return sortDelta;

      const messageDelta = this.loadMessages(right.id).length - this.loadMessages(left.id).length;
      if (messageDelta !== 0) return messageDelta;

      return right.id.localeCompare(left.id, 'en');
    })[0];
  }

  private mergeDuplicateSession(target: StoredBridgeSession, source: StoredBridgeSession): boolean {
    if (target.id === source.id) return false;

    this.mergeSessionMessages(target.id, source.id);

    if ((isWeakSessionName(target.name, target) || !target.name) && source.name && !isWeakSessionName(source.name, source)) {
      target.name = source.name;
    } else if (!target.name && source.name) {
      target.name = source.name;
    }

    if ((!target.system_prompt || !target.system_prompt.trim()) && source.system_prompt) {
      target.system_prompt = source.system_prompt;
    }
    if ((!target.provider_id || !target.provider_id.trim()) && source.provider_id) {
      target.provider_id = source.provider_id;
    }
    if ((!target.model || !target.model.trim()) && source.model) {
      target.model = source.model;
    }
    if ((!target.working_directory || !target.working_directory.trim()) && source.working_directory) {
      target.working_directory = source.working_directory;
    }

    const targetSdkSessionId = getStoredSdkSessionId(target);
    const sourceSdkSessionId = getStoredSdkSessionId(source);
    if (!targetSdkSessionId && sourceSdkSessionId) {
      (target as unknown as Record<string, unknown>)['sdk_session_id'] = sourceSdkSessionId;
    }

    target.created_at = pickEarlierTimestamp(target.created_at, source.created_at);
    target.updated_at = pickLaterTimestamp(target.updated_at, source.updated_at) || now();

    const archivedAt = now();
    source.archived_at = archivedAt;
    source.updated_at = archivedAt;

    return this.rewriteBindingsForMergedSession(target, source);
  }

  private rewriteBindingsForMergedSession(target: StoredBridgeSession, source: StoredBridgeSession): boolean {
    let changed = false;
    const targetSdkSessionId = getStoredSdkSessionId(target) || getStoredSdkSessionId(source) || '';

    for (const [key, binding] of this.bindings) {
      let nextBinding = binding as ChannelBinding & DockBindingState;
      let bindingChanged = false;

      if (binding.codepilotSessionId === source.id) {
        nextBinding = {
          ...nextBinding,
          codepilotSessionId: target.id,
          sdkSessionId: targetSdkSessionId,
          workingDirectory: target.working_directory,
          model: target.model,
          updatedAt: now(),
        };
        bindingChanged = true;
      } else if ((binding.sdkSessionId || '') === targetSdkSessionId && targetSdkSessionId) {
        if (binding.workingDirectory !== target.working_directory || binding.model !== target.model) {
          nextBinding = {
            ...nextBinding,
            workingDirectory: target.working_directory,
            model: target.model,
            updatedAt: now(),
          };
          bindingChanged = true;
        }
      }

      const dockState = getDockState(nextBinding);
      const remappedDockIds = dockState.openSessionIds
        ? Array.from(new Set(dockState.openSessionIds.map((sessionId) => (sessionId === source.id ? target.id : sessionId))))
        : undefined;
      const remappedSeenCounts = dockState.sessionSeenCounts
        ? { ...dockState.sessionSeenCounts }
        : undefined;

      if (remappedSeenCounts && typeof remappedSeenCounts[source.id] === 'number') {
        remappedSeenCounts[target.id] = Math.max(remappedSeenCounts[target.id] ?? 0, remappedSeenCounts[source.id] ?? 0);
        delete remappedSeenCounts[source.id];
      }

      if (
        JSON.stringify(remappedDockIds ?? []) !== JSON.stringify(dockState.openSessionIds ?? [])
        || JSON.stringify(remappedSeenCounts ?? {}) !== JSON.stringify(dockState.sessionSeenCounts ?? {})
      ) {
        nextBinding = {
          ...nextBinding,
          ...(remappedDockIds ? { openSessionIds: remappedDockIds } : {}),
          ...(remappedSeenCounts ? { sessionSeenCounts: remappedSeenCounts } : {}),
          updatedAt: now(),
        };
        bindingChanged = true;
      }

      if (bindingChanged) {
        this.bindings.set(key, nextBinding);
        changed = true;
      }
    }

    return changed;
  }

  private repairBindingSessionPointers(): boolean {
    let changed = false;
    const activeSessions = Array.from(this.sessions.values()).filter((session) => !session.archived_at);

    for (const [key, binding] of this.bindings) {
      const current = this.sessions.get(binding.codepilotSessionId);
      if (current && !current.archived_at) {
        continue;
      }

      if (!binding.sdkSessionId) continue;
      const replacement = activeSessions.find((session) => getStoredSdkSessionId(session) === binding.sdkSessionId);
      if (!replacement) continue;

      const dockState = getDockState(binding);
      const nextBinding: ChannelBinding & DockBindingState = {
        ...binding,
        codepilotSessionId: replacement.id,
        sdkSessionId: binding.sdkSessionId,
        workingDirectory: replacement.working_directory,
        model: replacement.model,
        updatedAt: now(),
        ...(dockState.openSessionIds
          ? {
              openSessionIds: Array.from(
                new Set(dockState.openSessionIds.map((sessionId) => (sessionId === binding.codepilotSessionId ? replacement.id : sessionId))),
              ),
            }
          : {}),
        ...(dockState.sessionSeenCounts
          ? {
              sessionSeenCounts: Object.fromEntries(
                Object.entries(dockState.sessionSeenCounts).map(([sessionId, seenCount]) => [
                  sessionId === binding.codepilotSessionId ? replacement.id : sessionId,
                  seenCount,
                ]),
              ),
            }
          : {}),
      };

      this.bindings.set(key, nextBinding);
      changed = true;
    }

    return changed;
  }

  private normalizeLoadedState(): void {
    let sessionsChanged = false;
    let bindingsChanged = false;
    const duplicateGroups = new Map<string, StoredBridgeSession[]>();

    for (const session of this.sessions.values()) {
      if (session.archived_at) continue;
      const sdkSessionId = getStoredSdkSessionId(session);
      if (!sdkSessionId) continue;
      const group = duplicateGroups.get(sdkSessionId) ?? [];
      group.push(session);
      duplicateGroups.set(sdkSessionId, group);
    }

    for (const group of duplicateGroups.values()) {
      if (group.length < 2) continue;
      const canonical = this.chooseCanonicalSession(group);
      for (const session of group) {
        if (session.id === canonical.id) continue;
        bindingsChanged = this.mergeDuplicateSession(canonical, session) || bindingsChanged;
        sessionsChanged = true;
      }
    }

    bindingsChanged = this.repairBindingSessionPointers() || bindingsChanged;

    if (sessionsChanged) {
      this.persistSessions();
    }
    if (bindingsChanged) {
      this.persistBindings();
    }
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string, bindingKey?: string): ChannelBinding | null {
    const direct = this.bindings.get(getBindingStorageKey(channelType, chatId, bindingKey));
    if (direct) return direct;
    if (bindingKey) return null;

    const matches = Array.from(this.bindings.values()).filter(
      (binding) => binding.channelType === channelType && binding.chatId === chatId,
    );
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
    return null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = getBindingStorageKey(data.channelType, data.chatId, data.bindingKey);
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        bindingKey: data.bindingKey ?? existing.bindingKey,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId ?? existing.sdkSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: (data.mode as 'code' | 'plan' | 'ask') ?? existing.mode,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      bindingKey: data.bindingKey,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (data.mode as 'code' | 'plan' | 'ask') || (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        const nextBinding = { ...b, ...updates, updatedAt: now() };
        const nextKey = getBindingStorageKey(nextBinding.channelType, nextBinding.chatId, nextBinding.bindingKey);
        if (nextKey !== key) {
          this.bindings.delete(key);
        }
        this.bindings.set(nextKey, nextBinding);
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  private touchSession(sessionId: string, updatedAt = now()): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.updated_at = updatedAt;
    this.persistSessions();
  }

  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
    timestamps?: SessionTimestamps,
  ): BridgeSession {
    const createdAt = timestamps?.createdAt || now();
    const updatedAt = timestamps?.updatedAt || createdAt;
    const session: StoredBridgeSession = {
      id: uuid(),
      name,
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
      created_at: createdAt,
      updated_at: updatedAt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionName(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.name = name;
    session.updated_at = now();
    this.persistSessions();
  }

  updateSessionMetadata(
    sessionId: string,
    updates: Partial<Pick<StoredBridgeSession, 'name' | 'working_directory' | 'model' | 'created_at' | 'updated_at'>>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (typeof updates.name === 'string') session.name = updates.name;
    if (typeof updates.working_directory === 'string' && updates.working_directory.trim()) {
      session.working_directory = updates.working_directory;
    }
    if (typeof updates.model === 'string') session.model = updates.model;
    if (typeof updates.created_at === 'string' && updates.created_at.trim()) session.created_at = updates.created_at;
    if (typeof updates.updated_at === 'string' && updates.updated_at.trim()) session.updated_at = updates.updated_at;
    this.persistSessions();
  }

  archiveSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const archivedAt = now();
    session.archived_at = archivedAt;
    session.updated_at = archivedAt;
    this.persistSessions();

    let bindingsChanged = false;
    for (const [key, binding] of this.bindings) {
      const dockState = getDockState(binding);
      const nextOpenSessionIds = (dockState.openSessionIds ?? []).filter((id) => id !== sessionId);
      const nextSeenCounts = { ...(dockState.sessionSeenCounts ?? {}) };
      delete nextSeenCounts[sessionId];

      if (
        JSON.stringify(nextOpenSessionIds) !== JSON.stringify(dockState.openSessionIds ?? [])
        || JSON.stringify(nextSeenCounts) !== JSON.stringify(dockState.sessionSeenCounts ?? {})
      ) {
        this.bindings.set(key, {
          ...binding,
          openSessionIds: nextOpenSessionIds,
          sessionSeenCounts: nextSeenCounts,
          updatedAt: archivedAt,
        } as ChannelBinding);
        bindingsChanged = true;
      }
    }

    if (bindingsChanged) {
      this.persistBindings();
    }
  }

  listSessions(): BridgeSession[] {
    return Array.from(this.sessions.values())
      .filter((session) => !session.archived_at)
      .sort((left, right) => getSessionSortTime(right) - getSessionSortTime(left));
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      s.updated_at = now();
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
    this.touchSession(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    const normalizedSdkSessionId = sdkSessionId.trim() || undefined;
    const duplicate = normalizedSdkSessionId
      ? Array.from(this.sessions.values()).find((session) => {
        if (session.id === sessionId || session.archived_at) return false;
        return getStoredSdkSessionId(session) === normalizedSdkSessionId;
      }) as StoredBridgeSession | undefined
      : undefined;

    if (duplicate) {
      this.mergeSessionMessages(sessionId, duplicate.id);
      if (!s.name && duplicate.name) s.name = duplicate.name;
      if ((!s.system_prompt || !s.system_prompt.trim()) && duplicate.system_prompt) s.system_prompt = duplicate.system_prompt;
      if ((!s.provider_id || !s.provider_id.trim()) && duplicate.provider_id) s.provider_id = duplicate.provider_id;
      if ((!s.model || !s.model.trim()) && duplicate.model) s.model = duplicate.model;
      s.created_at = pickEarlierTimestamp(s.created_at, duplicate.created_at);
      s.updated_at = pickLaterTimestamp(s.updated_at, duplicate.updated_at) || now();

      duplicate.archived_at = now();
      duplicate.updated_at = duplicate.archived_at;
      this.rewriteBindingsForMergedSession(s, duplicate);
    }

    (s as unknown as Record<string, unknown>)['sdk_session_id'] = normalizedSdkSessionId ?? '';
    s.updated_at = pickLaterTimestamp(s.updated_at, now()) || now();
    this.persistSessions();

    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, {
          ...b,
          sdkSessionId,
          workingDirectory: s.working_directory,
          model: s.model,
          updatedAt: now(),
        });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      s.updated_at = now();
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
