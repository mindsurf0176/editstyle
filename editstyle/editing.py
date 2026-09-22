"""Validated edit proposals and neutral interchange bundles."""

from __future__ import annotations

import csv
import json
import shutil
import zipfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

from editstyle.media import run


class Clip(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    reason: str = Field(min_length=1, max_length=1000)
    caption: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def ordered(self):
        if self.end <= self.start or "\n\n" in self.caption or "\r" in self.caption:
            raise ValueError("컷의 끝은 시작보다 뒤여야 하며 자막에 빈 줄을 넣을 수 없습니다.")
        return self


class Proposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    summary: str = Field(min_length=1, max_length=3000)
    clips: list[Clip] = Field(min_length=1, max_length=80)
    notes: list[str] = Field(default_factory=list, max_length=20)


def validate(proposal: Proposal, media: dict) -> dict:
    result = proposal.model_dump()
    previous = 0
    total = 0
    for clip in result["clips"]:
        start, end = round(clip["start"] * 30), round(clip["end"] * 30)
        if not previous <= start < end <= media["frames"]:
            raise ValueError("컷은 원본 범위 안에서 시간순으로 겹치지 않아야 합니다. 최소 길이는 1프레임입니다.")
        clip.update(start=start / 30, end=end / 30, source_in=start, source_out=end,
                    timeline_in=total, timeline_out=total + end - start)
        total += end - start
        previous = end
    result["duration"] = total / 30
    result["duration_frames"] = total
    return result


def srt(plan: dict) -> str:
    def stamp(frame):
        milliseconds = round(frame * 1000 / 30)
        hours, rest = divmod(milliseconds, 3600000)
        minutes, rest = divmod(rest, 60000)
        seconds, ms = divmod(rest, 1000)
        return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"
    entries = []
    for clip in plan["clips"]:
        if clip["caption"].strip():
            entries.append(f"{len(entries) + 1}\n{stamp(clip['timeline_in'])} --> {stamp(clip['timeline_out'])}\n{clip['caption'].strip()}\n")
    return "\n".join(entries)


def timeline(plan: dict, media: dict, source: Path):
    import opentimelineio as otio

    rate = 30
    def span(start, duration):
        return otio.opentime.TimeRange(otio.opentime.RationalTime(start, rate),
                                       otio.opentime.RationalTime(duration, rate))
    sequence = otio.schema.Timeline(name="editstyle", global_start_time=otio.opentime.RationalTime(0, rate))
    video_format = {"width": str(media["width"]), "height": str(media["height"]),
                    "pixelaspectratio": "square", "fielddominance": "none",
                    "rate": {"timebase": "30", "ntsc": "FALSE"}}
    sequence.metadata["fcp_xml"] = {"media": {"video": {"format": {"samplecharacteristics": video_format}}}}
    sequence.metadata["editstyle"] = {"summary": plan["summary"], "unmapped": plan["notes"],
                                     "captions": "captions.srt; import separately, typography is manual"}
    for kind in (["Video", "Audio"] if media["has_audio"] else ["Video"]):
        track = otio.schema.Track(name=kind, kind=kind)
        for index, item in enumerate(plan["clips"]):
            clip = otio.schema.Clip(name=f"{index + 1:03d}",
                                    media_reference=otio.schema.ExternalReference(
                                        target_url=source.as_uri(), available_range=span(0, media["frames"])),
                                    source_range=span(item["source_in"], item["source_out"] - item["source_in"]))
            file_media = {"video": {"samplecharacteristics": video_format}}
            if media["has_audio"]:
                file_media["audio"] = {"samplecharacteristics": {"depth": "16", "samplerate": "48000"}, "channelcount": "2"}
            clip.media_reference.metadata["fcp_xml"] = {"media": file_media}
            clip.metadata["fcp_xml"] = {"sourcetrack": {"mediatype": kind.lower(), "trackindex": "1"}}
            clip.markers.append(otio.schema.Marker(name=item["reason"],
                                                   marked_range=span(item["source_in"], 0)))
            track.append(clip)
        sequence.tracks.append(track)
    return sequence


def export_bundle(plan: dict, media: dict, source: Path, directory: Path) -> Path:
    """Create one immutable snapshot. Filenames never come from model output."""
    import opentimelineio as otio

    directory.mkdir(mode=0o700)
    (directory / "clips").mkdir()
    shutil.copy2(source, directory / "source.mp4")
    source = directory / "source.mp4"
    sequence = timeline(plan, media, source)
    otio.adapters.write_to_file(sequence, str(directory / "timeline.otio"))
    otio.adapters.write_to_file(sequence, str(directory / "timeline.xml"), adapter_name="fcp_xml")
    (directory / "captions.srt").write_text(srt(plan), encoding="utf-8")
    (directory / "EDITSTYLE.md").write_text(plan["style_markdown"], encoding="utf-8")
    (directory / "proposal.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    with (directory / "cuts.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["clip", "source_in_seconds", "source_out_seconds", "timeline_in_seconds", "reason"])
        for i, clip in enumerate(plan["clips"]):
            # Prefix strings to prevent spreadsheet formula interpretation.
            writer.writerow([f"{i + 1:03d}", clip["start"], clip["end"], clip["timeline_in"] / 30, "'" + clip["reason"]])
    filters = []
    inputs = []
    for i, clip in enumerate(plan["clips"]):
        path = directory / "clips" / f"{i + 1:03d}.mp4"
        length = clip["source_out"] - clip["source_in"]
        run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-ss", str(clip["start"]), "-i", str(source),
             "-t", str(length / 30), "-map", "0:v:0", "-map", "0:a:0?", "-vf", "fps=30",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac",
             "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(path)], 300)
        filters.append(f"[0:v]trim=start_frame={clip['source_in']}:end_frame={clip['source_out']},setpts=PTS-STARTPTS[v{i}]")
        inputs.append(f"[v{i}]")
        if media["has_audio"]:
            filters.append(f"[0:a]atrim=start={clip['start']}:end={clip['end']},asetpts=PTS-STARTPTS[a{i}]")
            inputs.append(f"[a{i}]")
    # Trim once from the source. Concatenating AAC files introduces packet-padding drift.
    filters.append("".join(inputs) + f"concat=n={len(plan['clips'])}:v=1:a={int(media['has_audio'])}[v]" + ("[a]" if media["has_audio"] else ""))
    args = ["ffmpeg", "-v", "error", "-nostdin", "-n", "-i", str(source),
            "-filter_complex", ";".join(filters), "-map", "[v]"]
    if media["has_audio"]:
        args += ["-map", "[a]"]
    run([*args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac",
         "-movflags", "+faststart", str(directory / "preview.mp4")], 600)
    (directory / "IMPORT.md").write_text(
        "# editstyle 가져오기\n\n"
        "이 묶음은 검토한 컷과 원본 오디오를 담습니다. 색보정·전환 효과·배경음악은 자동 적용하지 않았습니다.\n\n"
        "Premiere Pro: 파일 > 가져오기에서 timeline.xml을 선택합니다.\n"
        "DaVinci Resolve: 타임라인 가져오기에서 timeline.xml을 선택합니다.\n"
        "XML은 작업 PC의 source.mp4 절대 경로를 참조합니다. 다른 폴더/PC로 옮겼다면 함께 든 source.mp4로 미디어를 다시 연결하세요.\n\n"
        "CapCut Desktop/Web: clips 폴더의 번호순 MP4를 가져와 빈 타임라인에 순서대로 놓고, 자막 가져오기에서 captions.srt를 선택합니다. "
        "클립 배치와 자막 스타일은 직접 확인하세요. 편집 가능한 CapCut 프로젝트를 자동 생성한 것은 아닙니다.\n\n"
        "captions.srt는 편집 후 시간 기준입니다. 세 편집기 모두 별도로 가져오고 서체/위치를 지정하세요. "
        "자막이 없는 제안이면 SRT도 비어 있습니다. preview.mp4는 컷 검토용이며 자막이 번인되지 않았습니다.\n\n"
        "실제 편집기에서의 가져오기는 아직 검증되지 않았습니다. 컷 경계·오디오·자막 싱크를 확인하세요.\n",
        encoding="utf-8")
    bundle = directory / "editstyle.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_STORED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path != bundle:
                archive.write(path, path.relative_to(directory))
    return bundle
