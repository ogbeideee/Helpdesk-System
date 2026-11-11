export function currentReportDate() { return new Date(Date.now()+3600000).toISOString().slice(0,10); }
export const reportNoteFields = [['ongoing','Ongoing projects'],['roadblocks','Roadblocks & issues'],['priorities','Priorities for next week']];
export function shiftReportWeek(week, offset) { return new Date(Date.parse(`${week}T00:00:00Z`)+offset*7*86400000).toISOString().slice(0,10); }
export function reportDateLabel(date) { return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}); }
export function reportWeekLabel(week) { return `${reportDateLabel(week)} – ${reportDateLabel(new Date(Date.parse(`${week}T00:00:00Z`)+6*86400000).toISOString().slice(0,10))}`; }
export function filterWeeklyActivities(activities, filter, favourites) { return activities.filter(a=>filter==='recorded' ? a.count>0 || Boolean(a.description.trim()) || Boolean(a.projectStatus) : filter==='favourites' ? favourites.includes(a.id) : true); }
export function carriedWeeklyData(current, incoming, selected) { return {...Object.fromEntries(reportNoteFields.filter(([key])=>selected.includes(key)).map(([key])=>[key,incoming.notes[key] || ''])),activities:[...current,...(incoming.activities || []).filter(a=>!current.some(c=>c.id===a.id)).map(a=>({...a,count:0,description:'',projectStatus:null}))]}; }
export function activityTotal(activities) { return activities.reduce((sum,a)=>sum+a.count,0); }
export function newActivity(label,category) { return {id:crypto.randomUUID(),label:label.trim(),category,count:0,description:''}; }
export function activityFrequency(count) { return count===0?'none':count===1?'once':'multiple'; }
export function frequencyCount(mode,previousMultiple=2) { return mode==='none'?0:mode==='once'?1:Math.max(2,previousMultiple); }
export function validMultipleCount(value) { const count=Number(value); return value!=='' && Number.isInteger(count) && count>=2 && count<=100000; }
export function activityCountLabel(count) { return count===1?'1 time':`${count} times`; }
export function progressOnly(activity) { return activity.count===0 && Boolean(activity.description.trim()); }
export function projectStatusLabel(status) { return status==='in_progress'?'In progress':status==='completed'?'Completed':'Not specified'; }
export function reviewActivities(activities) { return activities.filter(a=>a.count>0 || a.description.trim() || a.projectStatus).map(a=>({...a,statusLabel:projectStatusLabel(a.projectStatus),prompt:!a.description.trim()?(a.category==='Projects'?'Add a short progress or outcome note.':a.id==='routine-3'?'Add where you worked and what you did.':''):''})); }
export function weeklyActivityGroups(activities,categories,favourites) {
 const pinned=favourites.map(id=>activities.find(a=>a.id===id)).filter(Boolean);
 return [...(pinned.length?[{title:'Favourites',activities:pinned}]:[]),...categories.map(title=>({title,activities:activities.filter(a=>a.category===title && !favourites.includes(a.id))})).filter(group=>group.activities.length)];
}
