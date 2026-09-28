import React, { act, StrictMode, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext, appReducer, initialState } from './store';
import type { AppAction, AppState } from './store';
import { editingState, draftKey } from './projectPersistence';
import { ProjectPersistenceContext, useProjectPersistence } from './useProjectPersistence';
import type { ProjectControls } from './useProjectPersistence';
import { AppMainContent } from './App';
import ProjectBar from './components/ProjectBar';
import type { ProjectEditingState, ProjectSnapshot } from './types';
import * as apiModule from './api';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const snapshot = (): ProjectSnapshot => ({
  schema_version: 1, video_id: 'video', revision: 4, updated_at: '2026-09-28',
  video_info: { video_id: 'video', original_name: 'clip.mp4', duration: 30, width: 100, height: 100, fps: 30, file_size: 1 },
  analysis: null, media_status: 'available',
  state: { ...editingState(initialState), undo_stack: [null],
    edit_plan: { instruction: 'saved cut', summary: 'saved cut', estimated_duration: 20,
      operations: [{ type: 'cut', action: 'keep', start_time: 0, end_time: 20 }] } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('project persistence React integration', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: AppState;
  let dispatch: React.Dispatch<AppAction>;
  let controls: ProjectControls;
  let storage: Storage;
  const api = {
    current: vi.fn(async (): Promise<ProjectSnapshot | null> => snapshot()), list: vi.fn(async () => []),
    get: vi.fn(async () => snapshot()), open: vi.fn(async () => snapshot()),
    save: vi.fn(async (_id: string, revision: number, state: ProjectEditingState) => ({ ...snapshot(), revision: revision + 1, state })),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const entries = new Map<string, string>();
    storage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
      removeItem: (key) => { entries.delete(key); }, clear: () => entries.clear(),
      key: (index) => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
    vi.stubGlobal('localStorage', storage);
    api.current.mockReset().mockResolvedValue(snapshot());
    api.list.mockReset().mockResolvedValue([]);
    api.get.mockReset().mockResolvedValue(snapshot());
    api.open.mockReset().mockResolvedValue(snapshot());
    api.save.mockClear();
    vi.spyOn(apiModule, 'analyzeVideo').mockResolvedValue({ job_id: 'analysis' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  async function render(online = true, fullUi = false) {
    function Harness() {
      const [state, send] = useReducer(appReducer, { ...initialState, backendOnline: online, backendStatus: online ? 'online' : 'offline' });
      current = state; dispatch = send;
      controls = useProjectPersistence(state, send, api);
      return <AppContext.Provider value={{ state, dispatch: send }}>
        <ProjectPersistenceContext.Provider value={controls}>
          <ProjectBar />
          {fullUi ? <AppMainContent onRetryBackend={() => {}} retryingBackend={false} /> : null}
        </ProjectPersistenceContext.Provider>
      </AppContext.Provider>;
    }
    await act(async () => { root.render(<StrictMode><Harness /></StrictMode>); });
  }

  it('hydrates once in StrictMode after readiness without saving a default project over it', async () => {
    const pending = deferred<ProjectSnapshot | null>();
    api.current.mockReturnValue(pending.promise);
    await render(false);
    expect(api.current).not.toHaveBeenCalled();
    await act(async () => dispatch({ type: 'SET_BACKEND_STATE', status: 'online' }));
    expect(api.current).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Restoring');
    await act(async () => pending.resolve(snapshot()));
    expect(current.editPlan?.instruction).toBe('saved cut');
    expect(current.commandUndoStack).toEqual([null]);
    expect(container.querySelector('[aria-label="Save status"]')?.textContent).toBe('Saved');
    await act(async () => dispatch({ type: 'SET_BACKEND_STATE', status: 'online' }));
    expect(api.current).toHaveBeenCalledTimes(1);
    expect(api.save).not.toHaveBeenCalled();
  });

  it('writes a draft immediately on an edit and saves the undo state after its debounce', async () => {
    await render();
    await act(async () => dispatch({ type: 'UNDO_LAST_COMMAND' }));
    expect(current.editPlan).toBeNull();
    const key = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .find((item) => item?.startsWith(`${draftKey('video')}.`))!;
    expect(JSON.parse(storage.getItem(key)!).state.edit_plan).toBeNull();
    expect(container.querySelector('[aria-label="Save status"]')?.textContent).toContain('Saving');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(api.save).toHaveBeenCalledWith('video', 4, expect.objectContaining({ edit_plan: null, undo_stack: [] }));
    expect(current.projectRevision).toBe(5);
    expect(storage.getItem(key)).toBeNull();
  });

  it('shows a restoration error if the localStorage getter is denied and retries only on request', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    await render();
    expect(controls.ready).toBe(false);
    expect(container.textContent).toContain('Retry restore');
    expect(api.save).not.toHaveBeenCalled();
    Object.defineProperty(window, 'localStorage', descriptor!);
    await act(async () => { expect(await controls.retry()).toBe(true); });
    expect(current.videoId).toBe('video');
  });

  it('keeps saved analysis and plan visible but disables source-consuming actions for missing media', async () => {
    api.current.mockResolvedValue({ ...snapshot(), media_status: 'missing', analysis: {
      file_path: '/missing', duration: 30, width: 100, height: 100, fps: 30, scenes: [], transcript: [],
      quality: { silent_segments: [], audio_energy: [], overall_silence_ratio: 0 },
    } });
    await render(true, true);
    expect(current.editPlan).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.textContent).toContain('Source video is missing');
    const sourceButtons = Array.from(container.querySelectorAll('fieldset button'));
    expect(sourceButtons.length).toBeGreaterThan(0);
    expect(sourceButtons.every((button) => button.matches(':disabled'))).toBe(true);
    const send = container.querySelector('[aria-label="Send editing instruction"]');
    expect(send?.matches(':disabled')).toBe(true);
    expect(apiModule.analyzeVideo).not.toHaveBeenCalled();
    const check = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Check source again')!;
    await act(async () => check.click());
    expect(api.open).toHaveBeenCalledWith('video');
    expect(current.mediaStatus).toBe('available');
  });

  it('never automatically retries analysis when reopening a project without analysis', async () => {
    await render(true, true);
    expect(apiModule.analyzeVideo).not.toHaveBeenCalled();
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry analysis')!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(apiModule.analyzeVideo).toHaveBeenCalledExactlyOnceWith('video', false);
    expect(current.activeJob?.job_id).toBe('analysis');
  });

  it('offers explicit recovery and an Open saved version action for a prior window draft', async () => {
    const saved = snapshot();
    const foreign = { ...saved.state, edit_plan: { ...saved.state.edit_plan!, instruction: 'Unsaved previous session' } };
    const key = draftKey('video', 'old-window');
    const raw = JSON.stringify({ schema_version: 1, video_id: 'video', owner_id: 'old-window', generation: 'old-generation',
      base_revision: saved.revision, base_state: saved.state, state: foreign });
    storage.setItem(key, raw);
    await render();
    expect(controls.recoveryRequired).toBe(true);
    expect(container.textContent).toContain('Open saved version');
    expect(api.save).not.toHaveBeenCalled();
    const openSaved = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Open saved version')!;
    await act(async () => openSaved.click());
    expect(controls.recoveryRequired).toBe(false);
    expect(storage.getItem(key)).toBe(raw);
    const recover = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Recover copy 1')!;
    await act(async () => recover.click());
    expect(current.editPlan?.instruction).toBe('Unsaved previous session');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(api.save).toHaveBeenCalledWith('video', 4, foreign);
    expect(storage.getItem(key)).toBe(raw);
  });
});
