import {useEffect,useId,useRef,useState} from 'react';
import {activityFrequency,frequencyCount,validMultipleCount} from '../weeklyReportView.js';

export default function WeeklyActivityFrequency({label,count,onChange}) {
 const name=useId();
 const lastMultiple=useRef(Math.max(2,count));
 const [number,setNumber]=useState(String(count));
 const mode=activityFrequency(count);
 if(count>=2)lastMultiple.current=count;
 useEffect(()=>setNumber(String(count)),[count]);
 return <>
 <fieldset className="weekly-frequency" aria-label={`${label}: times performed this week`}>
 <legend>Times performed this week</legend>
 <div className="weekly-frequency-options">{[['none','Not done'],['once','Once'],['multiple','Multiple times']].map(([value,text])=><label key={value} className={`weekly-frequency-option${mode===value?' is-selected':''}`}>
 <input type="radio" name={name} value={value} checked={mode===value} onChange={()=>onChange(frequencyCount(value,lastMultiple.current))} />{text}
 </label>)}</div>
 </fieldset>
 {mode==='multiple' && <div className="weekly-multiple">
 <label htmlFor={`${name}-count`}>Number of times</label>
 <div className="weekly-counter">
 <button type="button" className="btn" aria-label={`Decrease ${label}`} disabled={count<=2} onClick={()=>onChange(count-1)}>−</button>
 <input id={`${name}-count`} type="number" min="2" max="100000" aria-label={`${label} count`} value={number} onChange={e=>{setNumber(e.target.value);if(validMultipleCount(e.target.value))onChange(Number(e.target.value));}} onBlur={()=>setNumber(String(count))} />
 <button type="button" className="btn" aria-label={`Increase ${label}`} disabled={count>=100000} onClick={()=>onChange(count+1)}>+</button>
 </div>
 </div>}
 </>;
}
