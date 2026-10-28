// Date tests assume UTC; the local zone of whoever runs the suite (or an inherited TZ) must not matter.
process.env.TZ = "UTC";
// Keeps the whole suite off the real OS keychain; tests that cover the keychain path mock Bun.secrets.
process.env.WHOOP_MCP_CREDENTIAL_STORE ??= "file";
