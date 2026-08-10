# Qwen Web patch maintenance

This checkout carries a local fix for `qwen-web` against OmniRoute `v3.8.49`.
The fix keeps the browser request headers captured by the user, supports a
DevTools request-header block as the credential, and surfaces Qwen errors
instead of returning an empty successful response.

## Credentials

Never commit Qwen cookies, request headers, `.env` files, the OmniRoute data
directory, SQLite databases, or call logs. Store the credential only through
OmniRoute's local provider settings and rotate it if it is exposed.

## Updating from upstream

Keep the original project as the `upstream` remote and this repository as
`origin`:

```bash
git remote add upstream https://github.com/diegosouzapw/OmniRoute.git
git fetch upstream --tags
git branch -r --sort=-committerdate | head
```

When a new upstream release is available, create an update branch from the
matching upstream release branch and reapply this commit:

```bash
git fetch upstream --tags
git switch -c update/upstream-vX.Y.Z upstream/release/vX.Y.Z
git cherry-pick <qwen-web-fix-commit>
npm ci
npm run build:release
```

Resolve conflicts only in the three Qwen-related source files. Then run a
local smoke test with a credential already stored in OmniRoute:

```bash
omniroute chat --model qwen-web/qwen3.7-plus --no-history \
  'Reply with exactly: OMNI_QWEN_OK'
omniroute chat --model qwen-web/qwen3.7-plus --stream --no-history \
  'Reply with exactly: OMNI_STREAM_OK'
```

Do not run `npm install -g omniroute@latest` on the production installation
without rebuilding or reapplying this patch: a global npm install replaces the
patched runtime files.

For dependency-only updates, use Dependabot or Renovate and review the lockfile
and build output normally. For an OmniRoute release, the upstream rebase and
the Qwen smoke tests above are the required steps.
