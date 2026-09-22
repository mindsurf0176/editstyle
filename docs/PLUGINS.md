# editstyle 내부 확장 — 개발 미리보기

편집기 내부 UI를 기본 방향으로 전환했습니다. Python 엔진은 화면 없는 로컬 서비스이며,
브라우저 보조앱과 스타일 스킬/MCP도 계속 사용할 수 있습니다.

## 지원 상태

| 편집기 | 구현 형태 | 현재 검증 |
|---|---|---|
| Premiere Pro 25.6+ | UXP 도킹 패널 | SDK 계약 테스트·브라우저 패널 QA. 실제 Premiere 로드 미검증 |
| DaVinci Resolve Studio 20+ | Workspace > Scripts 내부 UIManager 도구창 | OTIO·호스트 어댑터 테스트. 실제 Resolve 실행 미검증 |
| CapCut | 기존 클립·SRT 파일 교환 유지 | 외부 개발자용 내부 패널 SDK를 확인하지 못함. 내부 플러그인 없음 |

Resolve 도구창은 **도킹 패널이나 Electron Workflow Integration 플러그인이 아닙니다**.
Studio 내부에서 실행하는 스크립트 확장입니다. 무료판 UI 지원을 약속하지 않습니다.
현재 개발 Mac에 Premiere/Resolve가 없어 ZIP은 실호스트 검증용 소스 패키지입니다.
테스트 대역 성공을 호스트 성공으로 간주하지 않습니다.

## 실행 구조

내부에서 타임라인 읽기 → 스타일·사용자 모델 선택 → 컷 제안 → 프레임 범위 검토 →
새 러프컷 시퀀스/타임라인 생성. 원본 타임라인과 미디어는 변경하지 않습니다.

- Premiere는 공식 UXP DOM으로 시퀀스·트랙·클립을 읽습니다.
- Resolve는 현재 타임라인을 `EXPORT_OTIO`로 임시 내보내고 OTIO 라이브러리로 읽습니다.
  시작 타임코드와 소스 시간 기준을 분리합니다. 임시 OTIO는 즉시 제거합니다.
- 공용 엔진이 원본 미디어 참조 FCP7 XML을 만들고 내부 확장이 호스트의
  `Project.importFiles` / `MediaPool.ImportTimelineFromFile`로 직접 가져옵니다.
  사용자의 수동 파일 이동이나 원본 재인코딩은 없습니다.
- 적용 시 타임라인을 재검사하며 바뀌면 중단합니다. 가져오기 성공/실패가 불명확하면
  중복 적용을 막고 직접 확인하도록 안내합니다.
- 모델에는 클립 이름·길이·스타일·요청만 전송합니다. **영상·음성 분석은 아직 없고
  의미 기반 장면 선택 품질은 보장하지 않습니다.** 민감한 클립 이름에는 로컬 모델을 사용하세요.

## 공통 엔진 시작

```bash
brew install ffmpeg # macOS. 다른 OS는 FFmpeg와 FFprobe 별도 설치
uv sync --extra app
uv run --extra app editstyle-app --plugins --no-browser
```

엔진은 `127.0.0.1:18470`에서 실행되고 터미널에 **플러그인 연결 코드**가 나옵니다.
패널에 붙여 넣으세요. 재시작마다 바뀌며 파일에 저장하지 않습니다. API 키와는 다른 코드입니다.
일반 앱 실행에는 bridge가 열리지 않습니다. 같은 포트의 기존 앱은 먼저 종료하세요.

패널에서 OpenAI-compatible Chat Completions 주소·모델·API 키를 입력합니다.
키는 엔진 메모리에만 있고 입력창은 요청 직후 지워집니다. 원격은 HTTPS, 로컬은 localhost
HTTP입니다. 연결 테스트는 실제 요청 1회로 모델 비용이 발생할 수 있습니다. 같은 엔진의
패널들은 모델 연결을 공유합니다. Resolve는 긴 요청을 엔진에서 처리하고 ‘생성 결과 확인’으로
결과를 받습니다. 모델 선택/키 입력을 위해 브라우저를 사용할 필요는 없습니다.

## Premiere 설치

1. Premiere **25.6+**, Adobe **UXP Developer Tool 2.2+**를 설치합니다.
2. Premiere Settings > Plugins > Enable developer mode를 켜고 재시작합니다.
3. ZIP을 풀거나 `plugins/premiere/`를 그대로 사용합니다.
4. UXP Developer Tool > Add Plugin에서 `manifest.json`을 선택하고 Load 합니다.
5. Premiere Window > UXP Plugins > editstyle을 엽니다. 패널은 도킹할 수 있습니다.
6. 엔진 연결 → 모델 연결 → 기본 러프컷 시퀀스 열기 → 타임라인 읽기.
7. 제안/직접 작성 → 프레임 범위 검토 → 적용 범위 확인 체크 → 새 시퀀스로 적용.

