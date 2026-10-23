// Child-process host for the capture MCP transports.
//
// usage: node mcp-transport-runner.mjs <logPath>
//
// Prints {"port":N} once listening, records every request as JSON lines in
// <logPath>, and exits on SIGTERM. It has to be a separate process: the driver
// runs Copilot with spawnSync, which would block an in-process server's event
// loop and every connection would hang.
import { startMcpTransports } from "./mcp-transport-server.mjs";

const logPath = process.argv[2];
const server = await startMcpTransports({ logPath });
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
