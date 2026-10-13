import { 
  MESSAGE_SENT_STATE, SIGNAL_CMD, 
  EVENT, SIGNAL_NAME, FUNC_PARAM_CHECKER, MESSAGE_ORDER, COMMAND_TOPICS, CONVERATION_TYPE, 
  ErrorType, MENTION_ORDER, UPLOAD_TYPE, FILE_TYPE, MESSAGE_TYPE,
  LOG_MODULE, MSG_TOP_ACTION_TYPE,
  USER_STATUS
} from "../../enum";
import utils from "../../utils";
import common from "../../common/common";
import Uploder from "../../common/uploader";
import MessageCacher from "../../common/msg-cacher";
import chatroomCacher from "../../common/chatroom-cacher";
import streamStorge from "../../common/stream-storge";

import { decimal, time, text } from "../../delivery/contract";

export default function(io, emitter, logger){
  let messageCacher = MessageCacher();

  io.on(SIGNAL_NAME.CMD_RECEIVED, (message, isPullFinished = true) => {

    logger.info({ tag: LOG_MODULE.MSG_RECEIVE, messageId: message.messageId });

    let isChatroom = utils.isEqual(message.conversationType, CONVERATION_TYPE.CHATROOM);
    if(isChatroom){
      let _chatroomResult = chatroomCacher.get(message.conversationId);
      return _chatroomResult.isJoined && emitter.emit(EVENT.MESSAGE_RECEIVED, [message, true]);
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_LOG_REPORT)){
      let { content, messageId } = message;
      if(utils.isEqual('Web', content.platform)){
        return common.reportLogs({ logger, params: { ...content, messageId } });
      }
      return;
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_STATUS_CHANGED)){
      let { content: { is_online }, sender } = message;
      let userId = sender.id;
      let status = is_online ? USER_STATUS.ONLINE : USER_STATUS.OFFLINE;
      return emitter.emit(EVENT.USER_STATUS_CHANGED, { userId, status });
    }
    if(utils.isEqual(message.name, MESSAGE_TYPE.MODIFY)){
      let { conversationType, conversationId, content: { content, messageId, sentTime, name } } = message;
      let newContent = content;
      if(utils.isBase64(content)){
        let str = utils.decodeBase64(content);
        newContent = utils.parse(str);
      }
      return emitter.emit(EVENT.MESSAGE_UPDATED, { conversationType, conversationId, messageId, content: newContent, name });
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_MSG_SET_TOP)){
      let { conversationType, conversationId, content: { msg_id, action = 0 }, sender, sentTime } = message;
      let isTop = utils.isEqual(MSG_TOP_ACTION_TYPE.ADD, action);
      return emitter.emit(EVENT.MESSAGE_SET_TOP, { isTop, message: { conversationType, conversationId, messageId: msg_id }, operator: sender, createdTime: sentTime });
    }

    // if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_RTC_1V1_FINISHED)){
    //   return emitter.emit(EVENT.RTC_FINISHED_1V1_EVENT, message);
    // }

    // 收到 非聊天室消息和状态消息 一定要更新会话列表
    if(!message.isStatus){
      io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, utils.clone(message));
    }
    

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_ADD_CONVERSATION_TO_TAG)){
      return;
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_REMOVE)){
      return;
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CONVERSATION_TAG_CREATE)){
      return;
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_REMOVE_CONVERS_FROM_TAG)){
      return;
    }
    
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_DELETE_MSGS)){
      let { content: { conversationId, conversationType, messages } } = message;
      return emitter.emit(EVENT.MESSAGE_REMOVED, { conversationId, conversationType, messages });
    }
    
    // 消息监听无需处理标记未读消息
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_MARK_UNREAD)){
      return;
    }
    // 消息监听无需处理清理总数消息
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_CLEAR_TOTALUNREAD)){
      return;
    }
    // 消息监听无需处理会话添加
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_ADD_CONVER)){
      return;
    }
    // 消息监听无需处理会话删除
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_REMOVE_CONVERS)){
      return;
    }
    // 消息监听无需处理会话置顶
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_TOPCONVERS)){
      return;
    }
    // 消息监听无需处理免打扰
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_UNDISTURB)){
      return;
    }
    //清理未读同步，只变更会话列表
    if(utils.isEqual(message.name, MESSAGE_TYPE.CLEAR_UNREAD)){
      return;
    }
    if(utils.isEqual(message.name, MESSAGE_TYPE.RECALL)){
      let { conversationId, conversationType, content, sender } = message;
      return emitter.emit(EVENT.MESSAGE_RECALLED, { conversationId, conversationType, content, sender });
    }
  
    if(utils.isEqual(message.name, MESSAGE_TYPE.COMMAND_MSG_EXSET)){
      let { content } = message;
      return emitter.emit(EVENT.MESSAGE_REACTION_CHANGED, { ...content });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.CLEAR_MSG)){
      let { content: {  conversationType, conversationId, cleanTime, senderId } } = message;
      if(!utils.isEmpty(senderId)){
        return emitter.emit(EVENT.MESSAGE_CLEAN_SOMEONE, { conversationType, conversationId, senderId });
      }
      return emitter.emit(EVENT.MESSAGE_CLEAN, { conversationType, conversationId, cleanTime });
    }

    if(utils.isEqual(message.name, MESSAGE_TYPE.READ_MSG) || utils.isEqual(message.name, MESSAGE_TYPE.READ_GROUP_MSG)){
      let { conversationType, conversationId, content: { msgs }, sender, isSender, sentTime } = message;
      let notify = {
        conversationType, 
        conversationId, 
        messages: msgs,
        senderId: sender.id,
        isSender,
        readTime: sentTime
      };
      return emitter.emit(EVENT.MESSAGE_READ, notify);
    }
    if(utils.isEqual(MESSAGE_TYPE.STREAM_TEXT, message.name)){
      let { content, is_finished } = message.content;
      let { messageId } = message;
      if(!is_finished){
        streamStorge.add(messageId, { content, seq: 1 });
      }
      message.content = utils.rename(message.content, { is_finished: 'isFinished', stream_id: 'streamId'})
    }
    if(utils.isEqual(message.name, MESSAGE_TYPE.STREAM_APPEND)){
      let { content, seq, stream_id, is_finished } = message.content;
      let contentList = streamStorge.get(stream_id);
      if(utils.isEmpty(contentList)){
        return;
      }
      if(is_finished){
        streamStorge.remove(stream_id);
        emitter.emit(EVENT.STREAM_COMPLETED, {
          messageId: stream_id,
          content: content,
        });
      }else{
        emitter.emit(EVENT.STREAM_APPENDED, {
          messageId: stream_id,
          content: content,
          seq: seq,
        });
        streamStorge.add(stream_id, {
          content, seq
        });
      }
      return;
    }
    if(!messageCacher.isInclude(message)){
      emitter.emit(EVENT.MESSAGE_RECEIVED, [message, isPullFinished]);
      let { conversationId, conversationType } = message;
      messageCacher.add({ conversationId, conversationType }, message);
    }
  });


  let commandNotify = (msg) => {
    let config = io.getConfig();
    if(!config.isPC){
      io.emit(SIGNAL_NAME.CMD_RECEIVED, msg);
    }
  };

  let maps = [
    [CONVERATION_TYPE.PRIVATE, 'p_msg'],
    [CONVERATION_TYPE.GROUP, 'g_msg'],
    [CONVERATION_TYPE.CHATROOM, 'c_msg'],
  ];
  let topics = {};
  utils.forEach(maps, (map) => {
    topics[map[0]] = map[1];
  });

  /*
    缓存发送的消息，同样的 tid 重复发送消息返回错误，不再调用 socket send 方法，规避消息重复发送
    sendingMsgMap[tid] = true;  
  */ 
  let sendingMsgMap = {};

    /*
    缓存发送失败的 clientMsgId，防止未收到 ACK，重发导致接收端消息重复
    sendMsgMap[tid] = uuid;  
  */ 
  let sendMsgMap = {};
  let sendMessage = (message, callbacks = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SENDMSG, true);
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      let { lifeTime, lifeTimeAfterRead } = message;
      if(utils.isNumber(lifeTime) && lifeTime < 0){
        return reject({ error: ErrorType.MESSAGE_LIFETIME_ERROR });  
      }
      if(utils.isNumber(lifeTimeAfterRead) && lifeTimeAfterRead < 0){
        return reject({ error: ErrorType.MESSAGE_LIFETIME_AFTER_READ_ERROR });  
      }
      let { referMsg } = message;
      if(!utils.isUndefined(referMsg)){
        let { messageIndex, messageId } = referMsg;
        if(utils.isUndefined(messageIndex) || utils.isUndefined(messageId) ){
          return reject({ error: ErrorType.SEND_REFER_MESSAGE_ERROR });
        }
      }
      let sender = io.getCurrentUser() || {};
      let isSending = sendingMsgMap[message.tid];
      if(isSending){
        return reject({ ...message, sender, error: ErrorType.MESSAGE_SEND_REPETITION });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND });
      let _callbacks = {
        onbefore: () => {}
      };
      utils.extend(_callbacks, callbacks);
      
      let tid = message.tid || utils.getUUID();
      let clientMsgId = message.clientMsgId || sendMsgMap[tid] || utils.getUUID();
      sendMsgMap[tid] = clientMsgId;

      sendingMsgMap[tid] = true;

      let data = utils.clone({...message, clientMsgId });
      let { name, conversationType, conversationId, isMass } = data;

      let flag = common.getMsgFlag(name, { isMass });
      utils.extend(data, { flag });

      let topic = topics[conversationType];
      utils.extend(data, { topic })

      utils.extend(message, { tid, sentState: MESSAGE_SENT_STATE.SENDING, sender, isSender: true });
      _callbacks.onbefore(utils.clone(message));

      if(!io.isConnected()){
        delete sendingMsgMap[tid];
        return reject({ ...message, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.CONNECTION_NOT_READY });
      }
      io.sendCommand(SIGNAL_CMD.PUBLISH, data, ({ messageId, sentTime, code, msg, msgIndex, memberCount, modifiedMsg, deliveryVersion, deliveryExpiresAt, deliveryRequestHash, deliverySequence, deliveryError }) => {
        if (message.deliveryVersion === 1 && code === 0 && (deliveryVersion !== 1 || deliveryExpiresAt !== message.deliveryExpiresAt || deliveryRequestHash !== message.deliveryRequestHash || !text(messageId, 2048) || !time(sentTime, true) || !decimal(deliverySequence, true))) {
          code = 30001; msg = "durable acceptance unknown";
        }
        // 不管消息发送成功或失败，清理 tid 发送中的状态
        delete sendingMsgMap[tid];
        if(code){
          utils.extend(message, { error: deliveryError || { code, msg }, sentState: MESSAGE_SENT_STATE.FAILED });
          return reject(utils.clone(message));
        }

        // 消息发送成功，清理缓存消息
        delete sendMsgMap[tid];

        modifiedMsg = modifiedMsg || { };
        let { msgContent, msgType } = modifiedMsg;
        msgType = msgType || message.name;
        msgContent = msgContent || message.content;
        
        let flagMap = common.formatter.toMsg(flag);
        utils.extend(message, { name: msgType, content: msgContent, sentTime, messageId, ...flagMap, flags: flag, messageIndex: deliveryVersion === 1 ? (Number.isSafeInteger(Number(deliverySequence)) ? Number(deliverySequence) : undefined) : msgIndex, sentState: MESSAGE_SENT_STATE.SUCCESS, ...(deliveryVersion === 1 ? { delivery: { state: "confirmed_acceptance", version: 1, expiresAt: deliveryExpiresAt, requestHash: deliveryRequestHash, sequence: deliverySequence } } : {}) });
        if(lifeTime > 0){
          message.destroyTime = lifeTime + sentTime;
        }
        if(lifeTimeAfterRead > 0){
          message.lifeTimeAfterRead = lifeTimeAfterRead;
        }
        let config = io.getConfig();
        if(!config.isPC && !utils.isEqual(conversationType, CONVERATION_TYPE.CHATROOM) && !message.isStatus){
          io.emit(SIGNAL_NAME.CMD_CONVERSATION_CHANGED, message);
        }
        let isChatroom = utils.isEqual(message.conversationType, CONVERATION_TYPE.CHATROOM)
        if(isChatroom){
          let { conversationId } = message;
          let { msgs = [] } = chatroomCacher.get(conversationId);
          msgs.push(message.messageId);
          chatroomCacher.set(conversationId, { msgs });
        }

        let isGroup = utils.isEqual(message.conversationType, CONVERATION_TYPE.GROUP);
        if(isGroup){
          message = utils.extend(message, { unreadCount: memberCount, readCount: 0 });
        }
        resolve(message);
      });
    });
  };

  /* 
    let messages = [ Message, Message, ... ];  
    let callbacks = {
      onbefore: () => {},
      onprogress: ({ message, count, total }) => {},
      oncompleted: ({ messages }) => {},
    };
  */
  let sendMassMessage = (messages, callbacks = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, messages, FUNC_PARAM_CHECKER.SENDMSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_MASS });
      let _cbs = {
        onprogress: () => {},
        oncompleted: () => {},
      };
      utils.extend(_cbs, callbacks);

      messages = utils.isArray(messages) ? messages : [messages];
      messages = utils.map(messages, (message) => {
        return { isMass: true, ...message }
      });
      
      let _msgs = [];
      let total = messages.length;
      utils.iterator(messages, (message, next, isFinished) => {
        let _next = () => {
          if(isFinished){
            resolve();
            return _cbs.oncompleted({ messages: _msgs });
          }
          next();
        };
        let progress = (msg) => {
          _msgs.push(msg);
          _cbs.onprogress({ message: msg, count: _msgs.length, total });
          _next();
        };
        sendMessage(message, callbacks).then(progress, progress);
      });
    });
  };
  let getMessages = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GETMSGS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { conversationId } = conversation;
      let { id: userId } = io.getCurrentUser();
      let params = {
        time: 0,
        order: MESSAGE_ORDER.BACKWARD,
        count: 20,
        userId: userId,
        topic: COMMAND_TOPICS.HISTORY_MESSAGES,
        targetId: conversationId,
        names: []
      };
      params = utils.extend(params, conversation);
      io.sendCommand(SIGNAL_CMD.QUERY, params, (result) => {
        let { messages, code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        // messageCacher.add(conversation, messages);
        result.messages = utils.map(messages, (message) => {
          if(utils.isEqual(message.name, MESSAGE_TYPE.STREAM_TEXT)){
            let { content: { content }, messageId } = message;
            let contentList = streamStorge.get(messageId);
            let contentStr = utils.map(contentList, (item) => {
              return item.content
            }).join('');
            if(!utils.isEmpty(contentStr)){
              message.content.content = contentStr;
            }
            let maxStream = utils.max(contentList);
            let { content: { is_finished }  } = message;
            if(!utils.isEmpty(maxStream) && !is_finished){
              
            }
            if(is_finished){
              streamStorge.remove(message.messageId);
            }
            message.content = utils.rename(message.content, { is_finished: 'isFinished', stream_id: 'streamId'})
          }
          return message;
        });
        resolve(result);
      });
    });
  };
  let getMessagesByIds = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GETMSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.GET_MSG_BY_IDS,
        userId: user.id,
      };
      data = utils.extend(data, params);
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { messages, code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ messages });
      });
    });
  };
  let clearMessage = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.CLEARMSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      logger.info({ tag: LOG_MODULE.MSG_CLEAR, ...params });
      let data = {
        topic: COMMAND_TOPICS.CLEAR_MESSAGE,
        time: 0
      };
      utils.extend(data, params);
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, timestamp }) => {
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
          let content = { 
            conversationType: params.conversationType,
            conversationId: params.conversationId,
            cleanTime: params.time || 0,
          };
          let { senderId } = params;
          if(!utils.isUndefined(senderId)){
            utils.extend(content, { senderId  })
          }
          let notify = { 
            name: MESSAGE_TYPE.CLEAR_MSG, 
            content: content
          };
          commandNotify(notify);
          resolve();
        }else{
          let errorInfo = common.getError(code);
          reject(errorInfo)
        }
      });
    });
  };
  let removeMessages = (messages) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, messages, FUNC_PARAM_CHECKER.REMOVE_MSGS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      messages = utils.isArray(messages) ? messages : [messages];
      let list = utils.quickSort(utils.clone(messages), (a, b) => {
        return a.sentTime > b.sentTime;
      });
      let item = list[0] || { sentTime: -10 };
      logger.info({ tag: LOG_MODULE.MSG_DELETE, time: item.sentTime });
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.REMOVE_MESSAGE,
        messages,
        userId: user.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, timestamp }) => {
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io }); 
          let _msgs = utils.map(messages, (msg) => {
            let { messageId, tid, conversationType, conversationId } = msg;
            return { messageId, tid, conversationType, conversationId };
          });
          let notify = {
            name: MESSAGE_TYPE.COMMAND_DELETE_MSGS,
            content: {
              conversationType: item.conversationType,
              conversationId: item.conversationId,
              messages: _msgs
            }
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
  /* 
    let message = {conversationType, conversationId, sentTime, messageId}
  */
  let recallMessage = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.RECALLMSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let data = { topic:  COMMAND_TOPICS.RECALL };
      utils.extend(data, message);
      
      logger.info({ tag: LOG_MODULE.MSG_RECALL,  messageId: message.messageId, sentTime: message.sentTime});

      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, timestamp } = result;
        if(utils.isEqual(code, ErrorType.COMMAND_SUCCESS.code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
          
          let msg = utils.clone(message);
          let { messageId, sentTime, exts } = message;
          let sender = io.getCurrentUser();
          utils.extend(msg, {
            name: MESSAGE_TYPE.RECALL,
            sender,
            isSender: true,
            content: {
              messageId,
              sentTime,
              exts,
            },
          });
          commandNotify(msg)

          let _msg = utils.clone(msg);
          delete msg.exts;
          _msg = utils.extend(msg, { name: MESSAGE_TYPE.RECALL_INFO });
          return resolve(msg);
        }
        let { msg } = common.getError(code);
        reject({ code, msg });
      });
    });
  };
  let readMessage = (messages) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, messages, FUNC_PARAM_CHECKER.READMESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      messages = utils.isArray(messages) ? messages : [messages];
      messages = utils.map(messages, (message) => {
        let { conversationType, conversationId, messageId, sentTime } = message;
        return { conversationType, conversationId, messageId, sentTime };
      });

      let data = {
        topic: COMMAND_TOPICS.READ_MESSAGE,
        messages
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code,  timestamp }) => {
        if (!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)) return reject({ code, msg: common.getError(code).msg });
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
          let conversation = messages[0];
          let notify = {
            name: MESSAGE_TYPE.READ_MSG,
            conversationType: conversation.conversationType,
            conversationId: conversation.conversationId,
            sender: io.getCurrentUser(),
            isSender: true,
            sentTime: timestamp,
            content: {
              msgs: messages
            }
          };
          commandNotify(notify);
        }
        resolve();
      });
    });
  };
  let getMessageReadDetails = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.GET_MESSAGE_READ_DETAILS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let data = {
        topic: COMMAND_TOPICS.GET_READ_MESSAGE_DETAIL,
        message
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        delete result.index;
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve(result);
      });
    });
  };

  let updateMessage = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.UPDATEMESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      logger.info({ tag: LOG_MODULE.MSG_UPDATE,  messageId: message.messageId });
      let msg = {
        ...utils.clone(message),
        name: MESSAGE_TYPE.MODIFY,
      };
      let notify = (_msg = {}) => {
        utils.extend(msg, _msg);
        commandNotify(msg);
      };
      // 兼容 PC 端修改非 content 属性，保证多端行为一致性，直接返回，PC 端会做本地消息 update
      if(utils.isUndefined(message.content)){
        notify();
        return resolve(msg);
      }
      let data = {
        topic: COMMAND_TOPICS.UPDATE_MESSAGE,
        ...message
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        let sender = io.getCurrentUser();
        notify({
          sender,
          isSender: true,
          isUpdated: true,
          content: {
            messageId: message.messageId,
            content: message.content,
            name: message.msgName
          }
        });
        resolve();
      });
    });
  };
  let getMentionMessages = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_MENTIOIN_MESSAGES);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let params = {
        count: 20,
        order: MENTION_ORDER.BACKWARD,
        messageIndex: 0,
        onlyUnread: true
      };
      let user = io.getCurrentUser();
      utils.extend(params, conversation);
      let data = {
        topic: COMMAND_TOPICS.GET_MENTION_MSGS,
        userId: user.id,
        ...params
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, isFinished, msgs } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ isFinished, msgs });
      });
    });
  };
  let getFileToken = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_FILE_TOKEN);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.GET_FILE_TOKEN,
        ...params,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ cred, code }) => {
        cred = cred || {};
        resolve(cred);
      });
    });
  };
