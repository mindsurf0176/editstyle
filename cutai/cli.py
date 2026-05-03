"""CutAI CLI — beautiful terminal interface using Typer + Rich.

Commands:
  cutai analyze <video>  — Analyze video (scenes, transcript, quality)
  cutai plan <video>     — Analyze + generate edit plan (no render)
  cutai edit <video>     — Full pipeline: analyze → plan → edit → render
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

# Suppress cv2/av dylib conflict warning on macOS.
# Both opencv-python-headless and PyAV bundle their own ffmpeg dylibs,
# causing ObjC class duplicate warnings. This is cosmetic — not a real crash risk.
# We suppress stderr during the conflicting imports to hide the warning.
if sys.platform == "darwin":
    try:
        _stderr_fd = os.dup(2)
        _devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(_devnull, 2)
        try:
            import av  # noqa: F401
            import cv2  # noqa: F401
        finally:
            os.dup2(_stderr_fd, 2)
            os.close(_stderr_fd)
            os.close(_devnull)
    except Exception:
        pass  # If import fails here, it'll be caught later with proper error handling

import typer
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

from cutai.models.types import SubtitleOperation


def _version_callback(value: bool) -> None:
    if value:
        from cutai import __version__
        print(f"cutai {__version__}")
        raise typer.Exit()

app = typer.Typer(
    name="cutai",
    help="🎬 CutAI — AI video editor with natural language instructions.",
    add_completion=False,
    rich_markup_mode="rich",
)
console = Console()
STYLE_LEARN_VIDEOS_ARG = typer.Argument(help="Videos to learn style from")
MULTI_VIDEOS_ARG = typer.Argument(help="Video files to combine")

@app.callback()
def main(
    version: bool = typer.Option(False, "--version", "-V", help="Show version and exit.", callback=_version_callback, is_eager=True),
) -> None:
    """🎬 CutAI — AI video editor with natural language instructions."""


def _setup_logging(verbose: bool) -> None:
    """Configure logging based on verbosity."""
    level = logging.DEBUG if verbose else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _validate_video(path: str) -> Path:
    """Validate that the video file exists."""
    p = Path(path)
    if not p.exists():
        console.print(f"[red]Error:[/red] Video file not found: {path}")
        raise typer.Exit(1)
    return p


def _handle_error(exc: Exception) -> None:
    """Handle exceptions with user-friendly Rich error panels."""
    import subprocess as _sp
    import traceback

    if isinstance(exc, FileNotFoundError):
        console.print(Panel(
            f"[red bold]File Not Found[/red bold]\n\n{exc}",
            style="red",
            title="❌ Error",
        ))
        raise typer.Exit(1)
    elif isinstance(exc, (_sp.CalledProcessError, _sp.TimeoutExpired)):
        detail = str(exc)
        if hasattr(exc, 'stderr') and exc.stderr:
            stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else str(exc.stderr)
            detail += f"\n\n[dim]stderr:[/dim] {stderr[:500]}"
        console.print(Panel(
            f"[red bold]FFmpeg / Subprocess Error[/red bold]\n\n{detail}",
            style="red",
            title="❌ Error",
        ))
        raise typer.Exit(1)
    elif isinstance(exc, RuntimeError):
        console.print(Panel(
            f"[red bold]Runtime Error[/red bold]\n\n{exc}",
            style="red",
            title="❌ Error",
        ))
        raise typer.Exit(1)
    elif isinstance(exc, ValueError):
        console.print(Panel(
            f"[red bold]Invalid Input[/red bold]\n\n{exc}",
            style="red",
            title="❌ Error",
        ))
        raise typer.Exit(1)
    else:
        tb = traceback.format_exc()
        console.print(Panel(
            f"[red bold]Unexpected Error[/red bold]\n\n{exc}\n\n"
            f"[dim]{tb}[/dim]\n\n"
            "[yellow]Please report this bug at https://github.com/mindsurf0176-ui/cutai/issues[/yellow]",
            style="red",
            title="🐛 Bug",
        ))
        raise typer.Exit(1)


@app.command()
def analyze(
    video: str = typer.Argument(help="Path to the video file"),
    output: str | None = typer.Option(None, "--output", "-o", help="Save analysis JSON to file"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size (tiny/base/small/medium/large)"),
    skip_transcription: bool = typer.Option(False, "--no-transcript", help="Skip Whisper transcription"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Analyze a video file — detect scenes, transcribe audio, check quality."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    try:
        console.print(
            Panel(f"🎬 Analyzing [bold]{video_path.name}[/bold]", style="blue")
        )

        from cutai.analyzer import analyze_video

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
                skip_transcription=skip_transcription,
            )
            progress.update(task, completed=True)

        # Display results
        _display_analysis(analysis)

        # Save to file if requested
        if output:
            out_path = Path(output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w") as f:
                json.dump(analysis.model_dump(), f, indent=2, ensure_ascii=False)
            console.print(f"\n📄 Analysis saved to [bold]{output}[/bold]")
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def plan(
    video: str = typer.Argument(help="Path to the video file"),
    instruction: str = typer.Option(..., "--instruction", "-i", help="Natural language editing instruction"),
    output: str | None = typer.Option(None, "--output", "-o", help="Save edit plan JSON to file"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use local rule-based planning (no API key needed)"),
    skip_transcription: bool = typer.Option(False, "--no-transcript", help="Skip Whisper transcription"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Analyze a video and generate an edit plan (without rendering)."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    try:
        console.print(
            Panel(
                f"🎬 Planning edit for [bold]{video_path.name}[/bold]\n"
                f"📝 Instruction: [italic]{instruction}[/italic]",
                style="blue",
            )
        )

        from cutai.analyzer import analyze_video
        from cutai.planner import create_edit_plan

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            t1 = progress.add_task("Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
                skip_transcription=skip_transcription,
            )
            progress.update(t1, completed=True)

            t2 = progress.add_task("Generating edit plan...", total=None)
            edit_plan = create_edit_plan(
                analysis,
                instruction,
                llm_model=llm,
                use_llm=not no_llm,
            )
            progress.update(t2, completed=True)

        _display_analysis(analysis)
        _display_plan(edit_plan)

        if output:
            out_path = Path(output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w") as f:
                json.dump(edit_plan.model_dump(), f, indent=2, ensure_ascii=False)
            console.print(f"\n📄 Edit plan saved to [bold]{output}[/bold]")
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def edit(
    video: str = typer.Argument(help="Path to the video file"),
    instruction: str = typer.Option("", "--instruction", "-i", help="Natural language editing instruction"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output video file path"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use local rule-based planning (no API key needed)"),
    skip_transcription: bool = typer.Option(False, "--no-transcript", help="Skip Whisper transcription"),
    burn_subtitles: bool = typer.Option(True, "--burn-subtitles/--sidecar-subtitles", help="Burn subtitles into video by default. Use --sidecar-subtitles to save a .ass sidecar instead"),
    style: str | None = typer.Option(None, "--style", "-s", help="Edit DNA style file (.yaml) to apply instead of instruction-based planning"),
    editstyle: str | None = typer.Option(None, "--editstyle", help="EDITSTYLE.md file to use (auto-detected if not specified)"),
    narrate: bool = typer.Option(False, "--narrate", help="Add AI voiceover narration to the output"),
    narrate_tone: str = typer.Option("documentary", "--narrate-tone", help="Narration tone preset"),
    narrate_lang: str = typer.Option("English", "--narrate-lang", help="Narration language"),
    narrate_audio_mode: str = typer.Option("voiceover", "--narrate-audio-mode", help="Narration audio mode: voiceover or replace"),
    narrate_voice: str | None = typer.Option(None, "--narrate-voice", help="Edge TTS voice name"),
    narrate_vision: bool = typer.Option(False, "--narrate-vision", help="Use vision AI to understand video frames for better narration"),
    narrate_vision_model: str | None = typer.Option(None, "--narrate-vision-model", help="Vision model for scene analysis (default: gemma4:31b-cloud)"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Full pipeline: analyze → plan → edit → render.

    Examples:
        cutai edit video.mp4 -i "remove silence and add subtitles"
        cutai edit video.mp4 --style vlog-casual.yaml
        cutai edit video.mp4 --editstyle EDITSTYLE.md
    """
    _setup_logging(verbose)
    video_path = _validate_video(video)

    # EDITSTYLE.md auto-detection (if no --style and no --editstyle given)
    if not style and not editstyle:
        editstyle = _detect_editstyle(video_path)

    # If editstyle found, parse it and use as style
    if editstyle:
        try:
            from cutai.style.editstyle_parser import parse_editstyle
            es_result = parse_editstyle(editstyle)
            console.print(
                f"📝 EDITSTYLE.md detected: [bold]{es_result.dna.name}[/bold]. Applying style..."
            )
            # We'll use this below in the planning step
            style = editstyle  # marker so the style branch is taken
        except Exception as es_err:
            console.print(f"[yellow]Warning:[/yellow] Failed to parse EDITSTYLE.md: {es_err}")
            editstyle = None

    if not instruction and not style and not editstyle:
        console.print("[red]Error:[/red] Provide --instruction, --style, or --editstyle (or place an EDITSTYLE.md in your project).")
        raise typer.Exit(1)

    # Default output path
    if not output:
        stem = video_path.stem
        output = str(video_path.parent / f"{stem}_edited.mp4")

    try:
        desc = f"🎬 Editing [bold]{video_path.name}[/bold]\n"
        if style:
            desc += f"🧬 Style: [italic]{style}[/italic]\n"
        if instruction:
            desc += f"📝 Instruction: [italic]{instruction}[/italic]\n"
        desc += f"📁 Output: [dim]{output}[/dim]"

        console.print(Panel(desc, style="blue"))

        from cutai.analyzer import analyze_video
        from cutai.editor.renderer import render

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            # Step 1: Analyze
            t1 = progress.add_task("Step 1/3: Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
                skip_transcription=skip_transcription,
            )
            progress.update(t1, completed=True)

            # Step 2: Plan (style-based or instruction-based)
            t2 = progress.add_task("Step 2/3: Generating edit plan...", total=None)
            if editstyle:
                from cutai.style import apply_style
                from cutai.style.editstyle_parser import parse_editstyle

                es_result = parse_editstyle(editstyle)
                # Combine instruction with patterns and rules from EDITSTYLE.md
                combined_instruction = instruction
                if es_result.patterns:
                    combined_instruction += "\n[Patterns] " + "; ".join(es_result.patterns)
                if es_result.rules:
                    combined_instruction += "\n[Rules] " + "; ".join(es_result.rules)
                edit_plan = apply_style(analysis, es_result.dna, instruction=combined_instruction)
            elif style:
                from cutai.style import apply_style, load_style

                style_dna = load_style(style)
                edit_plan = apply_style(analysis, style_dna, instruction=instruction)
            else:
                from cutai.planner import create_edit_plan

                edit_plan = create_edit_plan(
                    analysis,
                    instruction,
                    llm_model=llm,
                    use_llm=not no_llm,
                )
            progress.update(t2, completed=True)

            # Step 3: Render
            t3 = progress.add_task("Step 3/3: Rendering video...", total=None)
            result = render(str(video_path), edit_plan, analysis, output, burn_subtitles=burn_subtitles)
            progress.update(t3, completed=True)

        _display_analysis(analysis)
        _display_plan(edit_plan)

        # Step 4: Add narration if requested
        if narrate:
            from cutai.narrator import generate_narration as gen_narr

            console.print(Panel("🎙️ Adding AI narration...", style="cyan"))
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                t4 = progress.add_task("Generating narration...", total=None)
                narr_result = gen_narr(
                    video_path=str(video_path),
                    analysis=analysis,
                    tone=narrate_tone,
                    language=narrate_lang,
                    voice=narrate_voice,
                    audio_mode=narrate_audio_mode,
                    output_path=output,
                    llm_model=llm,
                    use_llm=not no_llm,
                    use_vision=narrate_vision,
                    vision_model=narrate_vision_model,
                )
                progress.update(t4, completed=True)

            console.print(
                f"  🎙️ {narr_result['narrations_count']} segments narrated"
            )
            result = narr_result["output_path"]

        # Build success message
        success_lines = [
            "✅ [bold green]Done![/bold green]",
            f"📁 Output: [bold]{result}[/bold]",
        ]
        ass_path = Path(output).with_suffix(".ass")
        has_subtitle_op = any(
            isinstance(op, SubtitleOperation) for op in edit_plan.operations
        )
        if has_subtitle_op and not burn_subtitles and ass_path.exists():
            success_lines.append(f"📝 Subtitles: {ass_path}")

        console.print()
        console.print(
            Panel(
                "\n".join(success_lines),
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


# ── Style commands ───────────────────────────────────────────────────────────


@app.command()
def engagement(
    video: str = typer.Argument(help="Path to the video file"),
    output: str | None = typer.Option(None, "--output", "-o", help="Save engagement report as JSON"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Analyze scene engagement scores for a video."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    try:
        console.print(
            Panel(f"📊 Analyzing engagement for [bold]{video_path.name}[/bold]", style="blue")
        )

        from cutai.analyzer import analyze_with_engagement

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Analyzing engagement...", total=None)
            analysis, report = analyze_with_engagement(
                str(video_path), whisper_model=model,
            )
            progress.update(task, completed=True)

        _display_engagement(analysis, report)

        if output:
            out_path = Path(output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with open(out_path, "w") as f:
                json.dump(report.model_dump(), f, indent=2, ensure_ascii=False)
            console.print(f"\n📄 Report saved to [bold]{output}[/bold]")
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def highlights(
    video: str = typer.Argument(help="Path to the video file"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output video path"),
    duration: float | None = typer.Option(None, "--duration", "-d", help="Target duration in seconds"),
    ratio: float = typer.Option(0.2, "--ratio", help="Fraction of video to keep (0.0-1.0)"),
    style: str = typer.Option("best-moments", "--style", "-s", help="Highlight style: best-moments, narrative, shorts"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model"),
    no_render: bool = typer.Option(False, "--no-render", help="Only show plan, don't render"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Generate a highlight reel from the most engaging moments."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    if not output:
        stem = video_path.stem
        output = str(video_path.parent / f"{stem}_highlights.mp4")

    try:
        console.print(
            Panel(
                f"🎬 Generating [bold]{style}[/bold] highlights for [bold]{video_path.name}[/bold]\n"
                f"📁 Output: [dim]{output}[/dim]",
                style="blue",
            )
        )

        from cutai.analyzer import analyze_with_engagement
        from cutai.highlight import auto_highlight_duration
        from cutai.highlight import generate_highlights as gen_hl

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            t1 = progress.add_task("Step 1/3: Analyzing video + engagement...", total=None)
            analysis, report = analyze_with_engagement(
                str(video_path), whisper_model=model,
            )
            progress.update(t1, completed=True)

            # Determine target duration
            target = duration
            if target is None and ratio < 1.0:
                target = analysis.duration * ratio
            if target is None:
                target = auto_highlight_duration(analysis.duration)

            t2 = progress.add_task("Step 2/3: Selecting highlights...", total=None)
            edit_plan = gen_hl(
                str(video_path),
                analysis,
                report,
                target_duration=target,
                target_ratio=ratio,
                style=style,
            )
            progress.update(t2, completed=True)

        _display_engagement(analysis, report)
        _display_plan(edit_plan)

        if no_render:
            console.print("\n[yellow]--no-render: skipping render step[/yellow]")
        else:
            from cutai.editor.renderer import render

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                t3 = progress.add_task("Step 3/3: Rendering highlights...", total=None)
                result = render(str(video_path), edit_plan, analysis, output)
                progress.update(t3, completed=True)

            console.print()
            console.print(
                Panel(
                    f"✅ [bold green]Highlights ready![/bold green]\n📁 Output: [bold]{result}[/bold]",
                    style="green",
                )
            )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def style_extract(
    video: str = typer.Argument(help="Video to extract style from"),
    output: str = typer.Option("style.yaml", "--output", "-o", help="Output YAML path"),
    name: str = typer.Option("", "--name", "-n", help="Style name"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Extract editing style (Edit DNA) from a reference video."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    try:
        console.print(
            Panel(f"🧬 Extracting style from [bold]{video_path.name}[/bold]", style="blue")
        )

        from cutai.style import extract_style, save_style

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Extracting Edit DNA...", total=None)
            dna = extract_style(str(video_path), whisper_model=model)
            if name:
                dna.name = name
            progress.update(task, completed=True)

        save_path = save_style(dna, output)

        _display_dna(dna)

        console.print()
        console.print(
            Panel(
                f"✅ [bold green]Style extracted![/bold green]\n📄 Saved to [bold]{save_path}[/bold]",
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def style_apply(
    video: str = typer.Argument(help="Video to apply style to"),
    style_file: str = typer.Option(..., "--style", "-s", help="Style YAML file"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output video path"),
    instruction: str = typer.Option("", "--instruction", "-i", help="Additional instruction"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    burn_subtitles: bool = typer.Option(True, "--burn-subtitles/--sidecar-subtitles", help="Burn subtitles into video by default. Use --sidecar-subtitles to save a .ass sidecar instead"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Apply an Edit DNA style to a video."""
    _setup_logging(verbose)
    video_path = _validate_video(video)

    if not output:
        stem = video_path.stem
        output = str(video_path.parent / f"{stem}_styled.mp4")

    try:
        console.print(
            Panel(
                f"🎬 Applying style to [bold]{video_path.name}[/bold]\n"
                f"🧬 Style: [italic]{style_file}[/italic]\n"
                f"📁 Output: [dim]{output}[/dim]",
                style="blue",
            )
        )

        from cutai.analyzer import analyze_video
        from cutai.editor.renderer import render
        from cutai.style import apply_style, load_style

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            t1 = progress.add_task("Step 1/3: Analyzing video...", total=None)
            analysis = analyze_video(str(video_path), whisper_model=model)
            progress.update(t1, completed=True)

            t2 = progress.add_task("Step 2/3: Applying style...", total=None)
            style_dna = load_style(style_file)
            edit_plan = apply_style(analysis, style_dna, instruction=instruction)
            progress.update(t2, completed=True)

            t3 = progress.add_task("Step 3/3: Rendering video...", total=None)
            result = render(str(video_path), edit_plan, analysis, output, burn_subtitles=burn_subtitles)
            progress.update(t3, completed=True)

        _display_analysis(analysis)
        _display_plan(edit_plan)

        console.print()
        console.print(
            Panel(
                f"✅ [bold green]Done![/bold green]\n📁 Output: [bold]{result}[/bold]",
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def style_learn(
    videos: list[str] = STYLE_LEARN_VIDEOS_ARG,
    output: str = typer.Option("learned_style.yaml", "--output", "-o", help="Output YAML path"),
    name: str = typer.Option("learned", "--name", "-n", help="Style name"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Learn editing style from multiple reference videos."""
    _setup_logging(verbose)

    # Validate all video paths
    for v in videos:
        _validate_video(v)

    try:
        console.print(
            Panel(
                f"🧬 Learning style from [bold]{len(videos)}[/bold] video(s)",
                style="blue",
            )
        )

        from cutai.style import learn_style, save_style

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Learning Edit DNA...", total=None)
            dna = learn_style(videos, name=name, whisper_model=model)
            progress.update(task, completed=True)

        save_path = save_style(dna, output)

        _display_dna(dna)

        console.print()
        console.print(
            Panel(
                f"✅ [bold green]Style learned![/bold green]\n📄 Saved to [bold]{save_path}[/bold]",
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def chat(
    video: str = typer.Argument(help="Path to the video file"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use local rule-based planning (no API key needed)"),
    output: str | None = typer.Option(None, "--output", "-o", help="Default output path for /render"),
    skip_transcription: bool = typer.Option(False, "--no-transcript", help="Skip Whisper transcription"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Interactive chat-based video editing session.

    Launch an interactive REPL where you can iteratively refine edits
    through natural language. Supports undo, preview, and style loading.

    Examples:
        cutai chat video.mp4
        cutai chat video.mp4 --no-llm
        cutai chat video.mp4 -o output.mp4
    """
    _setup_logging(verbose)
    video_path = _validate_video(video)

    try:
        from cutai.analyzer import analyze_video
        from cutai.chat import ChatSession

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
                skip_transcription=skip_transcription,
            )
            progress.update(task, completed=True)

        session = ChatSession(
            video_path=str(video_path),
            analysis=analysis,
            whisper_model=model,
            llm_model=llm,
            use_llm=not no_llm,
            default_output=output,
        )
        session.run()
    except (SystemExit, KeyboardInterrupt):
        pass
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def preview(
    video: str = typer.Argument(help="Path to the video file"),
    instruction: str = typer.Option("", "--instruction", "-i", help="Natural language editing instruction"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output preview path"),
    resolution: int = typer.Option(360, "--resolution", "-r", help="Preview resolution (height in px)"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use local rule-based planning (no API key needed)"),
    style: str | None = typer.Option(None, "--style", "-s", help="Edit DNA style file (.yaml)"),
    skip_transcription: bool = typer.Option(False, "--no-transcript", help="Skip Whisper transcription"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Generate a quick low-resolution preview of an edit.

    Downscales the source video first, then applies the edit plan.
    Much faster than full rendering — great for iterating on edits.

    Examples:
        cutai preview video.mp4 -i "remove silence"
        cutai preview video.mp4 -i "시네마틱하게" -r 480
        cutai preview video.mp4 -i "trim to 3 minutes" --style vlog.yaml
    """
    _setup_logging(verbose)
    video_path = _validate_video(video)

    if not instruction and not style:
        console.print("[red]Error:[/red] Provide --instruction or --style (or both).")
        raise typer.Exit(1)

    try:
        desc = f"🎬 Preview for [bold]{video_path.name}[/bold] ({resolution}p)\n"
        if style:
            desc += f"🧬 Style: [italic]{style}[/italic]\n"
        if instruction:
            desc += f"📝 Instruction: [italic]{instruction}[/italic]"

        console.print(Panel(desc.rstrip(), style="blue"))

        from cutai.analyzer import analyze_video
        from cutai.preview import render_preview

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            # Step 1: Analyze
            t1 = progress.add_task("Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
                skip_transcription=skip_transcription,
            )
            progress.update(t1, completed=True)

            # Step 2: Plan
            t2 = progress.add_task("Generating edit plan...", total=None)
            if style:
                from cutai.style import apply_style, load_style

                style_dna = load_style(style)
                edit_plan = apply_style(analysis, style_dna, instruction=instruction)
            else:
                from cutai.planner import create_edit_plan

                edit_plan = create_edit_plan(
                    analysis,
                    instruction,
                    llm_model=llm,
                    use_llm=not no_llm,
                )
            progress.update(t2, completed=True)

            # Step 3: Render preview
            t3 = progress.add_task(f"Rendering preview ({resolution}p)...", total=None)
            result = render_preview(
                str(video_path),
                edit_plan,
                analysis,
                output_path=output,
                resolution=resolution,
            )
            progress.update(t3, completed=True)

        _display_plan(edit_plan)

        console.print()
        console.print(
            Panel(
                f"✅ [bold green]Preview ready![/bold green]\n📁 Output: [bold]{result}[/bold]",
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def multi(
    videos: list[str] = MULTI_VIDEOS_ARG,
    instruction: str = typer.Option("", "--instruction", "-i", help="Editing instruction"),
    output: str = typer.Option("combined_output.mp4", "--output", "-o", help="Output video path"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use local rule-based planning (no API key needed)"),
    style: str | None = typer.Option(None, "--style", "-s", help="Edit DNA style file (.yaml)"),
    burn_subtitles: bool = typer.Option(True, "--burn-subtitles/--sidecar-subtitles", help="Burn subtitles into video by default. Use --sidecar-subtitles to save a .ass sidecar instead"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Combine and edit multiple video files into one.

    Examples:
        cutai multi clip1.mp4 clip2.mp4 clip3.mp4
        cutai multi clip1.mp4 clip2.mp4 -i "remove silence and add subtitles"
        cutai multi *.mp4 --style vlog.yaml -o final.mp4
    """
    _setup_logging(verbose)

    if len(videos) < 2:
        console.print("[red]Error:[/red] At least 2 video files are required.")
        raise typer.Exit(1)

    for v in videos:
        _validate_video(v)

    try:
        desc = f"🎬 Multi-edit: combining [bold]{len(videos)}[/bold] videos\n"
        if instruction:
            desc += f"📝 Instruction: [italic]{instruction}[/italic]\n"
        if style:
            desc += f"🧬 Style: [italic]{style}[/italic]\n"
        desc += f"📁 Output: [dim]{output}[/dim]"

        console.print(Panel(desc, style="blue"))

        from cutai.multi import multi_edit

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Processing multi-video edit...", total=None)
            result = multi_edit(
                video_paths=videos,
                instruction=instruction,
                output_path=output,
                whisper_model=model,
                llm_model=llm,
                use_llm=not no_llm,
                style=style,
                burn_subtitles=burn_subtitles,
            )
            progress.update(task, completed=True)

        console.print()
        console.print(
            Panel(
                f"✅ [bold green]Done![/bold green]\n📁 Output: [bold]{result}[/bold]",
                style="green",
            )
        )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def prefs(
    reset: bool = typer.Option(False, "--reset", help="Reset all learned preferences"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Show or reset learned editing preferences.

    CutAI learns from your editing patterns over time.
    Use --reset to clear all learned preferences.
    """
    _setup_logging(verbose)

    try:
        from cutai.learning import (
            UserPreferences,
            load_preferences,
            save_preferences,
            suggest_defaults,
        )

        if reset:
            new_prefs = UserPreferences()
            save_preferences(new_prefs)
            console.print("[green]✅ Preferences reset to defaults.[/green]")
            return

        prefs_data = load_preferences()
        defaults = suggest_defaults(prefs_data)

        # Display preferences
        prefs_table = Table(
            title="🧠 Learned Editing Preferences",
            show_header=True,
            header_style="bold cyan",
        )
        prefs_table.add_column("Property", style="dim")
        prefs_table.add_column("Value")

        prefs_table.add_row("Preferred style", prefs_data.preferred_style or "(none)")
        prefs_table.add_row("Subtitle position", prefs_data.preferred_subtitle_position)
        prefs_table.add_row("Color preset", prefs_data.preferred_color_preset or "(none)")
        prefs_table.add_row("BGM mood", prefs_data.preferred_bgm_mood or "(none)")
        prefs_table.add_row("Avg keep ratio", f"{prefs_data.avg_keep_ratio:.0%}")
        prefs_table.add_row("Instruction history", f"{len(prefs_data.instruction_history)} entries")
        prefs_table.add_row("Feedback entries", f"{len(prefs_data.feedback_history)} entries")

        console.print()
        console.print(prefs_table)

        if defaults:
            defaults_table = Table(
                title="💡 Suggested Defaults",
                show_header=True,
                header_style="bold",
            )
            defaults_table.add_column("Parameter", style="dim")
            defaults_table.add_column("Value")
            for k, v in defaults.items():
                defaults_table.add_row(k, str(v))
            console.print(defaults_table)

        if not prefs_data.instruction_history:
            console.print(
                "\n[dim]No editing history yet. Start editing to build preferences![/dim]"
            )
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def server(
    port: int = typer.Option(18910, "--port", "-p", help="Server port"),
    host: str = typer.Option("127.0.0.1", "--host", help="Server host"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Start the CutAI API server for desktop app integration."""
    _setup_logging(verbose)
    try:
        import uvicorn

        from cutai.server import app as api_app

        console.print(
            Panel(
                f"🚀 Starting CutAI API server\n"
                f"🌐 http://{host}:{port}\n"
                f"📖 Docs: http://{host}:{port}/docs",
                style="green",
                title="CutAI Server",
            )
        )
        uvicorn.run(api_app, host=host, port=port, log_level="debug" if verbose else "info")
    except ImportError as exc:
        console.print(
            f"[red]Error:[/red] Missing server dependency: {exc}\n"
            "Install with: pip install 'cutai[server]' or pip install fastapi uvicorn python-multipart"
        )
        raise typer.Exit(1) from exc


@app.command()
def style_show(
    style_file: str = typer.Argument(help="Style YAML file to display"),
) -> None:
    """Display an Edit DNA style file."""
    try:
        from cutai.style import load_style

        dna = load_style(style_file)
        _display_dna(dna)
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def style_convert(
    file: str = typer.Argument(help="Input file (.yaml or .md) to convert"),
    to: str = typer.Option(..., "--to", help="Target format: 'md' or 'yaml'"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output file path"),
) -> None:
    """Convert between EDITSTYLE.md and YAML preset formats.

    Examples:
        cutai style-convert cinematic.yaml --to md
        cutai style-convert EDITSTYLE.md --to yaml -o style.yaml
    """
    try:
        from cutai.style.editstyle_converter import editstyle_to_yaml, yaml_to_editstyle

        file_path = Path(file)
        if not file_path.exists():
            console.print(f"[red]Error:[/red] File not found: {file}")
            raise typer.Exit(1)

        target = to.lower().strip()
        if target == "md":
            result_text = yaml_to_editstyle(file)
            out_path = output or str(file_path.with_suffix(".md"))
            ext_label = "EDITSTYLE.md"
        elif target in ("yaml", "yml"):
            result_text = editstyle_to_yaml(file)
            out_path = output or str(file_path.with_suffix(".yaml"))
            ext_label = "YAML"
        else:
            console.print(f"[red]Error:[/red] --to must be 'md' or 'yaml', got '{to}'")
            raise typer.Exit(1)

        Path(out_path).write_text(result_text, encoding="utf-8")
        console.print(f"✅ Converted to {ext_label}: [bold]{out_path}[/bold]")
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


@app.command()
def style_validate(
    file: str = typer.Argument(help="EDITSTYLE.md file to validate"),
) -> None:
    """Validate an EDITSTYLE.md file and display its parsed content.

    Examples:
        cutai style-validate EDITSTYLE.md
    """
    try:
        from cutai.style.editstyle_parser import parse_editstyle

        file_path = Path(file)
        if not file_path.exists():
            console.print(f"[red]Error:[/red] File not found: {file}")
            raise typer.Exit(1)

        result = parse_editstyle(file)
        console.print(f"✅ [bold green]Valid EDITSTYLE.md[/bold green]: {result.dna.name}")
        _display_dna(result.dna)

        if result.patterns:
            console.print()
            console.print(Panel(
                "\n".join(f"• {p}" for p in result.patterns),
                title="📐 Patterns",
                style="cyan",
            ))
        if result.rules:
            console.print()
            console.print(Panel(
                "\n".join(f"• {r}" for r in result.rules),
                title="📏 Rules",
                style="yellow",
            ))
    except ValueError as ve:
        console.print(f"[red]Validation failed:[/red] {ve}")
        raise typer.Exit(1)
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


# ── Agent Mode ───────────────────────────────────────────────────────────────


@app.command()
def agent(
    inputs: list[str] = typer.Argument(help="Input video file(s)"),
    goal: str = typer.Option(..., "--goal", "-g", help="High-level editing goal"),
    output: str = typer.Option("agent_output.mp4", "--output", "-o", help="Output file path"),
    iterations: int = typer.Option(3, "--iterations", "-n", help="Max edit-evaluate iterations"),
    min_score: float = typer.Option(80.0, "--min-score", help="Stop when score reaches this threshold"),
    editstyle: str | None = typer.Option(None, "--editstyle", help="Path to EDITSTYLE.md"),
    style: str | None = typer.Option(None, "--style", "-s", help="Path to EditDNA YAML"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("gpt-4o", "--llm", help="LLM model for planning"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use rule-based planning only"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """🤖 Goal-driven autonomous video editing agent.

    Analyzes → plans → renders → self-evaluates → iterates until the goal is met.

    Examples:
        cutai agent video.mp4 --goal "15분짜리 카페 브이로그, 따뜻하고 캐주얼하게"
        cutai agent clip1.mp4 clip2.mp4 --goal "best moments reel, 3 minutes" -n 5
        cutai agent footage/ --goal "cinematic travel video" --editstyle EDITSTYLE.md
    """
    _setup_logging(verbose)

    # Expand directories to video files
    expanded: list[str] = []
    for inp in inputs:
        p = Path(inp)
        if p.is_dir():
            expanded.extend(
                str(f) for f in sorted(p.glob("*"))
                if f.suffix.lower() in {".mp4", ".mov", ".avi", ".mkv", ".webm"}
            )
        elif p.exists():
            expanded.append(str(p))
        else:
            console.print(f"[red]Error:[/red] File not found: {inp}")
            raise typer.Exit(1)

    if not expanded:
        console.print("[red]Error:[/red] No video files found.")
        raise typer.Exit(1)

    console.print(Panel(
        f"🤖 [bold]Agent Mode[/bold]\n"
        f"🎯 Goal: [italic]{goal}[/italic]\n"
        f"📁 Inputs: {len(expanded)} video(s)\n"
        f"🔄 Max iterations: {iterations}\n"
        f"📊 Target score: {min_score}\n"
        f"📁 Output: [dim]{output}[/dim]",
        style="magenta",
    ))

    try:
        from cutai.agent.engine import AgentEngine
        from rich.progress import Progress, SpinnerColumn, TextColumn

        engine = AgentEngine(
            inputs=expanded,
            goal=goal,
            output=output,
            max_iterations=iterations,
            min_score=min_score,
            editstyle=editstyle,
            style=style,
            whisper_model=model,
            llm_model=llm,
            use_llm=not no_llm,
            verbose=verbose,
        )

        current_task = [None]

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            def on_progress(step: str, detail: str) -> None:
                if current_task[0] is not None:
                    progress.update(current_task[0], completed=True)
                current_task[0] = progress.add_task(detail, total=None)

            result = engine.run(on_progress=on_progress)
            if current_task[0] is not None:
                progress.update(current_task[0], completed=True)

        # Display results
        console.print()
        for it in result.iterations:
            ev = it.evaluation
            score_str = f"{ev.score:.0f}/100" if ev else "N/A"
            status = "✅" if ev and ev.meets_goal else "🔄"
            console.print(f"  {status} Iteration {it.iteration}: score {score_str}")
            if ev and ev.strengths:
                for s in ev.strengths:
                    console.print(f"      [green]+ {s}[/green]")
            if ev and ev.weaknesses:
                for w in ev.weaknesses:
                    console.print(f"      [red]- {w}[/red]")

        console.print()
        console.print(Panel(
            f"✅ [bold green]Agent Complete[/bold green]\n"
            f"📁 Output: [bold]{result.final_output}[/bold]\n"
            f"📊 Final score: {result.final_score:.0f}/100\n"
            f"🔄 Iterations: {result.total_iterations}",
            style="green",
        ))
    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


# ── AI Narration ────────────────────────────────────────────────────────────────


@app.command()
def narrate(
    video: str = typer.Argument(help="Path to the video file"),
    tone: str = typer.Option("documentary", "--tone", "-t", help="Narration tone: documentary, calm, excited, sad, happy, serious, funny, teacher, or custom"),
    language: str = typer.Option("English", "--language", "-l", help="Language for narration"),
    voice: str | None = typer.Option(None, "--voice", help="Edge TTS voice name (auto-selects based on language)"),
    audio_mode: str = typer.Option("voiceover", "--audio-mode", help="Audio mode: voiceover (mix) or replace"),
    custom_prompt: str | None = typer.Option(None, "--custom-prompt", help="Custom tone/style instruction for narration"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output video path"),
    model: str = typer.Option("base", "--model", "-m", help="Whisper model size"),
    llm: str = typer.Option("auto", "--llm", help="LLM model for script generation"),
    no_llm: bool = typer.Option(False, "--no-llm", help="Use transcript directly as narration (no LLM)"),
    vision: bool = typer.Option(False, "--vision", help="Use vision AI to analyze video frames for context-aware narration"),
    vision_model: str | None = typer.Option(None, "--vision-model", help="Vision model for scene analysis (default: gemma4:31b-cloud)"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """Generate AI voiceover narration for a video.

    Analyzes scenes, generates context-aware narration text using LLM,
    converts to natural speech via Edge TTS (free), and mixes onto the video.

    Examples:
        cutai narrate video.mp4
        cutai narrate video.mp4 --tone documentary
        cutai narrate video.mp4 --tone "excited sports commentator"
        cutai narrate video.mp4 --audio-mode replace --tone calm
        cutai narrate video.mp4 --language Japanese --tone documentary
        cutai narrate video.mp4 --no-llm
    """
    _setup_logging(verbose)
    video_path = _validate_video(video)

    if not output:
        stem = video_path.stem
        output = str(video_path.parent / f"{stem}_narrated.mp4")

    try:
        desc = (
            f"🎙️ Narrating [bold]{video_path.name}[/bold]\n"
            f"Tone: [italic]{tone}[/italic]\n"
            f"Language: {language}\n"
            f"Audio: [italic]{audio_mode}[/italic]\n"
            f"Vision: {'enabled' if vision else 'disabled'}\n"
            f"📁 Output: [dim]{output}[/dim]"
        )

        console.print(Panel(desc, style="blue"))

        from cutai.analyzer import analyze_video
        from cutai.narrator import generate_narration as gen_narr

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            t1 = progress.add_task("Step 1/3: Analyzing video...", total=None)
            analysis = analyze_video(
                str(video_path),
                whisper_model=model,
            )
            progress.update(t1, completed=True)

            t2 = progress.add_task("Step 2/3: Generating narration + speech...", total=None)
            result = gen_narr(
                video_path=str(video_path),
                analysis=analysis,
                tone=tone,
                language=language,
                custom_prompt=custom_prompt,
                voice=voice,
                audio_mode=audio_mode,
                output_path=output,
                llm_model=llm,
                use_llm=not no_llm,
                use_vision=vision,
                vision_model=vision_model,
            )
            progress.update(t2, completed=True)

        console.print()
        console.print(Panel(
            f"✅ [bold green]Narration complete![/bold green]\n"
            f"📁 Output: [bold]{result['output_path']}[/bold]\n"
            f"🎙️ Segments narrated: {result['narrations_count']}",
            style="green",
        ))

    except typer.Exit:
        raise
    except Exception as exc:
        _handle_error(exc)


# ── MCP Server ───────────────────────────────────────────────────────────────


@app.command()
def mcp_server(
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable debug logging"),
) -> None:
    """🔌 Start CutAI MCP Server for AI coding agent integration.

    Exposes CutAI tools via the Model Context Protocol (stdio transport).
    Connect from Claude Code, Cursor, or any MCP-compatible client.

    MCP config example:
        {
          "mcpServers": {
            "cutai": {
              "command": "cutai",
              "args": ["mcp-server"]
            }
          }
        }
    """
    _setup_logging(verbose)
    from cutai.mcp_server import run_stdio_server
    run_stdio_server()


# ── EDITSTYLE.md auto-detection ──────────────────────────────────────────────


def _detect_editstyle(video_path: Path) -> str | None:
    """Auto-detect EDITSTYLE.md in standard locations.

    Search order:
        1. Current working directory
        2. Next to the input video file
        3. ~/.config/cutai/default-editstyle.md
    """
    candidates = [
        Path.cwd() / "EDITSTYLE.md",
        video_path.parent / "EDITSTYLE.md",
        Path.home() / ".config" / "cutai" / "default-editstyle.md",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


# ── Display helpers ──────────────────────────────────────────────────────────


def _display_engagement(analysis, report) -> None:
    """Display engagement scores as a rich table with colored bars."""

    console.print()
    console.print(Panel(
        f"📊 [bold]Engagement Analysis[/bold]\n"
        f"Average score: {report.avg_score:.1f} | "
        f"🟢 High: {report.high_count} | "
        f"🔴 Low: {report.low_count}",
        style="cyan",
        title="Engagement Report",
    ))

    if not report.scenes:
        return

    table = Table(
        title="🎯 Scene Engagement Scores",
        show_header=True,
        header_style="bold",
    )
    table.add_column("#", style="dim", width=4)
    table.add_column("Time", width=14)
    table.add_column("Score", width=6, justify="right")
    table.add_column("Tier", width=6)
    table.add_column("Bar", width=22)
    table.add_column("Breakdown", width=36)

    for se in report.scenes:
        # Find matching scene for time info
        scene = None
        for s in analysis.scenes:
            if s.id == se.scene_id:
                scene = s
                break

        time_str = ""
        if scene:
            time_str = f"{scene.start_time:.1f}–{scene.end_time:.1f}s"

        # Tier emoji + color
        if se.label == "high":
            tier = "🟢"
            bar_style = "green"
        elif se.label == "low":
            tier = "🔴"
            bar_style = "red"
        else:
            tier = "🟡"
            bar_style = "yellow"

        # Visual bar (20 chars max)
        filled = int(se.score / 5.0)  # 0-20
        bar = f"[{bar_style}]{'█' * filled}{'░' * (20 - filled)}[/{bar_style}]"

        # Breakdown
        breakdown = (
            f"E:{se.audio_energy_score:.0f} "
            f"S:{se.speech_density_score:.0f} "
            f"V:{se.visual_activity_score:.0f} "
            f"D:{se.duration_fit_score:.0f} "
            f"A:{se.audio_variety_score:.0f} "
            f"P:{se.position_score:.0f}"
        )

        table.add_row(
            str(se.scene_id),
            time_str,
            f"{se.score:.1f}",
            tier,
            bar,
            breakdown,
        )

    console.print(table)
    console.print(
        "[dim]Breakdown: E=Energy S=Speech V=Visual D=Duration A=AudioVar P=Position[/dim]"
    )


def _display_dna(dna) -> None:
    """Display an EditDNA in a rich panel with tables."""

    console.print()
    console.print(Panel(
        f"🧬 [bold]{dna.name}[/bold]\n{dna.description}",
        style="magenta",
        title="Edit DNA",
    ))

    # Rhythm
    rt = Table(title="🥁 Rhythm", show_header=True, header_style="bold")
    rt.add_column("Property", style="dim")
    rt.add_column("Value")
    rt.add_row("Avg cut length", f"{dna.rhythm.avg_cut_length:.1f}s")
    rt.add_row("Cut length variance", f"{dna.rhythm.cut_length_variance:.2f}s")
    rt.add_row("Pacing curve", dna.rhythm.pacing_curve)
    rt.add_row("Cuts per minute", f"{dna.rhythm.cuts_per_minute:.1f}")
    console.print(rt)

    # Transitions
    tt = Table(title="🔀 Transitions", show_header=True, header_style="bold")
    tt.add_column("Type", style="dim")
    tt.add_column("Ratio")
    tt.add_row("Jump cut", f"{dna.transitions.jump_cut_ratio:.0%}")
    tt.add_row("Fade", f"{dna.transitions.fade_ratio:.0%}")
    tt.add_row("Dissolve", f"{dna.transitions.dissolve_ratio:.0%}")
    tt.add_row("Wipe", f"{dna.transitions.wipe_ratio:.0%}")
    tt.add_row("Avg duration", f"{dna.transitions.avg_transition_duration:.1f}s")
    console.print(tt)

    # Visual
    vt = Table(title="🎨 Visual", show_header=True, header_style="bold")
    vt.add_column("Property", style="dim")
    vt.add_column("Value")
    vt.add_row("Brightness", f"{dna.visual.avg_brightness:+.3f}")
    vt.add_row("Saturation", f"{dna.visual.avg_saturation:.3f}")
    vt.add_row("Contrast", f"{dna.visual.avg_contrast:.3f}")
    vt.add_row("Temperature", dna.visual.color_temperature)
    console.print(vt)

    # Audio
    at = Table(title="🔊 Audio", show_header=True, header_style="bold")
    at.add_column("Property", style="dim")
    at.add_column("Value")
    at.add_row("Has BGM", "✅" if dna.audio.has_bgm else "❌")
    at.add_row("BGM volume ratio", f"{dna.audio.bgm_volume_ratio:.0%}")
    at.add_row("Silence tolerance", f"{dna.audio.silence_tolerance:.1f}s")
    at.add_row("Speech ratio", f"{dna.audio.speech_ratio:.0%}")
    console.print(at)

    # Subtitles
    st = Table(title="📝 Subtitles", show_header=True, header_style="bold")
    st.add_column("Property", style="dim")
    st.add_column("Value")
    st.add_row("Has subtitles", "✅" if dna.subtitle.has_subtitles else "❌")
    st.add_row("Position", dna.subtitle.position)
    st.add_row("Font size", dna.subtitle.font_size_category)
    console.print(st)


def _display_analysis(analysis) -> None:
    """Display video analysis in a rich table."""

    table = Table(title="📊 Video Analysis", show_header=True, header_style="bold cyan")
    table.add_column("Property", style="dim")
    table.add_column("Value")

    table.add_row("File", Path(analysis.file_path).name)
    table.add_row("Duration", f"{analysis.duration:.1f}s ({analysis.duration/60:.1f}min)")
    table.add_row("Resolution", f"{analysis.width}×{analysis.height}")
    table.add_row("FPS", f"{analysis.fps:.1f}")
    table.add_row("Scenes", str(len(analysis.scenes)))
    table.add_row("Transcript segments", str(len(analysis.transcript)))
    table.add_row("Silent segments", str(len(analysis.quality.silent_segments)))
    table.add_row(
        "Silence ratio",
        f"{analysis.quality.overall_silence_ratio * 100:.1f}%",
    )

    console.print()
    console.print(table)

    # Show scenes summary
    if analysis.scenes:
        scene_table = Table(title="🎬 Scenes", show_header=True, header_style="bold")
        scene_table.add_column("#", style="dim", width=4)
        scene_table.add_column("Time", width=16)
        scene_table.add_column("Duration", width=10)
        scene_table.add_column("Speech", width=8)
        scene_table.add_column("Silent", width=8)

        for scene in analysis.scenes[:20]:  # Limit display
            scene_table.add_row(
                str(scene.id),
                f"{scene.start_time:.1f}–{scene.end_time:.1f}",
                f"{scene.duration:.1f}s",
                "✅" if scene.has_speech else "❌",
                "🔇" if scene.is_silent else "🔊",
            )

        if len(analysis.scenes) > 20:
            scene_table.add_row("...", f"+{len(analysis.scenes)-20} more", "", "", "")

        console.print(scene_table)


def _display_plan(plan) -> None:
    """Display edit plan in a rich format."""
    from cutai.models.types import CutOperation, SubtitleOperation

    console.print()
    console.print(
        Panel(
            f"📋 [bold]Edit Plan[/bold]\n"
            f"Instruction: [italic]{plan.instruction}[/italic]\n"
            f"Summary: {plan.summary}\n"
            f"Estimated duration: {plan.estimated_duration:.1f}s ({plan.estimated_duration/60:.1f}min)\n"
            f"Operations: {len(plan.operations)}",
            style="yellow",
        )
    )

    if plan.operations:
        ops_table = Table(title="✂️  Operations", show_header=True, header_style="bold")
        ops_table.add_column("#", style="dim", width=4)
        ops_table.add_column("Type", width=10)
        ops_table.add_column("Details")

        for i, op in enumerate(plan.operations[:30]):
            if isinstance(op, CutOperation):
                details = f"{op.action} [{op.start_time:.1f}–{op.end_time:.1f}s] — {op.reason}"
            elif isinstance(op, SubtitleOperation):
                details = f"style={op.style}, position={op.position}, lang={op.language}"
            else:
                details = str(op.model_dump())

            ops_table.add_row(str(i), op.type, details)

        console.print(ops_table)


def app_entry() -> None:
    """Entry point for the CLI (used by pyproject.toml)."""
    app()


if __name__ == "__main__":
    app_entry()
