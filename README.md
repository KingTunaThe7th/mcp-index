# mcp-index

Index the MCP server ecosystem, then mount the ones you actually want behind a
single, sandboxed MCP endpoint.

`mcp-index` is two tools in one binary:

- **A catalog.** It pulls the official MCP Registry and the
  [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) list,
  normalizes and deduplicates them into a local SQLite + FTS5 index, and lets
  you search it offline in milliseconds.
- **A gateway.** It mounts any set of MCP servers behind one MCP endpoint,
  namespacing every tool, and runs each local server inside a bubblewrap
  sandbox with no network, no `$HOME`, no capabilities, and no inherited
  environment.

The gateway half exists because "just run this npx command you found in a
README" is how you get a supply-chain incident. Every server you mount is code
written by a stranger; `mcp-index` assumes it is hostile.

```console
$ mcp-index sync
registry: 4948 entries
awesome: 4617 entries
9556 unique servers (9556 new, 0 updated) in 14909ms

$ mcp-index search postgres --limit 2
ai.getvda/kafka-and-postgres-monitoring-stack  [remote]
  ai.getvda/kafka-and-postgres-monitoring-stack
  Kafka and Postgres Monitoring Stack
  remote: https://postgres-prometheus-kafka-stack-generator.getvda.ai/mcp
```

---

## Why

Three separate problems, one tool:

1. **Discovery.** The registry has machine-readable packages but almost no
   prose; the awesome list has prose and categories but no machine-readable
   install metadata. Neither is searchable offline. Joining them gives you both.
2. **Configuration sprawl.** Every MCP client has its own config format, and
   every server you add multiplies the number of tool schemas in your model's
   context. One endpoint with namespaced tools is easier to reason about and
   easier to revoke.
3. **Trust.** An MCP server is arbitrary code with access to your filesystem,
   your network and your API keys, invoked by a model that cannot distinguish a
   tool description from an instruction. Containment and schema pinning are not
   optional extras here; they are the design.

## Install

Requires Node **22.5+** (for `node:sqlite`) and, for the gateway, Linux with
unprivileged user namespaces.

> **This package is not published to npm.** The name `mcp-index` on npm belongs
> to an unrelated project, so `npm install -g mcp-index` or `npx mcp-index`
> would run *their* code, not this. Install from the repository.

```console
$ git clone https://github.com/KingTunaThe7th/mcp-index.git
$ cd mcp-index
$ npm ci --ignore-scripts
$ npm run build
$ node dist/cli.js doctor      # what isolation can this host provide?
```

`npm link` additionally installs a `mcp-index` shim into your node prefix's
`bin` (no registry involved); undo it with `npm unlink -g mcp-index`.

There are **no native build steps**: the index uses Node's built-in SQLite,
including FTS5.

## Quick start

```console
# 1. pre-install the servers you intend to mount
$ mkdir -p ~/.local/share/mcp-index/servers
$ npm install --prefix ~/.local/share/mcp-index/servers \
    @modelcontextprotocol/server-filesystem

# 2. write a config, edit the paths, mount everything behind one endpoint
$ node dist/cli.js init
$ $EDITOR mcp-index.json
$ node dist/cli.js gateway        # stdio endpoint for any MCP client

# 3. the catalog is separate, and only needed by search/show/snippet/serve
$ node dist/cli.js sync
$ node dist/cli.js search postgres --limit 5
```

The gateway never opens the catalog database: `sync` is only required by
`search`, `show`, `snippet` and the `serve` dashboard.

Or run it over HTTP with a dashboard:

```console
$ node dist/cli.js serve --port 7777
dashboard:  http://127.0.0.1:7777
mcp:        http://127.0.0.1:7777/mcp
token file: ~/.local/share/mcp-index/token
```


## Client setup: Cline

Cline spawns unmodified stdio commands, so it needs **absolute paths** — its
schema is `command` / `args` / `env` / `disabled` / `autoApprove`, and has no
`cwd`.

