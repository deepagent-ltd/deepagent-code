import IO from "../socket/io";
import DeliveryClient from "../delivery/client";
import { deliveryError } from "../delivery/contract";
import Web from "./web/index";
import Desktop from "./desktop/index";
import RTCSignal from "./signal/index";

import Logger from "../logger/logger";
import Emitter from "../common/emmit";
import common from "../common/common";
import { CONVERSATION_TOP_TYPE, USER_TYPE, STREAM_EVENT, MEDIA_TYPE, CONVERATION_TAG_TYPE, 
        MESSAGE_SENT_STATE, EVENT, CONNECT_STATE, UNDISTURB_TYPE, CONVERATION_TYPE, MESSAGE_TYPE, ErrorType, 
        CONVERSATION_ORDER, MESSAGE_ORDER, MENTION_TYPE, FILE_TYPE, MENTION_ORDER, 
        SIGNAL_NAME, UNREAD_TAG, PLATFORM_TYPE, PUSH_CHANNEL, USER_STATUS } from "../enum";

import * as ENUM from "../enum";
import utils from "../utils";
import MessageCacher from "../common/msg-cacher";

let init = (config) => {
  // Capture a data primitive before invoking any provider or configuration getter.
  const mode = Object.getOwnPropertyDescriptor(config, "protectedDeliveryReader");
  if ((!mode && "protectedDeliveryReader" in config) || (mode && (!("value" in mode) || ![true, false, undefined].includes(mode.value))))
    throw deliveryError("init", "invalid_request");
  const protectedReader = mode?.value === true;
  const mediaMode = Object.getOwnPropertyDescriptor(config, "protectedMedia");
  if ((!mediaMode && "protectedMedia" in config) || (mediaMode && (!("value" in mediaMode) || ![true, false, undefined].includes(mediaMode.value))) ||
      mediaMode?.value === true && !protectedReader) throw deliveryError("init", "invalid_request");
  const protectedMedia = mediaMode?.value === true;
  if (protectedReader) config = { ...config, protectedDeliveryReader: true, isSync: false, isPC: false };
  let emitter = Emitter();
  if (protectedReader) {
    const emit = emitter.emit;
    emitter.emit = (name, data) => { if (name === EVENT.STATE_CHANGED) emit(name, data); };
  }
  let provider = {};
  let { upload, appkey = '', log = {}, serverList = [] } = config;
  let uploadType = common.checkUploadType(upload);
 
  let sessionId = common.getSessionId();
  let logger = Logger({ ...log, appkey, sessionId, getCurrentUser: getCurrentUser, getVersion: getVersion, serverList });

  // 移除 AppKey 前后空格
  appkey = appkey.trim();
  utils.extend(config, { uploadType, logger, appkey });
  let io = IO(config);

  function getCurrentUser(){
    return io.getCurrentUser({ ignores: [] });
  }

  function getVersion(){
    return io.getVersion();
  }

  let web = Web.init({ io, emitter, logger });
  provider = web;

  /* PC 特性检查： 全局变量中存在约定变量自动切换为 PC */
  if(!protectedReader && common.isDesktop()){
    emitter = Emitter();
    provider = Desktop.init({ appkey, io, emitter, web, client: JGChatPCClient, logger });
  }


  let plugins = {
    call: () => {
      return RTCSignal({ io, emitter, logger });
    }
  }

  // PC 和 Web 复用的事件在此处透传
  io.on(SIGNAL_NAME.CMD_STREAM_APPENDED, (message) => {
    if (protectedReader) return;
    emitter.emit(EVENT.STREAM_APPENDED, { message });
  });
  io.on(SIGNAL_NAME.CMD_STREAM_COMPLETED, (message) => {
    if (protectedReader) return;
    let { conversationId, conversationType, messageId } = message;
    provider.message.getMessagesByIds({ conversationId, conversationType, messageIds: [messageId] }).then(({ messages }) => {
      let msg = messages[0] || { content: '' };
      emitter.emit(EVENT.STREAM_COMPLETED, { message: { ...message, content: msg.content } });
    });
  });

  let _export = {
    ...provider.socket,
    ...provider.message,
    ...provider.conversation,
    ...provider.chatroom,
    ...provider.moment,
    ...DeliveryClient(io, provider.message, protectedMedia),
    ...emitter,
    registerMessage: common.registerMessage,
    isDesktop: common.isDesktop,
    install: (plugin) => {
      if(!utils.isObject(plugin)){
        return;
      }
      let { name } = plugin;
      let func = plugins[name] || function(){ return {} };
      let apis = func();
      return apis;
    },
    Event: EVENT,
    ConnectionState: CONNECT_STATE,
    ConversationType: CONVERATION_TYPE,
    MessageType: MESSAGE_TYPE,
    ConversationOrder: CONVERSATION_ORDER,
    ErrorType,
    MentionType: MENTION_TYPE,
    MessageOrder: MESSAGE_ORDER,
    MentionOrder: MENTION_ORDER,
    FileType: FILE_TYPE,
    UndisturbType: UNDISTURB_TYPE,
    SentState: MESSAGE_SENT_STATE,
    UnreadTag: UNREAD_TAG,
    ConversationTagType: CONVERATION_TAG_TYPE,
    MediaType: MEDIA_TYPE,
    UserType: USER_TYPE,
    StreamEvent: STREAM_EVENT,
    ConversationTopType: CONVERSATION_TOP_TYPE,
    PlatformType: PLATFORM_TYPE,
    PushChannel: PUSH_CHANNEL,
  };

  if (!protectedReader) return _export;
  const allowed = new Set(["connect", "disconnect", "isConnected", "isNeedConnect",
    "getDeliveryCapabilities", "getDeliveryReceipt", "sendProtectedMessage", "getDeliveryReader",
    "getDeliveryReceiverBaseline", "getDeliveryLiveCut", "getDeliveryLiveMessages", "getDeliveryChanges", "getDeliveryMessages", "getDeliveryReadCut", "getDeliveryOutputProof", "markDeliveryRead", "clear",
    "sendProtectedMedia", "getProtectedMediaCapabilities", "getProtectedMediaTransferCapabilities", "getProtectedMediaUploadProgress", "beginProtectedMedia", "putProtectedMediaChunk",
    "finalizeProtectedMedia", "getProtectedMedia", "cancelProtectedMedia", "readProtectedMediaRange"]);
  const guarded = Object.fromEntries(Object.entries(_export).map(([name, value]) => [name,
    typeof value !== "function" || allowed.has(name) ? value : () => { throw deliveryError(name, "legacy_api_disabled"); }]));
  for (const name of ["on", "once", "off"]) guarded[name] = (event, callback) => {
    if (event !== EVENT.STATE_CHANGED) throw deliveryError(name, "legacy_api_disabled");
    return emitter[name](event, callback);
  };
  guarded.isDesktop = () => false;
  guarded.isProtectedLiveReadAvailable = io.deliveryLiveReadAvailable;
  guarded.isProtectedReceiverBaselineAvailable = io.deliveryReceiverBaselineAvailable;
  guarded.readProtectedReceiverBaseline = io.readDeliveryReceiverBaseline;
  guarded.readProtectedLiveCut = io.readDeliveryLiveCut;
  guarded.readProtectedLivePage = io.readDeliveryLivePage;
  guarded.onProtectedLiveMessage = io.onProtectedLiveMessage;
  guarded.readProtectedLiveMessage = io.readProtectedLiveMessage;
  guarded.captureProtectedCurrentLink = io.captureProtectedCurrentLink;
  guarded.readProtectedCurrentLink = io.readProtectedCurrentLink;
  return Object.freeze(guarded);
}

export default {
  init,
  Event: EVENT,
  ConnectionState: CONNECT_STATE,
  ConversationType: CONVERATION_TYPE,
  MessageType: MESSAGE_TYPE,
  ConversationOrder: CONVERSATION_ORDER,
  ErrorType,
  MentionType: MENTION_TYPE,
  MessageOrder: MESSAGE_ORDER,
  MentionOrder: MENTION_ORDER,
  FileType: FILE_TYPE,
  UndisturbType: UNDISTURB_TYPE,
  SentState: MESSAGE_SENT_STATE,
  UnreadTag: UNREAD_TAG,
  ConversationTagType: CONVERATION_TAG_TYPE,
  MediaType: MEDIA_TYPE,
  UserType: USER_TYPE,
  StreamEvent: STREAM_EVENT,
  ConversationTopType: CONVERSATION_TOP_TYPE,
  PlatformType: PLATFORM_TYPE,
  PushChannel: PUSH_CHANNEL,
  UserStatus: USER_STATUS,
}
