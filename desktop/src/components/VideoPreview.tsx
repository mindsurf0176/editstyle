import { useEffect, useRef, useState } from 'react';
import {
  GripHorizontal,
  ExternalLink,
  Download,
  PlayCircle,
  Loader2,
  FolderOpen,
  History,
  RotateCcw,
} from 'lucide-react';
import * as Slider from '@radix-ui/react-slider';
import { useApp } from '../store';
import {
  exportBundleOrUrl,
  getDownloadUrl,
  getSuggestedExportFilename,
  getPreviewDownloadUrl,
  getPreviewVideoUrl,
  getRenderVideoUrl,
  getThumbnailUrl,
  isNativeDesktop,
  openPathOrUrl,
  revealPathOrUrl,
  startPreview,
  startRender,
} from '../api';
import SceneTimeline from './SceneTimeline';
import ExportSuccessNotice from './ExportSuccessNotice';
import {
  formatRenderQualityDetails,
  formatSubtitleExportModeLabel,
} from '../renderQuality';
import type {
  OutputHistoryItem,
  PreviewResolution,
  RenderPreset,
  SubtitleExportMode,
} from '../types';

type DisplayMode = 'source' | 'preview' | 'render';
type CompareMode = 'off' | 'source-render' | 'preview-render';
type ExportFeedback = {
  kind: Exclude<DisplayMode, 'source'>;
  savedPath: string;
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getRecentOutputKey(item: OutputHistoryItem): string {
  return `${item.kind}:${item.job_id}`;
}

function getRecentOutputLabel(item: OutputHistoryItem): string {
  const parts = [item.kind === 'render' ? 'Render' : 'Preview'];

  if (item.render_preset) {
    parts.push(item.render_preset);
  }

  if (item.resolution) {
    parts.push(`${item.resolution}p`);
  }

  return parts.join(' ');
}

function getRecentOutputTitle(item: OutputHistoryItem): string {
  const fileName = item.output_path.split(/[\\/]/).pop() ?? item.output_path;
  return item.original_name ? `${item.original_name} -> ${fileName}` : fileName;
}

function getCrossVideoRerunWarning(
  item: OutputHistoryItem | null,
  currentVideoId: string | null,
  currentVideoName?: string | null
): string | null {
  if (!item?.video_id || !currentVideoId || item.video_id === currentVideoId) {
    return null;
  }

  const currentLabel = currentVideoName?.trim() || 'the current video';
  const originalLabel = item.original_name?.trim() || 'a different video';
  return `This will run on the current video: ${currentLabel}. Selected output was created from: ${originalLabel}.`;
}

export default function VideoPreview() {
  const { state, dispatch } = useApp();
  const {
    videoId,
    videoInfo,
    analysis,
    editPlan,
    currentTime,
    previewResult,
    previewResolution,
    renderPreset,
    subtitleExportMode,
    renderResult,
    activeJob,
    recentOutputs,
  } = state;
  const [displayMode, setDisplayMode] = useState<DisplayMode>('source');
  const [compareSource, setCompareSource] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>('off');
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  const [selectedRecentOutputKey, setSelectedRecentOutputKey] = useState<string | null>(null);
  const [recentOutputMessage, setRecentOutputMessage] = useState<string | null>(null);
  const [rerunStarting, setRerunStarting] = useState<OutputHistoryItem['kind'] | null>(null);
  const displayModeSelectionRef = useRef<'auto' | 'manual'>('auto');
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const renderVideoRef = useRef<HTMLVideoElement | null>(null);
  const syncSourceRef = useRef<'preview' | 'render' | null>(null);
  const lastSyncedTimeRef = useRef<number | null>(null);
  const currentRevisionRef = useRef(state.editRevision);
  currentRevisionRef.current = state.editRevision;

  useEffect(() => {
    setDisplayMode((current) => {
      const preferredMode = renderResult ? 'render' : previewResult ? 'preview' : 'source';

      if (displayModeSelectionRef.current === 'manual') {
        if (current === 'source') {
          return current;
        }

        if (current === 'preview' && previewResult) {
          return current;
        }

        if (current === 'render' && renderResult) {
          return current;
        }

        displayModeSelectionRef.current = 'auto';
      }

      return preferredMode;
    });
  }, [previewResult?.job_id, renderResult?.job_id]);

  const thumbnailUrl = videoId ? getThumbnailUrl(videoId, currentTime) : null;
  const previewUrl = previewResult ? getPreviewVideoUrl(previewResult.job_id) : null;
  const renderUrl = renderResult ? getRenderVideoUrl(renderResult.job_id) : null;
  const previewDownloadUrl = previewResult ? getPreviewDownloadUrl(previewResult.job_id) : null;
  const renderDownloadUrl = renderResult ? getDownloadUrl(renderResult.job_id) : null;
  const previewBusy = activeJob?.type === 'preview' && activeJob.status !== 'failed' && activeJob.status !== 'completed';
  const renderBusy = activeJob?.type === 'render' && activeJob.status !== 'failed' && activeJob.status !== 'completed';
  const nativeDesktop = isNativeDesktop();
  const hasPreview = Boolean(previewResult);
  const hasRender = Boolean(renderResult);
  const effectiveMode = compareSource ? 'source' : displayMode;
  const compareOptions = [
    hasRender ? { value: 'source-render' as const, label: 'Source / Render' } : null,
    hasPreview && hasRender ? { value: 'preview-render' as const, label: 'Preview / Render' } : null,
  ].filter((option): option is { value: Exclude<CompareMode, 'off'>; label: string } => Boolean(option));
  const compareEnabled = compareMode !== 'off';
  const renderQualityDetails = formatRenderQualityDetails(renderResult);

  const currentMedia = displayMode === 'preview' ? previewResult : displayMode === 'render' ? renderResult : null;
  const currentMediaKind = displayMode === 'preview' || displayMode === 'render' ? displayMode : null;
  const currentVideoUrl = displayMode === 'preview' ? previewUrl : displayMode === 'render' ? renderUrl : null;
  const currentDownloadUrl = displayMode === 'preview' ? previewDownloadUrl : displayMode === 'render' ? renderDownloadUrl : null;
  const currentBusy = displayMode === 'preview' ? previewBusy : displayMode === 'render' ? renderBusy : false;

  useEffect(() => {
    if (compareMode === 'source-render' && !hasRender) {
      setCompareMode('off');
      return;
    }

    if (compareMode === 'preview-render' && !(hasPreview && hasRender)) {
      setCompareMode('off');
    }
  }, [compareMode, hasPreview, hasRender]);

  useEffect(() => {
    if (compareMode !== 'preview-render') {
      syncSourceRef.current = null;
      lastSyncedTimeRef.current = null;
    }
  }, [compareMode]);

  useEffect(() => {
    setExportFeedback(null);
  }, [previewResult?.job_id, renderResult?.job_id]);

  useEffect(() => {
    setRecentOutputMessage(null);
  }, [selectedRecentOutputKey, activeJob?.job_id]);

  useEffect(() => {
    if (recentOutputs.length === 0) {
      setSelectedRecentOutputKey(null);
      return;
    }

    setSelectedRecentOutputKey((current) => {
      if (current && recentOutputs.some((item) => getRecentOutputKey(item) === current)) {
        return current;
      }

      return getRecentOutputKey(recentOutputs[0]);
    });
  }, [recentOutputs]);

  useEffect(() => {
    if (compareMode !== 'preview-render') {
      return;
    }

    const previewVideo = previewVideoRef.current;
    const renderVideo = renderVideoRef.current;

    if (!previewVideo || !renderVideo) {
      return;
    }

    const targetTime = currentTime;
    const shouldSyncPreview = Math.abs(previewVideo.currentTime - targetTime) > 0.15;
    const shouldSyncRender = Math.abs(renderVideo.currentTime - targetTime) > 0.15;

    if (!shouldSyncPreview && !shouldSyncRender) {
      return;
    }

    syncSourceRef.current = 'preview';
    if (shouldSyncPreview) {
      previewVideo.currentTime = targetTime;
    }
    if (shouldSyncRender) {
      renderVideo.currentTime = targetTime;
    }
    syncSourceRef.current = null;
    lastSyncedTimeRef.current = targetTime;
  }, [compareMode, currentTime]);

  function selectDisplayMode(mode: DisplayMode) {
    displayModeSelectionRef.current = 'manual';
    setDisplayMode(mode);
    setCompareMode('off');
  }

  function mirrorComparePlayback(source: 'preview' | 'render', action: 'play' | 'pause') {
    if (compareMode !== 'preview-render' || syncSourceRef.current) {
      return;
    }

    const sourceVideo = source === 'preview' ? previewVideoRef.current : renderVideoRef.current;
    const targetVideo = source === 'preview' ? renderVideoRef.current : previewVideoRef.current;

    if (!sourceVideo || !targetVideo) {
      return;
    }

    syncSourceRef.current = source;

    if (action === 'play') {
      void targetVideo.play().catch(() => undefined).finally(() => {
        syncSourceRef.current = null;
      });
      return;
    }

    targetVideo.pause();
    syncSourceRef.current = null;
  }

  function syncCompareTime(source: 'preview' | 'render') {
    if (compareMode !== 'preview-render' || syncSourceRef.current) {
      return;
    }

    const sourceVideo = source === 'preview' ? previewVideoRef.current : renderVideoRef.current;
    const targetVideo = source === 'preview' ? renderVideoRef.current : previewVideoRef.current;

    if (!sourceVideo || !targetVideo) {
      return;
    }

    const nextTime = sourceVideo.currentTime;
    const lastSyncedTime = lastSyncedTimeRef.current;

    if (lastSyncedTime !== null && Math.abs(lastSyncedTime - nextTime) < 0.05) {
      return;
    }

    syncSourceRef.current = source;
    if (Math.abs(targetVideo.currentTime - nextTime) > 0.1) {
      targetVideo.currentTime = nextTime;
    }
    syncSourceRef.current = null;
    lastSyncedTimeRef.current = nextTime;
    dispatch({ type: 'SET_CURRENT_TIME', time: nextTime });
  }

  async function handleExport(mode: Exclude<DisplayMode, 'source'>) {
    const media = mode === 'preview' ? previewResult : renderResult;
    const downloadUrl = mode === 'preview' ? previewDownloadUrl : renderDownloadUrl;
    if (!media || !videoInfo) {
      return;
    }

    const exportResult = await exportBundleOrUrl(
      media,
      getSuggestedExportFilename(
        videoInfo.original_name,
        mode,
        media.output_path,
        media.resolution
      ),
      downloadUrl ?? undefined
    );

    if (nativeDesktop && exportResult && typeof exportResult === 'object' && exportResult.savedPrimaryPath) {
      setExportFeedback({ kind: mode, savedPath: exportResult.savedPrimaryPath });
    }
  }

  function getRecentOutputUrls(item: OutputHistoryItem) {
    if (item.kind === 'preview') {
      return {
        videoUrl: getPreviewVideoUrl(item.job_id),
        downloadUrl: getPreviewDownloadUrl(item.job_id),
      };
    }

    return {
      videoUrl: getRenderVideoUrl(item.job_id),
      downloadUrl: getDownloadUrl(item.job_id),
    };
  }

  async function handleRecentOutputExport(item: OutputHistoryItem) {
    const { downloadUrl } = getRecentOutputUrls(item);
    const exportResult = await exportBundleOrUrl(
      item,
      getSuggestedExportFilename(
        item.original_name ?? videoInfo?.original_name,
        item.kind,
        item.output_path,
        item.resolution
      ),
      downloadUrl
    );

    if (nativeDesktop && exportResult && typeof exportResult === 'object' && exportResult.savedPrimaryPath) {
      setExportFeedback({
        kind: item.kind,
        savedPath: exportResult.savedPrimaryPath,
      });
    }
  }

  function getRecentOutputRerunIssue(item: OutputHistoryItem): string | null {
    if (!videoId || !videoInfo) {
      return 'Load a video to rerun this output.';
    }

    if (!editPlan) {
      return 'Create or load an edit plan to rerun this output.';
    }

    if (!analysis) {
      return 'Wait for analysis to finish before rerunning this output.';
    }

    if (item.kind === 'preview') {
      if (typeof item.resolution !== 'number') {
        return 'This saved preview does not include a preview resolution.';
      }

      if (previewBusy || rerunStarting === 'preview') {
        return 'A preview is already running.';
      }

      return null;
    }

    if (!item.render_preset) {
      return 'This saved render does not include a render preset.';
    }

    if (editPlan.operations.length === 0) {
      return 'Add at least one edit operation before rerunning a render.';
    }

    if (renderBusy || rerunStarting === 'render') {
      return 'A render is already running.';
    }

    return null;
  }

  async function handleRecentOutputRerun(item: OutputHistoryItem) {
    if (activeJob?.status === 'pending' || activeJob?.status === 'running' || rerunStarting) return;
    const revision = state.editRevision;
    const issue = getRecentOutputRerunIssue(item);
    if (issue) {
      setRecentOutputMessage(issue);
      return;
    }

    if (!videoId || !editPlan) {
      return;
    }

    setRecentOutputMessage(null);
    setRerunStarting(item.kind);

    try {
      if (item.kind === 'preview') {
        const resolution = item.resolution as PreviewResolution;
        const effectiveResolution = resolution ?? previewResolution;
        dispatch({ type: 'SET_PREVIEW_RESOLUTION', resolution: effectiveResolution });

        const { job_id } = await startPreview(videoId, editPlan, effectiveResolution);
        if (currentRevisionRef.current !== revision) throw new Error('The edit changed. Start a new preview.');
        dispatch({ type: 'SET_PREVIEW_RESULT', preview: null });
        dispatch({
          type: 'SET_ACTIVE_JOB',
          revision,
          job: { job_id, type: 'preview', status: 'running', progress: 0 },
        });
        dispatch({ type: 'SET_VIEW', view: 'editor' });
        return;
      }

      const preset = item.render_preset as RenderPreset;
      const effectivePreset = preset ?? renderPreset;
      const effectiveSubtitleExportMode = (
        item.subtitle_export_mode as SubtitleExportMode | undefined
      ) ?? subtitleExportMode;
      dispatch({ type: 'SET_RENDER_PRESET', renderPreset: effectivePreset });
      dispatch({
        type: 'SET_SUBTITLE_EXPORT_MODE',
        subtitleExportMode: effectiveSubtitleExportMode,
      });

      const { job_id } = await startRender(
        videoId,
        editPlan,
        effectivePreset,
        effectiveSubtitleExportMode
      );
      if (currentRevisionRef.current !== revision) throw new Error('The edit changed. Start a new render.');
      dispatch({ type: 'SET_RENDER_RESULT', render: null });
      dispatch({
        type: 'SET_ACTIVE_JOB',
        revision,
        job: { job_id, type: 'render', status: 'running', progress: 0 },
      });
      dispatch({ type: 'SET_VIEW', view: 'rendering' });
    } catch (error) {
      setRecentOutputMessage(
        error instanceof Error
          ? error.message
          : item.kind === 'render'
            ? 'Failed to start render'
            : 'Failed to start preview'
      );
    } finally {
      setRerunStarting(null);
    }
  }

  function handleRecentOutputSelection(item: OutputHistoryItem) {
    const itemKey = getRecentOutputKey(item);

    displayModeSelectionRef.current = 'manual';
    setSelectedRecentOutputKey(itemKey);
    setCompareMode('off');
    setDisplayMode(item.kind);

    if (item.kind === 'preview') {
      dispatch({
        type: 'SET_PREVIEW_RESULT',
        preview: {
          job_id: item.job_id,
          output_path: item.output_path,
          resolution: item.resolution,
          render_preset: item.render_preset,
          subtitle_export_mode: item.subtitle_export_mode,
          subtitle_path: item.subtitle_path,
          export_artifacts: item.export_artifacts,
        },
      });
      return;
    }

    dispatch({
      type: 'SET_RENDER_RESULT',
      render: {
        job_id: item.job_id,
        output_path: item.output_path,
        resolution: item.resolution,
        render_preset: item.render_preset,
        subtitle_export_mode: item.subtitle_export_mode,
        subtitle_path: item.subtitle_path,
        export_artifacts: item.export_artifacts,
      },
    });
  }

  function renderMediaPane(mode: DisplayMode) {
    if (mode === 'preview' && previewUrl) {
      return (
        <video
          key={previewResult?.job_id}
          ref={compareMode === 'preview-render' ? previewVideoRef : null}
          src={previewUrl}
          controls
          preload="metadata"
          className="h-full w-full"
          onPlay={() => mirrorComparePlayback('preview', 'play')}
          onPause={() => mirrorComparePlayback('preview', 'pause')}
          onTimeUpdate={() => syncCompareTime('preview')}
          onSeeked={() => syncCompareTime('preview')}
        />
      );
    }

    if (mode === 'render' && renderUrl) {
      return (
        <video
          key={renderResult?.job_id}
          ref={compareMode === 'preview-render' ? renderVideoRef : null}
          src={renderUrl}
          controls
          preload="metadata"
          className="h-full w-full"
          onPlay={() => mirrorComparePlayback('render', 'play')}
          onPause={() => mirrorComparePlayback('render', 'pause')}
          onTimeUpdate={() => syncCompareTime('render')}
          onSeeked={() => syncCompareTime('render')}
        />
      );
    }

    if (thumbnailUrl) {
      return (
        <img
          src={thumbnailUrl}
          alt="Video frame"
          className="max-w-full max-h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      );
    }

    return <div className="text-[#a1a1aa] text-sm">Loading preview...</div>;
  }

  function renderMediaActions(mode: Exclude<DisplayMode, 'source'>) {
    const media = mode === 'preview' ? previewResult : renderResult;
    const videoUrl = mode === 'preview' ? previewUrl : renderUrl;
    const downloadUrl = mode === 'preview' ? previewDownloadUrl : renderDownloadUrl;
    if (!media || !videoUrl || !videoInfo) {
      return null;
    }

    return (
      <>
        <button
          onClick={() => void openPathOrUrl(media.output_path, videoUrl)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs text-[#fafafa] hover:bg-[#18181b] transition-colors"
        >
          <ExternalLink size={13} />
          {nativeDesktop ? `Open ${mode}` : `Open ${mode}`}
        </button>
        {nativeDesktop ? (
          <button
            onClick={() => void handleExport(mode)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] hover:bg-[#e4e4e7] transition-colors"
          >
            <Download size={13} />
            {mode === 'render' ? 'Export render' : 'Save preview as'}
          </button>
        ) : (
          <a
            href={downloadUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] hover:bg-[#e4e4e7] transition-colors"
          >
            <Download size={13} />
            {`Download ${mode}`}
          </a>
        )}
      </>
    );
  }

  const comparePanes = compareMode === 'source-render'
    ? [
        { mode: 'source' as const, label: 'Source' },
        { mode: 'render' as const, label: 'Render' },
      ]
    : compareMode === 'preview-render'
      ? [
          { mode: 'preview' as const, label: 'Preview' },
          { mode: 'render' as const, label: 'Render' },
        ]
      : [];
  const selectedRecentOutput = recentOutputs.find(
    (item) => getRecentOutputKey(item) === selectedRecentOutputKey
  ) ?? recentOutputs[0] ?? null;
  const selectedRecentOutputDetails = formatRenderQualityDetails(selectedRecentOutput);
  const selectedRecentOutputIssue = selectedRecentOutput
    ? getRecentOutputRerunIssue(selectedRecentOutput)
    : null;
  const selectedRecentOutputWarning = getCrossVideoRerunWarning(
    selectedRecentOutput,
    videoId,
    videoInfo?.original_name
  );
  const rerunLabel = selectedRecentOutput?.kind === 'render'
    ? rerunStarting === 'render'
      ? 'Rerunning render...'
      : 'Rerun selected'
    : rerunStarting === 'preview'
      ? 'Rerunning preview...'
      : 'Rerun selected';

  if (!videoId || !videoInfo) {
    return (
      <div className="flex items-center justify-center h-full text-[#a1a1aa]">
        <p>No video loaded</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {(hasPreview || hasRender) && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[#27272a] bg-[#09090b] px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {displayMode === 'render' ? 'Render ready' : displayMode === 'preview' ? 'Preview ready' : 'Source frames'}
            </p>
            {displayMode === 'preview' && previewResult ? (
              <p className="text-xs text-[#a1a1aa]">
                {previewResult.resolution ?? 360}p low-resolution playback
              </p>
            ) : displayMode === 'render' ? (
              <p className="text-xs text-[#a1a1aa]">
                {renderQualityDetails ? `Output: ${renderQualityDetails}` : 'Full render playback'}
              </p>
            ) : (
              <p className="text-xs text-[#a1a1aa]">Choose preview or render for playback</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <div className="inline-flex rounded-lg border border-[#27272a] bg-[#000000] p-1">
              <button
                type="button"
                onClick={() => selectDisplayMode('source')}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  displayMode === 'source' && !compareEnabled
                    ? 'bg-[#ffffff] text-[#111315]'
                    : 'text-[#a1a1aa] hover:text-[#fafafa]'
                }`}
              >
                Source
              </button>
              {hasPreview && (
                <button
                  type="button"
                  onClick={() => selectDisplayMode('preview')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    displayMode === 'preview' && !compareEnabled
                      ? 'bg-[#ffffff] text-[#111315]'
                      : 'text-[#a1a1aa] hover:text-[#fafafa]'
                  }`}
                >
                  Preview
                </button>
              )}
              {hasRender && (
                <button
                  type="button"
                  onClick={() => selectDisplayMode('render')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    displayMode === 'render' && !compareEnabled
                      ? 'bg-[#ffffff] text-[#111315]'
                      : 'text-[#a1a1aa] hover:text-[#fafafa]'
                  }`}
                >
                  Render
                </button>
              )}
            </div>
            {compareOptions.length > 0 && (
              <div className="inline-flex rounded-lg border border-[#27272a] bg-[#000000] p-1">
                <button
                  type="button"
                  onClick={() => setCompareMode('off')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    !compareEnabled
                      ? 'bg-[#ffffff] text-[#111315]'
                      : 'text-[#a1a1aa] hover:text-[#fafafa]'
                  }`}
                >
                  Single view
                </button>
                {compareOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setCompareMode(option.value)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      compareMode === option.value
                        ? 'bg-[#ffffff] text-[#111315]'
                        : 'text-[#a1a1aa] hover:text-[#fafafa]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            {compareEnabled ? (
              <>
                {compareMode === 'preview-render' && renderMediaActions('preview')}
                {renderMediaActions('render')}
              </>
            ) : (
              currentMedia && currentVideoUrl && currentMediaKind && (
                <>
                  <button
                    onClick={() => void openPathOrUrl(currentMedia.output_path, currentVideoUrl)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs text-[#fafafa] hover:bg-[#18181b] transition-colors"
                  >
                    <ExternalLink size={13} />
                    {nativeDesktop
                      ? displayMode === 'render'
                        ? 'Open render'
                        : 'Open preview'
                      : 'Open file'}
                  </button>
                  {nativeDesktop ? (
                    <button
                      onClick={() => void handleExport(currentMediaKind)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] hover:bg-[#e4e4e7] transition-colors"
                    >
                      <Download size={13} />
                      {displayMode === 'render' ? 'Export render' : 'Save preview as'}
                    </button>
                  ) : (
                    <a
                      href={currentDownloadUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] hover:bg-[#e4e4e7] transition-colors"
                    >
                      <Download size={13} />
                      Download
                    </a>
                  )}
                </>
              )
            )}
          </div>
        </div>
      )}

      {nativeDesktop && exportFeedback && (
        <ExportSuccessNotice
          savedPath={exportFeedback.savedPath}
          assetLabel={exportFeedback.kind === 'render' ? 'Render' : 'Preview'}
          details={exportFeedback.kind === 'render' ? renderQualityDetails : null}
          onOpen={() => void openPathOrUrl(exportFeedback.savedPath)}
          onReveal={() => void revealPathOrUrl(exportFeedback.savedPath)}
          onDismiss={() => setExportFeedback(null)}
        />
      )}

      {/* Video thumbnail area */}
      <div className="relative flex-1 min-h-0 bg-black rounded-lg overflow-hidden flex items-center justify-center">
        {compareEnabled ? (
          <div className="grid h-full w-full grid-cols-1 md:grid-cols-2">
            {comparePanes.map((pane) => (
              <div
                key={pane.mode}
                className="relative flex min-h-0 items-center justify-center border-b border-white/10 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"
              >
                {renderMediaPane(pane.mode)}
                <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white ">
                  {pane.label}
                </div>
              </div>
            ))}
          </div>
        ) : (
          renderMediaPane(effectiveMode)
        )}

        {/* Preview mode overlay */}
        <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
          <div className="inline-flex items-center gap-2 rounded-md bg-black/65 px-3 py-1.5 text-xs text-white ">
            {compareEnabled || effectiveMode === 'preview' || effectiveMode === 'render'
              ? <PlayCircle size={14} />
              : <GripHorizontal size={14} />}
            <span>
              {compareEnabled
                ? compareMode === 'preview-render'
                  ? 'Split compare: preview and render'
                  : 'Split compare: source and render'
                : compareSource
                ? 'Source compare view'
                : effectiveMode === 'render'
                  ? 'Render playback'
                  : effectiveMode === 'preview'
                    ? 'Preview playback'
                    : 'Scrub timeline to preview frames'}
            </span>
          </div>
        </div>

        {currentBusy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="inline-flex items-center gap-2 rounded-md bg-black/70 px-4 py-2 text-sm text-white">
              <Loader2 size={14} className="animate-spin" />
              {displayMode === 'render' ? 'Rendering video' : 'Generating preview'}
            </div>
          </div>
        )}

        {/* Video info badge */}
        <div className="absolute top-3 right-3 rounded-md bg-black/60 px-2 py-1 text-xs text-[#a1a1aa] ">
          {compareEnabled
            ? compareMode === 'preview-render'
              ? 'Preview / Render'
              : renderQualityDetails
                ? `Render ${renderQualityDetails}`
                : 'Source / Render'
            : effectiveMode === 'preview' && previewResult
              ? `Preview ${previewResult.resolution ?? 360}p`
              : effectiveMode === 'render' && renderQualityDetails
                ? `Render ${renderQualityDetails}`
                : `${videoInfo.width}×${videoInfo.height} · ${videoInfo.fps}fps`}
        </div>
      </div>

      {/* Scene timeline (if analysis available) */}
      {analysis && <SceneTimeline />}

      {/* Timeline controls */}
      <div className="flex items-center gap-3 px-2">
        <div
          className="w-8 h-8 rounded-md bg-[#18181b] flex items-center justify-center text-[#a1a1aa]"
          aria-label={
            displayMode === 'render'
              ? 'Render playback active'
              : displayMode === 'preview'
                ? 'Preview playback active'
                : 'Frame preview only'
          }
          title={
            displayMode === 'render'
              ? 'Render playback active'
              : displayMode === 'preview'
                ? 'Preview playback active'
                : 'Playback is not available yet'
          }
        >
          {displayMode === 'preview' || displayMode === 'render'
            ? <PlayCircle size={14} />
            : <GripHorizontal size={14} />}
        </div>

        <span className="text-xs text-[#a1a1aa] w-12 text-right tabular-nums">
          {formatTime(currentTime)}
        </span>

        <Slider.Root
          className="relative flex-1 flex items-center h-5 select-none touch-none"
          value={[currentTime]}
          max={videoInfo.duration}
          step={0.1}
          onValueChange={([val]) => dispatch({ type: 'SET_CURRENT_TIME', time: val })}
        >
          <Slider.Track className="relative h-1 flex-1 rounded-md bg-[#18181b]">
            <Slider.Range className="absolute h-full rounded-md bg-[#ffffff]" />
          </Slider.Track>
          <Slider.Thumb className="block w-3 h-3 rounded-md bg-[#ffffff] hover:bg-[#e4e4e7] focus:outline-none focus:ring-2 focus:ring-[#ffffff]/50 transition-colors cursor-pointer" />
        </Slider.Root>

        <span className="text-xs text-[#a1a1aa] w-12 tabular-nums">
          {formatTime(videoInfo.duration)}
        </span>

        {!compareEnabled && displayMode !== 'source' && (
          <button
            type="button"
            onMouseDown={() => setCompareSource(true)}
            onMouseUp={() => setCompareSource(false)}
            onMouseLeave={() => setCompareSource(false)}
            onTouchStart={() => setCompareSource(true)}
            onTouchEnd={() => setCompareSource(false)}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
              compareSource
                ? 'border-[#ffffff] text-[#ffffff]'
                : 'border-[#27272a] text-[#a1a1aa] hover:text-[#fafafa]'
            }`}
            title="Hold to compare with source frames"
          >
            Hold for source
          </button>
        )}
      </div>

      {recentOutputs.length > 0 && selectedRecentOutput && (
        <div className="rounded-lg border border-[#27272a] bg-[#09090b] px-3 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="inline-flex items-center gap-2 text-sm font-medium text-[#fafafa]">
                <History size={15} className="text-[#a1a1aa]" />
                <span>Recent outputs</span>
              </div>
              <p className="text-xs text-[#a1a1aa]">
                Select an exported preview or render to open, reveal, or save a copy.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleRecentOutputRerun(selectedRecentOutput)}
                disabled={rerunStarting !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs font-medium text-[#fafafa] transition-colors hover:bg-[#18181b] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <RotateCcw size={13} className={rerunStarting ? 'animate-spin' : undefined} />
                {rerunLabel}
              </button>
              <button
                type="button"
                onClick={() => void openPathOrUrl(
                  selectedRecentOutput.output_path,
                  getRecentOutputUrls(selectedRecentOutput).videoUrl
                )}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs font-medium text-[#fafafa] transition-colors hover:bg-[#18181b]"
              >
                <ExternalLink size={13} />
                Open selected
              </button>
              {nativeDesktop ? (
                <button
                  type="button"
                  onClick={() => void revealPathOrUrl(selectedRecentOutput.output_path)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs font-medium text-[#fafafa] transition-colors hover:bg-[#18181b]"
                >
                  <FolderOpen size={13} />
                  Reveal selected
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleRecentOutputExport(selectedRecentOutput)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] transition-colors hover:bg-[#e4e4e7]"
              >
                <Download size={13} />
                {nativeDesktop ? 'Export selected' : 'Download selected'}
              </button>
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {recentOutputs.map((item) => {
              const itemKey = getRecentOutputKey(item);
              const selected = selectedRecentOutputKey === itemKey;
              return (
                <button
                  key={itemKey}
                  type="button"
                  onClick={() => handleRecentOutputSelection(item)}
                  className={`min-w-0 shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-[#ffffff] bg-[#ffffff]/10'
                      : 'border-[#27272a] bg-[#000000] hover:border-[#ffffff]/40 hover:bg-[#18181b]'
                  }`}
                  aria-pressed={selected}
                  title={getRecentOutputTitle(item)}
                >
                  <div className="text-xs font-medium text-[#fafafa]">
                    {getRecentOutputLabel(item)}
                  </div>
                  <div className="max-w-44 truncate text-[11px] text-[#a1a1aa]">
                    {item.original_name ?? (item.output_path.split(/[\\/]/).pop() ?? item.output_path)}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-col gap-1 text-[11px] text-[#a1a1aa] sm:flex-row sm:items-center sm:justify-between">
            <p className="truncate" title={selectedRecentOutput.output_path}>
              {selectedRecentOutput.output_path}
            </p>
            <p className="shrink-0">
              {selectedRecentOutputDetails ?? getRecentOutputLabel(selectedRecentOutput)}
            </p>
          </div>

          {selectedRecentOutput.subtitle_path && (
            <div className="mt-1 flex flex-col gap-1 text-[11px] text-[#a1a1aa] sm:flex-row sm:items-center sm:justify-between">
              <p className="truncate" title={selectedRecentOutput.subtitle_path}>
                Subtitle file: {selectedRecentOutput.subtitle_path}
              </p>
              <p className="shrink-0">
                {formatSubtitleExportModeLabel(selectedRecentOutput.subtitle_export_mode)}
              </p>
            </div>
          )}

          {(selectedRecentOutputWarning || recentOutputMessage || selectedRecentOutputIssue) && (
            <div className="mt-2 flex flex-col gap-1 text-[11px]">
              {selectedRecentOutputWarning ? (
                <p className="text-[var(--warning)]">
                  {selectedRecentOutputWarning}
                </p>
              ) : null}
              {recentOutputMessage || selectedRecentOutputIssue ? (
                <p className="text-[#a1a1aa]">
                  {recentOutputMessage ?? selectedRecentOutputIssue}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
