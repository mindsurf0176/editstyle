import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle, XCircle, X, Download, ExternalLink } from 'lucide-react';
import * as Progress from '@radix-ui/react-progress';
import { useApp } from '../store';
import {
  connectProgressWs,
  exportBundleOrUrl,
  getAnalysis,
  getDownloadUrl,
  getSuggestedExportFilename,
  getPreviewDownloadUrl,
  isNativeDesktop,
  openPathOrUrl,
  pollJob,
  revealPathOrUrl,
} from '../api';
import type {
  EditPlan,
  Job,
  MediaJobResult,
  OutputHistoryItem,
  VideoAnalysis,
} from '../types';
import ExportSuccessNotice from './ExportSuccessNotice';
import { formatRenderQualityDetails } from '../renderQuality';

function looksLikeEditPlan(result: Job['result']): result is EditPlan {
  return Boolean(
    result &&
    typeof result === 'object' &&
    'instruction' in result &&
    'operations' in result &&
    Array.isArray((result as EditPlan).operations)
  );
}

function looksLikeAnalysisResult(
  result: Job['result']
): result is { analysis: VideoAnalysis } {
  return Boolean(result && typeof result === 'object' && 'analysis' in result);
}

function looksLikeMediaResult(result: Job['result']): result is MediaJobResult {
  return Boolean(result && typeof result === 'object' && 'output_path' in result);
}

function buildRecentOutputItem(
  kind: 'preview' | 'render',
  job: Job,
  media: MediaJobResult,
  videoId: string | null,
  originalName: string | null | undefined
): OutputHistoryItem {
  return {
    kind,
    job_id: job.job_id,
    output_path: media.output_path,
    resolution: media.resolution,
    render_preset: media.render_preset,
    subtitle_export_mode: media.subtitle_export_mode,
    subtitle_path: media.subtitle_path,
    export_artifacts: media.export_artifacts,
    video_id: videoId,
    original_name: originalName ?? null,
    completed_at: new Date().toISOString(),
  };
}

