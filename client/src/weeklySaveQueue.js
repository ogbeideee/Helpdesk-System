// Serialize snapshot saves and flush edits made while an earlier save is in flight.
export function createWeeklySaveQueue({read,write,apply}) {
 let running=null;
 async function flush() {
   if(running){await running;return flush();}
   const state=read();
   if(!state.dirty || !state.report)return state.report;
   const snapshot={...state};
   running=Promise.resolve().then(()=>write(snapshot.report,snapshot)).then(saved=>apply(saved,snapshot.revision,snapshot.report.week));
   try{await running;}finally{running=null;}
   return flush();
 }
 return {flush};
}
