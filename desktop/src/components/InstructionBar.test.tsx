import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InstructionBar from './InstructionBar';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { EditPlan, VideoInfo } from '../types';
import * as api from '../api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const createPlanMock = vi.spyOn(api, 'createPlan');

const videoInfo: VideoInfo = {
  video_id: 'video-1',
  original_name: 'clip.mp4',
  duration: 42,
  width: 1920,
  height: 1080,
  fps: 30,
  file_size: 1024,
};

const existingPlan: EditPlan = {
  instruction: 'Remove silence and keep subtitles',
  operations: [],
  estimated_duration: 30,
  summary: 'Trim quiet moments',
};

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    backendStatus: 'online',
    backendOnline: true,
    videoId: videoInfo.video_id,
    videoInfo,
    view: 'editor',
    sidebarTab: 'edit',
    ...overrides,
  };
}

function getInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input');
  if (!input) {
    throw new Error('Input not found');
  }
  return input as HTMLInputElement;
}

function getButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector('form');
  if (!form) {
    throw new Error('Form not found');
  }
  return form as HTMLFormElement;
}

describe('InstructionBar planning bridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    createPlanMock.mockReset();

    if (root) {
      await act(async () => {
        root.unmount();
      });
    }

    container?.remove();
  });

  it('plans only the new command so existing manual edits can be preserved', async () => {
    const dispatchedActions: AppAction[] = [];
    const nextPlan: EditPlan = {
      instruction: 'Remove silence and keep subtitles\n\nAdditional refinement: make pacing faster',
      operations: [],
      estimated_duration: 24,
      summary: 'Faster pacing',
    };

    function Harness() {
      const [state, setState] = React.useState(() =>
        createState({
          editPlan: existingPlan,
          planningStylePreset: {
            name: 'cinematic',
            description: 'Warm contrast',
            file: 'cinematic.yaml',
          },
        })
      );

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <InstructionBar />
        </AppContext.Provider>
      );
    }

    createPlanMock.mockResolvedValue(nextPlan);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    const input = getInput(container);
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;

      if (!setValue) {
        throw new Error('Unable to set input value');
      }

      setValue.call(input, 'make pacing faster');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      getForm(container).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(createPlanMock).toHaveBeenCalledWith(
      'video-1',
      'make pacing faster',
      { stylePreset: 'cinematic.yaml' }
    );
    expect(dispatchedActions).toContainEqual({ type: 'APPLY_PLAN_PROPOSAL', plan: nextPlan, revision: 0 });
    expect(dispatchedActions).toContainEqual({ type: 'SET_SIDEBAR_TAB', tab: 'edit' });
    expect(dispatchedActions).toContainEqual({ type: 'SET_VIEW', view: 'editor' });
  });

  it('clears the current planning style from the instruction bar affordance', async () => {
    const dispatchedActions: AppAction[] = [];

    function Harness() {
      const [state, setState] = React.useState(() =>
        createState({
          planningStylePreset: {
            name: 'cinematic',
            description: 'Warm contrast',
            file: 'cinematic.yaml',
          },
        })
      );

      const dispatch = React.useCallback((action: AppAction) => {
        dispatchedActions.push(action);
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <InstructionBar />
        </AppContext.Provider>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain('Style context: cinematic');

    await act(async () => {
      getButtonByLabel(container, 'Clear style context').click();
    });

    expect(dispatchedActions).toContainEqual({
      type: 'SET_PLANNING_STYLE_PRESET',
      preset: null,
    });
    expect(container.textContent).not.toContain('Style context: cinematic');
  });
});
