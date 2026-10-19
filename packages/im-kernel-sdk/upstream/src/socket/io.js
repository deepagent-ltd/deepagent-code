import { deviceConfig, deviceError, deviceEndpoints, initialConnectExt, signConnect, signHttp } from "../delivery/device-auth";
import LiveRead from "../delivery/live-read";
import Emitter from "../common/emmit";
import utils from "../utils";
import Storage from "../common/storage";
import Proto from "./proto";
import { DISCONNECT_TYPE, CONNECT_STATE, SIGNAL_NAME, SIGNAL_CMD, QOS, NOTIFY_TYPE, ErrorType, HEART_TIMEOUT, CONNECT_ACK_INDEX, PONG_INDEX, COMMAND_TOPICS, CONVERATION_TYPE, SYNC_MESSAGE_TIME, STORAGE, PLATFORM, CONNECT_TOOL, LOG_MODULE, STREAM_EVENT } from "../enum";
import BufferEncoder from "./encoder/encoder";
import BufferDecoder from "./decoder/decoder";
import Network from "../common/network";
import Cache from "../common/cache";
import common from "../common/common";

import MessageSyncer from "./syncer/message-syncer";
import ChatroomSyncer from "./syncer/chatroom-syncer";
import ChatroomAttrSyncer from "./syncer/chatroom-attr-syncer";
import TagSyncer from "./syncer/tag-syncer";

import Timer from "../common/timer";
import Counter from "../common/counter";
import { topics, validateResult, deliveryError } from "../delivery/contract";
import { VERSION } from "./version";
import LiveOrigin from "../delivery/live-origin";
import CurrentLink from "../delivery/current-link";

import JWebSocket from "../provoider/websocket/index"

