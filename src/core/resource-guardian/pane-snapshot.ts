import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type PaneSnapshotProbe = () => Promise<ReadonlyMap<string, readonly number[]>>;

type PaneSnapshotExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const run = promisify(execFile);

/** Observe live panes in one command, independent of retained WorkOrder history. */
export function createBulkPaneSnapshotProbe(
  input: { exec?: PaneSnapshotExec } = {},
): PaneSnapshotProbe {
  const exec: PaneSnapshotExec =
    input.exec ?? ((file, args, options) => run(file, args, { ...options, encoding: "utf8" }));
  return async () => {
    const { stdout } = await exec(
      "tmux",
      ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const panes = new Map<string, number[]>();
    for (const [index, line] of stdout.split("\n").entries()) {
      if (line === "") continue;
      const match = line.match(/^([^\t]+)\t([1-9]\d*)$/);
      const pid = Number(match?.[2]);
      if (!match?.[1] || !Number.isSafeInteger(pid)) {
        const fields = line.split("\t");
        const reason =
          fields.length !== 2
            ? "field-count"
            : fields[0] === ""
              ? "empty-session"
              : !/^[1-9]\d*$/.test(fields[1] ?? "")
                ? "invalid-pid"
                : "unsafe-pid";
        throw new Error(`invalid tmux pane snapshot: row=${index + 1} reason=${reason}`);
      }
      const pids = panes.get(match[1]) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      panes.set(match[1], pids);
    }
    for (const pids of panes.values()) pids.sort((left, right) => left - right);
    return panes;
  };
}
