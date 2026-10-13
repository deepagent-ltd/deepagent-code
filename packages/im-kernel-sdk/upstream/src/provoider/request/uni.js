import utils from "../../utils";
import JTextEncoder from "../textencoder/index";
import WebUploader from "./web";

export default function(){
  let noop = () => {};

  let requestNormal = (url, option, callback) => {
    option = option || {};
    callback = callback || { success: noop, fail: noop, progress: noop };
    let headers = option.headers || {};
    let body = option.body || {};

    let requestTask = uni.request({
      url: url,
      data: body,
      header: headers,
      method: option.method || 'GET',
      success: (res) => {
        let { data } = res;
        callback.success(data, { responseURL: url });
      },
      fail: (error) => {
        callback.fail(error)
      }
    });
    return requestTask;
  };
  

  // url: 'https://jugglechat-file.oss-cn-beijing.aliyuncs.com',
  //   filePath: tempPath,
  //   header: header,
  //   name: 'file',
  //   formData: {
  //     policy: '',
  //     Key: '8osQo0sDA38bvZZFmnUri8.png',
  //     Expires: '1737617884',
  //     OSSAccessKeyId: 'LTAI5tCtWtVhvRJ741YN2PKW',
  //     Signature: 'NKVdKWn+RGT9gQjhAXyl/xtEcr0='
  //   },
    
  function getProtocolAndDomain(url) {
    const protocolIndex = url.indexOf("://");
    if (protocolIndex === -1) {
        return null;
    }
    const protocol = url.slice(0, protocolIndex + 3);
    const remainingUrl = url.slice(protocolIndex + 3);
    const pathIndex = remainingUrl.indexOf("/");
    const domain = pathIndex === -1? remainingUrl : remainingUrl.slice(0, pathIndex);
    return protocol + domain;
  }

  let uploadFile = (url, option, callbacks) => {
    let { tempPath, header, method, isUniWebThumbnail } = option;
    if(isUniWebThumbnail){
      let webUploader = WebUploader();
      return webUploader.uploadFile(url, option, callbacks);
    }
    let { objKey, policy, signVersion, signature, date, credential } = option;
    let formData = {
      key: objKey,
      policy: policy,
      'x-oss-signature-version': signVersion,
      'x-oss-credential': credential,
      'x-oss-date': date,
      'x-oss-signature': signature,
    };
    let host = getProtocolAndDomain(url);
    let uploadTask = uni.uploadFile({
			url: host,
			filePath: tempPath,
      header: header,
			name: 'file',
      formData: formData,
			success: () => {
        let fileUrl = `${host}/${objKey}`;
        callbacks.success({ url: fileUrl });
			},
      fail: (error) => {
        callbacks.fail(error);
      }
		});

    uploadTask.onProgressUpdate((res) => {
      let { totalBytesSent: loaded, totalBytesExpectedToSend: total } = res;
      callbacks.progress({ loaded, total });
		});

  };

  return {
    requestNormal,
    uploadFile: uploadFile
  }
}