ZIP은 `.ccx`가 아닙니다. 실제 로드·검증 후 UXP Developer Tool 패키징 및 Adobe 배포 절차가
필요합니다. Marketplace 미등록. 로컬 엔진 네트워크 권한만 요청하며 셸·QE·ExtendScript는 쓰지 않습니다.

## Resolve Studio 설치

`plugins/resolve/`의 **Editstyle.py와 editstyle_resolve.py 둘 다** 같은 `Edit` 폴더에 넣습니다.

- macOS: `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/`
- Windows: `%APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Edit/`
- Linux: `~/.local/share/DaVinciResolve/Fusion/Scripts/Edit/`

Resolve Studio 20+를 재시작하고 Workspace > Scripts > Edit > Editstyle을 선택합니다.
Python 3 스크립팅이 필요하며 `bmd`, `UIManager`는 Resolve 내부 환경에서 제공합니다.
외부 Python이나 pip로 UIManager를 설치하지 않습니다. 엔진·모델 연결도 내부 창에서 합니다.
정확한 호환성은 설치된 Resolve Help > Documentation > Developer 문서와 실제 실행으로
확인해야 합니다. SDK 계약이 다르면 원본을 수정하지 않고 실패합니다.

## 첫 버전 제한

- 영상 한 트랙 + 같은 원본·인/아웃의 오디오 최대 한 트랙. 빈 트랙은 무시.
- 최대 80클립. 원본과 타임라인이 같은 고정 FPS, 정사각 픽셀, 일반 로컬 영상.
- 컷은 클립 안의 정수 프레임, 끝 제외. 원래 순서·비중첩. 빈 공간은 결과에서 제거.
- 별도 음악/J·L컷, 멀티캠/중첩/조정 레이어, 역재생/리타임, 전환, 비활성 클립 미지원.
- **효과·색보정·자막·오디오 볼륨/믹스·마커·채널 매핑은 새 러프컷에 복제하지 않습니다.**
  원본에는 그대로 남습니다. 원본 오디오는 mono/stereo 한 스트림만 지원합니다.
- 소스 타임코드는 파일 시작 기준 컷으로 바뀌며 결과 타임라인은 0에서 시작합니다.
- 스타일의 자막·색감·음악·전환 규칙은 아직 자동 적용하지 않습니다. 현재 실행 범위는
  **기본 컷 리듬 제안·검토·새 타임라인 생성**입니다.

## 검증·패키지

```bash
uv run --extra app --extra mcp python -m unittest tests.test_style_bridge tests.test_companion tests.test_host_bridge -v
node --test tests/test_premiere.cjs
uv run --extra dev ruff check editstyle plugins/resolve tests/test_host_bridge.py scripts/build-plugins.py
python3 scripts/build-plugins.py
```

산출물: `dist/plugins/editstyle-premiere-dev.zip`, `editstyle-resolve-dev.zip`, `checksums.json`.
원본 보존·컷 검증·연결 코드/Origin·키 비저장·모델 오류·stale 차단·실제 미디어 XML/OTIO
재읽기와 호스트 어댑터 계약을 테스트합니다. 실제 LLM 품질/UXP 렌더링/Resolve UIManager 및
편집기 실앱 결과는 별도입니다.

로컬 검증 기록: Python 회귀 27개 + Premiere JavaScript 계약 6개 통과, ruff·wheel/sdist·
개발 ZIP 빌드 통과. `scripts/qa-plugin-panel.cjs`는 실제 엔진·실제 FFmpeg 영상과 **호스트 대역**으로
연결 코드 오류·모델 미연결·수동 컷 수정·동의·타임라인 변경 차단·XML 생성·중복 적용 차단을
검증합니다. 380/320px 스크린샷과 브라우저 오류 0을 확인했고 실제 UXP 렌더링 검증은 아닙니다.

## 공식 근거 (2026-09-22 확인)

- [Adobe UXP 시작](https://developer.adobe.com/premiere-pro/uxp/plugins/): 버전·개발 모드·패널 로드.
- [Adobe 샘플 manifest](https://github.com/AdobeDocs/uxp-premiere-pro-samples/blob/main/sample-panels/premiere-api/public/manifest.json): manifest v5 구조.
- [Project API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project): importFiles/getSequences/openSequence.
- [Sequence API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequence): 타임베이스·트랙·프레임 크기.
- [Blackmagic 제품 관리자의 Studio UI 요건 설명](https://forum.blackmagicdesign.com/viewtopic.php?f=21&start=0&t=149311).
- Resolve 세부 스크립팅 계약의 기준은 **설치된 공식 Developer/Scripting/README.txt**입니다.
  이 Mac에는 SDK가 없어 설치본 대조/실행 검증은 남아 있습니다.
- CapCut 공식 도움말 검색에서 외부 개발자용 내부 패널 SDK를 확인하지 못했습니다.
  자체 ‘Plugins’ 메뉴나 마케팅 페이지를 개발자 SDK 제공 근거로 해석하지 않았습니다.
