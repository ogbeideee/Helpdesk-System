// Presentation only. Keep the original text alternative and escape every value.
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notificationShell(inner, { title = 'Ticket update', tone = 'info', ticketNumber = '', ticketUrl = '', replyFooter = true } = {}) {
  const color = { info: '#2563eb', warning: '#b45309', danger: '#b91c1c' }[tone] || '#2563eb';
  const numberHtml = ticketUrl ? `<a href="${escapeHtml(ticketUrl)}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(ticketNumber)}</a>` : escapeHtml(ticketNumber);
  let logo = '';
  try {
    const base = new URL(process.env.PORTAL_BASE_URL || '');
    if (base.protocol === 'https:' && !base.username && !base.password) {
      const src = new URL('email-assets/bestaf-logo-full.png', base.origin + base.pathname.replace(/\/?$/, '/'));
      logo = `<td width="160" valign="middle" style="padding-right:16px;"><img src="${escapeHtml(src.toString())}" width="144" height="72" alt="BESTAF Technologies" style="display:block;width:144px;height:72px;border:0;"></td>`;
    }
  } catch { /* Text signature remains usable without a configured public URL. */ }
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;color:#243247;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;"><tr><td align="center" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #dbe3ed;border-radius:12px;">
<tr><td style="padding:22px 28px 16px;color:#475569;font-size:14px;font-weight:600;">IT Helpdesk</td></tr>
<tr><td style="padding:20px 28px 16px;border-top:2px solid ${color};">${ticketNumber ? `<p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:0.5px;">${numberHtml}</p>` : ''}<h1 style="margin:0;color:#17243b;font-size:24px;font-weight:600;line-height:1.3;">${escapeHtml(title)}</h1></td></tr>
<tr><td style="padding:0 28px 24px;font-size:15px;line-height:1.6;word-break:break-word;">${inner}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo}<td valign="middle"><strong style="color:#475569;font-size:13px;">IT Helpdesk</strong><br>BESTAF Technologies${replyFooter ? '<br>Reply to this email to continue the conversation.' : ''}</td></tr></table></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

function decorateMail(mail, options = {}) {
  if (mail.html) return mail;
  const subject = String(mail.subject || 'Ticket update');
  const ticketNumber = options.ticketNumber || /^\[(INC-[^\]]+)\]/.exec(subject)?.[1] || '';
  const rawHeading = subject.replace(/^\[[^\]]+\]\s*/, '').split(': ')[0];
  const heading = rawHeading.replace(/ SLA approaching breach/i, ' deadline approaching').replace(/ SLA breached/i, ' deadline missed');
  const tone = /SLA approaching breach/i.test(rawHeading) ? 'warning'
    : /SLA breached/i.test(rawHeading) ? 'danger' : 'info';
  // The standard text footer is rendered by the shell; keep quoted reply text
  // and all other paragraphs intact. No user content becomes links or markup.
  const body = String(mail.body || '');
  const replyFooter = body.includes('Reply directly to this email to add information to the ticket.');
  const text = body.split(/\r?\n--\r?\nIT Helpdesk — TicketDesk/)[0].trimEnd();
  const inner = text.split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    // Internal ticket notices keep their text alternative, but give the
    // subject and message preview distinct visual hierarchy in HTML.
    const preview = /^Subject:\s*([^\r\n]*)\r?\nExcerpt:\r?\n> ?([\s\S]*)$/.exec(block);
    if (preview) {
      return `<div style="margin:20px 0;"><p style="margin:0 0 6px;color:#64748b;font-size:12px;font-weight:600;">Subject</p><p style="margin:0 0 18px;color:#17243b;font-size:18px;font-weight:600;line-height:1.4;">${escapeHtml(preview[1])}</p><p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:600;">Message preview</p><blockquote style="margin:0;padding:14px 16px;border-left:3px solid #cbd5e1;background-color:#f8fafc;color:#475569;font-size:14px;line-height:1.7;">${escapeHtml(preview[2]).replace(/\r?\n/g, '<br>')}</blockquote></div>`;
    }
    if (options.ticketUrl && block === `Open ticket: ${options.ticketUrl}`) {
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td bgcolor="#2563eb" style="border-radius:6px;"><a href="${escapeHtml(options.ticketUrl)}" style="display:inline-block;padding:12px 20px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Open ticket</a></td></tr></table>`;
    }
    const facts = lines.map(line => /^(Ticket|Subject|State|SLA|Status|Due|Remaining|Priority|Category|Group|Team|Assigned|Assigned to|Requester|From|Resolution target|Target resolution):\s+(.*)$/.exec(line));
    if (facts.length && facts.every(Boolean)) {
      const isSla = /SLA (approaching breach|breached)/i.test(rawHeading);
      const visible = facts.filter(f => !(f[1] === 'Ticket' && ticketNumber) && !(isSla && f[1] === 'Status'));
      if (isSla) visible.sort((a, b) => {
        const order = ['Remaining', 'Due', 'Subject', 'State', 'SLA'];
        return order.indexOf(a[1]) - order.indexOf(b[1]);
      });
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid #e2e8f0;background-color:#f8fafc;">${visible.map(f => `<tr><th scope="row" align="left" valign="top" style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:400;width:92px;">${escapeHtml(f[1] === 'SLA' ? 'Target' : f[1])}</th><td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;line-height:1.5;color:#17243b;word-break:break-word;">${escapeHtml(f[2])}</td></tr>`).join('')}</table>`;
    }
    return `<p style="margin:0 0 16px;">${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('');
  return { ...mail, html: notificationShell(inner, { title: heading, tone, ticketNumber, replyFooter, ticketUrl: options.ticketUrl }) };
}

module.exports = { notificationShell, decorateMail };
