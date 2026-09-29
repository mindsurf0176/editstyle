import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftKey as projectDraftKey, editingState, ProjectPersistence, sameEditingState } from './projectPersistence';
import type { DraftJournal } from './projectPersistence';
import { initialState } from './store';
import type { ProjectEditingState, ProjectSnapshot } from './types';

const localStorage = {
  data: new Map<string, string>(),
  getItem(key: string) { return this.data.get(key) ?? null; },
  setItem(key: string, value: string) { this.data.set(key, value); },
  removeItem(key: string) { this.data.delete(key); },
  clear() { this.data.clear(); },
  key(index: number) { return [...this.data.keys()][index] ?? null; },
  get length() { return this.data.size; },
};
const draftKey = (id: string, owner = 'test') => projectDraftKey(id, owner);

const base = editingState(initialState);
const edited = (name: string): ProjectEditingState => ({ ...base,
  edit_plan: { instruction: name, summary: name, operations: [], estimated_duration: 10 }, undo_stack: [null],
});
const snapshot = (id = 'a', state = base, revision = 0): ProjectSnapshot => ({
  schema_version: 1, video_id: id, revision, updated_at: '2026-09-28T00:00:00Z', state,
  video_info: { video_id: id, original_name: `${id}.mp4`, duration: 10, width: 100, height: 100, fps: 25, file_size: 1 },
  analysis: null, media_status: 'available',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial = snapshot(), ownerId = 'test') {
  const api = {
    current: vi.fn(async () => initial), list: vi.fn(async () => []),
    get: vi.fn(async (id: string) => snapshot(id)), open: vi.fn(async (id: string) => snapshot(id)),
    save: vi.fn(async (id: string, revision: number, state: ProjectEditingState) => snapshot(id, state, revision + 1)),
  };
  const storage = { getItem: vi.fn((key: string) => localStorage.getItem(key)),
    setItem: vi.fn((key: string, value: string) => localStorage.setItem(key, value)),
    removeItem: vi.fn((key: string) => localStorage.removeItem(key)),
    key: (index: number) => localStorage.key(index), get length() { return localStorage.length; } };
  const hydrate = vi.fn();
  const ack = vi.fn();
  const manager = new ProjectPersistence(api, () => storage, hydrate, ack, 350, ownerId);
  const start = async () => { manager.setOnline(true); await manager.start(); };
  return { manager, api, storage, hydrate, ack, start };
}
function putDraft(state: ProjectEditingState, overrides: Partial<DraftJournal> = {}) {
  localStorage.setItem(draftKey('a'), JSON.stringify({ schema_version: 1, video_id: 'a', base_revision: 0,
    base_state: base, state, ...overrides }));
}

describe('project persistence and recovery', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('waits for backend readiness and restores once across repeated health checks', async () => {
    const h = harness();
    await h.manager.start();
    expect(h.api.current).not.toHaveBeenCalled();
    await h.start();
    h.manager.setOnline(true);
    h.manager.setOnline(false);
    h.manager.setOnline(true);
    await h.manager.start();
    expect(h.api.current).toHaveBeenCalledTimes(1);
    expect(h.hydrate).toHaveBeenCalledTimes(1);
  });

  it('serializes saves and keeps new edits dirty after an old acknowledgement', async () => {
    const h = harness(); await h.start();
    const first = deferred<ProjectSnapshot>();
    const second = deferred<ProjectSnapshot>();
    h.api.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.manager.observe('a', edited('first'));
    const save = h.manager.flush();
    h.manager.observe('a', edited('intermediate'));
    h.manager.observe('a', edited('latest'));
    expect(h.api.save).toHaveBeenCalledTimes(1);
    first.resolve(snapshot('a', edited('first'), 1));
    await Promise.resolve();
    expect(h.manager.view.status).toBe('saving');
    expect(h.manager.dirty).toBe(true);
    expect(h.api.save).toHaveBeenLastCalledWith('a', 1, edited('latest'));
    expect(JSON.parse(localStorage.getItem(draftKey('a'))!).state).toEqual(edited('latest'));
    second.resolve(snapshot('a', edited('latest'), 2));
    expect(await save).toBe(true);
    expect(h.manager.view.status).toBe('saved');
    expect(localStorage.getItem(draftKey('a'))).toBeNull();
  });

  it('journals an undo back to the base while an earlier edit is being saved', async () => {
    const h = harness(); await h.start();
    const response = deferred<ProjectSnapshot>();
    h.api.save.mockReturnValueOnce(response.promise);
    h.manager.observe('a', edited('sent'));
    const saving = h.manager.flush();
    h.manager.observe('a', base);
    const draft = JSON.parse(localStorage.getItem(draftKey('a'))!);
    expect(draft.state).toEqual(base);
    expect(draft.attempted_state).toEqual(edited('sent'));
    response.reject(new Error('Lost connection'));
    await saving;
    const reopened = harness(snapshot('a', edited('sent'), 1));
    await reopened.start();
    expect(reopened.hydrate.mock.calls[0][0].state).toEqual(base);
    await reopened.manager.flush();
    expect(reopened.api.save).toHaveBeenCalledWith('a', 1, base);
  });

  it('retains dirty edits and blocks save, import and switching when local storage is full', async () => {
    const h = harness(); await h.start();
    h.storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    h.manager.observe('a', edited('pending'));
    expect(await h.manager.flush()).toBe(false);
    const load = vi.fn(async () => snapshot('new'));
    expect(await h.manager.transition(load)).toBe(false);
    expect(await h.manager.switchProject('b')).toBe(false);
    expect(h.api.save).not.toHaveBeenCalled();
    expect(h.api.open).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(h.manager.view.error).toContain('storage is unavailable or full');
    expect(h.manager.dirty).toBe(true);
    h.storage.setItem.mockImplementation((key, value) => localStorage.setItem(key, value));
    expect(await h.manager.retry()).toBe(true);
    expect(h.api.save).toHaveBeenCalledWith('a', 0, edited('pending'));
  });

  it('blocks damaged recovery data until an explicit retry and does not overwrite it', async () => {
    localStorage.setItem(draftKey('a'), '{broken');
    const h = harness(); await h.start();
    expect(h.manager.view.ready).toBe(false);
    h.manager.setOnline(false); h.manager.setOnline(true);
    await Promise.resolve();
    expect(h.api.current).toHaveBeenCalledTimes(1);
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey('a'))).toBe('{broken');
    expect(h.api.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown project schema without autosaving', async () => {
    const h = harness({ ...snapshot(), schema_version: 9 } as unknown as ProjectSnapshot);
    await h.start();
    expect(h.manager.view.ready).toBe(false);
    expect(h.manager.view.error).toContain('Unsupported');
    h.manager.observe('a', edited('should not save'));
    expect(await h.manager.flush()).toBe(false);
  });

  it('restores metadata and editing state even when the source is missing', async () => {
    const saved = { ...snapshot('a', edited('preserved'), 4), media_status: 'missing' as const };
    const h = harness(saved); await h.start();
    expect(h.hydrate).toHaveBeenCalledWith(saved);
    expect(h.manager.view.status).toBe('saved');
    expect(h.api.save).not.toHaveBeenCalled();
  });

  it('recognizes a lost acknowledgement by reading identical state at a newer revision', async () => {
    const h = harness(); await h.start();
    h.api.save.mockRejectedValueOnce(new Error('Response lost'));
    h.manager.observe('a', edited('sent'));
    expect(await h.manager.flush()).toBe(false);
    h.api.get.mockResolvedValueOnce(snapshot('a', edited('sent'), 1));
    expect(await h.manager.retry()).toBe(true);
    expect(h.api.save).toHaveBeenCalledTimes(1);
    expect(h.manager.view.status).toBe('saved');
    expect(h.ack).toHaveBeenLastCalledWith('a', 1);
  });

  it('recovers new pending edits after a lost acknowledgement of an earlier edit', async () => {
    putDraft(edited('latest'), { attempted_state: edited('sent') });
    const h = harness(snapshot('a', edited('sent'), 1)); await h.start();
    expect(h.hydrate.mock.calls[0][0].state).toEqual(edited('latest'));
    expect(await h.manager.flush()).toBe(true);
    expect(h.api.save).toHaveBeenCalledWith('a', 1, edited('latest'));
  });

  it('keeps both versions on conflict and only replaces the saved version after explicit resolution', async () => {
    const h = harness(); await h.start();
    h.api.save.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    h.manager.observe('a', edited('mine'));
    expect(await h.manager.flush()).toBe(false);
    h.api.get.mockResolvedValue(snapshot('a', edited('theirs'), 3));
    expect(await h.manager.retry()).toBe(false);
    expect(h.manager.view.status).toBe('conflict');
    expect(h.api.save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(draftKey('a'))!).state).toEqual(edited('mine'));
    expect(await h.manager.overwriteSaved()).toBe(true);
    expect(h.api.save).toHaveBeenLastCalledWith('a', 3, edited('mine'));
  });

  it('can explicitly discard a conflicted draft and reload the saved version', async () => {
    putDraft(edited('mine'));
    const h = harness(snapshot('a', edited('theirs'), 3)); await h.start();
    h.api.get.mockResolvedValue(snapshot('a', edited('theirs'), 3));
    expect(h.manager.view.status).toBe('conflict');
    expect(await h.manager.reloadSaved()).toBe(true);
    expect(h.hydrate).toHaveBeenLastCalledWith(snapshot('a', edited('theirs'), 3));
    expect(localStorage.getItem(draftKey('a'))).toBeNull();
    expect(h.api.save).not.toHaveBeenCalled();
  });

  it('waits for in-flight saves before opening another project and ignores old-project edits', async () => {
    const h = harness(); await h.start();
    const first = deferred<ProjectSnapshot>();
    h.api.save.mockReturnValueOnce(first.promise);
    h.manager.observe('a', edited('first'));
    void h.manager.flush();
    const switching = h.manager.switchProject('b');
    expect(h.manager.view.transitioning).toBe(true);
    expect(h.api.open).not.toHaveBeenCalled();
    first.resolve(snapshot('a', edited('first'), 1));
    expect(await switching).toBe(true);
    h.manager.observe('a', edited('late'));
    expect(h.manager.videoId).toBe('b');
    expect(h.manager.dirty).toBe(false);
    expect(h.hydrate).toHaveBeenLastCalledWith(snapshot('b'));
  });

  it('retains the original identity when a transition cannot update the recovery journal', async () => {
    const h = harness(); await h.start();
    h.storage.removeItem.mockImplementation((key) => {
      if (key === draftKey('b')) throw new Error('Write denied');
      localStorage.removeItem(key);
    });
    expect(await h.manager.switchProject('b')).toBe(false);
    expect(h.manager.videoId).toBe('a');
    expect(h.hydrate).toHaveBeenCalledTimes(1);
    expect(await h.manager.retry()).toBe(true);
    expect(h.api.get).toHaveBeenLastCalledWith('a');
    expect(h.api.save).not.toHaveBeenCalled();
  });

  it('flushes edits that arrive while another project is being opened', async () => {
    const h = harness(); await h.start();
    const opened = deferred<ProjectSnapshot>();
    h.api.open.mockReturnValueOnce(opened.promise);
    const switching = h.manager.switchProject('b');
    await Promise.resolve(); await Promise.resolve();
    h.manager.observe('a', edited('late planning result'));
    opened.resolve(snapshot('b'));
    expect(await switching).toBe(true);
    expect(h.api.save).toHaveBeenCalledWith('a', 0, edited('late planning result'));
    expect(h.manager.videoId).toBe('b');
  });

  it('checks a restored source for the current project after saving local edits', async () => {
    const h = harness({ ...snapshot(), media_status: 'missing' }); await h.start();
    h.manager.observe('a', edited('kept'));
    h.api.open.mockResolvedValueOnce(snapshot('a', edited('kept'), 1));
    expect(await h.manager.switchProject('a')).toBe(true);
    expect(h.api.save).toHaveBeenCalledWith('a', 0, edited('kept'));
    expect(h.hydrate).toHaveBeenLastCalledWith(snapshot('a', edited('kept'), 1));
  });

  it('retains the original identity when importing a recovered project cannot journal its pending edits', async () => {
    const h = harness(); await h.start();
    localStorage.setItem(draftKey('b'), JSON.stringify({ schema_version: 1, video_id: 'b', base_revision: 0, base_state: base, state: edited('b pending') }));
    h.storage.setItem.mockImplementation(() => { throw new Error('Write denied'); });
    expect(await h.manager.transition(async () => snapshot('b'))).toBe(false);
    expect(h.manager.videoId).toBe('a');
    expect(h.hydrate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(draftKey('b'))!).state).toEqual(edited('b pending'));
  });

  it('reconnects with the dirty journal without rehydrating over current edits', async () => {
    const h = harness(); await h.start();
    h.manager.setOnline(false);
    h.manager.observe('a', edited('offline'));
    expect(await h.manager.flush()).toBe(false);
    h.manager.setOnline(true);
    await h.manager.retry();
    expect(h.hydrate).toHaveBeenCalledTimes(1);
    expect(h.api.save).toHaveBeenCalledWith('a', 0, edited('offline'));
    expect(h.manager.view.status).toBe('saved');
  });

  it('does not replace a different remote version with an older local draft on boot', async () => {
    putDraft(edited('local'), { base_revision: 5 });
    const h = harness(snapshot('a', edited('remote'), 6)); await h.start();
    expect(h.manager.view.status).toBe('conflict');
    expect(h.hydrate.mock.calls[0][0].state).toEqual(edited('local'));
    expect(await h.manager.flush()).toBe(false);
    expect(h.api.save).not.toHaveBeenCalled();
  });

  it('treats preset null defaults and JSON key order as the same saved contents', () => {
    const a = { ...base, planning_style_preset: { name: 'test', description: 'style' } };
    const b = JSON.parse(JSON.stringify({ ...base, planning_style_preset: { description: 'style', name: 'test', file: null, style: null } }));
    expect(sameEditingState(a, b)).toBe(true);
  });

  it('allows another import after the first import failed with no project open', async () => {
    const h = harness();
    h.api.current.mockResolvedValue(null as unknown as ProjectSnapshot);
    await h.start();
    expect(await h.manager.transition(async () => { throw new Error('Upload failed'); })).toBe(false);
    expect(h.manager.view.status).toBe('error');
    expect(await h.manager.retry()).toBe(true);
    expect(h.manager.view.status).toBe('saved');
    expect(await h.manager.transition(async () => snapshot('new'))).toBe(true);
    expect(h.manager.videoId).toBe('new');
  });

  it('isolates two writers sharing storage and restores the conflicted writer after a fresh restart', async () => {
    const a = harness(snapshot(), 'window-a'); const b = harness(snapshot(), 'window-b');
    await a.start(); await b.start();
    const responseA = deferred<ProjectSnapshot>(); const responseB = deferred<ProjectSnapshot>();
    a.api.save.mockReturnValueOnce(responseA.promise); b.api.save.mockReturnValueOnce(responseB.promise);
    a.manager.observe('a', edited('A'));
    const savingA = a.manager.flush();
    b.manager.observe('a', edited('B'));
    const savingB = b.manager.flush();
    const keyB = draftKey('a', 'window-b');
    const bRecord = localStorage.getItem(keyB);
    responseA.resolve(snapshot('a', edited('A'), 1));
    expect(await savingA).toBe(true);
    expect(localStorage.getItem(keyB)).toBe(bRecord);
    responseB.reject(Object.assign(new Error('conflict'), { status: 409 }));
    expect(await savingB).toBe(false);
    const restartedB = harness(snapshot('a', edited('A'), 1), 'new-window-b');
    restartedB.api.get.mockResolvedValue(snapshot('a', edited('A'), 1));
    await restartedB.start();
    expect(restartedB.manager.view.recoveryRequired).toBe(true);
    expect(restartedB.api.save).not.toHaveBeenCalled();
    expect(await restartedB.manager.recoverDraft(keyB)).toBe(true);
    expect(restartedB.hydrate).toHaveBeenLastCalledWith(snapshot('a', edited('B'), 1));
    expect(restartedB.manager.view.status).toBe('conflict');
    expect(localStorage.getItem(keyB)).toBe(bRecord);
    expect(JSON.parse(localStorage.getItem(draftKey('a', 'new-window-b'))!).state).toEqual(edited('B'));
  });

  it('preserves orphan copies when opening the saved version, including after another full restart', async () => {
    const original = harness(snapshot(), 'old-app'); await original.start();
    original.manager.observe('a', edited('orphan'));
    const key = draftKey('a', 'old-app'); const raw = localStorage.getItem(key);
    const reopened = harness(snapshot(), 'reopened-app'); await reopened.start();
    expect(reopened.manager.view.recoveryRequired).toBe(true);
    expect(await reopened.manager.reloadSaved()).toBe(true);
    expect(reopened.manager.view.recoveryRequired).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw);
    const again = harness(snapshot(), 'next-app'); await again.start();
    expect(again.manager.view.recoveryDrafts.map((copy) => copy.key)).toContain(key);
  });

  it('keeps the foreign source when copying its recovery state fails', async () => {
    const original = harness(snapshot(), 'old-app'); await original.start();
    original.manager.observe('a', edited('orphan'));
    const key = draftKey('a', 'old-app'); const raw = localStorage.getItem(key);
    const reopened = harness(snapshot(), 'new-app'); await reopened.start();
    reopened.storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(await reopened.manager.recoverDraft(key)).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(reopened.hydrate).toHaveBeenCalledTimes(1);
    expect(reopened.manager.dirty).toBe(false);
    expect(reopened.api.save).not.toHaveBeenCalled();
  });

  it('consumes only the recovered generation and preserves subsequent edits by its live owner', async () => {
    const original = harness(snapshot(), 'old-app'); await original.start();
    original.manager.observe('a', edited('orphan'));
    const key = draftKey('a', 'old-app');
    const reopened = harness(snapshot(), 'new-app'); await reopened.start();
    expect(await reopened.manager.recoverDraft(key)).toBe(true);
    const response = deferred<ProjectSnapshot>(); reopened.api.save.mockReturnValueOnce(response.promise);
    const saving = reopened.manager.flush();
    original.manager.observe('a', edited('newer live edit'));
    const newerRaw = localStorage.getItem(key);
    response.resolve(snapshot('a', edited('orphan'), 1));
    expect(await saving).toBe(true);
    expect(localStorage.getItem(key)).toBe(newerRaw);
    const next = harness(snapshot('a', edited('orphan'), 1), 'next-app'); await next.start();
    expect(next.manager.view.recoveryRequired).toBe(true);
    expect(next.manager.view.recoveryDrafts.map((copy) => copy.key)).toContain(key);
    next.api.get.mockResolvedValue(snapshot('a', edited('orphan'), 1));
    expect(await next.manager.recoverDraft(key)).toBe(true);
    expect(next.hydrate.mock.calls.at(-1)?.[0].state).toEqual(edited('newer live edit'));
  });

  it('does not consume a pending undo just because another window observes matching server contents', async () => {
    const a = harness(snapshot(), 'window-a'); await a.start();
    const response = deferred<ProjectSnapshot>(); a.api.save.mockReturnValueOnce(response.promise);
    a.manager.observe('a', edited('sent'));
    const saving = a.manager.flush();
    a.manager.observe('a', base);
    const key = draftKey('a', 'window-a'); const raw = localStorage.getItem(key);
    const b = harness(snapshot(), 'window-b'); await b.start();
    expect(b.manager.view.recoveryRequired).toBe(true);
    expect(localStorage.getItem(key)).toBe(raw);
    // The first request commits after B's GET, but A loses the acknowledgement.
    response.reject(new Error('Response lost after commit')); await saving;
    const restart = harness(snapshot('a', edited('sent'), 1), 'restart');
    restart.api.get.mockResolvedValue(snapshot('a', edited('sent'), 1));
    await restart.start();
    expect(restart.manager.view.recoveryDrafts.map((copy) => copy.key)).toContain(key);
    expect(await restart.manager.recoverDraft(key)).toBe(true);
    expect(restart.hydrate.mock.calls.at(-1)?.[0].state).toEqual(base);
    expect(await restart.manager.flush()).toBe(true);
    expect(restart.api.save).toHaveBeenCalledWith('a', 1, base);
  });

  it('fences an unresolved older save when explicitly recovering an undo equal to the current remote', async () => {
    const a = harness(snapshot(), 'window-a'); await a.start();
    const response = deferred<ProjectSnapshot>(); a.api.save.mockReturnValueOnce(response.promise);
    a.manager.observe('a', edited('sent'));
    const saving = a.manager.flush();
    a.manager.observe('a', base);
    const b = harness(snapshot(), 'window-b'); await b.start();
    expect(await b.manager.recoverDraft(draftKey('a', 'window-a'))).toBe(true);
    expect(b.manager.dirty).toBe(true);
    expect(JSON.parse(localStorage.getItem(draftKey('a', 'window-b'))!).fence_pending).toBe(true);
    b.storage.setItem.mockImplementationOnce(() => { throw new Error('temporary storage failure'); });
    expect(await b.manager.flush()).toBe(false);
    expect(await b.manager.retry()).toBe(true);
    expect(b.api.save).toHaveBeenCalledWith('a', 0, base);
    response.reject(Object.assign(new Error('old request fenced'), { status: 409 }));
    await saving;
  });

  it('treats a project saved before playhead support as the start of the source', () => {
    const legacy = { ...base } as ProjectEditingState;
    delete legacy.playhead_time;
    expect(sameEditingState(legacy, { ...base, playhead_time: 0 })).toBe(true);
    expect(sameEditingState(legacy, { ...base, playhead_time: 4 })).toBe(false);
  });
});
