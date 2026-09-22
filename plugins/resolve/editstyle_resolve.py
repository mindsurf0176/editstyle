"""Resolve Studio internal script support. Standard library only; host owns all edits."""

import json
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


class Bridge:
    def __init__(self):
        self.token = ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, body=None):
        request = urllib.request.Request(
            "http://127.0.0.1:18470/bridge" + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Editstyle-Plugin": self.token},
        )
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read(4096)).get("detail", "요청을 완료하지 못했습니다.")
            except (ValueError, TypeError):
                detail = "엔진 응답을 확인하세요."
            raise ValueError(detail) from None
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ValueError("로컬 엔진을 --plugins --no-browser로 실행하고 연결 코드를 확인하세요.") from exc


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ResolveHost:
    def __init__(self, resolve, bridge):
        self.resolve, self.bridge = resolve, bridge

    def active(self):
        project = self.resolve.GetProjectManager().GetCurrentProject()
        if not project or not project.GetCurrentTimeline():
            raise ValueError("Resolve에서 프로젝트와 타임라인을 여세요.")
        return project, project.GetCurrentTimeline()

    def capture(self):
        project, timeline = self.active()
        fps = float(timeline.GetSetting("timelineFrameRate"))
        for display, exact in ((23.976, 24000/1001), (29.97, 30000/1001), (59.94, 60000/1001)):
            if abs(fps - display) < .001:
                fps = exact
        with tempfile.TemporaryDirectory(prefix="editstyle-resolve-") as directory:
            path = Path(directory) / "snapshot.otio"
            if not timeline.Export(str(path), self.resolve.EXPORT_OTIO):
                raise ValueError("OTIO 내보내기에 실패했습니다. Resolve Studio 20+와 SDK를 확인하세요.")
            body = {"project_id": project.GetUniqueId(), "sequence_id": timeline.GetUniqueId(),
                    "name": timeline.GetName(), "fps": fps,
                    "width": int(timeline.GetSetting("timelineResolutionWidth")),
                    "height": int(timeline.GetSetting("timelineResolutionHeight")),
                    "otio": path.read_text(encoding="utf-8")}
        return self.bridge.request("/resolve/snapshots", body)

    def apply(self, prepared, expected):
        if self.capture()["snapshot"] != expected:
            raise ValueError("타임라인이 바뀌었습니다. 다시 읽고 검토하세요.")
        project, current = self.active()
        if project.GetUniqueId() != expected["project_id"] or current.GetUniqueId() != expected["sequence_id"]:
            raise ValueError("대상 프로젝트가 바뀌었습니다. 다시 읽고 검토하세요.")
        timeline = project.GetMediaPool().ImportTimelineFromFile(
            prepared["path"], {"timelineName": prepared["name"], "importSourceClips": True})
        if not timeline:
            raise ValueError("Resolve가 새 타임라인 가져오기를 완료하지 못했습니다. 원본은 유지됩니다.")
        if not project.SetCurrentTimeline(timeline):
            raise ValueError("타임라인은 생성됐습니다. 미디어 풀에서 여세요. 재적용하지 마세요.")
        return timeline.GetName()


def cut_text(proposal):
    return "\n".join(f"{c['clip_id']} {c['start']} {c['end']}" for c in proposal["cuts"])


def read_cuts(text, proposal):
    reasons = {c["clip_id"]: c["reason"] for c in proposal["cuts"]}
    cuts = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 3 or parts[0] not in reasons:
            raise ValueError("각 줄에 클립ID 시작프레임 끝프레임을 입력하세요.")
        try:
            start, end = int(parts[1]), int(parts[2])
        except ValueError as exc:
            raise ValueError("프레임은 정수로 입력하세요.") from exc
        cuts.append({"clip_id": parts[0], "start": start, "end": end, "reason": reasons[parts[0]]})
    if not cuts:
        raise ValueError("한 개 이상의 컷을 남겨야 합니다.")
    return {**proposal, "cuts": cuts}


