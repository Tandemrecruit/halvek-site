"""Stand-ins for Turnstile's siteverify and ZeptoMail's send API, for local tests.

POST /siteverify          answers like Turnstile (mode: ok, fail, down)
POST /v1.1/email          records the email and answers like ZeptoMail (mode: ok, fail, fail_with_attachments)
POST /mode                {"siteverify": "...", "email": "...", "hostname": "..."}
GET  /emails              every email received so far, as JSON
POST /reset               forget emails and go back to ok/ok

Usage: python3 -I test/mock_server.py [port]
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

STATE = {"siteverify": "ok", "email": "ok", "hostname": "127.0.0.1", "emails": [], "verifications": []}
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive, like the real services

    def log_message(self, *args):
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        if self.path == "/emails":
            with LOCK:
                return self._send(200, {"emails": STATE["emails"], "verifications": STATE["verifications"]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        raw = self._body()
        if self.path == "/mode":
            with LOCK:
                STATE.update(json.loads(raw or b"{}"))
            return self._send(200, {"ok": True})
        if self.path == "/reset":
            with LOCK:
                STATE.update({"siteverify": "ok", "email": "ok", "hostname": "127.0.0.1", "emails": [], "verifications": []})
            return self._send(200, {"ok": True})
        if self.path == "/siteverify":
            form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            with LOCK:
                STATE["verifications"].append({k: form.get(k) for k in ("response", "remoteip", "idempotency_key")} | {"secret_set": bool(form.get("secret"))})
                mode, hostname = STATE["siteverify"], STATE["hostname"]
            if mode == "down":
                return self._send(503, {"error": "down"})
            if mode == "fail":
                return self._send(200, {"success": False, "error-codes": ["invalid-input-response"]})
            return self._send(200, {"success": True, "hostname": hostname, "action": "quote", "error-codes": [], "challenge_ts": "2026-10-15T00:00:00Z"})
        if self.path == "/v1.1/email":
            record = {"authorization": self.headers.get("Authorization"), "content_type": self.headers.get("Content-Type"), "bytes": len(raw)}
            try:
                record["payload"] = json.loads(raw)
            except ValueError as err:
                record["payload_error"] = str(err)
            with LOCK:
                STATE["emails"].append(record)
                mode = STATE["email"]
            if mode == "fail" or (mode == "fail_with_attachments" and (record.get("payload") or {}).get("attachments")):
                return self._send(400, {"error": {"code": "TM_5001", "details": [{"code": "LE_102", "message": "Credit exhausted"}], "message": "Credits exhausted"}})
            return self._send(200, {"data": [{"code": "EM_104", "additional_info": [], "message": "OK"}], "message": "OK", "request_id": "test"})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9911
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
