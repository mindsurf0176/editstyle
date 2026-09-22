import { describe, expect, it } from 'vitest';
import type { CommandResultSummary, EditOperation, TimelineSelection } from './types';

describe('editor workflow types', () => {
  it('supports timeline selection variants', () => {
    const selections: TimelineSelection[] = [
      { type: 'none' },
      { type: 'playhead', time: 12.5 },
      { type: 'range', start_time: 3, end_time: 8 },
      { type: 'operation', operation_index: 1 },
    ];

    expect(selections.map((selection) => selection.type)).toEqual([
      'none',
      'playhead',
      'range',
      'operation',
    ]);
  });

  it('supports command summaries and editable subtitle operations', () => {
    const summary: CommandResultSummary = {
      command_id: 'cmd-1',
      instruction: '자막을 더 짧게 정리',
      changed_operations: 1,
      duration_before: 42,
      duration_after: 38,
      messages: ['자막 길이를 줄였습니다.'],
    };
    const operation: EditOperation = {
      type: 'subtitle',
      start_time: 1,
      end_time: 4,
      description: 'Opening subtitle',
      text: 'Short intro',
      editable: true,
      reason: 'intro pacing',
      confidence: 0.86,
    };

    expect(summary.changed_operations).toBe(1);
    expect(operation.editable).toBe(true);
  });
});
