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
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    log(`could not open a browser; open ${url} manually`);
  }
}

/** Prompts go to stderr so stdout stays clean; input is read line by line from stdin. */
export function terminalIO(): PromptIO {
  const lines = console[Symbol.asyncIterator]();
  const readLine = async (): Promise<string> => {
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
      const stty = (arg: string) => Bun.spawnSync(["stty", arg], { stdin: "inherit" });
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
