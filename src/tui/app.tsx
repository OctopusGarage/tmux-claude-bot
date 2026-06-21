import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlClient } from "../adapters/control/client.js";
import type { SessionRow } from "../core/dashboard/dashboard.js";
import { formatHeader } from "../core/dashboard/dashboard-view.js";
import { agentGlyph } from "../shared/types.js";
import {
  type ComposerState,
  composerStep,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
} from "./composer.js";

const PEEK_LINES = 80;

/** Control actions reachable from the `c` overlay, beyond the direct e/x/r keys. */
const CONTROLS = [
  "interrupt",
  "clear",
  "compact",
  "esc",
  "enter",
  "restart",
  "up",
  "down",
  "tab",
] as const;

/** The full keymap, shown in the `?` overlay. */
const HELP: [string, string][] = [
  ["j / k  ↑ / ↓", "move selection / scroll"],
  ["Enter", "refresh peek"],
  ["i", "compose a prompt — Enter sends, Alt+Enter / paste = multi-line"],
  ["p", "refresh peek"],
  ["l", "logs (WARN+) for this session"],
  ["m", "machine load (sysload)"],
  ["u", "recent inputs → Enter re-runs"],
  ["c", "controls (interrupt/clear/compact/…)"],
  ["e / x / r", "esc / enter / restart"],
  ["s", "projects — switch / start a project"],
  ["R", "recover (relaunch pre-restart agents)"],
  ["a", "attach to the real tmux pane"],
  ["q", "quit (the bot keeps running)"],
];

const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const shortLabel = (s: SessionRow): string => s.label || s.session;

type Mode = "list" | "input" | "controls" | "projects" | "logs" | "sysload" | "inputs" | "help";
type Project = { sid: string; label: string; alive: boolean; active: boolean };

