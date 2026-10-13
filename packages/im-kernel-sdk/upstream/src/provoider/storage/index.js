import WebStorage from "./web";
import UniStorage from "./uni";

let JStorage = {};
if(typeof uni != "undefined"){
  JStorage = UniStorage()
}else{
  JStorage = WebStorage()
}
export default JStorage;
