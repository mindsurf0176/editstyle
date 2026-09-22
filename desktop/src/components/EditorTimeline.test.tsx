/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import EditorTimeline from './EditorTimeline';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { EditPlan, VideoAnalysis, VideoInfo } from '../types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const videoInfo: VideoInfo = {
  video_id: 'video-1',
  original_name: 'clip.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  fps: 30,
  file_size: 1_024,
};

const analysis: VideoAnalysis = {
  file_path: '/tmp/clip.mp4',
  duration: 30,
  fps: 30,
  width: 1920,
  height: 1080,
  scenes: [
    {
      id: 1,
      start_time: 0,
      end_time: 10,
      duration: 10,
      has_speech: true,
      is_silent: false,
    },
    {
      id: 2,
      start_time: 10,
      end_time: 30,
      duration: 20,
      has_speech: false,
      is_silent: true,
    },
  ],
  transcript: [],
  quality: { silent_segments: [], audio_energy: [], overall_silence_ratio: 0 },
};

const editPlan: EditPlan = {
  instruction: 'Make a short edit',
  operations: [
    { type: 'cut', start_time: 2, end_time: 6, description: 'Trim intro' },
    { type: 'subtitle', description: 'No explicit range' },
    { type: 'speed', start_time: 12, end_time: 18 },
  ],
  estimated_duration: 24,
  summary: 'Short edit',
};

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    view: 'editor',
    sidebarTab: 'edit',
    ...overrides,
  };
}

function getButtonByLabel(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    label.test(candidate.getAttribute('aria-label') ?? candidate.getAttribute('title') ?? '')
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

describe('EditorTimeline', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }

    container?.remove();
  });

  async function renderTimeline(
    initial: AppState,
    dispatchedActions: AppAction[] = []
  ): Promise<void> {
    function Harness() {
      const [state, setState] = React.useState(initial);

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <EditorTimeline />
        </AppContext.Provider>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });
  }

  it('renders the empty no-video message', async () => {
    await renderTimeline(createState());

    expect(container.textContent).toContain('Import a video to build a timeline.');
  });

  it('allows manual source selection while analysis is unavailable', async () => {
    await renderTimeline(createState({ videoId: videoInfo.video_id, videoInfo, analysis: null }));

    expect(container.querySelector('[aria-label="Range start"]')).not.toBeNull();
    expect(container.textContent).toContain('Keep range');
  });

  it('renders Timeline and scene buttons with analysis', async () => {
    await renderTimeline(createState({ videoId: videoInfo.video_id, videoInfo, analysis }));

    expect(container.textContent).toContain('Timeline');
    expect(getButtonByLabel(container, /Scene 1: 0:00 - 0:10/)).toBeDefined();
    expect(getButtonByLabel(container, /Scene 2: 0:10 - 0:30/)).toBeDefined();
  });

  it('dispatches current time and range selection when clicking a scene', async () => {
    const dispatchedActions: AppAction[] = [];
    await renderTimeline(
      createState({ videoId: videoInfo.video_id, videoInfo, analysis }),
      dispatchedActions
    );

    await act(async () => {
      getButtonByLabel(container, /Scene 2: 0:10 - 0:30/).click();
    });

    expect(dispatchedActions).toContainEqual({ type: 'SET_CURRENT_TIME', time: 10 });
    expect(dispatchedActions).toContainEqual({
      type: 'SET_TIMELINE_SELECTION',
      selection: { type: 'range', start_time: 10, end_time: 30 },
    });
  });

  it('renders operation bars and dispatches operation selection when clicked', async () => {
    const dispatchedActions: AppAction[] = [];
    await renderTimeline(
      createState({ videoId: videoInfo.video_id, videoInfo, analysis, editPlan }),
      dispatchedActions
    );

    expect(container.textContent).toContain('cut');
    expect(container.textContent).toContain('speed');
    expect(container.textContent).not.toContain('subtitle');

    await act(async () => {
      getButtonByLabel(container, /cut: Trim intro/).click();
    });

    expect(dispatchedActions).toContainEqual({
      type: 'SET_TIMELINE_SELECTION',
      selection: { type: 'operation', operation_index: 0 },
    });
  });
});
