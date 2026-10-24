import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext, TemplateContext } from "../templating.js";

/**
 * The session ctx snapshot keeps the identity (message id + timestamp) of the inbound
 * message that last populated it. On later turns that stale identity leaks into the
 * rendered inbound context block, and models routinely misread the repeated
 * message_id/timestamp pair as a re-delivery of an earlier user message, answering
 * follow-up turns as if the original request had just been sent again. Refresh the
 * per-message identity fields from the current turn's ctx when it carries one; turns
 * without an inbound message id (synthetic/internal wakes) keep the snapshot as-is.
 */
export function withCurrentInboundMessageIdentity<T extends TemplateContext>(
  sessionCtx: T,
  ctx: MsgContext,
): T {
  return {
    ...sessionCtx,
    ...((normalizeOptionalString(ctx.MessageSid) ?? normalizeOptionalString(ctx.MessageSidFull))
      ? { MessageSid: ctx.MessageSid, MessageSidFull: ctx.MessageSidFull, Timestamp: ctx.Timestamp }
      : {}),
  };
}
