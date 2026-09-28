import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from './store';
import { editingState } from './projectPersistence';
import type { ProjectSnapshot } from './types';

const project: ProjectSnapshot = {
  schema_version: 1, video_id: 'reopened', revision: 7, updated_at: '2026-09-28',
  video_info: { video_id: 'reopened', original_name: 'clip.mp4', duration: 30, width: 100, height: 100, fps: 30, file_size: 1 },
  analysis: null, media_status: 'missing',
  state: { ...editingState(initialState), preview_resolution: 720, render_preset: 'high', subtitle_export_mode: 'sidecar',
    edit_plan: { instruction: 'restored', summary: 'restored', operations: [], estimated_duration: 30 },
    undo_stack: [null], transcribe_on_import: true },
};

describe('atomic project hydration', () => {
  it('restores undo and preferences while dropping every transient job, output, selection and error', () => {
    const state = appReducer({ ...initialState, editRevision: 10,
      activeJob: { job_id: 'old', type: 'render', status: 'running', progress: 70 },
      previewResult: { job_id: 'old', output_path: '/tmp/stale' }, renderResult: { job_id: 'old', output_path: '/tmp/stale' },
      currentTime: 20, timelineSelection: { type: 'range', start_time: 5, end_time: 9 },
      recentOutputs: [{ job_id: 'old', kind: 'render', completed_at: 'yesterday', output_path: '/tmp/stale' }], error: 'old error',
    }, { type: 'HYDRATE_PROJECT', project });
    expect(editingState(state)).toEqual(project.state);
    expect(state.commandUndoStack).toEqual([null]);
    expect(state.projectRevision).toBe(7);
    expect(state.editRevision).toBe(11);
    expect(state.mediaStatus).toBe('missing');
    expect(state.currentTime).toBe(0);
    expect(state.timelineSelection).toEqual({ type: 'none' });
    expect([state.activeJob, state.previewResult, state.renderResult, state.error, state.lastCommandSummary]).toEqual([null, null, null, null, null]);
    expect(state.recentOutputs).toEqual([]);
    const undone = appReducer(state, { type: 'UNDO_LAST_COMMAND' });
    expect(undone.editPlan).toBeNull();
    expect(undone.commandUndoStack).toEqual([]);
  });

  it('rejects a late revision acknowledgement and analysis job from another project', () => {
    const state = appReducer(initialState, { type: 'HYDRATE_PROJECT', project });
    expect(appReducer(state, { type: 'SET_PROJECT_REVISION', videoId: 'old', revision: 99 })).toBe(state);
    expect(appReducer(state, { type: 'SET_PROJECT_REVISION', videoId: 'reopened', revision: 6 })).toBe(state);
    expect(appReducer(state, { type: 'SET_ACTIVE_JOB', videoId: 'old',
      job: { job_id: 'late', type: 'analysis', status: 'running', progress: 0 } })).toBe(state);
    expect(appReducer(state, { type: 'APPLY_STYLE_PLAN', videoId: 'old', revision: state.editRevision,
      plan: project.state.edit_plan!, preset: { name: 'old style', description: '' } })).toBe(state);
    expect(appReducer(state, { type: 'APPLY_STYLE_PLAN', videoId: 'reopened', revision: state.editRevision - 1,
      plan: project.state.edit_plan!, preset: { name: 'old style', description: '' } })).toBe(state);
  });

  it('drops unverifiable jobs and outputs on disconnect while preserving the current edit and undo', () => {
    const restored = appReducer(initialState, { type: 'HYDRATE_PROJECT', project });
    const disconnected = appReducer({ ...restored, backendOnline: true,
      activeJob: { job_id: 'interrupted', type: 'render', status: 'running', progress: 50 },
      renderResult: { job_id: 'old', output_path: '/stale' },
    }, { type: 'SET_BACKEND_STATE', status: 'offline' });
    expect(editingState(disconnected)).toEqual(project.state);
    expect(disconnected.activeJob).toBeNull();
    expect(disconnected.renderResult).toBeNull();
    expect(disconnected.editRevision).toBe(restored.editRevision + 1);
  });
});
