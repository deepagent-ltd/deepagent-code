import Emitter from "../../common/emmit";
import utils from "../../utils";
import Proto from "../proto";
import { wireInteger, safeInteger } from "../../delivery/codec";
import { SIGNAL_NAME, SIGNAL_CMD, CONNECT_STATE, COMMAND_TOPICS, MESSAGE_TYPE, ErrorType, CONNECT_ACK_INDEX, PONG_INDEX, UPLOAD_TYPE, CONVERATION_TYPE, MESSAGE_SENT_STATE, UNDISTURB_TYPE, STORAGE } from "../../enum";
import common from "../../common/common";
import tools from "./tools";

import getQueryAckBody from "./query_ack";
import getPublishMsgBody from "./publish_msg";

export default function Decoder(cache, io) {
  let imsocket = Proto.lookup('codec.ImWebsocketMsg');
  let decode = async (buffer) => {
    let msg = imsocket.decode(new Uint8Array(buffer));
    let result = {}, name = '';
    let { cmd, payload } = msg;

    let xors = cache.get(STORAGE.CRYPTO_RANDOM);
    let stream = common.decrypto(payload, xors);
    let codec = null;
    let currentUser = io.getCurrentUser();
    switch (cmd) {
      case SIGNAL_CMD.CONNECT_ACK:
        codec = Proto.lookup('codec.ConnectAckMsgBody');
        let connectAckMsg = codec.decode(stream);
        result = utils.extend(result, { ack: connectAckMsg, index: CONNECT_ACK_INDEX, extra: connectAckMsg.ext });
        name = SIGNAL_NAME.S_CONNECT_ACK;
        break;
      case SIGNAL_CMD.PUBLISH_ACK:
        codec = Proto.lookup('codec.PublishAckMsgBody');
        let pubAckMsgBody = codec.decode(stream);
        let { index, msgId: messageId, timestamp: sentTime, code, msgIndex, memberCount, modifiedMsg } = pubAckMsgBody;

        if(modifiedMsg){
          let { msgContent, msgType } = modifiedMsg;
          if (msgContent && msgContent.length > 0) {
            let content = new TextDecoder().decode(msgContent);
            modifiedMsg = { msgContent: utils.parse(content), msgType };
          }
        }

        result = { messageId, sentTime, index, isSender: true, code, msgIndex, memberCount, modifiedMsg,
          deliveryVersion: pubAckMsgBody.deliveryVersion, deliveryExpiresAt: safeInteger(stream, 10),
          deliveryRequestHash: pubAckMsgBody.deliveryRequestHash, deliverySequence: wireInteger(stream, 5) };
        if (pubAckMsgBody.deliveryVersion === 1) result.sentTime = safeInteger(stream, 4);
        break;
      case SIGNAL_CMD.PUBLISH:
        currentUser = io.getCurrentUser();
        let { _msg, _name } = await getPublishMsgBody(stream, { currentUser, io });
        name = _name;
        result = _msg;
        break;
      case SIGNAL_CMD.QUERY_ACK:
        currentUser = io.getCurrentUser();
        result = await getQueryAckBody(stream, { cache, currentUser, io });
        name = SIGNAL_NAME.S_QUERY_ACK;
        break;
      case SIGNAL_CMD.PONG:
        result = { index: PONG_INDEX }
        name = SIGNAL_NAME.S_PONG;
        break;
      case SIGNAL_CMD.DISCONNECT:
        codec = Proto.lookup('codec.DisconnectMsgBody');
        let disconnectMsgBody = codec.decode(stream);
        result = utils.extend(result, { extra: disconnectMsgBody.ext, code: disconnectMsgBody.code });
        break;
    }
    return {
      cmd, result, name
    };
  };
  return {
    decode
  };
}