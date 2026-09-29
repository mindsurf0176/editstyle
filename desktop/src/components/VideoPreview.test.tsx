import { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VideoPreview from './VideoPreview';
import { AppContext, appReducer, initialState, type AppState } from '../store';
import type { EditPlan, VideoAnalysis, VideoInfo } from '../types';
import * as api from '../api';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
  quality: {
    silent_segments: [],
    audio_energy: [],
    overall_silence_ratio: 0,
  },
};

const editPlan: EditPlan = {
  instruction: 'Trim the intro and add subtitles',
  operations: [
    {
      type: 'cut',
      start_time: 0,
      end_time: 3,
      description: 'Remove the intro',
    },
  ],
  estimated_duration: 39,
  summary: 'Trim intro',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    backendStatus: 'online',
    backendOnline: true,
    videoId: videoInfo.video_id,
    videoInfo,
    view: 'editor',
    sidebarTab: 'edit',
    previewResult: { job_id: 'preview-job-1', output_path: '/tmp/preview.mp4', resolution: 360 },
    renderResult: {
      job_id: 'render-job-1',
      output_path: '/tmp/render.mp4',
      resolution: 1080,
      render_preset: 'balanced',
    },
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

function getButtonByTitle(container: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('title') === title
  );

  if (!button) {
    throw new Error(`Button not found for title: ${title}`);
  }

  return button as HTMLButtonElement;
}

function getContainer(): HTMLDivElement {
  if (!container) {
    throw new Error('Test container has not been initialized');
  }

  return container;
}

function getRoot(): Root {
  if (!root) {
    throw new Error('Test root has not been initialized');
  }

  return root;
}

function TestHarness({ initial }: { initial: AppState }) {
  const [state, dispatch] = useReducer(appReducer, initial);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <VideoPreview />
      <pre data-testid="state-snapshot" hidden>
        {JSON.stringify({
          previewResolution: state.previewResolution,
          renderPreset: state.renderPreset,
          subtitleExportMode: state.subtitleExportMode,
          activeJob: state.activeJob,
          view: state.view,
        })}
      </pre>
    </AppContext.Provider>
  );
}

function renderPreview(initial: AppState) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  return act(async () => {
    getRoot().render(<TestHarness initial={initial} />);
  });
}

function installMediaMocks(video: HTMLVideoElement) {
  const play = vi.fn(async () => {
    video.dispatchEvent(new Event('play', { bubbles: false }));
  });
  const pause = vi.fn(() => {
    video.dispatchEvent(new Event('pause', { bubbles: false }));
  });

  Object.defineProperty(video, 'play', {
    configurable: true,
    value: play,
  });
  Object.defineProperty(video, 'pause', {
    configurable: true,
    value: pause,
  });

  return { play, pause };
}

function getStateSnapshot() {
  const snapshot = getContainer().querySelector('[data-testid="state-snapshot"]')?.textContent;

  if (!snapshot) {
    throw new Error('State snapshot not found');
  }

  return JSON.parse(snapshot) as {
    previewResolution: AppState['previewResolution'];
    renderPreset: AppState['renderPreset'];
    subtitleExportMode: AppState['subtitleExportMode'];
    activeJob: AppState['activeJob'];
    view: AppState['view'];
  };
}

