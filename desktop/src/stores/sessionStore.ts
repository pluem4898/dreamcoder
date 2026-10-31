import { create } from 'zustand'
import {
  sessionsApi,
  type BatchDeleteSessionsResponse,
  type BranchSessionResponse,
  type CreateSessionRepositoryOptions,
} from '../api/sessions'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useTabStore } from './tabStore'
import { useWorkspacePanelStore } from './workspacePanelStore'
import type { SessionListItem } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { RuntimeSelection } from '../types/runtime'
import { isPlaceholderSessionTitle } from '../lib/sessionTitle'

type CreateSessionOptions = {
  repository?: CreateSessionRepositoryOptions
  permissionMode?: PermissionMode
  runtime?: RuntimeSelection
}

type BranchSessionResult = Pick<BranchSessionResponse, 'sessionId' | 'title' | 'workDir'>

type SessionStore = {
  sessions: SessionListItem[]
  activeSessionId: string | null
  isLoading: boolean
  error: string | null
  isBatchMode: boolean
  selectedSessionIds: Set<string>

  fetchSessions: (project?: string) => Promise<void>
  createSession: (workDir?: string, options?: CreateSessionOptions) => Promise<string>
  branchSession: (
    sourceSessionId: string,
    targetMessageId: string,
    options?: { title?: string },
  ) => Promise<BranchSessionResult>
  deleteSession: (id: string) => Promise<void>
  deleteSessions: (ids: string[]) => Promise<BatchDeleteSessionsResponse>
  enterBatchMode: () => void
  exitBatchMode: () => void
  toggleSessionSelected: (id: string) => void
  selectSessions: (ids: string[]) => void
  deselectSessions: (ids: string[]) => void
  clearSessionSelection: () => void
  renameSession: (id: string, title: string) => Promise<void>
  updateSessionTitle: (id: string, title: string) => void
  setActiveSession: (id: string | null) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoading: false,
  error: null,
  isBatchMode: false,
  selectedSessionIds: new Set(),

  fetchSessions: async (project?: string) => {
    set({ isLoading: true, error: null })
    try {
      const t0 = performance.now()
      const { sessions: raw } = await sessionsApi.list({ project, limit: 100 })
      console.log(`[mem] fetchSessions:got ${raw.length} sessions in ${(performance.now()-t0).toFixed(0)}ms`)
      let syncedSessions: SessionListItem[] = []
      set((state) => {
        const currentById = new Map(state.sessions.map((session) => [session.id, session]))
        const byId = new Map<string, SessionListItem>()
        for (const s of raw) {
          const current = currentById.get(s.id)
          const candidate = preserveLocalTitle(current, s)
          const existing = byId.get(s.id)
          if (!existing || new Date(candidate.modifiedAt) > new Date(existing.modifiedAt)) {
            byId.set(s.id, candidate)
          }
        }
        if (!project) {
          const openSessionIds = new Set(useTabStore.getState().tabs
            .filter((tab) => tab.type === 'session')
            .map((tab) => tab.sessionId))
          for (const session of state.sessions) {
            if (openSessionIds.has(session.id) && !byId.has(session.id)) {
              byId.set(session.id, session)
            }
          }
        }
        const sessions = [...byId.values()]
        syncedSessions = sessions
        return { sessions, isLoading: false }
      })
      syncOpenSessionTabTitles(syncedSessions)
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createSession: async (workDir?: string, options?: CreateSessionOptions) => {
    const { sessionId: id, workDir: resolvedWorkDir } = await sessionsApi.create({
      ...(workDir ? { workDir } : {}),
      ...(options?.repository ? { repository: options.repository } : {}),
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options?.runtime ? { runtime: options.runtime } : {}),
    })
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id,
      title: 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: '',
      workDir: resolvedWorkDir ?? workDir ?? null,
      projectRoot: resolvedWorkDir ?? workDir ?? null,
      workDirExists: true,
    }

    set((state) => ({
      sessions: state.sessions.some((session) => session.id === id)
        ? state.sessions
        : [optimisticSession, ...state.sessions],
      activeSessionId: id,
    }))

    void get().fetchSessions()
    return id
  },

  branchSession: async (sourceSessionId, targetMessageId, options) => {
    const result = await sessionsApi.branch(sourceSessionId, {
      targetMessageId,
      ...(options?.title ? { title: options.title } : {}),
    })
    const sourceSession = get().sessions.find((session) => session.id === sourceSessionId)
    const now = new Date().toISOString()
    const optimisticSession: SessionListItem = {
      id: result.sessionId,
      title: result.title || 'New Session',
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      projectPath: sourceSession?.projectPath ?? '',
      projectRoot: sourceSession?.projectRoot ?? sourceSession?.workDir ?? result.workDir ?? null,
      workDir: result.workDir ?? sourceSession?.workDir ?? null,
      workDirExists: true,
    }

    set((state) => ({
      sessions: state.sessions.some((session) => session.id === result.sessionId)
        ? state.sessions.map((session) =>
            session.id === result.sessionId
              ? { ...session, ...optimisticSession }
              : session)
        : [optimisticSession, ...state.sessions],
      activeSessionId: result.sessionId,
    }))

    void get().fetchSessions()
    return {
      sessionId: result.sessionId,
      title: result.title,
      workDir: result.workDir,
    }
  },

  deleteSession: async (id: string) => {
    try {
      await sessionsApi.delete(id)
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error
    }
    removeSessions([id], set)
  },

  deleteSessions: async (ids: string[]) => {
    const sessionIds = [...new Set(ids)].filter(Boolean)
    const result = await sessionsApi.batchDelete(sessionIds)
    const missing = result.failures
      .filter((failure) => failure.code === 'NOT_FOUND')
      .map((failure) => failure.sessionId)
    const successes = [...result.successes, ...missing]
    removeSessions(successes, set)
    return {
      ...result,
      ok: result.failures.every((failure) => failure.code === 'NOT_FOUND'),
      successes,
      failures: result.failures.filter((failure) => failure.code !== 'NOT_FOUND'),
    }
  },

  enterBatchMode: () => set({ isBatchMode: true }),
  exitBatchMode: () => set({ isBatchMode: false, selectedSessionIds: new Set() }),
  toggleSessionSelected: (id) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    if (selectedSessionIds.has(id)) {
      selectedSessionIds.delete(id)
    } else {
      selectedSessionIds.add(id)
    }
    return { selectedSessionIds }
  }),
  selectSessions: (ids) => set((s) => {
    const selectedSessionIds = new Set(s.selectedSessionIds)
    for (const id of ids) selectedSessionIds.add(id)
    return { selectedSessionIds }
  }),
  deselectSessions: (ids) => set((s) => ({
    selectedSessionIds: removeIdsFromSet(s.selectedSessionIds, ids),
  })),
  clearSessionSelection: () => set({ selectedSessionIds: new Set() }),

  renameSession: async (id: string, title: string) => {
    await sessionsApi.rename(id, title)
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  updateSessionTitle: (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, title } : session,
      ),
    }))
  },

  setActiveSession: (id) => set({ activeSessionId: id }),
}))