**1. Pre-install the server** (`npx` cannot download inside a `network: "none"`
sandbox):

```console
$ mkdir -p ~/.local/share/mcp-index/servers
$ npm install --prefix ~/.local/share/mcp-index/servers \
    @modelcontextprotocol/server-filesystem
```

**2. Write `~/.local/share/mcp-index/mcp-index.json`** — mount the package
read-only at `/servers` and your project at `/work`:

```json
{
  "servers": {
    "files": {
      "command": "node",
      "args": ["/servers/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "/work"],
      "mounts": [
        { "source": "~/.local/share/mcp-index/servers", "target": "/servers", "mode": "ro" },
        { "source": "/path/to/your/project", "target": "/work", "mode": "ro" }
      ],
      "network": "none",
      "destructiveTools": ["write_file", "edit_file", "move_file", "create_directory"]
    }
  }
}
```

**3. Add the entry.** In Cline: **MCP Servers → Configure → Configure MCP
Servers** (the extension's `cline_mcp_settings.json`; the CLI reads
`~/.cline/data/settings/cline_mcp_settings.json`, overridable with
`CLINE_MCP_SETTINGS_PATH`):

```json
{
  "mcpServers": {
    "index": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/mcp-index/dist/cli.js",
        "gateway",
        "--config",
        "/home/you/.local/share/mcp-index/mcp-index.json"
      ],
      "env": { "MCP_INDEX_HOME": "/home/you/.local/share/mcp-index" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

With the Cline CLI, the same thing:

```console
$ cline mcp add mcp-index --yes -- /absolute/path/to/node \
    /absolute/path/to/mcp-index/dist/cli.js gateway \
    --config /home/you/.local/share/mcp-index/mcp-index.json
