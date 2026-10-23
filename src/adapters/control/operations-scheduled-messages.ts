import { z } from "zod";
import type { HandlerDeps } from "../../core/deps.js";
import { isOperator } from "../../core/projects/operator.js";
import { getScheduledMessageService } from "../../core/scheduled-messages/service.js";
import { tildeifyHomeDeep } from "../../shared/utils/path.js";
import type { ControlOperationHandlers } from "./operations-types.js";

const nonempty = z.string().min(1).max(16_384);
const requestSchema = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("create"),
    session: nonempty,
    when: nonempty,
    text: z.string().min(1).max(100_000),
    requestId: nonempty,
  }),
  z.object({ command: z.literal("list") }),
  z.object({ command: z.enum(["show", "cancel"]), scheduleId: nonempty }),
]);

export function createControlScheduledMessageHandlers(
  deps: HandlerDeps,
): Pick<ControlOperationHandlers, "schedule"> {
  return {
    schedule: async (req, { ok, fail }) => {
      const input = requestSchema.parse(req);
      if (
        input.command === "create" &&
        isOperator(input.session, deps.config.projectSessionPrefix)
      ) {
        fail("cannot send to the operator session");
        return;
      }
      const service = getScheduledMessageService(deps);
      if (input.command === "create") {
        ok(
          tildeifyHomeDeep(
            await service.create({
              owner: { channel: "control", chatId: "local", userId: "local" },
              sessionName: input.session,
              when: input.when,
              text: input.text,
              requestId: input.requestId,
            }),
          ),
        );
      } else if (input.command === "list") {
        ok(tildeifyHomeDeep(service.list()));
      } else {
        const record =
          input.command === "show"
            ? service.get(input.scheduleId)
            : service.cancel(input.scheduleId);
        if (record === undefined) fail("scheduled message not found");
        else ok(tildeifyHomeDeep(record));
      }
    },
  };
}
