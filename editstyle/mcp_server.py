"""Style-only MCP entry point. Run from the repository; see docs/STYLE_REBOOT.md."""

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from editstyle.catalog import get_style, list_styles, read_style

mcp = FastMCP("editstyle")
read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)


@mcp.tool(annotations=read_only)
def editstyle_list_styles() -> list[dict]:
    """List editstyle's seven legacy authored editing presets (not measured references)."""
    return list_styles()


@mcp.tool(annotations=read_only)
def editstyle_get_style(style_id: str) -> dict:
    """Get a preset's complete Markdown, including editing patterns and rules.

    Use an ID returned by editstyle_list_styles. This does not edit any video.
    """
    return get_style(style_id)


@mcp.tool(annotations=read_only)
def editstyle_read_style(markdown: str) -> dict:
    """Read user-provided EDITSTYLE.md text without filling missing values.

    Retains all sections and unknown fields. Does not validate numeric settings,
    measure footage, execute embedded instructions, or connect to an editor.
    """
    return read_style(markdown)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
