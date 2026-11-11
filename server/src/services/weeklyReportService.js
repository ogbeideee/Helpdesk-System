const prisma = require('../lib/prisma');
const { randomUUID } = require('crypto');
const writer = require('./weeklyReportWriter');
const CATEGORIES = ['Infrastructure', 'User Support', 'Hardware', 'Projects'];
const labels = [
 ['DHCP issues',0], ['Server issues',0], ['Off-site work',0],
 ['M365 account creation',1], ['M365 password change',1], ['M365 2FA setup for users',1],
 ['Network troubleshooting and diagnostics',0], ['Desk phone outage repairs',2],
 ['Faceplate replacement',0], ['Reactivation of disabled network switch ports',0],
 ['Microsoft Office fault fixes after a vendor update',1],
 ['Resolution confirmation feature on the IT Helpdesk Platform',3],
 ['IT Helpdesk Platform user testing',3], ['User domain migration',0], ['Routine user support requests',1],
];
const DEFAULTS = labels.map(([label, category], i) => ({ id: `routine-${i+1}`, label, category: CATEGORIES[category], active: true }));
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function staff(agent) { if (!['agent','admin'].includes(agent.role)) fail('Staff account required',403); }
function text(value, max = 4000) { if (typeof value !== 'string' || value.length > max) fail(`Text must be at most ${max} characters`); return value.trim(); }
function weekBounds(value) {
 const today = new Date(Date.now() + 3600000).toISOString().slice(0,10);
 const raw = value || today;
 if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail('Week must be an ISO date');
 const date = new Date(`${raw}T00:00:00Z`);
 if (!Number.isFinite(+date) || date.toISOString().slice(0,10) !== raw) fail('Invalid week date');
 date.setUTCDate(date.getUTCDate() - (date.getUTCDay()+6)%7);
 const week = date.toISOString().slice(0,10);
 return { week, from: new Date(+date-3600000), to: new Date(+date+7*86400000-3600000), friday: new Date(+date+4*86400000).toISOString().slice(0,10) };
}
async function definitions() {
 const overrides = await prisma.weeklyActivityDefinition.findMany({ orderBy: { id: 'asc' } });
 const map = new Map(DEFAULTS.map(d=>[d.id,d]));
 overrides.forEach(d=>map.set(d.id,d));
 return [...map.values()];
}
async function changeDefinition(agent, input) {
 staff(agent); if (agent.role !== 'admin') fail('Administrator role required',403);
 const label = text(input.label,160); if (!label) fail('Activity name required');
 if (!CATEGORIES.includes(input.category) || typeof input.active !== 'boolean') fail('Invalid activity settings');
 const id = input.id || randomUUID();
 if (typeof id !== 'string' || id.length > 80) fail('Invalid activity id');
 return prisma.weeklyActivityDefinition.upsert({ where:{id}, create:{id,label,category:input.category,active:input.active}, update:{label,category:input.category,active:input.active} });
}
async function load(agent, value) {
 staff(agent); const bounds = weekBounds(value);
 const [row, defs, reference, account] = await Promise.all([
 prisma.agentWeeklyReport.findUnique({where:{agentId_week:{agentId:agent.id,week:bounds.week}}}), definitions(),
 prisma.agentWeeklyReportReference.findUnique({where:{agentId:agent.id}}),
 prisma.agent.findUnique({where:{id:agent.id},select:{weeklyReportPreferences:true}})]);
 const data = row?.data || { automatic:false, activities:[], summary:'', ongoing:'', roadblocks:'', priorities:'' };
 const existing = new Map(data.activities.map(a=>[a.id,a]));
 const activities = defs.filter(d=>d.active || existing.has(d.id)).map(d=>existing.get(d.id) || {...d,count:0,description:''});
 data.activities.filter(a=>!defs.some(d=>d.id===a.id)).forEach(a=>activities.push(a));
 let ticketCount = 0;
 if (data.automatic) {
 const events = await prisma.auditEvent.findMany({where:{actorId:agent.id,action:'ticket.resolved',createdAt:{gte:bounds.from,lt:bounds.to}},select:{ticketId:true}});
 ticketCount = new Set(events.map(e=>e.ticketId).filter(Boolean)).size;
 }
 const report = {week:bounds.week,friday:bounds.friday,version:row?.version || 0,data:{...data,useAI:data.useAI!==false,activities},ticketCount,definitions:defs,categories:CATEGORIES};
 const generated=report.data.generated;
 const draftReady=Boolean(generated && generated.fingerprint===writer.fingerprint(report));
 return {...report,preview:narrative(report),draftReady,referenceAvailable:Boolean(reference),aiAvailable:writer.available(),favourites:account?.weeklyReportPreferences?.favourites || []};
}
function validate(input) {
 if (!input || typeof input.automatic !== 'boolean' || !Array.isArray(input.activities) || input.activities.length>100) fail('Invalid weekly report');
 if(input.useAI!==undefined && typeof input.useAI!=='boolean')fail('AI writing must be on or off.');
 const ids = new Set();
 const activities = input.activities.map(a=>{
 if (!a || typeof a.id !== 'string' || a.id.length>80 || ids.has(a.id)) fail('Invalid or duplicate activity'); ids.add(a.id);
 const label = text(a.label,160);
 if (!label || !CATEGORIES.includes(a.category) || !Number.isInteger(a.count) || a.count<0 || a.count>100000) fail('Invalid activity count or category');
 if(a.projectStatus!=null && (!['in_progress','completed'].includes(a.projectStatus) || a.category!=='Projects'))fail('Invalid project status.');
 if(a.projectStatus==='completed' && a.count===0)fail('Completed project work needs at least one recorded activity.');
 return {id:a.id,label,category:a.category,count:a.count,description:text(a.description),...(a.projectStatus?{projectStatus:a.projectStatus}:{})};
 });
 return {automatic:input.automatic,useAI:input.useAI!==false,activities,...Object.fromEntries(['summary','ongoing','roadblocks','priorities'].map(k=>[k,text(input[k] || '')]))};
}
async function save(agent, value, input, version) {
 staff(agent); const {week} = weekBounds(value); const data = validate(input);
 if (!Number.isInteger(version) || version<0) fail('Invalid report version');
 // Only retain a server-created draft while its factual inputs are unchanged.
 const existing=await load(agent,week);
 if(existing.data.generated && JSON.stringify(validate(existing.data))===JSON.stringify(data))data.generated=existing.data.generated;
 if (version===0) {
 try { await prisma.agentWeeklyReport.create({data:{agentId:agent.id,week,data}}); }
 catch(e) { if (e.code==='P2002') fail('This week changed in another tab. Reload before saving.',409); throw e; }
 } else {
 const changed = await prisma.agentWeeklyReport.updateMany({where:{agentId:agent.id,week,version},data:{data,version:{increment:1}}});
 if (!changed.count) fail('This week changed in another tab. Reload before saving.',409);
 }
 return load(agent,week);
}
function narrative(report) {
 if(report.data.generated?.fingerprint===writer.fingerprint(report))return {summary:report.data.generated.summary,accomplishments:report.data.generated.accomplishments};
 const entries = report.data.activities.filter(a=>a.count>0 || a.description);
 const accomplishments = Object.fromEntries(CATEGORIES.map(category=>[category,entries.filter(a=>a.category===category).map(a=>`${a.label}: ${a.count}.${a.description ? ` ${a.description}` : ''}`).join('\n') || 'NA']));
 if (report.data.automatic) accomplishments['User Support'] = (accomplishments['User Support']==='NA'?'':accomplishments['User Support']+'\n')+`Tickets resolved: ${report.ticketCount}.`;
 return {accomplishments, summary:report.data.summary || entries.map(a=>`${a.label}: ${a.count}`).concat(report.data.automatic?[`Tickets resolved: ${report.ticketCount}`]:[]).join('; ') || 'No activities recorded this week.'};
}
async function reference(agent,buffer) {
 staff(agent);const data=await require('./weeklyReportReference').parseReference(buffer);
 await prisma.agentWeeklyReportReference.upsert({where:{agentId:agent.id},create:{agentId:agent.id,data},update:{data}});
 return {referenceAvailable:true,notes:data.notes};
}
async function clearReference(agent) {staff(agent);await prisma.agentWeeklyReportReference.deleteMany({where:{agentId:agent.id}});return {referenceAvailable:false};}
async function previous(agent,value) {
 staff(agent);const bounds=weekBounds(value);
 const last=await prisma.agentWeeklyReport.findFirst({where:{agentId:agent.id,week:{lt:bounds.week}},orderBy:{week:'desc'}});
 if(!last)fail('You have no earlier saved report. Upload a previous report instead.',404);
 return {week:last.week,notes:Object.fromEntries(['ongoing','roadblocks','priorities'].map(k=>[k,last.data[k] || ''])),activities:last.data.activities.map(({projectStatus,...a})=>({...a,count:0,description:''}))};
}
async function generate(agent,value,version,options={}) {
 const report=await load(agent,value);
 if(report.version!==version || version===0)fail('Save your activities before generating the report.',409);
 const stored=await prisma.agentWeeklyReportReference.findUnique({where:{agentId:agent.id}});
 const last=!stored?await prisma.agentWeeklyReport.findFirst({where:{agentId:agent.id,week:{lt:report.week}},orderBy:{week:'desc'}}):null;
 const style=stored?.data || (last?.data.generated?{samples:{summary:last.data.generated.summary,accomplishments:last.data.generated.accomplishments}}:null);
 const draft=await writer.write(report,style,{useAI:report.data.useAI,...options});
 const generated={...draft,fingerprint:writer.fingerprint(report),...(stored?{layout:stored.data.layout}:{})};
 const changed=await prisma.agentWeeklyReport.updateMany({where:{agentId:agent.id,week:report.week,version},data:{data:{...validate(report.data),generated},version:{increment:1}}});
 if(!changed.count)fail('Your activities changed while the report was being written. Reload and create it again.',409);
 return load(agent,report.week);
}
async function editDraft(agent,value,version,input) {
 const report=await load(agent,value);
 if(!report.draftReady || report.version!==version)fail('The report has changed. Create the report again before editing.',409);
 const summary=text(input.summary,12000);
 const accomplishments=Object.fromEntries(CATEGORIES.map(c=>[c,text(input.accomplishments?.[c],50000)]));
 if(!summary)fail('The executive summary cannot be empty.');
 const generated={...report.data.generated,summary,accomplishments};
 const changed=await prisma.agentWeeklyReport.updateMany({where:{agentId:agent.id,week:report.week,version},data:{data:{...validate(report.data),generated},version:{increment:1}}});
 if(!changed.count)fail('This report changed in another tab. Reload before saving.',409);
 return load(agent,report.week);
}
async function preferences(agent,input) {
 staff(agent);
 if(!Array.isArray(input.favourites) || input.favourites.length>100 || input.favourites.some(id=>typeof id!=='string' || !id || id.length>80) || new Set(input.favourites).size!==input.favourites.length)fail('Invalid favourite activity list.');
 await prisma.agent.update({where:{id:agent.id},data:{weeklyReportPreferences:{favourites:input.favourites}}});
 return {favourites:input.favourites};
}
module.exports = {load,save,definitions,changeDefinition,weekBounds,narrative,validate,CATEGORIES,reference,clearReference,previous,generate,editDraft,preferences};
