import { messages } from "../../core/i18n/index.js";

/**
 * Telegram's shared user-facing strings. Thin façade over the i18n catalog so
 * every existing `MSG.x` call site stays unchanged while the text now follows
 * the channel's UI language (resolved live on each access).
 */
const m = () => messages("telegram");

export const MSG = {
  get noSession() {
    return m().noSession;
  },
  get notRunning() {
    return m().notRunning;
  },
  noShortId: (id: string) => m().noShortId(id),
  pathNotAllowed: (dirs: string[]) => m().pathNotAllowed(dirs),
  queueFull: (max: number) => m().queueFull(max),
  get voiceNotInstalled() {
    return m().voiceNotEnabled;
  },
  get voiceUnsupported() {
    return m().voiceNeedsAppleSilicon;
  },
  get voiceAlreadyInstalled() {
    return m().voiceAlreadyInstalled;
  },
  get voiceInstalling() {
    return m().voiceInstalling;
  },
  get voiceInstallOk() {
    return m().voiceInstallOk;
  },
  voiceInstallFailed: (e: string) => m().voiceInstallFailed(e),
  voiceLangCurrent: (lang: string) => m().voiceLangCurrent(lang),
  voiceLangSet: (lang: string) => m().voiceLangSet(lang),
  get voiceLangInvalid() {
    return m().voiceLangInvalid;
  },
};
