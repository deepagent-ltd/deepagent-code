import utils from "../utils";
import { ErrorType, STORAGE, ErrorMessages, MESSAGE_TYPE, UPLOAD_TYPE, UNREAD_TAG, CONVERATION_TYPE } from "../enum";
import Storage from "./storage";
import Uploader from "./uploader";
import JSessionStorage from "../provoider/session/index";

/* 
let params = { content: 123 }
let params = { content: { name: 123 } }
let params = [{ content: 123 }]
let props = [
  {
    name: 'content',
    type: 'Object',
  }
]
*/
let check = (io, _params, props, isStatic, option = {}) => {
  if(!isStatic){
    if(!io.isConnected()){
      return ErrorType.CONNECTION_NOT_READY;
    }
  }
  let { isChild, isArray } = option;
  _params = _params || {};
  let checkType = (val, type, name) => {
    let error = null;
    let { msg, code } = ErrorType.ILLEGAL_TYPE_PARAMS;
    let _type = Object.prototype.toString.call(val);
    _type = _type.slice(8, _type.length - 1);
    if(!utils.isEqual(_type, type)){
      msg = `${name} ${msg}, 传入 ${_type}, 应传: ${type}`;
      error = { msg, code };
    }
    return error;
  };
  let checkEmpty = (val, type, name) => {
    let error = null;
    let { msg, code } = ErrorType.ILLEGAL_PARAMS_EMPTY;

    if(utils.isEmpty(val)){
      msg = `${name} ${msg}`;
      error = { msg, code };
    }
    return error;
  };
  let checkRequire = (val, name, index) => {
    let error = null;
    let { msg, code } = ErrorType.ILLEGAL_PARAMS;
    if(utils.isUndefined(val)){
      msg = `${name} ${msg}`;
      if(!isChild && utils.isArray(_params)){
        msg = `Array index ${index} : ${msg}`;
      }
      if(isChild && isArray){
        msg = `${option.name}[${option.num}].${msg}`;
      }
      if(isChild && !isArray){
        msg = `${option.name}.${msg}`;
      }
      error = { msg, code };
    }
    return error;
  };

  let _check = (prop, param, index) => {
    let { name, type, children} = prop;
    let val = param[name];
    let error = null;
    error = checkRequire(val, name, index);
    if(error){
      return error;
    }

    if(type){
      error = checkType(val, type, name);
      if(!error){
        error = checkEmpty(val, type, name);
      }
      if(!error && !utils.isUndefined(children)){
        let isArray = utils.isEqual(type, 'Array');
        error = check(io, val, children, isStatic, { num: index, name: name, isChild: true, isArray  });
      }
    }
    return error;
  };

  let params = utils.isArray(_params) ? _params : [_params];
  for(let i = 0; i < props.length; i++){
    let prop = props[i];
    for(let j = 0; j < params.length; j++){
      let param = params[j];
      let error = _check(prop, param, j);
      if(error){
        return error;
      }
    }
  }
}

let getTokenUUId = (token) => {
  let uuid = token.slice(16, 40);
  return uuid;
};

let getNaviStorageKey = () => {
  return `${STORAGE.NAVI}`;
};
let orderNum = 0;
let getNum = () => {
  orderNum += 1;
  if(orderNum > 65535){
    orderNum = 1;
  }
  return orderNum;
};
function updateSyncTime(message){
  let { isSender, sentTime, io } = message;
  let key =  STORAGE.SYNC_RECEIVED_MSG_TIME;
  if(isSender){
    key =  STORAGE.SYNC_SENT_MSG_TIME;
  }
  let time = Storage.get(key).time || 0;
  let isNewMsg = sentTime > time;
  if(isNewMsg){
    Storage.set(key, { time: sentTime });
    let config = io.getConfig();
    if(config.isPC){
      let times = {};
      times[key] = sentTime;
      config.$socket.updateSyncTime(times);
    }
  }
  return isNewMsg;
}

// PC 端打开数据库后，将本地时间戳同步至 localStorage 中
function initSyncTime(params){
  let { appkey, userId, times } = params;
  Storage.setPrefix(`${appkey}_${userId}`);
  utils.forEach(times, (localTime, key) => {
    if(utils.isInclude([STORAGE.SYNC_RECEIVED_MSG_TIME, STORAGE.SYNC_SENT_MSG_TIME, STORAGE.SYNC_CONVERSATION_TIME], key)){
      let item = Storage.get(key);
      let time = item.time || 0
      if(localTime > time){
        Storage.set(key, { time: localTime });
      }
    }
  });
}

