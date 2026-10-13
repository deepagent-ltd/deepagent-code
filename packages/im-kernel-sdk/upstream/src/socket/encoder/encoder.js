import utils from "../../utils";
import Proto from "../proto";
import { SIGNAL_CMD, QOS, CONVERATION_TYPE, COMMAND_TOPICS, PLATFORM, STORAGE } from "../../enum";
import common from "../../common/common";

import getConnectBody from "./connect";
import getPublishBody from "./publish";
import getPublishAckBody from "./publish_ack";
import getQueryBody from "./query";
import getPingBody from "./ping";

export default function Encoder(cache, io){
  let imsocket = Proto.lookup('codec.ImWebsocketMsg');
  let encode = async (cmd, data) => {
    let body = {}, memory = {};
    let payload = {
      version: 1, 
      cmd: cmd,
      qos: QOS.YES
    };
    let { counter, callback, index } = data;
    switch(cmd){
      case SIGNAL_CMD.CONNECT:
        body = getConnectBody(data);
        memory = { counter };
        break;
      case SIGNAL_CMD.PUBLISH:
        body = await getPublishBody(data, io);
        memory = { callback, data: data.data, counter };
        break;
      case SIGNAL_CMD.PUBLISH_ACK:
        body = getPublishAckBody(data);
        memory = { callback, data: data.data, counter };
        break;
      case SIGNAL_CMD.QUERY:
        body = await getQueryBody(data, io);
        let { targetId, userId, topic } = data.data;
        memory = { callback, index, topic, targetId, counter }
        break;
      case SIGNAL_CMD.PING:
        body = getPingBody(data);
        memory = { counter };
        break;
    }

    cache.set(index, memory);

    if(body.buffer){
      let xors = cache.get(STORAGE.CRYPTO_RANDOM);
      let _buffer = common.encrypto(body.buffer, xors);
      utils.extend(payload, { payload: _buffer });
    }
    
    let message = imsocket.create(payload);
    let buffer = imsocket.encode(message).finish();
    return buffer;
  };
  
  return { 
    encode
  };
}