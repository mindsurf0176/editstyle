import { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JobProgress from './JobProgress';
import ProjectBar from './ProjectBar';
import { AppContext, appReducer, initialState } from '../store';
import type { AppAction, AppState } from '../store';
import type { Job } from '../types';
import { ProjectPersistenceContext } from '../useProjectPersistence';
import type { ProjectControls } from '../useProjectPersistence';
import * as api from '../api';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const running: Job = { job_id: 'old', type: 'render', status: 'running', progress: 40 };
const plan = { instruction: 'saved edit', summary: 'saved edit', estimated_duration: 10, operations: [] };
const controls: ProjectControls = {
  ready: true, transitioning: false, status: 'saved', error: null, listError: null, projects: [],
  recoveryRequired: false, recoveryDrafts: [], recoverDraft: async () => true,
  retry: async () => true, reloadSaved: async () => true, overwriteSaved: async () => true,
  switchProject: async () => true, refreshProjects: async () => {}, importVideo: async () => null,
};

describe('JobProgress backend restart recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: AppState;
  let dispatch: (action: AppAction) => void;
  let disconnect: () => void;
  let report: (data: { progress: number; status: string }) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(api, 'connectProgressWs').mockImplementation((_id, onProgress, onClose) => {
      disconnect = () => onClose?.();
      report = onProgress;
      return { close() { onClose?.(); } } as WebSocket;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  async function render(job: Job = running) {
    function Harness() {
      const [current, send] = useReducer(appReducer, {
        ...initialState, backendOnline: true, backendStatus: 'online', videoId: 'project',
        videoInfo: { video_id: 'project', original_name: 'source.mp4', duration: 10, width: 100, height: 100, fps: 30, file_size: 1 },
        editPlan: plan, commandUndoStack: [null], activeJob: job,
      });
      state = current; dispatch = send;
      return <AppContext.Provider value={{ state: current, dispatch: send }}>
        <ProjectPersistenceContext.Provider value={controls}><ProjectBar /></ProjectPersistenceContext.Provider>
        <JobProgress />
      </AppContext.Provider>;
    }
    await act(async () => { root.render(<Harness />); });
  }

  it('marks a confirmed missing job failed and unlocks project switching without losing edits', async () => {
    const poll = vi.spyOn(api, 'pollJob').mockRejectedValue(new api.ApiError(404, 'Job not found'));
    await render();
    expect(container.querySelector('select')?.disabled).toBe(true);
    await act(async () => disconnect());
    expect(state.activeJob?.status).toBe('failed');
    expect(state.editPlan).toEqual(plan);
    expect(state.commandUndoStack).toEqual([null]);
    expect(state.videoId).toBe('project');
    expect(state.renderResult).toBeNull();
    expect(container.querySelector('select')?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('start this job again');
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Network request failed'), new api.ApiError(503, 'temporarily unavailable')])(
    'keeps polling after a transient error without calling it interrupted: %s', async (error) => {
      const poll = vi.spyOn(api, 'pollJob').mockRejectedValueOnce(error).mockResolvedValue({
        ...running, status: 'completed', progress: 100, result: { output_path: '/render.mp4' },
      });
      await render();
      await act(async () => disconnect());
      expect(state.activeJob?.status).toBe('running');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(state.activeJob?.status).toBe('completed');
      expect(state.renderResult?.output_path).toBe('/render.mp4');
      expect(poll).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['missing', 'completed'])('ignores a late %s response from the previous job', async (outcome) => {
    let resolve!: (job: Job) => void;
    let reject!: (error: unknown) => void;
    vi.spyOn(api, 'pollJob').mockReturnValue(new Promise<Job>((yes, no) => { resolve = yes; reject = no; }));
    await render();
    await act(async () => disconnect());
    await act(async () => {
      dispatch({ type: 'CLEAR_JOB' });
      dispatch({ type: 'SET_ACTIVE_JOB', job: { ...running, job_id: 'new' } });
    });
    await act(async () => {
      if (outcome === 'missing') reject(new api.ApiError(404, 'old job gone'));
      else resolve({ ...running, status: 'completed', result: { output_path: '/old.mp4' } });
    });
    expect(state.activeJob).toEqual({ ...running, job_id: 'new' });
    expect(state.renderResult).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not overlap polls or restart polling when cleanup closes the socket', async () => {
    let resolve!: (job: Job) => void;
    const poll = vi.spyOn(api, 'pollJob').mockReturnValue(new Promise<Job>((yes) => { resolve = yes; }));
    await render();
    await act(async () => { disconnect(); disconnect(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => dispatch({ type: 'CLEAR_JOB' }));
    await act(async () => {
      resolve({ ...running, status: 'completed', result: { output_path: '/old.mp4' } });
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(state.activeJob).toBeNull();
    expect(state.renderResult).toBeNull();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a job disappearing between the completion event and its result lookup', async () => {
    vi.spyOn(api, 'pollJob').mockRejectedValue(new api.ApiError(404, 'Job not found'));
    await render();
    await act(async () => report({ status: 'completed', progress: 100 }));
    expect(state.activeJob?.status).toBe('failed');
    expect(state.renderResult).toBeNull();
    expect(state.editPlan).toEqual(plan);
    expect(container.textContent).toContain('backend may have restarted');
  });

  it('looks up an error-only websocket event before changing any job status', async () => {
    let reject!: (error: unknown) => void;
    const poll = vi.spyOn(api, 'pollJob').mockReturnValue(new Promise<Job>((_resolve, no) => { reject = no; }));
    await render();
    await act(async () => report({ error: 'Job not found: old' } as unknown as { progress: number; status: string }));
    expect(poll).toHaveBeenCalledWith('old');
    expect(state.activeJob?.status).toBe('running');
    expect(state.activeJob?.progress).toBe(40);
    await act(async () => reject(new api.ApiError(404, 'Job not found')));
    expect(state.activeJob?.status).toBe('failed');
    expect(container.querySelector('select')?.disabled).toBe(false);
  });
});
