#!/usr/bin/env python3
"""Loopback HTTP server for standalone knob probes.
POST .../responses answers one minimal successful Responses-API SSE turn
("ok"), so Codex finishes a turn and exits normally; everything else gets 400.
Usage: fail-server.py <port>"""
import http.server
import json
import sys

EVENTS = [
    {"type": "response.created", "response": {"id": "resp_probe"}},
    {"type": "response.output_item.done",
     "item": {"type": "message", "role": "assistant", "id": "msg_probe",
              "content": [{"type": "output_text", "text": "ok"}]}},
    {"type": "response.completed",
     "response": {"id": "resp_probe",
                  "usage": {"input_tokens": 1, "input_tokens_details": None, "output_tokens": 1,
                            "output_tokens_details": None, "total_tokens": 2}}},
]


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _fail(self):
        body = b'{"error":{"message":"egress probe: no model","type":"invalid_request_error"}}'
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._fail()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self.rfile.read(n)
        if not self.path.rstrip("/").endswith("/responses"):
            return self._fail()
        body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in EVENTS).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
