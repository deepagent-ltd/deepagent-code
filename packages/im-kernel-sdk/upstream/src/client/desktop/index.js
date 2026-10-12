import Conversation from "./conversation";
import Message from "./message";
import Socket from "./socket";
import Chatroom from "./chatroom";

import * as ENUM from "../../enum";
import utils from "../../utils";
import MessageCacher from "../../common/msg-cacher";
import common from "../../common/common";
import Storage from "../../common/storage";
import tools from "./tools";
import chatroomCacher from "../../common/chatroom-cacher";

let init = ({ appkey, io, emitter, web, client, logger }) => {

  let { SIGNAL_NAME } = ENUM;
  // 移除 Web 监听
  io.off(SIGNAL_NAME.CMD_CONVERSATION_CHANGED);
  io.off(SIGNAL_NAME.CONN_CHANGED);
  io.off(SIGNAL_NAME.CMD_RECEIVED);

  let conversationUtils = common.ConversationUtils();

  let pc = JGChatPCClient.init(appkey, {
    ...web,
    emitter,
    io,
    ENUM,
    utils,
    common,
    MessageCacher,
    conversationUtils,
    chatroomCacher,
    tools,
    Storage,
    logger
  });
  let socket = Socket(pc.socket, { webAgent: web.socket });
  let conversation = Conversation(pc.conversation, { webAgent: web.conversation, conversationUtils });
  let message = Message(pc.message, { webAgent: web.message });
  let chatroom = Chatroom(web.chatroom, { io, emitter });
 
  // 告知 IO 模块当前是 PC 端，做特殊处理，例如：同步会话列表
  io.setConfig({
    isPC: true,
    $conversation: pc.conversation,
    $socket: pc.socket,
    $message: pc.message,
    logger: logger,
  });

  return {
    socket,
    conversation,
    message,
    chatroom,
  };
};
export default {
  init
}
