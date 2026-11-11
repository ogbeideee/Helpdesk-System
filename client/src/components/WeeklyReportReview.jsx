import {Modal} from './ui.jsx';
import {reviewActivities} from '../weeklyReportView.js';

export default function WeeklyReportReview({report,busy,error,onClose,onGenerate}) {
 const activities=reviewActivities(report.data.activities);
 return <Modal title="Review your week" onClose={busy?undefined:onClose} width={700} className="weekly-review-modal">
 <div className="weekly-review-scroll" role="region" aria-label="Activities to review" tabIndex={0}>
 <p className="muted">Check the counts and notes that will be used to write your report.</p>
 {error && <p role="alert">{error}</p>}
 <div className="weekly-review-list">{activities.length?activities.map(a=><section key={a.id} className="weekly-review-item">
 <div className="weekly-activity-heading"><strong>{a.label}</strong><span>{a.count} {a.count===1?'time':'times'}</span></div>
 <p className="muted small">{a.category}{a.category==='Projects'?` · ${a.statusLabel}`:''}</p>
 {a.description && <p className="weekly-text">{a.description}</p>}
 {a.prompt && <p className="weekly-review-prompt">{a.prompt}</p>}
 </section>):<p>No activities recorded. The report will state that no activity was recorded.</p>}</div>
 {report.data.automatic && <p>Tickets resolved: {report.ticketCount}. This total is refreshed when the report is generated.</p>}
 </div>
 <div className="weekly-controls weekly-review-footer"><button className="btn" disabled={busy} onClick={onClose}>Back to entries</button><button className="btn btn-primary" disabled={busy} onClick={onGenerate}>{busy?'Generating…':'Generate report'}</button></div>
 </Modal>;
}
