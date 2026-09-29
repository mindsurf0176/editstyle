import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { getSourceVideoUrl, getThumbnailUrl } from '../api';
import { useApp } from '../store';
import { getKeepRanges, keptPlaybackStep, type SourceRange } from '../timeline';

export default function SourcePlayer() {
  const { state, dispatch } = useApp();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSeekRef = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playKept, setPlayKept] = useState(true);
  const playKeptRef = useRef(true);
  playKeptRef.current = playKept;
  const duration = state.videoInfo?.duration ?? 0;
  const videoId = state.videoId;
  let ranges: SourceRange[] | null = null;
  if (duration > 0) {
    try {
      ranges = getKeepRanges(state.editPlan?.operations ?? [], duration);
    } catch {
      ranges = null;
    }
  }
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;
  const hasCuts = Boolean(state.editPlan?.operations.some((operation) => operation.type === 'cut'));

  useEffect(() => {
    setFailed(false);
    lastSeekRef.current = null;
  }, [videoId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    if (Math.abs(video.currentTime - state.currentTime) > 0.25) {
      video.currentTime = state.currentTime;
    }
  }, [failed, state.currentTime]);

  function followPlayback() {
    const video = videoRef.current;
    const activeRanges = rangesRef.current;
    if (!video || !activeRanges || !playKeptRef.current) {
      if (video) dispatch({ type: 'SET_CURRENT_TIME', time: video.currentTime });
      return;
    }
    const step = keptPlaybackStep(video.currentTime, activeRanges, !video.paused);
    if (step.seek && lastSeekRef.current !== step.time) {
      lastSeekRef.current = step.time;
      video.currentTime = step.time;
    } else if (!step.seek) {
      lastSeekRef.current = null;
    }
    if (step.pause) video.pause();
    dispatch({ type: 'SET_CURRENT_TIME', time: step.seek ? step.time : video.currentTime });
  }

  function commitSettled() {
    const video = videoRef.current;
    if (!video || !video.paused) return;
    dispatch({ type: 'COMMIT_PLAYHEAD', time: video.currentTime });
  }

  if (!videoId) return null;
  const sourceUrl = getSourceVideoUrl(videoId);
  const thumbnailUrl = getThumbnailUrl(videoId, failed ? state.currentTime : state.playheadTime);

  return (
    <div className="absolute inset-0">
      {failed ? (
        <img src={thumbnailUrl} alt="Video frame" className="absolute inset-0 h-full w-full object-contain" />
      ) : (
        <video
          key={videoId}
          ref={videoRef}
          src={sourceUrl}
          poster={thumbnailUrl}
          preload="metadata"
          playsInline
          className="absolute inset-0 h-full w-full object-contain bg-black"
          onTimeUpdate={followPlayback}
          onPlay={() => { setPlaying(true); followPlayback(); }}
          onPause={() => { setPlaying(false); commitSettled(); }}
          onSeeked={commitSettled}
          onError={() => setFailed(true)}
        />
      )}
      <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2">
        {failed ? (
          <p className="rounded bg-bg-panel px-2 py-1 text-xs text-text-secondary">
            This file cannot play here. Scrubbing still shows frames.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="inline-flex min-h-8 items-center gap-2 rounded-md bg-accent px-3 text-ui font-medium text-on-accent hover:bg-accent-hover"
              onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (video.paused) void video.play().catch(() => setFailed(true));
                else video.pause();
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? 'Pause source' : 'Play source'}
            </button>
            {hasCuts && ranges ? (
              <label className="inline-flex min-h-8 items-center gap-2 rounded-md bg-bg-panel px-2 text-ui text-text-primary">
                <input
                  type="checkbox"
                  checked={playKept}
                  onChange={(event) => setPlayKept(event.target.checked)}
                />
                Play kept ranges
              </label>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
