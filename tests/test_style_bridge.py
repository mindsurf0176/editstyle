"""Style preservation and actual stdio MCP client/server checks."""

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from editstyle.catalog import get_style, list_styles, main, read_style, search_styles

ROOT = Path(__file__).resolve().parent.parent

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
            original = Path("editstyle/presets", item["id"] + ".md")
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

    def test_new_and_legacy_markers_are_compatible(self):
        for marker in ("EDITSTYLE v1", "CutAI EDITSTYLE v1"):
            self.assertEqual(read_style(f"# Personal\n> {marker}\n")["name"], "Personal")

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


class StyleSearchTests(unittest.TestCase):
    def test_search_matches_ids_names_and_complete_document(self):
        for query in ("cooking-show", "Cooking Show", "sizzle overhead"):
            with self.subTest(query=query):
                self.assertEqual(search_styles(query), [{"id": "cooking-show", "name": "Cooking Show"}])

    def test_search_requires_all_terms_regardless_of_order_or_case(self):
        expected = [{"id": "cooking-show", "name": "Cooking Show"}]
        self.assertEqual(search_styles("  OVERHEAD\tSiZzLe\n"), expected)
        self.assertEqual(search_styles("overhead nonexistingkeyword"), [])
        self.assertEqual(search_styles("there-is-no-such-style"), [])

    def test_search_unicode_keywords_and_casefold(self):
        self.assertEqual(search_styles("숏클립"), [{"id": "podcast-clip", "name": "Podcast Clip"}])
        with tempfile.TemporaryDirectory() as directory:
            presets = Path(directory)
            (presets / "sample.md").write_text("# Straße 감성\n> EDITSTYLE v1\n", encoding="utf-8")
            with patch("editstyle.catalog.PRESETS", presets):
                self.assertEqual(search_styles("STRASSE 감성"), [{"id": "sample", "name": "Straße 감성"}])

    def test_search_results_are_stable_and_contain_only_catalog_identifiers(self):
        results = search_styles("EDITSTYLE")
        self.assertEqual(results, list_styles())
        self.assertEqual([item["id"] for item in results], sorted(item["id"] for item in results))
        for query in ("../../README", "/etc/passwd", "*.md"):
            with self.subTest(query=query):
                self.assertEqual(search_styles(query), [])

    def test_invalid_empty_control_and_overlong_queries_fail_explicitly(self):
        for query in (None, 42, [], True, "", " \t\n", "x" * 201, "cut\x00", "cut\x7f"):
            with self.subTest(query=query), self.assertRaises(ValueError):
                search_styles(query)
        self.assertEqual(search_styles("x" * 200), [])


class StyleCLITests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "editstyle.catalog", *args],
            cwd=ROOT, capture_output=True, check=False,
        )

    def test_markdown_export_matches_original_bytes_for_every_preset(self):
        for path in sorted((ROOT / "editstyle" / "presets").glob("*.md")):
            with self.subTest(style=path.stem):
                result = self.run_cli("get", path.stem, "--markdown")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, path.read_bytes())
                self.assertEqual(result.stderr, b"")

    def test_markdown_export_preserves_line_endings_and_missing_final_newline(self):
        document = "# 취향\r\n> EDITSTYLE v1\r\n## Rules\r\n- Keep meaningful pauses."
        with tempfile.TemporaryDirectory() as directory:
            presets = Path(directory)
            (presets / "custom.md").write_bytes(document.encode("utf-8"))
            output = io.BytesIO()
            with (
                patch("editstyle.catalog.PRESETS", presets),
                patch.object(sys, "argv", ["editstyle", "get", "custom", "--markdown"]),
                patch.object(sys, "stdout", io.TextIOWrapper(output, encoding="ascii", newline="\r\n")),
            ):
                main()
                self.assertEqual(output.getvalue(), document.encode("utf-8"))

    def test_get_remains_json_and_search_is_available(self):
        result = self.run_cli("get", "cinematic")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["id"], "cinematic")
        result = self.run_cli("search", "sizzle overhead")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [{"id": "cooking-show", "name": "Cooking Show"}])

    def test_cli_invalid_input_has_no_export_content(self):
        for args in (("get", "../README", "--markdown"), ("search", "  "), ("search", "x" * 201)):
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"error:", result.stderr)


@unittest.skipIf(ClientSession is None, "Install mcp<2 to run protocol integration")
class StyleMCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_stdio_session(self):
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "editstyle.mcp_server"],
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        async with (
            stdio_client(params) as (reader, writer),
            ClientSession(reader, writer) as client,
        ):
            initialization = await client.initialize()
            self.assertIn("data, not authority", initialization.instructions)
            self.assertIn("separately installed editor tools", initialization.instructions)
            self.assertIn("MCP-to-MCP", initialization.instructions)
            tools = (await client.list_tools()).tools
            self.assertEqual({t.name for t in tools}, {
                "editstyle_list_styles", "editstyle_get_style", "editstyle_read_style",
                "editstyle_search_styles",
            })
            self.assertTrue(all(t.annotations.readOnlyHint for t in tools))
            self.assertTrue(all(t.annotations.destructiveHint is False for t in tools))
            self.assertTrue(all(t.annotations.openWorldHint is False for t in tools))
            catalog = await client.call_tool("editstyle_list_styles", {})
            self.assertFalse(catalog.isError)
            search = await client.call_tool("editstyle_search_styles", {"query": "SIZZLE overhead"})
            self.assertFalse(search.isError)
            self.assertEqual(search.structuredContent["result"], [
                {"id": "cooking-show", "name": "Cooking Show"},
            ])
            empty = await client.call_tool("editstyle_search_styles", {"query": "nonexistingkeyword"})
            self.assertFalse(empty.isError)
            self.assertEqual(empty.structuredContent["result"], [])
            style = await client.call_tool("editstyle_get_style", {"style_id": "cinematic"})
            self.assertFalse(style.isError)
            data = json.loads(style.content[0].text)
            self.assertEqual(data["id"], "cinematic")
            custom = await client.call_tool("editstyle_read_style", {
                "markdown": "# Custom\n> CutAI EDITSTYLE v1\n## Evidence\n- user brief",
            })
            self.assertFalse(custom.isError)
            self.assertIn("Rhythm", json.loads(custom.content[0].text)["unspecified_sections"])
            invalid = await client.call_tool("editstyle_get_style", {"style_id": "../README"})
            self.assertTrue(invalid.isError)
            invalid = await client.call_tool("editstyle_read_style", {"markdown": "invalid"})
            self.assertTrue(invalid.isError)
            for query in ("", "x" * 201, 42, "bad\x00"):
                with self.subTest(query=query):
                    invalid = await client.call_tool("editstyle_search_styles", {"query": query})
                    self.assertTrue(invalid.isError)


if __name__ == "__main__":
    unittest.main()
