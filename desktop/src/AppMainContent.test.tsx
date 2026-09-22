import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppMainContent } from './App';
import InstructionBar from './components/InstructionBar';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from './store';
import type { EditPlan, Preset, VideoInfo } from './types';
import * as api from './api';

vi.mock('./components/VideoPreview', () => ({
  default: () => <div data-testid="video-preview">video-preview</div>,
}));

vi.mock('./components/EditPlanPanel', () => ({
  default: () => <div data-testid="edit-plan-panel">edit-plan-panel</div>,
}));

vi.mock('./components/HighlightsPanel', () => ({
  default: () => <div data-testid="highlights-panel">highlights-panel</div>,
}));

vi.mock('./components/BackendGate', () => ({
  default: () => <div data-testid="backend-gate">backend-gate</div>,
}));

vi.mock('./components/DropZone', () => ({
  default: () => <div data-testid="drop-zone">drop-zone</div>,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getPresetsMock = vi.spyOn(api, 'getPresets');
const getPresetMock = vi.spyOn(api, 'getPreset');
const applyStyleMock = vi.spyOn(api, 'applyStyle');

const videoInfo: VideoInfo = {
  video_id: 'video-1',
  original_name: 'clip.mp4',
  duration: 42,
  width: 1920,
  height: 1080,
  fps: 30,
  file_size: 1024,
};

const preset: Preset = {
  name: 'cinematic',
  description: 'Warm contrast',
  file: 'cinematic.yaml',
};

const appliedPlan: EditPlan = {
  instruction: 'Apply cinematic style',
  operations: [],
  estimated_duration: 30,
  summary: 'Applied cinematic style',
};

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    backendStatus: 'online',
    backendOnline: true,
    videoId: videoInfo.video_id,
    videoInfo,
    analysis: { file_path: '/tmp/clip.mp4', duration: 42, fps: 30, width: 1920, height: 1080,
      scenes: [], transcript: [], quality: { silent_segments: [], audio_energy: [], overall_silence_ratio: 0 } },
    view: 'editor',
    sidebarTab: 'style',
    ...overrides,
  };
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

function getButtonsByLabel(container: HTMLElement, label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  ) as HTMLButtonElement[];
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('AppMainContent desktop style flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    getPresetsMock.mockReset();
    getPresetMock.mockReset();
    applyStyleMock.mockReset();

    if (root) {
      await act(async () => {
        root.unmount();
      });
    }

    container?.remove();
  });

  it('loads presets in the style sidebar and switches to edit after apply-now', async () => {
    function Harness() {
      const [state, setState] = React.useState(() => createState());

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <div className="h-full">
            <AppMainContent onRetryBackend={() => undefined} retryingBackend={false} />
            <InstructionBar />
          </div>
        </AppContext.Provider>
      );
    }

    const presetsRequest = createDeferredPromise<Preset[]>();
    getPresetsMock.mockReturnValue(presetsRequest.promise);
    getPresetMock.mockResolvedValue({ ...preset, style: { contrast: 1.1 } });
    applyStyleMock.mockResolvedValue(appliedPlan);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain('Loading presets...');

    await act(async () => {
      presetsRequest.resolve([preset]);
      await Promise.resolve();
    });

    expect(getPresetsMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('cinematic');
    expect(container.querySelector('[data-testid="video-preview"]')).not.toBeNull();

    await act(async () => {
      getButtonByLabel(container, 'Apply now').click();
    });

    await flushEffects();

    expect(getPresetMock).toHaveBeenCalledWith('cinematic');
    expect(applyStyleMock).toHaveBeenCalledWith('video-1', { ...preset, style: { contrast: 1.1 } });
    expect(container.querySelector('[data-testid="edit-plan-panel"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Use for planning');
    expect(container.textContent).toContain('Style context: cinematic');
  });

  it('retries preset loading after leaving and returning to the style sidebar', async () => {
    function Harness() {
      const [state, setState] = React.useState(() => createState({ sidebarTab: 'style', presets: [] }));

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <div className="h-full">
            <button type="button" onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'highlights' })}>
              Show highlights
            </button>
            <button type="button" onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'style' })}>
              Show styles
            </button>
            <AppMainContent onRetryBackend={() => undefined} retryingBackend={false} />
          </div>
        </AppContext.Provider>
      );
    }

    getPresetsMock
      .mockRejectedValueOnce(new Error('Preset list unavailable'))
      .mockResolvedValueOnce([preset]);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await flushEffects();

    expect(getPresetsMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Preset list unavailable');
    expect(container.querySelector('[aria-label="Editing tools"]')?.textContent).not.toContain('cinematic');

    await act(async () => {
      getButtonByLabel(container, 'Show highlights').click();
    });

    expect(container.querySelector('[data-testid="highlights-panel"]')).not.toBeNull();

    await act(async () => {
      getButtonByLabel(container, 'Show styles').click();
    });

    await flushEffects();

    expect(getPresetsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('cinematic');
    expect(container.textContent).not.toContain('Preset list unavailable');
  });

  it('keeps the style sidebar and current plan visible when apply-now fails', async () => {
    const existingPlan: EditPlan = {
      instruction: 'Keep the punchy intro',
      operations: [],
      estimated_duration: 18,
      summary: 'Existing desktop plan',
    };

    function Harness() {
      const [state, setState] = React.useState(() => createState({
        presets: [preset],
        editPlan: existingPlan,
        planningStylePreset: preset,
      }));

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <div className="h-full">
            <AppMainContent onRetryBackend={() => undefined} retryingBackend={false} />
            <InstructionBar />
            <div data-testid="sidebar-tab">{state.sidebarTab}</div>
            <div data-testid="view">{state.view}</div>
            <div data-testid="plan-summary">{state.editPlan?.summary ?? 'none'}</div>
            <div data-testid="error">{state.error ?? 'none'}</div>
          </div>
        </AppContext.Provider>
      );
    }

    getPresetMock.mockResolvedValue({ ...preset, style: { contrast: 1.1 } });
    applyStyleMock.mockRejectedValue(new Error('Apply now failed'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      getButtonsByLabel(container, 'Apply now')[0]?.click();
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="sidebar-tab"]')?.textContent).toBe('style');
    expect(container.querySelector('[data-testid="view"]')?.textContent).toBe('editor');
    expect(container.querySelector('[data-testid="plan-summary"]')?.textContent).toBe('Existing desktop plan');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('Apply now failed');
    expect(container.textContent).toContain('Planning with cinematic');
    expect(container.textContent).toContain('Style context: cinematic');
    expect(container.querySelector('[data-testid="edit-plan-panel"]')).toBeNull();
  });
});
