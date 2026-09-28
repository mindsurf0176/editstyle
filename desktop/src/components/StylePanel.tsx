import { useEffect, useRef, useState } from 'react';
import { Palette, Check, Loader2 } from 'lucide-react';
import { useApp } from '../store';
import { getPresets, getPreset, applyStyle } from '../api';

export default function StylePanel() {
  const { state, dispatch } = useApp();
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const current = useRef(state);
  const mounted = useRef(false);
  current.current = state;
  const busy = applying !== null || state.activeJob?.status === 'pending' || state.activeJob?.status === 'running';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (state.presets.length > 0) return;
    let cancelled = false;

    getPresets()
      .then((presets) => {
        if (!cancelled) dispatch({ type: 'SET_PRESETS', presets });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load presets');
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.presets.length]);

  const handleApply = async (presetName: string) => {
    if (!state.videoId || !state.analysis || busy) return;
    const revision = state.editRevision;
    const videoId = state.videoId;
    const stillCurrent = () => mounted.current && current.current.videoId === videoId;
    setApplying(presetName);
    setApplied(null);
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      const preset = await getPreset(presetName);
      if (!stillCurrent()) return;
      const plan = await applyStyle(videoId, preset);
      if (!stillCurrent()) return;
      if (current.current.editRevision !== revision) {
        throw new Error('The edit changed while applying the style. Please review and apply again.');
      }
      if (plan.operations.some((operation) => operation.type === 'subtitle') && !state.analysis.transcript.length) {
        throw new Error('This preset needs a transcript. Enable speech transcription and import the video again.');
      }
      const selectedPreset = state.presets.find((candidate) => candidate.name === presetName) ?? null;
      dispatch({ type: 'APPLY_STYLE_PLAN', plan, preset: selectedPreset, videoId, revision });
      setApplied(presetName);
    } catch (err) {
      if (!stillCurrent()) return;
      const msg = err instanceof Error ? err.message : 'Failed to apply style';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      if (mounted.current) setApplying(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Palette size={14} />
          Style Presets
        </h3>
        <p className="mt-1 text-xs text-text-muted">
          Use a preset as planning context, or apply it immediately as a starting plan.
        </p>
      </div>

      <div className="flex-1 p-3">
        {state.planningStylePreset && (
          <div className="mb-3 rounded-md border border-border-strong bg-bg-surface px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-text-primary">
                  Planning with {state.planningStylePreset.name}
                </p>
                {state.planningStylePreset.description && (
                  <p className="mt-0.5 text-xs text-text-muted">
                    {state.planningStylePreset.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset: null })}
                className="min-h-8 shrink-0 rounded px-1 text-ui text-text-secondary hover:text-text-primary transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {loadError && (
          <div className="text-xs text-error px-3 py-2 rounded bg-error/10 mb-3">
            {loadError}
          </div>
        )}

        {state.presets.length === 0 && !loadError && (
          <div className="flex items-center justify-center h-20 text-xs text-text-muted">
            <Loader2 size={16} className="animate-spin mr-2" />
            Loading presets...
          </div>
        )}

        <div className="grid gap-2">
          {state.presets.map((preset) => {
            const isApplied = applied === preset.name;
            const isApplying = applying === preset.name;
            const isSelectedForPlanning = state.planningStylePreset?.name === preset.name;

            return (
              <div
                key={preset.name}
                className={`
                  rounded-md border px-3 py-3 text-left
                  transition-colors
                  ${isSelectedForPlanning || isApplied
                    ? 'bg-bg-surface border-border-strong'
                    : 'bg-bg-surface border-transparent hover:bg-bg-surface hover:border-border'
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`
                    mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md
                    ${isApplied || isSelectedForPlanning ? 'bg-accent' : 'bg-bg-base'}
                  `}
                  >
                    {isApplying ? (
                      <Loader2 size={14} className={`animate-spin ${isSelectedForPlanning ? 'text-on-accent' : 'text-text-primary'}`} />
                    ) : isApplied ? (
                      <Check size={14} className="text-on-accent" />
                    ) : (
                      <Palette
                        size={14}
                        className={isSelectedForPlanning ? 'text-on-accent' : 'text-text-muted'}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-ui font-medium capitalize break-words">{preset.name}</p>
                      {isSelectedForPlanning && (
                        <span className="text-xs font-medium text-text-secondary">
                          Planning
                        </span>
                      )}
                      {isApplied && !isSelectedForPlanning && (
                        <span className="text-xs font-medium text-text-secondary">
                          Applied
                        </span>
                      )}
                    </div>
                    {preset.description && (
                      <p className="mt-1 text-xs text-text-muted">
                        {preset.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset })}
                    disabled={isApplying}
                    aria-pressed={isSelectedForPlanning}
                    className={`min-h-8 rounded-md px-2 py-1.5 text-ui font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      isSelectedForPlanning
                        ? 'bg-accent text-on-accent'
                        : 'bg-bg-base text-text-primary hover:bg-bg-surface'
                    }`}
                  >
                    {isSelectedForPlanning ? 'Used for planning' : 'Use for planning'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApply(preset.name)}
                    disabled={!state.videoId || !state.analysis || busy}
                    className="min-h-8 rounded-md px-2 py-1.5 text-ui font-medium text-text-secondary bg-bg-base hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {isApplying ? 'Applying…' : 'Apply now'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
