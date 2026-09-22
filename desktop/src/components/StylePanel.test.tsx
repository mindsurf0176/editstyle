import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StylePanel from './StylePanel';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { EditPlan, Preset, VideoInfo } from '../types';
import * as api from '../api';

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

const altPreset: Preset = {
  name: 'vlog-casual',
  description: 'Bright and punchy',
  file: 'vlog-casual.yaml',
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
    (candidate) => candidate.textContent?.trim() === label
  );

  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }

  return button as HTMLButtonElement;
}

function getButtonsByLabel(container: HTMLElement, label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (candidate) => candidate.textContent?.trim() === label
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

describe('StylePanel', () => {
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

  it('loads presets on mount when the store is empty', async () => {
    function Harness() {
      const [state, setState] = React.useState(() => createState());

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <StylePanel />
        </AppContext.Provider>
      );
    }

    const presetsRequest = createDeferredPromise<Preset[]>();
    getPresetsMock.mockReturnValue(presetsRequest.promise);

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
    expect(container.textContent).toContain('Use for planning');
    expect(container.textContent).toContain('Apply now');
  });

  it('keeps planning selection separate from immediate style application', async () => {
    function Harness() {
      const [state, setState] = React.useState(() => createState({ presets: [preset] }));

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <div>
            <StylePanel />
            <div data-testid="sidebar-tab">{state.sidebarTab}</div>
            <div data-testid="view">{state.view}</div>
            <div data-testid="plan-summary">{state.editPlan?.summary ?? 'none'}</div>
          </div>
        </AppContext.Provider>
      );
    }

    getPresetMock.mockResolvedValue({ ...preset, style: { contrast: 1.1 } });
    applyStyleMock.mockResolvedValue(appliedPlan);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      getButtonByLabel(container, 'Use for planning').click();
    });

    expect(getPresetMock).not.toHaveBeenCalled();
    expect(applyStyleMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Planning with cinematic');
    expect(container.querySelector('[data-testid="sidebar-tab"]')?.textContent).toBe('style');
    expect(container.querySelector('[data-testid="view"]')?.textContent).toBe('editor');
    expect(container.querySelector('[data-testid="plan-summary"]')?.textContent).toBe('none');

    await act(async () => {
      getButtonByLabel(container, 'Apply now').click();
    });

    await flushEffects();

    expect(getPresetMock).toHaveBeenCalledWith('cinematic');
    expect(applyStyleMock).toHaveBeenCalledWith('video-1', { ...preset, style: { contrast: 1.1 } });
    expect(container.querySelector('[data-testid="sidebar-tab"]')?.textContent).toBe('edit');
    expect(container.querySelector('[data-testid="view"]')?.textContent).toBe('editor');
    expect(container.querySelector('[data-testid="plan-summary"]')?.textContent).toBe('Applied cinematic style');
    expect(container.textContent).toContain('Planning with cinematic');
  });

  it('preserves the existing plan, view, sidebar, and planning preset when apply-now fails', async () => {
    const existingPlan: EditPlan = {
      instruction: 'Keep subtitles',
      operations: [],
      estimated_duration: 20,
      summary: 'Existing plan summary',
    };

    function Harness() {
      const [state, setState] = React.useState(() => createState({
        presets: [preset, altPreset],
        editPlan: existingPlan,
        planningStylePreset: preset,
      }));

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <div>
            <StylePanel />
            <div data-testid="sidebar-tab">{state.sidebarTab}</div>
            <div data-testid="view">{state.view}</div>
            <div data-testid="plan-summary">{state.editPlan?.summary ?? 'none'}</div>
            <div data-testid="error">{state.error ?? 'none'}</div>
          </div>
        </AppContext.Provider>
      );
    }

    getPresetMock.mockResolvedValue({ ...altPreset, style: { contrast: 0.9 } });
    applyStyleMock.mockRejectedValue(new Error('Apply failed on backend'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      getButtonsByLabel(container, 'Apply now')[1]?.click();
    });

    await flushEffects();

    expect(getPresetMock).toHaveBeenCalledWith('vlog-casual');
    expect(applyStyleMock).toHaveBeenCalledWith('video-1', { ...altPreset, style: { contrast: 0.9 } });
    expect(container.querySelector('[data-testid="sidebar-tab"]')?.textContent).toBe('style');
    expect(container.querySelector('[data-testid="view"]')?.textContent).toBe('editor');
    expect(container.querySelector('[data-testid="plan-summary"]')?.textContent).toBe('Existing plan summary');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('Apply failed on backend');
    expect(container.textContent).toContain('Planning with cinematic');
    expect(container.textContent).not.toContain('Planning with vlog-casual');
  });

  it('replaces and clears the planning style selection', async () => {
    function Harness() {
      const [state, setState] = React.useState(() => createState({ presets: [preset, altPreset] }));

      const dispatch = React.useCallback((action: AppAction) => {
        setState((current) => appReducer(current, action));
      }, []);

      return (
        <AppContext.Provider value={{ state, dispatch }}>
          <StylePanel />
        </AppContext.Provider>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      getButtonsByLabel(container, 'Use for planning')[0]?.click();
    });

    expect(container.textContent).toContain('Planning with cinematic');

    await act(async () => {
      getButtonsByLabel(container, 'Use for planning')[0]?.click();
    });

    expect(container.textContent).toContain('Planning with vlog-casual');
    expect(container.textContent).not.toContain('Planning with cinematic');

    await act(async () => {
      getButtonByLabel(container, 'Clear').click();
    });

    expect(container.textContent).not.toContain('Planning with vlog-casual');
  });
});