```

The panel then lists namespaced tools — `files__read_file`,
`files__list_directory`, `files__search_files`, … — and `autoApprove: []` means
Cline asks before each call. Adding namespaced names there skips the prompt.

Verified behaviour, and what to do about it:

| Symptom | Cause and fix |
| --- | --- |
| `Refused: "files__write_file" is marked destructive and was not approved` | The tool is in `destructiveTools` and needs MCP elicitation. If your client cannot elicit, remove it from the list to allow writes outright. |
| `ENOTFOUND registry.npmjs.org` | The sandbox has no network. Pre-install the package, or set `"network": "egress"`. |
| Tool missing from the list | The mount is `blocked` by schema drift, or the process died. Check the gateway's stderr in Cline's MCP output pane, then `node dist/cli.js pin list`. |
| Empty or missing directory listing | `args` and `target` are **sandbox** paths (`/work`); only `mounts.source` is a host path. |
| Everything vanished after a package upgrade | The TOFU pin caught a changed toolset. Review, then `node dist/cli.js pin approve files`. |

For HTTP instead of stdio, run `node dist/cli.js serve` and add a remote entry:
`{ "type": "streamableHttp", "url": "http://127.0.0.1:7777/mcp",
"headers": { "Authorization": "Bearer <token from --print-token>" } }`.

## Commands

| Command | What it does |
| --- | --- |
| `sync` | Refresh the index from the registry, the awesome list and local client configs. |
| `search [query...]` | FTS5 search with `--category`, `--transport`, `--language`, `--official`, `--any`. |
| `show <id>` | Full record plus launch command. |
| `snippet <id>` | Emit a `claude` / `cursor` / `vscode` / `generic` config fragment. |
| `categories` | Tag distribution. |
| `stats` | Index summary. |
| `doctor` | Sandbox capabilities, `prlimit`, runtime prefixes, index state. |
| `init` | Write a starter `mcp-index.json`. |
| `gateway` | Aggregated MCP endpoint over stdio. |
| `serve` | Dashboard + JSON API + Streamable HTTP MCP endpoint. |
| `pin list\|approve\|remove` | Manage trust-on-first-use tool-schema pins. |

Global flags: `--json` (machine output), `--db <path>`, `--verbose`, `--quiet`.

### Index location

Everything lives under one root, `~/.local/share/mcp-index` by default:

```
index.db      SQLite + FTS5 catalog
pins.json     approved tool schemas (0600)
token         HTTP bearer token (0600)
homes/<alias> persistent sandbox homes (only if you ask for them)
```

Set `MCP_INDEX_HOME=/path` to keep it entirely self-contained (the repo
`.gitignore` already excludes `.mcp-index/`).

## Gateway configuration

`mcp-index.json` in the working directory (or `--config <path>`):

```json
{
  "gateway": {
    "driver": "auto",
    "allowUnsandboxed": false,
    "host": "127.0.0.1",
    "port": 7777
  },
  "servers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
      "cwd": "/home/you/project",
      "mounts": [{ "source": "/home/you/project", "target": "/work", "mode": "ro" }],
      "network": "none",
      "destructiveTools": ["write_file", "edit_file", "move_file"]
    },
    "kagi": {
      "url": "https://mcp.kagi.com/mcp",
      "headers": { "Authorization": "Bearer ${KAGI_KEY}" }
    }
  }
}
```

Per-server keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `command`, `args` | — | stdio launch. Arguments are **sandbox paths**, see below. |
| `url`, `headers`, `transport` | — | remote launch (`http` / `sse`). |
| `cwd` | sandbox home | Host path; translated into the sandbox through `mounts`. |
| `mounts` | `[]` | `{source, target, mode: "ro"\|"rw"}`. Anything not mounted does not exist. |
| `network` | `"none"` | `"none"` or `"egress"`. `npx`/`uvx` need `egress` on the first run. |
| `env` | `{}` | Extra non-secret variables for the child. |
| `persistentHome` | `false` | Keep `$HOME` across runs (state lives in `homes/<alias>`). |
| `image` | — | Required by the `docker`/`podman` drivers. |
| `runtimePrefixes` | auto | Toolchain roots kept visible inside the masked home. |
| `limits` | 2 GiB / 600 s / 256 MiB / 4096 fds | `memoryMb`, `cpuSeconds`, `fileSizeMb`, `openFiles`, `processes`. |
| `allowPrivateNetwork` | `false` | Permit loopback/private targets for remote servers. |
| `destructiveTools` | `[]` | Tool names that require human approval on every call. |
| `enabled` | `true` | Skip a mount without deleting it. |

Unknown keys are **rejected**, not ignored — a typo like `"mount"` instead of
`"mounts"` would otherwise silently widen what the server can reach.

> **Arguments are sandbox paths.** Mounts are host paths; the child only sees
> targets. With `mounts: [{source: "/home/you/project", target: "/work"}]`, you
> pass `/work/file.txt`, not `/home/you/project/file.txt`. `cwd` is the one
> exception: it is written as a host path and translated for you.

## Security model

Anonymous code from npm, run because a search result looked plausible. Assume it
reads `~/.ssh`, phones home, and tries to persist.

| Threat | Mitigation |
| --- | --- |
| Filesystem exfiltration (`~/.ssh`, `~/.aws`, browser profiles) | `$HOME` replaced by an ephemeral tmpfs; everything else read-only; `validatePolicy` hard-refuses mounts of known secret paths, `/`, `/etc`, `docker.sock`, and rw mounts of system paths. |
| Network exfiltration | `--unshare-all` (no network) unless the server declares `network: "egress"`, which re-shares net explicitly. |
| Credential leakage via environment | `--clearenv` plus an allowlist (`PATH`, `LANG`, proxy vars, …). Your API keys are not in the child's environment. |
| Privilege escalation | `--cap-drop ALL`, unprivileged user namespace, `--new-session` (blocks TIOCSTI), `--die-with-parent`. |
| Resource exhaustion | `prlimit` caps on address space, CPU seconds, file size and open files. |
| Prompt injection from tool descriptions | Third-party text is sanitized (ANSI/OSC, bidi, zero-width, Unicode tags) and attributed `[provided by server "x"]`. |
| Silent tool-schema swap after an update | TOFU pins: the first connect records a digest of every tool's name/description/input schema. A change **blocks** the mount until you review and run `mcp-index pin approve <alias>`. |
| Destructive tool called by a confused model | Configured `destructiveTools` require MCP elicitation approval. If the client cannot elicit, the call is **refused**. |
| SSRF via a remote `url` | Every remote endpoint is resolved and checked; loopback, private, link-local, CGNAT, multicast and reserved ranges are refused unless `allowPrivateNetwork` is set. A guarded `fetch` re-validates each request. |
| DNS rebinding against the HTTP server | Unknown `Host` headers are rejected (421), cross-site `Origin`s are rejected (403), no CORS headers are ever sent, and a 32-byte bearer token (constant-time compare) is required. |
| XSS in the dashboard | No `innerHTML` anywhere; values are written with `textContent`, links are validated as `http(s)`, and the page is served with a nonce-based CSP. |
| Secret material imported from client configs | Only env **names** are imported. Registry `headers` values are redacted before the `raw` blob is stored. |

### Drivers

`mcp-index gateway` picks the strongest available driver and **refuses to start**
rather than silently degrading:

| Driver | Filesystem | Network | Notes |
| --- | --- | --- | --- |
| `bwrap` | isolated | isolated | Preferred. Unprivileged; binds `/usr` read-only, masks `$HOME`, keeps your toolchain visible via `runtimePrefixes`. |
| `docker` / `podman` | isolated | isolated | Needs an image that contains the runtime. `--read-only`, `--cap-drop=ALL`, `--network=none`. |
| `unshare` | **shared** | isolated | Network-only fallback. Still sees your whole filesystem; reported as such. |
| `none` | shared | shared | Only with `--allow-unsandboxed`. |

Two behaviours were verified on the reference host rather than assumed:

- `bwrap 0.9.0` works unprivileged, but the toolchain lives under `$HOME`
  (`~/.local/node22`), so a blind `--tmpfs /home` breaks `npx`. Runtime prefixes
  are therefore re-bound **after** the tmpfs, and a test asserts that ordering.
- `systemd-run --user --scope` rejects `ProtectHome`, `ProtectSystem`,
  `NoNewPrivileges` and `PrivateTmp` ("Unknown assignment") because those are
  system-unit-only properties. It cannot be used as a rootless sandbox driver,
  so it is not offered as one.

### What this does **not** protect against

- A server you explicitly mount with `network: "egress"` can still exfiltrate
  whatever data you give it through its own tools.
- Tool *output* can contain injected text. It is sanitized and delimited, not
  guaranteed safe; treat tool results as data, never as instructions.
- Pins detect change, they do not prove safety. Reviewing the diff the first
  time is the point.
- In `unshare` and `none` mode, filesystem isolation is absent by definition.


## Data sources, licenses and terms

`sync` makes exactly two kinds of outbound request:

| Source | Request | Frequency |
| --- | --- | --- |
| MCP Registry | `GET /v0/servers?limit=100&version=latest`, cursor-paginated | one pass per `sync` |
| awesome-mcp-servers | one markdown file from `raw.githubusercontent.com` | **one** request per `sync` |

Both send a single identifying `User-Agent` (`mcp-index/<version> (+repo URL)`),
cap retries at three, and honour `Retry-After` on 429/5xx. There is no crawler,
no GitHub API call and no token: the project never touches `api.github.com`, so
API rate limits, token-sharing rules and the `api.github.com` abuse clauses do
not apply to it.

The awesome list is MIT licensed (© 2024 Frank Fiegel). Its notice — and the
notice for every runtime dependency — is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). If you redistribute an index
you generated, carry that notice with it: the database is a derivative of that
content. The repository itself ships no data, and `*.db` is gitignored so a
clone never contains a snapshot of third-party metadata.

On GitHub's side the relevant clauses are:

- **Acceptable Use Policies §6 (Services Usage Limits)** — "You will not
  reproduce, duplicate, copy, sell, resell or exploit any portion of the
  Service…". The single file fetched is repository content owned by its author
  and published under MIT; it is read once per sync into a local index, and is
  never resold or republished by this project.
- **Acceptable Use Policies §7 (Information Usage Restrictions)** — restricts
  scraping for spam and for selling personal information. This project does
  neither: it reads public repository metadata, collects no personal data, and
  sends nothing to third parties.
- **Acceptable Use Policies §4 (Spam and Inauthentic Activity)** and **§9
  (Excessive Bandwidth Use)** — one small file per sync is not bulk activity,
  and nothing here is used to place load on GitHub's servers.
- **Terms of Service §H (API Terms)** — not applicable; no GitHub API is used.

To avoid contacting GitHub entirely, point the importer at a local copy:

```console
$ mcp-index sync --awesome-url "file://$PWD/README.md"   # file:// is read directly
```

Use `--registry-url` similarly for the registry half, so a sync can run fully
offline against a mirror.

**Privacy:** there is no telemetry, no analytics and no phone-home. The only
data that leaves your machine are those two upstream requests. Local client
configs are read only on your machine, and only env var *names* are kept.

## Architecture

```
src/
  config.ts            paths + upstream endpoints
  cli.ts               commander front end
  db/                  schema.sql + node:sqlite access, FTS5 queries
  sources/             registry, awesome-list and local-config importers
  ingest/              normalization, dedupe, merge policy, sync pipeline
  security/            sanitize, redact, SSRF guard
  sandbox/             policy, drivers (bwrap/container/unshare/none), pins, prlimit
  gateway/             config, namespacing, mount manager, aggregated MCP server
  http/                dashboard, JSON API, auth, Streamable HTTP MCP
  catalog/             client config snippets
