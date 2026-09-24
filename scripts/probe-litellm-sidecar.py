"""Exercise the workflow's proxy config against a loopback-only model stub.

Run with: uv run --with-requirements .github/requirements/litellm.txt python scripts/probe-litellm-sidecar.py
No harness binaries, model credentials, or paid model calls are used.
"""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        # Native Responses/Messages requests must be translated by the sidecar.
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        response = {
            "id": "chatcmpl-local-proof",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "readiness-probe",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        if payload.get("stream"):
            response["object"] = "chat.completion.chunk"
            response["choices"] = [{"index": 0, "delta": {"role": "assistant", "content": "pong"}, "finish_reason": None}]
            first = json.dumps(response)
            response["choices"] = [{"index": 0, "delta": {}, "finish_reason": "stop"}]
            data = f"data: {first}\n\ndata: {json.dumps(response)}\n\ndata: [DONE]\n\n".encode()
            content_type = "text/event-stream"
        else:
            data = json.dumps(response).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    config = Path(__file__).resolve().parent.parent / ".github" / "litellm.json"
    executable = shutil.which("litellm")
    if executable is None:
        raise RuntimeError("Run with the requirements command in this file's docstring")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = dict(
        os.environ,
        OPENAI_API_KEY="local-only-not-a-real-key",
        HARNESS_LLM_MODEL="readiness-probe",
        HARNESS_LLM_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
        LITELLM_LOCAL_MODEL_COST_MAP="True",
        PYTHONUTF8="1",
    )
    with tempfile.TemporaryDirectory(prefix="hooknostic-sidecar-") as scratch:
        log_path = Path(scratch) / "proxy.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [executable, "--config", str(config), "--host", "127.0.0.1", "--port", str(port)],
                env=env, stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                for _ in range(60):
                    try:
                        with urllib.request.urlopen(base + "/health", timeout=2) as response:
                            assert response.status == 200
                        break
                    except Exception:
                        if process.poll() is not None:
                            raise RuntimeError("Proxy exited before becoming healthy")
                        time.sleep(1)
                else:
                    raise RuntimeError("Proxy health timeout")
                probes = [
                    ("/v1/chat/completions", {"messages": [{"role": "user", "content": "ping"}], "max_tokens": 16}),
                    ("/v1/messages", {"messages": [{"role": "user", "content": "ping"}], "max_tokens": 16}),
                    ("/v1/responses", {"input": "ping", "max_output_tokens": 16}),
                ]
                for route, payload in probes:
                    for stream in (False, True):
                        request = urllib.request.Request(
                            base + route,
                            data=json.dumps(dict(payload, model="readiness-probe", stream=stream)).encode(),
                            headers={"Content-Type": "application/json", "Authorization": "Bearer hooknostic-drift",
                                     "x-api-key": "hooknostic-drift", "anthropic-version": "2023-06-01"},
                        )
                        with urllib.request.urlopen(request, timeout=20) as response:
                            body = response.read().decode()
                            assert response.status == 200 and "pong" in body, (route, stream, body)
                        print(f"{route} stream={stream}: 200 pong", flush=True)
            except Exception:
                print(log_path.read_text(encoding="utf-8", errors="replace")[-8000:])
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                server.shutdown()


if __name__ == "__main__":
    main()
