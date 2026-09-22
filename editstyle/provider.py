"""BYOK OpenAI-compatible transport. Credentials exist only in the process."""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class ModelConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: str = Field(max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: SecretStr = SecretStr("")
    vision: bool = True

    @field_validator("base_url")
    @classmethod
    def valid_endpoint(cls, value: str) -> str:
        url = urlsplit(value.strip())
        if url.username or url.password or url.query or url.fragment or not url.hostname:
            raise ValueError("서버 주소에 계정, 쿼리 또는 조각 주소를 넣을 수 없습니다.")
        local = url.hostname in {"localhost", "127.0.0.1", "::1"}
        if url.scheme != "https" and not (url.scheme == "http" and local):
            raise ValueError("원격 서버는 HTTPS, 로컬 서버는 localhost HTTP를 사용하세요.")
        return value.strip().rstrip("/")

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("모델 이름을 입력하세요.")
        return value.strip()


def complete(connection: ModelConnection, system: str, content, *, transport=None) -> dict:
    headers = {}
    key = connection.api_key.get_secret_value()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        # Redirects are deliberately not followed with a user's credential.
        with httpx.Client(timeout=120, follow_redirects=False, trust_env=False,
                          transport=transport) as client:
            response = client.post(connection.base_url + "/chat/completions", headers=headers,
                                   json={"model": connection.model, "messages": [
                                       {"role": "system", "content": system},
                                       {"role": "user", "content": content},
                                   ]})
        if response.status_code in (401, 403):
            raise ValueError("모델 인증에 실패했습니다. API 키와 사용 권한을 확인하세요.")
        if response.status_code == 429:
            raise ValueError("모델 사용 한도에 도달했습니다. 잠시 뒤 다시 시도하세요.")
        if response.status_code != 200:
            raise ValueError(f"모델 서버가 HTTP {response.status_code}를 반환했습니다. 주소·모델·이미지 지원을 확인하세요.")
        if len(response.content) > 2_000_000:
            raise ValueError("모델 응답이 너무 큽니다.")
        body = response.json()
        text = body["choices"][0]["message"]["content"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("모델이 텍스트를 반환하지 않았습니다.")
        return {"text": text, "usage": body.get("usage", {}), "model": connection.model}
    except (httpx.HTTPError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        # Provider error bodies can echo keys/prompts. Do not propagate them.
        raise ValueError("모델 응답을 받지 못했습니다. 서버 연결과 Chat Completions 지원을 확인하세요.") from exc


def json_result(text: str) -> dict:
    match = re.fullmatch(r"\s*```(?:json)?\s*\n(.*?)\n```\s*", text, re.S)
    try:
        result = json.loads(match.group(1) if match else text)
    except json.JSONDecodeError as exc:
        raise ValueError("모델 응답이 올바른 JSON이 아닙니다. 다시 요청하거나 직접 작성하세요.") from exc
    if not isinstance(result, dict):
        raise ValueError("모델 응답은 JSON 객체여야 합니다.")
    return result