def show(resolve, fusion, bmd):
    """UIManager window inside Resolve. No browser, external window framework or Qt dependency."""
    ui = fusion.UIManager
    if not ui:
        raise ValueError("내부 도구창에는 Resolve Studio가 필요합니다.")
    dispatcher = bmd.UIDispatcher(ui)
    window = dispatcher.AddWindow({"ID": "Editstyle", "WindowTitle": "editstyle · Resolve Studio · 개발 미리보기",
                                    "Geometry": [200, 120, 480, 820]}, [
        ui.VGroup([
            ui.Label({"Text": "editstyle", "Weight": 0}),
            ui.Label({"Text": "터미널: editstyle-app --plugins --no-browser", "Weight": 0}),
            ui.LineEdit({"ID": "Code", "PlaceholderText": "엔진 연결 코드", "EchoMode": "Password", "Weight": 0}),
            ui.Button({"ID": "Pair", "Text": "엔진 연결", "Weight": 0}),
            ui.Button({"ID": "ModelToggle", "Text": "내 모델 설정", "Weight": 0}),
            ui.VGroup({"ID": "ModelSettings", "Visible": False, "Weight": 0}, [
                ui.Label({"Text": "OpenAI 호환 API 주소 / 모델 이름 / API 키", "Weight": 0}),
                ui.LineEdit({"ID": "Endpoint", "Text": "http://localhost:11434/v1"}),
                ui.LineEdit({"ID": "Model", "PlaceholderText": "사용할 모델 이름"}),
                ui.LineEdit({"ID": "Key", "PlaceholderText": "API 키 · 로컬 모델은 선택", "EchoMode": "Password"}),
                ui.Label({"Text": "키는 메모리에만 보관합니다. 연결 테스트는 모델 요청 1회를 사용합니다.", "WordWrap": True}),
                ui.HGroup([ui.Button({"ID": "ConnectModel", "Text": "모델 연결 테스트"}),
                           ui.Button({"ID": "DisconnectModel", "Text": "연결 해제"})]),
            ]),
            ui.Label({"Text": "편집 스타일", "Weight": 0}),
            ui.ComboBox({"ID": "Style", "Weight": 0}),
            ui.Button({"ID": "Capture", "Text": "현재 타임라인 읽기", "Weight": 0}),
            ui.Label({"ID": "Sequence", "Text": "아직 타임라인을 읽지 않았습니다.", "WordWrap": True, "Weight": 0}),
            ui.LineEdit({"ID": "Instruction", "PlaceholderText": "예: 컷을 짧게 줄이되 마지막 컷은 길게 남겨줘", "Weight": 0}),
            ui.Label({"Text": "모델에는 클립 이름·길이·스타일·요청만 전송합니다. 영상·오디오·파일 경로는 전송하지 않습니다.", "WordWrap": True, "Weight": 0}),
            ui.HGroup([
                ui.Button({"ID": "Generate", "Text": "AI 컷 제안"}),
                ui.Button({"ID": "Poll", "Text": "생성 결과 확인"}),
                ui.Button({"ID": "Manual", "Text": "직접 작성"}),
            ]),
            ui.Label({"Text": "컷 검토: 각 줄에 클립ID 시작프레임 끝프레임 · 끝 제외\n범위 수정 또는 줄 삭제 후 적용하세요.", "WordWrap": True, "Weight": 0}),
            ui.TextEdit({"ID": "Cuts", "AcceptRichText": False, "Weight": 1}),
            ui.TextEdit({"ID": "Review", "ReadOnly": True, "Weight": 1}),
            ui.CheckBox({"ID": "Acknowledge", "Text": "컷·원본 오디오만 새 타임라인에 적용 (효과·색보정·자막·믹스 제외)", "Weight": 0}),
            ui.Button({"ID": "Apply", "Text": "새 타임라인으로 적용", "Weight": 0}),
            ui.Label({"ID": "Status", "Text": "엔진을 연결하세요. 원본 타임라인은 변경하지 않습니다.", "WordWrap": True, "Weight": 0}),
        ])
    ])
    items = window.GetItems()
    bridge = Bridge()
    host = ResolveHost(resolve, bridge)
    state = {"captured": None, "proposal": None, "styles": [], "job": None, "applied": False, "paired": False}

    def controls():
        ready = state["paired"] and state["captured"] is not None
        items["Capture"].Enabled = state["paired"] and not state["job"]
        items["Generate"].Enabled = ready and not state["job"]
        items["Manual"].Enabled = ready and not state["job"]
        items["Poll"].Enabled = state["job"] is not None
        items["Style"].Enabled = not state["job"]
        items["Pair"].Enabled = not state["job"]
        items["ConnectModel"].Enabled = state["paired"] and not state["job"]
        items["DisconnectModel"].Enabled = state["paired"] and not state["job"]
        items["Apply"].Enabled = bool(state["proposal"] and not state["applied"] and items["Acknowledge"].Checked)

    def wrap(action):
        def handler(event):
            try:
                action()
            except Exception as exc:
                items["Status"].Text = str(exc) if isinstance(exc, ValueError) else "호스트 작업에 실패했습니다. 원본은 유지됩니다. SDK와 프로젝트를 확인하세요."
            finally:
                controls()
        return handler

    def clear():
        state.update(proposal=None, applied=False)
        items["Cuts"].PlainText = ""
        items["Review"].PlainText = ""
        items["Acknowledge"].Checked = False

    def review(proposal):
        state["proposal"] = proposal
        items["Cuts"].PlainText = cut_text(proposal)
        names = {c["id"]: c["name"] for c in state["captured"]["snapshot"]["clips"]}
        items["Review"].PlainText = proposal["summary"] + "\n\n" + "\n".join(
            f"{c['clip_id']} · {names[c['clip_id']]} · {c['reason']}" for c in proposal["cuts"]
        ) + "\n\n" + "\n".join(proposal["notes"])
        items["Status"].Text = "컷 범위와 이유를 검토하세요. 아직 적용하지 않았습니다."

    def pair():
        state.update(paired=False, captured=None, job=None)
        clear()
        bridge.token = items["Code"].Text.strip()
        items["Code"].Text = ""
        result = bridge.request("/status")
        if result["protocol"] != 1:
            raise ValueError("엔진과 플러그인 버전이 맞지 않습니다.")
        state["styles"] = bridge.request("/styles")["styles"]
        items["Style"].Clear()
        for style in state["styles"]:
            items["Style"].AddItem(style["name"])
        state["paired"] = True
        items["Status"].Text = "엔진 연결됨 · " + (result["model"] or "모델 미연결. ‘내 모델 설정’ 또는 직접 작성을 사용하세요.")

    def model_toggle():
        items["ModelSettings"].Visible = not items["ModelSettings"].Visible
        items["Key"].Text = ""

    def connect_model():
        config = {"base_url": items["Endpoint"].Text, "model": items["Model"].Text,
                  "api_key": items["Key"].Text, "vision": False}
        items["Key"].Text = ""
        state["job"] = bridge.request("/model/connect-job", config)["job_id"]
        items["Status"].Text = "모델 연결 테스트 중입니다. 잠시 뒤 ‘생성 결과 확인’을 누르세요."

    def disconnect_model():
        bridge.request("/model/disconnect", {})
        items["Key"].Text = ""
        items["Status"].Text = "모델 연결을 해제하고 메모리의 키를 지웠습니다."

    def capture():
        state["captured"] = None
        clear()
        state["captured"] = host.capture()
        snapshot = state["captured"]["snapshot"]
        items["Sequence"].Text = f"{snapshot['name']} · {len(snapshot['clips'])}클립 · {snapshot['fps']:.3f}fps"
        items["Status"].Text = "타임라인을 읽었습니다. AI 제안 또는 직접 작성을 선택하세요."

    def manual():
        clear()
        review({"summary": "직접 작성한 러프컷", "notes": ["모델 미사용"], "cuts": [
            {"clip_id": c["id"], "start": 0, "end": c["duration"], "reason": "직접 검토"}
            for c in state["captured"]["snapshot"]["clips"]]})

    def generate():
        clear()
        job = bridge.request("/proposals", {"snapshot_id": state["captured"]["id"],
            "style_id": state["styles"][items["Style"].CurrentIndex]["id"], "instruction": items["Instruction"].Text})
        state["job"] = job["job_id"]
        items["Status"].Text = "엔진에서 생성 중입니다. 잠시 뒤 ‘생성 결과 확인’을 누르세요. Resolve는 계속 사용할 수 있습니다."

    def poll():
        result = bridge.request("/jobs/" + state["job"])
        if result["status"] == "running":
            items["Status"].Text = "아직 생성 중입니다. 잠시 뒤 다시 확인하세요."
            return
        state["job"] = None
        if result["status"] == "error":
            raise ValueError(result["detail"])
        if "connection" in result:
            items["ModelSettings"].Visible = False
            items["Status"].Text = "모델 연결됨 · " + result["connection"]["model"]
            return
        review(result["proposal"])

    def apply():
        if not items["Acknowledge"].Checked or state["applied"]:
            raise ValueError("적용 범위를 검토하세요. 이미 적용한 제안은 다시 읽어야 합니다.")
        proposal = read_cuts(items["Cuts"].PlainText, state["proposal"])
        current = host.capture()["snapshot"]
        prepared = bridge.request("/prepare", {"snapshot_id": state["captured"]["id"], "current": current,
            "proposal": proposal, "acknowledge_basic_cuts": True})
        state["applied"] = True
        name = host.apply(prepared, current)
        items["Status"].Text = "새 타임라인 생성: " + name + ". 재생하며 확인하세요."

    window.On.Pair.Clicked = wrap(pair)
    window.On.ModelToggle.Clicked = wrap(model_toggle)
    window.On.ConnectModel.Clicked = wrap(connect_model)
    window.On.DisconnectModel.Clicked = wrap(disconnect_model)
    window.On.Capture.Clicked = wrap(capture)
    window.On.Manual.Clicked = wrap(manual)
    window.On.Generate.Clicked = wrap(generate)
    window.On.Poll.Clicked = wrap(poll)
    window.On.Apply.Clicked = wrap(apply)
    window.On.Style.CurrentIndexChanged = wrap(clear)
    window.On.Acknowledge.Clicked = wrap(controls)
    window.On.Cuts.TextChanged = wrap(lambda: setattr(items["Acknowledge"], "Checked", False))
    window.On.Editstyle.Close = lambda event: dispatcher.ExitLoop()
    controls()
    window.Show()
    dispatcher.RunLoop()
    window.Hide()
