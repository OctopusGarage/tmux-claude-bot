import type { ControlCallerProvenance, ControlRequest, ServerMessage } from "./protocol.js";

export type ControlOperationContext = {
  send: (msg: ServerMessage) => void;
  ok: (data: unknown) => void;
  fail: (error: string) => void;
  caller?: ControlCallerProvenance;
  isOperatorHomeCaller: boolean;
};

export type ControlOperationHandler<Request extends ControlRequest = ControlRequest> = (
  req: Request,
  ctx: ControlOperationContext,
) => Promise<void>;

export type ControlOperationHandlers = {
  [Op in ControlRequest["op"]]: ControlOperationHandler<Extract<ControlRequest, { op: Op }>>;
};
