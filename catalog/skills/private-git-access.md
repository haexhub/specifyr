---
id: private-git-access
name: "Private Git Access"
description: >
  Teaches an agent how to authenticate against private GitHub or GitLab
  repositories using a token injected via environment variable. Add this
  skill to any agent that needs to clone, fetch, or push to private repos.
  Requires secrets:read_env capability and GITHUB_TOKEN or GITLAB_TOKEN
  set as a project secret.
tags:
  - vcs
  - credentials
---

# Private Git Access

When you need to clone or interact with a **private repository**, authenticate
using the token available in your environment — do not prompt for credentials.

## GitHub

```bash
git clone https://oauth2:$GITHUB_TOKEN@github.com/ORG/REPO.git
```

Or, to avoid embedding the token in the URL (keeps it out of `git log --remotes`):

```bash
git -c credential.helper='' \
    -c url.https://oauth2:$GITHUB_TOKEN@github.com/.insteadOf=https://github.com/ \
    clone https://github.com/ORG/REPO.git
```

For the GitHub CLI (`gh`), authentication is automatic when `GH_TOKEN` is set.

## GitLab (SaaS or self-hosted)

```bash
git clone https://oauth2:$GITLAB_TOKEN@gitlab.com/ORG/REPO.git
```

For self-hosted GitLab, replace `gitlab.com` with your instance hostname.
`GITLAB_API_URL` is also set when the `gitlab` MCP tool is configured.

## Rules

- Never hardcode tokens in files, commit messages, or task outputs.
- Prefer the `https://oauth2:TOKEN@host/` form over SSH keys — the token
  is already scoped and rotatable without container rebuilds.
- If neither `GITHUB_TOKEN` nor `GITLAB_TOKEN` is set, report the missing
  secret clearly rather than failing silently.
