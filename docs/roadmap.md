# Roadmap and ideas

## Remote mode, so it works on claude.ai web and mobile

Today the server runs locally over stdio as a Claude Desktop extension. That covers Claude Desktop, but not claude.ai in a browser or the mobile apps, which can only reach **remote** MCP servers added as custom connectors.

A remote mode would run the same tools over Streamable HTTP on a server the user deploys (Railway, Fly.io, a VPS). The original research brief called this milestone M6 ([archived](archive/RESEARCH.md)).

There is already a working example of the idea: [crerocksolid/whoop-mcp](https://github.com/crerocksolid/whoop-mcp). Reviewed 2026-10-27, it shows what to copy and what to avoid:

- **Copy:**
  - A deploy-it-yourself server configured with the user's own WHOOP app (`WHOOP_CLIENT_ID`/`SECRET`, a public `https://…/callback` redirect URI).
  - A tool that hands out the WHOOP authorize link.
  - Higher-level tools (`get_today`, trends) instead of raw endpoints.
- **Avoid:**
  - **Its `/mcp` endpoint has no authentication**, so anyone with the URL can read the owner's WHOOP data. Ours must require auth on every request. Options, simplest first:
    - a long random bearer secret
    - Claude's MCP OAuth (our own OAuth 2.1 authorization server: RFC 9728 metadata, PKCE, client ID metadata documents)
  - **Its `/callback` doesn't check the OAuth `state`.** Reuse our `oauthCallback`, which ignores callbacks without this login's state.
  - **It keeps a permanent SQLite copy of the data.** WHOOP's API terms (§4.2.2) discourage this. Keep data in memory, or encrypted with a purge path.

What we already have toward it:

- **Server code:** `createMcpHandler` from the MCP SDK can serve the existing `createServer()` factory from `Bun.serve`.
- **Login:** the browser setup and login flows (`browser-setup.ts`, `login.ts`) would need a public redirect URI and Host and Origin checks for the deployed domain, instead of loopback.
- **Tokens:** they would move from `~/.config` to the server's encrypted storage, still one WHOOP grant per deployment.

Before shipping it, re-read WHOOP's API terms on third parties (§3.1.3, §4.2.1): a remote server is still the user's own, but hosting one for _other_ people would not be.