function getError(code) {
  let error = ErrorMessages.find(error => error.code == code) || { code, msg: '' };
  let { msg } = error;
  return { code, msg };
}

// 内置消息类型和动态注入的自定消息类型
let _MSG_FLAG_NAMES = [
  {name: "dac:media.v1", isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.TEXT,  isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.STREAM_TEXT,  isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.FILE,  isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.IMAGE, isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.VOICE, isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.VIDEO, isCount: true, isStorage: true },
  {name: MESSAGE_TYPE.MERGE, isCount: true, isStorage: true, isMerge: true},
  {name: MESSAGE_TYPE.RECALL, isCommand: true },
  {name: MESSAGE_TYPE.RECALL_INFO, isCommand: true },
  {name: MESSAGE_TYPE.READ_MSG, isCommand: true },
  {name: MESSAGE_TYPE.READ_GROUP_MSG, isCommand: true },
  {name: MESSAGE_TYPE.MODIFY, isCommand: true },
  {name: MESSAGE_TYPE.CLEAR_MSG, isCommand: true },
  {name: MESSAGE_TYPE.CLEAR_UNREAD, isCommand: true,  isCount: false, isStorage: false },
];

let formatter = {
  toFlag: ({ isCommand, isCount, isStorage, isMerge, isMass, isStatus }) => {
    let flag = 0;
    isCommand && (flag |= (1 << 0));
    isCount && (flag |= (1 << 1));
    isStatus && (flag |= (1 << 2));
    isStorage && (flag |= (1 << 3));
    isMerge && (flag |= (1 << 5));
    isMass && (flag |= (1 << 7));
    return flag;
  },
  toMsg: (flag) => {
    let obj = {
      1: { name: 'isCommand' },
      2: { name: 'isCount' },
      3: { name: 'isStatus' },
      4: { name: 'isStorage' },
      5: { name: 'isUpdated' },
      6: { name: 'isMerge' },
      7: { name: 'isMute' },
      8: { name: 'isMass' },
      11: { name: 'isStream' }
    };
    let result = {};
    for(let num in obj){
      // 创建一个只有第 N 位为 1 其他都为 0 的掩码
      let bitMask = Math.pow(2, (num - 1)); 
      let name = obj[num].name;
      result[name] = ((flag & bitMask) !== 0);
    }
    return result;
  }
};

let registerMessage = (names) => {
  names = utils.isArray(names) ? names : [names];
  utils.forEach(names, (name) => {
    _MSG_FLAG_NAMES.push(name);
  });
};

let getMsgFlag = (name, option = {}) => {
  let msg = utils.filter(_MSG_FLAG_NAMES, (n) => {
    return utils.isEqual(n.name, name);
  })[0] || {};
  let _msg = { ...msg, ...option };
  let flag = formatter.toFlag(_msg);
  return flag;
};

