import { describe, expect, it } from 'vitest';
import { appReducer, initialState, type AppState } from './store';
import type { EditPlan } from './types';

function createPlan(instruction: string, summary = instruction): EditPlan {
  return {
    instruction,
    operations: [{ type: 'cut', start_time: 0, end_time: 1 }],
    estimated_duration: 1,
    summary,
  };
}

function createState(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    ...overrides,
  };
}

describe('appReducer editor command state', () => {
  it('rejects stale style plans and competing active jobs', () => {
    const state = createState({ editRevision: 2, editPlan: createPlan('manual'),
      activeJob: { job_id: 'current', type: 'preview', status: 'running', progress: 5 } });
    expect(appReducer(state, { type: 'SET_EDIT_PLAN', plan: createPlan('stale'), revision: 1 })).toBe(state);
    expect(appReducer(state, { type: 'SET_ACTIVE_JOB', revision: 2,
      job: { job_id: 'other', type: 'render', status: 'running', progress: 0 } })).toBe(state);
  });

  it('preserves the current plan when a preset requires missing speech', () => {
    const state = createState({ editPlan: createPlan('manual') });
    const next = appReducer(state, { type: 'SET_EDIT_PLAN', revision: 0,
      plan: { ...createPlan('subtitles'), operations: [{ type: 'subtitle' }] } });
    expect(next.editPlan).toBe(state.editPlan);
    expect(next.error).toContain('Subtitles need a transcript');
  });

  it('stores a selected timeline range', () => {
    const nextState = appReducer(createState(), {
      type: 'SET_TIMELINE_SELECTION',
      selection: { type: 'range', start_time: 2, end_time: 6 },
    });

    expect(nextState.timelineSelection).toEqual({ type: 'range', start_time: 2, end_time: 6 });
  });

  it('records the last command result summary', () => {
    const summary = {
      command_id: 'cmd-1',
      instruction: '인트로 컷 줄여줘',
      changed_operations: 2,
      messages: ['작업을 적용했습니다.'],
    };

    const nextState = appReducer(createState(), {
      type: 'SET_COMMAND_RESULT_SUMMARY',
      summary,
    });

    expect(nextState.lastCommandSummary).toEqual(summary);
  });

  it('keeps at most 20 command undo entries', () => {
    const state = Array.from({ length: 21 }, (_, index) => index).reduce(
      (currentState, index) =>
        appReducer(currentState, {
          type: 'PUSH_COMMAND_UNDO',
          plan: createPlan(`plan-${index}`),
        }),
      createState()
    );

    expect(state.commandUndoStack).toHaveLength(20);
    expect(state.commandUndoStack[0]?.instruction).toBe('plan-20');
    expect(state.commandUndoStack.at(-1)?.instruction).toBe('plan-1');
  });

  it('undo restores the previous edit plan and clears generated outputs', () => {
    const previousPlan = createPlan('before', 'Before summary');
    const currentPlan = createPlan('after', 'After summary');
    const state = createState({
      editPlan: currentPlan,
      previewResult: { job_id: 'preview-1', output_path: '/tmp/preview.mp4' },
      renderResult: { job_id: 'render-1', output_path: '/tmp/render.mp4' },
      commandUndoStack: [previousPlan],
    });

    const nextState = appReducer(state, { type: 'UNDO_LAST_COMMAND' });

    expect(nextState.editPlan).toEqual(previousPlan);
    expect(nextState.commandUndoStack).toEqual([]);
    expect(nextState.previewResult).toBeNull();
    expect(nextState.renderResult).toBeNull();
    expect(nextState.lastCommandSummary).toEqual({
      command_id: 'undo',
      instruction: 'undo',
      changed_operations: previousPlan.operations.length,
      messages: ['Last edit undone.'],
    });
  });

  it('empty undo leaves state unchanged', () => {
    const state = createState({ editPlan: createPlan('current') });

    const nextState = appReducer(state, { type: 'UNDO_LAST_COMMAND' });

    expect(nextState).toBe(state);
  });
});
