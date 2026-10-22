import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("test harness isolation", () => {
  it("never inherits production state or log destinations", () => {
    expect(process.env.TCB_STATE_DIR).toContain(tmpdir());
    expect(process.env.TCB_LOG_DIR).toBeUndefined();
    expect(process.env.TCB_ENV_FILE).toBeUndefined();
  });
});
