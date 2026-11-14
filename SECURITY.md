# Security policy

## Reporting

Open a private security advisory on
[github.com/KingTunaThe7th/mcp-index](https://github.com/KingTunaThe7th/mcp-index/security/advisories/new)
or email `kurokagerin@gmail.com`. Please do not open a public issue for a
vulnerability that has not been fixed.

## Scope

`mcp-index` handles two kinds of hostile input, and both are in scope:

1. **Third-party text** from the MCP Registry and awesome-mcp-servers: names,
   descriptions, URLs, package identifiers and tool schemas.
2. **Third-party processes** launched by the gateway: the sandbox boundary.

In scope: escape from the bubblewrap policy, secret exposure via environment or
the `raw` column, XSS in the dashboard, auth bypass / DNS rebinding against the
HTTP server, SSRF via remote transports, prompt-injection primitives that
survive sanitization (raw ANSI, bidi, zero-width, tag characters), and
privilege escalation through a mounted server.

Out of scope: a server exfiltrating data you deliberately give it, the absence
of isolation under `--allow-unsandboxed`, and the `unshare` driver's lack of
filesystem isolation (documented, not a surprise).

## Design notes

- **Fail closed.** No driver means no gateway. No elicitation support means no
  destructive tool. Schema drift means the mount is blocked, not warned about.
- **Deny by default.** Empty environment, no network, no mounts, read-only root,
  no capabilities.
- **Sanitize on the way in and out.** Untrusted text is stored sanitized and
  sanitized again before it is returned over MCP.
- **No secrets at rest.** Only env *names* are imported; registry header values
  are redacted before being persisted.

If you find a case where any of those four statements is untrue, that is a bug
worth reporting.
