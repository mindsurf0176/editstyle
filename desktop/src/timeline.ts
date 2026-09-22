import type { EditOperation, EditPlan } from './types';

export interface SourceRange {
  start_time: number;
  end_time: number;
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start_time - b.start_time)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start_time <= previous.end_time) {
      previous.end_time = Math.max(previous.end_time, range.end_time);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function subtractRange(ranges: SourceRange[], removed: SourceRange): SourceRange[] {
  return ranges.flatMap((range) => {
    if (removed.end_time <= range.start_time || removed.start_time >= range.end_time) return [range];
    const remaining: SourceRange[] = [];
    if (removed.start_time > range.start_time) {
      remaining.push({ start_time: range.start_time, end_time: removed.start_time });
    }
    if (removed.end_time < range.end_time) {
      remaining.push({ start_time: removed.end_time, end_time: range.end_time });
    }
    return remaining;
  });
}

export function getKeepRanges(operations: EditOperation[], duration: number): SourceRange[] {
  const cuts = operations.filter((operation) => operation.type === 'cut');
  const ranges = cuts.map((operation) => {
    const { start_time, end_time, action } = operation;
    if (typeof start_time !== 'number' || typeof end_time !== 'number'
      || !Number.isFinite(start_time) || !Number.isFinite(end_time)
      || start_time < 0 || end_time <= start_time || end_time > duration
      || (action !== 'keep' && action !== 'remove')) {
      throw new Error('Cut ranges must have a valid action and fit within the source video.');
    }
    return { start_time, end_time, action };
  });
  const removes = ranges.filter((range) => range.action === 'remove');
  // Match the engine's source-time contract; manual edits are normalized to keeps.
  if (removes.length > 0) {
    return removes.reduce(subtractRange, [{ start_time: 0, end_time: duration }]);
  }
  const keeps = ranges.filter((range) => range.action === 'keep');
  return keeps.length > 0 ? mergeRanges(keeps) : [{ start_time: 0, end_time: duration }];
}

function intersectRanges(ranges: SourceRange[], selection: SourceRange[]): SourceRange[] {
  return mergeRanges(ranges.flatMap((range) => selection.flatMap((selected) => {
    const start_time = Math.max(range.start_time, selected.start_time);
    const end_time = Math.min(range.end_time, selected.end_time);
    return end_time > start_time ? [{ start_time, end_time }] : [];
  })));
}

function withKeepRanges(plan: EditPlan, ranges: SourceRange[], reason: string): EditPlan {
  if (ranges.length === 0) throw new Error('This edit would remove the whole video. Keep at least one range.');
  return {
    ...plan,
    operations: [
      ...ranges.map((range): EditOperation => ({ type: 'cut', action: 'keep', ...range, reason })),
      ...plan.operations.filter((operation) => operation.type !== 'cut'),
    ],
    estimated_duration: ranges.reduce((duration, range) => duration + range.end_time - range.start_time, 0),
  };
}

export function editSourceRange(
  plan: EditPlan | null,
  duration: number,
  action: 'keep' | 'remove',
  selection: SourceRange,
): EditPlan {
  const { start_time, end_time } = selection;
  if (!Number.isFinite(start_time) || !Number.isFinite(end_time)
    || start_time < 0 || end_time <= start_time || end_time > duration) {
    throw new Error(`Choose a range between 0 and ${duration.toFixed(2)} seconds, with end after start.`);
  }
  const currentPlan = plan ?? { instruction: 'Manual edit', operations: [], estimated_duration: duration, summary: 'Manual source cuts' };
  const currentRanges = getKeepRanges(currentPlan.operations, duration);
  const ranges = action === 'keep'
    ? intersectRanges(currentRanges, [selection])
    : subtractRange(currentRanges, selection);
  return withKeepRanges(currentPlan, ranges, 'Manual source edit');
}

export function appendPlan(current: EditPlan | null, incoming: EditPlan, duration: number): EditPlan {
  if (!current) return incoming;
  // An empty proposal means no rule matched, so the existing plan stays as-is.
  if (incoming.operations.length === 0) return current;
  const replacedTypes = new Set(incoming.operations
    .filter((operation) => ['colorgrade', 'bgm', 'subtitle'].includes(operation.type))
    .map((operation) => operation.type));
  const operations = current.operations.filter((operation) => !replacedTypes.has(operation.type));
  for (const operation of incoming.operations) {
    if (!operations.some((existing) => JSON.stringify(existing) === JSON.stringify(operation))) {
      operations.push(operation);
    }
  }
  const plan = { ...incoming, operations };
  if (!incoming.operations.some((operation) => operation.type === 'cut')) {
    return { ...plan, estimated_duration: current.estimated_duration };
  }
  const ranges = intersectRanges(getKeepRanges(current.operations, duration), getKeepRanges(incoming.operations, duration));
  return withKeepRanges(plan, ranges, 'Combined source cuts');
}
