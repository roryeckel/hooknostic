// Read-only npm protocol fixture. Serves an existing pnpm tarball; never publishes.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function startRegistry(manifest, tarball) {
  const requests = [];
  let baseUrl;
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url);
    requests.push({ method: req.method, path });
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (path === "/fixture.tgz") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(tarball);
    } else if (path === `/${manifest.name}` || path === `/${manifest.name}/${manifest.version}`) {
      const version = { ...manifest, dist: { tarball: baseUrl + "/fixture.tgz",
        shasum: createHash("sha1").update(tarball).digest("hex"),
        integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64") } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(path.endsWith(`/${manifest.version}`) ? version : {
        name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version },
      }));
    } else { res.writeHead(404); res.end(JSON.stringify({ error: "Fixture package not found" })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
