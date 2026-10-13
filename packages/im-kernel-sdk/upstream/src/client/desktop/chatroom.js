import { SIGNAL_NAME, EVENT, CHATROOM_EVENT_TYPE, LOG_MODULE } from "../../enum";
import utils from "../../utils";
import attrCaher from "../../common/attr-cacher";
import chatroomCacher from "../../common/chatroom-cacher";

export default function($chatroom, { io, emitter, logger }){

  io.on(SIGNAL_NAME.CMD_CHATROOM_ATTR_RECEIVED, (result) => {
    
    logger.info({ tag: LOG_MODULE.CHATROOM_ATTR_RECEIVE, ...result });

    let { dels, updates } = attrCaher.heap(result);
    let { chatroomId } = result;
    if(!utils.isEmpty(dels)){
      emitter.emit(EVENT.CHATROOM_ATTRIBUTE_DELETED, { id: chatroomId, attributes: dels });
    }
    if(!utils.isEmpty(updates)){
      emitter.emit(EVENT.CHATROOM_ATTRIBUTE_UPDATED, { id: chatroomId, attributes: updates });
    }
  });

  io.on(SIGNAL_NAME.CMD_CHATROOM_DESTROY, (chatroom) => {
    emitter.emit(EVENT.CHATROOM_DESTROYED, chatroom);
  });

  io.on(SIGNAL_NAME.CMD_CHATROOM_EVENT, (notify) => {
    let { type, chatroomId } = notify;
    if(utils.isEqual(CHATROOM_EVENT_TYPE.FALLOUT, type) || utils.isEqual(CHATROOM_EVENT_TYPE.QUIT, type)){
      clearChatroomCache(chatroomId);
      emitter.emit(EVENT.CHATROOM_USER_QUIT, notify);
    }
    if(utils.isEqual(CHATROOM_EVENT_TYPE.KICK, type)){
      clearChatroomCache(chatroomId);
      emitter.emit(EVENT.CHATROOM_USER_KICKED, notify);
    }
  });

  function clearChatroomCache(chatroomId){
    chatroomCacher.remove(chatroomId);
    attrCaher.removeAll(chatroomId);
  };

  let joinChatroom = (chatroom) =>{
    return $chatroom.joinChatroom(chatroom);
  };
  let joinAndCreateChatroom = (chatroom) =>{
    return $chatroom.joinAndCreateChatroom(chatroom);
  };
  let quitChatroom = (chatroom) => {
    return $chatroom.quitChatroom(chatroom);
  };

  let setChatroomAttributes = (chatroom) => {
    return $chatroom.setChatroomAttributes(chatroom)
  };

  let getChatroomAttributes = (chatroom) => {
    return $chatroom.getChatroomAttributes(chatroom)
  };

  let removeChatroomAttributes = (chatroom) => {
    return $chatroom.removeChatroomAttributes(chatroom)
  };

  let getAllChatRoomAttributes = (chatroom) => {
    return $chatroom.getAllChatRoomAttributes(chatroom)
  };

  return {
    joinChatroom,
    quitChatroom,
    joinAndCreateChatroom,
    setChatroomAttributes,
    getChatroomAttributes,
    removeChatroomAttributes,
    getAllChatRoomAttributes,
  }
}