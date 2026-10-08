# Security policy

This is a local developer tool, not a multi-user or internet-hosted service.

- Keep the HTTP observer bound to `127.0.0.1`; do not expose it through a proxy.
- Keep observation tokens, runtime connection files and project data private.
- Use `--read-only` when inspecting a project that must not be modified.
- Back up projects. Do not edit the same map concurrently in native MZ and MCP.
- Only execute trusted project scripts/plugins. Native NW.js can access local
  resources as the current OS user.
- Do not disable OS security features to make a test project run.
- Do not share arbitrary untrusted code through events and then execute it.

The HTTP presentation ACK endpoint reports that a browser rendered a frame.
It does not authorize map writes or execute runtime commands.

When reporting a vulnerability, avoid publicly attaching project files,
access tokens or sensitive local logs. Open a private report at
<https://github.com/twrsm666/rpgmaker-mcp/security/advisories> (or a plain
issue if advisories are unavailable) and keep the details out of public
threads until a fix ships.
