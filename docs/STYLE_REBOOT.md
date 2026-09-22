# editstyle: reusable editing styles (formerly CutAI)

2026-09-22 · working prototype

CutAI의 새 방향은 **기존 편집 도구에서 재사용하는 편집 스타일**이다.
사용자는 자기 영상이나 레퍼런스의 컷 리듬, 자막, 전환, 오디오, 연출 규칙을
`EDITSTYLE.md`로 보관하고 다음 영상에 맞게 적용한다.

## Product boundary

- 핵심 자산: 편집 취향과 그 근거를 담은 `EDITSTYLE.md`.
- 스킬: 레퍼런스 관찰 → 스타일 작성/수정 → 원본 영상에 맞춘 편집 지침.
- MCP: 스타일 목록, 원문 조회, 사용자 스타일 문서 읽기.
- 편집 실행: 사용자가 이미 쓰는 편집 도구와 연결된 에이전트가 담당한다.

사용 예: “이 레퍼런스의 편집 스타일을 저장해줘. 다음 인터뷰에도 쓰되, 말의
의미는 유지하고 자막 강조만 줄여줘.” 스타일을 특정 창작자의 이름만으로
정의하지 않고, 실제 관찰한 규칙과 예외로 설명한다.

4월의 독립 편집기·타임라인 개발 방향은 이번 재개 범위에서 보류한다.
`desktop/`, 렌더러, 예전 CLI/MCP는 기존 구현으로 보존했다.

## Reused assets and actual limitations

| 기존 자산 | 재사용 판단 |
|---|---|
| EDITSTYLE.md v1 | 문서 호환 유지. Patterns/Rules/미지의 섹션도 보존 |
| 7개 Markdown 프리셋 | 작성된 시작점. 실제 채널 분석 결과가 아님 |
| EditDNA 추출기 | 장면 길이·샘플 색상·오디오 휴리스틱 기반 실험 구현 |
| 전환 추출 | 현재 기본 hard-cut 값. 실제 전환 분류 미구현 |
| 자막 추출 | 자막 스트림 감지. 번인 자막의 서체/위치/애니메이션 추출 아님 |
| 색상 수치 | 영상의 관찰값. 원본에 그대로 적용 가능한 LUT 복원 아님 |
| 기존 숫자 파서 | 누락 필드에 기본값을 채움. 관측 근거로 사용하면 안 됨 |

새 reader는 원문과 섹션을 반환하며 누락을 그대로 드러낸다. 수치 검증기나
스타일 충돌 탐지기는 아니다. 예전 프리셋에는 오래된 플랫폼 길이 제한,
근거 없는 시청 통계, 서로 충돌하는 전환 지침이 있어 스킬에서 검토한다.

## Try the prototype

저장소 루트에서 실행한다. 기본 스타일 조회에는 Python 3.10+만 필요하다.
이 새 경로는 Whisper, OpenCV, FFmpeg나 기존 편집기 설치를 요구하지 않는다.

```bash
python3 -m editstyle.catalog list
python3 -m editstyle.catalog get cinematic
python3 -m editstyle.catalog read /absolute/path/EDITSTYLE.md
```

스킬 배포 단위는 `skills/editstyle/` 전체 폴더다. 스킬을 지원하는 호스트의
skills 디렉터리에 복사해서 사용한다. MCP 없이 사용자 브리프나 직접 제공한
스타일 문서만으로도 동작한다. 이 저장소를 받는 것만으로 자동 설치되지는 않는다.

MCP는 공식 Python SDK v1 API를 사용하며 호환성을 위해 `<2`로 제한한다.
공식 근거: https://py.sdk.modelcontextprotocol.io/v1/

```bash
uv run --no-project --with 'mcp>=1.28,<2' python -m editstyle.mcp_server
```

stdio MCP 호스트의 설정 예시(경로는 실제 체크아웃으로 변경):

```json
{
  "mcpServers": {
    "editstyle": {
      "command": "uv",
      "args": [
        "run", "--directory", "/absolute/path/to/editstyle", "--no-project",
        "--with", "mcp>=1.28,<2", "python", "-m", "editstyle.mcp_server"
      ]
    }
  }
}
```

도구는 `editstyle_list_styles`, `editstyle_get_style`, `editstyle_read_style` 세 개다.
새 MCP에는 편집/렌더/쉘 실행 도구가 없다. `read_style`은 파일 경로 대신
호스트가 제공한 Markdown 텍스트를 받는다. 저장은 호스트의 파일 기능으로 한다.
현재 배포는 저장소 체크아웃 기준이며 PyPI wheel 배포는 준비하지 않았다.

검증:

```bash
uv run --no-project --with 'mcp>=1.28,<2' python -m unittest discover -s tests -p test_style_bridge.py -v
```

## Next working slice

1. 실제 레퍼런스 한 편에서 시간 근거를 포함한 스타일을 추출한다. 관측/추론/
   사용자 선택/미확인을 분리하며, 미감지 항목을 기본값으로 채우지 않는다.
2. 같은 원본에 서로 다른 스타일 두 개를 적용할 구체적인 편집 지침을 만든다.
3. 사용자의 첫 대상 편집 도구를 정하고, 지원되는 조작 또는 교환 포맷으로
   연결해 결과를 비교한다. 단순 프롬프트 차이가 아니라 실제 컷·자막·리듬의
   차이와 편집 가능성을 확인한다.

실제 레퍼런스 추출, 편집기 어댑터, 스타일 재현 품질, 사용자 호스트 내 설치는
아직 검증되지 않았다. 프리셋 조회나 MCP 연결 성공만으로 제품 효과를 주장하지 않는다.
