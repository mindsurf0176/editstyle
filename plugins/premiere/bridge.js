"use strict";
function createBridge(fetcher) {
  let token = "";
  return {
    pair(value) { token = value.trim(); },
    async request(path, body) {
      let response;
      try {
        response = await fetcher("http://127.0.0.1:18470/bridge" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json", "X-Editstyle-Plugin": token },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (_) { throw new Error("로컬 엔진에 연결하지 못했습니다. editstyle-app --plugins --no-browser를 실행하세요."); }
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "요청을 완료하지 못했습니다.");
      return result;
    }
  };
}
module.exports = { createBridge };
