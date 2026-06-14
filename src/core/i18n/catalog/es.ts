import type { Messages } from "./zh.js";

/** Spanish catalog. Typed `: Messages`, so it must implement every key in zh.ts. */
export const es: Messages = {
  ackReceived: "Recibido",
  queuedAt: (pos) => `En cola · #${pos}`,
  queueFull: (max) => `Cola llena (máx. ${max}) — inténtalo de nuevo en un momento`,
  noCurrentProject:
    "Sin proyecto actual — elige uno con /list_alive_projects o crea uno con /add_project",
  errorPrefix: (msg) => `Error: ${msg}`,
  projectTag: (project) => `📂 ${project}`,

  voiceLangTitle: "🎙️ Idioma de voz",
  voiceLangCardPrompt: (lang) => `Actual (Feishu): **${lang}** · toca para cambiar`,
  autoDetect: "detección automática",
  voiceHeard: (text) => `🎙️ Dijiste: «${text}»`,
  voiceTranscribeFailed: "Falló la transcripción · reintenta o envía texto",
  voiceEmpty: "No te entendí · repítelo o envía texto",
  voiceUnsupported: "La transcripción de voz requiere Apple Silicon",
  voiceNotInstalled: "Voz no instalada (ejecuta `npm run whisper:install` en el repo)",

  currentProjectIs: (project) => `📂 Proyecto actual: ${project}`,
  switched: "Cambiado",
  switchedTo: (project) => `Cambiado a: ${project}`,
  removed: "Eliminado",
  nestingWarning:
    "⚠️ Este es el propio repo de tmux-claude-bot — manejarlo desde el bot suele anidarse (solo «recibido», sin resultado). Cambia a un proyecto real.",

  uiLangTitle: "🌐 Idioma de la interfaz",
  uiLangCurrent: (lang) => `Idioma de la interfaz: ${lang} · toca para cambiar`,
  uiLangSet: (lang) => `Idioma de la interfaz establecido en ${lang}`,

  helpTitle: "Ayuda",
  helpRunning: "**⚡ En ejecución**",
  helpProjects: "**📂 Proyectos / Vistas**",

  btnEnter: "⏎ Entrar",
  btnEsc: "⎋ Esc",
  btnInterrupt: "✋ Interrumpir",
  btnRestart: "🔄 Reiniciar",
  btnClear: "🧹 clear",
  btnCompact: "🗜 compact",
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 Estado",
  btnStart: "🚀 Iniciar",
  btnExit: "🚪 Salir",
  btnPeek: "👁 peek",
  btnHistory: "📜 Historial",
  btnQueue: "📋 Cola",
  btnProjects: "📁 Proyectos",
  btnRecent: "🕘 Recientes",
  btnCurrent: "📌 Actual",
  btnAddProject: "➕ Nuevo proyecto",
  btnSwitch: "🔀 Cambiar",
  btnRemove: "🗑 Eliminar",
  btnCreate: "➕ Crear",
  btnHelp: "💡 Ayuda",
  btnVoiceLang: "🎙️ Voz",
  btnVoiceInstall: "🎙️ Instalar voz",
  btnUiLang: "🌐 Idioma",
  btnActiveMarker: "✅ Actual",
  btnMore: "⌨️ Más ▾",
  btnCollapse: "▴ Contraer",
  btnCancel: "✕ Cancelar",
  btnDeleteMode: "🗑 Eliminar…",

  // ── adopt (take over a non-tmux claude) ──
  adoptTitle: "🧲 Procesos de Claude adoptables (fuera de tmux)",
  adoptEmpty: "No se encontraron procesos de Claude adoptables",
  adoptConfirmPrompt: (label: string) =>
    `¿Tomar el control? Primero se interrumpe y termina el proceso original, luego se reanuda en tmux:\n${label}`,
  btnAdoptConfirm: "🧲 Adoptar",
  btnAdoptCancel: "✕ Cancelar",
  adoptCancelled: "Adopción cancelada",
  adoptWorking: "Adoptando…",
  adoptGone: "Ese proceso ya no es adoptable (terminó o ya está en tmux)",
  adoptDone: (proj: string, resumed: boolean) =>
    resumed
      ? `✅ Adoptado y sesión reanudada: ${proj}`
      : `✅ Adoptado e iniciado de nuevo: ${proj}`,
  adoptFailed: "Fallo al adoptar: el proceso no terminó o Claude no se inició",
  adoptBusy:
    "La sesión de tmux destino ya tiene un programa en primer plano (otro Claude u otra cosa). Se canceló sin tocar el original — sal de ahí primero y vuelve a adoptar.",
  btnAdoptAttach: "💻 Ver en la terminal del computador (opcional)",
  adoptAttachHint: (cmd: string) =>
    `✅ El comando de conexión ya está en el portapapeles de tu COMPUTADOR (no hace falta copiar nada en el móvil). Al volver, solo pégalo en una terminal y pulsa Enter para entrar — este paso es opcional.\nComando: ${cmd}`,

  doneShort: "Listo",
  claudeNotRunningRestart: "Claude no está en ejecución — usa /restart para iniciarlo",
  contentTruncated: "...(contenido demasiado largo, truncado)",
  claudeEmptyOutput: "Claude no devolvió nada · /peek para ver el panel",
  claudeStarted: "✅ Claude iniciado",
  claudeStartedWith: (label) => `✅ Claude iniciado con «${label}»`,
  startPickerTitle: "🚀 Elige cómo iniciar",
  startPickerPrompt: "Hay varios comandos de inicio configurados — elige uno:",
  btnStartThis: "🚀 Iniciar este",
  claudeExited: "✅ Claude cerrado",
  claudeRestarted: "🔄 Claude reiniciado · --continue",
  sentEsc: "✅ Esc enviado",
  interrupted: "✅ Interrumpido · Ctrl-C",
  clearedContext: "✅ Contexto borrado · /clear",
  compactedContext: "✅ Contexto compactado · /compact",
  sentEnter: "✅ Enter enviado",
  sentUp: "✅ ↑ enviado",
  sentDown: "✅ ↓ enviado",
  sentLeft: "✅ ← enviado",
  sentRight: "✅ → enviado",
  sentTab: "✅ Tab enviado",
  statusRunning: "🟢 Claude en ejecución",
  statusNotRunning: "🔴 Claude detenido",
  statusContext: (bar, pct) => `📊 Contexto ${bar} ${pct}%`,
  statusFiveHour: (bar, pct, reset) => `⏱ Sesión (5h) ${bar} ${pct}% (reinicia ${reset})`,
  statusSevenDay: (bar, pct, reset) => `📅 Semanal ${bar} ${pct}% (reinicia ${reset})`,
  statusUsageStale: (mins) =>
    `⚠️ Datos de uso con ${mins} min de antigüedad (Claude Code pudo detenerse)`,

  // -- status usage install --
  statusUsageHint: "💡 ¿Ver el uso? Envía /status_install para configurarlo",
  statusInstallTitle: "📊 Instalación de reporte de uso",
  statusInstallNoClaude:
    "No se detectó ningún Claude en ejecución, así que no hay dónde instalar. Inicia un Claude primero.",
  statusInstallInstalled: (dir) => `✅ ${dir} reporte de uso instalado`,
  statusInstallAlready: (dir) => `⏭ ${dir} ya instalado`,
  statusInstallForeignPrompt: (dirs) =>
    `⚠️ Estos directorios ya tienen un statusLine propio — ¿qué hacer?\n${dirs.join("\n")}`,
  statusInstallOverwritten: (dir, backup) => `🔁 ${dir} sobrescrito (respaldo: ${backup})`,
  statusInstallWrapped: (dir, backup) =>
    `📦 ${dir} envuelto: conserva tu visualización + uso\n   ⚠️ Tu statusLine ahora pasa por el envoltorio del bot; si la barra falla, restaura desde: ${backup}`,
  statusInstallSnippet: (dir, snippet) =>
    `✍️ ${dir}: añade esto a tu script de statusline (debe hacer input=$(cat)):\n${snippet}`,
  statusInstallSkipped: (dir) => `✖️ ${dir} omitido`,
  statusInstallError: (dir, msg) => `❌ ${dir}: ${msg}`,
  btnStatusInstall: "📊 Instalar uso",
  btnStatusOverwrite: "🔁 Sobrescribir",
  btnStatusWrap: "📦 Envolver",
  btnStatusSnippet: "✍️ Dame el fragmento",
  btnStatusSkip: "✖️ Omitir",
  queueGlobalHeader: "━━ 🌐 Cola global ━━",
  queueCounts: (queued, processing) =>
    `En cola: ${queued} | Procesando: ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ Colas de sesión ━━",
  queueNoSessions: "No hay colas de sesión activas",
  queueLastDone: (s) => `último completado hace ${s}s`,
  queueTitle: "Estado de la cola",

  paneTitle: "👁 panel de tmux",
  emptyPane: "(vacío)",
  historyTitle: "📜 Historial",
  historyTitleShort: "Historial",
  noPathMapping: "Sin asignación de ruta · créala primero con /add_project",
  noHistory: "No se encontró historial de conversación",
  onlyNRounds: (n) => `Solo ${n} conversación(es)`,
  emptyOutput: "(sin salida)",

  noCurrentProjectShort: "Sin proyecto actual",
  aliveListTitle: (n) => `Proyectos activos (${n})`,
  aliveListEmpty: "No hay proyectos activos — crea uno con /add_project <ruta>",
  recentListTitle: "Proyectos recientes",
  recentListTitleN: (n) => `Proyectos recientes (${n})`,
  recentListEmpty: "No hay proyectos recientes — añade uno con /add_project <ruta>",

  notADir: (p) => `${p} no es un directorio`,
  dirNotExist: (p) => `Directorio no encontrado: ${p}`,
  pathNotAllowedPath: (p) => `Ruta no permitida: ${p}`,
  alreadySwitched: "Ya existe · cambiado",
  projectCreated: "Proyecto creado",
  projectCreatedPath: (p) => `Proyecto creado: ${p}`,
  browseTitle: "📂 Elige la ubicación del proyecto",
  browseRootsTitle: "📂 Elige un directorio inicial",
  browseEmpty: "(sin subdirectorios)",
  browseUnreadable: "⚠️ No se puede leer este directorio",
  browseCancelled: "Cancelado",
  btnBrowseUp: "⬆️ Subir",
  btnBrowseCreate: "✅ Crear proyecto aquí",
  btnBrowseCancel: "✖️ Cancelar",
  btnBrowseNewFolder: "➕ Nueva carpeta",
  browseNewFolderPrompt: (p) => `Responde con el nombre de la nueva carpeta a crear en ${p}`,
  browseNewFolderInvalid: "❌ Nombre no válido (no puede estar vacío ni contener «/»)",
  browseNewFolderExists: "❌ Ese nombre ya existe",
  browseNewFolderError: "❌ No se pudo crear la carpeta",
  shortIdNotFound: (id) => `ID corto no encontrado: ${id}`,
  noCurrentProjectSet: "No hay proyecto actual definido\n\nDefine uno con /add_project <ruta>",
  currentActive: "✅ activo",
  currentNotFound: "🔴 no encontrado",
  currentProjectTitle: "Proyecto actual",
  noRecentProjects: "No hay proyectos recientes\n\nAñade uno con /add_project <ruta>",
  messageTooLong: (len, max) => `Mensaje demasiado largo · ${len} > ${max} caracteres`,
  onlyTextVoice: "Solo se admiten mensajes de texto y de voz",
  unknownCommand: (name) => `Comando desconocido: /${name} (envía /help para ver la lista)`,

  toastProcessing: "➕ Trabajando…",
  sessionGone: "Sesión no encontrada o ya finalizada",
  toastSwitched: "✅ Cambiado",
  toastRemoving: "🗑 Eliminando…",
  toastSent: (action) => `/${action} enviado`,
  toastError: "Algo salió mal",

  processingQueued: (pos) => `Trabajando · cola #${pos}`,
  processing: "Trabajando",
  duplicateIgnored: "Duplicado ignorado — tu mensaje idéntico ya se está procesando",
  failed: "Falló",
  taskStillRunning: (body) =>
    `⏳ La tarea sigue en curso · /peek para ver el resultado actual\n\n${body}`,
  taskStillRunningNotice:
    "⏳ Aún en curso — el resultado se enviará automáticamente al terminar · /peek para verlo en vivo",
  voiceDownloadFailed: "Falló la descarga de voz · problema de red, reintenta",
  historyYou: "🧑‍💻 Tú",
  crashRecovered: (time) =>
    `♻️ tmux-claude-bot se recuperó de una salida anómala (caída / kill) · ${time}`,

  noSession: "Sin sesión activa · primero /list_alive_projects o /add_project",
  notRunning: "Claude no está en ejecución · /start para lanzarlo, o /restart para continuar",
  noShortId: (id) => `ID corto no encontrado: ${id}`,
  pathNotAllowed: (dirs) => `Ruta fuera de la lista permitida · permitidas: ${dirs.join(", ")}`,
  voiceNotEnabled:
    "🎙️ Voz no habilitada · envía /voice_install (solo Apple Silicon), o ejecuta `npm run whisper:install` en el host",
  voiceNeedsAppleSilicon:
    "🎙️ La transcripción de voz requiere Apple Silicon (macOS arm64) · este host no puede, envía texto",
  voiceAlreadyInstalled: "🎙️ La voz está lista · solo envía un mensaje de voz",
  voiceInstalling: "🎙️ Instalando voz · la primera vez descarga dependencias (~1-2 min), espera…",
  voiceInstallOk: "🎙️ La voz está lista · ya puedes enviar mensajes de voz",
  voiceInstallFailed: (e) =>
    `🎙️ Falló la instalación · ${e} · ejecuta \`npm run whisper:install\` en el host para más detalles`,
  voiceLangCurrent: (lang) =>
    `🎙️ Idioma de reconocimiento: ${lang === "auto" ? "detección automática" : lang} · toca abajo para cambiar`,
  voiceLangSet: (lang) =>
    `🎙️ Idioma de reconocimiento establecido en ${lang === "auto" ? "detección automática" : lang} · próximo mensaje de voz`,
  voiceLangInvalid: "🎙️ Uso: /voice_lang <en|zh|yue|ja|es|auto o un código de 2-3 letras>",

  helpIntroTelegram: `🤖 tmux-claude-bot

Envía cualquier texto → se reenvía a Claude → respuesta
🎙️ La transcripción de voz es opcional · /voice_install para habilitarla (solo Apple Silicon) · /voice_lang para fijar el idioma

Consejo: los mensajes reciben reacciones 👀 (recibido) / 👍 (hecho); el progreso se muestra en el sitio y se edita hasta el resultado; el resultado lleva debajo botones ⏎/✋/⎋/🔄.`,

  helpIntroLark: `🤖 tmux-claude (Lark)

Envía cualquier texto → se reenvía a Claude → respuesta`,

  helpSectionProjects: "📂 Proyectos",
  helpSectionRunning: "⚡ En ejecución",
  helpSectionIdle: "🚀 Detenido",

  cmdCurrentProject: "proyecto actual",
  cmdListAlive: "proyectos activos (toca para cambiar/eliminar)",
  cmdListRecent: "proyectos recientes",
  cmdAddProject: "crear un proyecto",
  cmdAdopt: "adoptar un Claude que corre fuera de tmux",
  cmdQueueStatus: "estado de la cola",
  cmdHistory: "historial de conversación (el último por defecto)",
  cmdPeek: "ver el panel de tmux",
  cmdVoiceLang: "idioma de reconocimiento de voz (en/zh/yue/ja/es/auto)",
  cmdLang: "idioma de la interfaz (en/zh/zh-TW/yue/ja/es)",
  cmdEnter: "Enter",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "reiniciar (--continue)",
  cmdClear: "borrar contexto",
  cmdCompact: "compactar contexto",
  cmdArrowsTab: "flechas / Tab",
  cmdExit: "salir",
  cmdStatus: "comprobar estado",
  cmdStart: "iniciar Claude",
  cmdDoctor: "ejecutar comprobaciones de instalación",
  cmdHelp: "esta ayuda",
  cmdWs: "gestión de espacios de trabajo (save/use/list/remove)",

  // ── workspaces ──
  wsSaved: (name, session) => `✅ Espacio de trabajo «${name}» guardado → ${session}`,
  wsUsed: (name) => `✅ Cambiado al espacio de trabajo «${name}»`,
  wsRemoved: (name) => `✅ Espacio de trabajo «${name}» eliminado`,
  wsNotFound: (name) => `Espacio de trabajo «${name}» no encontrado`,
  wsSessionGone: (name) => `La sesión del espacio de trabajo «${name}» ya no existe`,
  wsNoCurrentProject: "Sin proyecto actual — usa /add_project primero",
  wsListEmpty: "No hay espacios de trabajo guardados",
  wsListTitle: "📎 Espacios de trabajo",
  wsListItem: (name, session) => `• **${name}** → ${session}`,
  wsInvalidName:
    "Nombre del espacio: solo letras, dígitos, guiones y guiones bajos (1-32 caracteres)",
  wsUsage: "Uso: /ws <save <nombre> | use <nombre> | list | remove <nombre>>",

  // ── sessions ──
  noSessions: "No se encontraron sesiones guardadas",
  sessionsTitle: (n) => `${n} sesiones guardadas — toca para reanudar`,
  sessionsLabel: (id, ago) => `${id} · ${ago}`,
  resumeStarted: (id) => `✅ Sesión ${id} reanudada`,
  cmdSessions: "Explorar y reanudar sesiones anteriores",

  // ── group binding (Feishu) ──
  groupBoundWelcome: (label, path) =>
    `🎉 Grupo vinculado a **${label}**\n\`${path}\`\n\nSolo escribe — sin @ necesario.`,
  groupCreateFailed: (msg) =>
    `❌ No se pudo crear el grupo: ${msg}\n\nAsegúrate de que el bot tenga el permiso \`im:chat\`.`,
  groupBindOnlyInGroup:
    "`/bind` solo funciona dentro de un grupo. En un chat privado usa `/newgroup`.",
  groupUnbindOnlyInGroup: "`/unbind` solo funciona dentro de un grupo.",
  groupNewGroupOnlyInP2p: "`/newgroup` solo funciona en un chat privado con el bot.",
  groupRestored: (label) => `🔄 Este grupo se restauró → **${label}**.`,
  groupMissingPath: (label) =>
    `⚠️ El espacio de trabajo de **${label}** ya no está en disco. Usa \`/rebind <ruta|nombre>\` para apuntar este grupo a otro lugar.`,
  groupUnbound: "🔓 Este grupo ya no está vinculado a un espacio de trabajo.",
  groupNotBound: "Este grupo no está vinculado a un espacio de trabajo. Usa `/bind <ruta|nombre>`.",
  groupTargetUsage: "Uso: `<comando> <ruta absoluta | ~/ruta | nombre del espacio>`",
  btnGroupMenu: "🗂 Grupos de proyecto",
  btnMakeGroup: "🆕 Nuevo grupo",
  btnBindHere: "🔗 Vincular",
  btnRebindGroup: "🔁 Revincular",
  btnUnbindGroup: "🔓 Desvincular",
  btnRestoreGroup: "🔄 Restaurar",
  groupPickerTitle: "🆕 Nuevo grupo de proyecto — elige un proyecto",
  groupBindPickerTitle: "🔗 Vincular este grupo — elige un proyecto",
  groupBoundCardTitle: (label) => `🗂 Este grupo está vinculado a: ${label}`,
  groupMenuNoProjects:
    "Aún no hay proyectos recientes. Añade uno en un chat privado con `/add_project <ruta>`.",
  groupCreatedShort: (label) =>
    `✓ Grupo de proyecto «${label}» creado — continúa en el grupo nuevo.`,
  groupAlreadyExists: (label) =>
    `⚠️ El proyecto «${label}» ya tiene un grupo vinculado — usa ese; no hace falta crear otro.`,
  groupPinnedNoSwitch: (label) =>
    `🔒 Este grupo está fijado a «${label}» — cambiar de proyecto está deshabilitado aquí. Usa 🗂 → Revincular para cambiarlo.`,
  groupNoRemoveInGroup:
    "🔒 Eliminar proyectos no se permite en un grupo (afecta a otros). Hazlo en un chat privado con el bot.",
};
