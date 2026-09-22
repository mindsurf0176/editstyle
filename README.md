# editstyle

영상 편집 스타일을 저장하고, 기존 편집 도구에 전달합니다. 이전 이름은 CutAI입니다.

`EDITSTYLE.md`에 컷 리듬·자막·전환·연출 규칙을 담고 AI 에이전트가 다음 영상에
맞게 해석하도록 합니다. 로컬 보조앱, 스타일 스킬, 읽기 전용 MCP를 사용할 수 있습니다.

## 편집기 내부에서 사용하기 · 개발 미리보기

Premiere Pro **UXP 패널**과 Resolve Studio **내부 스크립트 도구창**을 구현했습니다.
현재 타임라인 읽기 → 사용자 모델 연결 → 스타일별 컷 제안 → 검토 → 새 러프컷 타임라인
적용 흐름입니다. 원본은 보존하며 기본 컷·원본 오디오만 옮깁니다.

```bash
uv sync --extra app
uv run --extra app editstyle-app --plugins --no-browser
```

터미널의 연결 코드를 내부 패널에 입력하세요. [설치·지원 범위](docs/PLUGINS.md).
실제 Premiere/Resolve 로드·렌더링은 아직 미검증인 **개발 패키지**입니다.
CapCut은 공개 내부 패널 SDK를 확인하지 못해 기존 파일 교환만 유지합니다.

## 보조앱 실행

```bash
brew install ffmpeg  # macOS. Linux/Windows는 각 환경에 FFmpeg 설치
uv sync --extra app
uv run --extra app editstyle-app
```

브라우저에서 `http://127.0.0.1:18470`이 열립니다. 로컬 모델 또는 OpenAI 호환
Chat Completions 서버의 주소·모델·API 키를 입력하고 연결하세요. API 키는 실행 중
메모리에만 보관합니다. 현재 배포 형태는 로컬 브라우저 앱이며 네이티브 설치 앱은 아닙니다.

- 영상 가져오기: 원본 보존, 최대 1280px/30fps 작업용 사본과 시간 근거 생성.
- 스타일 만들기: 모델에 문서·컷 후보를 전달하고 선택 시 샘플 프레임 8장 전달.
- 편집 제안: 컷 범위·이유·설명용 자막을 검토하고 수정한 버전을 저장.
- 가져오기 묶음: Premiere/Resolve용 FCP7 XML·OTIO, CapCut용 번호순 클립, 공통 SRT·컷 목록·미리보기.

모델 없이 스타일 작성과 수동 컷 편집도 가능합니다. [실행·지원 범위·검증 기록](docs/COMPANION.md)을 확인하세요.

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

## 제품 방향과 현재 한계

사용자가 모델·API 키를 지정하는 **편집 스타일 중심 AI 보조앱**의 첫 버전입니다.
브라우저 보조앱은 파일 교환이고, 새 내부 확장은 호스트 API로 타임라인을 읽고
새 러프컷을 직접 가져옵니다. 기존 효과를 복제하거나 원본 타임라인을 수정하지는 않습니다.
실제 공급자 모델을 통한 편집 품질과 세 편집기에서의 가져오기는 미검증입니다.
오디오 전사·자동 색보정·전환 효과·자막 서체 전달은 지원하지 않습니다.
기존 스킬/MCP는 스타일 문서 전달에 사용할 수 있습니다.

## 개발

```bash
uv sync --extra app --extra mcp --extra dev
uv run python -m unittest discover -s tests -p test_style_bridge.py -v
uv run python -m unittest discover -s tests -p test_companion.py -v
```

새 배포 패키지는 `editstyle/`만 포함합니다. `cutai/`와 `desktop/`은 이전 구현이며,
그 실행법과 의존성은 [이전 문서](docs/LEGACY_CUTAI.md)와
[이전 패키지 설정](docs/legacy-pyproject.toml)에 보존했습니다.
