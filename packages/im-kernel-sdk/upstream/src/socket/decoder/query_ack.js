import Emitter from "../../common/emmit";
import utils from "../../utils";
import Proto from "../proto";
import { topics, deliveryError } from "../../delivery/contract";
import { decodeQuery } from "../../delivery/codec";
import { SIGNAL_NAME, SIGNAL_CMD, CONNECT_STATE, COMMAND_TOPICS, MESSAGE_TYPE, ErrorType, CONNECT_ACK_INDEX, PONG_INDEX, UPLOAD_TYPE, CONVERATION_TYPE, MESSAGE_SENT_STATE, UNDISTURB_TYPE, STORAGE, USER_STATUS } from "../../enum";
import common from "../../common/common";
import tools from "./tools";

export default async function getQueryAckBody(stream, { cache, currentUser, io }){
  let codec = Proto.lookup('codec.QueryAckMsgBody');
  let qryAckMsgBody = codec.decode(stream);
  let { index, data, code, timestamp } = qryAckMsgBody;

  let { topic, targetId } = cache.get(index);
  // A rejected legacy reader ACK has no body. Do not decode empty data into
  // success defaults (or throw before the caller can observe reader_required).
  if (code !== 0) return { code, timestamp, index };

  if (topics[topic]) {
    try { return { code, timestamp, index, delivery: decodeQuery(topic, data) }; }
    catch (_) { return { code: 30001, timestamp, index, deliveryError: deliveryError(topics[topic][0], "invalid_response") }; }
  }
  let result = {};
  if (utils.isInclude([COMMAND_TOPICS.HISTORY_MESSAGES, COMMAND_TOPICS.SYNC_MESSAGES, COMMAND_TOPICS.GET_MSG_BY_IDS, COMMAND_TOPICS.GET_MERGE_MSGS], topic)) {
    result = await getMessagesHandler(index, data, { currentUser, io });
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.SYNC_CHATROOM_MESSAGES)) {
    result = await getChatroomMsgsHandler(index, data, { currentUser, io });
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.SYNC_CHATROOM_ATTRS)) {
    result = getChatroomAttrsHandler(index, data, { targetId });
  }

  if (utils.isInclude([COMMAND_TOPICS.CONVERSATIONS, COMMAND_TOPICS.PUBLIC_CONVERSATIONS, COMMAND_TOPICS.SYNC_CONVERSATIONS, COMMAND_TOPICS.QUERY_TOP_CONVERSATIONS], topic)) {
    result = await getConversationsHandler(index, data, { topic, currentUser, io });
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_CONVERSATION)) {
    result = await getConversationHandler(index, data, { currentUser, io });
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_UNREAD_TOTLAL_CONVERSATION)) {
    result = getTotalUnread(index, data);
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_READ_MESSAGE_DETAIL)) {
    result = getMessageReadDetails(index, data);
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_MENTION_MSGS)) {
    result = await getMentionMessages(index, data, { currentUser, io });
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_FILE_TOKEN)) {
    result = getFileToken(index, data);
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_USER_INFO)) {
    result = getUserInfo(index, data);
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_ALL_DISTURB)) {
    result = getAllDisturb(index, data);
  }

  if (utils.isInclude([COMMAND_TOPICS.REMOVE_CHATROOM_ATTRIBUTES, COMMAND_TOPICS.SET_CHATROOM_ATTRIBUTES], topic)) {
    result = getChatroomSetAttrs(index, data);
  }

  if (utils.isEqual(topic, COMMAND_TOPICS.GET_FIRST_UNREAD_MSG)) {
    result = await getMessage(index, data, { currentUser, io });
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.TAG_QUERY)){
    result = getConversationTags(index, data);
  }
  
  if(utils.isEqual(topic, COMMAND_TOPICS.BATCH_TRANSLATE)){
    result = getBatchTranslate(index, data);
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.GET_TOP_MSG)){
    result = await getTopMessage(index, data, { currentUser, io });
  }
  
  if(utils.isEqual(topic, COMMAND_TOPICS.MSG_QRY_FAVORITE)){
    result = await getFavtoriteMsgs(index, data, { currentUser, io });
  }

  if(utils.isInclude([COMMAND_TOPICS.RTC_ACCEPT, COMMAND_TOPICS.RTC_INVITE], topic)){
    result = getRTCAuth(index, data);
  }

  if(utils.isInclude([COMMAND_TOPICS.RTC_CREATE_ROOM, COMMAND_TOPICS.RTC_JOIN_ROOM, COMMAND_TOPICS.RTC_QRY_ROOM], topic)){
    result = getRTCRoom(index, data);
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.MSG_CONVERSATION_SEARCH)){
    result = await getConversationSearch(index, data, { currentUser, io });
  }

  if(utils.isEqual(topic, COMMAND_TOPICS.MSG_GLOBAL_SEARCH)){
    result = await getGlobalSearch(index, data, { currentUser, io });
  }
  
  if(utils.isEqual(topic, COMMAND_TOPICS.TAG_CREATE)){
    result = await getCreateTagHandler(index, data, { currentUser, io });
  }
  if(utils.isInclude([COMMAND_TOPICS.GET_USER_STATUS, COMMAND_TOPICS.SUB_USER_STATUS], topic)){
    result = await getUserStatus(index, data, { currentUser, io });
  }

  result = utils.extend(result, { code, timestamp, index });
  return result;
};

