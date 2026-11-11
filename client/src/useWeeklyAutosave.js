import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {createWeeklySaveQueue} from './weeklySaveQueue.js';

export function useWeeklyAutosave({report,setReport,setDirty,setError,busy}) {
 const state=useRef({report:null,dirty:false,revision:0});
 const callbacks=useRef({setReport,setDirty,setError});
 const [saving,setSaving]=useState(false);
 const [paused,setPaused]=useState(false);
 state.current.report=report;
 callbacks.current={setReport,setDirty,setError};
 const queue=useRef(null);
 if(!queue.current)queue.current=createWeeklySaveQueue({
 read:()=>state.current,
 write:r=>api.saveWeeklyReport({week:r.week,version:r.version,data:r.data}),
 apply:(saved,revision,week)=>{
  if(state.current.report?.week!==week)return;
  const current=state.current;
  const clean=current.revision===revision;
  // Keep the editor's exact text (including a trailing space mid-sentence).
  // The server normalizes stored text; an acknowledgement must not move the
  // caret or join words when the agent resumes typing after a pause.
  const next={...saved,data:current.report.data,draftReady:clean && saved.draftReady};
  current.report=next;current.dirty=!clean;
  callbacks.current.setReport(next);callbacks.current.setDirty(!clean);
 },
 });
 function markDirty(){state.current.revision++;state.current.dirty=true;}
 function reset(){state.current.dirty=false;state.current.revision++;setPaused(false);}
 async function flush(){
  setSaving(true);setPaused(false);
  try{return await queue.current.flush();}
  catch(e){setPaused(true);callbacks.current.setError(`${e.message} Your unsaved entries are still on this page.`);throw e;}
  finally{setSaving(false);}
 }
 useEffect(()=>{
 if(!report || busy || saving || paused || !state.current.dirty)return;
 const timer=setTimeout(()=>{flush().catch(()=>{});},900);
 return()=>clearTimeout(timer);
 },[report,busy,saving,paused]);
 return {markDirty,reset,flush,saving,paused};
}
