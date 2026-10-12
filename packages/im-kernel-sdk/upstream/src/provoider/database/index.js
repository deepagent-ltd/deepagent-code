import WebDB from "./web";
import UniDB from "./uni";
import common from "../../common/common";

let DB = WebDB;
if(common.isUni()){
  DB = UniDB;
}
export default DB;
