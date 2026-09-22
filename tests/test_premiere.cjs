const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost } = require('../plugins/premiere/host.js');
const { createBridge } = require('../plugins/premiere/bridge.js');

function fixture() {
  const state = { sequenceId: 'sequence-1', imported: [], speed: 1, audioOffset: 0, transitions: [], extraTrack: false, importOk: true };
  const source = { getMediaFilePath: async () => '/tmp/source.mp4', isSequence: async () => false,
    isMergedClip: async () => false, isMulticamClip: async () => false, isOffline: async () => false,
    getFootageInterpretation: async () => ({ getFrameRate: () => 30 }) };
  const item = (audio) => ({ getSpeed: async () => state.speed, isDisabled: async () => false,
    isSpeedReversed: async () => false, isAdjustmentLayer: async () => false, getProjectItem: async () => source,
    getStartTime: async () => ({ seconds: audio ? state.audioOffset : 0 }), getEndTime: async () => ({ seconds: 3 }),
    getInPoint: async () => ({ seconds: 0 }), getOutPoint: async () => ({ seconds: 3 }), getName: async () => '원본' });
  const track = audio => ({ getTrackItems: async type => type === 2 ? state.transitions : [item(audio)], isMuted: async () => false });
  const sequence = { guid: { toString: () => state.sequenceId }, name: '원본 시퀀스', getTimebase: async () => '8467200000',
    getFrameSize: async () => ({ width: 1920, height: 1080 }), getCaptionTrackCount: async () => 0,
    getVideoTrackCount: async () => state.extraTrack ? 2 : 1, getAudioTrackCount: async () => 1,
    getVideoTrack: async () => track(false), getAudioTrack: async () => track(true) };
  const added = { guid: { toString: () => 'new-sequence' }, name: 'editstyle result' };
  const project = { guid: { toString: () => 'project-1' }, getActiveSequence: async () => sequence,
    getSequences: async () => [sequence, ...state.imported.map(() => added)], getRootItem: async () => ({}),
    importFiles: async paths => { state.imported.push(paths); return state.importOk; },
    openSequence: async target => { assert.equal(target, added); return true; } };
  const ppro = { Project: { getActiveProject: async () => project }, ClipProjectItem: { cast: value => value } };
  return { host: createHost(ppro), state };
}

test('Premiere reads native clip and aligned audio in frames without writes', async () => {
  const { host, state } = fixture();
  const result = await host.snapshot();
  assert.equal(result.fps, 30); assert.equal(result.clips[0].duration, 90);
  assert.equal(result.clips[0].audio, true); assert.equal(state.imported.length, 0);
});
test('unsupported speed, separate audio, transitions and multitrack fail closed', async () => {
  for (const update of [{ speed: 2 }, { audioOffset: 1 }, { transitions: [{}] }, { extraTrack: true }]) {
    const { host, state } = fixture(); Object.assign(state, update);
    await assert.rejects(host.snapshot()); assert.equal(state.imported.length, 0);
  }
});
test('stale sequence blocks import', async () => {
  const { host, state } = fixture(); const expected = await host.snapshot(); state.sequenceId = 'changed';
  await assert.rejects(host.apply({ path: '/tmp/review.xml' }, expected), /바뀌었습니다/);
  assert.equal(state.imported.length, 0);
});
test('review imports exactly once and opens the newly added sequence', async () => {
  const { host, state } = fixture(); const expected = await host.snapshot();
  assert.equal(await host.apply({ path: '/tmp/review.xml' }, expected), 'editstyle result');
  assert.deepEqual(state.imported, [['/tmp/review.xml']]);
});
test('failed import is not reported as success', async () => {
  const { host, state } = fixture(); const expected = await host.snapshot(); state.importOk = false;
  await assert.rejects(host.apply({ path: '/tmp/review.xml' }, expected), /완료하지 못/);
});
test('bridge uses only the paired loopback endpoint and propagates safe errors', async () => {
  const calls = [];
  const bridge = createBridge(async (...args) => { calls.push(args); return { ok: true, json: async () => ({ protocol: 1 }) }; });
  bridge.pair(' code '); assert.equal((await bridge.request('/status')).protocol, 1);
  assert.equal(calls[0][0], 'http://127.0.0.1:18470/bridge/status');
  assert.equal(calls[0][1].headers['X-Editstyle-Plugin'], 'code');
  const bad = createBridge(async () => ({ ok: false, json: async () => ({ detail: 'paired code required' }) }));
  await assert.rejects(bad.request('/status'), /paired code/);
});
