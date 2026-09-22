"""Style preservation and actual stdio MCP client/server checks."""

import json
import sys
import unittest
from pathlib import Path

from cutai.style_bridge import get_style, list_styles, read_style

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    ClientSession = None


class StyleBridgeTests(unittest.TestCase):
    def test_catalog_preserves_all_seven_original_documents(self):
        styles = list_styles()
        self.assertEqual(len(styles), 7)
        for item in styles:
            result = get_style(item["id"])
            original = Path("awesome-editstyles/presets", item["id"] + ".md")
            self.assertEqual(result["markdown"], original.read_text(encoding="utf-8"))
            expected = 5 if item["id"] in {"cinematic", "vlog-casual"} else 7
            self.assertEqual(len(result["sections"]), expected)
            if expected == 7:
                self.assertTrue(any(s["heading"] == "Rules" for s in result["sections"]))

    def test_omissions_do_not_become_numeric_defaults(self):
        result = read_style("# My style\n> CutAI EDITSTYLE v1\n## Rules\n- Keep meaningful pauses.\n")
        self.assertIn("Rhythm", result["unspecified_sections"])
        self.assertEqual(len(result["sections"]), 1)
        self.assertNotIn("dna", result)

    def test_unknown_and_duplicate_sections_survive(self):
        text = "# 취향\n> CutAI EDITSTYLE v1\n## Evidence\n- 00:03 pause\n## Rules\n- A\n## Rules\n- B\n"
        result = read_style(text)
        self.assertEqual([s["heading"] for s in result["sections"]], ["Evidence", "Rules", "Rules"])
        self.assertEqual(result["markdown"], text)

    def test_examples_do_not_count_as_real_headers_or_markers(self):
        with self.assertRaises(ValueError):
            read_style("```markdown\n# Example\n> CutAI EDITSTYLE v1\n```\n")
        result = read_style("# Real\n> CutAI EDITSTYLE v1\n## Rules\n~~~md\n## Audio\n~~~\n- Keep\n")
        self.assertIn("Audio", result["unspecified_sections"])
        self.assertIn("## Audio", result["sections"][0]["content"])

    def test_arbitrary_paths_are_not_style_ids(self):
        for value in ("../../README", "/etc/passwd", "missing"):
            with self.assertRaises(ValueError):
                get_style(value)

    def test_invalid_documents_fail_explicitly(self):
        for value in ("", "# No marker", "> CutAI EDITSTYLE v1", "x" * 100_001):
            with self.assertRaises(ValueError):
                read_style(value)


@unittest.skipIf(ClientSession is None, "Install mcp<2 to run protocol integration")
class StyleMCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_session(self):
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "cutai.style_mcp"],
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as client:
                await client.initialize()
                tools = (await client.list_tools()).tools
                self.assertEqual({t.name for t in tools}, {
                    "cutai_list_styles", "cutai_get_style", "cutai_read_style",
                })
                self.assertTrue(all(t.annotations.readOnlyHint for t in tools))
                catalog = await client.call_tool("cutai_list_styles", {})
                self.assertFalse(catalog.isError)
                style = await client.call_tool("cutai_get_style", {"style_id": "cinematic"})
                self.assertFalse(style.isError)
                data = json.loads(style.content[0].text)
                self.assertEqual(data["id"], "cinematic")
                custom = await client.call_tool("cutai_read_style", {
                    "markdown": "# Custom\n> CutAI EDITSTYLE v1\n## Evidence\n- user brief",
                })
                self.assertFalse(custom.isError)
                self.assertIn("Rhythm", json.loads(custom.content[0].text)["unspecified_sections"])
                invalid = await client.call_tool("cutai_get_style", {"style_id": "../README"})
                self.assertTrue(invalid.isError)
                invalid = await client.call_tool("cutai_read_style", {"markdown": "invalid"})
                self.assertTrue(invalid.isError)


if __name__ == "__main__":
    unittest.main()
