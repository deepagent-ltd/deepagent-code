import { COMMAND_TOPICS, ErrorType, FUNC_PARAM_CHECKER, SIGNAL_CMD, SIGNAL_NAME, EVENT, NOTIFY_TYPE, CHATROOM_EVENT_TYPE, LOG_MODULE } from "../../enum";
import utils from "../../utils";
import Storage from "../../common/storage";
import common from "../../common/common";
import attrCaher from "../../common/attr-cacher";
import chatroomCacher from "../../common/chatroom-cacher";

export default function(io, emitter, logger){

  // 聊天室全以 Web 通信为主，PC 端只做接口透传，所以未在 desktop/index.js init 方法中卸载 io 相关事件，直接在 Web 端复用 
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
    logger.info({ tag: LOG_MODULE.CHATROOM_DESTORYED, ...chatroom });
    emitter.emit(EVENT.CHATROOM_DESTROYED, chatroom);
  });

  io.on(SIGNAL_NAME.CMD_CHATROOM_EVENT, (notify) => {
    let { type, chatroomId } = notify;
    logger.info({ tag: LOG_MODULE.CHATROOM_SERVER_EVENT, ...notify });
    if(utils.isEqual(CHATROOM_EVENT_TYPE.FALLOUT, type) || utils.isEqual(CHATROOM_EVENT_TYPE.QUIT, type)){
      clearChatroomCache(chatroomId);
      emitter.emit(EVENT.CHATROOM_USER_QUIT, notify);
    }
    if(utils.isEqual(CHATROOM_EVENT_TYPE.KICK, type)){
      clearChatroomCache(chatroomId);
      emitter.emit(EVENT.CHATROOM_USER_KICKED, notify);
    }
  });
  
  // 和 desktop/chatroom.js 复用断网重复加入事件，由于不涉及对外暴露 emitter，SDK 所以内部可共享 io.emit 事件
  io.on(SIGNAL_NAME.CMD_CHATROOM_REJOIN, () => {
    let chatrooms = chatroomCacher.getAll();
    let chatroomIds = [];
    utils.forEach(chatrooms, (value, chatroomId) => {
      chatroomIds.push(chatroomId);
    });
    logger.info({ tag: LOG_MODULE.CHATROOM_USER_REJOIN, chatroomIds });
    utils.iterator(chatroomIds, (id, next, isFinished) => {
      let chatroom = { id };
      let _next = () => {
        if(!isFinished){
          next();
        }
      }
      _joinChatroom(chatroom, {
        success: _next,
        fail: _next,
      });
    })
  });

  function clearChatroomCache(chatroomId){
    chatroomCacher.remove(chatroomId);
    attrCaher.removeAll(chatroomId);
  };
  let joinChatroom = (chatroom) =>{
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.JOINCHATROOM);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id } = chatroom;
      let chatroomResult = chatroomCacher.get(id);
      if(chatroomResult.isJoined){
        return resolve();
      }
      let _chatroom = { ...utils.clone(chatroom), isAutoCreate: false  }
      logger.info({ tag: LOG_MODULE.CHATROOM_USER_JOIN, ..._chatroom  });
      _joinChatroom(_chatroom, {
        success: resolve,
        fail: reject,
      });
    });
  };

  function joinAndCreateChatroom(chatroom){
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.JOINCHATROOM);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id } = chatroom;
      let chatroomResult = chatroomCacher.get(id);
      if(chatroomResult.isJoined){
        return resolve();
      }
      let _chatroom = { ...utils.clone(chatroom), isAutoCreate: true  }
      logger.info({ tag: LOG_MODULE.CHATROOM_USER_JOIN, ..._chatroom  });

      _joinChatroom(_chatroom, {
        success: resolve,
        fail: reject,
      });
    });
  }

  function _joinChatroom(chatroom, callbacks){
    let { id } = chatroom;
    let data = {
      topic: COMMAND_TOPICS.JOIN_CHATROOM,
      chatroom,
      conversationId: id
    };
    let count = chatroom.count;
    if(utils.isUndefined(count)){
      count = 50;
    }
    
    chatroomCacher.set(chatroom.id, { isJoined: true });

    io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
      let { code, timestamp } = result;
      logger.info({ tag: LOG_MODULE.CHATROOM_USER_JOIN, ...chatroom, code });
      if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
        
        let chatroomResult = chatroomCacher.get(chatroom.id);
        let syncMsgTime = chatroomResult.syncMsgTime || 0;
        let isNotSync = utils.isEqual(0, count);

        let _time = syncMsgTime;
        if(isNotSync && utils.isEqual(syncMsgTime, 0)){
          _time = timestamp;
        }

        // 模拟通知事件时间戳 +1 ，比本地时间戳大
        if(_time > 0){
          _time += 1;
        }
        let syncers = [
          { name: SIGNAL_NAME.S_NTF, msg: { receiveTime: _time, isNotSync, count: count, type: NOTIFY_TYPE.CHATROOM, targetId: id } },
          { name: SIGNAL_NAME.S_NTF, msg: { receiveTime: 0, type: NOTIFY_TYPE.CHATROOM_ATTR, targetId: id } },
        ];

        
        io.sync(syncers);
        return callbacks.success();
      }
      let error = common.getError(code);
      callbacks.fail(error)
    });
  }
  let quitChatroom = (chatroom) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.QUITCHATROOM);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let chatroomResult = chatroomCacher.get(chatroom.id);
      if(!chatroomResult.isJoined){
        return resolve();
      }
      logger.info({ tag: LOG_MODULE.CHATROOM_USER_QUIT, ...chatroom });
      let data = {
        topic: COMMAND_TOPICS.QUIT_CHATROOM,
        chatroom
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, ({ code }) => {
        logger.info({ tag: LOG_MODULE.CHATROOM_USER_QUIT, ...chatroom, code });
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          clearChatroomCache(chatroom.id);
          return resolve();
        }
        let error = common.getError(code);
        reject(error)
      });
    });
  };

  /* 
    let chatroom = {
      id: 'chatroomId',
      attributes: [
        { key: 'name', value: 'xiaoshan', isForce: true, isAutoDel: true },
      ],
      options: {
        notify: '',
      }
    }
  */
  let setChatroomAttributes = (chatroom) => {
    chatroom = utils.clone(chatroom);
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.SET_CHATROOM_ATTRS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { options } = chatroom;
      if(!utils.isObject(options)){
        options = {};
      }
      let { notify } = options;
      if(!utils.isUndefined(notify) && !utils.isString(notify)){
        let _error = ErrorType.ILLEGAL_TYPE_PARAMS;
        return reject({ code: _error.code, msg: `notify ${_error.msg}，必须是 String 类型` })
      }
      chatroom = utils.extend(chatroom, { options });
      let data = {
        topic: COMMAND_TOPICS.SET_CHATROOM_ATTRIBUTES,
        chatroom
      };
      attrCaher.removeAttrs(chatroom);
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, success, fail } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ success, fail });
        }
        let error = common.getError(code);
        reject(error)
      });
    });
  };
  
   /* 
    let chatroom = {
      id: 'chatroomId',
      attributes: [{ key: 'key1' }],
      options: {
        notify: ''
      }
    };
  */
    let removeChatroomAttributes = (chatroom) => {
      return utils.deferred((resolve, reject) => {
        let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.REMOVE_CHATROOM_ATTRS);
        if(!utils.isEmpty(error)){
          return reject(error);
        }
        let { options } = chatroom;
        if(!utils.isObject(options)){
          options = {};
        }
        let { notify } = options;
        if(!utils.isUndefined(notify) && !utils.isString(notify)){
          let _error = ErrorType.ILLEGAL_TYPE_PARAMS;
          return reject({ code: _error.code, msg: `notify ${_error.msg}，必须是 String 类型` })
        }

        chatroom = utils.extend(chatroom, { options });
        
        let data = {
          topic: COMMAND_TOPICS.REMOVE_CHATROOM_ATTRIBUTES,
          chatroom
        };
        io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
          let { code, success, fail } = result;
          if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
            attrCaher.removeAttrs({ id: chatroom.id, attributes: success });
            return resolve({ success, fail });
          }
          let error = common.getError(code);
          reject(error)
        });
      });
    };

  /* 
    let chatroom = {
      id: 'chatroomId',
      attributes: [{ key: 'key1' }],
    };
  */
  let getChatroomAttributes = (chatroom) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.GET_CHATROOM_ATTRS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let result = attrCaher.getAttrs(chatroom);
      resolve(result);
    });
  };
    /* 
    let chatroom = {
      id: 'chatroomId',
    };
  */
  let getAllChatRoomAttributes = (chatroom) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, chatroom, FUNC_PARAM_CHECKER.GET_ALL_CHATROOM_ATTRS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let result = attrCaher.getAll(chatroom);
      resolve(result);
    });
  };

  return {
    joinChatroom,
    joinAndCreateChatroom,
    quitChatroom,
    setChatroomAttributes,
    getChatroomAttributes,
    removeChatroomAttributes,
    getAllChatRoomAttributes,
  }
}