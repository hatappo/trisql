/**
 * content mapper のプロセス。tsc が package.json の typescript.contentMapper.exec で起動する。
 */
import { MapperHandlers } from "./mapper/handlers.ts";
import { serve } from "./mapper/rpc.ts";

const handlers = new MapperHandlers();
serve({
  initialize: (p) => handlers.initialize(p),
  openProject: (p) => handlers.openProject(p),
  transform: (p) => handlers.transform(p),
  closeProject: (p) => handlers.closeProject(p),
});
