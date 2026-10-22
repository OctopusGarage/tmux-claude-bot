export type UiIcon = string;

type IconDefinition = {
  icon: UiIcon;
  meaning: string;
};

type IconRegistry = Record<string, Record<string, IconDefinition>>;

export const UI_ICON_REGISTRY = {
  tone: {
    ok: { icon: "✅", meaning: "operation succeeded or acknowledged" },
    result: { icon: "💬", meaning: "agent result or reply" },
    error: { icon: "❌", meaning: "error or failed operation" },
    warning: { icon: "⚠️", meaning: "warning or degraded state" },
    queue: { icon: "📥", meaning: "queue / inbox view" },
    queued: { icon: "⏳", meaning: "queued or waiting work" },
    list: { icon: "🗒️", meaning: "plain list view" },
    view: { icon: "👁", meaning: "session pane or read-only view" },
    recover: { icon: "♻️", meaning: "recovery flow" },
  },
  agent: {
    generic: { icon: "🤖", meaning: "agent in general" },
    claude: { icon: "🟠", meaning: "Claude agent" },
    codex: { icon: "🔘", meaning: "Codex agent" },
    none: { icon: "💤", meaning: "no live agent detected" },
  },
  session: {
    active: { icon: "🟢", meaning: "session is running" },
    idle: { icon: "🟡", meaning: "session is running but idle" },
    stopped: { icon: "⚫", meaning: "session is stopped" },
    current: { icon: "📌", meaning: "current session" },
    independent: { icon: "🧩", meaning: "independent session for parallel work" },
    regular: { icon: "🏠", meaning: "regular path-backed session" },
    busy: { icon: "⏳", meaning: "agent or session has active work" },
    driftedPath: {
      icon: "⚠️",
      meaning: "session pane path differs from the bound workspace",
    },
    pane: { icon: "👁", meaning: "session pane / peek view" },
  },
  project: {
    project: { icon: "📂", meaning: "project label" },
    workspace: { icon: "📍", meaning: "workspace path" },
    repository: { icon: "📦", meaning: "git repository" },
    recent: { icon: "🕘", meaning: "recent projects" },
    create: { icon: "➕", meaning: "create/add" },
    switch: { icon: "🔀", meaning: "switch session" },
    remove: { icon: "🗑", meaning: "delete/remove" },
  },
  group: {
    projectGroup: { icon: "🗂", meaning: "project group" },
    none: { icon: "➖", meaning: "no group binding" },
    create: { icon: "🆕", meaning: "create group" },
    bind: { icon: "🔗", meaning: "bind group" },
    unbind: { icon: "🔓", meaning: "unbind group" },
  },
  action: {
    start: { icon: "🚀", meaning: "start" },
    restart: { icon: "🔄", meaning: "restart or restore" },
    exit: { icon: "🔌", meaning: "disconnect / exit agent" },
    interrupt: { icon: "🛑", meaning: "interrupt / Ctrl-C" },
    clear: { icon: "🧹", meaning: "clear context" },
    compact: { icon: "📦", meaning: "compact context" },
    cancel: { icon: "✕", meaning: "cancel" },
    help: { icon: "💡", meaning: "help" },
    status: { icon: "📊", meaning: "status / dashboard" },
    enter: { icon: "⏎", meaning: "send Enter key" },
    esc: { icon: "⎋", meaning: "send Escape key" },
    tab: { icon: "⇥", meaning: "send Tab key" },
    up: { icon: "⬆️", meaning: "send Up key" },
    down: { icon: "⬇️", meaning: "send Down key" },
    left: { icon: "⬅️", meaning: "send Left key" },
    right: { icon: "➡️", meaning: "send Right key" },
  },
  feature: {
    voice: { icon: "🎙️", meaning: "voice recognition" },
    language: { icon: "🌐", meaning: "language setting" },
    translate: { icon: "🔤", meaning: "translation" },
    history: { icon: "📜", meaning: "conversation history" },
    inputs: { icon: "🔁", meaning: "recent inputs / re-run" },
    dashboard: { icon: "📊", meaning: "dashboard" },
    adopt: { icon: "🧲", meaning: "take over unmanaged agent" },
    autopilot: { icon: "✈️", meaning: "supervisor-backed Autopilot delegation" },
    tag: { icon: "🏷", meaning: "prompt tag" },
  },
} as const satisfies IconRegistry;

type IconsOnly<T extends IconRegistry> = {
  [Category in keyof T]: {
    [Name in keyof T[Category]]: T[Category][Name]["icon"];
  };
};

function iconsFromRegistry<T extends IconRegistry>(registry: T): IconsOnly<T> {
  const icons: Record<string, Record<string, UiIcon>> = {};
  for (const [category, definitions] of Object.entries(registry)) {
    const group: Record<string, UiIcon> = {};
    for (const [name, definition] of Object.entries(definitions)) {
      group[name] = definition.icon;
    }
    icons[category] = group;
  }
  return icons as IconsOnly<T>;
}

export const UI_ICONS = iconsFromRegistry(UI_ICON_REGISTRY);

export const UI_ICON_MEANINGS: ReadonlyArray<{
  key: string;
  icon: UiIcon;
  meaning: string;
}> = Object.entries(UI_ICON_REGISTRY).flatMap(([category, group]) =>
  Object.entries(group).map(([name, definition]) => ({
    key: `${category}.${name}`,
    icon: definition.icon,
    meaning: definition.meaning,
  })),
);