function ConversationUtils(){
  let conversations = [];
  let isSynced = false;
  let isExisted = (item) => {
    let index = utils.find(conversations, ({ conversationType, conversationId }) => {
      return utils.isEqual(item.conversationType, conversationType) && utils.isEqual(item.conversationId, conversationId);
    });
    return index > -1;
  };
  let update = (list, option) => {
    option = option || { isAdd: false };
    list = utils.isArray(list) ? list : [list];
    utils.forEach(list, (item) => {
      let index = utils.find(conversations, ({ conversationType, conversationId }) => {
        return utils.isEqual(item.conversationType, conversationType) && utils.isEqual(item.conversationId, conversationId);
      });
      let conversation = item;
      let { latestMessage, updatedTime, conversationExts, mentions, undisturbType } = item;
      
      let tags = latestMessage.tags;
      let messageName = latestMessage.name;
      let msgFlag = formatter.toMsg(latestMessage.flags) || {};

      let _isSender = latestMessage.isSender;
      let isSender = utils.isBoolean(_isSender) && _isSender;

      if(!utils.isEqual(index, -1)){
        conversation = conversations.splice(index, 1)[0]; 
        let { conversationTitle, conversationPortrait, friendAlias } = latestMessage;
        conversationTitle = conversationTitle || item.conversationTitle;
        conversationPortrait = conversationPortrait || item.conversationPortrait;

        let conversationAlias = conversation.conversationAlias;
        if(utils.isEqual(CONVERATION_TYPE.PRIVATE, conversation.conversationType)){
          conversationAlias = friendAlias;
        }

        if(utils.isEmpty(conversationTitle)){
          conversationTitle = conversation.conversationTitle;
        }
        if(utils.isEmpty(conversationPortrait)){
          conversationPortrait = conversation.conversationPortrait;
        }
        if(utils.isEmpty(conversationExts)){
          conversationExts = conversation.conversationExts;
        }
 
        if(utils.isEqual(latestMessage.name, MESSAGE_TYPE.CLEAR_MSG) && latestMessage.isSender){
          latestMessage = {};
        }
        conversation = utils.extend(conversation, { 
          latestMessage: latestMessage,
          conversationTitle, 
          conversationPortrait,
          conversationExts,
          conversationAlias,
          mentions,
          updatedTime,
          undisturbType,
        });
      }else{
        if(!option.isAdd){
          // 如果本地没有会话，未读数默认为 1
          var newUnreadIndex = latestMessage.unreadIndex || conversation.latestUnreadIndex;
          conversation.latestUnreadIndex = newUnreadIndex;
          conversation.latestReadIndex = newUnreadIndex - 1;
        }
      }

      let { unreadCount = 0, latestReadIndex = 0, latestUnreadIndex = 0 } = conversation;
      // 自己发送的多端同步清空消息，未读数设置为 0，最后一条消息保持不变
      if(utils.isEqual(messageName, MESSAGE_TYPE.CLEAR_UNREAD) && latestMessage.isSender){
        unreadCount = 0;
        latestMessage = conversation.latestMessage;
      }
      if(!isSender && msgFlag.isCount){
        latestUnreadIndex = latestMessage.unreadIndex || latestUnreadIndex;
        unreadCount = latestUnreadIndex - latestReadIndex;
      }

      if(unreadCount < 0 || utils.isNull(unreadCount)){
        unreadCount = 0;
      }

      let key = getDraftKey(conversation);
      let draft = Storage.get(key);
      draft = utils.isEmpty(draft) ? '' : draft;
      utils.extend(conversation, { draft });

      if(!utils.isEmpty(tags)){
        utils.extend(conversation, { tags });
      }

      let sortTime = latestMessage.sentTime || conversation.sortTime;
      // 如果是自己发发送的群发消息不更新会话列表, 自己本地发送的消息通过 isMass 区分，接收或同步消息通过消息位计算
      if((latestMessage.isMass && isSender)){
        sortTime = conversation.sortTime;
      }
      conversation = utils.extend(conversation, { sortTime, unreadCount, latestUnreadIndex, latestReadIndex });  
      conversations.push(conversation);
    });
    conversations = utils.quickSort(conversations, (a, b) => {
      return a.sortTime > b.sortTime;
    });
    let MAX_COUNT = 1000;
    if(conversations.length > MAX_COUNT){
      conversations.length = MAX_COUNT;
    }
  };
  let setSynced = () => {
    isSynced = true;
  };
  let add = (list) => {
    update(list, { isAdd: true });
  };
  let remove = (item) => {
    let _conver = item;
    let index = utils.find(conversations, ({ conversationType, conversationId, latestMessage = {} }) => {
      let isMatched = true;
      // 删除会话指令中包含 time，用来判断是否是过期的删除指令
      if(item.time > 0){
        isMatched = item.time >= latestMessage.sentTime;
      }
      return isMatched && utils.isEqual(item.conversationType, conversationType) && utils.isEqual(item.conversationId, conversationId);
    });
    if(!utils.isEqual(index, -1)){
      let arrs = conversations.splice(index, 1);
      _conver = arrs[0];
    }
    return _conver;
  };
  let clear = () => {
    isSynced = false;
    conversations.length = 0;
  };
  let relpace = (conversation) => {
    let index = utils.find(conversations, ({ conversationType, conversationId }) => {
      return utils.isEqual(conversation.conversationType, conversationType) && utils.isEqual(conversation.conversationId, conversationId);
    });
    if(!utils.isEqual(index, -1)){
      utils.extend(conversations[index], conversation);
    }
    return conversations[index] || {};
  };
  let modify = (_conversations, props = {}) => {
    let list = [];
    _conversations = utils.isArray(_conversations) ? _conversations : [_conversations];
    utils.forEach(_conversations, (item) => {
      let conversation = getPer(item);
      if(!utils.isEmpty(conversation)){
        utils.extend(conversation, props);
        if(utils.isEmpty(props)){
          utils.extend(conversation, item);
        }
        let conver = relpace(conversation);
        list.push(conver);
      }else{
        list.push(item);
      }
    });
    return list;
  };
  let get = () => {
    return conversations;
  };
  let getPer = (conversation) => {
    let index = utils.find(conversations, ({ conversationType, conversationId }) => {
      return utils.isEqual(conversation.conversationType, conversationType) && utils.isEqual(conversation.conversationId, conversationId);
    });
    return conversations[index] || {};
  };
  let isSync = () => {
    return isSynced;
  };
  let read = (list, mentionClearType) => {
    list = utils.isArray(list) ? list : [list];
    let _list = [];
    utils.forEach(list, (item) => {
      let index = utils.find(conversations, ({ conversationType, conversationId }) => {
        return utils.isEqual(item.conversationType, conversationType) && utils.isEqual(item.conversationId, conversationId);
      });
      if(index > -1){
        conversations[index].latestReadIndex = item.unreadIndex;
        conversations[index].unreadCount = 0;
        if(mentionClearType == 0){
          conversations[index].mentions = {};
        }
        conversations[index].unreadTag = UNREAD_TAG.READ;
        _list.push(conversations[index]);
      }
    });
    return _list;
  };
  return {
    remove,
    update,
    clear,
    get,
    isSync,
    add,
    relpace,
    setSynced,
    modify,
    getPer,
    read,
    isExisted,
  };
}

