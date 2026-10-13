import utils from "../utils";
import Storage from "../common/storage";
import { STORAGE, ErrorType, LOG_MODULE } from "../enum";
import common from "./common";
import jrequest from "../provoider/request/index";

let detect = (urls, callback, option = {}) => {
  let requests = [], superior = '', errors = []; 

  utils.forEach(urls, (domain) => {
    let { http } = utils.getProtocol(domain);
    
    domain = domain.replace(/http:\/\/|https:\/\/|file:\/\/|wss:\/\/|ws:\/\//g, '');
    let url = `${http}//${domain}/health`;
    let xhr = jrequest.requestNormal(url, option, {
      success: function(result, $xhr){
        if(utils.isEmpty(superior)){
          let { responseURL } = $xhr;
          superior = responseURL.replace(/(\/health)/g, '');
          callback(superior);
          abortAll();
        }
      },
      fail: function(error){
        errors.push(error);
        if(utils.isEqual(errors.length, urls.length)){
          callback(superior, error);
        }
      }
    });
    requests.push(xhr);
  });

  function abortAll(){
    utils.forEach(requests, (xhr) => {
      xhr.abort();
    });
    requests = [];
  }
};

let getNavis = (urls, option, callback) => {
  let { logger } = option;
  
  logger.info({ tag: LOG_MODULE.NAV_START, urls });
  
  let requests = [], isResponsed = false, errors = []; 
  let { appkey, token } = option;

  // 通过 AppKey_Token 获取 userId
  let tokenKey = common.getTokenKey(appkey, token);
  let userId = Storage.get(tokenKey)

  if(!utils.isEmpty(userId)){
    Storage.setPrefix(`${appkey}_${userId}`)
  }
  let key = common.getNaviStorageKey(appkey, userId);
  let navi = Storage.get(key);
  if(!utils.isEmpty(navi)){
    logger.info({ tag: LOG_MODULE.NAV_REQEST, local: navi });
    return callback(navi);
  }

  utils.forEach(urls, (domain) => {
    let url = domain.replace(/http:\/\/|https:\/\/|file:\/\//g, '')
    let { http } = utils.getProtocol(domain);
    url = `${http}//${url}/navigator/general`;
    let options = {
      headers: {
        'x-appkey': appkey,
        'x-token': token
      }
    };
    let xhr = jrequest.requestNormal(url, options, {
      success: function(result, $xhr){
        if(!isResponsed){
          let { responseURL } = $xhr;
          let goodUrl = responseURL.replace(/(\/navigator\/general)/g, '');
          isResponsed = true;
          let { code, data = {} } = result;
          let { servers, user_id: userId } = data;
          
          // 默认规则：导航和 CMP 的协议必须一致
          let nav = { servers, userId, code, url: goodUrl };
          if(!utils.isEmpty(servers)){
            // 优先设置本地 AppKey 和 Token 缓存的 UserId
            Storage.set(tokenKey, userId);
            
            // 设置全局存储前缀
            Storage.setPrefix(`${appkey}_${userId}`);

            // 设置导航缓存
            key = common.getNaviStorageKey();
            Storage.set(key, nav);

            logger.info({ tag: LOG_MODULE.NAV_REQEST, remote: nav });
          }
          callback(nav);
          abortAll();
        }
      },
      fail: function(error){
        errors.push(error);
        if(utils.isEqual(errors.length, urls.length)){
          callback(error.result);
        }
      }
    });
    requests.push(xhr);
  });

  function abortAll(){
    utils.forEach(requests, (xhr) => {
      xhr.abort();
    });
    requests = [];
  }
};
export default {
  detect,
  getNavis
}