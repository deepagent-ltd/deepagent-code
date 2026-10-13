import WebEncoder from "./web";
import UniEncoder from "./uni";

let JTextEncoder = {};
if(typeof uni != "undefined"){
  JTextEncoder = UniEncoder();
}else{
  JTextEncoder = WebEncoder();
}
export default JTextEncoder;
