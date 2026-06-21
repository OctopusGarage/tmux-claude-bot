import { spawnSync } from "node:child_process";
import { render } from "ink";
import { createElement } from "react";
import { ControlClient } from "../adapters/control/client.js";
import { App } from "./app.js";

/** Launch the terminal UI. Connects to the running bot's control socket; if the
 * bot isn't up there's nothing to drive, so we exit with a hint rather than a
 * blank screen. The `a` key suspends the TUI, drops into the real tmux pane, and
 * resumes the TUI on detach. */
export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("tcb tui needs an interactive terminal (run it directly, not piped).\n");
    process.exitCode = 1;
    return;
  }
  const client = new ControlClient();
  try {
    await client.connect();
  } catch {
    process.stderr.write(
      "Can't reach the bot's control socket — is the bot running?\n" +
        "  managed service:  tcb service start\n" +
        "  dev:              npm run dev\n",
    );
    process.exitCode = 1;
    return;
  }

  // Render loop: the App resolves (exits) either to quit, or to attach to a tmux
  // session — in which case we hand the terminal to tmux, then re-render on return,
  // re-selecting the session we'd attached to.
  let resumeSession: string | undefined;
  for (;;) {
    let attachTo: string | null = null;
    const { waitUntilExit } = render(
      createElement(App, {
        client,
        onAttach: (s: string) => (attachTo = s),
        initialSession: resumeSession,
      }),
    );
    await waitUntilExit();
    if (!attachTo) break;
    // Inside tmux, `attach` would nest; switch the client to the session instead.
    const args = process.env.TMUX
      ? ["switch-client", "-t", attachTo]
      : ["attach-session", "-t", attachTo];
    spawnSync("tmux", args, { stdio: "inherit" });
    if (process.env.TMUX) break; // switch-client returns instantly; don't re-render over the switched view
    resumeSession = attachTo;
  }
  client.close();
}
