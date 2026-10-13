import utils from "../../utils";
import Storage from "../../common/storage";
import Consumer from "../../common/consumer";
import common from "../../common/common";
import chatroomCacher from "../../common/chatroom-cacher";

import { SIGNAL_CMD, COMMAND_TOPICS, STORAGE, NOTIFY_TYPE, SIGNAL_NAME, ErrorType, LOG_MODULE } from "../../enum";
export default function ChatroomSyncer(send, emitter, io, { logger }) {

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
      let { msg } = item;
      let _chatroomResult = chatroomCacher.get(msg.targetId);
      let { isJoined } = _chatroomResult;
      logger.info({ tag: LOG_MODULE.MSG_SYNC, ...item, isJoined });
      if(isJoined){
        if (utils.isEqual(msg.type, NOTIFY_TYPE.CHATROOM)) {
          queryChatroom(item, next);
        }
        if (utils.isEqual(msg.type, NOTIFY_TYPE.CHATROOM_DESTORY)) {
          broadcastChatroomDestory(item, next);
        }
      }else{
        next();
      }
    }

    function broadcastChatroomDestory(item, next){
      let { msg } = item;
      let chatroomId = msg.targetId;
      emitter.emit(SIGNAL_NAME.CMD_CHATROOM_DESTROY, { id: chatroomId });
      next();
    }

    function queryChatroom(item, next) {
      let {  msg } = item;
      let chatroomId = msg.targetId;
      let syncTime = getChatroomSyncTime(chatroomId);
      if (syncTime >= msg.receiveTime && msg.receiveTime > 0) {
        logger.info({ tag: LOG_MODULE.MSG_SYNC, syncTime, msg });
        return next();
      }
      if(msg.isNotSync){
        logger.info({ tag: LOG_MODULE.MSG_SYNC, syncTime, msg });
        setChatRoomSyncTime(msg.targetId, msg.receiveTime);
        return next();
      }
      
      let count = msg.count || 50;
      let data = {
        syncTime: syncTime,
        chatroomId: chatroomId,
        count: count,
        topic: COMMAND_TOPICS.SYNC_CHATROOM_MESSAGES
      };
      send(SIGNAL_CMD.QUERY, data, ({ messages, code }) => {
        messages = messages || [];
        logger.info({ tag: LOG_MODULE.MSG_SYNC, data, msg, code, count: messages.length });
        if(!utils.isEqual(code, ErrorType.COMMAND_SUCCESS.code)){
          return next();
        }
        let { msgs = [] } = chatroomCacher.get(chatroomId);
        utils.forEach(messages, (message) => {
          setChatRoomSyncTime(message.conversationId, message.sentTime);
          let { messageId } = message;
          let isInclude  = utils.isInclude(msgs, messageId);
          if(!isInclude){
            msgs.push(messageId);
            emitter.emit(SIGNAL_NAME.CMD_RECEIVED, [message]);
          }
        });
        chatroomCacher.set(chatroomId, { msgs });
        next();
      });
    }

    function getChatroomSyncTime(chatroomId){
      let result = chatroomCacher.get(chatroomId);
      return result.syncMsgTime || 0;
    }
    function setChatRoomSyncTime(chatroomId, time){
      let currentTime = getChatroomSyncTime(chatroomId);
      if(time > currentTime){
        chatroomCacher.set(chatroomId, { syncMsgTime: time });
      }
    }
  }
  return {
    exec
  };
}
