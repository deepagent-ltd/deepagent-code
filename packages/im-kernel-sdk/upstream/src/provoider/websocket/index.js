import WebWS from "./web";
import UniWS from "./uni";
import common from "../../common/common";

let JWebSocket = WebWS;
if(common.isUni()){
  JWebSocket = UniWS
}
export default JWebSocket;
