import { CONVERATION_TYPE, MENTION_TYPE, MESSAGE_TYPE, UNREAD_TAG  } from '../../enum';
import utils from '../../utils';

let isGroup = (type) => {
  return utils.isEqual(CONVERATION_TYPE.GROUP, type);
}

let formatMsg = ({ message, senders, groups }) => {
  let { content = '{}', senderId, conversationType, conversationId, 
        mentionInfo = '{}', isRead, isStream, streams, isSender, 
        isUpdated, referMsg = '{}', mergeMsg = '{}', reactions = '{}', attribute = '' 
      } = message;

  content = utils.parse(content);
  mentionInfo = utils.parse(mentionInfo);
  let sender = utils.filter(senders, (user) => {
    return utils.isEqual(user.id, senderId);
  })[0] || {};
  let target = {};
  if(isGroup(conversationType)){
    target = utils.filter(groups, (group) => {
      return utils.isEqual(group.id, conversationId);
    })[0] || {};
  }else{
    target = utils.filter(senders, (user) => {
      return utils.isEqual(user.id, conversationId);
    })[0] || {};
  }
  if(!streams){
    streams = '[]';
  }
  streams = utils.parse(streams);
  message = utils.extend(message, { 
    mergeMsg: utils.parse(mergeMsg),
    referMsg: utils.parse(referMsg),
    reactions: utils.parse(reactions),
    conversationTitle: target.name,
    conversationPortrait: target.portrait,
    conversationExts: target.exts,
    content, 
    sender,
    mentionInfo,
    streams,
    isStream: Boolean(isStream),
    sentTime: Number(message.sentTime),
    isRead: Boolean(isRead), 
    isSender: Boolean(isSender),
    isUpdated: Boolean(isUpdated),
    attribute,
  });
  return message;
};

let formatMsgs = ({ messages, senders, groups }) => {
  let _messages = utils.map(messages, (message) => {
    let msg = formatMsg({ message, senders, groups });
    return msg;
  });
  return _messages;
};

