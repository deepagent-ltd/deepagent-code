import WebRequest from "./web";
import UniRequest from "./uni";

let JRequest = {};
if(typeof uni != "undefined"){
  JRequest = UniRequest();
}else{
  JRequest = WebRequest();
}
export default JRequest;