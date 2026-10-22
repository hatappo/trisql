import getUser from "./get-user.sql";

const rendered = getUser.render({ id: 7 });
console.log(JSON.stringify({ doc: getUser.doc, rendered, source: getUser.source?.endsWith("get-user.sql") }));
