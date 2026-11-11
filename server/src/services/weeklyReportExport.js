const Excel = require('exceljs');
const defaultLayout = require('./weeklyReportLayout.json');
const { narrative, CATEGORIES } = require('./weeklyReportService');
async function exportReport(agent, report) {
 const layout=report.data.generated?.layout || defaultLayout;
 const workbook = new Excel.Workbook();
 const sheet = workbook.addWorksheet(`${report.week} to ${report.friday}`);
 sheet.columns = layout.columns;
 const n = narrative(report);
 const anchors=layout.anchors || {date:2,preparedBy:3,department:4,summary:6,accomplishments:9,ongoing:15,roadblocks:19,priorities:23,categoryRows:Object.fromEntries(CATEGORIES.map((c,i)=>[c,10+i]))};
 const values={A1:'Weekly IT Status Report'};
 const put=(row,a,b)=>{values[`A${row}`]=a;if(b!==undefined)values[`B${row}`]=b;};
 put(anchors.date,'Date:',new Date(`${report.friday}T12:00:00Z`));put(anchors.preparedBy,'Prepared By:',agent.name);put(anchors.department,'Department:','Information Technology');
 put(anchors.summary,'Executive Summary');put(anchors.summary+1,n.summary);
 put(anchors.accomplishments,'Key Accomplishments (This Week)');
 put(anchors.ongoing,'Ongoing Projects (In Progress)');put(anchors.ongoing+1,report.data.ongoing || 'NA');
 put(anchors.roadblocks,'Roadblocks & Issues');put(anchors.roadblocks+1,'Status:',report.data.roadblocks || 'NA');
 put(anchors.priorities,'Priorities for Next Week');put(anchors.priorities+1,report.data.priorities || 'NA');
 CATEGORIES.forEach(category=>put(anchors.categoryRows[category],`${category}:`,n.accomplishments[category]));
 // Excel caps row height at 409 points. Long sections continue in additional
 // styled rows instead of clipping descriptions or shrinking the type.
 let outputRow=1;
 const mergedContentRows=[anchors.summary+1,anchors.ongoing+1,anchors.priorities+1];
 const narrativeRows=[...mergedContentRows,...Object.values(anchors.categoryRows),anchors.roadblocks+1];
 const lastRow=Math.max(...layout.rows.map(r=>r.number),anchors.priorities+1);
 for(let sourceRow=1;sourceRow<=lastRow;sourceRow++) {
 const merged=layout.merges.includes(`A${sourceRow}:B${sourceRow}`);
 const column=mergedContentRows.includes(sourceRow)?'A':'B';
 const value=values[`${column}${sourceRow}`];
 const width=merged?100:65;
 const chunks=narrativeRows.includes(sourceRow)?splitText(String(value || ''),width):[value];
 for(let part=0;part<chunks.length;part++,outputRow++) {
 for(const col of ['A','B']) {
 const address=`${col}${sourceRow}`;
 const sourceStyle=layout.cells.find(c=>c.address===address)?.style;
 if(sourceStyle) sheet.getCell(`${col}${outputRow}`).style=JSON.parse(JSON.stringify(sourceStyle));
 const content=part===0?values[address]:undefined;
 if(content!==undefined) sheet.getCell(`${col}${outputRow}`).value=content;
 }
 if(merged) sheet.mergeCells(`A${outputRow}:B${outputRow}`);
 if(narrativeRows.includes(sourceRow)) sheet.getCell(`${column}${outputRow}`).value=chunks[part];
 const lines=String(chunks[part] || '').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/width)),0);
 const base=layout.rows.find(r=>r.number===sourceRow)?.height || 20;
 sheet.getRow(outputRow).height=narrativeRows.includes(sourceRow)?Math.min(409,Math.max(base,lines*15+10)):base;
 }
 }
 sheet.pageSetup = {...layout.pageSetup, fitToPage:true,fitToWidth:1,fitToHeight:0,printArea:`A1:B${outputRow-1}`};
 return Buffer.from(await workbook.xlsx.writeBuffer());
}
function splitText(text,width) {
 const chunks=[]; let chunk='',lines=0;
 for(const paragraph of text.split('\n')) {
 for(let start=0;start<Math.max(1,paragraph.length);start+=width) {
 const line=paragraph.slice(start,start+width);
 if(lines===22){chunks.push(chunk);chunk='';lines=0;}
 chunk+=(lines?'\n':'')+line;lines++;
 }
 }
 chunks.push(chunk);return chunks;
}
module.exports = {exportReport};
