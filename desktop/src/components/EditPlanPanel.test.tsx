import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EditPlanPanel from './EditPlanPanel';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { EditPlan, VideoAnalysis, VideoInfo } from '../types';
import * as api from '../api';

const startPreviewMock = vi.spyOn(api, 'startPreview');
const startRenderMock = vi.spyOn(api, 'startRender');

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

const editPlan: EditPlan = {
  instruction: 'Make a quick trailer',
  operations: [{ type: 'cut', start_time: 0, end_time: 12, description: 'Trim intro' }],
  estimated_duration: 12,
  summary: 'Trim intro',
};

const subtitleEditPlan: EditPlan = {
  instruction: 'Add subtitles',
  operations: [{ type: 'subtitle', description: 'Caption spoken dialogue' }],
  estimated_duration: 42,
  summary: 'Add subtitles',
};

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    backendStatus: 'online',
    backendOnline: true,
    view: 'editor',
    sidebarTab: 'edit',
    videoId: videoInfo.video_id,
    videoInfo,
    analysis,
    editPlan,
    ...overrides,
  };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

function getButtonContaining(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label)
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

describe('EditPlanPanel preview resolution flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    startPreviewMock.mockReset();
    startRenderMock.mockReset();

    if (root) {
      await act(async () => {
        root.unmount();
      });
    }

    container?.remove();
  });

  it('dispatches resolution changes and previews using the selected resolution', async () => {
    const dispatchedActions: AppAction[] = [];

    function Harness() {
      const [state, setState] = React.useState(() => createState());

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <EditPlanPanel />
        </AppContext.Provider>
      );
    }

    startPreviewMock.mockResolvedValue({ job_id: 'preview-job-720' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(getButton(container, 'Preview 360p')).toBeDefined();
    expect(container.textContent).not.toContain('Subtitle export');

    await act(async () => {
      getButton(container, '720p').click();
    });

    expect(dispatchedActions).toContainEqual({
      type: 'SET_PREVIEW_RESOLUTION',
      resolution: 720,
    });
    expect(getButton(container, 'Preview 720p')).toBeDefined();

    await act(async () => {
      getButton(container, 'Preview 720p').click();
    });

    expect(startPreviewMock).toHaveBeenCalledWith(videoInfo.video_id, editPlan, 720);
    expect(dispatchedActions).toContainEqual({ type: 'SET_PREVIEW_RESULT', preview: null });
    expect(dispatchedActions).toContainEqual({
      type: 'SET_ACTIVE_JOB',
      revision: 0,
      job: { job_id: 'preview-job-720', type: 'preview', status: 'running', progress: 0 },
    });
    expect(dispatchedActions).toContainEqual({ type: 'SET_VIEW', view: 'editor' });
  });

  it('dispatches render preset changes and renders using the selected preset', async () => {
    const dispatchedActions: AppAction[] = [];

    function Harness() {
      const [state, setState] = React.useState(() => createState());

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <EditPlanPanel />
        </AppContext.Provider>
      );
    }

    startRenderMock.mockResolvedValue({ job_id: 'render-job-high' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(getButton(container, 'Render Balanced')).toBeDefined();

    await act(async () => {
      getButton(container, 'High').click();
    });

    expect(dispatchedActions).toContainEqual({
      type: 'SET_RENDER_PRESET',
      renderPreset: 'high',
    });
    expect(getButton(container, 'Render High')).toBeDefined();

    await act(async () => {
      getButton(container, 'Render High').click();
    });

    expect(startRenderMock).toHaveBeenCalledWith(videoInfo.video_id, editPlan, 'high', 'burned');
    expect(dispatchedActions).toContainEqual({ type: 'SET_RENDER_RESULT', render: null });
    expect(dispatchedActions).toContainEqual({
      type: 'SET_ACTIVE_JOB',
      revision: 0,
      job: { job_id: 'render-job-high', type: 'render', status: 'running', progress: 0 },
    });
    expect(dispatchedActions).toContainEqual({ type: 'SET_VIEW', view: 'rendering' });
  });

  it('shows subtitle export settings only for subtitle plans and renders with the selected mode', async () => {
    const dispatchedActions: AppAction[] = [];

    function Harness() {
      const [state, setState] = React.useState(() => createState({ editPlan: subtitleEditPlan }));

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <EditPlanPanel />
        </AppContext.Provider>
      );
    }

    startRenderMock.mockResolvedValue({ job_id: 'render-job-sidecar' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain('Subtitle export');
    expect(container.textContent).toContain('Burn into video');
    expect(container.textContent).toContain('Save subtitle file');

    await act(async () => {
      getButtonContaining(container, 'Save subtitle file').click();
    });

    expect(dispatchedActions).toContainEqual({
      type: 'SET_SUBTITLE_EXPORT_MODE',
      subtitleExportMode: 'sidecar',
    });

    await act(async () => {
      getButton(container, 'Render Balanced').click();
    });

    expect(startRenderMock).toHaveBeenCalledWith(
      videoInfo.video_id,
      subtitleEditPlan,
      'balanced',
      'sidecar'
    );
  });

  it('shows the colour grade preset so two grades are distinguishable', async () => {
    function Harness() {
      const [state] = React.useState(() =>
        createState({
          editPlan: {
            instruction: '차가운 톤으로 색보정해줘',
            operations: [{ type: 'colorgrade', preset: 'cool', intensity: 50 }],
            estimated_duration: 42,
            summary: 'Apply cool color grade',
          },
        })
      );

      return (
        <AppContext.Provider value={{ state, dispatch: () => {} }}>
          <EditPlanPanel />
        </AppContext.Provider>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain('cool');
  });
});