export default function JobProgress() {
  const { state, dispatch } = useApp();
  const { activeJob } = state;
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [exportFeedback, setExportFeedback] = useState<{
    jobId: string;
    savedPath: string;
    assetLabel: string;
  } | null>(null);

  useEffect(() => {
    if (!activeJob || activeJob.status === 'completed' || activeJob.status === 'failed') {
      return;
    }

    const syncJob = async () => {
      try {
        const job = await pollJob(activeJob.job_id);
        dispatch({ type: 'SYNC_ACTIVE_JOB', job });
      } catch {
        // ignore sync errors
      }
    };

    const ws = connectProgressWs(
      activeJob.job_id,
      (data) => {
        dispatch({
          type: 'UPDATE_JOB_PROGRESS',
          jobId: activeJob.job_id,
          progress: data.progress,
          status: data.status as 'running' | 'completed' | 'failed',
        });

        if (data.status === 'completed' || data.status === 'failed') {
          void syncJob();
        }
      },
      () => {
        pollRef.current = setInterval(async () => {
          try {
            const job = await pollJob(activeJob.job_id);
            dispatch({ type: 'SYNC_ACTIVE_JOB', job });
            if (job.status === 'completed' || job.status === 'failed') {
              if (pollRef.current) clearInterval(pollRef.current);
            }
          } catch {
            // ignore poll errors
          }
        }, 2000);
      }
    );

    wsRef.current = ws;

    return () => {
      ws.close();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeJob?.job_id, activeJob?.status, dispatch]);

  useEffect(() => {
    if (activeJob?.status !== 'completed') return;

    let isSubscribed = true;

    const handleCompletion = async () => {
      try {
        const completedJob = activeJob.result ? activeJob : await pollJob(activeJob.job_id);
        if (!isSubscribed) return;

        if (
          !activeJob.result
          || activeJob.status !== completedJob.status
          || activeJob.progress !== completedJob.progress
          || activeJob.error !== completedJob.error
        ) {
          dispatch({ type: 'SYNC_ACTIVE_JOB', job: completedJob });
        }

        if (completedJob.type === 'analysis' && state.videoId) {
          const analysisData = looksLikeAnalysisResult(completedJob.result)
            ? completedJob.result.analysis
            : await getAnalysis(state.videoId);
          if (!isSubscribed) return;
          dispatch({ type: 'SET_ANALYSIS', analysis: analysisData });
        }

        if (completedJob.type === 'highlights' && looksLikeEditPlan(completedJob.result)) {
          dispatch({ type: 'SET_EDIT_PLAN', plan: completedJob.result });
          dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'edit' });
          dispatch({ type: 'SET_VIEW', view: 'editor' });
        }

        if (completedJob.type === 'render') {
          if (looksLikeMediaResult(completedJob.result)) {
            dispatch({
              type: 'ADD_RECENT_OUTPUT',
              item: buildRecentOutputItem(
                'render',
                completedJob,
                completedJob.result,
                state.videoId,
                state.videoInfo?.original_name
              ),
            });
            dispatch({
              type: 'SET_RENDER_RESULT',
              render: { job_id: completedJob.job_id, ...completedJob.result },
            });
          }
          dispatch({ type: 'SET_VIEW', view: 'editor' });
        }

        if (completedJob.type === 'preview' && looksLikeMediaResult(completedJob.result)) {
          dispatch({
            type: 'ADD_RECENT_OUTPUT',
            item: buildRecentOutputItem(
              'preview',
              completedJob,
              completedJob.result,
              state.videoId,
              state.videoInfo?.original_name
            ),
          });
          dispatch({
            type: 'SET_PREVIEW_RESULT',
            preview: { job_id: completedJob.job_id, ...completedJob.result },
          });
          dispatch({ type: 'SET_VIEW', view: 'editor' });
        }

      } catch (e) {
        console.error('Failed to finalize job:', e);
      }
    };

    void handleCompletion();

    return () => {
      isSubscribed = false;
    };
  }, [activeJob, state.videoId, dispatch]);

  // Keyed on job identity, not on the job object: status syncs recreate the
  // object and would otherwise cancel the dismissal timer before it fires.
  useEffect(() => {
    if (activeJob?.status !== 'completed' || activeJob.type !== 'analysis') return;

    const timer = setTimeout(() => dispatch({ type: 'CLEAR_JOB' }), 3000);
    return () => clearTimeout(timer);
  }, [activeJob?.job_id, activeJob?.status, activeJob?.type, dispatch]);

  useEffect(() => {
    if (!activeJob || exportFeedback?.jobId === activeJob.job_id) {
      return;
    }

    setExportFeedback(null);
  }, [activeJob?.job_id, exportFeedback?.jobId]);

  if (!activeJob) return null;

  const previewResultData = looksLikeMediaResult(activeJob.result) ? activeJob.result : null;
  const renderResultData = looksLikeMediaResult(activeJob.result) ? activeJob.result : null;
  const hasRenderResult = activeJob.type === 'render'
    && activeJob.status === 'completed'
    && Boolean(renderResultData);
  const renderQualityDetails = formatRenderQualityDetails(renderResultData);
  const hasPreviewResult = activeJob.type === 'preview'
    && activeJob.status === 'completed'
    && Boolean(previewResultData);
  const previewQualityDetails = formatRenderQualityDetails(previewResultData);
  const nativeDesktop = isNativeDesktop();
  const defaultPreviewFileName = state.videoInfo
    ? getSuggestedExportFilename(
        state.videoInfo.original_name,
        'preview',
        previewResultData?.output_path ?? '',
        previewResultData?.resolution
      )
    : null;
  const defaultRenderFileName = state.videoInfo
    ? getSuggestedExportFilename(
        state.videoInfo.original_name,
        'render',
        renderResultData?.output_path ?? '',
        renderResultData?.resolution
      )
    : null;

  async function handleExport(kind: 'preview' | 'render', media: MediaJobResult, fallbackUrl: string) {
    if (!activeJob) {
      return;
    }

    const defaultFileName = kind === 'preview'
      ? defaultPreviewFileName ?? 'cutai-video-preview.mp4'
      : defaultRenderFileName ?? 'cutai-video-render.mp4';
    const exportResult = await exportBundleOrUrl(media, defaultFileName, fallbackUrl);

    if (nativeDesktop && exportResult && typeof exportResult === 'object' && exportResult.savedPrimaryPath) {
      setExportFeedback({
        jobId: activeJob.job_id,
        savedPath: exportResult.savedPrimaryPath,
        assetLabel: kind === 'render' ? 'Render' : 'Preview',
      });
    }
  }

  const statusText = {
    pending: activeJob.type === 'preview' ? 'Preparing preview...' : 'Preparing...',
    running:
      activeJob.progress > 0
        ? `${activeJob.type === 'preview' ? 'Generating preview' : 'Processing'}... ${activeJob.progress}%`
        : activeJob.type === 'preview'
          ? 'Generating preview...'
          : 'Processing...',
    completed: hasRenderResult ? 'Render complete' : hasPreviewResult ? 'Preview ready' : 'Done',
    failed: activeJob.error ?? 'Failed',
  }[activeJob.status];

  const StatusIcon = {
    pending: Loader2,
    running: Loader2,
    completed: CheckCircle,
    failed: XCircle,
  }[activeJob.status];

  const statusColor = {
    pending: 'text-[#a1a1aa]',
    running: 'text-[#ffffff]',
    completed: 'text-[var(--success)]',
    failed: 'text-[var(--error)]',
  }[activeJob.status];

  return (
    <div className="fixed bottom-20 right-6 z-50 w-80 bg-[#09090b] border border-[#27272a] rounded-md shadow-sm overflow-hidden animate-in slide-in-from-bottom-4">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon
            size={16}
            className={`${statusColor} ${activeJob.status === 'running' || activeJob.status === 'pending' ? 'animate-spin' : ''}`}
          />
          <span className="text-sm font-medium truncate">{statusText}</span>
        </div>
        <button
          onClick={() => dispatch({ type: 'CLEAR_JOB' })}
          className="p-1 rounded hover:bg-[#18181b] transition-colors"
        >
          <X size={14} className="text-[#a1a1aa]" />
        </button>
      </div>

      <div className="px-4 pb-3 space-y-3">
        <Progress.Root
          className="relative w-full h-1.5 overflow-hidden rounded-full bg-[#000000]"
          value={activeJob.progress}
        >
          <Progress.Indicator
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
              activeJob.status === 'completed'
                ? 'bg-[var(--success)]'
                : activeJob.status === 'failed'
                  ? 'bg-[var(--error)]'
                  : 'bg-[#ffffff]'
            }`}
            style={{ width: `${activeJob.status === 'completed' ? 100 : activeJob.progress}%` }}
          />
        </Progress.Root>

        {activeJob.type && (
          <p className="text-[11px] text-[#a1a1aa] capitalize">
            {activeJob.type.replace('_', ' ')} job
          </p>
        )}

        {nativeDesktop && exportFeedback?.jobId === activeJob.job_id && (
          <ExportSuccessNotice
            savedPath={exportFeedback.savedPath}
            assetLabel={exportFeedback.assetLabel}
            details={activeJob.type === 'render' ? renderQualityDetails : null}
            onOpen={() => void openPathOrUrl(exportFeedback.savedPath)}
            onReveal={() => void revealPathOrUrl(exportFeedback.savedPath)}
            onDismiss={() => setExportFeedback(null)}
          />
        )}

        {hasPreviewResult && (
          <div className="space-y-2">
            {previewQualityDetails && (
              <p className="text-xs text-[#a1a1aa]">
                Output: {previewQualityDetails}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() =>
                  void openPathOrUrl(
                    previewResultData?.output_path ?? '',
                    getPreviewDownloadUrl(activeJob.job_id)
                  )
                }
                className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg border border-[#27272a] text-sm font-medium text-[#fafafa] hover:bg-[#18181b] transition-colors"
              >
                <ExternalLink size={14} />
                {nativeDesktop ? 'Open preview' : 'Open file'}
              </button>
              {nativeDesktop ? (
                <button
                  onClick={() =>
                    void handleExport(
                      'preview',
                      previewResultData!,
                      getPreviewDownloadUrl(activeJob.job_id)
                    )
                  }
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-[#ffffff] text-[#111315] text-sm font-medium hover:bg-[#e4e4e7] transition-colors"
                >
                  <Download size={14} />
                  Save preview as
                </button>
              ) : (
                <a
                  href={getPreviewDownloadUrl(activeJob.job_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-[#ffffff] text-[#111315] text-sm font-medium hover:bg-[#e4e4e7] transition-colors"
                >
                  <Download size={14} />
                  Download preview
                </a>
              )}
            </div>
          </div>
        )}

        {hasRenderResult && (
          <div className="space-y-2">
            {renderQualityDetails && (
              <p className="text-xs text-[#a1a1aa]">
                Output: {renderQualityDetails}
              </p>
            )}
            {renderResultData?.subtitle_path && (
              <p
                className="truncate text-xs text-[#a1a1aa]"
                title={renderResultData.subtitle_path}
              >
                Subtitle file: {renderResultData.subtitle_path}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() =>
                  void openPathOrUrl(
                    renderResultData?.output_path ?? '',
                    getDownloadUrl(activeJob.job_id)
                  )
                }
                className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg border border-[#27272a] text-sm font-medium text-[#fafafa] hover:bg-[#18181b] transition-colors"
              >
                <ExternalLink size={14} />
                {nativeDesktop ? 'Open render' : 'Open file'}
              </button>
              {nativeDesktop ? (
                <button
                  onClick={() =>
                    void handleExport(
                      'render',
                      renderResultData!,
                      getDownloadUrl(activeJob.job_id)
                    )
                  }
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-[#ffffff] text-[#111315] text-sm font-medium hover:bg-[#e4e4e7] transition-colors"
                >
                  <Download size={14} />
                  Export render
                </button>
              ) : (
                <a
                  href={getDownloadUrl(activeJob.job_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-[#ffffff] text-[#111315] text-sm font-medium hover:bg-[#e4e4e7] transition-colors"
                >
                  <Download size={14} />
                  Download render
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
