import { SIGNAL_NAME, EVENT, CONNECT_STATE, ErrorType, FUNC_PARAM_CHECKER, LOG_MODULE, STORAGE, COMMAND_TOPICS, SIGNAL_CMD } from "../../enum";
import utils from "../../utils";
import Storage from "../../common/storage";
import common from "../../common/common";

export default function(io, emitter, logger){
  let connectState = CONNECT_STATE.DISCONNECTED;
  
  io.on(SIGNAL_NAME.CONN_CHANGED, (data) => {
    let { state, code = '', user = {} } = data;
    logger.info({ tag: LOG_MODULE.CON_STATUS, state, code, userId: user.id });
    emitter.emit(EVENT.STATE_CHANGED, data);
  });

  let connect = (user) =>{
    return utils.deferred( async (resolve, reject) => {
      let error = common.check(io, user, FUNC_PARAM_CHECKER.CONNECT, true);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
     
      let device = await getDevice();

      let { token = '' } = user;
      token = token.trim();
      user = utils.extend(user, { token, deviceId: device.id });

      if(!io.isNeedConnect()){
        return reject(ErrorType.REPREAT_CONNECTION);
      }
      
      logger.info({ tag: LOG_MODULE.CON_CONNECT });

      io.connect(user, ({ error, user, next }) => {
        let { code, msg } = error;
        if(utils.isEqual(code, ErrorType.CONNECT_SUCCESS.code)){
          let config = io.getConfig();
          if(!config.isPC){
            next();
            let { id, name, exts, updatedTime, portrait, token } = user;
            return resolve(user)
          }
          
          utils.extend(user, { code, next });
          return resolve(user);
        }
        reject({ code, msg });
      });
    });
  };

  let disconnect = () => {
    return utils.deferred((resolve) => {
      logger.info({ tag: LOG_MODULE.CON_DISCONNECT });
      io.disconnect();
      let config = io.getConfig();
      if(!config.isPC){
        io.emit(SIGNAL_NAME.CLIENT_CLEAR_MEMORY_CACHE, {});
      }
      resolve();
    });
  };

  let getDevice = () => {
    return utils.deferred((resolve, reject) => {
      let device = Storage.get(STORAGE.APP_DEVICE);
      let id = device.id || '';
      if(utils.isEmpty(id)){
        id = utils.getDeviceID();
        Storage.set(STORAGE.APP_DEVICE, { id });
      }
      return resolve({ id });
    });
  };

  let setServerUrlProider = (callback) => {
    if(!utils.isFunction(callback)){
      callback = utils.noop;
    }
    io.setServerUrlProider(callback);
  };

  let uploadPushToken = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.UPLOAD_PUSH_TOKEN);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.UPLOAD_PUSH_TOKEN,
        ...params,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve();
      });
    });
  }

  let switchPush = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.SWITCH_PUSH);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.SWITCH_PUSH,
        ...params,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve();
      });
    });
  }

  /**
   * var params = {
   *    userIds: []
   * };
   */ 
  let getUserStatus = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_USER_STATUS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let { userIds } = params;
      userIds = utils.map(userIds, (userId) => {
        return userId.toString();
      });
      let data = {
        topic: COMMAND_TOPICS.GET_USER_STATUS,
        userIds,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, users } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({
          users
        });
      });
    });
  }

  /**
   * var params = {
   *    userIds: []
   * };
   */
  let subUserStatus = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.SUB_USER_STATUS);
      if(!utils.isEmpty(error)){
        return reject(error);
      }
      let { id: userId } = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.SUB_USER_STATUS,
        ...params,
        userId
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, msg, users } = result;
        if(!utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return reject({code, msg});
        }
        resolve({ users });
      });
    });
  }


  return {
    connect,
    disconnect,
    setServerUrlProider,
    getDevice: getDevice,
    isNeedConnect: io.isNeedConnect,
    isConnected: io.isConnected,
    getCurrentUser: io.getCurrentUser,
    setConnectParams: io.setConnectParams,
    uploadPushToken: uploadPushToken,
    switchPush: switchPush,
    getUserStatus,
    subUserStatus,
  }
}