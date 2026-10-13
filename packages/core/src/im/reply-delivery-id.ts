export * as ReplyDeliveryID from "./reply-delivery-id"

import { contentDigest } from "../contract/digest"

/** The durable outbox ID owns the transport ID; message metadata cannot supply it. */
export const fromOutbox = (outboxID: string) => `imsg_reply_${contentDigest(outboxID).slice(0, 40)}`
