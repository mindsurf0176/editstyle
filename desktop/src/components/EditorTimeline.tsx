import { useApp } from '../store';
import type { EditOperation } from '../types';

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

  function applyRange(event: React.MouseEvent<HTMLButtonElement>, action: 'keep' | 'remove') {
    const form = event.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    const start = String(data.get('start') ?? '').trim();
    const end = String(data.get('end') ?? '').trim();
    dispatch({ type: 'EDIT_SOURCE_RANGE', action, start: start ? Number(start) : NaN, end: end ? Number(end) : NaN });
  }

  return (
    <div className="bg-bg-panel border-t border-border px-4 py-3 flex-shrink-0">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Source Timeline</h2>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-text-muted">{formatTime(totalDuration)}</span>
          <button type="button" disabled={state.commandUndoStack.length === 0 || busy}
            onClick={() => dispatch({ type: 'UNDO_LAST_COMMAND' })}
            className="text-xs text-accent disabled:opacity-40">Undo last edit</button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex h-7 overflow-hidden rounded-md border border-border bg-bg-base">
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
                className="h-full border-r border-bg-panel bg-accent/70 transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-accent"
                style={{ width: `${widthPercent}%` }}
                onClick={() => {
                  dispatch({ type: 'SET_CURRENT_TIME', time: scene.start_time });
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
                <span className="sr-only">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="relative h-8 rounded-md border border-border bg-bg-base">
          {operations.map((operation, index) => {
            if (!hasTimelineRange(operation)) return null;

            const leftPercent = Math.min(Math.max((operation.start_time / totalDuration) * 100, 0), 100);
            const widthPercent = Math.max(
              ((operation.end_time - operation.start_time) / totalDuration) * 100,
              1
            );
            const detail = operation.description ? `: ${operation.description}` : '';
            const label = `${operation.type}${detail}`;

            return (
              <button
                key={`${operation.type}-${index}`}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={selection.type === 'operation' && selection.operation_index === index}
                className="absolute top-1 h-6 overflow-hidden rounded bg-warning/80 px-2 text-left text-[11px] font-medium text-bg-base transition-colors hover:bg-warning focus:outline-none focus:ring-2 focus:ring-warning"
                style={{
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
        </div>
      </div>
      <form key={`${startTime}-${endTime}`} className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => event.preventDefault()}>
        <label className="text-[11px] text-text-secondary">Start (seconds)
          <input aria-label="Range start" name="start" type="number" min="0" max={totalDuration} step="0.01" defaultValue={startTime}
            className="ml-2 w-24 rounded border border-border bg-bg-base px-2 py-1 text-text-primary" />
        </label>
        <label className="text-[11px] text-text-secondary">End (seconds)
          <input aria-label="Range end" name="end" type="number" min="0" max={totalDuration} step="0.01" defaultValue={endTime}
            className="ml-2 w-24 rounded border border-border bg-bg-base px-2 py-1 text-text-primary" />
        </label>
        <button type="button" disabled={busy} onClick={(event) => applyRange(event, 'keep')}
          className="rounded border border-border px-2 py-1 text-xs text-text-primary disabled:opacity-40">Keep range</button>
        <button type="button" disabled={busy} onClick={(event) => applyRange(event, 'remove')}
          className="rounded border border-border px-2 py-1 text-xs text-text-primary disabled:opacity-40">Remove range</button>
      </form>
      <p className="mt-2 text-[11px] text-text-muted">Times refer to the original video. Select a scene or enter a range; edits appear in the plan.</p>
      {state.lastCommandSummary ? <p role="status" className="mt-1 text-[11px] text-text-secondary">{state.lastCommandSummary.messages.join(' ')}</p> : null}
    </div>
  );
}
