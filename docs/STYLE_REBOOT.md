# editstyle 스킬·MCP 사용 안내

2026-09-22 · 스킬 우선 개발 버전

editstyle은 스타일 정보를 제공합니다. Codex·Claude가 이 정보를 읽고 기존
편집기 연결을 호출합니다. editstyle 자체 모델 호출은 없으며 실제 편집 실행에는
별도 편집기 연결이 필요합니다.

## 1. 스킬만 사용하기

저장소의 `skills/editstyle/` 전체 폴더를 복사합니다. 기존 설치가 있으면 먼저
그 내용을 확인하세요. 아래 명령은 같은 이름이 있으면 덮어쓰지 않고 중단합니다.
저장소 루트에서 사용할 호스트의 명령 하나만 실행합니다.

Codex:

```bash
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/editstyle" && cp -R skills/editstyle "$HOME/.agents/skills/editstyle"
```

Claude Code:

```bash
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/editstyle" && cp -R skills/editstyle "$HOME/.claude/skills/editstyle"
```

Codex에서는 `$editstyle`, Claude Code에서는 `/editstyle`로 명시 호출할 수
있습니다. 보이지 않으면 새 세션에서 확인하세요. 호스트별 배포/클라우드 환경의
스킬 경로는 다를 수 있으므로 아래 공식 문서를 기준으로 설정합니다.
저장소를 받는 것만으로 스킬이 자동 설치되지는 않습니다.

- [Codex 스킬 공식 문서](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code 스킬 공식 문서](https://code.claude.com/docs/en/skills)

스킬 폴더에는 사용 절차, 편집기 전달 규칙, `EDITSTYLE.template.md`가 있습니다.
사용자 브리프나 직접 제공한 스타일 문서로 동작하며 Python/MCP는 필수가 아닙니다.
템플릿의 `Unknown`은 아직 관찰하거나 선택하지 않은 값입니다. 예시 숫자로 채워
실측 스타일처럼 쓰지 않습니다. 개인 스타일 저장은 호스트의 파일 도구가 담당합니다.

### 배포용 ZIP

```bash
python3 scripts/build-skill.py
```

`dist/skills/editstyle-skill.zip`을 풀면 `editstyle/` 폴더가 나옵니다. 이 폴더를
위 스킬 위치에 넣습니다. ZIP은 같은 소스로 재생성할 때 동일한 바이트를 가지며,
옆의 `checksums.json`으로 무결성을 확인할 수 있습니다.
소스 스킬에 추가로 7개 프리셋이 `presets/`에 들어 있어 MCP 없이도 읽을 수 있습니다.
이 ZIP은 스킬 폴더 묶음이지 네이티브 편집기 플러그인이나 마켓플레이스 플러그인이 아닙니다.

## 2. 스타일 조회용 CLI / MCP 추가하기

Python 3.10+. 패키지는 표준 라이브러리만 쓰고 MCP만 선택 의존성입니다.

```bash
python3 -m pip install '.[mcp]'
editstyle list
editstyle search "cinematic"
editstyle get cinematic --markdown
editstyle read /absolute/path/EDITSTYLE.md
```

`get --markdown`은 저장 가능한 원문을 stdout으로 내보냅니다. 기본 `get`은 JSON입니다.
`search`는 공백으로 구분한 모든 검색어가 ID·이름·원문에 있는지 대소문자 구분 없이
검사합니다. 의미 검색·모델 추천은 아니며, 검색 결과가 없으면 빈 목록입니다.
로컬 파일 내용을 읽으려면 `read`를 사용하고 스타일 ID에 파일 경로를 넣지 않습니다.

### MCP 설정

Codex `config.toml`에 등록할 항목의 예시입니다. 경로는 실제 체크아웃으로 바꾸세요.
기존 설정 전체를 덮어쓰지 마세요. 설정 파일 위치·신뢰 범위는
[Codex MCP 문서](https://learn.chatgpt.com/docs/extend/mcp)를 따릅니다.

```toml
[mcp_servers.editstyle]
command = "uv"
args = ["run", "--directory", "/absolute/path/to/editstyle", "--no-project", "--with", "mcp>=1.28,<2", "python", "-m", "editstyle.mcp_server"]
```

Claude Code 등의 stdio MCP 설정 예시입니다. 호스트 설정 방식은
[Claude Code MCP 문서](https://code.claude.com/docs/en/mcp)를 확인하세요.

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

| 도구 | 역할 |
|---|---|
| `editstyle_list_styles` | 기존 7개 프리셋 목록 |
| `editstyle_search_styles` | 프리셋 키워드 검색 |
| `editstyle_get_style` | 선택한 프리셋의 전체 원문과 섹션 |
| `editstyle_read_style` | 호스트가 전달한 Markdown 읽기 |

모두 읽기 전용입니다. 서버에 파일 경로·API 키를 보낼 필요가 없으며 네트워크로
영상을 전송하지 않습니다. 스타일 저장/영상 관찰/편집기 실행은 호스트의 다른
도구가 수행하므로 해당 도구의 권한과 데이터 전송 범위는 별도로 확인해야 합니다.

## 3. 기존 편집기 연결과 함께 사용하기

편집기를 고른 뒤 이미 연결된 도구를 확인합니다. editstyle을 추가한다고 아래
MCP가 자동으로 설치되거나 연결되는 것은 아닙니다. 저장소 문서에서 확인한 예시이며
우리 환경에서 안전성·호환성·실제 편집을 검증한 추천 목록은 아닙니다.

| 대상 | 커뮤니티 구현 예시 | 연결 경계 |
|---|---|---|
| Premiere Pro | [premiere-mcp](https://github.com/AleksKhanevich/premiere-mcp) | 내부 CEP 브리지 설치·실행 필요 |
| DaVinci Resolve | [davinci-resolve-mcp](https://github.com/lordhoell/davinci-resolve-mcp) | 스크립팅 API. 버전·에디션·기능별 제한 확인 |
| CapCut | [capcut-mcp](https://github.com/bchenner/capcut-mcp) | 프로젝트 초안 파일 생성·수정. 앱 버전/파일 호환 확인 |

호스트는 실제 도구 목록과 입력 규격을 보고 컷·자막·전환·오디오·색감 중
어디까지 지원하는지 판단합니다. 이름만 보고 가상의 API를 만들지 않습니다.
원본 보존과 읽기 검증이 가능한 범위에서 실행하고, 지원하지 않는 항목은
편집 지침으로 남깁니다. MCP끼리 직접 호출하지 않고 호스트 에이전트가 조율합니다.

## 검증 범위

자동 검사는 스타일 원문 보존, 검색, CLI, 실제 stdio MCP 통신, 독립 스킬 ZIP의
구성과 재현성을 대상으로 합니다. 에이전트가 스킬을 실제로 따르는지는 별도
행동 검토이며 세 편집기 실제 프로젝트 적용, 영상 미감, 레퍼런스 재현 품질은
이 검사로 입증되지 않습니다. 새 연결 설치와 실영상 적용은 별도 검증 단계입니다.

기존 프리셋의 Patterns/Rules/알 수 없는 섹션은 보존합니다. 오래된 플랫폼
길이 제한·근거 없는 시청 통계·충돌하는 지침은 현재 사실처럼 사용하지 않습니다.
기존 분석기의 샘플 색상이나 자막 스트림 감지는 LUT·번인 자막 서체 복원이 아닙니다.
