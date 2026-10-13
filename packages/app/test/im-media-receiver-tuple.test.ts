import { expect, test } from "bun:test"
import { IMMediaReceiverTuple } from "./fixture/im-media-receiver-tuple"
import { IMMediaProductDescriptor } from "./fixture/im-media-product-descriptor"

const descriptor = process.env.DAC_IM_MEDIA_DRY_DESCRIPTOR
const tupleFile = process.env.DAC_IM_MEDIA_DRY_TUPLE

test.skipIf(!descriptor || !tupleFile)("receiver identity observer requires exact current origin/directory/message/ordered attachment DTO and refuses stale reader", async () => {
  const input = IMMediaProductDescriptor.decode(await Bun.file(descriptor!).json())
  const raw: unknown = await Bun.file(tupleFile!).json()
  const tuple = IMMediaReceiverTuple.decode(raw, input)
  const page = {
    reader: { displayEpoch: input.state.B.reader.displayEpoch, validatedServerNow: 1, nextExpiryAt: null },
    messages: [{ id: tuple.receiver.messageID, groupID: tuple.receiver.groupID, type: "text",
      remoteAttachments: [...tuple.receiver.attachments] }],
  }
  expect(IMMediaReceiverTuple.observe(page, tuple, input.state.B.reader.displayEpoch)?.id).toBe(tuple.receiver.messageID)
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!, type: "file" }] },
    tuple, input.state.B.reader.displayEpoch)).toThrow("message_identity")
  expect(() => IMMediaReceiverTuple.observe({ data: page }, tuple, input.state.B.reader.displayEpoch)).toThrow("invalid_page")
  expect(() => IMMediaReceiverTuple.observe({ ...page, reader: { ...page.reader, displayEpoch: "different" } },
    tuple, input.state.B.reader.displayEpoch)).toThrow("reader_unavailable")
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!, remoteAttachments: [] }] },
    tuple, input.state.B.reader.displayEpoch)).toThrow("attachment_tuple")
  expect(IMMediaReceiverTuple.observe({ ...page, messages: [] }, tuple, input.state.B.reader.displayEpoch)).toBeUndefined()
  expect(() => IMMediaReceiverTuple.decode({ ...tuple, receiver: { ...tuple.receiver, origin: tuple.sender.origin } }, input)).toThrow()
  expect(() => IMMediaReceiverTuple.decode({ ...tuple, receiver: { ...tuple.receiver, directory: input.peers.A.directory + "/wrong" } }, input)).toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, reader: { ...page.reader, displayEpoch: "wrong" } },
    tuple, input.state.B.reader.displayEpoch)).toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, protectedUnavailable: true }, tuple, input.state.B.reader.displayEpoch)).toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, reader: { ...page.reader, nextExpiryAt: 1 } },
    tuple, input.state.B.reader.displayEpoch)).toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!,
    id: "other-message", remoteAttachments: [...tuple.receiver.attachments] }] },
    tuple, input.state.B.reader.displayEpoch)).not.toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!,
    remoteAttachments: [...tuple.receiver.attachments].reverse() }] }, tuple, input.state.B.reader.displayEpoch)).toThrow()
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!,
    remoteAttachments: tuple.receiver.attachments.map((item, index) => index ? item : { ...item, contentRef: "different" }) }] },
    tuple, input.state.B.reader.displayEpoch)).toThrow()
  const detected = IMMediaReceiverTuple.decode({ ...tuple, receiver: { ...tuple.receiver,
    attachments: tuple.receiver.attachments.map((item, index) => index ? item : { ...item, mime: "text/plain; charset=utf-8" }) } },
    { ...input, files: input.files.map((item, index) => index ? item : { ...item, mime: "application/octet-stream" }) })
  expect(detected.receiver.attachments[0]?.mime).toBe("text/plain; charset=utf-8")
  expect(IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!, remoteAttachments: detected.receiver.attachments }] },
    detected, input.state.B.reader.displayEpoch)?.id).toBe(detected.receiver.messageID)
  expect(() => IMMediaReceiverTuple.observe({ ...page, messages: [{ ...page.messages[0]!,
    remoteAttachments: detected.receiver.attachments.map((item, index) => index ? item : { ...item, mime: "application/octet-stream" }) }] },
    detected, input.state.B.reader.displayEpoch)).toThrow()
})
