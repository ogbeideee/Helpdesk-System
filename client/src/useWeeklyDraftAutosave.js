import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {createWeeklySaveQueue} from './weeklySaveQueue.js';

// Draft saves share the report version. The page flushes them before changing
// entries or weeks, and starts them only after entry autosaves have finished.
export function useWeeklyDraftAutosave({report,setReport,draft,setDraftDirty,setError,enabled}) {
 const state=useRef({report:null,dirty:false,revision:0});
 const callbacks=useRef({});
 const [saving,setSaving]=useState(false);
 const [paused,setPaused]=useState(false);
 state.current.report=report;state.current.draft=draft;
 callbacks.current={setReport,setDraftDirty,setError};
 const queue=useRef(null);
 if(!queue.current)queue.current=createWeeklySaveQueue({
  read:()=>state.current,
  write:(r,snapshot)=>api.editWeeklyDraft({week:r.week,version:r.version,draft:snapshot.draft}),
  apply:(saved,revision,week)=>{
   if(state.current.report?.week!==week)return;
   const clean=state.current.revision===revision;
   state.current.report=saved;state.current.dirty=!clean;
   callbacks.current.setReport(saved);callbacks.current.setDraftDirty(!clean);
   // Keep exact local text and caret position; normalization belongs on disk.
  },
 });
 function markDirty(){state.current.revision++;state.current.dirty=true;}
 function reset(){state.current.dirty=false;state.current.revision++;setPaused(false);}
 async function flush(){setSaving(true);setPaused(false);try{return await queue.current.flush();}catch(e){setPaused(true);callbacks.current.setError(`${e.message} Your report wording is still on this page.`);throw e;}finally{setSaving(false);}}
 useEffect(()=>{if(!enabled || saving || paused || !state.current.dirty)return;const timer=setTimeout(()=>{flush().catch(()=>{});},900);return()=>clearTimeout(timer);},[draft,enabled,saving,paused]);
 return {markDirty,reset,flush,saving,paused};
}
