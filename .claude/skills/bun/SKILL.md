---

name: bun
description: Check whether the installed Bun is outdated and keep the project's Bun pins honest, using Bun's live docs (llms.txt) and release notes instead of memory. Use this whenever you start working in a Bun project, before upgrading or pinning Bun (package.json engines/packageManager, @types/bun, setup-bun in CI, oven/bun Docker images), when a Bun API or CLI flag seems missing or behaves unexpectedly ("Bun.xxx is not a function", unknown flag, missing types), when the user asks what's new in Bun or whether to upgrade, and whenever you're about to rely on a Bun feature you're not sure the installed version has.
---

# Bun version check

Your knowledge of Bun has a cutoff date, and Bun ships a release every few weeks. Before you tell the user which version they're on, whether an API exists, or which version to pin, check reality. Don't rely on memory. Two bundled scripts do the checking; they run on Bun, so they need no extra install.

## 1. Check the installed version (run this first)

```bash
bun .claude/skills/bun/scripts/bun-version-check.ts            # human-readable
bun .claude/skills/bun/scripts/bun-version-check.ts --json     # if you want to parse it
```

The script reports:
- the installed version and how Bun was installed (homebrew, install-script, mise, npm and so on)
- the latest stable release and how many releases behind the install is
- a one-paragraph summary of each missed release, taken from the official release notes
- every Bun pin in the project, with any disagreements

Results are cached for 6 hours. Pass `--refresh` if the user says a release just came out.

## 2. Flag it, and say why it matters

If the status is **OUTDATED**, tell the user in one or two lines:
- the installed and latest versions
- which missed changes matter **for what they're doing right now**, taken from the release summaries

Skip the changes that don't matter. "You're on 1.4.2; 1.4.4 adds `ws.pause()` in `Bun.serve`, which is what you're trying to use" helps. A full changelog dump doesn't.

Give the upgrade command that matches the install method the script detected:
- **Homebrew:** `brew upgrade bun`. Running `bun upgrade` on a Homebrew install fights the package manager.
- **Install script:** `bun upgrade`.

Don't run the upgrade yourself unless the user asks. It changes their machine for every project, not just this one.

If the status is **CURRENT**, don't report it. Carry on with the task.

## 3. Check the project's pins

The script lists the pins it found:
- **Runtime:** `engines.bun`, `packageManager`, `.bun-version`, `.tool-versions`, `mise.toml`
- **Types:** `@types/bun` / `bun-types` (the resolved installed version)
- **CI:** `setup-bun` `bun-version`, or `bun-version-file` (resolved from the file it names)
- **Containers:** `FROM oven/bun:<tag>`

Raise the issues it reports:
- **The project requires a newer Bun than is installed.** Commands may fail or behave differently, so say so before running anything.
- **The types and the runtime are on different minor versions.** `tsc` may accept APIs the runtime lacks, or reject ones it has. Suggest `bun add -d @types/bun@<runtime version>`.
- **An exact pin is older than the latest release.** This is often deliberate, so mention it but don't "fix" it uninvited.
- **CI or Docker resolves to a different version than local.** For example, `setup-bun` with no `bun-version` (that means latest) while the local install is outdated, or the reverse. This causes "works on my machine" bugs. Suggest aligning them.

When you change a pin, keep runtime, types, CI and Docker on the same version unless the user wants otherwise.

## 4. Before relying on a Bun API, confirm the installed version has it

If you're about to use an API or flag you aren't sure the installed version has, look it up rather than guessing. Cases to watch:
- new `Bun.*` APIs
- `bun build` flags
- `bun test` features
- `bun:sqlite` additions
- anything marked experimental

```bash
bun .claude/skills/bun/scripts/bun-docs.ts search <terms>    # rank pages from https://bun.com/llms.txt
bun .claude/skills/bun/scripts/bun-docs.ts get runtime/secrets   # read one page as markdown
bun .claude/skills/bun/scripts/bun-docs.ts grep 'New in Bun v1\.4'   # regex over the full docs
bun .claude/skills/bun/scripts/bun-docs.ts get https://bun.com/blog/bun-v1.4.4   # release notes
```

The docs mark when features arrived. Pages carry notes like `New in Bun v1.4`, and the release notes list what each version added. If a feature is newer than the installed Bun, that is when to flag that it's outdated (step 2): name the version that adds it, then either suggest upgrading or write the code without it.

The docs describe the **latest** Bun. If the user is on an older version, the page may describe behaviour they don't have yet. Check the release notes between their version and latest when it matters.
