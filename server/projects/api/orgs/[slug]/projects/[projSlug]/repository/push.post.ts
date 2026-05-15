import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { getProjectRepository, setLastPushedAt } from "@su/project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "@su/secrets-store";
import { configureRemote, commitAndPush } from "@su/git-remote";
import { projectDir } from "@su/data-dirs";
import { parseBody } from "@su/validation";

const bodySchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .default("specifyr: workflow progress"),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);
  const { message } = await parseBody(event, bodySchema);

  const cfg = await getProjectRepository(orgId, slug);
  if (!cfg) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository not configured.",
    });
  }
  const secrets = await getProjectSecrets(orgId, slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) {
    throw createError({
      statusCode: 400,
      statusMessage: "Repository token missing.",
    });
  }

  const projectRoot = projectDir(orgId, slug);
  try {
    await configureRemote(projectRoot, cfg.url);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: (err as Error).message,
    });
  }
  const result = await commitAndPush({
    projectRoot,
    branch: cfg.branch,
    message,
    bearerToken: token,
  });
  if (!result.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: result.stderr || "push failed",
    });
  }
  if (result.pushed) {
    // Metadata update must not fail the push: a successful push that
    // can't record its timestamp is still a successful push. Mirrors
    // the behaviour of repository-autosync.ts.
    await setLastPushedAt(orgId, slug, new Date().toISOString()).catch(() => {});
  }
  return { ok: true, pushed: result.pushed };
});
