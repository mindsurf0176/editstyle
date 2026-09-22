# editstyle

**편집 스타일은 editstyle에, 편집은 쓰던 도구에서.** 이전 이름은 CutAI입니다.

컷의 호흡, 자막, 전환, 오디오, 연출 규칙을 `EDITSTYLE.md`에 저장합니다.
Codex·Claude가 이 스타일을 읽고, 사용자가 연결한 편집기 도구로 다음 영상에
맞게 적용합니다. editstyle 전용 모델이나 API 키는 필요하지 않습니다.

```text
editstyle 스킬 + EDITSTYLE.md
            ↓
       Codex / Claude
            ↓
   사용자가 연결한 편집기 MCP
            ↓
  Premiere / Resolve / CapCut 등
```

편집기 MCP는 별도입니다. editstyle이 설치하거나 실행하지 않으며, 연결된
도구가 없으면 스타일 문서와 편집 지침을 만듭니다. 현재 모든 편집기에서
자동 편집이 검증되었다는 뜻은 아닙니다.

## 스킬로 시작하기

`skills/editstyle/` 전체 폴더를 호스트의 스킬 폴더에 넣습니다. Python이나
MCP 없이도 사용자 브리프·직접 제공한 스타일 문서로 시작할 수 있습니다.

- Codex: `~/.agents/skills/editstyle/`
- Claude Code: `~/.claude/skills/editstyle/`

사용 예:

```text
이 레퍼런스에서 실제로 확인한 편집 스타일을 EDITSTYLE.md로 저장해줘.
확인하지 못한 자막·오디오 설정은 추측하지 마.

내 EDITSTYLE.md로 이 인터뷰의 편집 계획을 만들어줘. 아직 적용하지 마.

이 스타일을 연결된 편집기에 적용해줘. 원본은 남기고 새 타임라인을 만들어줘.
적용한 항목과 지원하지 못한 항목을 구분해줘.
```

[설치와 연결 안내](docs/STYLE_REBOOT.md) · [스킬 본문](skills/editstyle/SKILL.md)

## 스타일 조회용 CLI / MCP · 선택 설치

기본 패키지는 Python 3.10+ 표준 라이브러리만 사용합니다. FFmpeg·Whisper·
편집기를 설치하지 않습니다. 아래 명령은 저장소 루트 기준입니다.

```bash
python3 -m pip install '.[mcp]'
editstyle list
editstyle search "cinematic"
editstyle get cinematic --markdown
editstyle read /absolute/path/EDITSTYLE.md
editstyle-mcp
```

MCP는 목록·키워드 검색·원문 조회·문서 읽기만 제공합니다. 영상 분석, 모델 호출,
편집기 조작, 파일 저장은 하지 않습니다. 7개 프리셋은 작성된 시작점이며 실제
레퍼런스 분석 결과가 아닙니다. 내 스타일은 일반 Markdown 파일로 보관합니다.

## 무엇을 확인하나요?

- 레퍼런스를 볼 수 있을 때만 시간 근거를 남기며, 관측·추론·취향·미확인을 구분합니다.
- 편집기 이름이 아닌 실제 연결 도구와 입력 규격을 확인합니다.
- 제안, 실행했지만 미검증, 확인 완료, 미지원, 실패를 구분해 결과를 보고합니다.

이 흐름은 에이전트가 따르는 스킬 지침입니다. 모든 호스트의 동작을 강제하는
샌드박스나 자동 품질 보증 장치는 아닙니다. 편집 결과와 스타일 재현 품질은
실제 영상·편집기에서 별도로 검증해야 합니다.

## 보존한 실험 구현

기존 [BYOK 보조앱](docs/COMPANION.md)과 [Premiere·Resolve 내부 확장](docs/PLUGINS.md)은
실험용으로 보존했습니다. 현재 주력 경로의 필수 구성요소가 아닙니다.
`cutai/`와 `desktop/`의 이전 독립 편집기는 [역사 문서](docs/LEGACY_CUTAI.md)에 남겼습니다.
[제품 방향](docs/PRODUCT_DIRECTION.md)을 참고하세요.

## 개발과 스킬 패키징

```bash
uv sync --extra app --extra mcp --extra dev
uv run python -m unittest tests.test_style_bridge tests.test_skill_bundle -v
python3 scripts/build-skill.py
```

`dist/skills/editstyle-skill.zip`에는 스킬, 스타일 템플릿, 편집기 전달 지침과
7개 프리셋이 포함됩니다. 호스트 자동 설치나 마켓플레이스 등록은 하지 않습니다.
Python wheel에는 경량 `editstyle/` 패키지와 선택 설치용 실험 앱이 포함됩니다.