export function App({
  client,
  onAttach,
  initialSession,
}: {
  client: ControlClient;
  onAttach: (session: string) => void;
  /** Select this session on first load (so the selection survives an attach). */
  initialSession?: string | undefined;
}): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const editor = useRef<ComposerState>({ value: "", cursor: 0, pasting: false });
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [sel, setSel] = useState(0);
  const [peek, setPeek] = useState("");
  const [mode, setMode] = useState<Mode>("list");
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const appliedInitial = useRef(false);
  const [status, setStatus] = useState("connecting…");
  // Live fleet summary line(s) shown at the top — the same header `tcb dashboard`
  // renders. Refreshed on every snapshot (activity events + the periodic timer).
  const [summary, setSummary] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projSel, setProjSel] = useState(0);
  const [overlayText, setOverlayText] = useState("");
  const [overlayTitle, setOverlayTitle] = useState("");
  const [overlayScroll, setOverlayScroll] = useState(0);
  const [inputsList, setInputsList] = useState<string[]>([]);
  const [inputSel, setInputSel] = useState(0);
  const refreshTimer = useRef<NodeJS.Timeout | null>(null);

  const selected = rows[Math.min(sel, Math.max(0, rows.length - 1))];
  // Keep both panes within the terminal (the 2-line fleet summary + status line +
  // footer + borders take ~10 rows).
  const bodyRows = Math.max(6, (stdout?.rows ?? 30) - 10);
  const peekRows = bodyRows;
  // Window the lists/overlays so long content scrolls with the selection.
  const listStart = Math.max(0, Math.min(sel - Math.floor(bodyRows / 2), rows.length - bodyRows));
  const visible = rows.slice(listStart, listStart + bodyRows);
  const projStart = Math.max(
    0,
    Math.min(projSel - Math.floor(bodyRows / 2), Math.max(0, projects.length - bodyRows)),
  );
  const projVisible = projects.slice(projStart, projStart + bodyRows);
  const overlayLines = overlayText.split("\n");
  const overlayScrollClamped = Math.min(overlayScroll, Math.max(0, overlayLines.length - peekRows));
  const overlayWindow = overlayLines
    .slice(overlayScrollClamped, overlayScrollClamped + peekRows)
    .join("\n");

  const loadSnapshot = useCallback(async () => {
    try {
      const snap = await client.snapshot();
      setRows(snap.sessions);
      setSummary(formatHeader(snap));
      // Clear the initial "connecting…" once, but never clobber a transient
      // reply/notify/error message that the periodic refresh would otherwise wipe.
      setStatus((s) => (s === "connecting…" ? "" : s));
    } catch (err) {
      setStatus(`snapshot failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [client]);

  const loadPeek = useCallback(
    async (session: string | undefined) => {
      if (!session) {
        setPeek("");
        return;
      }
      try {
        setPeek(await client.peek(session, PEEK_LINES));
      } catch (err) {
        setPeek(`peek failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [client],
  );

  useEffect(() => {
    void loadSnapshot();
    const onActivity = (): void => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void loadSnapshot();
        void loadPeek(selected?.session);
      }, 400);
    };
    const onReply = (m: { session: string; output: string }): void =>
      setStatus(`✓ ${m.session.slice(-18)}: ${m.output.replace(/\s+/g, " ").slice(0, 60)}`);
    const onNotify = (m: { text: string }): void => setStatus(`… ${m.text.slice(0, 70)}`);
    const onError = (m: { error: string }): void => setStatus(`✗ ${m.error.slice(0, 70)}`);
    const onDisc = (): void => setStatus("⚠ bot disconnected — reconnecting…");
    const onReconn = (): void => {
      setStatus("reconnected");
      void loadSnapshot();
    };
    client.on("activity", onActivity);
    client.on("reply", onReply);
    client.on("notify", onNotify);
    client.on("error", onError);
    client.on("disconnected", onDisc);
    client.on("reconnected", onReconn);
    return () => {
      client.off("activity", onActivity);
      client.off("reply", onReply);
      client.off("notify", onNotify);
      client.off("error", onError);
      client.off("disconnected", onDisc);
      client.off("reconnected", onReconn);
    };
  }, [client, loadSnapshot, loadPeek, selected?.session]);

  // Periodic refresh so the top fleet summary + busy timers stay live even when no
  // server activity event fires. Self-scheduling (not setInterval) so a slow
  // snapshot — buildDashboard pane-diffs idle sessions — never overlaps itself.
  useEffect(() => {
    let stopped = false;
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await loadSnapshot();
        if (!stopped) tick();
      }, 2000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [loadSnapshot]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-peek only on session change
  useEffect(() => {
    void loadPeek(selected?.session);
  }, [selected?.session]);

  // Restore the selection to the just-attached session on the first snapshot.
  useEffect(() => {
    if (appliedInitial.current || !initialSession || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.session === initialSession);
    if (idx >= 0) setSel(idx);
    appliedInitial.current = true;
  }, [rows, initialSession]);

  // Near-live peek: while the selected session is busy (and we're on the main
  // view), re-capture its pane on a short interval so the user sees it working.
  useEffect(() => {
    if (!selected?.busy || mode !== "list") return;
    const session = selected.session;
    const id = setInterval(() => void loadPeek(session), 1200);
    return () => clearInterval(id);
  }, [selected?.session, selected?.busy, mode, loadPeek]);

  // Raw line-editor while composing a prompt: own stdin directly (Ink's parsed
  // useInput is disabled for this mode) so a bracketed multi-line PASTE lands
  // verbatim instead of submitting at the first newline.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach only on mode change
  useEffect(() => {
    if (mode !== "input" || !isRawModeSupported) return;
    setRawMode(true);
    stdout.write(ENABLE_BRACKETED_PASTE);
    const onData = (chunk: Buffer): void => {
      const r = composerStep(editor.current, chunk.toString("utf8"));
      editor.current = r.state;
      setInput(r.state.value);
      setCursor(r.state.cursor);
      if (r.submit) void sendPrompt(r.state.value);
      else if (r.cancel) exitComposer();
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      stdout.write(DISABLE_BRACKETED_PASTE);
      setRawMode(false);
    };
  }, [mode]);

  const move = (d: number): void => setSel((i) => Math.max(0, Math.min(rows.length - 1, i + d)));
  const fail = (err: unknown): void => setStatus(`✗ ${err instanceof Error ? err.message : err}`);

  const doControl = async (action: string): Promise<void> => {
    if (!selected) return;
    setStatus(`→ ${action} → ${shortLabel(selected)}`);
    try {
      await client.control(selected.session, action);
    } catch (err) {
      fail(err);
    }
  };

  const exitComposer = (): void => {
    editor.current = { value: "", cursor: 0, pasting: false };
    setInput("");
    setCursor(0);
    setMode("list");
  };
  const sendPrompt = async (text: string): Promise<void> => {
    exitComposer();
    const t = text.trim();
    if (!t || !selected) return;
    setStatus(`→ sent to ${shortLabel(selected)}`);
    try {
      await client.send(selected.session, t);
    } catch (err) {
      fail(err);
    }
  };

  const openProjects = async (): Promise<void> => {
    try {
      setProjects(await client.projects());
      setProjSel(0);
      setMode("projects");
    } catch (err) {
      fail(err);
    }
  };
  const doRecover = async (): Promise<void> => {
    setStatus("recovering…");
    try {
      const r = await client.recover();
      setStatus(`recover: launched ${r.launched} · shell ${r.shellOnly} · alive ${r.alreadyAlive}`);
      void loadSnapshot();
    } catch (err) {
      fail(err);
    }
  };
  const doOpen = async (p: Project): Promise<void> => {
    setMode("list");
    setStatus(`opening ${p.label}…`);
    try {
      const r = await client.open(p.sid);
      setStatus(`open ${p.label}: ${r.status}${r.started ? ` (${r.started})` : ""}`);
      void loadSnapshot();
    } catch (err) {
      fail(err);
    }
  };
  const showText = async (
    m: "logs" | "sysload",
    title: string,
    load: () => Promise<string>,
  ): Promise<void> => {
    setOverlayTitle(title);
    setOverlayText("loading…");
    setOverlayScroll(0);
    setMode(m);
    try {
      const t = await load();
      setOverlayText(t);
      setOverlayScroll(Math.max(0, t.split("\n").length - peekRows)); // start at the tail
    } catch (err) {
      setOverlayText(`✗ ${err instanceof Error ? err.message : err}`);
    }
  };
  const openInputs = async (): Promise<void> => {
    if (!selected) return;
    try {
      setInputsList(await client.inputs(selected.session));
      setInputSel(0);
      setMode("inputs");
    } catch (err) {
      fail(err);
    }
  };
  const rerunInput = async (text: string): Promise<void> => {
    setMode("list");
    if (!selected) return;
    setStatus(`↻ re-running on ${shortLabel(selected)}`);
    try {
      await client.send(selected.session, text);
    } catch (err) {
      fail(err);
    }
  };

  useInput(
    (ch, key) => {
      if (mode === "help") {
        setMode("list"); // any key closes help
        return;
      }
      if (mode === "controls") {
        if (key.escape || ch === "c") setMode("list");
        else {
          const action = CONTROLS[Number.parseInt(ch, 10) - 1];
          if (action) {
            void doControl(action);
            setMode("list");
          }
        }
        return;
      }
      if (mode === "logs" || mode === "sysload") {
        if (
          key.escape ||
          ch === "q" ||
          (mode === "logs" && ch === "l") ||
          (mode === "sysload" && ch === "m")
        )
          setMode("list");
        else if (key.upArrow || ch === "k") setOverlayScroll((s) => Math.max(0, s - 1));
        else if (key.downArrow || ch === "j") setOverlayScroll((s) => s + 1); // clamped in render
        return;
      }
      if (mode === "projects") {
        if (key.escape || ch === "s") setMode("list");
        else if (key.upArrow || ch === "k") setProjSel((i) => Math.max(0, i - 1));
        else if (key.downArrow || ch === "j")
          setProjSel((i) => Math.min(projects.length - 1, i + 1));
        else if (key.return) {
          const p = projects[projSel];
          if (p) void doOpen(p);
        }
        return;
      }
      if (mode === "inputs") {
        if (key.escape || ch === "u") setMode("list");
        else if (key.upArrow || ch === "k") setInputSel((i) => Math.max(0, i - 1));
        else if (key.downArrow || ch === "j")
          setInputSel((i) => Math.min(inputsList.length - 1, i + 1));
        else if (key.return) {
          const t = inputsList[inputSel];
          if (t) void rerunInput(t);
        }
        return;
      }
      // list mode
      if (ch === "q") {
        client.close();
        exit();
      } else if (ch === "?") setMode("help");
      else if (key.upArrow || ch === "k") move(-1);
      else if (key.downArrow || ch === "j") move(1);
      else if (ch === "i") {
        setCursor(0);
        setMode("input");
      } else if (ch === "c") setMode("controls");
      else if (ch === "s") void openProjects();
      else if (ch === "R") void doRecover();
      else if (ch === "l" && selected)
        void showText("logs", `Logs · ${shortLabel(selected)}`, () =>
          client.logs(selected.session),
        );
      else if (ch === "m") void showText("sysload", "System load", () => client.sysload());
      else if (ch === "u") void openInputs();
      else if (ch === "p" || key.return) void loadPeek(selected?.session);
      else if (ch === "e") void doControl("esc");
      else if (ch === "x") void doControl("enter");
      else if (ch === "r") void doControl("restart");
      else if (ch === "a" && selected) {
        onAttach(selected.session); // run.ts suspends the TUI, drops into tmux, resumes
        exit();
      }
    },
    { isActive: mode !== "input" },
  );

  const pane = (title: JSX.Element, body: JSX.Element): JSX.Element => (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
      {title}
      {body}
    </Box>
  );

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column">
        {/* Live fleet summary — the same header `tcb dashboard` shows, refreshed
            on activity + a periodic timer; falls back to the title before the
            first snapshot lands. */}
        <Text bold color="cyan">
          {summary || " tmux-claude-bot "}
        </Text>
        <Text color="gray">{status}</Text>
      </Box>

      {mode === "help" ? (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
          <Text bold color="cyan">
            Keys
          </Text>
          {HELP.map(([k, d]) => (
            <Text key={k}>
              <Text color="yellow">{k.padEnd(14)}</Text>
              <Text color="gray"> {d}</Text>
            </Text>
          ))}
        </Box>
      ) : mode === "input" ? (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
          <Text bold color="green">
            Prompt → {selected ? shortLabel(selected) : "—"}
          </Text>
          <Text>
            {input.slice(0, cursor)}
            <Text inverse>{input[cursor] && input[cursor] !== "\n" ? input[cursor] : " "}</Text>
            {input[cursor] === "\n" ? "\n" : ""}
            {input.slice(cursor + 1)}
          </Text>
        </Box>
      ) : (
        <Box flexGrow={1}>
          <Box flexDirection="column" width={34} marginRight={1} borderStyle="round" paddingX={1}>
            {rows.length === 0 ? (
              <Text color="gray">no sessions</Text>
            ) : (
              visible.map((r, j) => {
                const i = listStart + j;
                return (
                  <Text key={r.session} inverse={i === sel} wrap="truncate">
                    {/* ● green = busy · ● yellow = idle (agent up) · ○ gray = stopped (no agent) */}
                    <Text color={r.busy ? "green" : r.running ? "yellow" : "gray"}>
                      {r.running ? "● " : "○ "}
                    </Text>
                    {agentGlyph(r.kind)} {shortLabel(r)}
                    {r.busy && r.taskMs ? ` ${fmtDur(r.taskMs)}` : ""}
                  </Text>
                );
              })
            )}
            {rows.length > bodyRows ? (
              <Text color="gray">
                {listStart > 0 ? "↑" : " "} {sel + 1}/{rows.length}{" "}
                {listStart + bodyRows < rows.length ? "↓" : " "}
              </Text>
            ) : null}
          </Box>

          {mode === "projects"
            ? pane(
                <Text bold color="yellow">
                  Projects · Enter open+start · Esc cancel
                </Text>,
                projects.length === 0 ? (
                  <Text color="gray">no projects</Text>
                ) : (
                  <Box flexDirection="column">
                    {projVisible.map((p, j) => {
                      const i = projStart + j;
                      return (
                        <Text key={p.sid} inverse={i === projSel} wrap="truncate">
                          <Text color={p.alive ? "green" : "gray"}>{p.alive ? "● " : "◌ "}</Text>
                          {p.label}
                          {p.active ? " *" : ""}
                        </Text>
                      );
                    })}
                  </Box>
                ),
              )
            : mode === "inputs"
              ? pane(
                  <Text bold color="yellow">
                    Inputs · {selected ? shortLabel(selected) : "—"} · Enter re-run · Esc
                  </Text>,
                  inputsList.length === 0 ? (
                    <Text color="gray">no inputs</Text>
                  ) : (
                    <Box flexDirection="column">
                      {inputsList.slice(0, bodyRows).map((t, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
                        <Text key={i} inverse={i === inputSel} wrap="truncate">
                          {i + 1}. {t.replace(/\s+/g, " ")}
                        </Text>
                      ))}
                    </Box>
                  ),
                )
              : mode === "logs" || mode === "sysload"
                ? pane(
                    <Text bold color="yellow" wrap="truncate">
                      {overlayTitle} · j/k scroll · Esc close
                    </Text>,
                    <Text>{overlayWindow}</Text>,
                  )
                : pane(
                    <Text bold wrap="truncate">
                      {selected ? shortLabel(selected) : "—"}{" "}
                      <Text color={selected?.busy ? "green" : "gray"}>
                        {selected?.busy ? "busy" : "idle"}
                      </Text>
                      <Text color="gray">
                        {selected
                          ? ` · up ${fmtDur(selected.uptimeMs)} · Σ ${fmtDur(selected.cumulativeBusyMs)}`
                          : ""}
                      </Text>
                    </Text>,
                    <Text>{peek ? peek.split("\n").slice(-peekRows).join("\n") : "(empty)"}</Text>,
                  )}
        </Box>
      )}

      {mode === "input" ? (
        <Text color="gray">Enter send · Alt+Enter newline · paste multi-line · Esc cancel</Text>
      ) : mode === "controls" ? (
        <Text color="yellow">
          {CONTROLS.map((a, i) => `${i + 1} ${a}`).join("  ")} · Esc cancel
        </Text>
      ) : mode === "projects" || mode === "inputs" ? (
        <Text color="gray">j/k move · Enter select · Esc cancel</Text>
      ) : mode === "logs" || mode === "sysload" ? (
        <Text color="gray">j/k scroll · Esc close</Text>
      ) : mode === "help" ? (
        <Text color="gray">any key to close</Text>
      ) : (
        <Text color="gray">
          j/k move · i prompt · a attach · s projects · u inputs · ? more keys · q quit
        </Text>
      )}
    </Box>
  );
}
