import { useApp } from '../store';
import type { EditOperation } from '../types';
import { getKeepRanges } from '../timeline';

function formatTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function hasTimelineRange(
  operation: EditOperation
): operation is EditOperation & { start_time: number; end_time: number } {
  return typeof operation.start_time === 'number' && typeof operation.end_time === 'number'
    && Number.isFinite(operation.start_time) && Number.isFinite(operation.end_time)
    && operation.end_time > operation.start_time;
}

export default function EditorTimeline() {
  const { state, dispatch } = useApp();

  if (!state.videoId) {
    return (
      <div className="bg-bg-panel border-t border-border px-4 py-3 text-sm text-text-muted">
        Import a video to build a timeline.
      </div>
    );
  }

  const totalDuration = state.analysis?.duration || state.videoInfo?.duration || 0;

  if (totalDuration <= 0) {
    return (
      <div className="bg-bg-panel border-t border-border px-4 py-3 text-sm text-text-muted">
        Analyzing timeline…
      </div>
    );
  }

  const operations = state.editPlan?.operations ?? [];
  const selection = state.timelineSelection;
  const selectedRange = selection.type === 'range'
    ? selection
    : selection.type === 'operation' ? operations[selection.operation_index] : null;
  const startTime = selectedRange?.start_time ?? 0;
  const endTime = selectedRange?.end_time ?? totalDuration;
  const busy = state.activeJob?.status === 'running' || state.activeJob?.status === 'pending';
  const laneEnds: number[] = [];
  const rangedOperations = operations.flatMap((operation, index) => {
    if (!hasTimelineRange(operation)) return [];
    let lane = laneEnds.findIndex((end) => end <= operation.start_time);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = operation.end_time;
    return [{ operation, index, lane }];
  });
  const selectedOperation = selection.type === 'operation' ? operations[selection.operation_index] : null;
  const selectionLabel = selectedOperation
    ? `${selectedOperation.type === 'cut' ? String(selectedOperation.action ?? 'cut') : selectedOperation.type}${selectedOperation.description ? ` · ${selectedOperation.description}` : ''}`
    : selection.type === 'range' ? 'Selected source range' : 'Full source';
  let keptLabel = '';
  try {
    const kept = getKeepRanges(operations, totalDuration);
    const keptDuration = kept.reduce((total, range) => total + range.end_time - range.start_time, 0);
    keptLabel = `Kept ${formatTime(keptDuration)} of ${formatTime(totalDuration)}`;
  } catch {
    keptLabel = '';
  }

  function applyRange(event: React.MouseEvent<HTMLButtonElement>, action: 'keep' | 'remove') {
    const form = event.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    const start = String(data.get('start') ?? '').trim();
    const end = String(data.get('end') ?? '').trim();
    dispatch({ type: 'EDIT_SOURCE_RANGE', action, start: start ? Number(start) : NaN, end: end ? Number(end) : NaN });
  }

  function commitPlayhead(time: number) {
    dispatch({ type: 'COMMIT_PLAYHEAD', time });
  }

  return (
    <section aria-label="Source timeline" className="bg-bg-panel border-t border-border px-4 py-3 flex-shrink-0 min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Source Timeline</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs timecode text-text-secondary">{formatTime(totalDuration)}</span>
          <button type="button" disabled={state.commandUndoStack.length === 0 || busy}
            onClick={() => dispatch({ type: 'UNDO_LAST_COMMAND' })}
            className="min-h-8 rounded px-2 text-ui text-text-secondary hover:bg-bg-surface disabled:opacity-40">Undo last edit</button>
        </div>
      </div>

      <div className="mb-1 flex justify-between text-xs timecode text-text-muted" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <span key={fraction}>{formatTime(totalDuration * fraction)}</span>)}
      </div>
      <div className="space-y-2">
        <div className="relative flex h-9 overflow-hidden rounded border border-border-strong bg-bg-base" aria-label="Source scenes">
          {state.analysis?.scenes.map((scene) => {
            const startLabel = formatTime(scene.start_time);
            const endLabel = formatTime(scene.end_time);
            const label = `Scene ${scene.id}: ${startLabel} - ${endLabel}`;
            const widthPercent = Math.max((scene.duration / totalDuration) * 100, 0.75);

            return (
              <button
                key={scene.id}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={selection.type === 'range' && selection.start_time === scene.start_time && selection.end_time === scene.end_time}
                className="focus-inset min-w-0 h-full overflow-hidden border-r border-border-strong bg-bg-surface px-2 text-left text-xs text-text-secondary transition-colors hover:bg-bg-elevated aria-pressed:bg-accent aria-pressed:text-on-accent aria-pressed:shadow-[inset_0_0_0_2px_#eeeeee]"
                style={{ width: `${widthPercent}%` }}
                onClick={() => {
                  dispatch({ type: 'COMMIT_PLAYHEAD', time: scene.start_time });
                  dispatch({
                    type: 'SET_TIMELINE_SELECTION',
                    selection: {
                      type: 'range',
                      start_time: scene.start_time,
                      end_time: scene.end_time,
                    },
                  });
                }}
              >
                <span className="block truncate">Scene {scene.id}</span>
              </button>
            );
          })}
          {!state.analysis?.scenes.length ? <span className="self-center px-3 text-xs text-text-muted">{state.analysis ? 'No scene boundaries detected' : 'Analyzing scenes…'}</span> : null}
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent"
            style={{ left: `${Math.min(100, Math.max(0, state.currentTime / totalDuration * 100))}%` }} />
        </div>

        <div className="max-h-28 overflow-y-auto rounded border border-border bg-bg-base" aria-label="Edit operations">
        <div className="relative" style={{ height: `${Math.max(1, laneEnds.length) * 36}px` }}>
          {rangedOperations.map(({ operation, index, lane }) => {

            const leftPercent = Math.min(Math.max((operation.start_time / totalDuration) * 100, 0), 100);
            const widthPercent = Math.max(
              ((operation.end_time - operation.start_time) / totalDuration) * 100,
              1
            );
            const detail = operation.description ? `: ${operation.description}` : '';
            const action = operation.action ? ` ${String(operation.action)}` : '';
            const label = `${operation.type}${action}${detail} (${formatTime(operation.start_time)}–${formatTime(operation.end_time)})`;

            return (
              <button
                key={`${operation.type}-${index}`}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={selection.type === 'operation' && selection.operation_index === index}
                className={`focus-inset absolute h-8 overflow-hidden rounded border px-2 text-left text-xs font-medium transition-colors aria-pressed:border-accent aria-pressed:shadow-[inset_0_0_0_1px_#eeeeee] ${operation.action === 'remove' ? 'border-error/70 bg-bg-surface text-error hover:bg-bg-elevated' : operation.action === 'keep' ? 'border-success/70 bg-bg-surface text-success hover:bg-bg-elevated' : 'border-border-strong bg-bg-surface text-text-primary hover:bg-bg-elevated'}`}
                style={{
                  top: `${lane * 36 + 2}px`,
                  left: `${leftPercent}%`,
                  width: `${Math.min(widthPercent, 100 - leftPercent)}%`,
                }}
                onClick={() => {
                  dispatch({
                    type: 'SET_TIMELINE_SELECTION',
                    selection: { type: 'operation', operation_index: index },
                  });
                }}
              >
                <span className="block truncate">{operation.type === 'cut' ? String(operation.action ?? 'cut') : operation.type}</span>
              </button>
            );
          })}
          {rangedOperations.length === 0 ? <span className="absolute inset-0 flex items-center px-3 text-xs text-text-muted">Range edits appear here</span> : null}
        </div>
        </div>
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
        Playhead
        <input
          aria-label="Source playhead"
          type="range"
          min={0}
          max={totalDuration}
          step={0.01}
          value={Math.min(Math.max(state.currentTime, 0), totalDuration)}
          onChange={(event) => dispatch({ type: 'SET_CURRENT_TIME', time: Number(event.target.value) })}
          onPointerUp={(event) => commitPlayhead(Number(event.currentTarget.value))}
          onBlur={(event) => commitPlayhead(Number(event.currentTarget.value))}
          onKeyUp={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              commitPlayhead(Number(event.currentTarget.value));
            }
          }}
          className="min-w-0 flex-1 accent-white"
        />
        <span className="timecode text-text-primary">{formatTime(state.currentTime)}</span>
      </label>
      <p className="mt-2 text-xs text-text-secondary break-words"><span className="capitalize">{selectionLabel}</span> <span className="timecode">{formatTime(startTime)}–{formatTime(endTime)}</span>{keptLabel ? <span> · {keptLabel}</span> : null}</p>
      <form key={`${startTime}-${endTime}`} className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => event.preventDefault()}>
        <label className="flex items-center gap-2 text-xs text-text-secondary">Start (s)
          <input aria-label="Range start" name="start" type="number" min="0" max={totalDuration} step="0.01" defaultValue={startTime}
            className="h-8 w-20 rounded border border-border-strong bg-bg-surface px-2 text-ui timecode text-text-primary" />
        </label>
        <label className="flex items-center gap-2 text-xs text-text-secondary">End (s)
          <input aria-label="Range end" name="end" type="number" min="0" max={totalDuration} step="0.01" defaultValue={endTime}
            className="h-8 w-20 rounded border border-border-strong bg-bg-surface px-2 text-ui timecode text-text-primary" />
        </label>
        <button type="button" disabled={busy} onClick={(event) => applyRange(event, 'keep')}
          className="min-h-8 rounded border border-border-strong bg-bg-surface px-3 text-ui text-text-primary hover:bg-bg-elevated disabled:opacity-40">Keep range</button>
        <button type="button" disabled={busy} onClick={(event) => applyRange(event, 'remove')}
          className="min-h-8 rounded border border-border-strong bg-bg-surface px-3 text-ui text-text-primary hover:bg-bg-elevated disabled:opacity-40">Remove range</button>
        <button type="button" disabled={busy} onClick={() => dispatch({ type: 'MARK_PLAYHEAD_EDGE', edge: 'in' })}
          aria-label="Mark in"
          className="min-h-8 rounded border border-border-strong bg-bg-surface px-3 text-ui text-text-primary hover:bg-bg-elevated disabled:opacity-40">Mark in</button>
        <button type="button" disabled={busy} onClick={() => dispatch({ type: 'MARK_PLAYHEAD_EDGE', edge: 'out' })}
          aria-label="Mark out"
          className="min-h-8 rounded border border-border-strong bg-bg-surface px-3 text-ui text-text-primary hover:bg-bg-elevated disabled:opacity-40">Mark out</button>
      </form>
      <p className="mt-2 text-xs text-text-muted">Source times. Mark in and out from the playhead, then keep or remove that range. Playback skips removed ranges; speed and transitions stay in the rendered preview.</p>
      {state.lastCommandSummary ? <p role="status" className="mt-1 text-xs text-text-secondary">{state.lastCommandSummary.messages.join(' ')}</p> : null}
    </section>
  );
}
