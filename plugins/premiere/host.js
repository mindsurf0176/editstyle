/* Premiere 25.6+ DOM only. No QE, ExtendScript eval, shell, or original edits. */
"use strict";

function createHost(ppro) {
  const frame = (seconds, fps) => {
    const result = seconds * fps;
    if (!Number.isFinite(result) || Math.abs(result - Math.round(result)) > 0.02)
      throw new Error("프레임 경계에 맞지 않는 클립입니다. 오디오·속도 설정을 확인하세요.");
    return Math.round(result);
  };
  async function snapshot() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Premiere에서 프로젝트를 여세요.");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("편집할 시퀀스를 여세요.");
    const fps = 254016000000 / Number(await sequence.getTimebase());
    const size = await sequence.getFrameSize();
    if (await sequence.getCaptionTrackCount()) throw new Error("자막 없는 러프컷 시퀀스를 선택하세요.");
    async function readTracks(kind) {
      const video = kind === "Video";
      const count = await sequence[video ? "getVideoTrackCount" : "getAudioTrackCount"]();
      const rows = [];
      let populated = 0;
      for (let t = 0; t < count; t++) {
        const track = await sequence[video ? "getVideoTrack" : "getAudioTrack"](t);
        if ((await track.getTrackItems(2, false)).length)
          throw new Error("전환 효과 없는 기본 컷 타임라인만 지원합니다.");
        const items = await track.getTrackItems(1, false);
        if (!items.length) continue;
        if (++populated > 1 || await track.isMuted())
          throw new Error("영상 한 트랙과 음소거되지 않은 원본 오디오 한 트랙만 지원합니다.");
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (await item.isDisabled() || Math.abs(await item.getSpeed() - 1) > 0.00001 || await item.isSpeedReversed())
            throw new Error("비활성·역재생·속도 변경 클립은 아직 지원하지 않습니다.");
          if (video && await item.isAdjustmentLayer()) throw new Error("조정 레이어는 지원하지 않습니다.");
          const media = ppro.ClipProjectItem.cast(await item.getProjectItem());
          const path = media && await media.getMediaFilePath();
          if (!path || await media.isSequence() || await media.isMergedClip() || await media.isMulticamClip() || await media.isOffline())
            throw new Error("오프라인·중첩·병합·멀티캠·생성 미디어 대신 온라인 원본 영상 클립을 사용하세요.");
          if (video) {
            const interpretation = await media.getFootageInterpretation();
            if (Math.abs(interpretation.getFrameRate() - fps) > 0.001)
              throw new Error("원본과 시퀀스의 프레임레이트가 같아야 합니다.");
          }
          const start = frame((await item.getStartTime()).seconds, fps);
          const end = frame((await item.getEndTime()).seconds, fps);
          const sourceIn = frame((await item.getInPoint()).seconds, fps);
          const sourceOut = frame((await item.getOutPoint()).seconds, fps);
          if (end - start !== sourceOut - sourceIn || end <= start)
            throw new Error("시간 매핑이 바뀐 클립은 지원하지 않습니다.");
          rows.push({ id: `${video ? "v" : "a"}${t}-${i}`, name: await item.getName(), path,
            timeline_in: start, source_in: sourceIn, duration: end - start,
            source_frames: sourceOut, audio: false });
        }
      }
      return rows.sort((a, b) => a.timeline_in - b.timeline_in);
    }
    const clips = await readTracks("Video"), audio = await readTracks("Audio");
    if (!clips.length || clips.length > 80) throw new Error("1~80개의 영상 클립을 사용하세요.");
    const used = new Set();
    for (const clip of clips) {
      const pairs = audio.filter(a => a.path === clip.path && a.timeline_in === clip.timeline_in &&
        a.source_in === clip.source_in && a.duration === clip.duration);
      if (pairs.length > 1) throw new Error("중복 오디오를 지원하지 않습니다.");
      if (pairs.length) { clip.audio = true; used.add(pairs[0].id); }
    }
    if (used.size !== audio.length) throw new Error("별도 음악·분리 오디오·J/L컷은 아직 지원하지 않습니다.");
    return { host: "premiere", project_id: project.guid.toString(), sequence_id: sequence.guid.toString(),
      name: sequence.name, fps, width: size.width, height: size.height, clips };
  }
  async function apply(prepared, expected) {
    // Re-read immediately before the sole host mutation. No remote response selects a project.
    if (JSON.stringify(await snapshot()) !== JSON.stringify(expected))
      throw new Error("타임라인이 바뀌었습니다. 다시 읽고 검토하세요.");
    const project = await ppro.Project.getActiveProject();
    const before = new Set((await project.getSequences()).map(s => s.guid.toString()));
    if (project.guid.toString() !== expected.project_id ||
        (await project.getActiveSequence()).guid.toString() !== expected.sequence_id)
      throw new Error("대상 프로젝트가 바뀌었습니다. 다시 읽고 검토하세요.");
    const ok = await project.importFiles([prepared.path], true, await project.getRootItem(), false);
    if (!ok) throw new Error("Premiere가 러프컷 가져오기를 완료하지 못했습니다. 원본은 유지됩니다.");
    const added = (await project.getSequences()).filter(s => !before.has(s.guid.toString()));
    if (added.length !== 1) throw new Error("가져온 시퀀스를 자동 식별하지 못했습니다. 프로젝트 패널을 확인하세요. 재적용하지 마세요.");
    if (!await project.openSequence(added[0]))
      throw new Error("시퀀스는 생성됐지만 열지 못했습니다. 프로젝트 패널에서 여세요. 재적용하지 마세요.");
    return added[0].name;
  }
  return { snapshot, apply };
}

module.exports = { createHost };
