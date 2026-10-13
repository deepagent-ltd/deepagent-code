import { COMMAND_TOPICS, CONVERATION_TYPE, UNDISTURB_TYPE, RTC_STATE} from "../../enum";
import utils from "../../utils";
import Proto from "../proto";
import { topics } from "../../delivery/contract";
import { encodeQuery } from "../../delivery/codec";
import JTextEncoder from "../../provoider/textencoder/index";

export default async function getQueryBody({ data, callback, index }, io){
  let { targetId, userId, topic  } = data;
  let buffer = [];
  if (topics[topic]) {
    buffer = encodeQuery(topic, data.request);
    if (topic !== "qry_delivery_receipt") targetId = io.getCurrentUser().id;
  }
  
  let { msgEncryptHook } = io.getConfig();
  msgEncryptHook = msgEncryptHook || {};
  if(!utils.isAsyncFunction(msgEncryptHook.onEncrypt) && !utils.isFunction(msgEncryptHook.onEncrypt)){
    msgEncryptHook = {
      onEncrypt: async (data) => {
        return data.buffer;
      }
    };
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.HISTORY_MESSAGES)){
    let { conversationType, time, count, order, names } = data;
    let codec = Proto.lookup('codec.QryHisMsgsReq');
    let message = codec.create({
      converId: targetId,
      type: conversationType,
      startTime: time,
      count: count,
      order: order,
      msgTypes: names
    });
    buffer = codec.encode(message).finish();
  }

  if(utils.isInclude([COMMAND_TOPICS.PUBLIC_CONVERSATIONS, COMMAND_TOPICS.CONVERSATIONS], topic)){
    let { count, time, order, conversationType, tag, exceptTag } = data;
    targetId = userId;
    let codec = Proto.lookup('codec.QryConversationsReq');
    let content = {
      startTime: time,
      count: count,
      order: order
    };
    if(!utils.isUndefined(conversationType)){
      utils.extend(content, { channelType: conversationType });
    }
    if(tag){
      utils.extend(content, { tag });
    }
    if(exceptTag){
      utils.extend(content, { exceptTag });
    }
    let message = codec.create(content);
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isEqual(COMMAND_TOPICS.GET_CONVERSATION, topic)){
    let {  conversation, userId } = data;
    let { conversationId, conversationType } = conversation;
    let codec = Proto.lookup('codec.QryConverReq');
    let message = codec.create({ 
      channelType: conversationType,
      targetId: conversationId
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.SYNC_CONVERSATIONS, topic)){
    let { count, syncTime } = data;
    targetId = userId;
    let codec = Proto.lookup('codec.SyncConversationsReq');
    let message = codec.create({ startTime: syncTime, count });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.SYNC_MESSAGES)){
    let { syncTime, containsSendBox, sendBoxSyncTime } = data;
    targetId = userId;
    let codec = Proto.lookup('codec.SyncMsgReq');
    let message = codec.create({
      syncTime,
      containsSendBox,
      sendBoxSyncTime
    });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.SYNC_CHATROOM_MESSAGES)){
    let { syncTime, chatroomId, count } = data;
    let codec = Proto.lookup('codec.SyncChatroomReq');
    let message = codec.create({
      syncTime,
      chatroomId,
      count
    });
    targetId = chatroomId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.SYNC_CHATROOM_ATTRS)){
    let { syncTime, chatroomId } = data;
    let codec = Proto.lookup('codec.SyncChatroomReq');
    let message = codec.create({
      syncTime,
      chatroomId
    });
    targetId = chatroomId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_MSG_BY_IDS, topic)){
    let { conversationId, conversationType: channelType, messageIds: msgIds, userId } = data;
    let codec = Proto.lookup('codec.QryHisMsgByIdsReq');
    let message = codec.create({
      channelType,
      targetId: conversationId,
      msgIds,
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_UNREAD_TOTLAL_CONVERSATION, topic)){
    targetId = userId;
    let codec = Proto.lookup('codec.QryTotalUnreadCountReq');
    let { conversationTypes = [], ignoreConversations = [], tag } = data;
    let ingores = [];
    utils.forEach(ignoreConversations, ({ conversationId, conversationType }) => {
      ingores.push({ 
        targetId: conversationId,
        channelType: conversationType
       });
    });
    let filter = {
      channelTypes: conversationTypes,
      ignoreConvers: ingores
    };
    if(tag){
      utils.extend(filter, { tag });
    }
    let message = codec.create({ 
      filter: filter
    });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.CLEAR_UNREAD_TOTLAL_CONVERSATION, topic)){
    targetId = userId;
    let codec = Proto.lookup('codec.QryTotalUnreadCountReq');
    let message = codec.create({});
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.READ_MESSAGE, topic)){
    let { messages } = data;
    messages = utils.isArray(messages) ? messages : [messages];
    let channelType = CONVERATION_TYPE.PRIVATE;
    let channelId = '';
    
    let msgs = utils.map(messages, (item) => {
      let { conversationType, conversationId, sentTime, messageId, unreadIndex } = item;
      channelType = conversationType;
      channelId = conversationId;
      targetId = conversationId;
      return { 
        msgId: messageId,
        msgTime: sentTime,
        msgIndex: unreadIndex
      };
    });
    let codec = Proto.lookup('codec.MarkReadReq');
    let message = codec.create({
      channelType,
      targetId: channelId,
      msgs
    });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_READ_MESSAGE_DETAIL, topic)){
    let { message } = data;
    let { conversationType: channelType, conversationId, messageId: msgId } = message;
    let codec = Proto.lookup('codec.QryReadDetailReq');
    let msg = codec.create({
      channelType,
      targetId: conversationId,
      msgId,
    });
    targetId = msgId;
    buffer = codec.encode(msg).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_MENTION_MSGS, topic)){
    let { conversationId, conversationType: channelType, count, order, messageIndex: startIndex, userId, onlyUnread } = data;
    let codec = Proto.lookup('codec.QryMentionMsgsReq');
    let message = codec.create({
      targetId: conversationId,
      channelType,
      count,
      order,
      startIndex,
      onlyUnread
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_FILE_TOKEN, topic)){
    targetId = userId;
    let { type, ext } = data;
    let codec = Proto.lookup('codec.QryUploadTokenReq');
    let message = codec.create({ fileType: type, ext });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_USER_INFO, topic)){
    targetId = userId;
    let codec = Proto.lookup('codec.UserIdReq');
    let message = codec.create({ userId });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_MERGE_MSGS, topic)){
    let { messageId, time, count, order } = data;
    targetId = messageId;
    let codec = Proto.lookup('codec.QryMergedMsgsReq');
    let message = codec.create({ startTime: time, count, order });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.GET_FIRST_UNREAD_MSG, topic)){
    let { conversationType, conversationId } = data;
    targetId = conversationId;
    let codec = Proto.lookup('codec.QryFirstUnreadMsgReq');
    let message = codec.create({ channelType: conversationType, targetId: conversationId });
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.QUERY_TOP_CONVERSATIONS, topic)){
    let { time, userId, sortType } = data;
    let codec = Proto.lookup('codec.QryTopConversReq');
    let message = codec.create({ startTime: time, sortType });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  

  if(utils.isEqual(COMMAND_TOPICS.RECALL, topic)){
    let { messageId, sentTime, exts, conversationType, conversationId } = data;
    let _exts = [];
    utils.forEach(exts, (value, key) => {
      _exts.push({ key, value });
    });
    let codec = Proto.lookup('codec.RecallMsgReq');
    let message = codec.create({
      targetId: conversationId,
      channelType: conversationType,
      msgId: messageId,
      msgTime: sentTime,
      exts: _exts
    });
    targetId = conversationId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.CLEAR_UNREAD, topic)){
    let { conversations, userId } = data;
    conversations = utils.isArray(conversations) ? conversations : [conversations];
    let codec = Proto.lookup('codec.ClearUnreadReq');
    let currentUser = io.getCurrentUser();
    let list = utils.map(conversations, ({ conversationType, conversationId, unreadIndex }) => {
      return { 
        channelType: conversationType,
        targetId: conversationId,
        latestReadIndex: currentUser.mentionClearType == 0 ? unreadIndex : 0
      };
    });
    let message = codec.create({
      conversations: list
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.SET_ALL_DISTURB, topic)){
    let { userId, times, timezone, type } = data;
    let codec = Proto.lookup('codec.UserUndisturb');
    let isSwitch = utils.isEqual(UNDISTURB_TYPE.DISTURB, type);
    let message = codec.create({
      switch: isSwitch,
      timezone: timezone,
      rules: times,
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isEqual(COMMAND_TOPICS.GET_ALL_DISTURB, topic)){
    let { userId } = data;
    let codec = Proto.lookup('codec.Nil');
    let message = codec.create({});
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.MARK_CONVERSATION_UNREAD, topic)){
    let { userId, conversations } = data;
    conversations = utils.map(conversations, (item) => {
      let { conversationId, conversationType, unreadTag } = item;
      return {
        channelType: conversationType,
        targetId: conversationId,
        unreadTag,
      }
    })
    let codec = Proto.lookup('codec.ConversationsReq');
    let message = codec.create({ conversations });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isInclude([COMMAND_TOPICS.SET_CHATROOM_ATTRIBUTES, COMMAND_TOPICS.REMOVE_CHATROOM_ATTRIBUTES], topic)){
    let { chatroom: { id: chatId, attributes, options  } } = data;
    let { notify } = options;
    let codec = Proto.lookup('codec.ChatAttBatchReq');
    let _msg = { 
      atts: attributes,
    };
    if(!utils.isUndefined(notify)){
      utils.extend(_msg, { msg: JTextEncoder.encoder(notify)})
    }
    let message = codec.create(_msg);
    targetId = chatId;
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isEqual(COMMAND_TOPICS.REMOVE_CONVERSATION, topic)){
    let { conversations, userId } = data;
    conversations = utils.isArray(conversations) ? conversations : [conversations];
    let list = utils.map(conversations, ({ conversationType, conversationId }) => {
      return { 
        channelType: conversationType,
        targetId: conversationId 
      };
    });
    let codec = Proto.lookup('codec.DelConversationReq');
    let message = codec.create({
      conversations: list
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.UPDATE_MESSAGE, topic)){
    let { conversationId, conversationType: channelType, messageId: msgId, content, sentTime: msgTime, msgName } = data;
    let codec = Proto.lookup('codec.ModifyMsgReq');
    content = utils.toJSON(content);
    
    let modifyBuffer = JTextEncoder.encoder(content);
    modifyBuffer = await msgEncryptHook.onEncrypt({
      buffer: modifyBuffer, 
      name: msgName,
      conversationType: channelType,
      conversationId: conversationId,
    });

    let message = codec.create({
      channelType,
      targetId: conversationId,
      msgId,
      msgTime,
      msgType: msgName,
      msgContent: modifyBuffer
    });
    targetId = conversationId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.CLEAR_MESSAGE, topic)){
    let { conversationId, conversationType: channelType, time: cleanMsgTime } = data;
    let codec = Proto.lookup('codec.CleanHisMsgReq');
    let message = codec.create({
      channelType,
      targetId: conversationId,
      cleanMsgTime,
    });
    targetId = conversationId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.JOIN_CHATROOM, topic)){
    let { chatroom: { id: chatId, isAutoCreate  } } = data;
    let codec = Proto.lookup('codec.ChatRoomReq');
    let message = codec.create({ chatId, isAutoCreate });
    targetId = chatId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.QUIT_CHATROOM, topic)){
    let { chatroom: { id: chatId  } } = data;
    let codec = Proto.lookup('codec.ChatRoomReq');
    let message = codec.create({ chatId });
    targetId = chatId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.INSERT_CONVERSATION, topic)){
    let {  conversation, userId } = data;
    let { conversationId, conversationType } = conversation;
    let codec = Proto.lookup('codec.Conversation');
    let message = codec.create({ 
      channelType: conversationType,
      targetId: conversationId
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isEqual(COMMAND_TOPICS.MUTE_CONVERSATION, topic)){
    let { userId, conversations } = data;
    let items = utils.isArray(conversations) ? conversations : [conversations];
    items = utils.map(items, (item) => {
      let { conversationType, conversationId, undisturbType } = item;
      return { targetId: conversationId, channelType: conversationType, undisturbType };
    });
    let codec = Proto.lookup('codec.UndisturbConversReq');
    let message = codec.create({ 
      userId: userId,
      items: items
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isEqual(COMMAND_TOPICS.TOP_CONVERSATION, topic)){
    let { userId, conversations } = data;
    let items = utils.isArray(conversations) ? conversations : [conversations];
    items = utils.map(items, (item) => {
      let { conversationType, conversationId, isTop } = item;
      return { targetId: conversationId, channelType: conversationType, isTop };
    });
    let codec = Proto.lookup('codec.ConversationsReq');
    let message = codec.create({ 
      conversations: items
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.REMOVE_MESSAGE, topic)){
    let { userId, messages } = data;
  
    let msgs = [], _targetId = '', channelType = CONVERATION_TYPE.PRIVATE;
    utils.forEach(messages, (message) => {
      let { conversationType, conversationId, messageIndex, sentTime, messageId } = message;
      _targetId = conversationId;
      channelType = conversationType,
      msgs.push({ msgId: messageId, msgIndex: messageIndex, msgTime: sentTime });
    });

    let codec = Proto.lookup('codec.DelHisMsgsReq');
    let message = codec.create({ 
      channelType,
      targetId: _targetId,
      msgs: msgs,
    });
    
    targetId = _targetId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isInclude([COMMAND_TOPICS.ADD_MSG_REACTION, COMMAND_TOPICS.REMOVE_MSG_REACTION], topic)){
    let { messageId, reactionId, userId, conversationId, conversationType } = data;
    let codec = Proto.lookup('codec.MsgExt');
    let message = codec.create({ 
      channelType: conversationType,
      targetId: conversationId,
      msgId: messageId,
      ext: {
        key: reactionId,
        value: userId
      }
    });
    targetId = messageId;
    buffer = codec.encode(message).finish();
  }
  
  if(utils.isInclude([COMMAND_TOPICS.CONVERSATION_TAG_ADD, COMMAND_TOPICS.CONVERSATION_TAG_REMOVE], topic)){
    let { userId, tag } = data;
    let { name = '', id, conversations = [] } = tag;
    let convers = utils.map(conversations, ({ conversationId, conversationType }) => {
      return { targetId: conversationId, channelType: conversationType };
    });
    let codec = Proto.lookup('codec.TagConvers');
    let message = codec.create({ 
      tag: id,
      tagName: name,
      convers: convers
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isInclude([COMMAND_TOPICS.TAG_CREATE, COMMAND_TOPICS.TAG_REMOVE], topic)){
    let { userId, tag } = data;
    let tags = utils.isArray(tag) ? tag : [tag];
    tags = utils.map(tags, (tag) => {
      return { tag: tag.id, tagName: tag.name, tagOrder: tag.order };
    });
    let codec = Proto.lookup('codec.UserConverTags');
    let message = codec.create({
      tags: tags
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }

  if(utils.isEqual(COMMAND_TOPICS.TAG_QUERY, topic)){
    let { userId } = data;
    let codec = Proto.lookup('codec.Nil');
    let message = codec.create({});
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isInclude([COMMAND_TOPICS.RTC_CREATE_ROOM, COMMAND_TOPICS.RTC_JOIN_ROOM], topic)){
    let { room, user } = data;
    let { id, type, option = {} } = room;
    let { cameraEnable = false, micEnable = false } = option;
    let codec = Proto.lookup('codec.RtcRoomReq');
    let message = codec.create({
      roomId: id, 
      roomType: type,
      joinMember: {
        member: user,
        rtcState: RTC_STATE.NONE,
        cameraEnable, 
        micEnable,
      }
    });
    targetId = user.id;
    if(utils.isEqual(COMMAND_TOPICS.RTC_JOIN_ROOM, topic)){
      targetId = room.id;
    }
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.RTC_QUIT_ROOM, topic)){
    let { room } = data;
    let codec = Proto.lookup('codec.RtcRoomReq');
    let message = codec.create({
      roomId: room.id,
      roomType: room.type
    });
    targetId = room.id;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.RTC_QRY_ROOM, topic)){
    let { room } = data;
    let codec = Proto.lookup('codec.Nil');
    let message = codec.create({});
    targetId = room.id;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.RTC_PING, topic)){
    let { room } = data;
    let codec = Proto.lookup('codec.Nil');
    let message = codec.create({});
    targetId = room.id;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.RTC_INVITE, topic)){
    let { roomId, roomType, memberIds, channel, user, mediaType, ext, attachedConversation } = data;
    let codec = Proto.lookup('codec.RtcInviteReq');
    let _data = {
      roomId: roomId,
      roomType: roomType,
      targetIds: memberIds,
      rtcChannel: channel,
      rtcMediaType: mediaType,
      ext: ext || ''
    };
    if(!utils.isEmpty(attachedConversation)){
      let { conversationType, conversationId, subChannel } = attachedConversation;
      _data.attachedConver = {
        channelType: conversationType,
        targetId: conversationId,
        subChannel: subChannel || ''
      };
    }
    let message = codec.create(_data);
    targetId = roomId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.RTC_UPDATE_STATE, topic)){
    let { memberId, state, roomId } = data;
    let codec = Proto.lookup('codec.RtcMember');
    let message = codec.create({
      member: { 
        userId: memberId 
      },
      rtcState: state,
    });
    targetId = roomId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isInclude([COMMAND_TOPICS.RTC_ACCEPT, COMMAND_TOPICS.RTC_HANGUP], topic)){
    let { roomId, user } = data;
    let codec = Proto.lookup('codec.Nil');
    let message = codec.create({});
    targetId = roomId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isInclude([COMMAND_TOPICS.SET_TOP_MSG, COMMAND_TOPICS.DEL_TOP_MSG], topic)){
    let { conversationId, conversationType, messageId, isTop, userId } = data;
    let codec = Proto.lookup('codec.SetTopMsgReq');
    let message = codec.create({
      channelType: conversationType,
      targetId: conversationId,
      msgId: messageId
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.GET_TOP_MSG, topic)){
    let { conversationId, conversationType } = data;
    let codec = Proto.lookup('codec.GetTopMsgReq');
    let message = codec.create({
      channelType: conversationType,
      targetId: conversationId
    });
    targetId = conversationId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isInclude([COMMAND_TOPICS.MSG_ADD_FAVORITE, COMMAND_TOPICS.MSG_REMOVE_FAVORITE], topic)){
    let { messages, userId } = data;
    let codec = Proto.lookup('codec.FavoriteMsgIds');
    let items = utils.map(messages, (message) => {
      let { conversationId, conversationType, senderId, messageId } = message;
      return {
        channelType: conversationType,
        receiverId: conversationId,
        senderId: senderId,
        msgId: messageId
      };
    });
    let message = codec.create({ items });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.MSG_QRY_FAVORITE, topic)){
    let { limit, offset, userId } = data;
    let codec = Proto.lookup('codec.QryFavoriteMsgsReq');
    let message = codec.create({
      limit, offset
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.UPLOAD_PUSH_TOKEN, topic)){
    let { deviceId, pushToken, platform, packageName, pushChannel, userId } = data;
    let codec = Proto.lookup('codec.RegPushTokenReq');
    let message = codec.create({ deviceId, pushToken, platform, packageName, pushChannel });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.SWITCH_PUSH, topic)){
    let { isOpen } = data;
    let codec = Proto.lookup('codec.PushSwitch');
    let message = codec.create({ switch: isOpen });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.BATCH_TRANSLATE, topic)){
    let { userId, content, sourceLang, targetLang } = data;
    let codec = Proto.lookup('codec.TransReq');
    let items = [];
    utils.forEach(content, (val, key) => {
      items.push({ key, content: val });
    });
    sourceLang = utils.isEqual(sourceLang, 'auto') ? '' : sourceLang;
    let message = codec.create({
      items,
      sourceLang,
      targetLang,
    });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.MSG_CONVERSATION_SEARCH, topic)){
    let { conversationId, conversationType: channelType, keyword, count } = data;
    let codec = Proto.lookup('codec.SearchMsgsReq');
    let message = codec.create({ keyword, count, channelType, targetId: conversationId });
    targetId = conversationId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isEqual(COMMAND_TOPICS.MSG_GLOBAL_SEARCH, topic)){
    let { keyword, count, userId } = data;
    let codec = Proto.lookup('codec.SearchMsgsReq');
    let message = codec.create({ keyword, count });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  if(utils.isInclude([COMMAND_TOPICS.GET_USER_STATUS, COMMAND_TOPICS.SUB_USER_STATUS], topic)){
    let { userIds, userId } = data;
    let codec = Proto.lookup('codec.UserIdsReq');
    let message = codec.create({ userIds });
    targetId = userId;
    buffer = codec.encode(message).finish();
  }
  let codec = Proto.lookup('codec.QueryMsgBody');
  let message = codec.create({ index, topic, targetId, data: buffer });
  let _buffer = codec.encode(message).finish();
  return { buffer: _buffer };
}