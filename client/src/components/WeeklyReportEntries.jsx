import WeeklyActivityFrequency from './WeeklyActivityFrequency.jsx';
import {activityCountLabel,filterWeeklyActivities,progressOnly,projectStatusLabel,weeklyActivityGroups} from '../weeklyReportView.js';

export default function WeeklyReportEntries({report,favourites,filter,setFilter,pinBusy,pin,activity,remove}) {
 const visible=filterWeeklyActivities(report.data.activities,filter,favourites);
 return <>
  <div className="weekly-entry-tools"><div className="weekly-filter-group" aria-label="Filter activities">{[['all','All'],['recorded','Recorded'],['favourites','Favourites']].map(([key,label])=><button type="button" className={`btn btn-ghost${filter===key?' is-selected':''}`} aria-pressed={filter===key} key={key} onClick={()=>setFilter(key)}>{label}</button>)}</div><span className="muted small">{filterWeeklyActivities(report.data.activities,'recorded',favourites).length} recorded activities</span></div>
  <div className="weekly-entry-list">{weeklyActivityGroups(visible,report.categories,favourites).map(group=><section key={group.title}><h2 className="weekly-group-label">{group.title}</h2>{group.activities.map(a=><details className="weekly-entry" key={`${report.week}:${a.id}`}>
   <summary><span><strong>{a.label}</strong><span className="muted small weekly-entry-meta">{a.category==='Projects'?`${projectStatusLabel(a.projectStatus)} · `:''}{a.description.trim()?'Note added':a.count?'Add a description':'Not recorded'}</span></span><span className="weekly-entry-count"><button type="button" className="btn btn-ghost" aria-label={`Decrease ${a.label}`} disabled={a.count===0} onClick={e=>{e.preventDefault();e.stopPropagation();activity(a.id,{count:a.count-1,...(a.count===1 && a.projectStatus==='completed'?{projectStatus:null}:{})});}}>−</button><span aria-label={activityCountLabel(a.count)}>{a.count}</span><button type="button" className="btn btn-ghost" aria-label={`Increase ${a.label}`} disabled={a.count>=100000} onClick={e=>{e.preventDefault();e.stopPropagation();activity(a.id,{count:a.count+1});}}>+</button></span><span aria-hidden="true">⌄</span></summary>
   <div className="weekly-entry-editor"><button type="button" className="btn btn-ghost weekly-pin" aria-label={`${favourites.includes(a.id)?'Unpin':'Pin'} ${a.label}`} aria-pressed={favourites.includes(a.id)} disabled={pinBusy} onClick={()=>pin(a.id)}>{favourites.includes(a.id)?'Unpin favourite':'Pin as favourite'}</button>
   <WeeklyActivityFrequency label={a.label} count={a.count} onChange={count=>activity(a.id,{count,...(count===0 && a.projectStatus==='completed'?{projectStatus:null}:{})})} />
   {a.category==='Projects' && <label>Project status<select value={a.projectStatus || ''} onChange={e=>activity(a.id,{projectStatus:e.target.value || null})}><option value="">Not specified</option><option value="in_progress">In progress</option><option value="completed" disabled={a.count===0}>Completed</option></select></label>}
   <label>Description / progress<textarea maxLength={4000} rows={3} value={a.description} onChange={e=>activity(a.id,{description:e.target.value})} /></label>
   {progressOnly(a) && <p className="muted small">Progress note only · no completed activity counted</p>}
   {!report.definitions.some(d=>d.id===a.id) && <button type="button" className="btn" onClick={()=>remove(a.id)}>Remove custom activity</button>}
   </div></details>)}</section>)}{!visible.length && <p className="weekly-empty muted">No activities in this view.</p>}</div>
 </>;
}
