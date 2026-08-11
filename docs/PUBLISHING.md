# Publishing and listing the server

How to ship a new version and get listed in the MCP catalogs, so the server is discoverable from
Claude, Cursor, LobeHub and friends. The canonical source is the **official MCP registry**
(`registry.modelcontextprotocol.io`).

## Version sync (important)

The version lives in **three places and must match byte for byte**:

- `package.json` → `version`;
- `server.json` → root `version`;
- `server.json` → `packages[0].version`.

And `mcpName` in `package.json` must equal `name` in `server.json`
(`io.github.A1-x-Tech/mcp-avito-ads`). Pre-flight check — all three must print the same `X.Y.Z`:

```bash
grep -n '"version"' package.json server.json
grep -n 'mcpName' package.json; grep -n '"name"' server.json
```

> ⚠️ `mcp-publisher` publishes the **root** `server.json.version`. If you bump npm and
> `packages[0].version` but leave the root one stale, `npm publish` succeeds (it reads
> `package.json`) while `mcp-publisher publish` fails with the misleading
> `400 cannot publish duplicate version` — it is re-publishing the old root version.

> ⚠️ **`description` in `server.json` must be <= 100 characters.** The registry rejects longer
> ones. It is deliberately shorter than the `description` in `package.json`; do not copy that one
> over.

## Release (all channels in one pass)

Publishing to npm alone quietly drifts from the other channels: `git push --follow-tags` pushes
the tag but does **not** create a GitHub Release, and the registry is immutable per version (even
a metadata fix needs a bump).

1. Bump `version` in the three places above and record the change in `CHANGELOG.md` (move
   `[Unreleased]` into a dated section).
2. `npm publish` — runs `typecheck` + `test` + `build` (via `prepublishOnly` / `prepare`).
3. `git commit`, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push origin main --follow-tags`.
4. **GitHub Release:** `gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag`.
5. **Official MCP registry:**

```bash
brew install mcp-publisher                            # or a binary from modelcontextprotocol/registry releases
mcp-publisher logout                                  # login on top of a live token will not re-mint it
mcp-publisher login github --token "$(gh auth token)" # NOT a bare `login github` — see below
mcp-publisher publish                                 # from the repo root (where server.json lives)
```

> ⚠️ The registry JWT lives for **about an hour**. If publishing is delayed after login, you get a
> 401 — run `mcp-publisher logout && mcp-publisher login github --token "$(gh auth token)"` again
> immediately before `publish`.

> ⚠️ **Log in with a token, not the device flow.** `mcp-publisher login github` without `--token`
> authorizes the registry's OAuth app, and an organization with the "Only approved applications
> can access data" policy is invisible to that app — the registry sees an empty org list and
> answers `403 Forbidden: You have permission to publish: io.github.<personal-login>/*`. The `gh`
> token already carries the `read:org` scope and does see the organization.
>
> You recognize it by the 403 text itself: it lists the namespaces you may publish to. If that
> list holds **only** the personal `io.github.<login>/*` and no organization, the login method is
> the problem. Public org membership (`gh api -X PUT /orgs/A1-x-Tech/public_members/<login>`) is
> necessary but not sufficient; verify with `curl -s https://api.github.com/users/<login>/orgs`,
> which must show `A1-x-Tech`.

### What the registry checks

- **Namespace** — the name `io.github.A1-x-Tech/*` is proven by logging in with a GitHub account that
  has access to the `A1-x-Tech` organization. The namespace is **case-sensitive**:
  `io.github.A1-x-Tech`, not `io.github.a1-x-tech`.
- **npm package ownership** — the `mcpName` field in the **published** `package.json` (the npm
  tarball, not your working tree) is compared with `name` from `server.json` character by
  character. The package carrying `mcpName` must already be on npm, so npm publish comes first.

## LobeHub

1. Open [lobehub.com/mcp](https://lobehub.com/mcp) → **Submit MCP**.
2. Give the repository URL `https://github.com/A1-x-Tech/mcp-avito-ads`. LobeHub pulls the README,
   the tool list and the install config (`npx -y mcp-avito-ads`) itself.
