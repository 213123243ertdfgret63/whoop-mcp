import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../log.ts";

export interface PromptIO {
  print(text: string): void;
  /** Asks for a line of input; the answer is trimmed. */
  ask(question: string): Promise<string>;
  /** Like `ask`, but the typed (or pasted) value is not echoed. */
  askSecret(question: string): Promise<string>;
  openUrl(url: string): void;
}

/** Best-effort: the URL is always printed too, so a missing opener is not an error. */
export function openUrl(url: string): void {
  // A full path on macOS: Claude Desktop may start the server without a usual PATH.
  const opener =
    process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const failed = () => {
    // Origin and path only: the setup page's query carries a one-time token.
    const { origin, pathname } = new URL(url);
    log.warn("could not open a browser", { url: `${origin}${pathname}` });
  };
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", failed); // a missing opener is reported here, not thrown
    child.unref();
  } catch {
    failed();
  }
}

/** Prompts go to stderr so stdout stays clean; input is read line by line from stdin. */
export function terminalIO(): PromptIO {
  // Created on first use: an open readline interface keeps stdin, and so the process, alive.
  let lines: AsyncIterator<string> | undefined;
  const readLine = async (): Promise<string> => {
    lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
    const next = await lines.next();
    if (next.done) throw new Error("Input ended before setup finished.");
    return next.value;
  };
  const ask = async (question: string) => {
    process.stderr.write(question);
    return (await readLine()).trim();
  };

  return {
    print: (text) => console.error(text),
    ask,
    async askSecret(question) {
      // Piped input (and Windows, which has no stty) can't be hidden, but still works.
      if (!process.stdin.isTTY || process.platform === "win32") return ask(question);
      const stty = (arg: string) => spawnSync("/bin/stty", [arg], { stdio: ["inherit", "ignore", "ignore"] });
      const onInterrupt = () => {
        stty("echo");
        process.exit(130);
      };
      process.on("SIGINT", onInterrupt);
      stty("-echo");
      try {
        const value = await ask(question);
        process.stderr.write("\n");
        return value;
      } finally {
        stty("echo");
        process.off("SIGINT", onInterrupt);
      }
    },
    openUrl,
  };
}
