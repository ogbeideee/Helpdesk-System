// Human-readable ticket numbers: <PREFIX>-<NNNNNN> (default INC-000001).
// Prefix/width are configurable via TICKET_NUMBER_PREFIX / TICKET_NUMBER_WIDTH
// so the scheme can be aligned with ITSM conventions without code changes.
const PREFIX = (process.env.TICKET_NUMBER_PREFIX || 'INC').toUpperCase();
const WIDTH = Number(process.env.TICKET_NUMBER_WIDTH) || 6;
const GLOBAL_SEQUENCE_YEAR = 0; // sentinel row = single global sequence

async function nextTicketNumber(tx) {
  const seq = await tx.ticketSequence.upsert({
    where: { year: GLOBAL_SEQUENCE_YEAR },
    create: { year: GLOBAL_SEQUENCE_YEAR, last: 1 },
    update: { last: { increment: 1 } },
  });
  return `${PREFIX}-${String(seq.last).padStart(WIDTH, '0')}`;
}

// Matches ticket references like INC-000123 or legacy HD-2026-000042 in
// subjects/bodies so replies can be threaded onto the right ticket.
const TICKET_REF_RE = /\b([A-Z]{2,4}-\d{6}|[A-Z]{2}-\d{4}-\d{6})\b/i;

function extractTicketRef(subject, bodyText) {
  const inSubject = String(subject || '').match(TICKET_REF_RE);
  if (inSubject) return inSubject[1].toUpperCase();
  // Only look near the top of the body to avoid quoting deep threads.
  const head = String(bodyText || '').slice(0, 2000);
  const inBody = head.match(TICKET_REF_RE);
  return inBody ? inBody[1].toUpperCase() : null;
}

module.exports = {
  PREFIX,
  WIDTH,
  nextTicketNumber,
  extractTicketRef,
};
