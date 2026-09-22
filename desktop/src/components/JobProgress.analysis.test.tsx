import { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import JobProgress from './JobProgress';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { VideoAnalysis, VideoInfo } from '../types';
import * as api from '../api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const videoInfo: VideoInfo = {
  video_id: 'video-1',
  original_name: 'clip.mp4',
  duration: 42,
  width: 1920,
  height: 1080,
  fps: 30,
  file_size: 1_024,
};

const analysis: VideoAnalysis = {
  file_path: '/tmp/clip.mp4',
  duration: 42,
  fps: 30,
  width: 1920,
  height: 1080,
  scenes: [],
  transcript: [],
  quality: { silent_segments: [], audio_energy: [], overall_silence_ratio: 0 },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function TestHarness({
  initial,
  onDispatch,
}: {
  initial: AppState;
  onDispatch?: (dispatch: (action: AppAction) => void) => void;
}) {
  const [state, dispatch] = useReducer(appReducer, initial);
  onDispatch?.(dispatch);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <JobProgress />
    </AppContext.Provider>
  );
}

const completedAnalysisJob = {
  job_id: 'analysis-job-1',
  type: 'analysis' as const,
  status: 'completed' as const,
  progress: 100,
};

describe('JobProgress analysis completion', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }

    container?.remove();
    container = null;
  });

  it('dismisses the completion toast so it stops covering the action buttons', async () => {
    vi.spyOn(api, 'connectProgressWs').mockImplementation(() => ({ close() {} } as WebSocket));
    vi.spyOn(api, 'pollJob').mockResolvedValue({
      job_id: 'analysis-job-1',
      type: 'analysis',
      status: 'completed',
      progress: 100,
      result: { analysis },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TestHarness
          initial={{
            ...initialState,
            backendStatus: 'online',
            backendOnline: true,
            videoId: videoInfo.video_id,
            videoInfo,
            view: 'editor',
            sidebarTab: 'edit',
            activeJob: {
              job_id: 'analysis-job-1',
              type: 'analysis',
              status: 'completed',
              progress: 100,
            },
          }}
        />
      );
    });

    expect(container.textContent).toContain('analysis job');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
    });

    expect(container.textContent).toBe('');
  });

  it('still dismisses when status syncs keep replacing the job object', async () => {
    vi.spyOn(api, 'connectProgressWs').mockImplementation(() => ({ close() {} } as WebSocket));
    vi.spyOn(api, 'pollJob').mockResolvedValue({ ...completedAnalysisJob, result: { analysis } });

    let dispatch: ((action: AppAction) => void) | null = null;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <TestHarness
          initial={{
            ...initialState,
            backendStatus: 'online',
            backendOnline: true,
            videoId: videoInfo.video_id,
            videoInfo,
            view: 'editor',
            sidebarTab: 'edit',
            activeJob: completedAnalysisJob,
          }}
          onDispatch={(next) => {
            dispatch = next;
          }}
        />
      );
    });

    // A sync arriving inside the dismissal window must not restart the timer.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        dispatch?.({
          type: 'SYNC_ACTIVE_JOB',
          job: { ...completedAnalysisJob, result: { analysis } },
        });
      });
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(container.textContent).toBe('');
  });
});
