# editstyle 로컬 보조앱

2026-09-22 · 첫 구현. 독립 편집기 UI를 확장하지 않고 기존 editstyle Python
패키지에 별도 실행 진입점과 로컬 작업실을 추가했다.

## 실행

```bash
uv sync --extra app
uv run --extra app editstyle-app
# 브라우저 자동 열기 없이:
uv run --extra app editstyle-app --no-browser --port 18470
# 테스트용 저장 위치:
uv run --extra app editstyle-app --data-dir out/app-workspace
```

FFmpeg/FFprobe가 PATH에 있어야 한다. macOS는 `brew install ffmpeg`.
기본 데이터 경로는 `~/.editstyle`이며 스타일·업로드 원본·작업용 사본·편집 제안·
내보내기가 저장된다. 영상 원본과 결과가 남으므로 작업량에 따라 디스크가 늘어난다.
작업을 지울 때는 앱을 종료한 뒤 해당 데이터 폴더를 사용자가 관리한다.

## 모델 연결과 데이터 전달

- 지원 규격: OpenAI-compatible `/chat/completions`. 서버 기본 주소에 `/v1`을
  포함한다. LM Studio와 Ollama의 호환 API를 연결할 수 있지만 실제 모델이
  설치/실행되어 있어야 한다. 특정 공급자 전용 API나 챗봇 구독 로그인은 지원하지 않는다.
- API 키는 서버 메모리에만 있다. 파일/localStorage/응답/로그에 저장하지 않는다.
  종료 또는 연결 해제로 지워진다. 여러 브라우저 탭은 같은 로컬 앱 연결을 공유한다.
- 연결 확인은 짧은 실제 생성 요청 한 번이다. 사용료는 모델 공급자가 책정한다.
- 생성 요청에는 지시, 선택한 스타일, 영상 길이와 컷 후보가 포함된다. 프레임 전달은
  체크박스로 선택하며 8개의 640px JPEG와 각각의 시간만 보낸다. 원본 영상/오디오/
  로컬 파일 경로는 보내지 않는다. 사용량 토큰은 공급자가 반환한 값을 제안에 기록한다.
- 원격 주소는 HTTPS만, HTTP는 localhost/127.0.0.1/::1만 허용한다.
  키를 보낸 요청의 리다이렉트는 따라가지 않는다.
- 앱은 loopback에만 바인딩하고 Host/Origin/요청 토큰을 확인한다. 외부 웹 배포용
  인증 서비스가 아니다.

## 실제 처리 범위

1. 최대 10분/512MB 영상을 가져와 원본을 보존하고, 최대 1280px/30fps H.264
   작업용 사본을 만든다. 오디오는 있을 때만 stereo AAC로 정규화한다.
2. FFmpeg scene difference threshold 0.3으로 컷 후보를 찾고 8개 프레임을 샘플링한다.
   컷 후보는 의미나 전환의 정답이 아니다.
3. 모델의 스타일 초안은 저장 전 편집할 수 있다. 관측/추론/미확인 항목을 구분하도록
   요청하며, 오디오가 제공되지 않았다는 점을 명시한다.
4. 모델의 편집 제안은 시간순/비중첩/원본 범위/최소 1프레임을 검증한다. 초 단위
   입력은 30fps 프레임 경계로 정규화한다. 자막은 설명용이며 전사 결과가 아니다.
5. 수정은 새 ID로 저장한다. 변경 중에는 내보내기를 막고, 새 제안을 불러오면 이전
   다운로드 표시를 무효화한다. ZIP은 검토한 제안의 고정된 사본이다.

## 편집기별 전달

| 대상 | 제공 파일 | 남은 확인 |
|---|---|---|
| Premiere Pro | FCP7 XML + source.mp4, SRT 별도 | 실제 가져오기, 오디오 채널·자막 싱크 |
| DaVinci Resolve | 같은 XML 또는 OTIO, SRT 별도 | 실제 가져오기, 프레임/오디오 일치 |
| CapCut Desktop/Web | 번호순 클립 + SRT + cuts.csv | 클립 수동 배치, 자막 스타일 지정 |

XML은 생성된 묶음의 로컬 source.mp4 절대 경로를 참조한다. ZIP을 다른 경로/PC로
옮기면 함께 든 source.mp4로 다시 연결해야 한다. CapCut 네이티브 프로젝트를
생성하지 않으며, 자동 타임라인 가져오기 지원을 주장하지 않는다.

자동 적용: 컷, 원본 오디오 유지, 편집 후 시간 기준 SRT. 미적용: 색보정, 전환 효과,
BGM 생성/선택, 자막 서체/애니메이션. preview.mp4는 자막 없는 컷 검토본이다.
SRT가 빈 경우 제안에 자막이 없다는 뜻이다. 자세한 가져오기 방법은 각 ZIP의
IMPORT.md에도 있다.

## 검증 기록

- 기존 스타일/MCP 테스트 8개와 보조앱 테스트 8개. 보조앱 테스트에는 실제 FFmpeg
  변환, 오디오/무음 렌더, 수정 버전, SRT 시간 이동, XML·OTIO 재읽기,
  잘못된 범위 차단, Host/Origin/토큰 검증, API 키 응답/파일 미노출이 포함된다.
- 공급자 호출 테스트는 HTTP transport fixture와 응답 fixture를 사용한다. 실제
  유료/로컬 LLM 추론 품질 검증이 아니다. 작업 머신의 Ollama에는 설치 모델이 없다.
- Playwright로 실제 앱/FFmpeg 경로에서 스타일 작성 → 공개 Big Buck Bunny 샘플
  가져오기 → 컷/자막 수정 → 새 버전 저장 → 5초 미리보기 재생 → ZIP 다운로드 →
  새로고침 복구 확인. 데스크톱/390px 화면 확인, 브라우저 오류 0.
- 실앱 Premiere/Resolve/CapCut 가져오기, 영상 스타일 재현 품질, 사용자 BYOK 모델
  연결은 별도 검증이 필요하다. 현재 앱은 모델 설정 후 그 검증을 진행할 수 있는 상태다.

출처: [LM Studio 호환 API](https://lmstudio.ai/docs/developer/openai-compat),
[CapCut 자막 가져오기](https://www.capcut.com/help/how-to-import-subtitles),
[OTIO FCP 어댑터 지원 범위](https://github.com/OpenTimelineIO/otio-fcp-adapter),
[FFmpeg 필터](https://ffmpeg.org/ffmpeg-filters.html).
