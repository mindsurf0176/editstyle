"""Original media stays untouched at direct cut, render, and preview boundaries."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

import cutai.editor.cutter as cutter
import cutai.preview as preview
from cutai.editor.renderer import render
from cutai.models.types import CutOperation, EditPlan, SubtitleOperation


@pytest.mark.parametrize("pipeline", ["cut", "render", "preview"])
@pytest.mark.parametrize("alias", ["same", "normalized", "symlink", "hardlink"])
@pytest.mark.parametrize("with_cuts", [False, True])
def test_original_source_alias_is_rejected_before_work(
    monkeypatch, tmp_path, sample_analysis, pipeline, alias, with_cuts,
):
    source = tmp_path / "source.mp4"
    original = b"original media must stay byte-identical"
    source.write_bytes(original)
    output = source
    if alias == "normalized":
        (tmp_path / "child").mkdir()
        output = tmp_path / "child" / ".." / "source.mp4"
    elif alias == "symlink":
        output = tmp_path / "symbolic.mp4"
        output.symlink_to(source)
    elif alias == "hardlink":
        output = tmp_path / "hard.mp4"
        output.hardlink_to(source)
    operations = [CutOperation(action="keep", start_time=1, end_time=9)] if with_cuts else []
    plan = EditPlan(instruction="edit", operations=operations)
    work = Mock(side_effect=AssertionError("Media work must not start"))
    monkeypatch.setattr(cutter, "_get_duration", work)
    monkeypatch.setattr(preview, "_downscale_video", work)
    with pytest.raises(ValueError, match="must not overwrite the source"):
        if pipeline == "cut":
            cutter.apply_cuts(str(source), operations, str(output))
        elif pipeline == "render":
            render(str(source), plan, sample_analysis, str(output))
        else:
            preview.render_preview(str(source), plan, sample_analysis, str(output))
    work.assert_not_called()
    assert source.read_bytes() == original
    assert output.read_bytes() == original


@pytest.mark.parametrize("operations,duration,error", [
    ([CutOperation(action="remove", start_time=0, end_time=35)], 35, "entire video"),
    ([CutOperation(action="keep", start_time=30, end_time=50)], 35, "Cut ranges"),
    ([], 0, "Source duration"),
    ([], float("inf"), "Source duration"),
])
def test_preview_rejects_invalid_plan_before_downscaling(
    monkeypatch, tmp_path, sample_analysis, operations, duration, error,
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"not needed until validation passes")
    output = tmp_path / "not-created" / "preview.mp4"
    plan = EditPlan(instruction="edit", operations=operations)
    analysis = sample_analysis.model_copy(update={"duration": duration})
    downscale = Mock(side_effect=AssertionError("Downscaling must not start"))
    monkeypatch.setattr(preview, "_downscale_video", downscale)
    with pytest.raises(ValueError, match=error):
        preview.render_preview(str(source), plan, analysis, str(output))
    downscale.assert_not_called()
    assert not output.parent.exists()


@pytest.mark.parametrize("alias", ["same", "symlink", "hardlink"])
@pytest.mark.parametrize("with_cuts", [False, True])
def test_subtitle_sidecar_alias_cannot_overwrite_source_before_any_processing(
    monkeypatch, tmp_path, sample_analysis, alias, with_cuts,
):
    source = tmp_path / ("edited.ass" if alias == "same" else "source.mp4")
    original = b"original source, regardless of filename extension"
    source.write_bytes(original)
    output = tmp_path / "edited.mp4"
    sidecar = output.with_suffix(".ass")
    if alias == "symlink":
        sidecar.symlink_to(source)
    elif alias == "hardlink":
        sidecar.hardlink_to(source)
    operations = [SubtitleOperation()]
    if with_cuts:
        operations.insert(0, CutOperation(action="keep", start_time=1, end_time=9))
    plan = EditPlan(instruction="sidecar", operations=operations)
    work = Mock(side_effect=AssertionError("Media work must not start"))
    monkeypatch.setattr(cutter, "_get_duration", work)
    monkeypatch.setattr("cutai.editor.subtitle.generate_ass", work)
    with pytest.raises(ValueError, match="must not overwrite the source"):
        render(str(source), plan, sample_analysis, str(output), burn_subtitles=False)
    work.assert_not_called()
    assert not output.exists()
    assert source.read_bytes() == sidecar.read_bytes() == original
