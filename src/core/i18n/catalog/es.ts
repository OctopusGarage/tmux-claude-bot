import { UI_ICONS } from "../../../shared/ui/icons.js";
import type { Messages } from "./zh.js";

/** Spanish catalog. Typed `: Messages`, so it must implement every key in zh.ts. */
export const es: Messages = {
  ackReceived: "Recibido",
  queuedAt: (pos) => `En cola · #${pos}`,
  queueFull: (max) => `Cola llena (máx. ${max}) — inténtalo de nuevo en un momento`,
  noCurrentProject:
    "Sin sesión actual — elige uno con /list_alive_projects o crea uno con /add_project",
  errorPrefix: (msg) => `Error: ${msg}`,
  projectTag: (project) => `📂 ${project}`,

  voiceLangTitle: "🎙️ Idioma de voz",
  voiceLangCardPrompt: (lang) => `Actual (Feishu): **${lang}** · toca para cambiar`,
  autoDetect: "detección automática",
  voiceHeard: (text) => `🎙️ Dijiste: «${text}»`,
  voiceHeardTranslated: (original, translated) =>
    `🎙️ Dijiste: «${original}»\n🌐 Enviando en inglés: «${translated}»`,
  promptTranslateTitle: `${UI_ICONS.feature.translate} Modo de traducción`,
  promptTranslateCardPrompt: (mode) => `Actual: **${mode}** · toca para cambiar`,
  voiceTranscribeFailed: "Falló la transcripción · reintenta o envía texto",
  voiceTranslateFailed: "Falló la traducción · reintenta o envía texto",
  promptTranslateFailed: "Falló la traducción · reintenta o desactiva la traducción de prompts",
  promptTranslatedSent: (from, to) => `Traducido y enviado ${from}->${to}`,
  promptTranslateAlreadyInstalled: "🌐 Las dependencias de traducción de prompts están listas",
  promptTranslateInstalling:
    "🌐 Instalando dependencias de traducción de prompts · la primera vez descarga el modelo…",
  promptTranslateInstallOk:
    "🌐 Las dependencias de traducción de prompts están listas · ya puedes activar el modo",
  promptTranslateInstallFailed: (e) =>
    `🌐 Falló la instalación · ${e} · ejecuta npm run translate:install en el host para más detalle`,
  voiceEmpty: "No te entendí · repítelo o envía texto",
  voiceUnsupported: "La transcripción de voz requiere Apple Silicon",
  voiceNotInstalled: "Voz no instalada (ejecuta `npm run whisper:install` en el repo)",

  currentProjectIs: (project) => `${UI_ICONS.session.current} Sesión actual: ${project}`,
  projectStatusSession: (alive) =>
    `${alive ? UI_ICONS.session.active : UI_ICONS.session.stopped} Sesión: ${alive ? "en ejecución" : "detenida"}`,
  projectStatusAgent: (agent, running, busy) =>
    agent
      ? `${running ? (busy ? UI_ICONS.session.busy : UI_ICONS.agent.generic) : UI_ICONS.session.stopped} Agente: ${agent}${running ? (busy ? " ocupado" : " inactivo") : " detenido"}`
      : `${UI_ICONS.agent.none} Agente: ninguno`,
  projectStatusType: (isFree) =>
    `${isFree ? UI_ICONS.session.independent : UI_ICONS.session.regular} Tipo: ${isFree ? "sesión independiente" : "sesión regular"}`,
  projectStatusGroup: (label) =>
    `${label ? UI_ICONS.group.projectGroup : UI_ICONS.group.none} Grupo: ${label ?? "ninguno"}`,
  projectStatusLine: (session, agent, type, group) => `${session} · ${agent} · ${type} · ${group}`,
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
  btnInterrupt: `${UI_ICONS.action.interrupt} Interrumpir`,
  btnRestart: "🔄 Reiniciar",
  btnClear: `${UI_ICONS.action.clear} clear`,
  btnCompact: `${UI_ICONS.action.compact} compact`,
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 Estado",
  btnStart: "🚀 Iniciar",
  btnResume: "🔄 Reanudar",
  btnExit: `${UI_ICONS.action.exit} Salir`,
  btnPeek: "👁 peek",
  btnHistory: "📜 Historial",
  btnInputs: "🔁 Reenviar",
  btnQueue: `${UI_ICONS.tone.queue} Cola`,
  btnDashboard: "📊 Panel",
  btnProjects: "🟢 Sesiones activas",
  btnRecent: "🕘 Recientes",
  btnCurrent: "📌 Sesión actual",
  btnAddProject: "➕ Nuevo proyecto",
  btnSwitch: "🔀 Cambiar",
  btnRemove: "🗑 Eliminar",
  btnCreate: "➕ Crear",
  btnHelp: "💡 Ayuda",
  btnVoiceLang: "🎙️ Voz",
  btnVoiceInstall: "🎙️ Instalar voz",
  btnPromptTranslate: `${UI_ICONS.feature.translate} Traducir`,
  btnPromptTranslateOff: "⏻ Desactivar",
  btnPromptTranslateInstall: `${UI_ICONS.feature.translate} Instalar traducción`,
  btnUiLang: "🌐 Idioma",
  btnActiveMarker: "✅ Actual",
  btnMore: "⌨️ Más ▾",
  btnCollapse: "▴ Contraer",
  btnCancel: "✕ Cancelar",
  btnConfirmAction: (action) => `Confirmar ${action}`,
  btnDeleteMode: "🗑 Eliminar…",
  confirmActionBody: (action, impact, target) =>
    `Confirmar acción: ${action}\n\nDestino: ${target}\nImpacto: ${impact}\n\nConfirma para continuar.`,
  confirmImpactExit: "Cierra el agente actual y limpia la cola pendiente de esa sesión.",
  confirmImpactRestart:
    "Interrumpe y reinicia el agente actual; la entrada no enviada puede perderse.",
  confirmImpactClear: "Envía /clear y limpia el contexto actual del agente.",
  confirmImpactCompact: "Envía /compact y compacta el contexto actual del agente.",

  // ── adopt (take over an unmanaged agent) ──
  adoptTitle: "🧲 Procesos no gestionados adoptables",
  adoptEmpty: "No se encontraron procesos adoptables",
  adoptConfirmPrompt: (label: string) =>
    `¿Tomar el control? Primero se interrumpe y termina el proceso original, luego se reanuda en una sesión gestionada:\n${label}`,
  btnAdoptConfirm: "🧲 Adoptar",
  btnAdoptAsFree: `${UI_ICONS.session.independent} Adoptar como sesión independiente`,
  btnAdoptCancel: "✕ Cancelar",
  adoptCancelled: "Adopción cancelada",
  adoptWorking: "Adoptando…",
  recoverEmpty: "No hay proyectos que recuperar.",
  cmdInputs: "Recuperar una entrada reciente para editar",
  inputsTitle: "📝 Entradas recientes (toca para recuperar y editar)",
  inputsEmpty: "No hay entradas recientes",
  inputsExpired: "La lista caducó — envía /inputs de nuevo",
  inputDraftToast: "✏️ Recuperado como borrador — edítalo y envíalo",
  recoverAllRunning: (count: number, list: string) =>
    `🟢 Los ${count} proyecto(s) están en ejecución; no hay nada que recuperar:\n\n${list}`,
  btnRecover: "🔄 Recuperar",
  recoverPreview: (count: number, alive: number, list: string) =>
    `🔄 Se recuperarán ${count} proyecto(s)${alive > 0 ? ` (${alive} en ejecución, se omiten)` : ""}\n\n${list}\n\n¿Confirmar la recuperación?`,
  btnRecoverConfirm: "🔄 Confirmar recuperación",
  recoverWorking: "Recuperando…",
  recoverCancelled: "Recuperación cancelada.",
  recoverBusy: "Ya hay una recuperación en curso.",
  recoverDone: (launched: number, shellOnly: number, alive: number, failed: number) =>
    `🔄 Recuperación completada\n\n🔁 ${launched} reiniciado(s)${shellOnly > 0 ? ` · 🐚 ${shellOnly} recreado(s)` : ""} · 🟢 ${alive} en ejecución${failed > 0 ? ` · ⚠️ ${failed} con error` : ""}`,
  adoptGone: "Ese proceso ya no es adoptable (terminó o ya está gestionado)",
  adoptDone: (proj: string, resumed: boolean) =>
    resumed
      ? `✅ Adoptado y sesión reanudada: ${proj}`
      : `✅ Adoptado e iniciado de nuevo: ${proj}`,
  adoptFailed: "Fallo al adoptar: el proceso no terminó o el agente no se inició",
  adoptBusy:
    "La sesión destino ya tiene un programa en primer plano (otro agente u otra cosa). Se canceló sin tocar el original — sal de ahí primero y vuelve a adoptar.",
  adoptProjectRunning:
    "Ya hay un proyecto con la mismo workspace ejecutando Claude/Codex. Se canceló sin tocar el original — usa “Adoptar como sesión independiente” si quieres una adopción paralela.",
  btnAdoptAttach: "💻 Ver en la terminal del computador (opcional)",
  adoptAttachHint: (cmd: string) =>
    `✅ Para ver la sesión, ejecuta este comando opcional en una terminal del computador:\nComando: ${cmd}`,

  doneShort: "Listo",
  agentNotRunningRestart:
    "No está en ejecución — usa /resume para restaurarlo, o /start para iniciar uno nuevo",
  contentTruncated: "...(contenido demasiado largo, truncado)",
  agentEmptyOutput: "No devolvió nada · /peek para ver el panel",
  agentStarted: "✅ Iniciado",
  agentResumed: "🔄 Sesión anterior reanudada",
  agentResumeMissingState:
    "No hay estado de sesión anterior para reanudar — usa /start para crear una nueva.",
  agentAlreadyRunning: "✅ Ya está en ejecución",
  projectAutomationBusy: (taskKind, projectId, runId, supervisor) =>
    `Hay una automatización del proyecto en ejecución; los mensajes normales quedan bloqueados por ahora.\nTarea: ${taskKind}\nProyecto: ${projectId}\nRun: ${runId}\nSupervisor: ${supervisor}\n\nEspera a que termine, o revísala/cancélala antes de continuar.`,
  agentStartedWith: (label) => `✅ Iniciado con «${label}»`,
  startPickerTitle: "🚀 Elige cómo iniciar",
  startPickerPrompt: "Hay varios comandos de inicio configurados — elige uno:",
  btnStartThis: "🚀 Iniciar este",
  agentExited: "✅ Cerrado",
  agentRestarted: "🔄 Reiniciado",
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
  statusRunning: (agent) => `🟢 ${agent} en ejecución`,
  statusNotRunning: (agent) => `🔴 ${agent} detenido`,
  statusContext: (bar, pct) => `📊 Contexto ${bar} ${pct}%`,
  statusFiveHour: (bar, pct, reset) => `⏱ Sesión (5h) ${bar} ${pct}% (reinicia ${reset})`,
  statusSevenDay: (bar, pct, reset) => `📅 Semanal ${bar} ${pct}% (reinicia ${reset})`,
  statusUsageStale: (mins) =>
    `⚠️ Datos de uso con ${mins} min de antigüedad (el agente pudo detenerse)`,

  // -- status usage install --
  statusUsageHint: "💡 ¿Ver el uso? Envía /status_install para configurarlo",
  statusUsagePending:
    "📊 Datos de uso aún no disponibles — se mostrarán tras la próxima llamada a la API",
  statusUsageNoData:
    "📊 Sin datos de uso para esta sesión todavía · envía un mensaje para actualizar",
  statusModeApi: "API",
  statusModeSubscription: "suscripción",
  statusApiLine: (mode, host) => `🔌 ${mode} · ${host}`,
  statusInstallTitle: "📊 Instalación de reporte de uso",
  statusInstallNoClaude:
    "No se detect\u00f3 ning\u00fan Claude en ejecuci\u00f3n. La instalaci\u00f3n del informe de uso es solo para Claude; Codex ya informa el uso de forma nativa, no requiere instalaci\u00f3n.",
  statusInstallInstalled: (dir) => `✅ ${dir} reporte de uso instalado`,
  statusInstallAlready: (dir) => `⏭ ${dir} ya instalado`,
  statusInstallForeignPrompt: (dirs) =>
    `⚠️ Estos directorios ya tienen un statusLine propio — ¿qué hacer? Se recomienda «Envolver» (conserva tu statusLine y añade el reporte de uso).\n${dirs.join("\n")}`,
  statusInstallOverwritten: (dir, backup) => `🔁 ${dir} sobrescrito (respaldo: ${backup})`,
  statusInstallWrapped: (dir, backup) =>
    `📦 ${dir} envuelto: conserva tu visualización + uso\n   ⚠️ Tu statusLine ahora pasa por el envoltorio del bot; si la barra falla, restaura desde: ${backup}`,
  statusInstallSnippet: (dir, snippet) =>
    `✍️ ${dir}: añade esto a tu script de statusline (debe hacer input=$(cat)):\n${snippet}`,
  statusInstallSkipped: (dir) => `✖️ ${dir} omitido`,
  statusInstallError: (dir, msg) => `❌ ${dir}: ${msg}`,
  btnStatusInstall: "📊 Instalar uso",
  btnStatusOverwrite: "🔁 Sobrescribir",
  btnStatusWrap: "📦 Envolver (recom.)",
  btnStatusSnippet: "✍️ Dame el fragmento",
  btnStatusSkip: "✖️ Omitir",
  queueGlobalHeader: "━━ 🌐 Cola global ━━",
  queueCounts: (queued, processing) =>
    `En cola: ${queued} | Procesando: ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ Colas de sesión ━━",
  queueNoSessions: "No hay colas de sesión activas",
  queueLastDone: (s) => `último completado hace ${s}s`,
  queueItemCancelled: "mensaje en cola cancelado",
  queueItemRewritten: "mensaje en cola reescrito",
  queueItemGone: `ese mensaje ya no está en cola (si se está ejecutando, usa ${UI_ICONS.action.interrupt} interrumpir para detenerlo)`,
  queueTitle: "Estado de la cola",

  paneTitle: "👁 panel de sesión",
  emptyPane: "(vacío)",
  historyTitle: "📜 Historial",
  historyTitleShort: "Historial",
  noPathMapping: "Sin asignación de ruta · créala primero con /add_project",
  noHistory: "No se encontró historial de conversación",
  onlyNRounds: (n) => `Solo ${n} conversación(es)`,
  emptyOutput: "(sin salida)",

  noCurrentProjectShort: "Sin sesión actual",
  aliveListTitle: (n) => `Sesiones activas (${n})`,
  aliveListEmpty: "No hay sesiones activas — crea una con /add_project <ruta>",
  recentListTitle: "Proyectos recientes",
  recentListTitleN: (n) => `Proyectos recientes (${n})`,
  recentListEmpty: "No hay proyectos recientes — añade uno con /add_project <ruta>",

  notADir: (p) => `${p} no es un directorio`,
  dirNotExist: (p) => `Directorio no encontrado: ${p}`,
  pathNotAllowedPath: (p) => `Ruta no permitida: ${p}`,
  alreadySwitched: "Ya existe · cambiado",
  projectCreated: "Proyecto creado",
  projectCreatedPath: (p) => `Proyecto creado: ${p}`,
  projectPathCollision: (p) =>
    `⚠️ El nombre de sesión de este directorio choca con un proyecto existente (${p}). Renombra uno para usar ambos.`,
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
  noCurrentProjectSet: "No hay sesión actual definido\n\nDefine uno con /add_project <ruta>",
  currentProjectTitle: "Sesión actual",
  noRecentProjects: "No hay proyectos recientes\n\nAñade uno con /add_project <ruta>",
  messageTooLong: (len, max) => `Mensaje demasiado largo · ${len} > ${max} caracteres`,
  onlyTextVoice: "Solo se admiten mensajes de texto y de voz",
  handlerErrorTelegram: "⚠️ Error al procesar el mensaje; inténtalo de nuevo.",
  handlerError:
    "⚠️ Error al procesar el mensaje; inténtalo de nuevo. Si el grupo no responde, envía /restore para reconectar el proyecto.",
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
  notRunning: "No está en ejecución · /start para lanzarlo, o /restart para continuar",
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

Envía cualquier texto → se reenvía al agente → respuesta
🎙️ La transcripción de voz es opcional · /voice_install para habilitarla (solo Apple Silicon) · /voice_lang para fijar el idioma

Consejo: los mensajes reciben reacciones 👀 (recibido) / 👍 (hecho); el progreso se muestra en el sitio y se edita hasta el resultado; el resultado lleva debajo botones ⏎/${UI_ICONS.action.interrupt}/⎋/🔄.`,

  helpIntroLark: `🤖 tmux-claude (Lark)

Envía cualquier texto → se reenvía al agente → respuesta`,

  helpSectionProjects: "📂 Proyectos",
  helpSectionSession: "▶️ Sesión",
  helpSectionGroups: "👥 Grupos",
  helpSectionSettings: "⚙️ Ajustes",
  helpSectionDiagnostics: "🛠 Diagnóstico",
  helpSectionRunning: "⚡ En ejecución",
  helpSectionIdle: "🚀 Detenido",

  cmdCurrentProject: "sesión actual",
  cmdListAlive: "sesiones activas (toca para cambiar/eliminar)",
  cmdListRecent: "proyectos recientes",
  cmdAddProject: "crear un proyecto",
  cmdNewFree: "Nueva sesión independiente (paralela, mismo workspace)",
  freeProjectLimit: (max) =>
    `Límite de sesiones independientes alcanzado (${max}). Elimina uno primero.`,
  freeProjectCreated: (slot, label) =>
    `${UI_ICONS.session.independent} Sesión independiente #${slot}${label ? ` (${label})` : ""} creada.\nUsa /cd a cualquier ruta e inicia el agente tú mismo; /list_alive_projects para volver.`,
  btnNewFree: `${UI_ICONS.session.independent} Nueva sesión independiente`,
  freeLabelPrompt: "Envía un nombre para la sesión independiente (envía - para omitir)",
  freeLabelCancelled: "Cancelado",
  cmdAdopt: "adoptar un agente no gestionado",
  cmdQueueStatus: "estado de la cola",
  cmdHistory: "historial de conversación (el último por defecto)",
  cmdPeek: "ver el panel de sesión",
  cmdVoiceLang: "idioma de reconocimiento de voz (en/zh/yue/ja/es/auto)",
  cmdPromptTranslate: "traducción de prompts (status/off/on origen destino)",
  cmdTranslateInstall: "instalar dependencias de traducción de prompts",
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
  cmdStart: "iniciar el agente",
  cmdResume: "reanudar la sesión anterior del agente",
  cmdDoctor: "ejecutar comprobaciones de instalación",
  cmdRecover: "Recuperar proyectos tras reinicio",
  cmdStatusInstall: "Instalar informe de uso para /status",
  cmdVoiceInstall: "Instalar transcripción de voz (Apple Silicon)",
  cmdHelp: "esta ayuda",
  cmdWs: "gestión de espacios de trabajo (save/use/list/remove)",

  // ── workspaces ──
  wsSaved: (name, session) => `✅ Espacio de trabajo «${name}» guardado → ${session}`,
  wsUsed: (name) => `✅ Cambiado al espacio de trabajo «${name}»`,
  wsRemoved: (name) => `✅ Espacio de trabajo «${name}» eliminado`,
  wsNotFound: (name) => `Espacio de trabajo «${name}» no encontrado`,
  wsSessionGone: (name) => `La sesión del espacio de trabajo «${name}» ya no existe`,
  wsNoCurrentProject: "Sin sesión actual — usa /add_project primero",
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

  // ── logs ──
  cmdLogs: "Ver registros recientes de advertencia/error (/logs <traceId|N>)",
  logsTitle: "🪵 Registros recientes",

  // ── prompt library ──
  cmdPrompts: "Explorar prompts guardados",
  promptsDisabled: "Biblioteca de prompts no habilitada (configura PROMPT_MCP_COMMAND en .env)",
  promptsEmpty: "Sin prompts coincidentes",
  promptsError: "Error de conexión con la biblioteca de prompts — inténtalo más tarde",
  promptsGone: "Ese prompt ya no existe — busca de nuevo",
  promptsTitle: (n) => `🔖 Biblioteca de prompts (${n})`,
  promptsOpen: "Ver/Copiar",
  promptsSearchTitle: (q, n) => `🔖 "${q}" — ${n} resultado${n === 1 ? "" : "s"}`,
  promptsRefine: (shown, total) =>
    `${total} en total — mostrando los primeros ${shown}. Usa /prompts <término> para filtrar`,
  promptsAll: "✖ Todos",
  promptsPrev: "◀ Anterior",
  promptsNext: "Siguiente ▶",

  // ── dashboard ──
  cmdHome:
    "Cambiar a la sesión del operador principal (destino predeterminado sin proyecto seleccionado)",
  homeOperatorDisabled: "La sesión del operador principal no está habilitada",
  homeOperatorSwitched: "🏠 Cambiado a la sesión del operador principal",
  cmdDashboard: "Ver el panel global (resumen de todas las sesiones)",
  cmdBatch:
    "Planificador de lotes: ver estado o controlar ejecución (start/pause/resume/stop/report)",
  cmdAutopilot: "Delegar el trabajo de la sesión actual al Loop Supervisor",
  cmdOpportunity: "Revisar oportunidades propuestas y delegar el trabajo aprobado",
  cmdGoals: "Listar presets de objetivos de autopilot",
  cmdSysload: "Ver carga, temperatura y procesos descontrolados",
  sysloadTitle: "🖥 Carga del sistema",
  dashboardTitle: "📊 Panel",
  autopilotTitle: `${UI_ICONS.feature.autopilot} Autopilot`,
  autopilotDelegatePanelBody:
    "Delega el contexto de la sesión actual al Loop Supervisor para implementar, revisar, verificar, gestionar PRs y notificar el resultado final.",
  autopilotNotifyPaused: (session, reason) => `🛑 autopilot en pausa [${session}]: ${reason}`,
  autopilotNotifyStopped: (session, reason) => `⏹️ autopilot detenido [${session}]: ${reason}`,
  autopilotNotifyUsage: (session, pct) =>
    `🛑 objetivo de autopilot en pausa [${session}]: el uso alcanzó el umbral del ${pct}%`,
  autopilotNotifyMaxIter: (session) =>
    `⏹️ objetivo de autopilot detenido [${session}]: máximo de iteraciones alcanzado`,
  autopilotNotifyWallClock: (session) =>
    `⏹️ objetivo de autopilot detenido [${session}]: presupuesto de tiempo agotado`,
  autopilotNotifyAwaitHuman: (session) =>
    `🎯 autopilot [${session}]: la fase parece completa — confirma con /autopilot confirm o continúa con /autopilot reject`,
  autopilotNotifyGoalComplete: (session, goalId) =>
    `✅ objetivo de autopilot completado [${session}]: ${goalId} (confirma por favor)`,
  autopilotNotifyCycleComplete: (session, rounds) =>
    `✅ ciclo de autopilot completado [${session}]: ${rounds} ronda(s) (confirma)`,
  autopilotNotifyKeepaliveDone: (session) =>
    `✅ tarea keep-alive de autopilot completada [${session}]: marcador de fin detectado`,
  autopilotNotifyGoalAdvance: (session, goalId, pos, total, round, rounds) =>
    `➡️ autopilot [${session}]: objetivo ${goalId} (${pos}/${total} · ronda ${round}/${rounds})`,
  batchRunStarted: (planId, tasks) =>
    `🚀 Ejecución de lote iniciada: plan ${planId}, ${tasks} tarea(s)`,
  batchPoolPaused: (agent, resumeAt) =>
    `⏸ Pool de lote pausado [${agent}]: cuota alcanzada, reanudación en ${resumeAt}`,
  batchRunComplete: (summary) => `✅ Ejecución de lote completada\n${summary}`,
  autopilotGlobal: (on) =>
    on
      ? "Mantener activo global ACTIVADO: todas las sesiones activas se gestionan (usa /autopilot off para excluir una)"
      : "Mantener activo global DESACTIVADO",
  autopilotStatus: (o) =>
    `Autopilot: ${o.enabled ? "activado" : "desactivado"} (${o.pureKeepAlive ? "mantener activo" : "por objetivo"}, ${o.iterations} intervenciones, persona=${o.persona})${o.goal ? ` (objetivo ${o.goal.id}#${o.goal.phaseIndex})` : ""}`,
  autopilotUsage: (raw) =>
    `Subcomando desconocido «${raw}». Uso: /autopilot [delegate [requisito]|on|off|keepalive on|off|stop|goals <ids> [rounds N]|goal <id>|confirm|reject|global on|off]`,
  btnApEnable: `${UI_ICONS.feature.autopilot} Activar keep-alive/objetivos`,
  btnApDisable: "⏹ Desactivar keep-alive/objetivos",
  btnApDelegate: "🚀 Continuar con supervisor",
  btnApCancelDelegate: "⛔ Cancelar delegación",
  btnApPickGoals: "🎯 Elegir objetivos",
  btnApGlobalOn: "🌐 Global: sí",
  btnApGlobalOff: "🌐 Global: no",
  btnApStop: "⏹ Detener objetivo",
  btnApConfirm: "✅ Confirmar",
  btnApContinue: "▶️ Continuar",
  btnApBack: "↩︎ Volver",
  btnApRoundsMinus: "➖",
  btnApRoundsPlus: "➕",
  btnApStartCycle: (n: number, rounds: number) =>
    `▶️ Iniciar (${n} objetivo(s) · ${rounds} ronda(s))`,
  apRoundsLabel: (rounds: number) => `Rondas: ${rounds}`,
  goalTestCoverage: "Aumentar cobertura de pruebas",
  goalFixTests: "Reparar pruebas",
  goalCodeReview: "Revisión de código",
  goalAddFeature: "Añadir función",
  goalRefactorElegant: "Refactorizar con elegancia",
  goalUiPolish: "Pulir interfaz",
  goalImproveArchitecture: "Mejorar la arquitectura",
  goalHardenStandards: "Reforzar estándares y controles",
  goalPolishGithub: "Pulir la presencia en GitHub",
  goalSyncDocs: "Alinear la documentación con el código",
  autopilotGoalStarted: (id) => `Objetivo iniciado: ${id}`,
  autopilotUnknownGoal: (ids) => `Objetivo desconocido. Disponibles: ${ids}`,
  goalsTitle: "🎯 Objetivos predefinidos",
  noLogsContext:
    "No hay sesión actual. Selecciona un proyecto o especifica un trace (/logs <traceId>).",

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
  groupNoNewGroupProjects:
    "No hay proyectos regulares disponibles para crear un grupo nuevo (se ocultan los ya vinculados y las sesiones independientes).",
  groupNoBindableProjects:
    "No hay proyectos regulares disponibles para vincular. Añade uno en un chat privado con `/add_project <ruta>`.",
  groupNoParallelProjects:
    "No hay proyectos regulares disponibles para crear un grupo paralelo. Añade uno primero.",
  groupCreatedShort: (label) =>
    `✓ Grupo de proyecto «${label}» creado — continúa en el grupo nuevo.`,
  groupAlreadyExists: (label) =>
    `⚠️ El proyecto «${label}» ya tiene un grupo vinculado — usa ese; no hace falta crear otro.`,
  groupPinnedNoSwitch: (label) =>
    `🔒 Este grupo está fijado a «${label}» — cambiar de proyecto está deshabilitado aquí. Usa 🗂 → Revincular para cambiarlo.`,
  groupNoRemoveInGroup:
    "🔒 Eliminar proyectos no se permite en un grupo (afecta a otros). Hazlo en un chat privado con el bot.",
  groupFreePickerTitle: `${UI_ICONS.session.independent} Nuevo grupo paralelo de proyecto (crea una sesión independiente)`,
  groupOverviewTitle: "🗂 Grupos de proyecto",
  groupOverviewExisting: "Grupos de proyecto existentes:",
  groupOverviewNoGroups: "Aún no hay grupos de proyecto.",
  groupOverviewItem: (label, path) => `• **${label}** — \`${path}\``,
  btnFreeGroup: `${UI_ICONS.session.independent} Nuevo grupo paralelo`,
  freeGroupCreated: (label) => `${UI_ICONS.session.independent} Grupo paralelo "${label}" creado`,
};
