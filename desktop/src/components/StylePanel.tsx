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
  current.current = state;
  const busy = applying !== null || state.activeJob?.status === 'pending' || state.activeJob?.status === 'running';

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
    setApplying(presetName);
    setApplied(null);
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      const preset = await getPreset(presetName);
      const plan = await applyStyle(state.videoId, preset);
      if (current.current.editRevision !== revision) {
        throw new Error('The edit changed while applying the style. Please review and apply again.');
      }
      if (plan.operations.some((operation) => operation.type === 'subtitle') && !state.analysis.transcript.length) {
        throw new Error('This preset needs a transcript. Enable speech transcription and import the video again.');
      }
      dispatch({ type: 'SET_EDIT_PLAN', plan, revision });
      const selectedPreset = state.presets.find((candidate) => candidate.name === presetName) ?? null;
      dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset: selectedPreset });
      dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'edit' });
      dispatch({ type: 'SET_VIEW', view: 'editor' });
      setApplied(presetName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to apply style';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[#27272a]">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Palette size={14} />
          Style Presets
        </h3>
        <p className="mt-1 text-[11px] text-[#a1a1aa]">
          Use a preset as planning context, or apply it immediately as a starting plan.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {state.planningStylePreset && (
          <div className="mb-3 rounded-lg border border-[#ffffff]/30 bg-[#ffffff]/10 px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-[#fafafa]">
                  Planning with {state.planningStylePreset.name}
                </p>
                {state.planningStylePreset.description && (
                  <p className="mt-0.5 text-[11px] text-[#a1a1aa]">
                    {state.planningStylePreset.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset: null })}
                className="text-[11px] text-[#a1a1aa] hover:text-[#fafafa] transition-colors"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {loadError && (
          <div className="text-xs text-[var(--error)] px-3 py-2 rounded bg-[var(--error)]/10 mb-3">
            {loadError}
          </div>
        )}

        {state.presets.length === 0 && !loadError && (
          <div className="flex items-center justify-center h-20 text-xs text-[#a1a1aa]">
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
                  rounded-lg border px-3 py-3 text-left
                  transition-all duration-200
                  ${isSelectedForPlanning || isApplied
                    ? 'bg-[#ffffff]/15 border-[#ffffff]/30'
                    : 'bg-[#18181b]/50 border-transparent hover:bg-[#18181b] hover:border-[#27272a]'
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`
                    mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md
                    ${isApplied || isSelectedForPlanning ? 'bg-[#ffffff]' : 'bg-[#000000]'}
                  `}
                  >
                    {isApplying ? (
                      <Loader2 size={14} className="animate-spin text-[#ffffff]" />
                    ) : isApplied ? (
                      <Check size={14} className="text-white" />
                    ) : (
                      <Palette
                        size={14}
                        className={isSelectedForPlanning ? 'text-white' : 'text-[#a1a1aa]'}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium capitalize">{preset.name}</p>
                      {isSelectedForPlanning && (
                        <span className="rounded-full bg-[#ffffff]/15 px-2 py-0.5 text-[10px] font-medium text-[#ffffff]">
                          Planning
                        </span>
                      )}
                      {isApplied && !isSelectedForPlanning && (
                        <span className="rounded-full bg-[#ffffff]/15 px-2 py-0.5 text-[10px] font-medium text-[#ffffff]">
                          Applied
                        </span>
                      )}
                    </div>
                    {preset.description && (
                      <p className="mt-1 text-[11px] text-[#a1a1aa]">
                        {preset.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset })}
                    disabled={isApplying}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      isSelectedForPlanning
                        ? 'bg-[#ffffff] text-[#111315]'
                        : 'bg-[#000000] text-[#fafafa] hover:bg-[#18181b]'
                    }`}
                  >
                    {isSelectedForPlanning ? 'Used for planning' : 'Use for planning'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApply(preset.name)}
                    disabled={!state.videoId || !state.analysis || busy}
                    className="rounded-md px-3 py-1.5 text-[11px] font-medium text-[#a1a1aa] bg-[#000000] hover:bg-[#18181b] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