import NetworkWatcher from "../common/network-watcher";
/* 
  fileCompressLimit: 图片缩略图压缩限制，小于设置数值将不执行压缩，单位 KB
  config = { appkey, nav, isSync, upload, uploadType, fileCompressLimit, connectHeaders, signKey }
*/
export default function IO(config){
  const protectedReader = config.protectedDeliveryReader === true;
  const deviceAuth = deviceConfig(config.protectedDeviceAuth);
  let deviceHandshake;
  let pendingConnect;
  let emitter = Emitter();
  let { appkey, navList, serverList = [], isSync = true, reconnectCount = 100, logger } = config;
  if(!utils.isArray(navList)){
    navList = ['https://nav.fake.com'];
  }
  /* 
    pool = {

    }
  */
  let wsPools = [];
  let ws = {};
  let io = {};
  let currentDomain = '';
  let deliveryNavigator = '';

  let serverProviderCallback = utils.noop;

  let cache = Cache();

  let decoder = BufferDecoder(cache, io);
  let encoder = BufferEncoder(cache, io);

  let timer = Timer({ timeout: HEART_TIMEOUT });
  let syncTimer = Timer({ timeout: SYNC_MESSAGE_TIME });

  let isCurrentFirstConnect = true;

  let connectionState = CONNECT_STATE.DISCONNECTED;
  let deliveryEpoch = 0;
  let deliveryLiveCapability = false;
  let deliveryReceiverCapability = false;
  const deliveryInvalidators = new Set();
  let deliveryIndex = 65535;
  const deliveryPending = new Map();
  const invalidateDelivery = () => {
    const retainedConnect = pendingConnect;
    pendingConnect = undefined;
    retainedConnect?.finish({ error: ErrorType.COMMAND_FAILED });
    deliveryEpoch++;
    deviceHandshake = undefined;
    deliveryLiveCapability = false;
    deliveryReceiverCapability = false;
    if (liveRead) liveRead.clear();
    deliveryNavigator = '';
    for (const invalidate of Array.from(deliveryInvalidators)) invalidate();
    for (const pending of Array.from(deliveryPending.values())) pending.finish({ code: 30001,
      deliveryError: deliveryError(pending.operation, pending.dispatched && ["send", "mark_read"].includes(pending.operation) ? "unknown" : "disconnected") });
  };
  let reconnectErrors = [
    ErrorType.CONNECT_APPKEY_IS_REQUIRE.code,
    ErrorType.CONNECT_TOKEN_NOT_EXISTS.code,
    ErrorType.CONNECT_APPKEY_NOT_EXISTS.code,
    ErrorType.CONNECT_TOKEN_ILLEGAL.code,
    ErrorType.CONNECT_TOKEN_UNAUTHORIZED.code,
    ErrorType.CONNECT_TOKEN_EXPIRE.code,
    ErrorType.CONNECT_APP_BLOCKED.code,
    ErrorType.CONNECT_USER_BLOCKED.code,
    ErrorType.CONNECT_USER_KICKED.code,
    ErrorType.CONNECT_USER_LOGOUT.code,
    11025, 11026, 11027, 11028,
  ]
  let updateState = (result) => {
    connectionState = result.state;
    emitter.emit(SIGNAL_NAME.CONN_CHANGED, { ...result });
  }

  let clearHeart = () => {
    timer.pause();
    syncTimer.pause();
  };

  function forceReconnect(){
    let user = getCurrentUser({ ignores: [] });
    let index = utils.find(wsPools, (_ws) => {
      return _ws === ws;
    });
    let currentWs = wsPools[index] || {};
    disconnect();
    currentWs.onmessage = utils.noop;
    currentWs.onclose = utils.noop;
    currentWs.onerror = utils.noop;
    cache.remove(CONNECT_TOOL.RECONNECT_COUNT);
    cache.remove(CONNECT_TOOL.RECONNECT_FREQUENCY);
    return reconnect(user, ({ next }) => {
      next = next || utils.noop;
      next();
    });
  };

  let networkWatcher = NetworkWatcher({
    ononline: () => {
      // if(ws.readyState == 3){
        forceReconnect();
      // }
    }
  });
  networkWatcher.watch();

  let isUserDisconnected = false;
  let onDisconnect = (result = {}) => {
    invalidateDelivery();
    let { code } = result;
    let cbs = cache.getAll();
    utils.forEach(cbs, (val, key) => {
      if(!utils.isNaN(key)){
        let { callback } = val;
        callback = callback || utils.noop;
        callback(ErrorType.COMMAND_FAILED);
        cache.remove(key);
      }
    });
    
    if(!isUserDisconnected && !utils.isInclude(reconnectErrors, code) && !utils.isEqual(connectionState, CONNECT_STATE.DISCONNECTED)){
      let user = getCurrentUser({ ignores: [] });
      clearHeart();
      return reconnect(user, ({ next }) => {
        next = next || utils.noop;
        next();
      });
    }

    if(!utils.isEqual(connectionState, CONNECT_STATE.DISCONNECTED)){
      let user = getCurrentUser();
      updateState({ state: CONNECT_STATE.DISCONNECTED, ...result, user});
      clearHeart();
    }
  };
  let currentUserInfo = {};
  const liveOrigin = LiveOrigin(() => protectedReader && isConnected() &&
    typeof currentUserInfo.id === "string" && currentUserInfo.id.length > 0
    ? { generation: deliveryEpoch, receiverID: currentUserInfo.id } : undefined);
  const currentLink = CurrentLink(() => protectedReader && isConnected() && ws &&
    typeof currentUserInfo.id === "string" && currentUserInfo.id.length > 0
    ? { socket: ws, generation: deliveryEpoch, receiverID: currentUserInfo.id } : undefined);
  const liveRead = LiveRead(() => protectedReader && deliveryLiveCapability && isConnected() && ws && currentUserInfo.id
    ? { socket: ws, generation: deliveryEpoch, receiverID: currentUserInfo.id } : undefined, liveOrigin,
    (request, page) => validateResult("qry_delivery_messages", request, page));
  let setCurrentUser = (user) => {
    utils.extend(currentUserInfo, user);
  };
  let clearLocalServers = (userId) => {
    let key = common.getNaviStorageKey(appkey, userId);
    Storage.remove(key);
  };
  let connect = ({ token, deviceId, _isReconnect = false }, callback) => {
    clearTimeout(reconnectTimer);
    invalidateDelivery();
    const deliveryConnectEpoch = deliveryEpoch;
    const originalCallback = callback;
    let settled = false;
    callback = (result) => {
      if (settled) return;
      settled = true;
      if (pendingConnect?.finish === callback) pendingConnect = undefined;
      originalCallback(result);
    };
    pendingConnect = { epoch: deliveryConnectEpoch, finish: callback };
    if(utils.isEmpty(cache.get(STORAGE.CRYPTO_RANDOM))){
      cache.set(STORAGE.CRYPTO_RANDOM, utils.getRandoms(8));
    }
    let _state = _isReconnect ?  CONNECT_STATE.RECONNECTING : CONNECT_STATE.CONNECTING;
    updateState({ state: _state });
    async function smack({ servers, userId }){
      if (deliveryEpoch !== deliveryConnectEpoch) return callback({ error: ErrorType.COMMAND_FAILED });
      setCurrentUser({ id: userId, token, deviceId });

      cache.set(SIGNAL_NAME.S_CONNECT_ACK, callback);

      let noceNum = utils.getRandoms(5).join('');
      let timestamp = Date.now();
      let signKey = config.signKey || '';
      let signature = '';
      if(!utils.isEmpty(signKey)){
        signature = await common.signatureWithNonce(noceNum, timestamp, signKey);
      }
      let headers = {
        'x-appkey': appkey,
        'x-token': token,
        'x-platform': 'Web',
        'x-version': VERSION,
        'x-device': utils.getBrowserVersion(),
        'x-device_id': deviceId,
        'X-Nonce': noceNum,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      };
      let customHeaders = config.connectHeaders || {};
      customHeaders = utils.extend(customHeaders, headers);
      let options = {
        headers: customHeaders
      };

      Network.detect(servers, (domain, error) => {
        if (deliveryEpoch !== deliveryConnectEpoch) return callback({ error: ErrorType.COMMAND_FAILED });
        if (deviceAuth && error) {
          updateState({ state: CONNECT_STATE.CONNECT_FAILED, code: 11025 });
          return callback({ error: deviceError(11025) });
        }
        // 如果嗅探失败，返回连接断开，同时清理已缓存的 CMP 地址
        if(error && utils.isEqual(error.status, 200)){
          serverProviderCallback((result) => {
            result = utils.isObject(result) ? result : {};
            let { serverUrls } = result;
            serverUrls = serverUrls || [];
            if(serverUrls.length > 0){
              serverList = serverUrls.concat(serverUrls);
              forceReconnect();
            }
          });
          clearLocalServers(userId);
          return reconnect({ token, userId, deviceId }, callback);
        }
        if(error && utils.isEqual(403, error.status)){
          updateState({ state: CONNECT_STATE.DISCONNECTED, code: ErrorType.CONNECT_FORBIDDEN });
          return;
        }
        currentDomain = domain;
        domain = domain.replace(/http:\/\/|https:\/\/|file:\/\/|wss:\/\/|ws:\/\//g, '');
        let { ws: protocol } = utils.getProtocol(currentDomain);
        let url = deviceAuth ? deviceEndpoints(deviceAuth, currentDomain, currentDomain).socket : `${protocol}//${domain}/im`;
        ws = new JWebSocket(url);
        const openedSocket = ws;
        wsPools.push(ws);
        logger.info({ tag: LOG_MODULE.WS_CONNECT});

        ws.onopen = function(){
          if (ws !== openedSocket || deliveryEpoch !== deliveryConnectEpoch) return;
          let platform = PLATFORM.WEB;
          if(!protectedReader && common.isDesktop()){
            platform = PLATFORM.DESKTOP;
          }
          let clientSession = common.getClientSession();
          if (deviceAuth) deviceHandshake = { socket: openedSocket, epoch: deliveryConnectEpoch, token, platform, clientSession, phase: "requested" };
          sendCommand(SIGNAL_CMD.CONNECT, { appkey, token, deviceId, platform, clientSession, sdkVersion: VERSION,
            ...(deviceAuth ? { ext: initialConnectExt() } : {}) });
          wsPools = utils.filter(wsPools, (_ws) => {
            return _ws.readyState != 3;
          });
        };
        ws.onclose = (e) => {
          if (ws !== openedSocket || deliveryEpoch !== deliveryConnectEpoch) return;
          onDisconnect({ type: DISCONNECT_TYPE.CLOSE });
        };
        ws.onerror = () => {
          if (ws !== openedSocket || deliveryEpoch !== deliveryConnectEpoch) return;
          onDisconnect({ type: DISCONNECT_TYPE.ERROR });
        };
        ws.onmessage = function({ data }){
          if (ws !== openedSocket || deliveryEpoch !== deliveryConnectEpoch) return;
          // 需要修改在适配层处理
          if(common.isUni()){
            bufferHandler(data, openedSocket, deliveryConnectEpoch);
          }else{
            let reader = new FileReader();
            reader.onload = function() {
              if (ws === openedSocket && deliveryEpoch === deliveryConnectEpoch) bufferHandler(this.result, openedSocket, deliveryConnectEpoch);
            }
            reader.readAsArrayBuffer(data);
          }
        };
      }, deviceAuth ? { deviceAuth, navigator: deliveryNavigator || navList[0],
        current: () => deliveryEpoch === deliveryConnectEpoch } : options);
    }
    if(!utils.isEmpty(serverList)){
      return smack({ servers: serverList })
    }
    return Network.getNavis(navList, { appkey, token, logger, deviceAuth, sourceEpoch: deliveryConnectEpoch, current: () => deliveryEpoch === deliveryConnectEpoch }, (result) => {
      let { code, servers, userId, url } = result;

      if(!utils.isEqual(code, ErrorType.COMMAND_SUCCESS.code)){
        let error = common.getError(code);
        clearLocalServers(userId);
        // 网络异常 code 为空，通过 code 检测是否为网络异常
        if(!code){
          error = ErrorType.IM_SERVER_CONNECT_ERROR;
        }
        updateState({ state: CONNECT_STATE.DISCONNECTED, code: error.code });
        return callback({ error });
      }
      if (deliveryEpoch !== deliveryConnectEpoch) return;
      deliveryNavigator = typeof url === "string" ? url : "";
      smack({ servers, userId });
    });
  };
  
  let reconnectTimer = 0;
  let reconnect = ({ token, userId, deviceId }, callback) => {
    clearTimeout(reconnectTimer);

    logger.info({ tag: LOG_MODULE.CON_RECONNECT, userId, deviceId });

    let rCountObj = cache.get(CONNECT_TOOL.RECONNECT_COUNT);
    let count = rCountObj.count || 1;
    let isTimeout = count > reconnectCount;
    if(isTimeout){
      cache.remove(CONNECT_TOOL.RECONNECT_COUNT);
      cache.remove(CONNECT_TOOL.RECONNECT_FREQUENCY);
      return updateState({ state: CONNECT_STATE.DISCONNECTED, code: ErrorType.IM_SERVER_CONNECT_ERROR.code })
    }

    let reconnectOpt = cache.get(CONNECT_TOOL.RECONNECT_FREQUENCY);
    let frequency = reconnectOpt.frequency || 1;
    let msec = frequency * 1000;
    reconnectTimer = setTimeout(() => {
      
      count += 1;
      cache.set(CONNECT_TOOL.RECONNECT_COUNT, { count });

      frequency = frequency * 2;
      cache.set(CONNECT_TOOL.RECONNECT_FREQUENCY, { frequency });

      connect({ token, userId, deviceId, _isReconnect: true }, (result) => {
        let { error } = result;
        if(utils.isEqual(error.code, ErrorType.COMMAND_SUCCESS.code)){
          emitter.emit(SIGNAL_NAME.CMD_CHATROOM_REJOIN, {});
        }
        callback(result);
      });
    }, msec)
  }
  let PingTimeouts = [];

  let disconnect = () => {
    if(ws){
      ws.close && ws.close();
    }
    timer.pause();
    syncTimer.pause();
    
    PingTimeouts.length = 0;
  };

  let userDisconnect = () => {
    clearTimeout(reconnectTimer);
    invalidateDelivery();
    isUserDisconnected = true;
    connectionState = CONNECT_STATE.DISCONNECTED;
    disconnect();
  };

  let sendCommand = async (cmd, data, callback) => {
    callback = callback || utils.noop;
    const deliveryTopic = cmd === SIGNAL_CMD.QUERY && Object.prototype.hasOwnProperty.call(topics, data.topic);
    const protectedSend = cmd === SIGNAL_CMD.PUBLISH && data.deliveryVersion === 1;
    const selfInfo = cmd === SIGNAL_CMD.QUERY && data.topic === COMMAND_TOPICS.GET_USER_INFO && data.userId === currentUserInfo.id;
    if (protectedReader && !deliveryTopic && !protectedSend && !selfInfo && ![SIGNAL_CMD.CONNECT, SIGNAL_CMD.PING].includes(cmd))
      return callback({ code: 30001, deliveryError: deliveryError(data.topic || String(cmd), "legacy_api_disabled") });
    let index = common.getNum();
    if(utils.isEqual(cmd, SIGNAL_CMD.CONNECT)){
      index = CONNECT_ACK_INDEX;
    }
    if(utils.isEqual(cmd, SIGNAL_CMD.PING)){
      index = PONG_INDEX;
    }
    const protectedCall = cmd === SIGNAL_CMD.QUERY && topics[data.topic] || cmd === SIGNAL_CMD.PUBLISH && data.deliveryVersion === 1;
    const operation = cmd === SIGNAL_CMD.PUBLISH ? "send" : topics[data.topic]?.[0];
    const openedSocket = ws, generation = deliveryEpoch;
    const counter = Counter({ cmd, ...(protectedCall ? { timeout: 15000 } : deviceAuth && cmd === SIGNAL_CMD.CONNECT ? { timeout: 10000 } : {}) });
    if (protectedCall) {
      if (deliveryPending.size + liveRead.pending() >= 8 || deliveryIndex >= 2147483647) return callback({ code: 30001,
        deliveryError: deliveryError(operation, "capacity") });
      if (!isConnected()) return callback({ code: 30001, deliveryError: deliveryError(operation, "disconnected") });
      index = ++deliveryIndex;
      const original = callback;
      callback = result => {
        if (!deliveryPending.has(index)) return;
        deliveryPending.delete(index); counter.clear(); cache.remove(index);
        original(result);
      };
      deliveryPending.set(index, { finish: callback, operation, dispatched: false });
      counter.start(() => callback({ code: 30001, deliveryError: deliveryError(operation, operation === "mark_read" || operation === "send" ? "unknown" : "transport_timeout") }));
    }
    let buffer;
    try { buffer = await encoder.encode(cmd, { callback, data, index, counter }); }
    catch (error) {
      if (!protectedCall) throw error;
      callback({ code: 30001, deliveryError: deliveryError(operation, "invalid_request") });
      return;
    }
    if (deviceAuth && (generation !== deliveryEpoch || ws !== openedSocket)) { if (cache.get(index).counter === counter) cache.remove(index); return; }
    if (protectedCall && (!deliveryPending.has(index) || generation !== deliveryEpoch || ws !== openedSocket)) {
      cache.remove(index);
      callback({ code: 30001, deliveryError: deliveryError(operation, "disconnected") });
      return;
    }
    if(ws.readyState != 1){
      disconnect();
      return callback(ErrorType.COMMAND_FAILED);
    }
    if (protectedCall) deliveryPending.get(index).dispatched = true;
    try { ws.send(buffer); }
    catch (error) {
      if (!protectedCall) throw error;
      callback({ code: 30001, deliveryError: deliveryError(operation, ["send", "mark_read"].includes(operation) ? "unknown" : "disconnected") });
      return;
    }
    let _data = utils.clone(data);
    delete _data.messages;
    if(_data.user){
      _data.user = { id: _data.user.id };
    }
    logger.info(protectedCall || cmd === SIGNAL_CMD.CONNECT ? { tag: LOG_MODULE.WS_SEND, cmd, topic: data.topic, bytes: buffer.length } : { tag: LOG_MODULE.WS_SEND, cmd, ..._data });

    if(!protectedCall && !utils.isEqual(SIGNAL_CMD.PUBLISH_ACK, cmd)){
      // 请求发出后开始计时，一定时间内中未响应认为连接异常，断开连接，counter 定时器在收到 ack 后清除
      counter.start(({ cmd: _cmd }) => {
        // PING 三次未响应后认为网络异常，向业务层抛出网络异常状态，PingTimeouts 在收到 PONG 后进行 reset
        if(utils.isEqual(_cmd, SIGNAL_CMD.PING) && PingTimeouts.length < 3){
          return PingTimeouts.push({ cmd: _cmd });
        }
        disconnect();
        callback(ErrorType.COMMAND_FAILED);
      });
    }
  };
  
  let messageSyncer = MessageSyncer(sendCommand, emitter, io, { logger });
  let chatroomSyncer = ChatroomSyncer(sendCommand, emitter, io, { logger });
  let chatroomAttrSyncer = ChatroomAttrSyncer(sendCommand, emitter, io, { logger });
  let tagSyncer = TagSyncer(sendCommand, emitter, io, { logger });

  let bufferHandler = async (buffer, openedSocket = ws, sourceEpoch = deliveryEpoch) => {
    if (openedSocket !== ws || sourceEpoch !== deliveryEpoch) return;
    let decoded;
    try {
      // Legacy publish decoders may perform lookups before producing events.
      // Drop the outer envelope before those decoders can observe its body.
      if (protectedReader) {
        const envelope = Proto.lookup("codec.ImWebsocketMsg").decode(new Uint8Array(buffer));
        if (envelope.cmd === SIGNAL_CMD.PUBLISH) {
          liveOrigin.publish(common.decrypto(envelope.payload, cache.get(STORAGE.CRYPTO_RANDOM)));
          return;
        }
      }
      decoded = await decoder.decode(buffer);
    }
    catch (error) {
      for (const pending of Array.from(deliveryPending.values())) pending.finish({ code: 30001,
        deliveryError: deliveryError(pending.operation, "invalid_response") });
      disconnect();
      return;
    }
    if (openedSocket !== ws || sourceEpoch !== deliveryEpoch) return;
    let { cmd, result, name } = decoded;
    let { index } = result;
    // Protected indices never wrap or overlap the legacy 16-bit range. A late
    // ACK has no remaining callback and cannot settle a future request.
    if (index > 65535 && !deliveryPending.has(index)) return;
    let { callback, data, counter, topic } = cache.get(index);

    logger.info({ tag: LOG_MODULE.WS_RECEIVE, cmd, code: result.code, topic });
    
    // 清空计时器，与 counter.start 对应
    if(counter){
      counter.clear();
      PingTimeouts.length = 0;
    }
    if(utils.isEqual(name, SIGNAL_NAME.S_CHATROOM_USER_NTF)){
      let { chatroomId, time, type, userId } = result;
      emitter.emit(SIGNAL_NAME.CMD_CHATROOM_EVENT, { chatroomId, time, type, userId });
    }
    
    if(utils.isEqual(name, SIGNAL_NAME.S_STREAM_EVENT)){
      let { conversationType, conversationId, messageId, streams } = result;
      
      let msgs = [], comps = [];
      utils.forEach(streams, (stream) => {
        let { event } = stream;
        if(utils.isEqual(event, STREAM_EVENT.MESSAGE)){
          msgs.push(stream);
        }
        if(utils.isEqual(event, STREAM_EVENT.FINISHED)){
          comps.push(stream);
        }
      });
      
      if(!utils.isEqual(msgs.length, 0)){
        let _result = { conversationType, conversationId, messageId, streams: msgs };
        emitter.emit(SIGNAL_NAME.CMD_STREAM_APPENDED, _result);
      }

      if(!utils.isEqual(comps.length, 0)){
        utils.forEach(comps, (stream) => {
          let _result = { conversationType, conversationId, messageId };
          emitter.emit(SIGNAL_NAME.CMD_STREAM_COMPLETED, _result);
        });
      }
    }

    if(utils.isEqual(name, SIGNAL_NAME.CMD_RECEIVED)){
      messageSyncer.exec({
        msg: result,
        name: name,
        $message: config.$message,
        user: { id: currentUserInfo.id }
      });
      // 连接成功后会开始计时 3 分钟拉取逻辑，如果收到直发或者 NTF 重新开始计算时长，连接断开后会清空计时
      syncTimer.reset();
    }

    if(utils.isEqual(name, SIGNAL_NAME.S_NTF)){
      let { type } = result;
      let _invokeItem = { msg: result, name: name, $message: config.$message, user: { id: currentUserInfo.id } }
     
      if (utils.isEqual(type, NOTIFY_TYPE.MSG)) {
        messageSyncer.exec(_invokeItem);
      }
      
      if (utils.isEqual(type, NOTIFY_TYPE.CHATROOM) || utils.isEqual(type, NOTIFY_TYPE.CHATROOM_DESTORY)) {
        chatroomSyncer.exec(_invokeItem);
      }

      if(utils.isEqual(type, NOTIFY_TYPE.CHATROOM_ATTR)){
        chatroomAttrSyncer.exec(_invokeItem);
      } 

      // 连接成功后会开始计时 3 分钟拉取逻辑，如果收到直发或者 NTF 重新开始计算时长，连接断开后会清空计时
      syncTimer.reset();
    }

    if(utils.isEqual(cmd, SIGNAL_CMD.PUBLISH_ACK)){
      utils.extend(data, result);
      let { conversationType } = data;
      // 单群聊和聊天室通知和拉取消息时间戳分开计算，只有发送单群聊消息更新发件箱
      if(!utils.isEqual(conversationType, CONVERATION_TYPE.CHATROOM)){
        common.updateSyncTime({ ...data, io});
      }
      callback(data);
    }
    if(utils.isEqual(cmd, SIGNAL_CMD.QUERY_ACK)){
      callback && callback(result);
    }
    if(utils.isEqual(cmd, SIGNAL_CMD.CONNECT_ACK)){
      
      isUserDisconnected = false;

      let _callback = cache.get(SIGNAL_NAME.S_CONNECT_ACK) || utils.noop;

      let { ack: { code, userId, timestamp: ackTime, mentionClearType } } = result;

      if (!deviceAuth && code === 11024) {
        isUserDisconnected = true; disconnect(); updateState({ state: CONNECT_STATE.CONNECT_FAILED, code: 11025 });
        _callback({ user: currentUserInfo, error: deviceError(11025) }); return;
      }
      if (deviceAuth) {
        const handshake = deviceHandshake;
        const current = () => handshake && deviceHandshake === handshake && handshake.socket === ws &&
          handshake.epoch === deliveryEpoch && handshake.token === currentUserInfo.token && ws.readyState === 1;
        if (code === 11024) {
          if (!current() || handshake.phase !== "requested") {
            isUserDisconnected = true; disconnect(); updateState({ state: CONNECT_STATE.CONNECT_FAILED, code: 11026 });
            _callback({ user: currentUserInfo, error: deviceError() }); return;
          }
          handshake.phase = "signing";
          try {
            const ext = await signConnect(deviceAuth, result.ack.ext, { audience: handshake.socket.url, appkey,
              token: handshake.token, connectionEpoch: handshake.epoch }, current);
            if (!current() || handshake.phase !== "signing") return;
            handshake.phase = "submitted";
            await sendCommand(SIGNAL_CMD.CONNECT, { appkey, token: handshake.token, deviceId: deviceAuth.jkt,
              platform: handshake.platform, clientSession: handshake.clientSession, sdkVersion: VERSION, ext });
          } catch (error) {
            if (!current()) return;
            const code = [11025, 11026, 11027, 11028].includes(error?.code) ? error.code : 11026;
            isUserDisconnected = true; disconnect(); updateState({ state: CONNECT_STATE.CONNECT_FAILED, code });
            _callback({ user: currentUserInfo, error: deviceError(code) });
          }
          return;
        }
        if (code === ErrorType.CONNECT_SUCCESS.code && (!current() || handshake.phase !== "submitted")) {
          isUserDisconnected = true; disconnect(); updateState({ state: CONNECT_STATE.CONNECT_FAILED, code: 11025 });
          _callback({ user: currentUserInfo, error: deviceError(11025) }); return;
        }
        if (code === ErrorType.CONNECT_SUCCESS.code) handshake.phase = "verified";
      }

      mentionClearType = mentionClearType || 0;
   
      let state = CONNECT_STATE.CONNECT_FAILED;
      let error = deviceAuth && code >= 11025 && code <= 11028 ? deviceError(code) : common.getError(code);
      if (deviceAuth && code !== ErrorType.CONNECT_SUCCESS.code) { isUserDisconnected = true; disconnect(); }
      if(utils.isEqual(code, ErrorType.CONNECT_SUCCESS.code)){
        // 会话列表 IM Server 维护，Web 端首次连接，不拉取离线消息，开发者只需要获取最新的会话列表即可
        if(isCurrentFirstConnect && !config.isPC){
          common.updateSyncTime({ sentTime: ackTime, isSender: true, io});
          common.updateSyncTime({ sentTime: ackTime, isSender: false, io});
        }
        isCurrentFirstConnect = false;

        deliveryLiveCapability = protectedReader && ['{"dacDeliveryLiveRead":1}','{"dacDeliveryLiveRead":2}'].includes(result.ack.ext);
        deliveryReceiverCapability = protectedReader && result.ack.ext === '{"dacDeliveryLiveRead":2}';
        state = CONNECT_STATE.CONNECTED;
        setCurrentUser({ id: userId });
        // 兼容只设置 IM Server 列表的情况
        Storage.setPrefix(`${appkey}_${userId}`);

        cache.remove(CONNECT_TOOL.RECONNECT_FREQUENCY);

        return getUserInfo({ id: userId }, ({ user: _user }) => {

          _user = _user || {};
          let name = _user.nickname;
          let portrait = _user.userPortrait;
          let exts = utils.toObject(_user.extFields);
          setCurrentUser({ name, portrait, exts, updatedTime: _user.updatedTime, mentionClearType });

          // 首先返回连接方法回调，确保 PC 端本地数据库同步信息时间戳优先更新至 localStorage 中
          _callback({ user: currentUserInfo, error, next: () => {
            updateState({ state, user: currentUserInfo });
          } });

          // 同步会话和同步消息顺序不能调整，保证先同步会话再同步消息，规避会话列表最后一条消息不是最新的
          if(config.isPC){
            let syncNext = () => {
              
              messageSyncer.exec({
                time: Storage.get(STORAGE.SYNC_CONVERSATION_TIME).time || 0,
                name: SIGNAL_NAME.S_SYNC_CONVERSATION_NTF,
                user: { id: currentUserInfo.id },
                $conversation: config.$conversation
              });
              
              syncMsgs();
              
              tagSyncer.exec({
                $conversation: config.$conversation
              });
            };

            // PC 中先连接后打开数据库，优先将本地数据库中的同步时间更新至 LocalStorage 中，避免换 Token 不换用户 Id 重复同步会话
            let syncTime = Storage.get(STORAGE.SYNC_CONVERSATION_TIME).time || 0;
            if(utils.isEqual(syncTime, 0)){
              config.$socket.openDB({ appkey, userId, token: currentUserInfo.token }).then(() => {
                syncNext();
              });
            }else{
              syncNext();
            }
          }else{
            syncMsgs();
          }
          timer.resume(() => {
            sendCommand(SIGNAL_CMD.PING, {});
            logger.info({ tag: LOG_MODULE.HB_START });
          });
          if (!protectedReader) syncTimer.resume(() => {
            messageSyncer.exec({
              msg: { type: NOTIFY_TYPE.MSG },
              name: SIGNAL_NAME.S_NTF,
              $message: config.$message,
              user: { id: currentUserInfo.id }
            });
          });
        });
      }
      if(utils.isEqual(code, ErrorType.CONNECT_SECURITY_DOMAIN_ERROR.code)){
        // 防止 WebScoket 断开自动重连
        isUserDisconnected = true;
      }
      updateState({ state, user: currentUserInfo, code });
      _callback({ user: currentUserInfo, error });
    }
    if(utils.isEqual(cmd, SIGNAL_CMD.DISCONNECT)){
      let { code, extra } = result;
      onDisconnect({ code, extra, type: DISCONNECT_TYPE.SERVER });
    }
    if(utils.isEqual(name, SIGNAL_NAME.S_PONG)){
      logger.info({ tag: LOG_MODULE.HB_STOP });
    }
    
    if(utils.isEqual(name, SIGNAL_NAME.S_RTC_INVITE_NTF)){
      emitter.emit(SIGNAL_NAME.CMD_RTC_INVITE_EVENT, result);
    }
    
    if(utils.isEqual(name, SIGNAL_NAME.S_RTC_ROOM_EVENT)){
      let { roomEventType, room, members, reason } = result;
      emitter.emit(SIGNAL_NAME.CMD_RTC_ROOM_EVENT, { roomEventType, room, members, reason });
    }

    cache.remove(index);
  }

  function syncMsgs(){
    if(!protectedReader && isSync){
      messageSyncer.exec({
        msg: { type: NOTIFY_TYPE.MSG },
        name: SIGNAL_NAME.S_NTF,
        $message: config.$message,
        user: { id: currentUserInfo.id }
      });
    }
  }

  let isConnected = () => {
    return utils.isEqual(connectionState, CONNECT_STATE.CONNECTED)
  };

  let isNeedConnect = () => {
    return utils.isEqual(connectionState, CONNECT_STATE.DISCONNECTED)
  }

  function getCurrentUser(options = {}){
    let { ignores = ['token'] } = options;
    let user = utils.clone(currentUserInfo);
    utils.forEach(ignores, (key) => {
      delete user[key];
    });
    return user;
  };

  function getConfig(){
    config.currentDomain = currentDomain;
    return config;
  };
  function setConfig(cfg){
    utils.extend(config, cfg);
    if (protectedReader) utils.extend(config, { protectedDeliveryReader: true, isSync: false, isPC: false });
  }
  function setConnectParams(signKey, headers){
    headers = headers || {};
    if(!utils.isObject(headers)){
      headers = {};
    }
    config.connectHeaders = headers;
    config.signKey = signKey;
  }
  function getUserInfo(user, callback){
    let data = {
      topic: COMMAND_TOPICS.GET_USER_INFO,
      userId: user.id
    };
    sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
      callback(result);
    });
  }
  
  utils.extend(io, { 
    getConfig,
    setConfig,
    setConnectParams,
    connect,
    disconnect: userDisconnect,
    sendCommand,
    isConnected,
    isNeedConnect,
    getCurrentUser,
    deliveryGeneration: () => deliveryEpoch,
    deviceHttpHeaders: (input) => signHttp(deviceAuth, input, () => input.currentSourceEpoch === deliveryEpoch &&
      input.credential === currentUserInfo.token && isConnected()),
    deliveryLiveReadAvailable: () => !!(protectedReader && deliveryLiveCapability && isConnected()),
    deliveryReceiverBaselineAvailable: () => !!(protectedReader && deliveryReceiverCapability && isConnected()),
    acceptDeliveryLiveRead: liveRead.accept,
    readDeliveryLiveCut: liveRead.cut,
    readDeliveryReceiverBaseline: liveRead.baseline,
    readDeliveryLivePage: liveRead.page,
    onProtectedLiveMessage: liveOrigin.subscribe,
    readProtectedLiveMessage: liveOrigin.read,
    captureProtectedCurrentLink: currentLink.capture,
    readProtectedCurrentLink: currentLink.read,
    deliveryMediaContext: () => isConnected() && deliveryNavigator && currentUserInfo.token ?
      Object.freeze({ generation: deliveryEpoch, navigator: deliveryNavigator, user: currentUserInfo.id, token: currentUserInfo.token }) : undefined,
    onDeliveryInvalidation: invalidate => { deliveryInvalidators.add(invalidate); return () => deliveryInvalidators.delete(invalidate); },
    setServerUrlProider: (callback) => {
      serverProviderCallback = callback;
    },
    getVersion: () => {
      return VERSION;
    },
    sync: (syncers) => {
      syncers = utils.isArray(syncers) ? syncers : [syncers];
      let config = getConfig();
      utils.forEach(syncers, (item) => {
        let _item = { ...item, $message: config.$message };
        let { msg: { type } } = item;
        if (utils.isEqual(type, NOTIFY_TYPE.CHATROOM)) {
          chatroomSyncer.exec(_item);
        }
        if(utils.isEqual(type, NOTIFY_TYPE.CHATROOM_ATTR)){
          chatroomAttrSyncer.exec(_item);
        } 
      });
    },
    ...emitter
  });
  return io;
}
