import { ShareStore } from "../src/store"

const [directory, sessionID, secret, startText, countText] = process.argv.slice(2)
if (!directory || !sessionID || !secret || !startText || !countText) throw new Error("Missing writer arguments")

const start = Number(startText)
const count = Number(countText)
const store = new ShareStore(directory)

await Promise.all(
  Array.from({ length: count }, (_, offset) =>
    store.publish(sessionID.slice(-8), secret, `session/message/${sessionID}/${start + offset}`, {
      index: start + offset,
    }),
  ),
)
