import utils from '../../utils';
export default function DB(option){
  let { name, version = 1, tables = {} } = option;
  let insert = (params) => {
  };

  let search = (params, callback) => {
    callback({ list: [] });
  };

  let remove = (params) => {
  }

  let dbTools = {
    insert,
    search,
    remove,
  }
  return dbTools;
}