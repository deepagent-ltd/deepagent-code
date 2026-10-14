import { signHttp, deviceError } from "../delivery/device-auth";
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
  if(!option.deviceAuth && !utils.isEmpty(navi)){
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
    if (option.deviceAuth) {
      const controller = new AbortController();
      requests.push({ abort: () => controller.abort() });
      const deadline = setTimeout(() => controller.abort(), 10000);
      (async () => {
        try {
          const current = () => !controller.signal.aborted && !isResponsed && option.current();
          const interrupted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(deviceError()), { once: true }));
          const headers = await Promise.race([signHttp(option.deviceAuth, { method: "GET", url, credential: token,
            currentSourceEpoch: option.sourceEpoch }, current), interrupted]);
          if (!current()) return;
          const response = await fetch(url, { method: "GET", headers: { "x-appkey": appkey, ...headers },
            redirect: "error", cache: "no-store", credentials: "omit", signal: controller.signal });
          if (!current()) { await response.body?.cancel(); return; }
          if (response.status !== 200 || response.headers.get("cache-control") !== "no-store") {
            await response.body?.cancel(); throw deviceError(response.status === 401 ? 11026 : 11025);
          }
          const reader = response.body?.getReader();
          if (!reader) throw deviceError();
          let size = 0, chunks = [];
          try {
            for (;;) {
              const part = await reader.read();
              if (!current()) throw deviceError();
              if (part.done) break;
              size += part.value.length;
              if (size > 65536) throw deviceError();
              chunks.push(part.value);
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (!current()) return;
          const servers = result.data?.servers, userId = result.data?.user_id;
          if (result.code !== 0 || !Array.isArray(servers) || servers.length < 1 || servers.length > 4 ||
            !servers.every(server => typeof server === "string" && server.length <= 1024) || typeof userId !== "string" || userId.length < 1 || userId.length > 128) throw deviceError();
          isResponsed = true;
          callback({ servers, userId, code: 0, url: domain });
          abortAll();
        } catch (error) {
          if (isResponsed || !option.current()) return;
          errors.push(error);
          if (errors.length === urls.length) callback({ code: error?.code || 11026 });
        } finally { clearTimeout(deadline); controller.abort(); }
      })();
      return;
    }
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
