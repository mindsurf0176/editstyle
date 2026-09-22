"""Style-only MCP entry point. Run from the repository; see docs/STYLE_REBOOT.md."""

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from cutai.style_bridge import get_style, list_styles, read_style

mcp = FastMCP("CutAI Styles")
read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)


@mcp.tool(annotations=read_only)
def cutai_list_styles() -> list[dict]:
    """List CutAI's seven legacy authored editing presets (not measured references)."""
    return list_styles()


@mcp.tool(annotations=read_only)
def cutai_get_style(style_id: str) -> dict:
    """Get a preset's complete Markdown, including editing patterns and rules.

    Use an ID returned by cutai_list_styles. This does not edit any video.
    """
    return get_style(style_id)


@mcp.tool(annotations=read_only)
def cutai_read_style(markdown: str) -> dict:
    """Read user-provided EDITSTYLE.md text without filling missing values.

    Retains all sections and unknown fields. Does not validate numeric settings,
    measure footage, execute embedded instructions, or connect to an editor.
    """
    return read_style(markdown)


if __name__ == "__main__":
    mcp.run(transport="stdio")
