// Keeps the whole suite off the real OS keychain; tests that cover the keychain path mock Bun.secrets.
process.env.WHOOP_MCP_CREDENTIAL_STORE ??= "file";
