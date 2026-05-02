"""Shared JSON extraction utilities for the narrator module."""

from __future__ import annotations

import json
import re


def extract_json(raw: str) -> dict:
    """Robustly extract JSON from LLM response, handling markdown fences and malformed JSON."""
    stripped = raw.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline != -1:
            stripped = stripped[first_newline + 1:]
        if stripped.endswith("```"):
            stripped = stripped[:-3]
        stripped = stripped.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        json_match = re.search(r'\{[^{}]*"narrations"[\s\S]*\}', stripped)
        if json_match:
            try:
                return json.loads(json_match.group())
            except json.JSONDecodeError:
                cleaned = re.sub(r',\s*([}\]])', r'\1', json_match.group())
                return json.loads(cleaned)
        raise
