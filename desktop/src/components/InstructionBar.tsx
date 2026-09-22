import { useRef, useState } from 'react';
import { Send, Scissors, Subtitles, Clapperboard, Wand2, X } from 'lucide-react';
import { useApp } from '../store';
import { createPlan } from '../api';

const QUICK_PRESETS = [
  { label: 'Remove silence', icon: Scissors, instruction: 'Remove all silent parts' },
  { label: 'Add subtitles', icon: Subtitles, instruction: 'Add subtitles to the video' },
  { label: 'Make cinematic', icon: Clapperboard, instruction: 'Apply cinematic color grading and transitions' },
];

export default function InstructionBar() {
  const { state, dispatch } = useApp();
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const revisionRef = useRef(state.editRevision);
  revisionRef.current = state.editRevision;

  const disabled = !state.videoId;
  const isRefiningPlan = !!state.editPlan;
  const selectedStylePreset = state.planningStylePreset;

  const handleSubmit = async (text?: string) => {
    const finalInstruction = text || instruction;
    if (!finalInstruction.trim() || !state.videoId || loading) return;

    setLoading(true);
    try {
      const plan = await createPlan(
        state.videoId,
        finalInstruction,
        { stylePreset: selectedStylePreset?.file ?? selectedStylePreset?.name }
      );
      if (revisionRef.current !== state.editRevision) throw new Error('The edit changed while planning. Send the instruction again.');
      if (plan.operations.some((operation) => operation.type === 'subtitle') && !state.analysis?.transcript.length) {
        throw new Error('Subtitles need a transcript. Enable speech transcription and import the video again.');
      }
      dispatch({ type: 'APPLY_PLAN_PROPOSAL', plan, revision: state.editRevision });
      dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'edit' });
      dispatch({ type: 'SET_VIEW', view: 'editor' });
      if (!text) setInstruction('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create plan';
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {/* Quick presets — only show when no video loaded */}
      {!state.videoId && (
        <div className="flex items-center gap-2">
          {QUICK_PRESETS.map(({ label, icon: Icon }) => (
            <button key={label} disabled className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-muted bg-bg-surface border border-border opacity-50 cursor-not-allowed">
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Style preset indicator */}
      {selectedStylePreset && state.videoId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/10 border border-accent/20">
          <Wand2 size={12} className="text-accent" />
          <span className="text-xs font-medium text-accent flex-1">Style context: {selectedStylePreset.name}</span>
          <button aria-label="Clear style context" onClick={() => dispatch({ type: 'SET_PLANNING_STYLE_PRESET', preset: null })} className="text-accent hover:text-text-primary transition-colors">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main input */}
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="flex items-center gap-2">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={disabled ? 'Import a video to start editing...' : isRefiningPlan ? 'Refine your edit plan...' : 'Describe your edit — "Cut the intro, add subtitles, speed up 2x"'}
          disabled={disabled}
          className="flex-1 h-11 px-4 rounded-lg bg-bg-surface border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        />
        <button
          type="submit"
          disabled={disabled || !instruction.trim() || loading}
          className="h-11 px-5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {loading ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Send size={16} />
          )}
          <span>{isRefiningPlan ? 'Refine' : 'Go'}</span>
        </button>
      </form>
    </div>
  );
}
