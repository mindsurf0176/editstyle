import { describe, expect, it } from 'vitest';
import { appendPlan, editSourceRange, getKeepRanges, keptPlaybackStep, nextKeptTime } from './timeline';
import type { EditOperation, EditPlan } from './types';

type CutSpec = ['keep' | 'remove', number, number];
type RangeSpec = [number, number];

// Keep these behavioral cases aligned with tests/test_cut_contract.py.
const cutCases: [string, CutSpec[], RangeSpec[]][] = [
  ['no cuts', [], [[0, 36]]],
  ['one keep', [['keep', 6, 18]], [[6, 18]]],
  ['one remove', [['remove', 6, 12]], [[0, 6], [12, 36]]],
  ['mixed', [['keep', 0, 18], ['remove', 6, 12]], [[0, 6], [12, 18]]],
  ['mixed reverse order', [['remove', 6, 12], ['keep', 0, 18]], [[0, 6], [12, 18]]],
  ['overlapping keeps', [['keep', 8, 18], ['keep', 2, 12]], [[2, 18]]],
  ['adjacent keeps', [['keep', 6, 12], ['keep', 0, 6]], [[0, 12]]],
  ['overlapping removes', [['remove', 8, 18], ['remove', 2, 12]], [[0, 2], [18, 36]]],
  ['adjacent removes', [['remove', 6, 12], ['remove', 0, 6]], [[12, 36]]],
  ['outside keep', [['keep', 6, 18], ['remove', 24, 36]], [[6, 18]]],
  ['touching keep', [['keep', 6, 18], ['remove', 0, 6], ['remove', 18, 36]], [[6, 18]]],
  ['remove spanning keeps', [['keep', 2, 8], ['keep', 12, 20], ['remove', 6, 15]], [[2, 6], [15, 20]]],
  ['remove contains keep', [['keep', 6, 18], ['remove', 0, 24]], []],
  ['all removed', [['remove', 0, 36]], []],
  ['keep then all removed', [['keep', 0, 36], ['remove', 0, 36]], []],
  ['duplicates', [['keep', 0, 18], ['keep', 0, 18], ['remove', 6, 12], ['remove', 6, 12]], [[0, 6], [12, 18]]],
];

const invalidRanges: RangeSpec[] = [
  [-1, 6], [6, 6], [12, 6], [30, 50], [36, 40],
  [NaN, 6], [0, NaN], [Infinity, 36], [0, Infinity], [-Infinity, 6],
];

describe('source-time cut contract', () => {
  it.each(cutCases)('%s', (_name, specs, expected) => {
    const operations: EditOperation[] = specs.map(([action, start_time, end_time]) => ({
      type: 'cut', action, start_time, end_time,
    }));
    const original = JSON.stringify(operations);
    expect(getKeepRanges(operations, 36)).toEqual(expected.map(([start_time, end_time]) => ({ start_time, end_time })));
    expect(JSON.stringify(operations)).toBe(original);
  });

  it.each(invalidRanges)('rejects invalid interval [%s, %s] even if removed', (start_time, end_time) => {
    for (const action of ['keep', 'remove']) {
      expect(() => getKeepRanges([
        { type: 'cut', action: 'remove', start_time: 0, end_time: 36 },
        { type: 'cut', action, start_time, end_time },
      ], 36)).toThrow('Cut ranges');
    }
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid duration %s even without cuts', (duration) => {
    expect(() => getKeepRanges([], duration)).toThrow('Source duration');
    expect(() => getKeepRanges([{ type: 'cut', action: 'keep', start_time: 0, end_time: 1 }], duration)).toThrow('Source duration');
  });

  it('rejects unknown actions and missing times', () => {
    expect(() => getKeepRanges([{ type: 'cut', action: 'trim', start_time: 0, end_time: 10 }], 36)).toThrow('Cut ranges');
    expect(() => getKeepRanges([{ type: 'cut', action: 'keep', start_time: 0 }], 36)).toThrow('Cut ranges');
  });

  it('plays through kept ranges and stops after the last one', () => {
    const ranges = getKeepRanges([
      { type: 'cut', action: 'keep', start_time: 0, end_time: 18 },
      { type: 'cut', action: 'remove', start_time: 6, end_time: 12 },
    ], 36);
    expect(ranges).toEqual([{ start_time: 0, end_time: 6 }, { start_time: 12, end_time: 18 }]);
    expect(nextKeptTime(3, ranges)).toBe(3);
    expect(nextKeptTime(6, ranges)).toBe(12);
    expect(nextKeptTime(18, ranges)).toBeNull();
    expect(keptPlaybackStep(7, ranges, false)).toEqual({ time: 7, seek: false, pause: false });
    expect(keptPlaybackStep(7, ranges, true)).toEqual({ time: 12, seek: true, pause: false });
    expect(keptPlaybackStep(18, ranges, true)).toEqual({ time: 18, seek: false, pause: true });
    expect(keptPlaybackStep(4, [], true)).toEqual({ time: 4, seek: false, pause: true });
  });
});

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

  it('intersects a later mixed plan with retained manual footage', () => {
    const manual = editSourceRange(null, 36, 'keep', { start_time: 2, end_time: 24 });
    const combined = appendPlan(manual, {
      ...gradePlan,
      operations: [
        { type: 'cut', action: 'keep', start_time: 0, end_time: 18 },
        { type: 'cut', action: 'remove', start_time: 6, end_time: 12 },
      ],
    }, 36);
    expect(getKeepRanges(combined.operations, 36)).toEqual([
      { start_time: 2, end_time: 6 }, { start_time: 12, end_time: 18 },
    ]);
    expect(combined.estimated_duration).toBe(10);
  });

  it('rejects an invalid or empty first proposal', () => {
    for (const operations of [
      [{ type: 'cut', action: 'keep', start_time: 30, end_time: 50 }],
      [{ type: 'cut', action: 'remove', start_time: 0, end_time: 36 }],
    ] as EditOperation[][]) {
      expect(() => appendPlan(null, { ...gradePlan, operations }, 36)).toThrow();
    }
  });
});
