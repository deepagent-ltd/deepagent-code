import WebSession from "./web";
import UniSession from "./uni";

let JSession = {};
if(typeof uni != "undefined"){
  JSession = UniSession();
}else{
  JSession = WebSession();
}
export default JSession;