function removeIdsFromSet(selected: Set<string>, ids: string[]): Set<string> {
  if (ids.length === 0) return selected
  const next = new Set(selected)
  for (const id of ids) next.delete(id)
  return next
}

function isSessionNotFoundError(error: unknown): error is { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

function removeSessions(
  ids: string[],
  set: (
    partial: Partial<SessionStore> | ((state: SessionStore) => Partial<SessionStore>),
  ) => void,
): void {
  if (ids.length === 0) return
  const removed = new Set(ids)
  for (const id of removed) {
    useSessionRuntimeStore.getState().clearSelection(id)
    useWorkspacePanelStore.getState().clearSession(id)
  }
  set((state) => ({
    sessions: state.sessions.filter((session) => !removed.has(session.id)),
    activeSessionId: state.activeSessionId && removed.has(state.activeSessionId)
      ? null
      : state.activeSessionId,
    selectedSessionIds: removeIdsFromSet(state.selectedSessionIds, ids),
  }))
}

function preserveLocalTitle(
  current: SessionListItem | undefined,
  incoming: SessionListItem,
): SessionListItem {
  if (!current) return incoming
  if (isPlaceholderSessionTitle(incoming.title) && !isPlaceholderSessionTitle(current.title)) {
    return { ...incoming, title: current.title }
  }
  return incoming
}

function syncOpenSessionTabTitles(sessions: SessionListItem[]): void {
  const titleById = new Map(sessions.map((session) => [session.id, session.title]))
  const { tabs, updateTabTitle } = useTabStore.getState()
  for (const tab of tabs) {
    if (tab.type !== 'session') continue
    const title = titleById.get(tab.sessionId)
    if (title && title !== tab.title) {
      updateTabTitle(tab.sessionId, title)
    }
  }
}
