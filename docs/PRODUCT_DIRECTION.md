# editstyle 보조앱 방향 — 검토안

> 2026-09-22 후속: 사용자가 바로 구현을 승인했다. 로컬 보조앱 첫 버전은
> [COMPANION.md](COMPANION.md)에 기록한다. 아래 미구현 표기는 구현 전의 역사 기록이다.

2026-09-22. 사용자가 CutAI를 editstyle로 이름 변경했고, 지원 대상으로
DaVinci Resolve·Premiere Pro·CapCut을 지정했다. 이어서 “어디든 붙이는 AI 편집
확장앱, LLM 모델은 사용자가 지정”하는 제품 형태를 제안했다. 앱 UI나 BYOK
연결을 구현했다고 해석하지 않는다.

## 권장 형태

편집 도구 옆에서 실행하는 스타일 중심 AI 보조앱. 사용자는 모델 연결을 설정하고,
레퍼런스/직접 작성한 취향을 스타일로 저장하며, 원본 영상에 맞춘 제안을 검토한다.
앱은 가능한 조작을 대상 편집기에 전달하고 실제 적용 결과를 표시한다.

- 재사용할 자산: EDITSTYLE.md, 스타일 라이브러리, 관측 근거, 수정 이력.
- 모델: 사용자 API 키·모델 이름·지원되는 공급자/서버 주소를 지정하는 BYOK.
- 호스트: 독립 데스크톱 보조앱이 첫 후보. 편집기 내부 플러그인은 어댑터별 후속 후보.
- 연결: 스킬/MCP, 편집기 API, 가져오기 파일을 지원 수준에 따라 구분한다.
- 모델 설정을 바꿔도 기존 스타일과 편집 프로젝트를 재사용한다.

API 키 사용과 소비자용 챗봇 구독 연결은 별도 기능이다. 키 저장·모델 API 호출·
영상/오디오 전송 범위와 비용 표시 설계가 필요하며 현재 구현은 없다.

## 범용 연결의 현실적인 범위

- Premiere·Resolve: FCP7 XML 등을 통한 편집 가능한 타임라인 교환을 조사했다.
  실제 앱에서 가져오기 검증 전이며, 효과·자막 서체까지 그대로 이식된다는 뜻이 아니다.
- CapCut: 공식 안내에서 Desktop/Web의 SRT 가져오기 확인. 현재 일반적인 XML
  타임라인 가져오기나 외부 제어 API는 확인하지 못했다. 번호순 클립·SRT·컷 목록
  또는 지원되는 조작 방식으로 범위를 정해야 한다. 완전한 편집기 연동으로 표시하지 않는다.
- OpenTimelineIO FCP 어댑터는 컷·오디오·마커를 지원하지만 효과와 전환은 미지원으로
  명시한다. 아직 프로젝트에 설치하거나 내보내기 기능을 구현하지 않았다.

근거:
- https://www.capcut.com/help/how-to-import-subtitles
- https://helpx.adobe.com/pdf/cs6/premiere_pro_reference.pdf (기존 XML 교환 근거, 오래된 문서)
- https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_10_Reference_Manual.pdf (기존 XML 교환 근거, 오래된 문서)
- https://github.com/OpenTimelineIO/otio-fcp-adapter

## 현재 구현과 보류한 작업

- 완료: editstyle 리브랜딩, 경량 Python 패키지/CLI, 스타일 문서 읽기 MCP, 스킬.
- 두 스타일 비교: 사용자 제안에 따라 구현 중단. 공개 Big Buck Bunny 샘플
  90–126초 구간을 `out/style-comparison/source.mp4`에 준비하고 컷 경계와
  컨택트 시트를 확인했으나 스타일 적용/비교본은 만들지 않았다.
- 예전 IMG_4704.MOV는 iCloud dataless 상태이며 ffprobe에서 읽기 timeout.
- BYOK 및 보조앱은 검토 단계. 편집기 조작/내보내기 기능도 미구현.

다음 의사결정은 공통 보조앱의 첫 사용자 흐름과 모델 연결 범위다. 이 검토안이
확정되면 실제 레퍼런스 → 스타일 저장 → 같은 원본의 두 편집 결과 비교로 검증한다.
