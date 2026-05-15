import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_PORT } from "../core/constants.js";
import { SpecOrchestrator } from "../core/orchestrator.js";

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(response, statusCode, value, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(value);
}

export function createUiHandler(options = {}) {
  const orchestrator = options.orchestrator ?? new SpecOrchestrator({ cwd: options.cwd });
  const cwd = options.cwd ?? process.cwd();
  const publicDir = path.join(cwd, "public");

  return async function handler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/projects") {
      sendJson(response, 200, await orchestrator.listProjects());
      return;
    }

    const projectMatch = /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)$/.exec(url.pathname);
    if (projectMatch) {
      const [, orgId, slug] = projectMatch;
      try {
        sendJson(response, 200, await orchestrator.projectSnapshot(orgId, slug));
      } catch (error) {
        sendJson(response, 404, { error: error.message });
      }
      return;
    }

    const assetPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.join(publicDir, assetPath);
    try {
      const content = await readFile(filePath);
      const extension = path.extname(filePath);
      const contentType =
        extension === ".css"
          ? "text/css; charset=utf-8"
          : extension === ".js"
            ? "application/javascript; charset=utf-8"
            : "text/html; charset=utf-8";
      sendText(response, 200, content, contentType);
    } catch {
      sendJson(response, 404, { error: "Not found" });
    }
  };
}

export async function startUiServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? "127.0.0.1";
  const server = http.createServer(createUiHandler(options));

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    port: resolvedPort,
    host,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}
