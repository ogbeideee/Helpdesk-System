import {useState} from 'react';
import {Modal} from './ui.jsx';
import {reportNoteFields} from '../weeklyReportView.js';

export default function WeeklyReportCarryForward({current,incoming,onClose,onApply}) {
 const [selected,setSelected]=useState([]);
 return <Modal title="Review carried-forward notes" onClose={onClose} width={700} className="weekly-review-modal"><div className="weekly-review-scroll"><p className="muted">Only selected sections replace your current notes. Current activity counts and descriptions are kept.</p>{reportNoteFields.map(([key,label])=><section className="weekly-carry-section" key={key}><label><input type="checkbox" checked={selected.includes(key)} onChange={e=>setSelected(s=>e.target.checked?[...s,key]:s.filter(k=>k!==key))} /> Replace {label.toLowerCase()}</label><div className="weekly-carry-columns"><div><span className="muted small">Current</span><p className="weekly-text">{current[key] || 'No note'}</p></div><div><span className="muted small">Previous report</span><p className="weekly-text">{incoming.notes[key] || 'No note'}</p></div></div></section>)}</div><div className="weekly-controls weekly-review-footer"><button className="btn" onClick={onClose}>Keep current notes</button><button className="btn btn-primary" disabled={!selected.length} onClick={()=>onApply(selected)}>Use selected notes</button></div></Modal>;
}