let formatConversation = ({conversation, users, groups, friends}) => {
  if(utils.isEmpty(conversation)){
    return conversation;
  }
  friends = friends || [];
  let { 
    id,
    type,
    draft,
    unreadCount,
    isTop,
    undisturbType,
    sortTime,
    mentions,
    latestMessageTid,
    latestMessageId,
    latestMessageName,
    latestMessageIsSender,
    latestMessageIsUpdated,
    latestMessageSentTime,
    latestMessageSenderId,
    latestMessageContent,
    latestMessageMessageIndex,
    latestMessageIsRead,
    latestMessageIsMass,
    latestUnreadCount,
    latestReadCount,
    latestReadIndex, 
    latestUnreadIndex,
    latestMentionInfo,
    unreadTag
  } = conversation;

  mentions = mentions || '{}';

  let sender = utils.filter(users, (user) => {
    return utils.isEqual(user.id, latestMessageSenderId);
  })[0] || { id: latestMessageSenderId};

  let target = {
    name: '',
    portrait: '',
    exts: {}
  };
  if(isGroup(type)){
    target = utils.filter(groups, (group) => {
      return utils.isEqual(group.id, id);
    })[0] || target;
  }else{
    target = utils.filter(users, (user) => {
      return utils.isEqual(user.id, id);
    })[0] || target;
  }
  let conversationAlias = target.name;
  if(!isGroup(type)){
    let friend = utils.filter(friends, (friend) => {
      return utils.isEqual(friend.id, id);
    })[0] || { display_name: target.name };
    conversationAlias = friend.display_name;
  }
  unreadCount = unreadCount > 0 ? unreadCount : 0;
  let _conversation = {
    conversationId: id,
    conversationType: type,
    conversationPortrait: target.portrait,
    conversationTitle: target.name,
    conversationExts: target.exts,
    conversationAlias: conversationAlias,
    draft: draft || "",
    isTop: Boolean(isTop),
    undisturbType: undisturbType,
    latestReadIndex: Number(latestReadIndex), 
    latestUnreadIndex: Number(latestUnreadIndex),
    latestMessage: {
      conversationId: id,
      conversationType: type,
      conversationPortrait: target.portrait,
      conversationTitle: target.name,
      conversationExts: target.exts,
      content: utils.parse(latestMessageContent),
      isRead: Boolean(latestMessageIsRead),
      isSender: Boolean(latestMessageIsSender),
      isUpdated: Boolean(latestMessageIsUpdated),
      isMass: Boolean(latestMessageIsMass),
      messageId: latestMessageId,
      tid: latestMessageTid,
      mentionInfo: utils.parse(latestMentionInfo),
      messageIndex: latestMessageMessageIndex,
      name: latestMessageName,
      readCount: Number(latestReadCount || 0),
      unreadCount: Number(latestUnreadCount || 0),
      sentTime: Number(latestMessageSentTime),
      referMsg: {},
      sender: sender,
    },
    sortTime: Number(sortTime) || 0,
    unreadCount: unreadCount || 0,
    mentions: utils.parse(mentions),
    unreadTag: unreadTag || UNREAD_TAG.READ,
  };
  if(utils.isEmpty(latestMessageId)){
    _conversation.latestMessage = {};
  }
  return _conversation;
};
let formatConversations = ({ conversations, users, groups, friends }) => {
  let _converations = utils.map(conversations, (conversation) => {
    let _converation = formatConversation({ conversation, users, groups, friends });
    return _converation;
  });
  return _converations;
};
let createMentions = (mentions, message, user) => {
  let { mentionInfo } = message;

  let { senders = [], msgs = [] } = mentions;
  if(utils.isEqual(message.name, MESSAGE_TYPE.RECALL_INFO)){
    let { content: { messageId }, sender } = message;
    let msgIndex = utils.find(msgs, (msg) => {
      return utils.isEqual(msg.messageId, messageId)
    });
    if(msgIndex > -1){
      msgs.splice(msgIndex, 1);
    }

    // 如果没有消息撤回发送人的消息，移除 senders 中的发送人信息
    let isIncludeSender = utils.find(msgs, (msg) => { return utils.isEqual(msg.senderId, sender.id) }) > -1;
    if(!isIncludeSender){
      let senderIndex = utils.find(senders, (member) => {
        return utils.isEqual(message.sender.id, member.id);
      });
      if(!utils.isEqual(senderIndex, -1)){
        senders.splice(senderIndex, 1);
      }
    }

    let count = msgs.length;
    return {
      isMentioned: count > 0,
      senders,
      msgs,
      count: count
    };
  }

  if(utils.isEqual(message.name, MESSAGE_TYPE.CLIENT_REMOVE_MSGS)){
    let { content: { messages }, sender } = message;
    let senderIds = {};
    utils.forEach(messages, ({ messageId }) => {
      let msgIndex = utils.find(msgs, (msg) => {
        let isSame = utils.isEqual(msg.messageId, messageId);
        if(isSame){
          senderIds[msg.senderId] = msg.senderId;
        }
        return isSame;
      });
      if(msgIndex > -1){
        msgs.splice(msgIndex, 1);
      }
    })
    
    utils.forEach(senderIds, (senderId) => {
      let isIncludeSender = utils.find(msgs, (msg) => { return utils.isEqual(msg.senderId, senderId) }) > -1;
      if(!isIncludeSender){
        let senderIndex = utils.find(senders, (member) => {
          return utils.isEqual(senderId, member.id);
        });
        if(!utils.isEqual(senderIndex, -1)){
          senders.splice(senderIndex, 1);
        }
      }
    });

    let count = msgs.length;
    return {
      isMentioned: count > 0,
      senders,
      msgs,
      count: count
    };
  }

  if(utils.isEmpty(mentionInfo)){
    return mentions;
  }

  let { members, mentionType } = mentionInfo;
  let index = utils.find(members, (member) => {
    return utils.isEqual(user.id, member.id);
  });

  if(index > -1 || utils.isEqual(mentionType, MENTION_TYPE.ALL)){
    msgs.push({ senderId: message.sender.id, messageId: message.messageId, sentTime: message.sentTime, mentionType });

    let senderIndex = utils.find(senders, (member) => {
      return utils.isEqual(message.sender.id, member.id);
    });
    if(utils.isEqual(senderIndex, -1)){
      senders.push(message.sender);
    }
  }
  let count = msgs.length;
  return {
    isMentioned: count > 0,
    senders,
    msgs,
    count: count
  };
}

function isNestInclude(sources, targets, callback){
  let isOK = false;
  for (var i = 0; i < sources.length; i++) {
    for (var j = 0; j < targets.length; j++) {
      isOK = callback(sources[i], targets[j]);
      if(isOK){
        break;
      }
    }
  }
  return isOK;
}
function hasUncompletedStream(messages){
  let isInclude = false;
  for (var i = 0; i < messages.length; i++) {
    let message = messages[i];
    let { isStream, streams } = message;
    isStream = !!isStream;
    if(!streams){
      streams = '[]';
    }
    streams = utils.parse(streams);
    if(isStream && utils.isEqual(streams.length, 0)){
      isInclude = true;
      break;
    }
  }
  return isInclude;
}
export default {
  isGroup,
  formatMsg,
  formatMsgs,
  formatConversations,
  formatConversation,
  createMentions,
  isNestInclude,
  hasUncompletedStream,
};