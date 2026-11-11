const Excel = require('exceljs');
const CATEGORIES = ['Infrastructure','User Support','Hardware','Projects'];
const error = message => Object.assign(new Error(message), {status:400});
const normal = value => value.toLowerCase().replace(/[^a-z0-9]/g,'');
function checkArchive(buffer) {
 if (!Buffer.isBuffer(buffer) || buffer.length>2*1024*1024 || buffer.length<22) throw error('Upload an .xlsx report up to 2 MB.');
 let end=-1;
 for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--) if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0) throw error('This file is not a supported Excel workbook.');
 const count=buffer.readUInt16LE(end+10);let offset=buffer.readUInt32LE(end+16),total=0;
 if(count>300 || offset>=end) throw error('The workbook is too complex. Upload a simple weekly report.');
 for(let i=0;i<count;i++) {
 if(offset+46>end || buffer.readUInt32LE(offset)!==0x02014b50) throw error('Invalid workbook archive.');
 const size=buffer.readUInt32LE(offset+24),length=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32);
 const name=buffer.subarray(offset+46,offset+46+length).toString();total+=size;
 if(size>4*1024*1024 || total>10*1024*1024 || /vbaProject|externalLinks\/|embeddings\//i.test(name)) throw error('Upload a simple workbook without macros, external links or embedded files.');
 offset+=46+length+extra+comment;
 }
}
function plain(cell) {
 const value=cell.value;
 if(value==null || value instanceof Date) return '';
 if(typeof value==='string' || typeof value==='number') return String(value).trim();
 if(value.formula || value.sharedFormula) throw error('Report references must contain text, not formulas.');
 if(value.richText) return value.richText.map(t=>t.text).join('').trim();
 return typeof value.text==='string'?value.text.trim():'';
}
async function parseReference(buffer) {
 checkArchive(buffer);
 const workbook=new Excel.Workbook();
 try {await workbook.xlsx.load(buffer);} catch {throw error('Could not read this .xlsx file.');}
 const sheet=workbook.worksheets.find(s=>{
 for(let i=1;i<=Math.min(s.rowCount,500);i++) if(normal(plain(s.getCell(`A${i}`)))==='executivesummary')return true;
 return false;
 });
 if(!sheet || sheet.rowCount>500 || sheet.columnCount>2) throw error('Use the two-column Weekly IT Status Report format with the original section headings.');
 const rows=[];const cells=[];
 for(let row=1;row<=sheet.rowCount;row++) {
 rows.push({number:row,height:Math.min(409,sheet.getRow(row).height || 20)});
 for(const col of ['A','B']){const c=sheet.getCell(`${col}${row}`);plain(c);cells.push({address:c.address,style:JSON.parse(JSON.stringify(c.style))});}
 }
 const find=label=>{for(let row=1;row<=sheet.rowCount;row++)if(normal(plain(sheet.getCell(`A${row}`)))===normal(label))return row;throw error(`Missing report section: ${label}`);};
 const headings={summary:find('Executive Summary'),accomplishments:find('Key Accomplishments (This Week)'),ongoing:find('Ongoing Projects (In Progress)'),roadblocks:find('Roadblocks & Issues'),priorities:find('Priorities for Next Week')};
 if(!(headings.summary<headings.accomplishments && headings.accomplishments<headings.ongoing && headings.ongoing<headings.roadblocks && headings.roadblocks<headings.priorities)) throw error('Report sections must follow the sample report order.');
 const categoryRows=Object.fromEntries(CATEGORIES.map(category=>[category,find(category)]));
 const ordered=CATEGORIES.map(c=>categoryRows[c]);
 if(ordered.some((r,i)=>r<=headings.accomplishments || r>=headings.ongoing || (i>0 && r<=ordered[i-1]))) throw error('Keep Infrastructure, User Support, Hardware and Projects in the original order.');
 const section=(start,end,col='A')=>{const parts=[];for(let row=start;row<end;row++){const t=plain(sheet.getCell(`${col}${row}`));if(t)parts.push(t);}return parts.join('\n').slice(0,4000);};
 const accomplishments=Object.fromEntries(CATEGORIES.map((c,i)=>[c,section(categoryRows[c],ordered[i+1] || headings.ongoing,'B').slice(0,2500)]));
 const merges=sheet.model.merges || [];
 if(merges.some(m=>!/^A(\d+):B\1$/.test(m)))throw error('Use single-row merges across columns A and B only.');
 return {
 samples:{summary:section(headings.summary+1,headings.accomplishments).slice(0,3000),accomplishments},
 notes:{ongoing:section(headings.ongoing+1,headings.roadblocks),roadblocks:section(headings.roadblocks+1,headings.priorities,'B'),priorities:section(headings.priorities+1,sheet.rowCount+1)},
 layout:{columns:sheet.columns.map(c=>({width:Math.min(100,Math.max(10,c.width || 30))})),rows,merges,cells,pageSetup:{orientation:sheet.pageSetup.orientation || 'portrait'},anchors:{...headings,categoryRows,date:find('Date'),preparedBy:find('Prepared By'),department:find('Department')}},
 };
}
module.exports={parseReference,checkArchive};
