// Test-only Node preload (`NODE_OPTIONS=--import <this file's URL>`) that records
// each generated hook process: when Node started it, how long the hook took,
// its exit code, and its stdout and stderr. A harness that swallows a hook's
// output (Codex 0.156.1 prints only `hook: PreToolUse Failed`) leaves a failed
// playback drive with no cause; this record names one.
//
// It observes and never alters: writes still reach the real streams, and the
// exit listener changes no exit code. A process whose entry script is not a
// generated hook runtime (the harness's own Node launcher, a scripted `node -e`
// command) is ignored.
//
// Each hook process writes JSON Lines to `<HOOKNOSTIC_PLAYBACK_HOOK_LOG>.<pid>.jsonl`:
// a `start` record as it loads, `stdin` once its input has arrived, and `exit`
// as it leaves. A `start` without its `exit` is a process that died without
// running exit handlers (a native abort, or a kill on timeout). A hook the
// harness reported but which has no `start` record never reached JavaScript:
// it was killed while the OS was still starting it.
import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const logPath = process.env["HOOKNOSTIC_PLAYBACK_HOOK_LOG"];
const entry = process.argv[1] === undefined ? "" : basename(process.argv[1]);

if (logPath && /^hooknostic\.m?js$/.test(entry)) {
  // One file per process: hooks never share a handle, so one hook's write
  // cannot collide with another's.
  const path = `${logPath}.${process.pid}.jsonl`;
  const writeErrors = [];
  const record = (fields) => {
    const line = JSON.stringify({ pid: process.pid, ...fields, ...(writeErrors.length ? { writeErrors } : {}) });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        appendFileSync(path, line + "\n");
        return;
      } catch (error) {
        // A recorder failure must not become a hook failure. Windows can
        // refuse a write while another process (a scanner) holds the file;
        // wait briefly and retry, and say so in the next record.
        writeErrors.push(`${fields.phase}#${attempt}: ${error instanceof Error ? error.message : String(error)}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  };
  const tee = (stream) => {
    const chunks = [];
    const write = stream.write;
    stream.write = function (chunk, ...rest) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return write.call(this, chunk, ...rest);
    };
    return chunks;
  };

  // Milliseconds from Node's time origin to this preload running: Node's own
  // startup, before any hook code. It does not include process creation before
  // that origin (or the `cmd.exe` a harness may start first), which the
  // harness's own clock does include.
  const startedAt = Date.now();
  const bootMs = Math.round(performance.now());
  // The real stdout carries the protocol reply; the shim later redirects
  // `process.stdout` to stderr, whose writes are teed here too.
  const stdout = tee(process.stdout);
  const stderr = tee(process.stderr);
  const stdinChunks = [];
  const stdin = process.stdin;
  const push = stdin.push;
  stdin.push = function (chunk, ...rest) {
    if (chunk !== null && chunk !== undefined) {
      stdinChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    }
    return push.call(this, chunk, ...rest);
  };
  const nativeEvent = () => /"hook_event_name"\s*:\s*"([^"]+)"/.exec(stdinChunks.join(""))?.[1];

  record({ phase: "start", startedAt, bootMs, entry });
  // How far a process got matters most for one that never exits: input fully
  // received is the line between a slow start and a slow dispatch. An `end`
  // listener does not start the stream flowing.
  stdin.once("end", () => {
    record({ phase: "stdin", nativeEvent: nativeEvent(), atMs: Date.now() - startedAt + bootMs });
  });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    record({ phase: "uncaught", origin, error: error instanceof Error ? error.stack : String(error) });
  });
  process.on("exit", (code) => {
    record({
      phase: "exit",
      nativeEvent: nativeEvent(),
      code,
      durationMs: Date.now() - startedAt + bootMs,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    });
  });
}