test/                  42 tests, including a real sandboxed gateway run
```

Data flow: `sources/*` → `ingest/normalize` (dedupe on canonical repo URL,
registry > local > awesome precedence) → `db` (FTS5 external-content index kept
in sync by triggers) → `cli` / `http`.

Gateway flow: `GatewayManager` builds a `SandboxPolicy` per server, spawns the
argv from a driver, connects an MCP client, pins the toolset, and registers
namespaced items in `NamespaceRegistry`. `createGatewayServer` exposes them and
routes each call back by alias.

## Development

```console
$ npm install
$ npm run typecheck     # tsc --noEmit, strict
$ npm test              # node:test via tsx
$ npm run build         # dist/ + schema.sql asset copy
```

`git config --local core.hooksPath .githooks` enables the pre-commit gate:
no `innerHTML` in `src/`, a shallow secret scan of staged files, and a
typecheck.

The integration test (`test/gateway.test.ts`) really spawns bubblewrap, mounts
the repo read-only at `/work`, and asserts that a secret in the parent
environment does not reach the child, that `$HOME` is `/sandbox-home`, that
tools are namespaced, and that a destructive tool is refused when the client
cannot elicit approval. It skips itself where bubblewrap is unavailable.

## Limitations

- Linux-first for sandboxing. On macOS/Windows only the container driver can
  isolate, and it needs an image you supply.
- The registry returns history; `version=latest` is requested by default so
  there is one row per server. Fields absent upstream stay empty rather than
  being guessed.
- Deduplication relies on repository URLs. Registry entries without a
  `repository` field cannot be merged with their awesome-list counterpart and
  appear twice — visibly, with different ids.
- `node:sqlite` prints an `ExperimentalWarning` on Node 22.

## License

MIT. See [LICENSE](LICENSE). Security policy in [SECURITY.md](SECURITY.md),
third-party licenses and upstream terms in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

