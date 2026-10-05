/**
 * Preload: the contextBridge surface.
 *
 * Every function returns a plain promise; the renderer never sees ipcRenderer,
 * require, or any Node primitive.
 */
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const api = {
  status: () => invoke('status:get'),
  state: () => invoke('state:get'),

  voice: {
    train: (input: { text?: string; path?: string }) => invoke('voice:train', input),
  },

  drafts: {
    generate: (input: { moment: string; tags?: string[] }) => invoke('draft:generate', input),
    rescore: (input: { id: string; title?: string; body?: string }) => invoke('draft:rescore', input),
    approve: (input: { id: string; subreddit?: string }) => invoke('draft:approve', input),
    post: (input: { id: string }) => invoke('draft:post', input),
  },

  analytics: {
    report: () => invoke('analytics:report'),
  },

  suggest: {
    reply: (input: { postId: string }) => invoke('suggest:reply', input),
  },

  git: {
    sync: (input?: { repoPath?: string }) => invoke('git:sync', input ?? {}),
  },

  github: {
    verify: () => invoke('github:verify'),
  },

  config: {
    save: (input: Record<string, unknown>) => invoke('config:save', input),
  },

  calendar: {
    get: () => invoke('calendar:get'),
  },

  pricing: () => invoke('pricing:get'),
  plan: () => invoke('plan:get'),

  openExternal: (url: string) => invoke('shell:open', url),
};

export type UpvoteApi = typeof api;

contextBridge.exposeInMainWorld('upvote', api);