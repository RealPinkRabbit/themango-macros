"""LCD 알림판용 웹서버 — 표준 라이브러리만 사용(추가 의존성 0, RAM 사용 최소).

- GET  /            대시보드 HTML
- GET  /events      SSE 스트림 (알림 즉시 푸시)
- GET  /api/state   현재 상태 JSON
- POST /api/ack     알림 확인(소리 정지)
- POST /api/test    테스트 알림 발생
"""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .events import Event

log = logging.getLogger("web")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "web_static")


class Hub:
    """SSE 구독자 관리."""

    def __init__(self):
        self._clients = set()
        self._lock = threading.Lock()

    def register(self) -> queue.Queue:
        q = queue.Queue(maxsize=50)
        with self._lock:
            self._clients.add(q)
        return q

    def unregister(self, q):
        with self._lock:
            self._clients.discard(q)

    def broadcast(self, payload: dict):
        data = json.dumps(payload, ensure_ascii=False)
        with self._lock:
            clients = list(self._clients)
        for q in clients:
            try:
                q.put_nowait(data)
            except queue.Full:
                pass

    @property
    def count(self) -> int:
        with self._lock:
            return len(self._clients)


class WebServer:
    def __init__(self, cfg, bus, notifier, status_fn):
        self.cfg = cfg
        self.bus = bus
        self.notifier = notifier
        self.status_fn = status_fn          # () -> dict
        self.hub = Hub()
        self._httpd = None
        bus.subscribe(lambda ev: self.hub.broadcast({"type": "event", "event": ev.to_dict()}))

    def start(self):
        host = str(self.cfg.get("web.host", "0.0.0.0"))
        port = int(self.cfg.get("web.port", 8080))
        handler = _make_handler(self)
        self._httpd = ThreadingHTTPServer((host, port), handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, name="web", daemon=True).start()
        threading.Thread(target=self._heartbeat, name="web-hb", daemon=True).start()
        log.info("대시보드: http://%s:%d", host, port)

    def stop(self):
        if self._httpd:
            self._httpd.shutdown()

    def _heartbeat(self):
        while True:
            time.sleep(10)
            try:
                self.hub.broadcast({"type": "status", "status": self.status_fn()})
            except Exception:
                log.debug("상태 브로드캐스트 실패", exc_info=True)


def _make_handler(server: WebServer):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):      # 접근 로그는 저널을 더럽히므로 끔
            pass

        # ---------------------------------------------------------- helpers
        def _send(self, code, body: bytes, ctype="text/plain; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        # ---------------------------------------------------------- GET
        def do_GET(self):
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                try:
                    with open(os.path.join(STATIC_DIR, "index.html"), "rb") as f:
                        self._send(200, f.read(), "text/html; charset=utf-8")
                except OSError:
                    self._send(500, b"index.html missing")
            elif path == "/api/state":
                self._json({"status": server.status_fn(), "recent": server.bus.recent(20)})
            elif path == "/events":
                self._sse()
            else:
                self._send(404, b"not found")

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            # Content-Length 를 줄 수 없는 무한 스트림이므로 '연결 종료 = 스트림 끝' 방식으로 간다.
            # (HTTP/1.1 keep-alive 로 두면 브라우저가 본문 끝을 판단하지 못한다)
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            q = server.hub.register()
            try:
                init = json.dumps({"type": "init", "status": server.status_fn(),
                                   "recent": server.bus.recent(20)}, ensure_ascii=False)
                self.wfile.write(f"data: {init}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        data = q.get(timeout=15)
                        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")     # 연결 유지
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                server.hub.unregister(q)

        # ---------------------------------------------------------- POST
        def do_POST(self):
            path = self.path.split("?")[0]
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            if path == "/api/ack":
                ok = server.notifier.ack()
                server.hub.broadcast({"type": "ack"})
                self._json({"ok": True, "cleared": ok})
            elif path == "/api/test":
                server.bus.publish(Event("new_order", "테스트 알림", "확인 버튼을 눌러 보세요", 1))
                self._json({"ok": True})
            else:
                self._send(404, b"not found")

    return Handler
