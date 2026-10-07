// Presentation only. Keep the original text alternative and escape every value.
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notificationShell(inner, { title = 'Ticket update', tone = 'info', ticketNumber = '', replyFooter = true } = {}) {
  const color = { info: '#2563eb', warning: '#b45309', danger: '#b91c1c' }[tone] || '#2563eb';
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;color:#243247;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;"><tr><td align="center" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #dbe3ed;border-radius:12px;">
<tr><td style="padding:22px 28px;background-color:#17243b;color:#ffffff;font-size:18px;font-weight:700;">IT Helpdesk <span style="font-size:12px;font-weight:400;color:#cbd5e1;">&nbsp; / &nbsp; TicketDesk</span></td></tr>
<tr><td style="padding:24px 28px 16px;border-top:4px solid ${color};">${ticketNumber ? `<p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;">${escapeHtml(ticketNumber)}</p>` : ''}<h1 style="margin:0;color:${color};font-size:23px;line-height:1.3;">${escapeHtml(title)}</h1></td></tr>
<tr><td style="padding:0 28px 24px;font-size:15px;line-height:1.6;word-break:break-word;">${inner}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;">IT Helpdesk &mdash; TicketDesk${replyFooter ? '<br>Reply directly to this email to add information to the ticket.' : ''}</td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

function decorateMail(mail) {
  if (mail.html) return mail;
  const subject = String(mail.subject || 'Ticket update');
  const ticketNumber = /^\[(INC-[^\]]+)\]/.exec(subject)?.[1] || '';
  const heading = subject.replace(/^\[[^\]]+\]\s*/, '').split(': ')[0];
  const tone = /SLA approaching breach/i.test(heading) ? 'warning'
    : /SLA breached/i.test(heading) ? 'danger' : 'info';
  // The standard text footer is rendered by the shell; keep quoted reply text
  // and all other paragraphs intact. No user content becomes links or markup.
  const body = String(mail.body || '');
  const replyFooter = body.includes('Reply directly to this email to add information to the ticket.');
  const text = body.split(/\r?\n--\r?\nIT Helpdesk — TicketDesk/)[0];
  const inner = text.split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    const facts = lines.map(line => /^(Ticket|Subject|State|SLA|Status|Due|Remaining|Priority|Category|Group|Assigned to|Requester|From|Resolution target):\s+(.*)$/.exec(line));
    if (facts.length && facts.every(Boolean)) {
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid #e2e8f0;background-color:#f8fafc;">${facts.map(f => `<tr><th scope="row" align="left" valign="top" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:400;width:92px;">${escapeHtml(f[1])}</th><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#17243b;">${escapeHtml(f[2])}</td></tr>`).join('')}</table>`;
    }
    return `<p style="margin:0 0 16px;">${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('');
  return { ...mail, html: notificationShell(inner, { title: heading, tone, ticketNumber, replyFooter }) };
}

module.exports = { notificationShell, decorateMail };
