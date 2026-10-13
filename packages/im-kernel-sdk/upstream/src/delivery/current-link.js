// A current link only fences the original IO. It grants no source, membership
// or delivery authority and never exposes the socket or its credential.
export default function CurrentLink(current) {
  const links = new WeakMap();
  const capture = () => {
    const owner = current();
    if (!owner) return;
    const handle = Object.freeze({});
    links.set(handle, { socket: owner.socket, value: Object.freeze({ version: 1,
      generation: owner.generation, receiverID: owner.receiverID }) });
    return handle;
  };
  const read = handle => {
    const captured = links.get(handle);
    const owner = current();
    if (!captured || !owner || owner.socket !== captured.socket ||
        owner.generation !== captured.value.generation || owner.receiverID !== captured.value.receiverID) return;
    return captured.value;
  };
  return { capture, read };
}
