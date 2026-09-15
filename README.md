# Repository Starter Template

Use this GitHub template to create new repositories with secure CI and repository security scanning enabled from the first commit.

## Included automation

- **CI** — auto-detects supported project types and runs the shared read-only CI workflow.
- **Security** — scans the repository on pushes, pull requests, manual runs, and every Monday at 03:17 UTC.

Both callers are pinned to the immutable, post-merge-validated `cjgl23/github-workflows` commit:

`b25f7e44fd55ce5efd4c57175557e00789d64070`

The template intentionally does **not** include automatic Release or deployment automation. Add those only after the repository's release/versioning policy is defined.

## After creating a repository from this template

For most repositories, no GitHub Actions changes are required. The shared CI workflow starts with `project-type: auto` and safely handles unknown/static repositories without guessing commands.

If a repository needs custom commands, runtime settings, a working directory override, or specialized browser/integration testing, edit the copied `.github/workflows/ci.yml` in that repository. Keep reusable workflow references pinned to full commit SHAs.

## Security rules

- Do not replace the central commit SHA with `@main` or a movable tag.
- Do not add `secrets: inherit` to the baseline CI or Security callers.
- Keep CI and Security read-only unless a repository has a separately reviewed need for additional permissions.
- Never store application secrets, cloud credentials, API tokens, or private keys in this template repository.
