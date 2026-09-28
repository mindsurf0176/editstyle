import { useEffect, useState } from 'react';
import { Loader2, CheckCircle, XCircle, X, Download, ExternalLink } from 'lucide-react';
import * as Progress from '@radix-ui/react-progress';
import { useApp } from '../store';
import {
  ApiError,
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

function interruptedJob(job: Job): Job {
  return { ...job, status: 'failed', result: undefined,
    error: 'This job is no longer available. The backend may have restarted. Your edits are preserved; start this job again when ready.' };
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
  const [exportFeedback, setExportFeedback] = useState<{
    jobId: string;
    savedPath: string;
    assetLabel: string;
  } | null>(null);

  useEffect(() => {
    if (!activeJob || activeJob.status === 'completed' || activeJob.status === 'failed') {
      return;
    }

    let subscribed = true;
    let terminal = false;
    let polling = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    const syncJob = async () => {
      if (!subscribed || terminal || polling) return;
      polling = true;
      try {
        const job = await pollJob(activeJob.job_id);
        if (!subscribed || terminal || job.job_id !== activeJob.job_id) return;
        terminal = job.status === 'completed' || job.status === 'failed';
        dispatch({ type: 'SYNC_ACTIVE_JOB', job });
      } catch (error) {
        if (subscribed && !terminal && error instanceof ApiError && error.status === 404) {
          terminal = true;
          dispatch({ type: 'SYNC_ACTIVE_JOB', job: interruptedJob(activeJob) });
        }
        // Network failures and non-404 responses do not prove the job is gone.
      } finally {
        polling = false;
        if (terminal) clearInterval(interval);
      }
    };

    const ws = connectProgressWs(
      activeJob.job_id,
      (data) => {
        if (!subscribed || terminal) return;
        if (!data || typeof data !== 'object' || 'error' in data
          || !['pending', 'running', 'completed', 'failed'].includes(data.status)
          || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 100) {
          void syncJob();
          return;
        }
        dispatch({
          type: 'UPDATE_JOB_PROGRESS',
          jobId: activeJob.job_id,
          progress: data.progress,
          status: data.status as Job['status'],
        });

        if (data.status === 'completed' || data.status === 'failed') {
          void syncJob();
        }
      },
      () => {
        if (!subscribed || terminal || interval !== undefined) return;
        interval = setInterval(() => { void syncJob(); }, 2000);
        void syncJob();
      }
    );

    return () => {
      subscribed = false;
      clearInterval(interval);
      ws.close();
    };
  }, [activeJob?.job_id, activeJob?.status, dispatch]);

  useEffect(() => {
    if (activeJob?.status !== 'completed') return;

    let isSubscribed = true;

    const handleCompletion = async () => {
      try {
        let completedJob = activeJob;
        if (!activeJob.result) {
          try {
            completedJob = await pollJob(activeJob.job_id);
          } catch (error) {
            if (isSubscribed && error instanceof ApiError && error.status === 404) {
              dispatch({ type: 'SYNC_ACTIVE_JOB', job: interruptedJob(activeJob) });
              return;
            }
            throw error;
          }
        }
        if (!isSubscribed) return;
        if (completedJob.job_id !== activeJob.job_id) return;

        if (
          !activeJob.result
          || activeJob.status !== completedJob.status
          || activeJob.progress !== completedJob.progress
          || activeJob.error !== completedJob.error
        ) {
          dispatch({ type: 'SYNC_ACTIVE_JOB', job: completedJob });
        }
        if (completedJob.status !== 'completed') return;

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
    failed: 'Job failed',
  }[activeJob.status];

  const StatusIcon = {
    pending: Loader2,
    running: Loader2,
    completed: CheckCircle,
    failed: XCircle,
  }[activeJob.status];

  const statusColor = {
    pending: 'text-text-secondary',
    running: 'text-text-primary',
    completed: 'text-success',
    failed: 'text-error',
  }[activeJob.status];

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-5rem)] overflow-y-auto bg-bg-panel border border-border-strong rounded-md animate-in slide-in-from-bottom-4">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon
            size={16}
            className={`${statusColor} ${activeJob.status === 'running' || activeJob.status === 'pending' ? 'animate-spin' : ''}`}
          />
          <span className="text-sm font-medium truncate">{statusText}</span>
        </div>
        <button
          aria-label="Dismiss job status"
          onClick={() => dispatch({ type: 'CLEAR_JOB' })}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-bg-surface transition-colors"
        >
          <X size={14} className="text-text-secondary" />
        </button>
      </div>

      <div className="px-4 pb-3 space-y-3">
        {activeJob.status === 'failed' && activeJob.error ? (
          <p role="alert" className="text-xs text-text-secondary">{activeJob.error}</p>
        ) : null}
        <Progress.Root
          className="relative w-full h-1.5 overflow-hidden rounded-full bg-bg-base"
          value={activeJob.progress}
        >
          <Progress.Indicator
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
              activeJob.status === 'completed'
                ? 'bg-success'
                : activeJob.status === 'failed'
                  ? 'bg-error'
                  : 'bg-accent'
            }`}
            style={{ width: `${activeJob.status === 'completed' ? 100 : activeJob.progress}%` }}
          />
        </Progress.Root>

        {activeJob.type && (
          <p className="text-xs text-text-secondary capitalize">
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
              <p className="text-xs text-text-secondary">
                Output: {previewQualityDetails}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  void openPathOrUrl(
                    previewResultData?.output_path ?? '',
                    getPreviewDownloadUrl(activeJob.job_id)
                  )
                }
                className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md border border-border-strong text-ui font-medium text-text-primary hover:bg-bg-surface transition-colors"
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
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md bg-accent text-on-accent text-sm font-medium hover:bg-accent-hover transition-colors"
                >
                  <Download size={14} />
                  Save preview as
                </button>
              ) : (
                <a
                  href={getPreviewDownloadUrl(activeJob.job_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md bg-accent text-on-accent text-sm font-medium hover:bg-accent-hover transition-colors"
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
              <p className="text-xs text-text-secondary">
                Output: {renderQualityDetails}
              </p>
            )}
            {renderResultData?.subtitle_path && (
              <p
                className="truncate text-xs text-text-secondary"
                title={renderResultData.subtitle_path}
              >
                Subtitle file: {renderResultData.subtitle_path}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  void openPathOrUrl(
                    renderResultData?.output_path ?? '',
                    getDownloadUrl(activeJob.job_id)
                  )
                }
                className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md border border-border-strong text-ui font-medium text-text-primary hover:bg-bg-surface transition-colors"
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
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md bg-accent text-on-accent text-sm font-medium hover:bg-accent-hover transition-colors"
                >
                  <Download size={14} />
                  Export render
                </button>
              ) : (
                <a
                  href={getDownloadUrl(activeJob.job_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-md bg-accent text-on-accent text-sm font-medium hover:bg-accent-hover transition-colors"
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
