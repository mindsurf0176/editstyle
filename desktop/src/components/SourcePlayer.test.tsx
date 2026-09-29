/* @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import SourcePlayer from './SourcePlayer';
import { AppContext, appReducer, initialState, type AppAction, type AppState } from '../store';
import type { EditPlan, VideoInfo } from '../types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const videoInfo: VideoInfo = {
  video_id: 'video-1', original_name: 'clip.mp4', duration: 36,
  width: 1920, height: 1080, fps: 30, file_size: 100,
};

const editPlan: EditPlan = {
  instruction: 'Keep the opening and the middle',
  operations: [
    { type: 'cut', action: 'keep', start_time: 0, end_time: 18 },
    { type: 'cut', action: 'remove', start_time: 6, end_time: 12 },
  ],
  estimated_duration: 12,
  summary: 'Skip 6–12s',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderPlayer(dispatched: AppAction[] = []) {
  function Harness() {
    const [state, setState] = React.useState<AppState>({
      ...initialState, videoId: videoInfo.video_id, videoInfo, editPlan, mediaStatus: 'available',
    });
    const dispatch = React.useCallback((action: AppAction) => {
      dispatched.push(action);
      setState((current) => appReducer(current, action));
    }, []);
    return (
      <AppContext.Provider value={{ state, dispatch }}>
        <SourcePlayer />
      </AppContext.Provider>
    );
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root?.render(<Harness />); });
}

describe('source playback', () => {
  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
  });

  it('skips a removed range while playing and saves the playhead when paused', async () => {
    const dispatched: AppAction[] = [];
    await renderPlayer(dispatched);
    const video = container?.querySelector('video');
    if (!video) throw new Error('source video missing');
    let paused = false;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.currentTime = 7;
    await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
    expect(video.currentTime).toBe(12);
    expect(dispatched).toContainEqual({ type: 'SET_CURRENT_TIME', time: 12 });
    expect(dispatched.some((action) => action.type === 'COMMIT_PLAYHEAD')).toBe(false);

    paused = true;
    video.currentTime = 4;
    await act(async () => { video.dispatchEvent(new Event('pause')); });
    expect(video.currentTime).toBe(4);
    expect(dispatched).toContainEqual({ type: 'COMMIT_PLAYHEAD', time: 4 });
  });
});
