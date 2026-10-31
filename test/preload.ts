// Date tests assume UTC; the local zone of whoever runs the suite (or an inherited TZ) must not matter.
process.env.TZ = "UTC";
// Keeps the whole suite off the real OS keychain, whatever the shell sets: disconnect deletes app credentials.
// Tests that cover the keychain path stand in for it (spyOn the `keychain` object, or a fake `security`).
process.env.WHOOP_MCP_CREDENTIAL_STORE = "file";
// And if a test lifts the file store without a stand-in, `security` is a program that refuses everything, never
// Apple's real one: the suite once overwrote a developer's saved WHOOP app credentials that way.
process.env.WHOOP_MCP_SECURITY = `${import.meta.dir}/refuse-security.sh`;
// Tests never write log files unless they ask for one.
process.env.WHOOP_MCP_LOG_FILE ??= "off";
// Nothing from the developer's shell may leak in: logging levels, or WHOOP app credentials that would make
// tests take the real login path (and bind port 8787).
process.env.WHOOP_MCP_LOG_LEVEL = "info";
delete process.env.WHOOP_MCP_LOG_STDERR_LEVEL;
for (const key of ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET", "WHOOP_REDIRECT_URI"]) delete process.env[key];
// Never open the real browser from a test.
process.env.WHOOP_MCP_NO_BROWSER = "1";
