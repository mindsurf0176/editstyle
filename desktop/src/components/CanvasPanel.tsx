import { Film } from 'lucide-react';
import { useApp } from '../store';
import VideoPreview from './VideoPreview';
import EditorTimeline from './EditorTimeline';

export default function CanvasPanel({ onOpenInstructions }: { onOpenInstructions?: () => void }) {
  const { state } = useApp();
  const hasVideo = !!state.videoId;

  return (
    <main aria-label="Video workspace" className="flex-1 flex flex-col bg-bg-base min-w-0 min-h-0 overflow-y-auto">
      {hasVideo ? (
        <>
          {/* Video Canvas */}
          <div className="flex-1 shrink-0 flex flex-col relative">
            <VideoPreview />
          </div>

          <EditorTimeline />

          {/* Bottom bar: video info */}
          <div className="min-h-9 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 bg-bg-panel border-t border-border flex-shrink-0">
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-text-muted timecode">
                {state.videoInfo?.width}×{state.videoInfo?.height} · {Math.round(state.videoInfo?.duration || 0)}s
              </span>
            </div>
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-xs text-text-muted truncate max-w-64">{state.videoInfo?.original_name}</span>
            </div>
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <Film size={32} className="text-text-muted" />
          <div className="text-center">
            <p className="text-base font-semibold text-text-secondary mb-1">No video loaded</p>
            <p className="text-sm text-text-muted">Import a local video to review scenes and build your edit.</p>
          </div>
          {onOpenInstructions ? <button type="button" onClick={onOpenInstructions}
            className="min-h-9 rounded-md border border-border-strong bg-bg-surface px-4 text-ui text-text-primary hover:bg-bg-elevated transition-colors">Open import & instructions</button> : null}
        </div>
      )}
    </main>
  );
}
