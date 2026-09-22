"""Install both files in Resolve's Fusion/Scripts/Edit directory; launch from Workspace > Scripts."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from editstyle_resolve import show  # noqa: E402


def main():
    resolve = globals().get("resolve")
    if not resolve:
        import DaVinciResolveScript as dvr
        resolve = dvr.scriptapp("Resolve")
    if not resolve:
        raise RuntimeError("Resolve Studio 안에서 실행하세요.")
    fusion = resolve.Fusion()
    # bmd is provided by Resolve's internal script runner, not a pip dependency.
    if not globals().get("bmd"):
        raise RuntimeError("Workspace > Scripts 메뉴에서 실행하세요. 외부 Python 실행은 지원하지 않습니다.")
    show(resolve, fusion, globals()["bmd"])


if __name__ == "__main__":
    main()
