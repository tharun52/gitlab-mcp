# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build          # tsc → build/index.js (sets executable bit)
npm run watch          # tsc --watch for iterative development

# Test
npm run test:mock      # Fast unit + mock-server tests — run these locally before pushing
npm run test:schema    # JSON schema validation
npm run test:oauth     # OAuth2 flow against mock server
npm run test:stateless # Multi-pod stateless OAuth helpers
npm run test:all       # mock + live (live requires a real GitLab token)

# Run a single test file
node --import tsx/esm --test test/<file>.ts

# Live integration tests (needs real GitLab credentials)
GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxxx GITLAB_API_URL=https://gitlab.com/api/v4 npm run test:live

# Lint / format / type-check
npm run lint           # ESLint
npm run lint:fix       # ESLint autofix
npm run format         # Prettier write
npm run format:check   # Prettier check (CI gate)
npx tsc --noEmit       # Type check only

# Docs (requires Python 3.10+)
make serve             # Preview docs at http://127.0.0.1:8000/gitlab-mcp/
make tools-docs        # Regenerate per-group tool docs from tools/registry.ts
```

Node version is pinned to **22.21.1** in `.nvmrc`. Run `nvm use` before developing.

CI (`pr-test.yml`) runs `test:mock`, `test:oauth`, `test:remote-auth`, `tsc --noEmit`, lint, format check, and Docker build on every PR.

## Architecture

The server is a Model Context Protocol (MCP) server that exposes GitLab API operations as tools. It supports three transports: **stdio** (local default), **SSE**, and **Streamable HTTP**.

### Core data flow

1. `index.ts` — entry point; starts the transport, registers tools, and dispatches all tool calls through a single `switch` block keyed on tool name. This file is very large (~5K+ lines) because every GitLab API call lives here as a handler.
2. `config.ts` — parses all env vars and CLI args (CLI takes precedence). This is the single source of truth for runtime configuration. Every feature flag (`SSE`, `STREAMABLE_HTTP`, `REMOTE_AUTHORIZATION`, `GITLAB_MCP_OAUTH`, `GITLAB_READ_ONLY_MODE`, `USE_PIPELINE`, `USE_GITLAB_WIKI`, `USE_MILESTONE`) originates here.
3. `schemas.ts` — Zod schemas for every tool's input. All validation happens here before dispatch.
4. `tools/registry.ts` — defines `allTools[]` (tool name + description + inputSchema) and `TOOLSET_DEFINITIONS` (grouping tools into categories). Controls which tools are enabled by default vs. opt-in.

### Tool lifecycle

Adding a new tool requires changes in exactly four places:
1. **`schemas.ts`** — define Zod input schema
2. **`tools/registry.ts`** — add to `allTools[]` and the appropriate `TOOLSET_DEFINITIONS` entry
3. **`index.ts`** — add dispatch case in the `switch` block
4. **`test/`** — add a test file

### Toolset system

Tools are grouped into named toolsets (e.g. `merge_requests`, `issues`, `pipelines`). Default toolsets are always enabled; non-default ones (`pipelines`, `milestones`, `wiki`, `releases`, `tags`, `workitems`, `webhooks`, `search`, `variables`, `dependency_proxy`) must be explicitly enabled via `GITLAB_TOOLSETS=all` or `GITLAB_TOOLSETS=pipelines,wiki`.

`IS_REMOTE = SSE || STREAMABLE_HTTP` controls whether file-download tools return a URL (remote) or write to disk (local). Several tools have two schema variants controlled by this flag.

### Authentication

Four auth modes, configured in `config.ts`:
- `GITLAB_PERSONAL_ACCESS_TOKEN` — simplest; static PAT
- `GITLAB_USE_OAUTH=true` — local browser OAuth2 flow (`oauth.ts`)
- `GITLAB_MCP_OAUTH=true` — MCP OAuth proxy for remote clients like Claude.ai (`oauth-proxy.ts`)
- `REMOTE_AUTHORIZATION=true` — per-request token from HTTP header

`auth-retry.ts` wraps requests with 401 retry + token refresh for OAuth flows.

### Stateless mode

`stateless/` implements multi-pod-safe OAuth where session state is encoded into opaque tokens instead of held in memory — required for horizontally scaled deployments. Enabled via `OAUTH_STATELESS_MODE=true` with `OAUTH_STATELESS_SECRET`.

### Dynamic API URL / connection pool

`gitlab-client-pool.ts` manages a pool of GitLab clients (up to `GITLAB_POOL_MAX_SIZE`, default 100) for dynamic API URL routing — allows a single server instance to serve multiple GitLab instances. Enabled via `ENABLE_DYNAMIC_API_URL=true`.

## Conventions

- **No stray `console.log`** in non-test `.ts` files — use the pino logger.
- **No TODO/FIXME/XXX** in committed code — open an issue instead.
- Commit message prefixes: `feat:`, `fix:`, `docs:`, `chore:` — used by the changelog generator.
- Branch naming: `feat/<desc>`, `fix/<desc>`, `docs/<desc>`, `chore/<desc>`.
