/*
 * GM_* 호환 계층 — 기존 Tampermonkey 유저스크립트를 파이에서 그대로 굴리기 위한 shim.
 *
 * 왜 Tampermonkey 를 안 쓰나
 *   확장 설치 UI, 스토어 로그인, 확장 내부 저장소에 스크립트를 심는 과정이 전부 수작업이라
 *   무인 운영에서 재현이 안 된다. 대신 CDP(Page.addScriptToEvaluateOnNewDocument)로
 *   document-start 시점에 이 shim + 유저스크립트를 직접 주입한다.
 *   (팝업/새 창에도 자동으로 적용된다)
 *
 * 지원: GM_setValue / GM_getValue / GM_deleteValue / GM_listValues / GM_addStyle /
 *       GM_xmlhttpRequest / GM_download / GM_openInTab / GM_registerMenuCommand(무시) /
 *       GM_log / GM_info / unsafeWindow / GM.* (Promise 버전)
 * 미지원: @require, @resource, 크로스오리진 쿠키 강제 등 — 필요해지면 여기에 추가할 것.
 */
(function () {
  if (window.__TMG_GM_SHIM__) return;
  window.__TMG_GM_SHIM__ = true;

  var PREFIX = "__gm__";
  var mem = {};                      // localStorage 를 못 쓰는 경우 대비

  function store() {
    try { window.localStorage.getItem("x"); return window.localStorage; }
    catch (e) { return null; }
  }

  window.unsafeWindow = window;

  window.GM_setValue = function (k, v) {
    var s = JSON.stringify(v);
    var ls = store();
    if (ls) { try { ls.setItem(PREFIX + k, s); return; } catch (e) {} }
    mem[k] = s;
  };
  window.GM_getValue = function (k, def) {
    var ls = store(), raw = null;
    if (ls) { try { raw = ls.getItem(PREFIX + k); } catch (e) {} }
    if (raw === null || raw === undefined) raw = (k in mem) ? mem[k] : null;
    if (raw === null || raw === undefined) return def;
    try { return JSON.parse(raw); } catch (e) { return def; }
  };
  window.GM_deleteValue = function (k) {
    var ls = store();
    if (ls) { try { ls.removeItem(PREFIX + k); } catch (e) {} }
    delete mem[k];
  };
  window.GM_listValues = function () {
    var out = [], ls = store();
    if (ls) {
      try {
        for (var i = 0; i < ls.length; i++) {
          var key = ls.key(i);
          if (key && key.indexOf(PREFIX) === 0) out.push(key.slice(PREFIX.length));
        }
      } catch (e) {}
    }
    Object.keys(mem).forEach(function (k) { if (out.indexOf(k) < 0) out.push(k); });
    return out;
  };

  window.GM_addStyle = function (css) {
    var s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  };

  window.GM_log = function () { console.log.apply(console, arguments); };
  window.GM_registerMenuCommand = function () { /* 무인 운영이라 메뉴 없음 */ };
  window.GM_openInTab = function (url) { return window.open(url, "_blank"); };

  window.GM_xmlhttpRequest = function (o) {
    o = o || {};
    var ctrl = { abort: function () {} };
    var headers = o.headers || {};
    var init = {
      method: o.method || "GET",
      headers: headers,
      body: o.data,
      credentials: o.anonymous ? "omit" : "include"
    };
    if (typeof AbortController === "function") {
      var ac = new AbortController();
      init.signal = ac.signal;
      ctrl.abort = function () { ac.abort(); };
    }
    fetch(o.url, init).then(function (r) {
      var take = r.text();
      if (o.responseType === "blob") take = r.blob();
      else if (o.responseType === "arraybuffer") take = r.arrayBuffer();
      else if (o.responseType === "json") take = r.json();
      return take.then(function (body) {
        var res = {
          status: r.status,
          statusText: r.statusText,
          finalUrl: r.url,
          readyState: 4,
          responseHeaders: (function () {
            var s = ""; r.headers.forEach(function (v, k) { s += k + ": " + v + "\r\n"; }); return s;
          })(),
          responseText: (typeof body === "string") ? body : "",
          response: body
        };
        if (typeof o.onload === "function") o.onload(res);
      });
    }).catch(function (e) {
      if (typeof o.onerror === "function") o.onerror({ error: String(e), status: 0 });
    });
    return ctrl;
  };

  window.GM_download = function (o) {
    var url = (typeof o === "string") ? o : o.url;
    var name = (typeof o === "object" && o.name) ? o.name : "";
    var a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 1000);
    if (typeof o === "object" && typeof o.onload === "function") o.onload();
  };

  window.GM_info = {
    scriptHandler: "tmg-alert-shim",
    version: "1.0.0",
    script: { name: "injected", version: "0", namespace: "tmg-alert" }
  };

  // Promise 스타일 GM.* 도 제공
  window.GM = {
    setValue: function (k, v) { return Promise.resolve(window.GM_setValue(k, v)); },
    getValue: function (k, d) { return Promise.resolve(window.GM_getValue(k, d)); },
    deleteValue: function (k) { return Promise.resolve(window.GM_deleteValue(k)); },
    listValues: function () { return Promise.resolve(window.GM_listValues()); },
    addStyle: function (c) { return Promise.resolve(window.GM_addStyle(c)); },
    xmlHttpRequest: window.GM_xmlhttpRequest,
    openInTab: window.GM_openInTab,
    info: window.GM_info
  };
})();
