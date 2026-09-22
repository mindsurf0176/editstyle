import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type { EditPlan } from './types';
import {
  createPlan,
  exportBundleOrUrl,
  exportPathOrUrl,
  getExportArtifacts,
  getRenderVideoUrl,
  getSuggestedExportFilename,
  isNativeDesktop,
  openNativePath,
  openPathOrUrl,
  revealNativePath,
  revealPathOrUrl,
  startRender,
  startPreview,
} from './api';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

const plan: EditPlan = {
  instruction: 'Create preview',
  operations: [],
  estimated_duration: 10,
  summary: 'Preview summary',
};

describe('api', () => {
  beforeEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('detects the native desktop runtime from Tauri internals', () => {
    expect(isNativeDesktop()).toBe(false);

    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    expect(isNativeDesktop()).toBe(true);
  });

  it('sends the selected resolution in the POST body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ job_id: 'job-720' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await startPreview('video-1', plan, 720);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/preview',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: 'video-1', plan, resolution: 720 }),
      })
    );
  });

  it('sends the selected planning style preset in the plan request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(plan),
    });
    vi.stubGlobal('fetch', fetchMock);

    await createPlan('video-plan', 'make it snappier', { stylePreset: 'cinematic.yaml' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/plan',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: 'video-plan',
          instruction: 'make it snappier',
          use_llm: false,
          style_preset: 'cinematic.yaml',
        }),
      })
    );
  });

  it('defaults preview resolution to 360 when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ job_id: 'job-default' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await startPreview('video-2', plan);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/preview',
      expect.objectContaining({
        body: JSON.stringify({ video_id: 'video-2', plan, resolution: 360 }),
      })
    );
  });

  it('sends the selected render preset in the POST body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ job_id: 'render-job-high' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await startRender('video-3', plan, 'high');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/render',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: 'video-3',
          plan,
          render_preset: 'high',
          subtitle_export_mode: 'burned',
        }),
      })
    );
  });

  it('sends the selected subtitle export mode in the POST body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ job_id: 'render-job-sidecar' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const subtitlePlan: EditPlan = { ...plan, operations: [{ type: 'subtitle' }] };
    await startRender('video-4', subtitlePlan, 'balanced', 'sidecar');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/render',
      expect.objectContaining({
        body: JSON.stringify({
          video_id: 'video-4',
          plan: subtitlePlan,
          render_preset: 'balanced',
          subtitle_export_mode: 'sidecar',
        }),
      })
    );
  });

  it('builds an in-app render playback URL', () => {
    expect(getRenderVideoUrl('render-job-1')).toBe(
      'http://127.0.0.1:18910/api/render/render-job-1/video'
    );
  });

  it('does not request a missing sidecar when the subtitle operation was removed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job_id: 'cut-only' }) });
    vi.stubGlobal('fetch', fetchMock);
    await startRender('video-no-subtitle', plan, 'balanced', 'sidecar');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subtitle_export_mode).toBe('burned');
  });

  it('builds sensible export filenames from the original video name and media kind', () => {
    expect(getSuggestedExportFilename('My Clip.mov', 'preview', '/tmp/preview.mp4', 480)).toBe(
      'My-Clip-preview-480p.mp4'
    );
    expect(getSuggestedExportFilename('My Clip.mov', 'render', '/tmp/final.mov')).toBe(
      'My-Clip-render.mov'
    );
    expect(getSuggestedExportFilename('  ', 'preview', '/tmp/final')).toBe(
      'cutai-video-preview.mp4'
    );
  });

  it('opens a local path with the OS default app in desktop mode', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await openPathOrUrl('/tmp/output.mp4');

    expect(openPath).toHaveBeenCalledWith('/tmp/output.mp4');
  });

  it('opens an HTTP target with the opener URL API in desktop mode', async () => {
    await openNativePath('http://127.0.0.1:18910/api/preview/job/video');

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:18910/api/preview/job/video');
  });

  it('reveals a local path through the Tauri command in desktop mode', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await revealPathOrUrl('/tmp/output.mp4');

    expect(invoke).toHaveBeenCalledWith('reveal_path', { path: '/tmp/output.mp4' });
  });

  it('exports a direct native reveal helper', async () => {
    await revealNativePath('/tmp/output.mp4');

    expect(invoke).toHaveBeenCalledWith('reveal_path', { path: '/tmp/output.mp4' });
  });

  it('exports a local path through the Tauri save command in desktop mode', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue('/Users/minseo/Exports/clip-render.mp4');

    await expect(exportPathOrUrl('/tmp/output.mp4', 'clip-render.mp4')).resolves.toBe(
      '/Users/minseo/Exports/clip-render.mp4'
    );

    expect(invoke).toHaveBeenCalledWith('save_exported_file', {
      request: { sourcePath: '/tmp/output.mp4', defaultFileName: 'clip-render.mp4' },
    });
  });

  it('derives export artifacts from explicit bundle metadata first', () => {
    expect(getExportArtifacts({
      output_path: '/tmp/render.mp4',
      export_artifacts: [
        { kind: 'video', path: '/tmp/render.mp4' },
        { kind: 'subtitle', path: '/tmp/render.ass' },
      ],
      subtitle_path: '/tmp/ignored.ass',
    })).toEqual([
      { kind: 'video', path: '/tmp/render.mp4' },
      { kind: 'subtitle', path: '/tmp/render.ass' },
    ]);
  });

  it('exports a media bundle through the native save bundle command in desktop mode', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue({
      savedPrimaryPath: '/Users/minseo/Exports/clip-render.mp4',
      savedCompanionPaths: ['/Users/minseo/Exports/clip-render.ass'],
    });

    await expect(exportBundleOrUrl({
      output_path: '/tmp/render.mp4',
      subtitle_export_mode: 'sidecar',
      subtitle_path: '/tmp/render.ass',
      export_artifacts: [
        { kind: 'video', path: '/tmp/render.mp4' },
        { kind: 'subtitle', path: '/tmp/render.ass' },
      ],
    }, 'clip-render.mp4')).resolves.toEqual({
      savedPrimaryPath: '/Users/minseo/Exports/clip-render.mp4',
      savedCompanionPaths: ['/Users/minseo/Exports/clip-render.ass'],
    });

    expect(invoke).toHaveBeenCalledWith('save_export_bundle', {
      request: {
        primarySourcePath: '/tmp/render.mp4',
        companionSourcePaths: ['/tmp/render.ass'],
        defaultFileName: 'clip-render.mp4',
      },
    });
  });

  it('falls back to opening the browser target when reveal is not native', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    await revealPathOrUrl('/tmp/output.mp4', 'http://127.0.0.1:18910/api/render/job/download');

    expect(windowOpen).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/render/job/download',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('falls back to opening the browser target when open is not native', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openPathOrUrl('/tmp/output.mp4', 'http://127.0.0.1:18910/api/preview/job/video');

    expect(windowOpen).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/preview/job/video',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('falls back to opening the browser target when export is not native', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    await exportPathOrUrl(
      '/tmp/output.mp4',
      'clip-render.mp4',
      'http://127.0.0.1:18910/api/render/job/download'
    );

    expect(windowOpen).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/render/job/download',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('falls back to the browser download target when exporting a bundle outside desktop mode', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);

    await exportBundleOrUrl(
      {
        output_path: '/tmp/render.mp4',
        subtitle_export_mode: 'sidecar',
        subtitle_path: '/tmp/render.ass',
      },
      'clip-render.mp4',
      'http://127.0.0.1:18910/api/render/job/download'
    );

    expect(windowOpen).toHaveBeenCalledWith(
      'http://127.0.0.1:18910/api/render/job/download',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
