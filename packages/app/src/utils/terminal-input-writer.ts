export function terminalInputWriter(send: (data: string) => void, connected: () => boolean, buffer = false) {
  let chunks: string[] | undefined

  const flush = () => {
    if (!connected() || !chunks?.length) return
    send(chunks.join(""))
    chunks = undefined
  }

  const push = (data: string) => {
    if (!data) return
    if (!connected()) {
      if (!buffer) return
      if (chunks) chunks.push(data)
      else chunks = [data]
      return
    }

    flush()
    send(data)
  }

  return { push, flush }
}
