# editstyle

영상 편집 스타일을 저장하고, 기존 편집 도구에 전달합니다. 이전 이름은 CutAI입니다.

`EDITSTYLE.md`에 컷 리듬·자막·전환·연출 규칙을 담고 AI 에이전트가 다음 영상에
맞게 해석하도록 합니다. 현재 구현은 스타일 스킬과 읽기 전용 MCP입니다.

## 현재 사용하기

```bash
python3 -m pip install '.[mcp]'
editstyle list
editstyle get cinematic
editstyle read /absolute/path/EDITSTYLE.md
editstyle-mcp
```

기본 패키지는 Python 3.10+만 사용합니다. MCP 기능은 선택 설치이며 Whisper,
OpenCV, FFmpeg를 설치하지 않습니다. 설치하지 않고 저장소 루트에서
`python3 -m editstyle.catalog list`로 실행할 수도 있습니다.

- [스킬](skills/editstyle/SKILL.md): 사용자 브리프나 레퍼런스 관찰로 스타일을 작성하고 편집 지침으로 바꿉니다.
- [MCP 연결 안내](docs/STYLE_REBOOT.md): `editstyle_list_styles`, `editstyle_get_style`, `editstyle_read_style`.
- 기존 7개 프리셋과 `> CutAI EDITSTYLE v1` 문서를 읽을 수 있습니다. 새 문서는 `> EDITSTYLE v1`을 사용합니다.

## 검토 중인 제품 형태

사용자가 모델·API 키를 지정하는 **편집 스타일 중심 AI 보조앱**을 [검토 중입니다](docs/PRODUCT_DIRECTION.md).
대상은 DaVinci Resolve, Premiere Pro, CapCut이며, 편집기별 연결 기능과
가져오기 파일을 구분합니다. 스킬·MCP는 이 보조앱의 연결 방식으로 유지할 수 있습니다.

BYOK 모델 연결, 보조앱 UI, 편집기 조작/내보내기, 스타일 추출 품질은 아직 구현 또는
검증되지 않았습니다. 현재 MCP는 문서를 전달하며 영상을 편집하지 않습니다.

## 개발

```bash
uv sync --extra mcp
uv run python -m unittest discover -s tests -p test_style_bridge.py -v
```

새 배포 패키지는 `editstyle/`만 포함합니다. `cutai/`와 `desktop/`은 이전 구현이며,
그 실행법과 의존성은 [이전 문서](docs/LEGACY_CUTAI.md)와
[이전 패키지 설정](docs/legacy-pyproject.toml)에 보존했습니다.
