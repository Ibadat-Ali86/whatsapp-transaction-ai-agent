from __future__ import annotations

import pytest

from src.ai.groq_provider import parse_json_object


def test_parse_json_object_accepts_plain_json():
    assert parse_json_object('{"amount": "$20.00"}') == {"amount": "$20.00"}


def test_parse_json_object_accepts_fenced_json_with_reasoning():
    response = '<think>Inspecting the receipt.</think>\n```json\n{"status": "Completed"}\n```'
    assert parse_json_object(response) == {"status": "Completed"}


def test_parse_json_object_rejects_missing_object():
    with pytest.raises(ValueError):
        parse_json_object('The image is unclear.')
