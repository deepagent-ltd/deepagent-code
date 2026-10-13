import { ErrorType, FUNC_PARAM_CHECKER, MOMENT_ORDER, COMMENT_ORDER, RESPONSE_CODE } from "../../enum";
import utils from "../../utils";
import jrequest from "../../provoider/request/index";
import common from "../../common/common";

export default function(io, emitter, logger) {

  let getRequestUrl = (url) => {
    let config = io.getConfig();
    let { currentDomain } = config;
    let { http: protocol } = utils.getProtocol(currentDomain);
    let domain = currentDomain.replace(/http:\/\/|https:\/\/|file:\/\/|wss:\/\/|ws:\/\//g, '');
    return `${protocol}//${domain}/${url}`;
  };

  let getRequestOptions = (method, data) => {
    let user = io.getCurrentUser({ ignores: [] });
    let { token } = user;
    let config = io.getConfig();
    let { appkey } = config;
    let result = {
      method
    };
    let headers = {
      'Appkey': appkey,
      'Authorization': token
    };
    if (method === 'POST') {
      headers = utils.extend(headers, {
        'Content-Type': 'application/json'
      });
      result = utils.extend(result, { body: utils.toJSON(data) })
    }
    result.headers = headers;
    return result;
  };
  
  /* 
    var params = {
      text: '',
      medias: [
        {
          "type":"image",
          "url":"xxx",
          "snapshot_url":"xxxx",
          "height":100,
          "width":100
        }
      ]
    };
  */
  let addMoment = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, FUNC_PARAM_CHECKER.ADD_MOMENT);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let { text, medias } = params;
      if(utils.isUndefined(text) && utils.isUndefined(medias)){
        return reject(ErrorType.MOMENT_ADD_PARAM_ERROR);
      }
      if(utils.isUndefined(text) && !utils.isArray(medias)){
        return reject(ErrorType.MOMENT_ADD_PARAM_MDL_ERROR);
      }
      if(utils.isUndefined(medias) && !utils.isUndefined(text)){
        text = text.toString();
      }
      let url = getRequestUrl('momentgateway/moments/add');
      let content = {
        text: text,
        medias: medias
      };
      let options = getRequestOptions('POST', {
        content: content
      });
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let moment = {
            ...data,
            content: content,
          };
          moment = momentFormat(moment);
          resolve(moment);
        },
        fail: reject
      });
    });
  };

  /* 
    var params = {
      momentIds: [];
    };
  */
  let removeMoment = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.REMOVE_MOMENT);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let url = getRequestUrl('momentgateway/moments/del');
      let { momentIds } = params;
      let options = getRequestOptions('POST', {
        moment_ids: momentIds
      });
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          resolve();
        },
        fail: reject
      });
    });
  };

  let getMoments = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, {}, FUNC_PARAM_CHECKER.GET_MOMENT_LIST);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      params = params || {
        order: MOMENT_ORDER.DESC,
        start: 0,
        limit: 20,
        userId: ''
      };
      if(params.limit > 50){
        params.limit = 50;
      }
      if(!utils.isEmpty(params.userId)){
        params = utils.rename(params, { userId: 'user_id' });
      }
      let queryStr = utils.formatToQueryStr(params);
      let url = getRequestUrl(`momentgateway/moments/list?${queryStr}`);
      let options = getRequestOptions('GET', params);
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let { items, is_finished } = data;
          let moments = utils.map(items, (item) => {
            return momentFormat(item);
          });
          resolve({
            moments,
            isFinished: is_finished
          });
        },
        fail: reject
      });
    });
  };

  /* 
    var params = {
      momentId: '',
    };
  */
  let getMoment = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_MOMENT_INFO);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let { momentId } = params;
      let queryStr = utils.formatToQueryStr({
        moment_id: momentId
      });
      let url = getRequestUrl(`momentgateway/moments/info?${queryStr}`);
      let options = getRequestOptions('GET', params);
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let moment = momentFormat(data);
          resolve(moment);
        },
        fail: reject
      });
    });
  };

  /* 
    var params = {
      "momentId":"朋友圈 Id",
      "parentCommentId":"父级评论的 Id",
      "content":{
        "text":"评论内容"
      }
    };
  */
  let addComment = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.ADD_COMMENT);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let url = getRequestUrl('momentgateway/moments/comments/add');
      let { momentId, parentCommentId, content } = params;
      let _content = {
        moment_id: momentId,
        parent_comment_id: parentCommentId,
        content: content
      };
      let options = getRequestOptions('POST', _content);
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let _comment = utils.extend(_content, data);
          let comment = commentFormat(_comment);
          resolve(comment);
        },
        fail: reject
      });
    });
  };
  /* 
    var params = {
      "momentId":"朋友圈 Id",
      "commentIds": ["评论 Id"]
    };
  */
  let removeComment = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.REMOVE_COMMENT);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let url = getRequestUrl('momentgateway/moments/comments/del');
      let { momentId, commentIds } = params;
      let options = getRequestOptions('POST', {
        moment_id: momentId,
        comment_ids: commentIds
      });
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          resolve();
        },
        fail: reject
      });
    });
  };
  let getComments = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_COMMENT_LIST);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let _params = {
        order: COMMENT_ORDER.DESC,
        start: 0,
        limit: 20
      };
      _params = utils.extend(_params, params);
      if(_params.limit > 50){
        _params.limit = 50;
      }
      _params = utils.rename(_params, { momentId: 'moment_id' });
      let queryStr = utils.formatToQueryStr(_params);
      let url = getRequestUrl(`momentgateway/moments/comments/list?${queryStr}`);
      let options = getRequestOptions('GET', _params);
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let { items, is_finished } = data;
          let comments = utils.map(items, (item) => {
            return commentFormat(item);
          });
          resolve({
            comments,
            isFinished: is_finished
          });
        },
        fail: reject
      });
    });
  };
  /* 
    var params = {
      momentId: '',
      reaction: {
        key: '',
        value: ''
      }
    };
  */
  let addReaction = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.ADD_REACTION);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let url = getRequestUrl('momentgateway/moments/reactions/add');
      let { momentId, reaction } = params;
      let options = getRequestOptions('POST', {
        moment_id: momentId,
        reaction: reaction
      });
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          resolve();
        },
        fail: reject
      });
    });
  };
  /* 
    var params = {
      momentId: '',
      reaction: {
        key: 'k1',
      }
    };
  */
  let removeReaction = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.DELETE_REACTION);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      
      let url = getRequestUrl('momentgateway/moments/reactions/del');
      let { momentId, reaction } = params;
      let options = getRequestOptions('POST', {
        moment_id: momentId,
        reaction: reaction
      });
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          resolve();
        },
        fail: reject
      });
    });
  };

  /* 
    var params = {
      momentId: '',
    };
  */
  let getReactions = (params) => {
    return utils.deferred((resolve, reject) => {
      let error = common.check(io, params, FUNC_PARAM_CHECKER.GET_REACTION_LIST);
      if (!utils.isEmpty(error)) {
        return reject(error);
      }
      let queryStr = utils.formatToQueryStr({
        moment_id: params.momentId,
      });
      let url = getRequestUrl(`momentgateway/moments/reactions/list?${queryStr}`);
      let options = getRequestOptions('GET', {});
      jrequest.requestNormal(url, options, {
        success: (result) => {
          let { code, data } = result;
          if(!utils.isEqual(code, RESPONSE_CODE.SUCCESS)){
            return reject(result)
          }
          let { items } = data;
          let reactions = utils.map(items, (item) => {
            return reactionFormat(item);
          });
          resolve({
            reactions
          });
        },
        fail: reject
      });
    });
  };

  let userFormat = (user) => {
    return utils.rename(user, { user_id: 'id', nickname: 'name', updated_time: 'updatedTime', user_type: 'userType' });
  };
  let momentFormat = (item) => {
    let { moment_id, content = {}, user_info = {}, reactions, top_comments, moment_time  }  = item;
    let { text, medias } = content;
    if(!utils.isArray(medias)){
      medias = [];
    }
    medias = utils.map(medias, (item) => {
      let { type, url, snapshot_url, height, width } = item;
      return utils.rename(item, { snapshot_url: 'snapshotUrl' });
    });

    let user = userFormat(user_info);

    if(!utils.isArray(reactions)){
      reactions = [];
    }
    reactions = utils.map(reactions, (item) => {
      return reactionFormat(item);
    });
    if(!utils.isArray(top_comments)){
      top_comments = [];
    }
    let topComments = utils.map(top_comments, (item) => {
      return commentFormat(item);
    });
    return {
      momentId: moment_id,
      content: {
        text,
        medias
      },
      user: user,
      reactions: reactions,
      topComments: topComments,
      momentTime: moment_time,
    };
  };

  let reactionFormat = (item) => {
    let { value, timestamp, user_info } = item;
    let user = userFormat(user_info);
    return {
      value,
      timestamp,
      user
    };
  };

  let commentFormat = (item) => {
    let { comment_id, moment_id, parent_comment_id, content, parent_user_info, user_info, comment_time } = item;

    let parentUser = {};
    if(parent_user_info && parent_user_info.user_id){
      parentUser = userFormat(parent_user_info);
    }
    return {
      commentId: comment_id,
      momentId: moment_id,
      parentCommentId: parent_comment_id || '',
      content,
      parentUser: parentUser,
      user: user_info ? userFormat(user_info) : {},
      commentTime: comment_time
    };
  };

  return {
    addMoment,
    removeMoment,
    getMoments,
    getMoment,
    addComment,
    removeComment,
    getComments,
    addReaction,
    removeReaction,
    getReactions,
  };
}