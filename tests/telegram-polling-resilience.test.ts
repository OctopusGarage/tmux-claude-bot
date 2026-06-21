import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";
import { isFatalPollingError } from "../src/adapters/telegram/start.js";

function grammyError(error_code: number, description = "x"): GrammyError {
  return new GrammyError("msg", { ok: false, error_code, description }, "getUpdates", {});
}

describe("isFatalPollingError", () => {
  it("treats 401 (bad/revoked token) as fatal", () => {
    expect(isFatalPollingError(grammyError(401, "Unauthorized"))).toBe(true);
  });

  it("treats 404 (wrong token / bot deleted) as fatal", () => {
    expect(isFatalPollingError(grammyError(404, "Not Found"))).toBe(true);
  });

  it("treats a 409 Conflict as transient (a lingering long-poll clears itself)", () => {
    expect(isFatalPollingError(grammyError(409, "Conflict: terminated by other getUpdates"))).toBe(
      false,
    );
  });

  it("treats 5xx server errors as transient", () => {
    expect(isFatalPollingError(grammyError(502, "Bad Gateway"))).toBe(false);
  });

  it("treats a network HttpError (socket hang up) as transient", () => {
    expect(isFatalPollingError(new HttpError("socket hang up", new Error("socket hang up")))).toBe(
      false,
    );
  });

  it("treats a plain Error as transient (not a GrammyError)", () => {
    expect(isFatalPollingError(new Error("boom"))).toBe(false);
  });
});
