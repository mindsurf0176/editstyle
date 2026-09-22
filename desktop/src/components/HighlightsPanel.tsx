import { useMemo, useRef, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { useApp } from '../store';
import { generateHighlights } from '../api';

const DEFAULT_STYLE = 'viral';
const STYLE_OPTIONS = [
  { value: 'viral', label: 'Viral' },
  { value: 'narrative', label: 'Narrative' },
  { value: 'balanced', label: 'Balanced' },
];

export default function HighlightsPanel() {
  const { state, dispatch } = useApp();
  const [targetMinutes, setTargetMinutes] = useState(1);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [loading, setLoading] = useState(false);
  const revision = useRef(state.editRevision);
  revision.current = state.editRevision;
  const busy = loading || state.activeJob?.status === 'pending' || state.activeJob?.status === 'running';

  const maxMinutes = useMemo(() => {
    const duration = state.analysis?.duration ?? state.videoInfo?.duration ?? 0;
    return Math.max(1, Math.ceil(duration / 60));
  }, [state.analysis?.duration, state.videoInfo?.duration]);

  const handleGenerate = async () => {
    if (!state.videoId || !state.analysis || busy) return;
    const requestedRevision = state.editRevision;

    setLoading(true);
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      const { job_id } = await generateHighlights(state.videoId, targetMinutes * 60, style);
      if (revision.current !== requestedRevision) throw new Error('The edit changed. Generate highlights again.');
      dispatch({
        type: 'SET_ACTIVE_JOB',
        revision: requestedRevision,
        job: { job_id, type: 'highlights', status: 'running', progress: 0 },
      });
      dispatch({ type: 'SET_VIEW', view: 'editor' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate highlights';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[#27272a]">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Sparkles size={14} />
          Highlights
        </h3>
        <p className="mt-1 text-xs text-[#a1a1aa]">
          Generate a shorter cut from the most engaging scenes.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <label className="block space-y-2">
          <span className="text-xs font-medium text-[#fafafa]">Target length</span>
          <input
            type="range"
            min={1}
            max={maxMinutes}
            step={1}
            value={targetMinutes}
            onChange={(e) => setTargetMinutes(Number(e.target.value))}
            className="w-full accent-[#ffffff]"
          />
          <div className="flex items-center justify-between text-[11px] text-[#a1a1aa]">
            <span>1 min</span>
            <span>{targetMinutes} min target</span>
            <span>{maxMinutes} min max</span>
          </div>
        </label>

        <label className="block space-y-2">
          <span className="text-xs font-medium text-[#fafafa]">Highlight style</span>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="w-full rounded-lg border border-[#27272a] bg-[#000000] px-3 py-2 text-sm text-[#fafafa] focus:outline-none focus:border-[#ffffff]"
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded-lg border border-[#27272a] bg-[#18181b]/30 p-3 text-xs text-[#a1a1aa] leading-relaxed">
          CutAI will score scenes, build a highlight plan, and send it back to the Edit tab for review before rendering.
        </div>
      </div>

      <div className="px-4 py-3 border-t border-[#27272a]">
        <button
          onClick={handleGenerate}
          disabled={!state.videoId || !state.analysis || busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#ffffff] text-[#111315] text-sm font-medium hover:bg-[#e4e4e7] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          Generate highlights
        </button>
      </div>
    </div>
  );
}
