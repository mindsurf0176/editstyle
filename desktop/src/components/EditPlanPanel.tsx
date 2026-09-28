import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Scissors,
  Subtitles,
  Music,
  Palette,
  ArrowRightLeft,
  Gauge,
  Trash2,
  Play,
  Download,
} from 'lucide-react';
import { useApp } from '../store';
import { startPreview, startRender } from '../api';
import {
  PREVIEW_RESOLUTIONS,
  RENDER_PRESET_OPTIONS,
  SUBTITLE_EXPORT_MODE_OPTIONS,
} from '../types';
import type { EditOperation } from '../types';

const OPERATION_ICONS: Record<string, typeof Scissors> = {
  cut: Scissors,
  subtitle: Subtitles,
  bgm: Music,
  colorgrade: Palette,
  transition: ArrowRightLeft,
  speed: Gauge,
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Surfaces the attribute that tells two operations of the same type apart.
function operationDetail(op: EditOperation): string | null {
  const value = (key: string) => (typeof op[key] === 'string' ? (op[key] as string) : null);
  switch (op.type) {
    case 'colorgrade':
      return value('preset');
    case 'bgm':
      return value('mood');
    case 'transition':
      return value('transition_type') ?? value('style');
    case 'subtitle':
      return value('style');
    case 'speed': {
      const factor = op.speed_factor ?? op.factor;
      return typeof factor === 'number' ? `${factor}x` : null;
    }
    default:
      return null;
  }
}

export default function EditPlanPanel() {
  const { state, dispatch } = useApp();
  const [starting, setStarting] = useState(false);
  const {
    editPlan,
    videoId,
    analysis,
    activeJob,
    previewResult,
    previewResolution,
    renderPreset,
    subtitleExportMode,
  } = state;

  if (!editPlan) return null;

  const previewBusy = activeJob?.type === 'preview' && activeJob.status !== 'failed' && activeJob.status !== 'completed';
  const renderBusy = activeJob?.type === 'render' && activeJob.status !== 'failed' && activeJob.status !== 'completed';
  const busy = starting || (activeJob?.status === 'running' || activeJob?.status === 'pending');
  const canPreview = Boolean(videoId && analysis && !busy);
  const canRender = Boolean(videoId && analysis && editPlan.operations.length > 0 && !busy);
  const hasSubtitleOperation = editPlan.operations.some((operation) => operation.type === 'subtitle');
  const selectedRenderPreset = RENDER_PRESET_OPTIONS.find((preset) => preset.value === renderPreset)
    ?? RENDER_PRESET_OPTIONS[1];
  const selectedSubtitleExportMode = SUBTITLE_EXPORT_MODE_OPTIONS.find(
    (option) => option.value === subtitleExportMode
  ) ?? SUBTITLE_EXPORT_MODE_OPTIONS[0];

  const validationMessage = !videoId
    ? 'Upload a video first.'
    : !analysis
      ? 'Preview and render unlock after analysis completes.'
      : editPlan.operations.length === 0
        ? 'This plan has no edit operations yet.'
        : null;

  const handleRender = async () => {
    if (!videoId || !editPlan || !analysis || busy) return;
    setStarting(true);
    try {
      const { job_id } = await startRender(videoId, editPlan, renderPreset, subtitleExportMode);
      dispatch({ type: 'SET_RENDER_RESULT', render: null });
      dispatch({
        type: 'SET_ACTIVE_JOB',
        revision: state.editRevision,
        job: { job_id, type: 'render', status: 'running', progress: 0 },
      });
      dispatch({ type: 'SET_VIEW', view: 'rendering' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start render';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setStarting(false);
    }
  };

  const handlePreview = async () => {
    if (!videoId || !editPlan || !analysis || busy) return;
    setStarting(true);
    try {
      const { job_id } = await startPreview(videoId, editPlan, previewResolution);
      dispatch({ type: 'SET_PREVIEW_RESULT', preview: null });
      dispatch({
        type: 'SET_ACTIVE_JOB',
        revision: state.editRevision,
        job: { job_id, type: 'preview', status: 'running', progress: 0 },
      });
      dispatch({ type: 'SET_VIEW', view: 'editor' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start preview';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-text-primary">Edit Plan</h3>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => dispatch({ type: 'CLEAR_EDIT_PLAN' })}
          disabled={busy}
          className="h-8 px-2 text-ui text-text-secondary hover:text-text-primary hover:bg-bg-surface"
        >
          Clear
        </Button>
      </div>

      <div className="px-4 py-3 text-ui text-text-secondary border-b border-border">
        <p className="break-words">{editPlan.instruction}</p>
        <p className="mt-1 text-text-muted">
          Estimated output: {formatTime(editPlan.estimated_duration)}
        </p>
      </div>

      <div className="shrink-0">
        {editPlan.operations.map((op, index) => {
          const Icon = OPERATION_ICONS[op.type] ?? Scissors;
          const selected = state.timelineSelection.type === 'operation' && state.timelineSelection.operation_index === index;
          return (
            <div
              key={index}
              className={`flex items-center gap-2 border-b border-border px-3 py-2 ${selected ? 'bg-bg-surface border-l-2 border-l-accent' : ''}`}
            >
              <button type="button" aria-pressed={selected}
                aria-label={`Select operation ${index + 1}`}
                onClick={() => dispatch({ type: 'SET_TIMELINE_SELECTION', selection: { type: 'operation', operation_index: index } })}
                className="flex min-h-9 min-w-0 flex-1 items-start gap-2 rounded py-1 text-left">
                <Icon size={15} className="mt-0.5 shrink-0 text-text-secondary" />
                <span className="min-w-0">
                <span className="block text-ui font-medium capitalize text-text-primary">
                  {op.type === 'cut' ? `Cut · ${String(op.action ?? '')}` : op.type}
                </span>
                {(op.description || op.reason || operationDetail(op)) && (
                  <span className="block text-xs text-text-muted break-words">
                    {op.description || op.reason || operationDetail(op)}
                  </span>
                )}
                {op.start_time !== undefined && op.end_time !== undefined && (
                  <span className="block text-xs timecode text-text-secondary">
                    {formatTime(op.start_time)} → {formatTime(op.end_time)}
                  </span>
                )}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => dispatch({ type: 'REMOVE_OPERATION', index })}
                aria-label={`Remove operation ${index + 1}`}
                disabled={busy}
                className="h-8 w-8 shrink-0 rounded text-text-secondary hover:bg-bg-elevated hover:text-error transition-colors"
              >
                <Trash2 size={15} />
              </Button>
            </div>
          );
        })}
        {editPlan.operations.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs text-text-muted">
            Select a source range or add an instruction.
          </div>
        )}
      </div>

      <div className="mt-auto border-t border-border px-4 py-3">
        <h3 className="mb-3 text-sm font-medium text-text-primary">Preview & render</h3>
        <div className="mb-4 flex flex-col gap-2">
          <div>
            <p className="text-ui font-medium text-text-primary">Preview quality</p>
            <p className="text-xs text-text-muted">
              Lower resolutions generate faster.
            </p>
          </div>
          <div className="flex rounded-md border border-border bg-bg-base p-1" role="group" aria-label="Preview quality">
            {PREVIEW_RESOLUTIONS.map((resolution) => {
              const selected = previewResolution === resolution;

              return (
                <Button
                  key={resolution}
                  type="button"
                  variant="secondary"
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: 'SET_PREVIEW_RESOLUTION', resolution })}
                  disabled={busy}
                  className={`h-8 flex-1 rounded px-2 text-ui font-medium transition-colors ${
                    selected
                      ? 'bg-accent text-on-accent hover:bg-accent-hover'
                      : 'bg-transparent text-text-secondary hover:bg-bg-surface hover:text-text-primary'
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {resolution}p
                </Button>
              );
            })}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-2 flex flex-col gap-2">
            <div>
              <p className="text-ui font-medium text-text-primary">Render quality</p>
              <p className="text-xs text-text-muted">
                {selectedRenderPreset.description}
              </p>
            </div>
            <div className="flex rounded-md border border-border bg-bg-base p-1" role="group" aria-label="Render quality">
              {RENDER_PRESET_OPTIONS.map((preset) => {
                const selected = renderPreset === preset.value;

                return (
                  <Button
                    key={preset.value}
                    type="button"
                    variant="secondary"
                    aria-pressed={selected}
                    onClick={() => dispatch({ type: 'SET_RENDER_PRESET', renderPreset: preset.value })}
                    disabled={busy}
                    className={`h-8 flex-1 rounded px-2 text-ui font-medium transition-colors ${
                      selected
                        ? 'bg-accent text-on-accent hover:bg-accent-hover'
                        : 'bg-transparent text-text-secondary hover:bg-bg-surface hover:text-text-primary'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {preset.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>

        {hasSubtitleOperation && (
          <div className="mb-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-text-primary">Subtitle export</p>
                <p className="text-xs text-text-muted">
                  {selectedSubtitleExportMode.description}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {SUBTITLE_EXPORT_MODE_OPTIONS.map((option) => {
                const selected = subtitleExportMode === option.value;

                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant="secondary"
                    aria-pressed={selected}
                    onClick={() => dispatch({
                      type: 'SET_SUBTITLE_EXPORT_MODE',
                      subtitleExportMode: option.value,
                    })}
                    disabled={busy}
                    className={`h-auto min-h-9 flex-col items-start gap-0 whitespace-normal rounded-md border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-border-strong bg-bg-elevated'
                        : 'border-border bg-bg-surface hover:border-border-strong'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <span className="text-ui font-medium text-text-primary">{option.label}</span>
                    <span className="mt-0.5 text-xs text-text-muted">
                      {option.description}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            onClick={handlePreview}
            disabled={!canPreview}
            title={!canPreview ? validationMessage ?? 'Preview is already running' : undefined}
            className="w-full min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-md
              bg-bg-elevated text-text-primary text-sm font-medium
              hover:bg-bg-panel
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors"
          >
            <Play size={14} className="flex-shrink-0" />
            <span className="truncate">
              {previewBusy
                ? `Previewing ${previewResolution}p`
                : previewResult
                  ? `Refresh ${previewResolution}p`
                  : `Preview ${previewResolution}p`}
            </span>
          </Button>
          <Button
            onClick={handleRender}
            disabled={!canRender}
            title={!canRender ? validationMessage ?? 'Render is already running' : undefined}
            className="w-full min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-md
              bg-accent text-on-accent text-ui font-medium
              hover:bg-accent-hover
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors"
          >
            <Download size={14} className="flex-shrink-0" />
            <span className="truncate">
              {renderBusy ? `Rendering ${selectedRenderPreset.label}` : `Render ${selectedRenderPreset.label}`}
            </span>
          </Button>
        </div>
        <p className="mt-3 text-xs text-text-muted">Your plan saves automatically. Render the video, then export a file from the viewer.</p>
      </div>
      {validationMessage && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          {validationMessage}
        </div>
      )}
    </div>
  );
}