async function getFavtoriteMsgs(index, data, { currentUser, io }){
  let payload = Proto.lookup('codec.FavoriteMsgs');
  let result = payload.decode(data);
  let { items, offset } = result;
  if(!items){
    items = [];
  }
  let list = await utils.Defer.all(
    utils.map(items, async (item) => {
      let { createdTime, msg } = item;
      let message = await tools.msgFormat(msg, { currentUser, io });
      return { createdTime, message };
    })
  );
  return {
    index, list, offset
  }
}

async function getTopMessage(index, data, { currentUser, io }){
  let payload = Proto.lookup('codec.TopMsg');
  let result = payload.decode(data);
  let { msg, operator, createdTime = 0 } = result;
  let message = {};
  if(msg){
    message = await tools.msgFormat(result.msg, { currentUser, io });
    operator = common.formatUser(result.operator);
  }
  return {
    index, message, operator, createdTime
  }
}

function getBatchTranslate(index, data){
  let payload = Proto.lookup('codec.TransReq');
  let trans = payload.decode(data);
  return {
    index, trans
  }
}

function getRTCAuth(index, data){
  let payload = Proto.lookup('codec.RtcAuth');
  let auth = payload.decode(data);
  return {
    index, auth
  }
}

function getChatroomSetAttrs(index, data) {
  let payload = Proto.lookup('codec.ChatAttBatchResp');
  let { attResps } = payload.decode(data);
  let success = [], fail = [];
  utils.forEach(attResps, (attr) => {
    let { code = 0, key, attTime: updateTime, msgTime: messageTime } = attr;
    let _attr = { code, key, updateTime, messageTime };
    if (utils.isEqual(code, ErrorType.COMMAND_SUCCESS.code)) {
      success.push(_attr)
    } else {
      let error = common.getError(code);
      utils.extend(_attr, error);
      fail.push(_attr)
    }
  })
  return {
    index, success, fail
  }
}
async function getMentionMessages(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.QryMentionMsgsResp');
  let { mentionMsgs, isFinished } = payload.decode(data);

  let msgs = await utils.Defer.all(
    utils.map(mentionMsgs, async (msg) => {
      return await tools.msgFormat(msg, { currentUser, io });
    })
  );
  return {
    index, msgs, isFinished
  };
}

function getFileToken(index, data) {
  let payload = Proto.lookup('codec.QryUploadTokenResp');
  let result = payload.decode(data);
  let { ossType } = result;
  let cred = { type: ossType };
  if (utils.isEqual(ossType, UPLOAD_TYPE.QINIU)) {
    let { qiniuCred } = result;
    utils.extend(cred, qiniuCred);
  }
  if (utils.isEqual(ossType, UPLOAD_TYPE.ALI)) {
    let { preSignResp } = result;
    utils.extend(cred, preSignResp);
  }
  if (utils.isEqual(ossType, UPLOAD_TYPE.S3) || utils.isEqual(ossType, UPLOAD_TYPE.MINIO)) {
    let { preSignResp } = result;
    utils.extend(cred, preSignResp);
  }
  return {
    index, cred
  };
}

function getUserInfo(index, data) {
  let payload = Proto.lookup('codec.UserInfo');
  let user = payload.decode(data);
  return {
    index, user
  };
}

function getAllDisturb(index, data) {
  let payload = Proto.lookup('codec.UserUndisturb');
  let params = payload.decode(data);
  let { timezone, rules = [] } = params;
  let type = params.switch ? UNDISTURB_TYPE.UNDISTURB : UNDISTURB_TYPE.DISTURB;
  let times = [];
  utils.forEach(rules, ({ start, end }) => {
    times.push({ start, end });
  });
  return { index, type, timezone, times };
}

function getMessageReadDetails(index, data) {
  let payload = Proto.lookup('codec.QryReadDetailResp');
  let { readCount, memberCount, readMembers, unreadMembers } = payload.decode(data);
  readMembers = utils.map(readMembers, (item) => {
    return {
      member: common.formatUser(item.member),
      readTime: item.time,
    };
  });
  unreadMembers = utils.map(unreadMembers, (item) => {
    return {
      member: common.formatUser(item.member),
      readTime: item.time,
    };
  });
  return {
    index, readCount, unreadCount: memberCount - readCount, readMembers, unreadMembers
  };
}

