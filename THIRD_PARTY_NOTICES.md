# Third-party notices

`mcp-index` is MIT licensed (see [LICENSE](LICENSE)). It fetches, but does not
vendor, data owned by other parties. This file records those notices.

## What this repository does *not* contain

- No prebuilt index. `*.db`, `*.db-wal` and `*.db-shm` are gitignored, so a
  clone never ships a snapshot of third-party catalog metadata.
- No copied descriptions or catalog rows in source or tests. The fixtures under
  `test/` use invented names (`acme/pg-mcp`, `io.test/*`).

The database you generate locally with `mcp-index sync` is a derivative work of
the sources below. If you redistribute it (as a file, an export, or an API),
carry these notices with it.

## awesome-mcp-servers

- Source: <https://github.com/punkpeye/awesome-mcp-servers>
- Fetched at runtime from `raw.githubusercontent.com` (see `DEFAULT_AWESOME_URL`).
- License: MIT

```
The MIT License (MIT)
=====================

Copyright © 2024 Frank Fiegel (frank@glama.ai)

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

## Official MCP Registry

- Source: <https://registry.modelcontextprotocol.io/v0/servers>
- Server records are published there by their respective authors; each record
  carries its own repository URL and license. `mcp-index` copies metadata
  (name, description, package identifiers, remote URLs) and never the servers
  themselves.
- Governed by the registry operator's terms, not by GitHub's. Override the
  endpoint with `MCP_REGISTRY_URL` or `--registry-url` if you mirror it.

## Local MCP client configs

Read from your own machine (Claude Desktop, Cursor, VS Code). Only server
aliases, commands, arguments and environment variable **names** are imported;
values are discarded at parse time. Nothing is uploaded.

## Runtime dependencies

All runtime dependencies are MIT licensed:

| Package | License |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `commander` | MIT |
| `zod` | MIT |

The full transitive tree, with versions and resolved URLs, is in
`package-lock.json`.
