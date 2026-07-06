export type OptionalFeatureInstallResult =
  | { status: "already-ready" }
  | { status: "unsupported" }
  | { status: "in-progress" }
  | { status: "ok" }
  | { status: "failed"; message: string };

export type OptionalFeatureInstallCopy = {
  installing: string;
  ok: string;
  alreadyReady: string;
  inProgress: string;
  failed(message: string): string;
  unsupported?: string | undefined;
};

export type OptionalFeatureInstallNotice = {
  tone: "info" | "err";
  text: string;
};

export function renderOptionalFeatureInstallResult(
  result: OptionalFeatureInstallResult,
  copy: OptionalFeatureInstallCopy,
): OptionalFeatureInstallNotice {
  switch (result.status) {
    case "ok":
      return { tone: "info", text: copy.ok };
    case "failed":
      return { tone: "err", text: copy.failed(result.message) };
    case "already-ready":
      return { tone: "info", text: copy.alreadyReady };
    case "unsupported":
      return { tone: "err", text: copy.unsupported ?? "unsupported" };
    case "in-progress":
      return { tone: "info", text: copy.inProgress };
  }
}

export async function runOptionalFeatureInstall<T extends OptionalFeatureInstallResult>(req: {
  copy: OptionalFeatureInstallCopy;
  precheck?: (() => T | null) | undefined;
  install: () => Promise<T>;
  send: (notice: OptionalFeatureInstallNotice) => Promise<void>;
  onResult?: ((result: T) => void) | undefined;
  background?: boolean | undefined;
}): Promise<T> {
  const precheck = req.precheck?.();
  if (precheck) {
    await req.send(renderOptionalFeatureInstallResult(precheck, req.copy));
    req.onResult?.(precheck);
    return precheck;
  }

  await req.send({ tone: "info", text: req.copy.installing });
  if (req.background) {
    void (async () => {
      const result = await req.install();
      req.onResult?.(result);
      await req.send(renderOptionalFeatureInstallResult(result, req.copy));
    })().catch(async (err) => {
      await req.send({
        tone: "err",
        text: req.copy.failed(err instanceof Error ? err.message : String(err)),
      });
    });
    return { status: "in-progress" } as T;
  }
  const result = await req.install();
  req.onResult?.(result);
  await req.send(renderOptionalFeatureInstallResult(result, req.copy));
  return result;
}
