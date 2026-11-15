import assert from "node:assert/strict";
import test from "node:test";
import {
  actingPlayerId,
  deviceOf,
  isLocalRoom,
  localPartnerId,
  localRoundSeconds,
  makeLocalPartner,
} from "../src/localPlay.js";
import type { Player } from "../src/types.js";

const host: Player = {
  id: "hostSocket",
  name: "Kaan",
  avatar: "boy-1",
  isHost: true,
  hasAnswered: false,
  supportsTextQuestions: true,
  supportsServerCoins: true,
  supportsWhoIsMoreLikely: true,
  supportsReactions: true,
  supportsRankIt: true,
  supportsDailyAnalysis: true,
  supportsTwoTruths: true,
};

const remote: Player = { ...host, id: "otherSocket", name: "Ece", isHost: false };

test("the local partner plays on the host's socket with the host's features", () => {
  const partner = makeLocalPartner(host, "Ayşe", "girl-2");
  assert.equal(partner.id, localPartnerId(host.id));
  assert.equal(partner.localOf, host.id);
  assert.equal(partner.isHost, false);
  assert.equal(partner.supportsTwoTruths, true);
  assert.equal(partner.supportsDailyAnalysis, true);
  // Reactions go to a partner's own phone; there is none.
  assert.equal(partner.supportsReactions, false);
  assert.equal(deviceOf(partner), host.id);
  assert.equal(deviceOf(host), host.id);
});

test("a room is local only with a partner on the host's phone", () => {
  assert.equal(isLocalRoom({ players: [host] }), false);
  assert.equal(isLocalRoom({ players: [host, remote] }), false);
  assert.equal(isLocalRoom({ players: [host, makeLocalPartner(host, "A", "b")] }), true);
});

test("a socket answers for itself, or for the partner on its phone", () => {
  const partner = makeLocalPartner(host, "Ayşe", "girl-2");
  const local = { players: [host, partner] };
  assert.equal(actingPlayerId(local, host.id, undefined), host.id);
  assert.equal(actingPlayerId(local, host.id, host.id), host.id);
  assert.equal(actingPlayerId(local, host.id, partner.id), partner.id);
  assert.equal(actingPlayerId(local, host.id, "nobody"), null);
  assert.equal(actingPlayerId(local, host.id, 42), null);
});

test("nobody can answer for a player on another phone", () => {
  const online = { players: [host, remote] };
  assert.equal(actingPlayerId(online, host.id, remote.id), null);
  assert.equal(actingPlayerId(online, remote.id, host.id), null);
  assert.equal(actingPlayerId(online, remote.id, undefined), remote.id);
  // A partner on the host's phone isn't the remote player's to answer for.
  const partner = makeLocalPartner(host, "Ayşe", "girl-2");
  assert.equal(actingPlayerId({ players: [host, partner] }, remote.id, partner.id), null);
});

test("a local round leaves time for both turns and the handoff", () => {
  assert.ok(localRoundSeconds(15) >= 30 + 60);
  assert.ok(localRoundSeconds(30) > localRoundSeconds(15));
});