describe('VideoPreview mode switching', () => {
  afterEach(async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();

    if (root) {
      await act(async () => {
        getRoot().unmount();
      });
      root = null;
    }

    container?.remove();
    container = null;
  });

  it('shows completed render in-app and preserves source/preview/render single-view switching', async () => {
    await renderPreview(createState());
    const container = getContainer();

    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toContain('/api/render/render-job-1/video');
    expect(container.textContent).toContain('Single view');
    expect(container.textContent).toContain('Source / Render');
    expect(container.textContent).toContain('Preview / Render');
    expect(container.textContent).toContain('Output: Balanced · 1080p');
    expect(container.textContent).toContain('Render Balanced · 1080p');

    await act(async () => {
      getButton(container, 'Source').click();
    });
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/videos/video-1/media');

    await act(async () => {
      getButton(container, 'Preview').click();
    });
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/preview/preview-job-1/video');

    const holdButton = getButton(container, 'Hold for source');
    await act(async () => {
      holdButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/videos/video-1/media');

    await act(async () => {
      holdButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/preview/preview-job-1/video');
  });

  it('supports source/render split compare with render-specific actions', async () => {
    await renderPreview(createState());
    const container = getContainer();

    await act(async () => {
      getButton(container, 'Source / Render').click();
    });

    const videos = Array.from(container.querySelectorAll('video'));
    expect(videos).toHaveLength(1);
    expect(videos[0]?.getAttribute('src')).toContain('/api/render/render-job-1/video');
    expect(container.querySelector('img[alt="Video frame"]')).toBeTruthy();
    expect(container.textContent).toContain('Split compare: source and render');
    expect(container.textContent).not.toContain('Hold for source');

    const downloadLinks = Array.from(container.querySelectorAll('a'));
    expect(downloadLinks).toHaveLength(1);
    expect(downloadLinks[0]?.textContent).toContain('Download render');
    expect(downloadLinks[0]?.getAttribute('href')).toContain('/api/render/render-job-1/download');

    await act(async () => {
      getButton(container, 'Source').click();
    });
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/videos/video-1/media');
  });

  it('renders desktop export actions and passes suggested preview/render filenames', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const exportSpy = vi
      .spyOn(api, 'exportBundleOrUrl')
      .mockResolvedValueOnce({
        savedPrimaryPath: '/Users/minseo/Exports/clip-preview-360p.mp4',
        savedCompanionPaths: [],
      })
      .mockResolvedValueOnce({
        savedPrimaryPath: '/Users/minseo/Exports/clip-render.mp4',
        savedCompanionPaths: [],
      });
    const openSpy = vi.spyOn(api, 'openPathOrUrl').mockResolvedValue();
    const revealSpy = vi.spyOn(api, 'revealPathOrUrl').mockResolvedValue();

    await renderPreview(createState());
    const container = getContainer();

    await act(async () => {
      getButton(container, 'Preview / Render').click();
    });

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(getButton(container, 'Save preview as')).toBeTruthy();
    expect(getButton(container, 'Export render')).toBeTruthy();

    await act(async () => {
      getButton(container, 'Save preview as').click();
    });
    expect(exportSpy).toHaveBeenNthCalledWith(
      1,
      { output_path: '/tmp/preview.mp4', resolution: 360, job_id: 'preview-job-1' },
      'clip-preview-360p.mp4',
      'http://127.0.0.1:18910/api/preview/preview-job-1/download'
    );
    expect(container.textContent).toContain('Preview saved');
    expect(container.textContent).toContain('/Users/minseo/Exports/clip-preview-360p.mp4');

    await act(async () => {
      getButton(container, 'Reveal in folder').click();
    });
    expect(revealSpy).toHaveBeenCalledWith('/Users/minseo/Exports/clip-preview-360p.mp4');

    await act(async () => {
      getButton(container, 'Open file').click();
    });
    expect(openSpy).toHaveBeenCalledWith('/Users/minseo/Exports/clip-preview-360p.mp4');

    await act(async () => {
      getButton(container, 'Export render').click();
    });
    expect(exportSpy).toHaveBeenNthCalledWith(
      2,
      {
        job_id: 'render-job-1',
        output_path: '/tmp/render.mp4',
        resolution: 1080,
        render_preset: 'balanced',
      },
      'clip-render.mp4',
      'http://127.0.0.1:18910/api/render/render-job-1/download'
    );
    expect(container.textContent).toContain('Render saved');
    expect(container.textContent).toContain('Balanced · 1080p');
    expect(container.textContent).toContain('/Users/minseo/Exports/clip-render.mp4');
  });

  it('supports preview/render split compare with actions for both assets', async () => {
    await renderPreview(createState());
    const container = getContainer();

    await act(async () => {
      getButton(container, 'Preview / Render').click();
    });

    const videos = Array.from(container.querySelectorAll('video'));
    expect(videos).toHaveLength(2);
    expect(videos[0]?.getAttribute('src')).toContain('/api/preview/preview-job-1/video');
    expect(videos[1]?.getAttribute('src')).toContain('/api/render/render-job-1/video');
    expect(container.textContent).toContain('Split compare: preview and render');

    const downloadLinks = Array.from(container.querySelectorAll('a'));
    expect(downloadLinks).toHaveLength(2);
    expect(downloadLinks[0]?.textContent).toContain('Download preview');
    expect(downloadLinks[0]?.getAttribute('href')).toContain('/api/preview/preview-job-1/download');
    expect(downloadLinks[1]?.textContent).toContain('Download render');
    expect(downloadLinks[1]?.getAttribute('href')).toContain('/api/render/render-job-1/download');

    await act(async () => {
      getButton(container, 'Single view').click();
    });
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/render/render-job-1/video');
  });

  it('syncs play, pause, and seek between preview/render compare videos', async () => {
    await renderPreview(createState());
    const container = getContainer();

    await act(async () => {
      getButton(container, 'Preview / Render').click();
    });

    const videos = Array.from(container.querySelectorAll('video')) as HTMLVideoElement[];
    expect(videos).toHaveLength(2);

    const previewVideo = videos[0];
    const renderVideo = videos[1];
    const previewControls = installMediaMocks(previewVideo);
    const renderControls = installMediaMocks(renderVideo);

    await act(async () => {
      previewVideo.dispatchEvent(new Event('play', { bubbles: false }));
    });
    expect(renderControls.play).toHaveBeenCalledTimes(1);
    expect(previewControls.play).toHaveBeenCalledTimes(0);

    await act(async () => {
      renderVideo.dispatchEvent(new Event('pause', { bubbles: false }));
    });
    expect(previewControls.pause).toHaveBeenCalledTimes(1);
    expect(renderControls.pause).toHaveBeenCalledTimes(0);

    await act(async () => {
      previewVideo.currentTime = 12.4;
      previewVideo.dispatchEvent(new Event('seeked', { bubbles: false }));
    });
    expect(renderVideo.currentTime).toBeCloseTo(12.4, 3);
    expect(container.textContent).toContain('0:12');

    await act(async () => {
      renderVideo.currentTime = 18.2;
      renderVideo.dispatchEvent(new Event('timeupdate', { bubbles: false }));
    });
    expect(previewVideo.currentTime).toBeCloseTo(18.2, 3);
    expect(container.textContent).toContain('0:18');
  });

  it('promotes a selected recent output into the current reviewed asset and switches display mode', async () => {
    await renderPreview(createState({
      previewResult: { job_id: 'preview-current', output_path: '/tmp/preview-current.mp4', resolution: 360 },
      renderResult: {
        job_id: 'render-current',
        output_path: '/tmp/render-current.mp4',
        resolution: 1080,
        render_preset: 'balanced',
      },
      recentOutputs: [
        {
          kind: 'preview',
          job_id: 'preview-history',
          output_path: '/tmp/preview-history.mp4',
          resolution: 480,
          original_name: 'history-preview.mp4',
          completed_at: '2026-03-28T00:00:00Z',
        },
        {
          kind: 'render',
          job_id: 'render-history',
          output_path: '/tmp/render-history.mp4',
          resolution: 720,
          render_preset: 'draft',
          original_name: 'history-render.mp4',
          completed_at: '2026-03-28T00:01:00Z',
        },
      ],
    }));
    const container = getContainer();

    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/render/render-current/video');

    await act(async () => {
      getButtonByTitle(container, 'history-preview.mp4 -> preview-history.mp4').click();
    });

    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/preview/preview-history/video');
    expect(container.textContent).toContain('Preview ready');
    expect(container.textContent).toContain('Preview 480p');

    await act(async () => {
      getButtonByTitle(container, 'history-render.mp4 -> render-history.mp4').click();
    });

    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/render/render-history/video');
    expect(container.textContent).toContain('Render ready');
    expect(container.textContent).toContain('Render Draft · 720p');
  });

  it('reruns a selected recent preview with its saved resolution using the current video and edit plan', async () => {
    const startPreviewSpy = vi.spyOn(api, 'startPreview').mockResolvedValue({ job_id: 'preview-rerun-job' });

    await renderPreview(createState({
      analysis,
      editPlan,
      previewResolution: 360,
      recentOutputs: [
        {
          kind: 'preview',
          job_id: 'preview-history',
          video_id: 'old-video',
          output_path: '/tmp/preview-history.mp4',
          resolution: 480,
          original_name: 'history-preview.mp4',
          completed_at: '2026-03-28T00:00:00Z',
        },
      ],
    }));
    const container = getContainer();

    expect(container.textContent).toContain(
      'This will run on the current video: clip.mp4. Selected output was created from: history-preview.mp4.'
    );

    await act(async () => {
      getButton(container, 'Rerun selected').click();
    });

    expect(startPreviewSpy).toHaveBeenCalledWith(videoInfo.video_id, editPlan, 480);
    expect(getStateSnapshot()).toMatchObject({
      previewResolution: 480,
      activeJob: {
        job_id: 'preview-rerun-job',
        type: 'preview',
        status: 'running',
        progress: 0,
      },
      view: 'editor',
    });
  });

  it('reruns a selected recent render with its saved preset using the current video and edit plan', async () => {
    const startRenderSpy = vi.spyOn(api, 'startRender').mockResolvedValue({ job_id: 'render-rerun-job' });

    await renderPreview(createState({
      analysis,
      editPlan,
      renderPreset: 'balanced',
      subtitleExportMode: 'burned',
      recentOutputs: [
        {
          kind: 'render',
          job_id: 'render-history',
          video_id: 'old-video',
          output_path: '/tmp/render-history.mp4',
          resolution: 720,
          render_preset: 'draft',
          subtitle_export_mode: 'sidecar',
          subtitle_path: '/tmp/render-history.ass',
          original_name: 'history-render.mp4',
          completed_at: '2026-03-28T00:01:00Z',
        },
      ],
    }));
    const container = getContainer();

    expect(container.textContent).toContain(
      'This will run on the current video: clip.mp4. Selected output was created from: history-render.mp4.'
    );

    await act(async () => {
      getButton(container, 'Rerun selected').click();
    });

    expect(startRenderSpy).toHaveBeenCalledWith(videoInfo.video_id, editPlan, 'draft', 'sidecar');
    expect(getStateSnapshot()).toMatchObject({
      renderPreset: 'draft',
      subtitleExportMode: 'sidecar',
      activeJob: {
        job_id: 'render-rerun-job',
        type: 'render',
        status: 'running',
        progress: 0,
      },
      view: 'rendering',
    });
    expect(container.textContent).toContain('Subtitle file: /tmp/render-history.ass');
  });

  it('shows inline rerun guidance when the current edit plan is missing', async () => {
    const startPreviewSpy = vi.spyOn(api, 'startPreview').mockResolvedValue({ job_id: 'preview-rerun-job' });

    await renderPreview(createState({
      recentOutputs: [
        {
          kind: 'preview',
          job_id: 'preview-history',
          output_path: '/tmp/preview-history.mp4',
          resolution: 480,
          original_name: 'history-preview.mp4',
          completed_at: '2026-03-28T00:00:00Z',
        },
      ],
    }));
    const container = getContainer();

    await act(async () => {
      getButton(container, 'Rerun selected').click();
    });

    expect(startPreviewSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Create or load an edit plan to rerun this output.');
  });

  it('does not show a cross-video warning when the selected recent output matches the current video', async () => {
    await renderPreview(createState({
      analysis,
      editPlan,
      recentOutputs: [
        {
          kind: 'preview',
          job_id: 'preview-history',
          video_id: videoInfo.video_id,
          output_path: '/tmp/preview-history.mp4',
          resolution: 480,
          original_name: 'clip.mp4',
          completed_at: '2026-03-28T00:00:00Z',
        },
      ],
    }));
    const container = getContainer();

    expect(container.textContent).not.toContain('This will run on the current video');
  });
});
