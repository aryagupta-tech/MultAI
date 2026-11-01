import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {CollaborationService} from '../src/collaboration.js';
import {createTestContext, seedActor} from './helpers.js';

const headers = (identity: {token: string}) => ({authorization: `Bearer ${identity.token}`});

test('replay links: host-only, cleaned up, paged, revocable and expiring', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Owner');
  const guest = await seedActor(ctx.db, 'Guest');
  const service = new CollaborationService(ctx.db);
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const created = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: headers(owner), payload: {requestId: randomUUID(), title: 'Fix the cart', message: {kind: 'instruction', text: 'Fix the **cart** total', image}}});
  const id = created.json().session.id as string;
  const invitation = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(guest.actor, {token: invitation.invitation.token});
  assert.ok('requestId' in join);
  await service.admit(owner.actor, id, join.requestId!, {role: 'collaborator'});
  await service.postMessage(guest.actor, id, {requestId: randomUUID(), kind: 'discussion', text: 'Looks good to me'});

  const denied = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${id}/replays`, headers: headers(guest), payload: {}});
  assert.equal(denied.statusCode, 403);
  const tooLong = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${id}/replays`, headers: headers(owner), payload: {expiresInSeconds: 90 * 86400}});
  assert.equal(tooLong.statusCode, 400);
  const made = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${id}/replays`, headers: headers(owner), payload: {expiresInSeconds: 86400}});
  assert.equal(made.statusCode, 201, made.body);
  const {id: replayId, token} = made.json().replay as {id: string; token: string};
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  const listed = await ctx.app.inject({url: `/v1/sessions/${id}/replays`, headers: headers(owner)});
  assert.deepEqual(listed.json().replays.map((item: {id: string}) => item.id), [replayId]);
  assert.equal(JSON.stringify(listed.json()).includes(token), false);

  // Anyone with the token, no sign-in.
  const view = await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token}});
  assert.equal(view.statusCode, 200, view.body);
  const body = view.json();
  assert.equal(body.replay.title, 'Fix the cart');
  const text = JSON.stringify(body);
  assert.equal(text.includes('iVBORw0KGgo'), false);
  assert.equal(text.includes(owner.actor.userId), false);
  assert.equal(text.includes(guest.actor.userId), false);
  const messages = body.events.filter((event: {type: string}) => event.type.startsWith('message.'));
  assert.deepEqual(messages.map((event: {who: string; data: {text: string; screenshot?: boolean}}) => [event.who, event.data.text, Boolean(event.data.screenshot)]), [['Host', 'Fix the **cart** total', true], ['Teammate 1', 'Looks good to me', false]]);
  assert.equal(body.events.some((event: {type: string}) => event.type.startsWith('invitation.') || event.type.startsWith('replay.')), false);
  assert.equal(body.done, true);
  const later = await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token, after: body.next}});
  assert.deepEqual(later.json().events, []);

  const wrong = await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token: randomBytes(32).toString('base64url')}});
  assert.equal(wrong.statusCode, 404);
  // Expired links stop working.
  await ctx.db.query("UPDATE replay_links SET expires_at=now()-interval '1 second' WHERE id=$1", [replayId]);
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token}})).statusCode, 404);
  // Revoked links stop working.
  const second = (await ctx.app.inject({method: 'POST', url: `/v1/sessions/${id}/replays`, headers: headers(owner), payload: {}})).json().replay as {id: string; token: string};
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token: second.token}})).statusCode, 200);
  const revoked = await ctx.app.inject({method: 'DELETE', url: `/v1/sessions/${id}/replays/${second.id}`, headers: headers(owner)});
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/replays/view', payload: {token: second.token}})).statusCode, 404);
});

test('the replay page is served with a strict policy of its own', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const page = await ctx.app.inject({url: '/replay'});
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /text\/html/u);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self'/u);
  assert.doesNotMatch(page.body, /<script>(?!<)/u);
  const script = await ctx.app.inject({url: '/replay.js'});
  assert.match(String(script.headers['content-type']), /javascript/u);
  assert.doesNotMatch(script.body, /innerHTML/u);
});
