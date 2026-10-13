export default function(){
  let noop = () => {};
  let forEach = (obj, callback) => {
    for (var key in obj) {
      callback(obj[key], key, obj);
    }
  };
  let request = (url, option, callback) => {
    option = option || {};
    callback = callback || { success: noop, fail: noop, progress: noop }
    let xhr = new XMLHttpRequest();
    let method = option.method || 'GET';
    xhr.open(method, url, true);
    let headers = option.headers || {};
    forEach(headers, (header, name) => {
      xhr.setRequestHeader(name, header);
    });
    let body = option.body || {};
    let isSuccess = () => {
      return /^(200|202)$/.test(xhr.status);
    };
    let timeout = option.timeout;
    if (timeout) {
      xhr.timeout = timeout;
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState == 4) {
        let { responseText } = xhr;
        responseText = responseText || '{}';
        let result = JSON.parse(responseText);
        if (isSuccess()) {
          callback.success(result, xhr);
        } else {
          let { status } = xhr;
          let error = { status, result };
          callback.fail(error)
        }
      }
    };
    xhr.upload.onprogress = function(event) {
      if (event.lengthComputable && callback.progress) {
        callback.progress(event)
      }
    };
    xhr.onerror = (error) => {
      callback.fail(error)
    }
    xhr.send(body);
    return xhr;
  };
  return {
    requestNormal: request,
    uploadFile: request
  };
};