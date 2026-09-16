from __future__ import annotations

from types import SimpleNamespace

import pytest

from pydantic import SecretStr

from src.ai import groq_provider
from src.ai.groq_provider import parse_json_object


def test_parse_json_object_accepts_plain_json():
    assert parse_json_object('{"amount": "$20.00"}') == {"amount": "$20.00"}


def test_parse_json_object_accepts_fenced_json_with_reasoning():
    response = '<think>Inspecting the receipt.</think>\n```json\n{"status": "Completed"}\n```'
    assert parse_json_object(response) == {"status": "Completed"}


def test_parse_json_object_rejects_missing_object():
    with pytest.raises(ValueError):
        parse_json_object('The image is unclear.')


def test_extract_requests_bounded_output_tokens(monkeypatch):
    calls = []
    settings = SimpleNamespace(
        GROQ_API_KEY=SecretStr('test-key'),
        GROQ_VISION_MODEL='qwen/qwen3.8-27b',
        GROQ_MAX_OUTPUT_TOKENS=512,
    )

    class FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"status":"Completed"}'))]
            )

    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))
    monkeypatch.setattr(groq_provider, 'get_settings', lambda: settings)
    monkeypatch.setattr(groq_provider, 'Groq', lambda api_key: fake_client)

    result = groq_provider.GroqVisionProvider().extract_payment_fields(
        b'synthetic-image', 'bounded-output-check'
    )

    assert result.fields == {'status': 'Completed'}
    assert calls[0]['max_tokens'] == 512
