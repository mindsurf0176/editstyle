import { Film } from 'lucide-react';
import { useApp } from '../store';
import VideoPreview from './VideoPreview';
import EditorTimeline from './EditorTimeline';

export default function CanvasPanel() {
  const { state } = useApp();
  const hasVideo = !!state.videoId;

  return (
    <div className="flex-1 flex flex-col bg-bg-base min-w-0 h-full">
      {hasVideo ? (
        <>
          {/* Video Canvas */}
          <div className="flex-1 flex items-center justify-center bg-black min-h-0 relative">
            <VideoPreview />
          </div>

          <EditorTimeline />

          {/* Bottom bar: video info */}
          <div className="h-10 flex items-center justify-between px-4 bg-bg-panel border-t border-border flex-shrink-0">
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-text-muted font-mono">
                {state.videoInfo?.width}×{state.videoInfo?.height} · {Math.round(state.videoInfo?.duration || 0)}s
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-muted truncate max-w-48">{state.videoInfo?.original_name}</span>
            </div>
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-24 h-24 rounded-2xl bg-bg-surface border border-border flex items-center justify-center">
            <Film size={40} className="text-text-muted" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-text-secondary mb-1">No video loaded</p>
            <p className="text-sm text-text-muted">Import a video from the chat to get started</p>
          </div>
        </div>
      )}
    </div>
  );
}