// 特性检查
function checkUploadType(upload){
  upload = upload || {};
  let type = UPLOAD_TYPE.NONE;
  if(upload.QiniuError){
    type = UPLOAD_TYPE.QINIU;
  }
  if(upload.urllib){
    type = UPLOAD_TYPE.ALI;
  }
  if(upload && upload.name == 'S3Client'){
    type = UPLOAD_TYPE.S3;
  }
  if(upload && upload.name == 'minio'){
    type = UPLOAD_TYPE.MINIO;
  }
  return type;
}

function formatMediaMessage(message, url){
  let { name, content } = message;
  
  let _content = {};
  if(utils.isEqual(name, MESSAGE_TYPE.FILE)){
    let { file } = content;
    let size = file.size / 1000
    _content = { size, url };
    utils.extend(message.content, { size, url });
  }

  if(utils.isEqual(name, MESSAGE_TYPE.IMAGE)){
    let { height, width } = content;
    let direction = 'h';
    if(width > height){
      direction = 'w';
    }
    let thumbnail = `${url}&imageView2/2/${direction}/100`;
    _content = { thumbnail, url };
    utils.extend(message.content, { url, thumbnail });
  }

  if(utils.isInclude([MESSAGE_TYPE.VIDEO, MESSAGE_TYPE.VOICE], name)){
    utils.extend(message.content, { url });
  }

  return message;
}

function uploadThumbnail(upload, option, callback){
  if(typeof uni != 'undefined' && uni.compressImage){
    return uploadUniThumbnail(upload, option, callback);
  }
  uploadWebThumbnail(upload, option, callback);
}
function uploadUniThumbnail(upload, option, callback){
  let { type, content } = option;
  let uploader = Uploader(upload, { type });

  let { tempPath } = content;

  uni.compressImage({
    src: tempPath,
    quality: 25,
    success: res => {
      let callbacks = {
        onprogress: utils.noop,
        oncompleted: ({ url }) => {
          let error = null;
          uni.getImageInfo({
            src: tempPath,
            success: function (args) {
              callback(error, url, args);
            }
          });
        },
        onerror: (error) => {
          callback(error);
        }
      };
      uploader.exec({ tempPath: res.tempFilePath }, option, callbacks);
    }
  })
}


function uploadWebThumbnail(upload, option, callback){
  let { type, token, domain, file, url: uploadUrl } = option;
  let uploader = Uploader(upload, { type });
  uploader.compress(file, (tbFile, args) => {
    let content = { file: tbFile };
    let opts = { token, domain, url: uploadUrl, ...option, isUniWebThumbnail: true };
    let callbacks = {
      onprogress: utils.noop,
      oncompleted: ({ url }) => {
        let error = null;
        callback(error, url, {...args, isUniWebThumbnail: true});
      },
      onerror: (error) => {
        callback(error);
      }
    };
    uploader.exec(content, opts, callbacks);
  }, option);
}

function uploadFrame(upload, option, callback){
  if(isUni()){
    return uploadUniFrame(upload, option, callback);
  }
  uploadWebFrame(upload, option, callback);
}

