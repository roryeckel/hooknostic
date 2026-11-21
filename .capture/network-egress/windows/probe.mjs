#!/usr/bin/env node
// Connectivity probe for the Windows measurement and the firewall trials.
// Prints one JSON line: public IPv4 connects, a DNS lookup, an HTTPS fetch,
// and a loopback round trip through a server in this same process. Inside
// the audited step it is also the positive control: its connections must
// appear in the summary, attributed to the lane, or the audit missed them.
//   node probe.mjs [label]
import { lookup } from "node:dns/promises";
import { createServer, connect } from "node:net";

const label = process.argv[2] ?? "probe";
const TIMEOUT_MS = 5000;

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result) => {
      globalThis.clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = globalThis.setTimeout(() => done("TIMEOUT"), TIMEOUT_MS);
    socket.once("connect", () => done("connected"));
    socket.once("error", (error) => done(error.code ?? error.message));
  });
}

async function loopback() {
  const server = createServer((socket) => socket.end("pong"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const result = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    const timer = globalThis.setTimeout(() => {
      socket.destroy();
      resolve("TIMEOUT");
    }, TIMEOUT_MS);
    socket.on("data", (chunk) => (data += chunk));
    socket.once("end", () => {
      globalThis.clearTimeout(timer);
      resolve(data === "pong" ? "round-trip" : `unexpected:${data}`);
    });
    socket.once("error", (error) => {
      globalThis.clearTimeout(timer);
      resolve(error.code ?? error.message);
    });
  });
  server.close();
  return result;
}

async function dns(host) {
  try {
    return `resolved:${(await lookup(host)).address}`;
  } catch (error) {
    return error.code ?? error.message;
  }
}

async function https(url) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return `status:${response.status}`;
  } catch (error) {
    return error.cause?.code ?? error.name ?? "error";
  }
}

const [v4a, v4b, v4c, resolved, fetched, loop] = await Promise.all([
  tcp("1.1.1.1", 443),
  tcp("8.8.8.8", 443),
  tcp("9.9.9.9", 443),
  dns("github.com"),
  https("https://github.com/"),
  loopback(),
]);
console.log(
  JSON.stringify({ probe: label, pid: process.pid, ipv4: [v4a, v4b, v4c], dns: resolved, https: fetched, loopback: loop }),
);
