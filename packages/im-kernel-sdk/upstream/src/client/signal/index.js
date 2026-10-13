import { COMMAND_TOPICS, SIGNAL_CMD, SIGNAL_NAME, EVENT, ErrorType, LOG_MODULE, RTC_CHANNEL } from "../../enum";
import utils from "../../utils";
import common from "../../common/common";
export default function({ io, emitter, logger }){
  
  io.on(SIGNAL_NAME.CMD_RTC_INVITE_EVENT, (notify) => {
    return emitter.emit(EVENT.RTC_INVITE_EVENT, notify);
  });
  io.on(SIGNAL_NAME.CMD_RTC_ROOM_EVENT, (notify) => {
    return emitter.emit(EVENT.RTC_ROOM_EVENT, notify);
  });

  /* let room = { type, id, members } */ 
  let createRTCRoom = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_CREATE_ROOM,
        user: user,
        room
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ room });
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let room = { type, id, members } */ 
  let joinRTCRoom = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_JOIN_ROOM,
        user: user,
        room
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ room });
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let room = { type, id } */ 
  let quitRTCRoom = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_QUIT_ROOM,
        user: user,
        room
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ room });
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let options = { roomId } */ 
  let acceptRTC = (options) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_ACCEPT,
        user: user,
        ...options
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve(result);
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };
  /* let room = { id }*/ 
  let hangupRTC = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_HANGUP,
        user: user,
        roomId: room.id
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve();
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let room = { id } */ 
  let queryRTCRoom = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        topic: COMMAND_TOPICS.RTC_QRY_ROOM,
        user: user,
        room
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code, room: _room } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ ..._room });
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let room = { id } */ 
  let pingRTC = (room) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        user: user,
        room: room,
        topic: COMMAND_TOPICS.RTC_PING
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve({ room });
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  /* let options = { 
    roomId: '',
    roomType: roomType,
    memberIds: memberIds,
    channel: 0,
    rtcMediaType: 1,
    ext: '',
    attachedConversation: {
      conversationType: 1,
      conversationId: '',
      subChannel: ''
    }
  */ 
  let inviteRTC = (options) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        channel: RTC_CHANNEL.ZEGO,
        ...options,
        topic: COMMAND_TOPICS.RTC_INVITE,
        user: user,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve(result);
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };
  /* 
    let options = {
      roomId: '',
      memberId: '',
      state: CALL_STATE.INCOMMING    
    };
  */
  let updateRTCState = (options) => {
    return utils.deferred((resolve, reject) => {
      let user = io.getCurrentUser();
      let data = {
        ...options,
        topic: COMMAND_TOPICS.RTC_UPDATE_STATE,
      };
      io.sendCommand(SIGNAL_CMD.QUERY, data, (result) => {
        let { code } = result;
        if(utils.isEqual(ErrorType.COMMAND_SUCCESS.code, code)){
          return resolve();
        }
        let error = common.getError(code);
        reject(error);
      });
    });
  };

  return {
    createRTCRoom,
    joinRTCRoom,
    quitRTCRoom,
    queryRTCRoom,
    pingRTC,
    inviteRTC,
    acceptRTC,
    hangupRTC,
    updateRTCState,
    $emitter: emitter,
    isConnected: io.isConnected,
    getCurrentUser: io.getCurrentUser,
  }
}