function getTotalUnread(index, data) {
  let payload = Proto.lookup('codec.QryTotalUnreadCountResp');
  let { totalCount: count } = payload.decode(data);
  return {
    index, count
  };
}


async function getConversationHandler(index, data, options = {}) {
  let payload = Proto.lookup('codec.Conversation');
  let item = payload.decode(data);
  let conversations = await tools.formatConversations([item], options);
  let conversation = conversations[0] || {};
  return { conversation, index };
}
async function getConversationsHandler(index, data, options = {}) {
  let payload = Proto.lookup('codec.QryConversationsResp');
  let { conversations, isFinished } = payload.decode(data);
  conversations = await tools.formatConversations(conversations, options);
  return { conversations, isFinished, index };
}
function getChatroomAttrsHandler(index, data, { targetId }) {
  let payload = Proto.lookup('codec.SyncChatroomAttResp');
  let result = payload.decode(data);
  let { atts } = result;
  atts = utils.map(atts, (attr) => {
    let { key, value, attTime: updateTime, userId, optType: type, } = attr;
    return { key, value, updateTime, userId, type };
  });
  return { attrs: atts, chatroomId: targetId, index };
}
function getConversationTags(index, data) {
  let payload = Proto.lookup('codec.UserConverTags');
  let result = payload.decode(data);
  let { tags } = result;
  tags = utils.map(tags, (tag) => {
    let { tag: id, tagName, tagType, tagOrder } = tag;
    return { id, name: tagName, type: tagType, order: tagOrder || 0 };
  });
  return { tags, index };
}
async function getCreateTagHandler(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.UserConverTags');
  let result = payload.decode(data);
  let { tags } = result;
  return { tags, index };
}
async function getChatroomMsgsHandler(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.SyncChatroomMsgResp');
  let result = payload.decode(data);
  let { msgs } = result;
  let messages = await utils.Defer.all(
    utils.map(msgs, async (msg) => {
      return await tools.msgFormat(msg, { currentUser, io });
    })
  );
  return { messages, index };
}
async function getMessage(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.DownMsg');
  let _msg = payload.decode(data);
  if (!_msg.msgId) {
    return { index, msg: {} };
  }
  let msg = await tools.msgFormat(_msg, { currentUser, io });
  return { index, msg };
}
async function getMessagesHandler(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.DownMsgSet');
  let result = payload.decode(data);

  let { isFinished, msgs, targetUserInfo, groupInfo } = result;
  let messages = await utils.Defer.all(
    utils.map(msgs, async (msg) => {
      // sync_msgs 和 getHistoryMessages 共用此方法，但 sync_msgs 的用户信息携带在消息里，历史消息在 pb 结构外侧与 msgs 同级，此处做兼容处理
      if (targetUserInfo) {
        utils.extend(msg, { targetUserInfo });
      }
      if (groupInfo) {
        utils.extend(msg, { groupInfo });
      }
      let _msg = await tools.msgFormat(msg, { currentUser, io });
      return _msg;
    })
  );
  return { isFinished, messages, index };
}

function getRTCRoom(index, data){
  let payload = Proto.lookup('codec.RtcRoom');
  let result = payload.decode(data);
  return { room: tools.formatRTCRoom(result) };
}

async function getConversationSearch(index, data, { currentUser, io }){
  let payload = Proto.lookup('codec.SearchMsgsResp');
  let result = payload.decode(data);
  let searchResult = await tools.searchConversationFormat(result, { currentUser, io });
  return { searchResult, index };
}

async function getGlobalSearch(index, data, { currentUser, io }){
  let payload = Proto.lookup('codec.QryGlobalSearchResp');
  let result = payload.decode(data);
  let { maxScore, items } = result;
  let list = await utils.Defer.all(
    utils.map(items, async (item) => {
      return await tools.searchConversationFormat(item, { currentUser, io });
    })
  );
  let searchResult = {
    matchCount: maxScore,
    items: list,
  };
  return { searchResult, index };
}
async function getUserStatus(index, data, { currentUser, io }) {
  let payload = Proto.lookup('codec.UserStatusList');
  let result = payload.decode(data);
  let { items } = result;
  items = items || [];
  let users = utils.map(items, (item) => {
    let { userId, onlineStatus } = item;
    onlineStatus = onlineStatus || {};
    let status = onlineStatus.isOnline ? USER_STATUS.ONLINE : USER_STATUS.OFFLINE;
    return { userId, status };
  });
  return { users, index };
}