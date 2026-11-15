# T3 Factory

T3 Factory (`t3factory`) evolves [T3 Code](https://github.com/pingdotgg/t3code) into one
product for software, research, and knowledge work. Start a thread with an outcome,
coordinate people, agents, tools, and compute, then review evidence and authorize delivery.
**T3 Factory is the application, not a feature inside T3 Code.** Its product identity
and branding apply across web, Electron desktop, and native mobile.
Upstream T3 Code is developed by T3 Tools; its attribution and license remain unchanged.

This describes the product direction, not a claim that every designed flow is implemented.
The [design library](./docs/factory/design/README.md) contains editable source assets,
the Figma/FigJam entry points, and the standalone/optional Linear design contract.

Open **Factory** for Overview, Issues, Sources, Workflows, and Orchestrator. Use **Sessions** or
**New thread** for ordinary conversations. The [Factory guide](./docs/user/source-control.md#factory)
explains scope selection, reviewed issue and feed-item starts, orchestrator orientation, and
workflow dispatch limits.

Fork work is tracked in [this repository's issues](https://github.com/Codeseys-Labs/t3factory/issues),
including [the Factory UX specification](https://github.com/Codeseys-Labs/t3factory/issues/29).
Inspiration sources, research, and parity evidence remain in
[the source register](https://github.com/Codeseys-Labs/t3factory/issues/1),
[research](https://github.com/Codeseys-Labs/t3factory/issues/27), and
[the design decision](https://github.com/Codeseys-Labs/t3factory/issues/28).
Those references do not imply feature parity or source reuse.

The [T3 Factory vision](./docs/factory/vision.md) describes a shared thread-first experience
for software, research, and knowledge work, with editable SVG, Mermaid, and draw.io diagrams.
It distinguishes existing capabilities from proposed orchestration and sandbox extensions.

## Upstream installation

The commands and releases below install upstream T3 Code, not this fork.
To work on this fork, use the source setup below and the
[development guide](./docs/operations/development.md).

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Some notes

This fork's issue tracker records Factory work. The upstream project has its own contribution
policy; read [CONTRIBUTING.md](./CONTRIBUTING.md) before proposing an upstream change.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Factory and source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Source setup and upstream support

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
