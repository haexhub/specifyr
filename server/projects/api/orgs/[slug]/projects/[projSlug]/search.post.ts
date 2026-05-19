import { spawn } from "node:child_process";
import { projectDir } from "@su/data-dirs";
import { searchCodeInput } from "@su/spec-tools-schemas";
import { parseBody } from "@su/validation";

/**
 * Code-search inside the project's working tree. Backs the browser-side
 * Speckit agent's `search_code` LLM tool.
 *
 * Implementation: spawn ripgrep with `--json` and stream the structured
 * output, collecting at most `limit` matches. The process is killed as
 * soon as we hit the cap so a hot query on a large repo doesn't pay for
 * the full scan.
 *
 * Why a child process and not a JS regex over fs.glob:
 *   - ripgrep is gitignore-aware out of the box (skips .git automatically,
 *     and respects .gitignore if present).
 *   - It's an order of magnitude faster on real-world trees.
 *
 * Security notes:
 *   - argv array passed to spawn → no shell, no quoting concerns. Query
 *     content can contain anything; it's an rg argument, not a command.
 *   - `-F` (fixed-strings) makes the query a literal substring match.
 *     The LLM doesn't have to think about regex escaping, and a query
 *     of "(.*)" doesn't degrade to a catastrophic regex.
 *   - `--no-config` ignores any user-level rg config that could change
 *     behaviour (e.g. globally enabling --no-ignore).
 *   - The glob param is already Zod-validated to forbid '..' segments.
 *     Even so, rg's --glob does NOT escape the cwd — paths matched are
 *     always relative to its working directory.
 *
 * Auth: `project-access` middleware gates the URL and populates
 * event.context.{orgId, projectSlug}.
 */
interface RgMatchEvent {
  type: "match";
  data: {
    path: { text?: string; bytes?: string };
    line_number: number;
    lines: { text?: string; bytes?: string };
  };
}

function decodePathField(field: { text?: string; bytes?: string }): string {
  if (typeof field.text === "string") return field.text;
  if (typeof field.bytes === "string") {
    return Buffer.from(field.bytes, "base64").toString("utf8");
  }
  return "";
}

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectSlug = event.context.projectSlug!;
  const { query, glob, limit } = await parseBody(event, searchCodeInput);

  const root = projectDir(orgId, projectSlug);

  const args: string[] = [
    "--json",
    "--no-config",
    "--no-messages",
    "-F", // fixed-strings: query is a literal substring
    "-g",
    "!.git",
    "-g",
    "!node_modules",
  ];
  if (glob) {
    args.push("-g", glob);
  }
  args.push("--", query);

  return await new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const matches: Array<{ path: string; line: number; snippet: string }> = [];
    let truncated = false;
    let buf = "";
    let killed = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (killed) return;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt: { type: string } | RgMatchEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          // ripgrep occasionally emits a non-JSON line if invoked oddly;
          // tolerate and continue.
          continue;
        }
        if (evt.type !== "match") continue;
        const m = evt as RgMatchEvent;
        const snippetRaw = decodePathField(m.data.lines);
        matches.push({
          path: decodePathField(m.data.path),
          line: m.data.line_number,
          snippet: snippetRaw.replace(/\r?\n$/, ""),
        });
        if (matches.length >= limit) {
          truncated = true;
          killed = true;
          child.kill("SIGTERM");
          break;
        }
      }
    });

    child.on("error", (err) => {
      reject(
        createError({
          statusCode: 500,
          statusMessage: `search failed: ${err.message}`,
        }),
      );
    });
    child.on("close", (code) => {
      // rg: 0 = matches, 1 = no matches, 2 = error. Our SIGTERM yields
      // code=null (or signal-based) — treat as success.
      if (code === 0 || code === 1 || code === null) {
        resolve({ matches, truncated });
      } else {
        reject(
          createError({
            statusCode: 500,
            statusMessage: `search exited ${code}`,
          }),
        );
      }
    });
  });
});
