import { describe, expect, it } from "vitest";
import {
  createLineDecoder,
  encodeLine,
  type ServerMessage,
} from "../../../src/adapters/control/protocol.js";

describe("control protocol", () => {
  it("encodeLine round-trips through the decoder", () => {
    const decode = createLineDecoder<ServerMessage>();
    const msg: ServerMessage = { event: "reply", session: "s1", output: "done" };
    expect(decode(encodeLine(msg))).toEqual([msg]);
  });

  it("reassembles a message split across chunks", () => {
    const decode = createLineDecoder<{ id: number }>();
    expect(decode('{"id":')).toEqual([]); // partial line buffered
    expect(decode("7}\n")).toEqual([{ id: 7 }]);
  });

  it("yields multiple complete messages from one chunk, buffering the partial tail", () => {
    const decode = createLineDecoder<{ n: number }>();
    const out = decode('{"n":1}\n{"n":2}\n{"n":3');
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decode("}\n")).toEqual([{ n: 3 }]);
  });

  it("skips a malformed line without wedging the stream", () => {
    const decode = createLineDecoder<{ ok: boolean }>();
    const out = decode('not json\n{"ok":true}\n');
    expect(out).toEqual([{ ok: true }]);
  });

  it("skips blank and whitespace-only lines", () => {
    const decode = createLineDecoder<{ id: number }>();
    expect(decode('\n  \n{"id":1}\n\n')).toEqual([{ id: 1 }]);
  });
});
