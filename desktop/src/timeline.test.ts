import { describe, expect, it } from 'vitest';
import { appendPlan, editSourceRange } from './timeline';
import type { EditPlan } from './types';

const gradePlan: EditPlan = {
  instruction: 'warm color',
  operations: [{ type: 'colorgrade', preset: 'warm', intensity: 50 }],
  estimated_duration: 20,
  summary: 'Warm',
};

describe('source timeline editing', () => {
  it('trims the source then removes an interior range without restoring excluded footage', () => {
    const trim = editSourceRange(gradePlan, 20, 'keep', { start_time: 2, end_time: 15 });
    const remove = editSourceRange(trim, 20, 'remove', { start_time: 6, end_time: 9 });
    expect(remove.operations).toEqual([
      { type: 'cut', action: 'keep', start_time: 2, end_time: 6, reason: 'Manual source edit' },
      { type: 'cut', action: 'keep', start_time: 9, end_time: 15, reason: 'Manual source edit' },
      gradePlan.operations[0],
    ]);
    expect(remove.estimated_duration).toBe(10);
    expect(gradePlan.operations).toHaveLength(1);
  });

  it('keeps manually retained footage when a later instruction adds color grading', () => {
    const manual = editSourceRange(null, 20, 'keep', { start_time: 3, end_time: 12 });
    const combined = appendPlan(manual, gradePlan, 20);
    expect(combined.operations).toEqual([...manual.operations, ...gradePlan.operations]);
    expect(combined.estimated_duration).toBe(9);
  });

  it('combines later automatic removal with the retained manual range', () => {
    const manual = editSourceRange(null, 20, 'keep', { start_time: 3, end_time: 12 });
    const combined = appendPlan(manual, {
      ...gradePlan,
      operations: [{ type: 'cut', action: 'remove', start_time: 0, end_time: 5 }],
    }, 20);
    expect(combined.operations).toEqual([
      { type: 'cut', action: 'keep', start_time: 5, end_time: 12, reason: 'Combined source cuts' },
    ]);
    expect(combined.estimated_duration).toBe(7);
  });

  it('rejects empty output and invalid source-time ranges', () => {
    expect(() => editSourceRange(null, 20, 'remove', { start_time: 0, end_time: 20 })).toThrow('whole video');
    for (const selection of [
      { start_time: -1, end_time: 4 }, { start_time: 7, end_time: 3 },
      { start_time: 4, end_time: 21 }, { start_time: NaN, end_time: 5 },
    ]) {
      expect(() => editSourceRange(null, 20, 'keep', selection)).toThrow('Choose a range');
    }
  });

  it('replaces a previous singleton effect while retaining manual cuts', () => {
    const manual = editSourceRange(null, 20, 'keep', { start_time: 2, end_time: 14 });
    const warm = appendPlan(manual, gradePlan, 20);
    const cool = appendPlan(warm, { ...gradePlan, operations: [{ type: 'colorgrade', preset: 'cool', intensity: 50 }] }, 20);
    expect(cool.operations).toEqual([...manual.operations, { type: 'colorgrade', preset: 'cool', intensity: 50 }]);
    expect(cool.estimated_duration).toBe(12);
  });

  it('keeps the existing plan when a proposal matched no rules', () => {
    const manual = editSourceRange(null, 20, 'keep', { start_time: 2, end_time: 14 });
    const warm = appendPlan(manual, gradePlan, 20);
    const unmatched = appendPlan(warm, {
      instruction: 'make it sparkle',
      operations: [],
      estimated_duration: 20,
      summary: '',
    }, 20);
    expect(unmatched).toBe(warm);
  });
});
