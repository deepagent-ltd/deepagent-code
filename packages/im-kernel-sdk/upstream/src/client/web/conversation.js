import { CONVERSATION_TOP_TYPE, CONVERSATION_TAG, FUNC_PARAM_CHECKER, ErrorType, SIGNAL_CMD, COMMAND_TOPICS, SIGNAL_NAME, EVENT, MESSAGE_ORDER, CONNECT_STATE, MESSAGE_TYPE, MENTION_TYPE, UNDISTURB_TYPE, CONVERSATION_ORDER } from "../../enum";
import utils from "../../utils";
import common from "../../common/common";
import Storage from "../../common/storage";
import tools from "../desktop/tools";
export default function(io, emitter){
  /*  
  1、内存中缓存最近 200 个会话，并按 message.sentTime 倒序排序
  2、startTime 是 0 时，优先返回内存中会话，内存数量小于 count 数，从服务端获取
  3、startTime 非 0 是，直接从服务端获取，并更新到内存中
  */
  let conversationUtils = common.ConversationUtils();

  io.on(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, (message) => {
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_MSG_EXSET)){
      return;
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_DELETE_MSGS)){
      let { content: { messages } } = message;
      return io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, { ...message, name: MESSAGE_TYPE.CLIENT_REMOVE_MSGS });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_ADD_CONVERSATION_TO_TAG)){
      let { content: { id, name, conversations } } = message;
      return emitter.emit(EVENT.TAG_CONVERSATION_ADDED, { id, conversations });
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_REMOVE)){
      let { content: { tags } } = message;
      return emitter.emit(EVENT.TAG_REMOVED, {  
        tags: tags
      });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_CREATE)){
      let { content: { tags } } = message;
      let addTagList = [];
      let updateTagList =  [];
      utils.forEach(tags, (tag) => {
        let _tag = { id: tag.tag, name: tag.tag_name || '', conversations: tag.conversations || [], order: tag.tag_order || 0 };
        if(tag.is_add){
          addTagList.push(_tag);
        }else{
          updateTagList.push(_tag);
        }
      });
      if(!utils.isEmpty(addTagList)){
        return emitter.emit(EVENT.TAG_CREATED, {  
          tags: addTagList
        });
      }
      if(!utils.isEmpty(updateTagList)){
        return emitter.emit(EVENT.TAG_CHANGED, {  
          tags: updateTagList
        });
      }
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_REMOVE_CONVERS_FROM_TAG)){
      let { content: { id, conversations } } = message;
      return emitter.emit(EVENT.TAG_CONVERSATION_REMOVED, { id, conversations });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_ADD_CONVER)){
      let { content: _conversation } = message;
      conversationUtils.update(_conversation);
      let newConversation = conversationUtils.getPer(_conversation);
      return emitter.emit(EVENT.CONVERSATION_ADDED, { conversations: utils.clone([newConversation]) });
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CLEAR_TOTALUNREAD)){
      let { content: { clearTime } } = message;
      let conversations = conversationUtils.get();
      let currentUser = io.getCurrentUser();
      conversationUtils.read(conversations, currentUser.mentionClearType);
      return emitter.emit(EVENT.CLEAR_TOTAL_UNREADCOUNT, { clearTime });
    }
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_REMOVE_CONVERS)){
      let { content: { conversations } } = message;
      let list = [];
      utils.forEach(conversations, (item) => {
        let _item = conversationUtils.remove(item);
        list.push(_item);
      });
      return emitter.emit(EVENT.CONVERSATION_REMOVED, { conversations: list });
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_TOPCONVERS)){
      let { content: { conversations } } = message;
      let item = conversations[0] || { isTop: false }
      let list = conversationUtils.modify(conversations, { isTop: item.isTop });
      emitter.emit(EVENT.CONVERSATION_TOP, { conversations });
      return emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: list });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_UNDISTURB)){
      let { content: { conversations } } = message;
      let item = conversations[0] || { undisturbType: UNDISTURB_TYPE.UNDISTURB }
      let list = conversationUtils.modify(conversations, { undisturbType: item.undisturbType });
      emitter.emit(EVENT.CONVERSATION_UNDISTURBED, { conversations });
      return emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: list });
    }

    // 如果会话最后一条消息大于清理的时间，不更新会话列表
    if(utils.isEqual(message.name, MESSAGE_TYPE.CLEAR_MSG)){
      let { content: { cleanTime, conversationType, conversationId, senderId  } } = message;
      let params = { conversationType, conversationId };
      let conversation = conversationUtils.getPer(params) || params;
      let { latestMessage } = conversation || { };
      latestMessage = latestMessage || { sender: { id: '' } }; 
  
      if(cleanTime >= latestMessage.sentTime){
        if(!utils.isEmpty(senderId) && !utils.isEqual(senderId, latestMessage.sender.id)){
          return;
        }
        conversation.latestMessage = {};
        emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: [conversation] });
      }
      return;
    }
    if(utils.isEqual(MESSAGE_TYPE.CLIENT_REMOVE_MSGS, message.name)){
      let { content: { messages } } = message;
      if(utils.isEmpty(messages)){
        return;
      }
      let msg = messages[0];
      let conversation = conversationUtils.getPer(msg);
      if(utils.isEmpty(conversation)){
        conversation = { latestMessage: { tid: '' } };
      }
      let tids = utils.map(messages, (item) => {
        return item.tid;
      });
      let { latestMessage } = conversation;
      // 只有会话最后一条消息被删除时触发会话列表变更或这删除的消息 @ 消息

      let mentions = conversation.mentions || {};
      let mentionMsgs = mentions.msgs || [];
      
      let isIncludeMsg = tools.isNestInclude(mentionMsgs, messages, (mentionMsg, msg) => {
        return utils.isEqual(mentionMsg.messageId, msg.tid);
      });
      let isLastMsg = utils.isInclude(tids, latestMessage.tid);

      if(isLastMsg || isIncludeMsg){
        let _conversation = conversationUtils.getPer(message);
        let _mentions = _conversation.mentions || {};
        let current = io.getCurrentUser();
        _mentions = tools.createMentions(_mentions, message, current);

        let props = { mentions: _mentions };
        if(isLastMsg){
          utils.extend(props, { latestMessage: {} });
        }
        let list = conversationUtils.modify(_conversation, props);
        emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: utils.clone(list) });
      }
      return;
    }
    // 如果会话最后一条消息和被撤回消息不匹配，不更新会话列表
    if(utils.isEqual(message.name, MESSAGE_TYPE.RECALL)){
      let { content: { messageId } } = message;
      let conversation = conversationUtils.getPer(message);
      let { latestMessage, mentions } = conversation || { };
      latestMessage = latestMessage || {}; 

      let isLastMsg = utils.isEqual(latestMessage.messageId, messageId);
      mentions = mentions || {};
      let _msgs = mentions.msgs || [];
      let msgIndex = utils.find(_msgs, (msg) => {
        return utils.isEqual(msg.messageId, messageId);
      });

      if(!isLastMsg && utils.isEqual(msgIndex, -1)){
        return;
      }
      
      // 对外模拟 recallinfo 消息
      message = utils.extend(message, { name: MESSAGE_TYPE.RECALL_INFO });
    }
    if(utils.isInclude([MESSAGE_TYPE.READ_MSG, MESSAGE_TYPE.READ_GROUP_MSG], message.name)){
      return;
    }
    if(utils.isEqual(message.name, MESSAGE_TYPE.CLEAR_UNREAD)){
      let { content } = message;
      let { conversations } = content;
      let currentUser = io.getCurrentUser();
      let list = conversationUtils.read(conversations, currentUser.mentionClearType);
      emitter.emit(EVENT.CONVERSATION_CLEARUNREAD, { conversations });
      if(!utils.isEmpty(list)){
        emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: list });
      }
      return;
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_MARK_UNREAD)){
      let { content: { conversations } } = message;
      let list = conversationUtils.modify(conversations);
      return emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: list });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.MODIFY)){
      let conversation = conversationUtils.getPer(message);
      let { latestMessage } = conversation || {};
      latestMessage = latestMessage || {}; 
      // 如果会话最后一条消息和被修改消息不匹配，不更新会话列表
      if(!utils.isEqual(latestMessage.messageId, message.messageId)){
        return;
      }
      utils.extend(message, { name: latestMessage.name, isUpdated: true });
    }

    let msgFlag = common.formatter.toMsg(message.flags) || {};
    if(!msgFlag.isStorage){
      return;
    }

    next(message);

    function next(message){
      let conversation = createConversation(message);
      if(conversationUtils.isExisted(conversation)){
        conversationUtils.update(conversation);
        let updateConversation = conversationUtils.getPer(conversation);
        return emitter.emit(EVENT.CONVERSATION_CHANGED, { conversations: utils.clone([updateConversation]) });
      }

      conversationUtils.update([conversation]);
      let newConversation = conversationUtils.getPer(conversation);
      emitter.emit(EVENT.CONVERSATION_ADDED, { conversations: utils.clone([newConversation]) });
    }
  });

  io.on(SIGNAL_NAME.CLIENT_CLEAR_MEMORY_CACHE, () => {
    conversationUtils.clear();
  });

  let commandNotify = (msg) => {
    let config = io.getConfig();
    if(!config.isPC){
      io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
    }
  };

  let getConversations = (params = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, []);
      if(!utils.isEmpty(error)){
        return reject(error);
      }

      let { count = 50, time = 0, conversationType, order = CONVERSATION_ORDER.FORWARD } = params;
      order = utils.isEqual(order, CONVERSATION_ORDER.FORWARD) ? CONVERSATION_ORDER.FORWARD : CONVERSATION_ORDER.BACKWARD;

      let user = io.getCurrentUser();
      let _params = { topic: COMMAND_TOPICS.CONVERSATIONS, time: 0, count, order, userId: user.id, conversationType };
      utils.extend(_params, params);
      io.sendCommand(SIGNAL_CMD.QUERY, _params, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        if(!utils.isUndefined(conversationType)){
          let list = utils.map(result.conversations, (item) => {
            let { unreadCount } = item;
            item.unreadCount = unreadCount < 0 ? 0 : unreadCount;
            return item;
          });
          return resolve(utils.clone({ conversations: list.reverse(), isFinished: result.isFinished }));
        }
        let { conversations } = result;
        conversationUtils.setSynced();
        conversationUtils.add(conversations);
        resolve({ conversations: utils.clone(conversations), isFinished: result.isFinished });
      });
    });
  };

  let getPublicConversations = (params = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, []);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { count = 50, time = 0, conversationType, order = CONVERSATION_ORDER.FORWARD } = params;
      order = utils.isEqual(order, CONVERSATION_ORDER.FORWARD) ? CONVERSATION_ORDER.FORWARD : CONVERSATION_ORDER.BACKWARD;
      let user = io.getCurrentUser();
      let _params = { topic: COMMAND_TOPICS.PUBLIC_CONVERSATIONS, time: 0, count, order, userId: user.id, conversationType };
      utils.extend(_params, params);
      io.sendCommand(SIGNAL_CMD.QUERY, _params, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        let { conversations, isFinished } = result;
        resolve({ conversations: utils.clone(conversations), isFinished: isFinished });
      });
    });
  };

  let removeConversation = (conversations) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversations, FUNC_PARAM_CHECKER.REMOVECONVERSATION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.REMOVE_CONVERSATION, conversations, userId: user.id };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let list = utils.isArray(conversations) ? conversations : [conversations];
        let config = io.getConfig();
        let { timestamp, code } = result;
        if (code !== ErrorType.COMMAND_SUCCESS.code) return reject(common.getError(code));
        list = utils.map(list, (item) => {
          item.time = timestamp;
          return item;
        });
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
        }
        if(!config.isPC){
          let msg = { name: MESSAGE_TYPE.COMMAND_REMOVE_CONVERS, content: { conversations: list } };
          io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
        }
        resolve();
      });
    });
  };
  let insertConversation = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.INSERTCONVERSATION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.INSERT_CONVERSATION, conversation, userId: user.id };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, msg, timestamp }) => {
        if(code){
          return reject({ code, msg })
        }
        common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
        let item = createConversation({
          ...conversation,
          sentTime: Date.now()
        });
        conversationUtils.update(item);
        let newConversation = conversationUtils.getPer(item);
        resolve({ conversation: newConversation });
      });
    });
  };
  let getConversation = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_CONVERSATION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.GET_CONVERSATION, conversation, userId: user.id };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, msg, conversation }) => {
        if(code){
          return reject({ code, msg })
        }
        if(!utils.isEmpty(conversation)){
          conversationUtils.update(conversation);
        }
        resolve({ conversation });
      });
    });
  };
 
  let disturbConversation = (conversations) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversations, FUNC_PARAM_CHECKER.MUTE_CONVERSATION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.MUTE_CONVERSATION, conversations, userId: user.id };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, msg, timestamp }) => {
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({ code, msg })
        }
        common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
        let config = io.getConfig();
        if(!config.isPC){
          let list = utils.isArray(conversations) ? conversations : [conversations];
          let msg = { name: MESSAGE_TYPE.COMMAND_UNDISTURB, content: { conversations: list } };
          io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
        }
        resolve();
      });
    });
  };
  let setTopConversation = (conversations) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversations, FUNC_PARAM_CHECKER.SET_TOP_CONVERSATION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      conversations = utils.isArray(conversations) ? conversations : [conversations];

      let data = { topic: COMMAND_TOPICS.TOP_CONVERSATION, conversations, userId: user.id };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, msg, timestamp }) => {
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({ code, msg })
        }
        common.updateSyncTime({ isSender: true,  sentTime: timestamp, io }); 
        let config = io.getConfig();
        if(!config.isPC){
          let msg = { name: MESSAGE_TYPE.COMMAND_TOPCONVERS, content: { conversations: conversations } };
          io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
        }
        resolve();
      });
    });
  };

  let getTopConversations = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, []);
      if(!utils.isEmpty(error)){
        return reject(error);
      }

      params = params || {};
      let { count = 50, time = 0 } = params;
      let user = io.getCurrentUser();
      let _params = { topic: COMMAND_TOPICS.QUERY_TOP_CONVERSATIONS, time: 0, count, userId: user.id };
      utils.extend(_params, params);
      io.sendCommand(SIGNAL_CMD.QUERY, _params, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ conversations: result.conversations, isFinished: result.isFinished });
      });
    });
  };
  let clearUnreadcount = ( conversations ) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversations, FUNC_PARAM_CHECKER.CLEARUNREADCOUNT);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.CLEAR_UNREAD };
      utils.extend(data, { conversations, userId: user.id });
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code } = result;
        if (code !== ErrorType.COMMAND_SUCCESS.code) return reject(common.getError(code));
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
        }
        let config = io.getConfig();
        if(!config.isPC){
          let msg = { name: MESSAGE_TYPE.CLEAR_UNREAD, content: { conversations } };
          io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
        }
        resolve();
      });
    });
  };
  let getTotalUnreadcount = (params = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, {});
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { conversationTypes = [], ignoreConversations, tag } = params;
      conversationTypes = utils.isArray(conversationTypes) ? conversationTypes : [conversationTypes];
      if(!utils.isEmpty(ignoreConversations)){
        let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_TOTAL_UNREADCOUNT);
        if(!utils.isEmpty(error)){
          return reject(error);
        }
      }
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.GET_UNREAD_TOTLAL_CONVERSATION, userId, conversationTypes, ignoreConversations, tag };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ count, code }) => {
        if (code !== ErrorType.COMMAND_SUCCESS.code) return reject(common.getError(code));
        count = count || 0;
        resolve({ count });
      });
    });
  };
  let clearTotalUnreadcount = () => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, {});
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.CLEAR_UNREAD_TOTLAL_CONVERSATION, userId };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code }) => {
        if (code !== ErrorType.COMMAND_SUCCESS.code) return reject(common.getError(code));
        let conversations = conversationUtils.get();
        let currentUser = io.getCurrentUser();
        conversationUtils.read(conversations, currentUser.mentionClearType);
        resolve();
      });
    });
  };

  let setDraft = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.SET_DRAFT);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let key = common.getDraftKey(conversation);
      let { draft } = conversation;
      Storage.set(key, draft);
      resolve();
    });
  };
  let getDraft = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_DRAFT);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let key = common.getDraftKey(conversation);
      let draft = Storage.get(key);
      resolve(draft);
    });
  };
  let removeDraft = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_DRAFT);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let key = common.getDraftKey(conversation);
      let draft = Storage.remove(key);
      resolve(draft);
    });
  };

  function createConversation(message){
    let { conversationId, conversationType, conversationTitle, conversationPortrait, conversationExts, mentionInfo, messageId } = message;

    let $conversation = {
      conversationId,
      conversationType,
      conversationTitle, 
      conversationPortrait,
      conversationExts,
      latestMessage: message,
      unreadCount: 0,
      updatedTime: 0,
      undisturbType: message.undisturbType
    };
    let _conversation = conversationUtils.getPer(message);
    let mentions = _conversation.mentions || {};
    let user = io.getCurrentUser();
    mentions = tools.createMentions(mentions, message, user);

    if(message.isSender){
      let conversation = conversationUtils.getPer(message);
      utils.extend($conversation, {
        conversationTitle: conversation.conversationTitle,
        conversationPortrait: conversation.conversationPortrait,
        conversationExts: conversation.conversationExts,
      });
    }
    utils.extend($conversation, { mentions });
    return $conversation;
  }

  /* 
    let params = {
      type: UNDISTURB_TYPE.DISTURB,
      timezone: 'Asia/Shanghai',
      times: [
        { start: 'HH:mm', end: 'HH:mm' }
      ]
    };
  */
  let setAllDisturb = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.SET_ALL_DISTURB);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { code } = ErrorType.ILLEGAL_TYPE_PARAMS;
      let _params = { timezone: '', times: [] };
      
      let { type, timezone, times } = params;
      let isDisturb = utils.isEqual(type, UNDISTURB_TYPE.DISTURB);
      if(isDisturb && !utils.isString(timezone)){
        let msg = 'timezone 参数不合法，请检查，格式示例：Asia/Shanghai';
        return reject({ msg, code });
      }

      if(isDisturb && !utils.isArray(times)){
        let msg = "times 参数不合法，请检查，格式示例：[{ start: '12:00', end: '13:00' }]";
        return reject({ msg, code });
      }

      let isValid = true;
      let timeIndex = 0;
      times = times || [];
      for(let i = 0; i < times.length; i++){
        let time = times[i];
        if(!utils.isObject(time)){
          isValid = false;
          timeIndex = i;
          break;
        }
        let { start, end } = time;
        if(!utils.isValidHMTime(start) || !utils.isValidHMTime(end)){
          isValid = false;
          timeIndex = i;
          break;
        }
      }
      if(!isValid){
        let msg = `times 下标 ${timeIndex} 参数，时间格式不正确`
        return reject({ msg, code });
      }

      _params = utils.extend(_params, params);
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.SET_ALL_DISTURB, userId, ..._params };
      io.sendCommand(SIGNAL_CMD.QUERY, data, () => {
        resolve();
      });
    });
  };
  let getAllDisturb = () => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, {});
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.GET_ALL_DISTURB, userId };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timezone, times, type, code } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({ code, msg: '' });
        }
        resolve({ timezone, times, type });
      });
    });
  };

  let markUnread = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.MARK_UNREAD);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      conversation = utils.clone(conversation);
      let { id: userId } = io.getCurrentUser();
      let conversations = utils.isArray(conversation) ? conversation : [conversation];
      let data = { topic: COMMAND_TOPICS.MARK_CONVERSATION_UNREAD, userId, conversations };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
          let config = io.getConfig();
          if(!config.isPC){
            let msg = { name: MESSAGE_TYPE.COMMAND_MARK_UNREAD, content: { conversations } };
            io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, msg);
          }
          resolve();
        }else{
          let error = common.getError(code);
          reject(error);
        }        
      });
    });
  };

  let createConversationTag = (tag) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, tag, FUNC_PARAM_CHECKER.CREATE_CONVERSATION_TAG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let _tag = utils.clone(tag);
      let _tags = utils.isArray(_tag) ? _tag : [_tag];
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.TAG_CREATE, userId, tag: _tags };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code, tags } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
          let notifyTags = [];
          utils.forEach(_tags, (_tag) => {
            let index = utils.find(tags, (ackTag) => { return utils.isEqual(_tag.id, ackTag.tag)});
            let isAdd = false;
            if(index > -1){
              isAdd = tags[index].isAdd;
            }
            notifyTags.push({ tag: _tag.id, tag_name: _tag.name, conversations: [], tag_order: _tag.order || 0, is_add: isAdd });
          });
          let notify = {
            name: MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_CREATE,
            content: { tags: notifyTags },
          };
          commandNotify(notify);
          resolve(result);
        }else{
          let errorInfo = common.getError(code);
          reject(errorInfo);
        }        
      });
    });
  };

  let destroyConversationTag = (tag) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, tag, FUNC_PARAM_CHECKER.REMOVE_CONVERSATION_TAG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let _tag = utils.clone(tag);
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.TAG_REMOVE, userId, tag: _tag };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
          let tags = utils.isArray(tag) ? tag : [tag];
          let notify = {
            name: MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_REMOVE,
            content: { tags }
          };
          commandNotify(notify);
          resolve();
        }else{
          let errorInfo = common.getError(code);
          reject(errorInfo);
        }        
      });
    });
  };

  let getConversationTags = () => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, {});
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.TAG_QUERY, userId };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code, tags } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          let _tags = utils.map(tags, (tag) => {
            let item = CONVERSATION_TAG[tag.id] || {};
            utils.extend(tag, item);
            return tag;
          })
          resolve({ tags: _tags });
        }else{
          let error = common.getError(code);
          reject(error);
        }
      });
    });
  };
  
  let addConversationsToTag = (tag) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, tag, FUNC_PARAM_CHECKER.ADD_CONVERSATION_TO_TAG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let _tag = utils.clone(tag);
      let { id: userId } = io.getCurrentUser();
      let conversations = utils.map(_tag.conversations, (conversation) => {
        return { conversationId: conversation.conversationId, conversationType: conversation.conversationType };
      });
      _tag = utils.extend(_tag, { conversations });
      let data = { topic: COMMAND_TOPICS.CONVERSATION_TAG_ADD, userId, tag: _tag };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
          let notify = {
            name: MESSAGE_TYPE.COMMAND_ADD_CONVERSATION_TO_TAG,
            content: { id: tag.id, conversations: conversations },
          };
          commandNotify(notify);
          resolve();
        }else{
          let error = common.getError(code);
          reject(error);
        }        
      });
    });
  };

  let removeConversationsFromTag = (tag) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, tag, FUNC_PARAM_CHECKER.REMOVE_CONVERSATION_FROM_TAG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let _tag = utils.clone(tag);
      let conversations = utils.map(_tag.conversations, (conversation) => {
        return { conversationId: conversation.conversationId, conversationType: conversation.conversationType };
      });
      _tag = utils.extend(_tag, { conversations });
      
      let { id: userId } = io.getCurrentUser();
      let data = { topic: COMMAND_TOPICS.CONVERSATION_TAG_REMOVE, userId, tag: _tag };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { timestamp, code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });
          let notify = {
            name: MESSAGE_TYPE.COMMAND_REMOVE_CONVERS_FROM_TAG,
            content: { id: tag.id, conversations: conversations },
          };
          commandNotify(notify);
          resolve();
        }else{
          let error = common.getError(code);
          reject(error);
        }        
      });
    });
  };

  return {
    getConversations,
    removeConversation,
    insertConversation,
    getConversation,
    markUnread,
    disturbConversation,
    setTopConversation,
    getTopConversations,
    clearUnreadcount,
    getTotalUnreadcount,
    clearTotalUnreadcount,
    setDraft,
    getDraft,
    removeDraft,
    setAllDisturb,
    getAllDisturb,
    createConversationTag,
    destroyConversationTag,
    getConversationTags,

    addConversationsToTag,
    removeConversationsFromTag,
    getPublicConversations
  };
}
