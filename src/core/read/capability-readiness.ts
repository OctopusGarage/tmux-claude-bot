export type PathProbes = {
  pathExists(path: string): boolean;
  pathExecutable?: ((path: string) => boolean) | undefined;
};

export type PromptTranslationReadiness =
  | { status: "ready"; python: string }
  | { status: "missing" | "not-executable"; python: string };

export type VoiceTranscriptionReadiness =
  | { status: "ready"; bin: string }
  | { status: "missing" | "not-executable" | "unsupported-platform"; bin: string };

export function preferredManagedPath(
  explicit: string | undefined,
  fallback: string,
  pathExists: (path: string) => boolean,
): string {
  const trimmed = explicit?.trim();
  if (trimmed && pathExists(trimmed)) return trimmed;
  return fallback;
}

export function promptTranslationReadiness(req: {
  env: Record<string, string | undefined>;
  fallbackPython: string;
  probes: PathProbes;
}): PromptTranslationReadiness {
  const python = preferredManagedPath(
    req.env.ARGOS_TRANSLATE_PYTHON,
    req.fallbackPython,
    req.probes.pathExists,
  );
  const status = pathReadiness(python, req.probes);
  return status === "ready" ? { status: "ready", python } : { status, python };
}

export function voiceTranscriptionReadiness(req: {
  env: Record<string, string | undefined>;
  fallbackBin: string;
  platformSupported: boolean;
  probes: PathProbes;
}): VoiceTranscriptionReadiness {
  const bin = preferredManagedPath(req.env.MLX_WHISPER_BIN, req.fallbackBin, req.probes.pathExists);
  const status = pathReadiness(bin, req.probes);
  if (status === "ready") return { status: "ready", bin };
  if (!req.platformSupported) return { status: "unsupported-platform", bin };
  return { status, bin };
}

function pathReadiness(path: string, probes: PathProbes): "ready" | "missing" | "not-executable" {
  if (!probes.pathExists(path)) return "missing";
  if (probes.pathExecutable && !probes.pathExecutable(path)) return "not-executable";
  return "ready";
}
