import getUser from "./get-user.sql";

console.log(JSON.stringify(getUser.render({ id: 3 })));
