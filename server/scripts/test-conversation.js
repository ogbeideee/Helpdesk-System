const fixture = require('./lib/testdb').use('conversation');
const assert = require('node:assert/strict');
const prisma = require('../src/lib/prisma');
const { app } = require('../server');
const { signToken } = require('../src/authMiddleware');
const service = require('../src/services/conversationService');
const { intakeEmailMessage } = require('../src/services/ticketIntake');

async function main() {
  const displayedTrail = service.displayMessage('Current reply.\nFrom: Person <person@example.com>\nSent: Thursday\nTo: Team\nSubject: Earlier\nOld reply.\n--\nOld signature');
  assert.equal(displayedTrail.cleanBody, 'Current reply.');
  assert.equal(displayedTrail.quotedMessages[0].headers.from, 'Person <person@example.com>');
  assert.equal(displayedTrail.quotedMessages[0].cleanBody, 'Old reply.');
  assert.equal(displayedTrail.quotedMessages[0].signature, 'Old signature');
  const admin = await prisma.agent.create({ data: { name: 'Thread admin', email: 'admin@example.com', role: 'admin' } });
  const agent = await prisma.agent.create({ data: { name: 'Thread agent', email: 'agent@example.com', role: 'agent' } });
  const source = await prisma.ticket.create({ data: { ticketNumber: 'INC-002001', shortDescription: 'Original request',
    requesterEmail: 'requester@example.com', body: 'Please repair the screen.\n\nOn Monday, Example wrote:\n> Older request' } });
  const target = await prisma.ticket.create({ data: { ticketNumber: 'INC-002002', shortDescription: 'Destination', requesterEmail: 'requester@example.com' } });
  const inbound = await intakeEmailMessage({ messageId: 'thread-reply-1', internetMessageId: 'thread-reply-1@example.com',
    from: 'requester@example.com', subject: 'Re: INC-002001', body: 'Still broken.\n\nOn Monday, Example wrote:\n> Previous message' },
    { logger: { log() {}, warn() {} } });
  assert.equal(inbound.comment.ticketId, source.id);
  assert.equal(JSON.parse(inbound.comment.threadingMetadata).reason, 'ticket_number');
  const comment = inbound.comment;
  const attachment = await prisma.attachment.create({ data: { ticketId: source.id, commentId: comment.id,
    filename: 'evidence.txt', size: 12, storageKey: 'test-thread-attachment' } });
  await prisma.comment.create({ data: { ticketId: source.id, isInternal: true, authorAgentId: agent.id, body: '> Keep this internal text exactly' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/tickets`;
  const request = async (path, actor = admin, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${signToken(actor)}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const first = await request(`/${source.id}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.conversation.unreadIds, [comment.id]);
    assert.equal(first.data.conversation.awaiting, 'agent');
    assert.equal(first.data.originalMessage.cleanBody, 'Please repair the screen.');
    const message = first.data.comments.find(c => c.id === comment.id);
    assert.equal(message.displayMessage.cleanBody, 'Still broken.');
    assert(message.body.includes('Previous message'));
    assert.equal(message.threading.reason, 'ticket_number');
    assert.equal(first.data.comments.find(c => c.isInternal).displayMessage.cleanBody, '> Keep this internal text exactly');
    const ordinary = await request(`/${source.id}`, agent);
    assert(!ordinary.data.comments.find(c => c.id === comment.id).threading);
    assert(!ordinary.data.conversation.originalThreading);
    assert.equal((await request(`/${source.id}/conversation/read`, admin, { through: first.data.conversation.snapshotAt })).status, 200);
    assert.deepEqual((await request(`/${source.id}`)).data.conversation.unreadIds, []);
    assert.deepEqual((await request(`/${source.id}`, agent)).data.conversation.unreadIds, [comment.id]);
    const cursor = await prisma.ticketConversationRead.findUnique({ where: { ticketId_agentId: { ticketId: source.id, agentId: admin.id } } });
    await service.markRead(source.id, admin.id, '2000-01-01T00:00:00Z');
    assert.equal((await prisma.ticketConversationRead.findUnique({ where: { ticketId_agentId: { ticketId: source.id, agentId: admin.id } } })).lastReadAt.getTime(), cursor.lastReadAt.getTime());
    assert.equal((await request(`/${source.id}/conversation/read`, admin, { through: 'invalid' })).status, 400);
    assert.equal((await request(`/${source.id}/conversation/read`, admin, { through: '2099-01-01T00:00:00Z' })).status, 400);
    const move = { targetTicketNumber: target.ticketNumber, note: 'This reply concerns the other request' };
    assert.equal((await request(`/${source.id}/conversation/${comment.id}/move`, agent, move)).status, 403);
    assert.equal((await request(`/${source.id}/conversation/${comment.id}/move`, admin, { ...move, note: '' })).status, 400);
    const internal = ordinary.data.comments.find(c => c.isInternal);
    assert.equal((await request(`/${source.id}/conversation/${internal.id}/move`, admin, move)).status, 400);
    const moved = await request(`/${source.id}/conversation/${comment.id}/move`, admin, move);
    assert.equal(moved.status, 200);
    assert.equal((await prisma.comment.findUnique({ where: { id: comment.id } })).body, comment.body);
    assert.equal((await prisma.attachment.findUnique({ where: { id: attachment.id } })).ticketId, target.id);
    assert.equal((await prisma.ticket.findUnique({ where: { id: source.id } })).state, 'NEW');
    assert.equal((await prisma.ticket.findUnique({ where: { id: target.id } })).state, 'NEW');
    assert.equal(await prisma.auditEvent.count({ where: { action: 'ticket.thread_corrected' } }), 2);
    assert.equal((await request(`/${source.id}/conversation/${comment.id}/move`, admin, move)).status, 409);
    const destination = (await request(`/${target.id}`)).data;
    assert.equal(destination.comments[0].threading.reason, 'manual_correction');
    assert.deepEqual(destination.conversation.unreadIds, [comment.id]);
    const queue = (await request('/queue')).data;
    assert.equal(queue.tickets.find(t => t.id === target.id).lastReply.unreadCount, 1);
    await prisma.comment.create({ data: { ticketId: target.id, authorAgentId: agent.id, authorEmail: agent.email, body: 'Please try again' } });
    assert.equal((await request(`/${target.id}`)).data.conversation.awaiting, 'requester');
    const outside = await prisma.comment.create({ data: { ticketId: target.id, viaEmail: true, isRequester: true, authorEmail: 'vendor@example.com', body: 'Additional context' } });
    assert.equal((await request(`/${target.id}`)).data.comments.find(c => c.id === outside.id).messageType, 'participant');
    await prisma.ticket.update({ where: { id: source.id }, data: { state: 'CLOSED' } });
    assert.equal((await request(`/${target.id}/conversation/${outside.id}/move`, admin, { targetTicketNumber: source.ticketNumber, note: 'Bad destination' })).status, 400);
    console.log('Conversation checks passed: original text, message types, per-user unread snapshots, monotonic cursors, reply ownership, attachments, audits, permissions and open destinations.');
  } finally { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); fixture.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