//TODO: UniApp 截图视频首帧需特殊处理
function uploadUniFrame(upload, option, callback){
  let error = null;
  let url = '';
  callback(error, url, option.content);
}
function uploadWebFrame(upload, option, callback){
  let { type, token, domain, file, url: uploadUrl } = option;
  let uploader = Uploader(upload, { type });
  uploader.capture(file, (frameFile, args) => {
    let content = { file: frameFile };
    let opts = { token, domain, url: uploadUrl, ...option };
    let callbacks = {
      onprogress: utils.noop,
      oncompleted: ({ url }) => {
        let error = null;
        callback(error, url, args);
      },
      onerror: (error) => {
        callback(error);
      }
    };
    uploader.exec(content, opts, callbacks);
  }, option);
}

function getDraftKey(item){
  return `draft_${item.conversationType}_${item.conversationId}`;
}
function formatUser(user){
  let exts = utils.toObject(user.extFields);
  return {
    id: user.userId,
    name: user.nickname || "",
    portrait: user.userPortrait || "",
    updatedTime: user.updatedTime || 0,
    exts: exts || {},
    type: user.userType || 0,
  };
}
function formatGroupMember(member){
  if(!member){
    member = { extFields: [] }
  }
  let exts = utils.toObject(member.extFields);
  return {
    name: member.grpDisplayName || "",
    updatedTime: member.updatedTime || 0,
    exts: exts || {},
  };
}
function toKVs(obj){
  let arrs = [];
  utils.forEach(obj, (value, key) => {
    arrs.push({key, value});
  });
  return arrs;
}
function formatProvider(funcs, instance){
  let invokes = {};

  utils.forEach(funcs, (name) => {
    invokes[name] = function(){
      let args = [];
      for(let i = 0; i < arguments.length; i++){
        let item = arguments[i], itemNew = {};
        itemNew = utils.isArray(item) ? item : clone(item);
        args.push(itemNew);
      }
      let func = instance[name];
      if(func){
        return func(...args);
      }
      return Promise.reject(ErrorType.SDK_FUNC_NOT_DEFINED);
    };
  });
  return invokes;
}
function clone(item){
  let loop = (obj) => {
    let newObj = obj;
    utils.forEach(obj, (v, k) => {
      // 递归循环中包含 File 对象直接跳过，File 对象不能 clone
      if(utils.isObject(v)){
        newObj[k] = loop(v);
      }else if(utils.isArray(v)){
        newObj[k] = utils.clone(v);
      }else{
        newObj[k] = v;
      }
    });
    return newObj;
  }
  let result = loop(item);
  return result;
}
function isDesktop(){
  return typeof JGChatPCClient != 'undefined';
}
function getSessionId(){
  return 's-xxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};
function getTokenKey(appkey, token){
  return `${appkey}_${token}`
}

function genUId(){
  return 'xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function getClientSession(){
  let clientSession = JSessionStorage.getItem(STORAGE.CLIENT_SESSION);
  if(!clientSession){
    clientSession = genUId();
    JSessionStorage.setItem(STORAGE.CLIENT_SESSION, clientSession);
  }
  return clientSession;
}
function encrypto(arrs, xors){
  let list = [];
  arrs.forEach((v, index) => {
    let i = index % 8;
    let _v = v ^ xors[i];
    list.push(_v);
  });
  return new Uint8Array(list);
}

function decrypto(arrs, xors){
  let list = [];
  arrs.forEach((v, index) => {
    let i = index % 8;
    let _v = v ^ xors[i];
    list.push(_v);
  });
  return new Uint8Array(list);
}

function reportLogs({ logger, params }){
  return logger.report({ ...params });
}

function isUni(){
  return typeof uni != 'undefined';
}
async function signatureWithNonce(nonce, timestamp, signKey) {
    nonce = nonce || '';
    timestamp = timestamp || '';
    signKey = signKey || '';

    let raw = `${nonce}${timestamp}${signKey}`;
    let rawData = new TextEncoder().encode(raw);
    let keyData = new TextEncoder().encode(signKey);

    let cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    let signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, rawData);
    let hashArray = Array.from(new Uint8Array(signatureBuffer));
    let signature = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return signature;
}

export default {
  check,
  getNum,
  getTokenKey,
  getNaviStorageKey,
  initSyncTime,
  updateSyncTime,
  getError,
  ConversationUtils,
  checkUploadType,
  formatMediaMessage,
  uploadThumbnail,
  uploadFrame,
  getDraftKey,
  formatUser,
  toKVs,
  registerMessage,
  getMsgFlag,
  formatter,
  formatProvider,
  isDesktop,
  getSessionId,
  getClientSession,
  encrypto,
  decrypto,
  reportLogs,
  isUni,
  formatGroupMember,
  signatureWithNonce
}
