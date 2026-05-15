import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { runGitInProject } from "@su/git-remote";
import { assertRemoteSafe } from "@su/git-clone";
import { parseBody } from "@su/validation";

const bodySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  username: z.string().trim().min(1).max(255),
  token: z.string().min(1).max(4096),
});

/**
 * Probes the remote with `git ls-remote --heads` over a one-shot
 * `cwd: /tmp` so the request never touches the project tree. The
 * caller's PAT is injected via http.extraHeader (per-call only) and
 * scrubbed from any error output.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  const body = await parseBody(event, bodySchema);

  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: "only https:// remote URLs are supported",
    });
  }
  if (parsed.protocol !== "https:") {
    throw createError({
      statusCode: 400,
      statusMessage: "only https:// remote URLs are supported",
    });
  }
  if (parsed.username || parsed.password) {
    throw createError({
      statusCode: 400,
      statusMessage: "remote URL must not contain inline credentials",
    });
  }
  try {
    await assertRemoteSafe(parsed);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: (err as Error).message,
    });
  }

  const result = await runGitInProject({
    cwd: "/tmp",
    args: ["ls-remote", "--heads", body.url],
    bearerToken: body.token,
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    return { ok: false, message: result.stderr.trim() || "connection failed" };
  }
  const refs = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => l.split(/\s+/)[1] ?? l);
  return { ok: true, refs };
});
