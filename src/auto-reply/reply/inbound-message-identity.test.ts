import { describe, expect, it } from "vitest";
import { withCurrentInboundMessageIdentity } from "./inbound-message-identity.js";

describe("withCurrentInboundMessageIdentity", () => {
  it("refreshes the pinned snapshot identity from the current turn", () => {
    const sessionCtx = {
      MessageSid: "msg-first",
      MessageSidFull: "msg-first-full",
      Timestamp: 1000,
      SenderId: "sender-a",
    };
    const refreshed = withCurrentInboundMessageIdentity(sessionCtx, {
      MessageSid: "msg-second",
      MessageSidFull: "msg-second-full",
      Timestamp: 2000,
    });
    expect(refreshed.MessageSid).toBe("msg-second");
    expect(refreshed.MessageSidFull).toBe("msg-second-full");
    expect(refreshed.Timestamp).toBe(2000);
    expect(refreshed.SenderId).toBe("sender-a");
    // Inputs stay untouched; the helper is pure.
    expect(sessionCtx.MessageSid).toBe("msg-first");
    expect(sessionCtx.Timestamp).toBe(1000);
  });

  it("refreshes when only the full message id is present", () => {
    const refreshed = withCurrentInboundMessageIdentity(
      { MessageSid: "msg-first", MessageSidFull: "msg-first-full", Timestamp: 1000 },
      { MessageSidFull: "msg-second-full", Timestamp: 2000 },
    );
    expect(refreshed.MessageSid).toBeUndefined();
    expect(refreshed.MessageSidFull).toBe("msg-second-full");
    expect(refreshed.Timestamp).toBe(2000);
  });

  it("keeps the snapshot untouched for turns without an inbound message id", () => {
    const sessionCtx = {
      MessageSid: "msg-first",
      MessageSidFull: "msg-first-full",
      Timestamp: 1000,
    };
    const refreshed = withCurrentInboundMessageIdentity(sessionCtx, { Timestamp: 2000 });
    expect(refreshed).toEqual(sessionCtx);
    expect(refreshed).not.toBe(sessionCtx);
  });
});