/* options: fileType, Video and Image: scale: 0 ~ 1 */
  let _uploadFile = (options, message, callbacks = {}) => {
    let { uploadType, upload, fileCompressLimit } = io.getConfig();
      let _callbacks = {
        onprogress: () => { },
        onerror: () => { }
      };
      utils.extend(_callbacks, callbacks);

      let { fileType, scale } = options;
      let uploader = Uploder(upload, { type: uploadType });

      let { name, content } = message;
      let _file = content.file || { name: '' };
      
      let fileName = _file.name || content.tempPath;
      fileName = fileName || '';
      let names = fileName.split('.');

      let ext = names[names.length - 1];
      getFileToken({ type: fileType, ext }).then((auth) => {
        let { type } = auth;
        if(utils.isEqual(ErrorType.COMMAND_FAILED.code, auth.code)){
          return _callbacks.onerror(ErrorType.COMMAND_FAILED);
        }
        if(!utils.isEqual(type, uploadType)){
          return _callbacks.onerror(ErrorType.UPLOAD_PLUGIN_NOTMATCH);
        }
        let params = utils.extend(auth, { file: content.file, scale, fileCompressLimit });

        if(utils.isEqual(name, MESSAGE_TYPE.IMAGE)){
          // 业务层设置缩略图，传入优先，不再执行生成缩略图逻辑
          let { thumbnail } = content;
          if(thumbnail){
            return uploadFile(auth, message);
          }

          getFileToken({ type: fileType, ext }).then((cred) => {
            if(utils.isEqual(ErrorType.COMMAND_FAILED.code, cred.code)){
              return _callbacks.onerror(ErrorType.COMMAND_FAILED);
            }
            common.uploadThumbnail(upload, { ...params, ...cred, content }, (error, thumbnail, args) => {
              let { height, width, isUniWebThumbnail } = args;
              utils.extend(message.content, { thumbnail, height, width, type: args.type });
              uploadFile({ ...auth, isUniWebThumbnail }, message);
            });
          });
        }
        
        if(utils.isEqual(name, MESSAGE_TYPE.VIDEO)){
          // 业务层设置封面，传入优先，不再执行生成缩略图逻辑
          let { poster } = content;
          if(poster){
            return uploadFile(auth, message);
          }
          getFileToken({ type: fileType, ext: 'png' }).then((cred) => {
            if(utils.isEqual(ErrorType.COMMAND_FAILED.code, cred.code)){
              return _callbacks.onerror(ErrorType.COMMAND_FAILED);
            }
            common.uploadFrame(upload, { ...params, ...cred, content }, (error, poster, args) => {
              let { height, width, duration } = args;
              utils.extend(message.content, { poster, height, width, duration});
              uploadFile(auth, message);
            });
          });
        }

        if(utils.isInclude([MESSAGE_TYPE.FILE, MESSAGE_TYPE.VOICE], name)){
          uploadFile(auth, message);
        }
      });

      function uploadFile(option, message){
        let { content } = message;
        let cbs = {
          onprogress: ({ percent }) => {
            _callbacks.onprogress({ percent, message });
          },
          oncompleted: ({ url }) => {
            if(!utils.isInclude([MESSAGE_TYPE.VOICE], name)){
              let _size = content.size || content.file.size;
              let size = _size/1024;
              utils.extend(message.content, { size: size.toFixed(2) });
            }
            utils.extend(message.content, { url });
            delete message.content.file;
            _callbacks.oncompleted(message);
          },
          onerror: (error) => {
            _callbacks.onerror(ErrorType.UPLOADING_FILE_ERROR, error);
          }
        };
        uploader.exec(content, option, cbs);
      }
  };
  /* 
    message = {
      conversationType,
      conversationId,
      content: { file, name, type, intro }
    }
  */
  let sendFileMessage = (message, callbacks = {}) => {
    message = utils.extend(message, { name: MESSAGE_TYPE.FILE });
    let option = { fileType: FILE_TYPE.FILE };
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SEND_FILE_MESSAGE, true);
      let { uploadType } = io.getConfig();
      if(utils.isEqual(uploadType, UPLOAD_TYPE.NONE)){
        error = ErrorType.UPLOAD_PLUGIN_ERROR;
      }
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_FILE, type: FILE_TYPE.FILE });
      let onbefore = callbacks.onbefore || utils.noop;
      let tid = message.tid || utils.getUUID();
      utils.extend(message, { tid, sentState: MESSAGE_SENT_STATE.SENDING });

      let { size = 0 } = message.content;
      let msg = utils.clone(message);
      msg.content = { ...message.content, size };
      onbefore(msg);

      if(!io.isConnected()){
        return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.CONNECTION_NOT_READY });
      }

      _uploadFile(option, message, {
        onprogress: callbacks.onprogress,
        oncompleted: (message) => {
          delete message.content.tempPath;
          message.content.size = size;
          sendMessage(message).then(resolve, reject);
        },
        onerror: (error) => {
          if(utils.isEqual(error.code, ErrorType.COMMAND_FAILED.code)){
            return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.COMMAND_FAILED });
          }
          callbacks.onerror(error, message);
        },
      })
    });
  };

  let sendImageMessage = (message, callbacks = {}) => {
    message = utils.extend(message, { name: MESSAGE_TYPE.IMAGE });
    let option = { fileType: FILE_TYPE.IMAGE, scale: message.scale };
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SEND_FILE_MESSAGE, true);
      let { uploadType } = io.getConfig();
      if(utils.isEqual(uploadType, UPLOAD_TYPE.NONE)){
        error = ErrorType.UPLOAD_PLUGIN_ERROR;
      }
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_FILE, type: FILE_TYPE.IMAGE });
      let onbefore = callbacks.onbefore || utils.noop;
      let tid = message.tid || utils.getUUID();
      utils.extend(message, { tid, sentState: MESSAGE_SENT_STATE.SENDING });
      onbefore(message);

      if(!io.isConnected()){
        return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.CONNECTION_NOT_READY });
      }

      _uploadFile(option, message, {
        onprogress: callbacks.onprogress,
        oncompleted: (message) => {
          delete message.content.tempPath;
          sendMessage(message).then(resolve, reject);
        },
        onerror: (error) => {
          if(utils.isEqual(error.code, ErrorType.COMMAND_FAILED.code)){
            return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.COMMAND_FAILED });
          }
          callbacks.onerror(error, message);
        },
      })
    });
  };

  let sendVoiceMessage = (message, callbacks = {}) => {
    message = utils.extend(message, { name: MESSAGE_TYPE.VOICE });
    let option = { fileType: FILE_TYPE.AUDIO };
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SEND_FILE_MESSAGE, true);
      let { uploadType } = io.getConfig();
      if(utils.isEqual(uploadType, UPLOAD_TYPE.NONE)){
        error = ErrorType.UPLOAD_PLUGIN_ERROR;
      }
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_FILE, type: FILE_TYPE.AUDIO });

      let onbefore = callbacks.onbefore || utils.noop;
      let tid = message.tid || utils.getUUID();
      utils.extend(message, { tid, sentState: MESSAGE_SENT_STATE.SENDING });
      onbefore(message);

      if(!io.isConnected()){
        return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.CONNECTION_NOT_READY });
      }
      
      _uploadFile(option, message, {
        onprogress: callbacks.onprogress,
        oncompleted: (message) => {
          delete message.content.tempPath;
          sendMessage(message).then(resolve, reject);
        },
        onerror: (error) => {
          if(utils.isEqual(error.code, ErrorType.COMMAND_FAILED.code)){
            return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.COMMAND_FAILED });
          }
          callbacks.onerror(error, message);
        },
      })
    });
  };

  let sendVideoMessage = (message, callbacks = {}) => {
    message = utils.extend(message, { name: MESSAGE_TYPE.VIDEO });
    let option = { fileType: FILE_TYPE.VIDEO, scale: message.scale };
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SEND_FILE_MESSAGE, true);
      let { uploadType } = io.getConfig();
      if(utils.isEqual(uploadType, UPLOAD_TYPE.NONE)){
        error = ErrorType.UPLOAD_PLUGIN_ERROR;
      }
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_FILE, type: FILE_TYPE.VIDEO });
      let onbefore = callbacks.onbefore || utils.noop;
      let tid = message.tid || utils.getUUID();
      utils.extend(message, { tid, sentState: MESSAGE_SENT_STATE.SENDING });
      onbefore(message);
      
      if(!io.isConnected()){
        return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.CONNECTION_NOT_READY });
      }

      _uploadFile(option, message, {
        onprogress: callbacks.onprogress,
        oncompleted: (message) => {
          delete message.content.tempPath;
          sendMessage(message).then(resolve, reject);
        },
        onerror: (error) => {
          if(utils.isEqual(error.code, ErrorType.COMMAND_FAILED.code)){
            return reject({ tid, sentState: MESSAGE_SENT_STATE.FAILED, error: ErrorType.COMMAND_FAILED });
          }
          callbacks.onerror(error, message);
        },
      });
    });
  };

  let sendMergeMessage = (params, callbacks = {}) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.SEND_MERGE_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject({ error });
      }
      logger.info({ tag: LOG_MODULE.MSG_SEND_MERGE });
      let { conversationType, conversationId, conversationTitle, conversationPortrait, messages, previewList, title, lifeTime, lifeTimeAfterRead } = params;
      if(messages.length > 20){
        return reject({ error: ErrorType.TRANSFER_MESSAGE_COUNT_EXCEED });
      }
      let mergeMsg = {
        channelType: CONVERATION_TYPE.PRIVATE,
        targetId: ''
      };
      let messageIdList = [];
      messages = utils.map(messages, (message) => {
        utils.extend(mergeMsg, { 
          channelType: message.conversationType,
          targetId: message.conversationId
        });
        return { msgId: message.messageId, msgTime: message.sentTime, msgIndex: message.messageIndex };
      });

      utils.forEach(messages, ({ msgId }) => {
        messageIdList.push(msgId);
      });
      let user = io.getCurrentUser();
      utils.extend(mergeMsg, { userId: user.id, msgs: messages });

      let msg = {
        conversationId,
        conversationType,
        conversationTitle, 
        conversationPortrait,
        name: MESSAGE_TYPE.MERGE,
        mergeMsg: mergeMsg,
        lifeTime, 
        lifeTimeAfterRead,
        content: {
          conversationType: mergeMsg.channelType,
          conversationId: mergeMsg.targetId,
          previewList,
          messageIdList,
          title
        }
      };
      return sendMessage(msg, callbacks).then(resolve, reject);
    });
  };

  let getMergeMessages = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_MERGE_MESSAGES);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let data = {
        time: 0,
        order: MESSAGE_ORDER.FORWARD,
        count: 20,
        topic: COMMAND_TOPICS.GET_MERGE_MSGS,
      };
      utils.extend(data, params);
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, isFinished, messages } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ isFinished, messages });
      });
    });
  };

  let getFirstUnreadMessage = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_FIRST_UNREAD_MSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let data = {
        ...conversation,
        topic: COMMAND_TOPICS.GET_FIRST_UNREAD_MSG,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code, msg }) => {
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          let error = common.getError(code);
          return reject(error);
        }
        resolve({ message: msg });
      });
    });
  };

  /* 
    let conversation = {
      conversationType: 1,
      conversationId: '',
      time: 19482938392,
      count: 10,
    };
  */
  function getContextMessages(conversation){
    return utils.deferred(async (resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GETMSGS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { time, conversationId, conversationType, count } = conversation;
      
      count = count || 10;
      // 默认从当前会话第一条未读消息开始获取
      if(utils.isUndefined(time)){
        let { message } = await getFirstUnreadMessage(conversation);
        time = message.sentTime || 0;
      }
      
      let frontResult = await getMessages({ conversationType, conversationId, time: time, count });
      let backResult = { messages: [], isFinished: true };
      if(time > 0){
        backResult = await getMessages({ conversationType, conversationId, time: time - 1, count, order: MESSAGE_ORDER.FORWARD })
      }
      resolve({ 
        frontMessages: frontResult.messages, 
        isFrontFinished: frontResult.isFinished, 
        isBackFinished: backResult.isFinished, 
        backMessages: backResult.messages 
      });
    });
  };

  let searchMessages = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.SEARCH_MESSAGES);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      return reject(ErrorType.SDK_FUNC_NOT_DEFINED);
    });
  };

  let updateMessageAttr = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.UPDATE_MESSAGE_ATTR);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      return reject(ErrorType.SDK_FUNC_NOT_DEFINED);
    });
  };

  let setSearchContent = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SET_MESSAGE_SEARCH_CONTENT);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      return reject(ErrorType.SDK_FUNC_NOT_DEFINED);
    });
  };

  let insertMessage = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.INSERT_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let user = io.getCurrentUser();
      let { sender } = message;
      let isSender = utils.isEqual(user.id, sender.id);
      let tid = utils.getUUID();
      let msg = { tid, ...message, isSender, sender };
      resolve(msg);
    });
  };

  let addMessageReaction = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.ADD_MSG_REACTION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.ADD_MSG_REACTION,
        ...message,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, timestamp } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
        resolve();
      });
    });
  };

  let removeMessageReaction = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.REMOVE_MSG_REACTION);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.REMOVE_MSG_REACTION,
        ...message,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, timestamp } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        common.updateSyncTime({ isSender: true,  sentTime: timestamp, io });  
        resolve();
      });
    });
  };

  /* 
    let params = {
      targetLang: '',
      sourceLang: '',
      content: {
        key1: content,
        key2: content2
      }
    }
  */
  let translate = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.TRANSLATE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { content } = params;
      if(utils.isEmpty(content)){
        return resolve(params);
      }
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.BATCH_TRANSLATE,
        ...params,
        userId: user.id,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, trans } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        let { items } = trans;
        let _result = {};
        utils.forEach(items, (item) => {
          let { key, content } = item;
          _result[key] = content;
        })
        resolve(_result);
      });
    });
  };

  /* 

    let subscribeMsgCache = {
      conversationType_convesationId: { 
        timer: '定时器',
        time: '上一次的获取时间'
      }
    }
  */
  let subscribeMsgCache = {};
  let _getSubId = (conversation) => {
    let { conversationId, conversationType } = conversation;
    return `${conversationType}_${conversationId}`;
  };
  let subscribeMessage = (conversation, option) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.SUBSCRIBE_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let subId = _getSubId(conversation);
      let subInfo = subscribeMsgCache[subId];
      if(subInfo){
        return resolve();
      }
      subInfo = { timer: 0, time: 0 };
      subscribeMsgCache[subId] = subInfo;

      let defOption = { ms: 3 * 1000 };
      if(!utils.isObject(option) || !utils.isNumber(option.ms)){
        option = defOption;
      }

      let fetchMsgs = (params) => {
        getMessages(params).then((result) => {
          let { messages } = result;
          messages = messages || [];
          let message = messages[messages.length - 1];
          if(message){
            subInfo.time = message.sentTime;
          }
          utils.forEach(messages, (message) => {
            io.emit(SIGNAL_NAME.CMD_RECEIVED, message);
          });
        }).catch(utils.noop);
      }

      let firstParams = { 
        ...conversation,
        time: 0
      };
      fetchMsgs(firstParams);

      subInfo.timer = setInterval(() => {
        let params = { ...conversation, time: subInfo.time, count: 200, order: MESSAGE_ORDER.FORWARD };
        fetchMsgs(params)
      }, option.ms);
    });
  };
  let unsubscribeMessage = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.SUBSCRIBE_MESSAGE, true);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let subId = _getSubId(conversation);
      let subInfo = subscribeMsgCache[subId];
      if(subInfo){
        clearInterval(subInfo.timer);
        delete subscribeMsgCache[subId];
      }
      resolve();
    });
  };

  /* 
    let message = {
      conversationType: 1,
      conversationId: '',
      messageId: '',
      isTop: true,
    }
  */
  let setTopMessage = (message) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, message, FUNC_PARAM_CHECKER.SET_TOP_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { isTop, conversationType, conversationId, messageId } = message;
      let user = io.getCurrentUser();
      let topic = isTop ? COMMAND_TOPICS.SET_TOP_MSG : COMMAND_TOPICS.DEL_TOP_MSG;
      let data = {
        topic: topic,
        conversationType, 
        conversationId,
        messageId,
        userId: user.id,
        isTop: !!isTop,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        let _msg = {
          conversationType, 
          conversationId,
          content: { msg_id: messageId, action: isTop ? MSG_TOP_ACTION_TYPE.ADD : MSG_TOP_ACTION_TYPE.REMOVE },
          sender: user,
          name: MESSAGE_TYPE.COMMAND_MSG_SET_TOP,
          sentTime: Date.now()
        };
        commandNotify(_msg);
        resolve();
      });
    });
  };
  
  /* 
    let conversation = {
      conversationType: 1,
      conversationId: '',
    }
  */
  let getTopMessage = (conversation) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, conversation, FUNC_PARAM_CHECKER.GET_TOP_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { conversationType, conversationId } = conversation;
      let data = {
        topic: COMMAND_TOPICS.GET_TOP_MSG,
        conversationType, 
        conversationId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, message, operator, createdTime } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        let _result = {};
        if(message){
          _result = { message, operator, createdTime };
        }
        resolve(_result);
      });
    });
  };

  let addFavoriteMessages = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.ADD_FAVORITE_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { messages } = params;
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.MSG_ADD_FAVORITE,
        messages,
        userId: user.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve();
      });
    });
  };

  let removeFavoriteMessages = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.ADD_FAVORITE_MESSAGE);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { messages } = params;
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.MSG_REMOVE_FAVORITE,
        messages,
        userId: user.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve();
      });
    });
  };

  let getFavoriteMessages = (params) => {
    return utils.deferred((resolve, reject) => {
      let _params = { limit: 20, offset: '' };
      if(!utils.isObject(params)){
        params = _params;
      }
      let { limit = 20, offset = '' } = params;

      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.MSG_QRY_FAVORITE,
        limit,
        offset,
        userId: user.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, list, offset } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ list, offset });
      });
    });
  };

  /* 
    let options = {
      // 必传
      conversationId: '',

      // 必传
      conversationType: 1,

      // 必传
      keyword: '',

      // 可选
      count: 5
    };
  
  */
  let searchConversationMsgsFromCloud = (options) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, options, FUNC_PARAM_CHECKER.SEARCH_CONVERSATION_MSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let params = {
        count: 5
      };
      params = utils.extend(params, options);
      let user = io.getCurrentUser();
      let data = {
        ...params,
        topic: COMMAND_TOPICS.MSG_CONVERSATION_SEARCH,
        userId: user.id,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, searchResult, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve(searchResult);
      });
    });
  };

  /* 
    let options = {
      // 必传
      keyword: '',
      // 可选
      count: 5
    };
  */
  let searchGlobalMsgsFromCloud = (options) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, options, FUNC_PARAM_CHECKER.SEARCH_GLOBAL_MSG);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let params = {
        count: 5
      };
      params = utils.extend(params, options);
      let user = io.getCurrentUser();
      let data = {
        ...params,
        topic: COMMAND_TOPICS.MSG_GLOBAL_SEARCH,
        userId: user.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, searchResult, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve(searchResult);
      });
    });
  };

  return {
    sendMessage,
    sendMassMessage,
    getMessages,
    removeMessages,
    getMessagesByIds,
    clearMessage,
    recallMessage,
    readMessage,
    getMessageReadDetails,
    updateMessage,
    insertMessage,
    updateMessageAttr,
    setSearchContent,
    getMentionMessages,
    getFileToken,
    sendFileMessage,
    sendImageMessage,
    sendVoiceMessage,
    sendVideoMessage,
    sendMergeMessage,
    getMergeMessages,
    getFirstUnreadMessage,
    searchMessages,
    addMessageReaction,
    removeMessageReaction,
    subscribeMessage,
    unsubscribeMessage,
    translate,
    setTopMessage,
    getTopMessage,
    addFavoriteMessages,
    removeFavoriteMessages,
    getFavoriteMessages,
    getContextMessages,
    searchConversationMsgsFromCloud,
    searchGlobalMsgsFromCloud,
    _uploadFile,
  };
}