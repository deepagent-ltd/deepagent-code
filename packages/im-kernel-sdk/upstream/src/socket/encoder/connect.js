import utils from "../../utils";
import Proto from "../proto";

export default function({ data }){
  let { appkey, token, deviceId, platform, clientSession, sdkVersion, ext } = data;
  let protoId = 'jug9le1m';

  let codec = Proto.lookup('codec.ConnectMsgBody');
  let message = codec.create({ appkey, token, platform, deviceId, clientSession, protoId, sdkVersion, ext });
  let buffer = codec.encode(message).finish();
  return { buffer };
}