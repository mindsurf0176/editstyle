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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium text-text-primary">Edit Plan</h3>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={() => dispatch({ type: 'CLEAR_EDIT_PLAN' })}
          disabled={busy}
          className="h-6 px-2 text-xs text-text-secondary hover:text-accent hover:bg-accent/10"
        >
          Clear
        </Button>
      </div>

      <div className="px-4 py-3 text-xs text-text-secondary border-b border-border">
        <p className="italic">"{editPlan.instruction}"</p>
        <p className="mt-1 text-text-muted">
          Estimated output: {formatTime(editPlan.estimated_duration)}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {editPlan.operations.map((op, index) => {
          const Icon = OPERATION_ICONS[op.type] ?? Scissors;
          return (
            <div
              key={index}
              className="flex items-center gap-3 px-4 py-3 border-b border-border/50 group hover:bg-bg-panel/80 transition-colors"
            >
              <div className="w-7 h-7 rounded-md bg-accent/10 flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium capitalize text-text-secondary">
                  {op.type === 'cut' ? `Cut · ${String(op.action ?? '')}` : op.type}
                </p>
                {(op.description || op.reason || operationDetail(op)) && (
                  <p className="text-[11px] text-text-muted truncate">
                    {op.description || op.reason || operationDetail(op)}
                  </p>
                )}
                {op.start_time !== undefined && op.end_time !== undefined && (
                  <p className="text-[10px] text-text-muted tabular-nums">
                    {formatTime(op.start_time)} → {formatTime(op.end_time)}
                  </p>
                )}
              </div>
              <Button
                onClick={() => dispatch({ type: 'REMOVE_OPERATION', index })}
                aria-label={`Remove operation ${index + 1}`}
                disabled={busy}
                className="p-1 rounded hover:bg-accent/10 transition-all"
              >
                <Trash2 size={12} className="text-accent" />
              </Button>
            </div>
          );
        })}
        {editPlan.operations.length === 0 && (
          <div className="flex items-center justify-center h-20 text-xs text-text-muted">
            No operations — add instructions below
          </div>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-text-primary">Preview quality</p>
            <p className="text-[11px] text-text-muted">
              Lower resolutions generate faster.
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-border bg-bg-elevated p-1">
            {PREVIEW_RESOLUTIONS.map((resolution) => {
              const selected = previewResolution === resolution;

              return (
                <Button
                  key={resolution}
                  type="button"
                  onClick={() => dispatch({ type: 'SET_PREVIEW_RESOLUTION', resolution })}
                  disabled={busy}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-accent text-text-primary'
                      : 'text-text-muted hover:text-text-primary'
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {resolution}p
                </Button>
              );
            })}
          </div>
        </div>

        <div className="mb-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-text-primary">Render quality</p>
              <p className="text-[11px] text-text-muted">
                {selectedRenderPreset.description}
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-border bg-bg-elevated p-1">
              {RENDER_PRESET_OPTIONS.map((preset) => {
                const selected = renderPreset === preset.value;

                return (
                  <Button
                    key={preset.value}
                    type="button"
                    onClick={() => dispatch({ type: 'SET_RENDER_PRESET', renderPreset: preset.value })}
                    disabled={busy}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      selected
                        ? 'bg-accent text-text-primary'
                        : 'text-text-muted hover:text-text-primary'
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
                <p className="text-[11px] text-text-muted">
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
                    onClick={() => dispatch({
                      type: 'SET_SUBTITLE_EXPORT_MODE',
                      subtitleExportMode: option.value,
                    })}
                    disabled={busy}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-accent bg-accent/20'
                        : 'border-border bg-bg-elevated hover:border-accent'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <p className="text-xs font-medium text-text-primary">{option.label}</p>
                    <p className="mt-0.5 text-[11px] text-text-muted">
                      {option.description}
                    </p>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button
            onClick={handlePreview}
            disabled={!canPreview}
            title={!canPreview ? validationMessage ?? 'Preview is already running' : undefined}
            className="w-full min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg
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
            className="w-full min-w-0 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg
              bg-accent text-text-primary text-sm font-medium
              hover:bg-accent/90
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors"
          >
            <Download size={14} className="flex-shrink-0" />
            <span className="truncate">
              {renderBusy ? `Rendering ${selectedRenderPreset.label}` : `Render ${selectedRenderPreset.label}`}
            </span>
          </Button>
        </div>
      </div>
      {validationMessage && (
        <div className="px-4 pb-3 text-[11px] text-text-muted">
          {validationMessage}
        </div>
      )}
    </div>
  );
}
