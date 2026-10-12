import Proto from "../proto";

export default  function({ data }){
  let { msgIndex, ackIndex } = data;

  let codec = Proto.lookup('codec.PublishAckMsgBody');
  let message = codec.create({ index: ackIndex, msgIndex, code: 0 });
  let buffer = codec.encode(message).finish();
  return { buffer };
}