"""Compatibility entry point; tool names now use editstyle_."""

from editstyle.mcp_server import mcp

if __name__ == "__main__":
    mcp.run(transport="stdio")
