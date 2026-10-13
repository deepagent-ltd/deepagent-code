import utils from "../../utils";
import Storage from "../../common/storage";
import Consumer from "../../common/consumer";
import common from "../../common/common";
import chatroomCacher from "../../common/chatroom-cacher";

import { SIGNAL_CMD, COMMAND_TOPICS, STORAGE, NOTIFY_TYPE, SIGNAL_NAME, ErrorType, LOG_MODULE } from "../../enum";
export default function ChatroomAttSyncer(send, emitter, io, { logger }) {

  let consumer = Consumer();
  let exec = (data) => {
    consumer.produce(data);
    consumer.consume(({ item }, next) => {
      let { name } = item;
      if (utils.isEqual(name, SIGNAL_NAME.S_NTF)) {
        query(item, next);
      }
    });

    function query(item, next) {
      logger.info({ tag: LOG_MODULE.MSG_SYNC, ...item });
      let { msg } = item;
      let _chatroomResult = chatroomCacher.get(msg.targetId);
      let { isJoined } = _chatroomResult;
      if(utils.isEqual(msg.type, NOTIFY_TYPE.CHATROOM_ATTR)){
        isJoined && queryChatroomAttr(item, next);
      }
    }

    function queryChatroomAttr(item, next) {
      let { msg } = item;
      let chatroomId = msg.targetId;
      let syncTime = getChatroomAttrSyncTime(chatroomId);
      if (syncTime >= msg.receiveTime && msg.receiveTime > 0) {
        return next();
      }

      let data = {
        syncTime: syncTime,
        chatroomId: chatroomId,
        targetId: chatroomId,
        topic: COMMAND_TOPICS.SYNC_CHATROOM_ATTRS
      };
      send(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, attrs, chatroomId: _chatroomId } = result;
        attrs = attrs || [];
        logger.info({ tag: LOG_MODULE.MSG_SYNC, data, msg, code, count: attrs.length });
        if(!utils.isEqual(code, ErrorType.COMMAND_SUCCESS.code)){
          return next();
        }
        utils.forEach(attrs, (message) => {
          setChatRoomAttrSyncTime(_chatroomId, message.updateTime);
        });
        emitter.emit(SIGNAL_NAME.CMD_CHATROOM_ATTR_RECEIVED, { attrs, chatroomId: _chatroomId });
        next();
      });
    }

    function getChatroomAttrSyncTime(chatroomId){
      let syncInfo = chatroomCacher.get(chatroomId);
      return syncInfo.syncAttTime || 0;
    }
    function setChatRoomAttrSyncTime(chatroomId, time){
      let currentTime = getChatroomAttrSyncTime(chatroomId);
      if(time > currentTime){
        chatroomCacher.set(chatroomId, { syncAttTime: time });
      }
    }
  }
  return {
    exec
  };
}
