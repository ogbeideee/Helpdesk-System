import {useEffect,useState} from 'react';
import {api} from '../api.js';
import {Spinner,Icon} from './ui.jsx';
import WeeklyReportReview from './WeeklyReportReview.jsx';
import WeeklyReportEntries from './WeeklyReportEntries.jsx';
import WeeklyReportPreview from './WeeklyReportPreview.jsx';
import WeeklyReportCarryForward from './WeeklyReportCarryForward.jsx';
import {useWeeklyAutosave} from '../useWeeklyAutosave.js';
import {useWeeklyDraftAutosave} from '../useWeeklyDraftAutosave.js';
import {currentReportDate,activityTotal,newActivity,reportNoteFields,reportDateLabel,reportWeekLabel,shiftReportWeek,carriedWeeklyData} from '../weeklyReportView.js';

export default function WeeklyReportPage({me}) {
 const [date,setDate]=useState(currentReportDate);
 const [report,setReport]=useState(null);
 const [dirty,setDirty]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [message,setMessage]=useState('');
 const [draft,setDraft]=useState(null);
 const [draftDirty,setDraftDirty]=useState(false);
 const [tab,setTab]=useState('activities');
 const [filter,setFilter]=useState('all');
 const [name,setName]=useState('');
 const [category,setCategory]=useState('Infrastructure');
 const [sharedName,setSharedName]=useState('');
 const [favourites,setFavourites]=useState([]);
 const [pinBusy,setPinBusy]=useState(false);
 const [review,setReview]=useState(false);
 const [incoming,setIncoming]=useState(null);
 const autosave=useWeeklyAutosave({report,setReport,setDirty,setError,busy});
 const wording=useWeeklyDraftAutosave({report,setReport,draft,setDraftDirty,setError,enabled:!busy && !dirty && !autosave.saving && Boolean(report?.draftReady)});
 const saving=autosave.saving || wording.saving;
 const locked=busy || wording.saving;
 const ready=Boolean(report?.draftReady && !dirty);

 useEffect(()=>{
  let cancelled=false;autosave.reset();wording.reset();setReport(null);setError('');setMessage('');setReview(false);setIncoming(null);setTab('activities');setDirty(false);setDraftDirty(false);
  api.weeklyReport(date).then(r=>{if(!cancelled){setReport(r);setFavourites(r.favourites || []);setDraft(r.preview);}}).catch(e=>{if(!cancelled)setError(e.message);});
  return ()=>{cancelled=true;};
 },[date]);
 useEffect(()=>{const guard=e=>{if(dirty || draftDirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty,draftDirty]);
 useEffect(()=>{
  const guard=e=>{const link=e.target.closest?.('a[href]');if((dirty || draftDirty) && link?.hash && link.hash!==window.location.hash && !window.confirm('Discard unsaved weekly report changes?')){e.preventDefault();e.stopPropagation();}};
  document.addEventListener('click',guard,true);return()=>document.removeEventListener('click',guard,true);
 },[dirty,draftDirty]);

 function update(data){autosave.markDirty();setReport(r=>({...r,draftReady:false,data:{...r.data,...data}}));setDirty(true);setMessage('');}
 function activity(id,patch){update({activities:report.data.activities.map(a=>a.id===id?{...a,...patch}:a)});}
 function editDraft(next){wording.markDirty();setDraft(next);setDraftDirty(true);setMessage('');}
 async function flush(){
  // Editors are separate: save wording before an action changes its version.
  if(draftDirty || wording.saving)return wording.flush();
  return autosave.flush();
 }
 async function changeTab(next){if(next===tab)return;setBusy(true);setError('');try{await flush();setTab(next);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function changeWeek(next){if(!next || next===date)return;setBusy(true);setError('');try{await flush();setDate(next);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function save(create=false){
  setBusy(true);setError('');
  try{if(create && !report.version)autosave.markDirty();let r=await flush();if(create){r=await api.generateWeeklyReport({week:r.week,version:r.version});setReport(r);setDraft(r.preview);wording.reset();setDraftDirty(false);setReview(false);setTab('preview');}setMessage(create?'Report generated':'All changes saved');return r;}
  catch(e){setError(e.message);return null;}finally{setBusy(false);}
 }
 async function exportReport(){setBusy(true);setError('');try{const r=await flush();await api.exportWeeklyReport(r.week);setMessage('Excel report downloaded');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function upload(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith('.xlsx') || file.size>2*1024*1024){setError('Choose an .xlsx report up to 2 MB.');return;}
  setBusy(true);setError('');try{await flush();const result=await api.uploadWeeklyReference(file);setReport(r=>({...r,referenceAvailable:true}));setIncoming({notes:result.notes});setMessage('Writing reference saved. Review any notes you want to carry forward.');}catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function previous(){setBusy(true);setError('');try{await flush();setIncoming(await api.previousWeeklyReport(report.week));}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function removeReference(){setBusy(true);setError('');try{await flush();await api.clearWeeklyReference();setReport(r=>({...r,referenceAvailable:false}));setMessage('Uploaded reference removed.');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function definition(payload){setBusy(true);setError('');try{await flush();await api.saveWeeklyActivity(payload);const r=await api.weeklyReport(report.week);setReport(r);setDraft(r.preview);setSharedName('');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function pin(id){const previous=favourites;const next=previous.includes(id)?previous.filter(x=>x!==id):[...previous,id];setFavourites(next);setPinBusy(true);try{await api.saveWeeklyPreferences({favourites:next});}catch(e){setFavourites(previous);setError(e.message);}finally{setPinBusy(false);}}

 return <div className="weekly-report">
  {error && <div role="alert" className="error">{error} {report && <button className="btn" disabled={locked} onClick={()=>save()}>Retry save</button>} <button className="btn" onClick={()=>{if(!(dirty || draftDirty) || window.confirm('Discard unsaved changes and reload?'))window.location.reload();}}>Reload</button></div>}
  {!report?(!error && <Spinner />):<>
   <div className="weekly-weekbar"><div><h2>{reportWeekLabel(report.week)}</h2><p className="muted small">Report date · Friday, {reportDateLabel(report.friday)}</p></div><div className="weekly-week-actions"><button className="btn" disabled={locked || saving} aria-label="Previous week" onClick={()=>changeWeek(shiftReportWeek(report.week,-1))}>‹</button><button className="btn" disabled={locked || saving} onClick={()=>changeWeek(currentReportDate())}>This week</button><button className="btn" disabled={locked || saving} aria-label="Next week" onClick={()=>changeWeek(shiftReportWeek(report.week,1))}>›</button><label className="weekly-date-picker">Choose date<input type="date" value={date} disabled={locked || saving} onChange={e=>changeWeek(e.target.value)} /></label></div></div>
   <div className="weekly-tabbar"><div role="tablist" aria-label="Weekly report sections">{[['activities','Activities'],['preview','Report preview']].map(([key,label])=><button key={key} id={`weekly-tab-${key}`} role="tab" aria-controls={`weekly-panel-${key}`} aria-selected={tab===key} className="btn btn-ghost" disabled={locked} onClick={()=>changeTab(key)}>{label}</button>)}</div><span role="status" className="muted small">{saving?'Saving…':autosave.paused || wording.paused?'Autosave paused — retry saving':dirty || draftDirty?'Waiting to save…':message || 'All changes saved'}</span></div>
   <section role="tabpanel" id="weekly-panel-activities" aria-labelledby="weekly-tab-activities" hidden={tab!=='activities'}>
    <fieldset disabled={locked} className="weekly-fields">
     <WeeklyReportEntries report={report} favourites={favourites} filter={filter} setFilter={setFilter} pinBusy={pinBusy} pin={pin} activity={activity} remove={id=>update({activities:report.data.activities.filter(a=>a.id!==id)})} />
     <details className="card weekly-disclosure"><summary>Add a custom activity</summary><div className="weekly-controls"><label>Activity name<input maxLength={160} value={name} onChange={e=>setName(e.target.value)} /></label><label>Report category<select value={category} onChange={e=>setCategory(e.target.value)}>{report.categories.map(c=><option key={c}>{c}</option>)}</select></label><button className="btn" disabled={!name.trim() || report.data.activities.length>=100} onClick={()=>{update({activities:[...report.data.activities,newActivity(name,category)]});setName('');}}>Add activity</button></div></details>
     <section className="card"><div className="weekly-section-heading"><h2>Report notes</h2><button className="btn btn-ghost" onClick={previous}>Use last week's notes</button></div><div className="weekly-note-grid">{reportNoteFields.map(([key,label])=><label key={key}>{label}<textarea rows={3} maxLength={4000} value={report.data[key]} onChange={e=>update({[key]:e.target.value})} /></label>)}</div></section>
     <details className="card weekly-disclosure"><summary>Report setup <span className="muted small">Writing style, Excel reference & ticket counting</span></summary><div className="weekly-setup-content"><h3>Start from a previous report</h3><p className="muted small">Reuse its writing style and Excel formatting. You can review imported notes before replacing current notes.</p><label>Upload previous report (.xlsx)<input type="file" accept=".xlsx" onChange={e=>{upload(e.target.files?.[0]);e.target.value='';}} /></label>{report.referenceAvailable && <div className="weekly-controls"><span>Saved writing reference ready</span><button className="btn" onClick={removeReference}>Remove reference</button></div>}<label><input type="checkbox" checked={report.data.useAI} onChange={e=>update({useAI:e.target.checked})} /> Match sample wording with AI</label><p className="muted small">Uses Groq with activity names, counts, descriptions and sample wording. With this off, reports use factual sentences written locally.</p>{!report.aiAvailable && <p className="muted small">The writing service is not configured. Factual report generation is still available.</p>}<label><input type="checkbox" checked={report.data.automatic} onChange={e=>update({automatic:e.target.checked})} /> Automatically include tickets I resolved</label><p className="muted small">Counts distinct tickets you resolved this week, including weekend work. Avoid recording the same work manually. Save or generate to refresh the total.</p>{report.data.automatic && <p>Tickets resolved: <strong>{report.ticketCount}</strong></p>}<p className="muted small">Manual activity instances: {activityTotal(report.data.activities)}</p></div></details>
     {me.role==='admin' && <details className="card weekly-disclosure"><summary>Team activity list</summary><p className="muted small">Shared activity changes apply to new entries. Previous records retain their labels.</p><div className="weekly-controls"><label>New standard activity<input maxLength={160} value={sharedName} onChange={e=>setSharedName(e.target.value)} /></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}>{report.categories.map(c=><option key={c}>{c}</option>)}</select></label><button className="btn" disabled={saving || !sharedName.trim()} onClick={()=>definition({label:sharedName,category,active:true})}>Add to team list</button></div>{report.definitions.map(d=><div className="weekly-controls" key={d.id}><span>{d.label} · {d.category}</span><button className="btn" disabled={saving} onClick={()=>definition({...d,active:!d.active})}>{d.active?'Disable':'Enable'}</button></div>)}</details>}
    </fieldset>
   </section>
   <section role="tabpanel" id="weekly-panel-preview" aria-labelledby="weekly-tab-preview" hidden={tab!=='preview'}><WeeklyReportPreview report={report} me={me} draft={draft} ready={ready} disabled={busy} onEdit={editDraft} /></section>
   <footer className="weekly-actionbar"><div><strong>{ready?'Report ready to export':report.data.generated?'Report needs updating':'Ready to review'}</strong><p className="muted small">{ready?'Your latest saved entries are included.':'Review the entries before generating your report.'}</p></div><div className="weekly-action-buttons">{(autosave.paused || wording.paused) && <button className="btn" disabled={locked} onClick={()=>save()}>Retry save</button>}{ready && <button className="btn" disabled={locked} onClick={()=>setReview(true)}>Regenerate report</button>}<button className="btn btn-primary" disabled={locked} onClick={ready?exportReport:()=>{setError('');setReview(true);}}>{busy?'Working…':ready?'Export Excel':'Review & generate'}<Icon name="arrowRight" /></button></div></footer>
   {review && <WeeklyReportReview report={report} busy={busy} error={error} onClose={()=>setReview(false)} onGenerate={()=>save(true)} />}
   {incoming && <WeeklyReportCarryForward current={report.data} incoming={incoming} onClose={()=>setIncoming(null)} onApply={selected=>{update(carriedWeeklyData(report.data.activities,incoming,selected));setIncoming(null);setMessage('Selected notes carried forward. Current activity counts were kept.');}} />}
  </>}
 </div>;
}
