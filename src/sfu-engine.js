// kScreen engine with two transports:
//  - "mesh": the original P2P mesh (P2PEngine in webrtc.js), one connection per pair of people.
//  - "sfu":  one connection per person to the media server (LiveKit). The server receives each
//            stream once and forwards it to whoever watches, so the upload doesn't grow with
//            the room and nobody depends on a direct route to everyone else.
//
// The server decides the room's mode and can change it while the room is open (hybrid rooms, see
// server/sfu-nodes.js): it comes with every poll and applyRoomMode follows it. Everything that
// isn't transport stays in P2PEngine: capture, mic processing, voice state, "watching",
// previews, the room roster and presence. In SFU mode a "peer" is a LiveKit participant whose
// identity is its room peer id, and the control/files data channels become LiveKit data
// messages behind objects that behave like RTCDataChannel, so setupDataChannel and P2PFiles
// work unchanged.

import { P2PEngine, SHARE_AUDIO_QUALITIES } from './webrtc.js';

const MIC_BITRATE = 64_000;
// P2P -> SFU without a gap: open P2P connections stay up (still carrying video, voice and
// messages) until the media server delivers the same things, then close. This is the longest
// they wait for that.
const HANDOFF_MAX_MS = 12_000;
// A new video through the media server replaces the P2P one only once it has a decoded frame,
// so the card never goes black in between.
const HANDOFF_FRAME_WAIT_MS = 5_000;
const SFU_NET_RECHECK_MS = 30_000;
const CAMERA_BITRATE = 1_200_000;
// Data messages are split in parts the server forwards safely (reliable packets above ~15 KB
// are not guaranteed); the receiver joins them back, so the API still sees whole messages.
const MAX_PART = 14 * 1024;
const FLAG_BINARY = 1;
const FLAG_MORE = 2;
const TOPIC_CONTROL = 'kc';
const TOPIC_FILES = 'kf';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let livekitModule = null;
function loadLivekit() {
  livekitModule ||= import('livekit-client').catch((err) => {
    livekitModule = null;
    throw err;
  });
  return livekitModule;
}

// Enough of RTCDataChannel for setupDataChannel (control) and P2PFiles (files).
class PeerChannel extends EventTarget {
  constructor(engine, peerId, topic) {
    super();
    this.engine = engine;
    this.peerId = peerId;
    this.topic = topic;
    this.label = topic === TOPIC_FILES ? 'files' : 'control';
    this.readyState = 'connecting';
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.chain = Promise.resolve();
    this.parts = [];
  }

  open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.parts = [];
    const event = new Event('close');
    this.onclose?.(event);
    this.dispatchEvent(event);
    // Anyone waiting for the buffer to drain must not hang.
    this.dispatchEvent(new Event('bufferedamountlow'));
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    let bytes;
    let flags = 0;
    if (typeof data === 'string') {
      bytes = encoder.encode(data);
    } else {
      flags = FLAG_BINARY;
      bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    for (let off = 0; off < bytes.byteLength || off === 0; off += MAX_PART) {
      const end = Math.min(bytes.byteLength, off + MAX_PART);
      const frame = new Uint8Array(1 + end - off);
      frame[0] = flags | (end < bytes.byteLength ? FLAG_MORE : 0);
      frame.set(bytes.subarray(off, end), 1);
      this.queue(frame);
      if (end >= bytes.byteLength) break;
    }
  }

  // Sent one after another (order matters for the parts); bufferedAmount counts what is not
  // yet handed to the server connection, like a real channel's buffer.
  queue(frame) {
    const size = frame.byteLength;
    this.bufferedAmount += size;
    this.chain = this.chain
      .then(() => this.engine.sfuPublishData(this.peerId, this.topic, frame))
      .catch(() => { /* room closed: the channel closes with it */ })
      .finally(() => {
        const before = this.bufferedAmount;
        this.bufferedAmount = Math.max(0, before - size);
        if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.dispatchEvent(new Event('bufferedamountlow'));
        }
      });
  }

  receive(frame) {
    if (this.readyState !== 'open' || !frame?.byteLength) return;
    const flags = frame[0];
    this.parts.push(frame.subarray(1));
    if (flags & FLAG_MORE) return;
    const parts = this.parts;
    this.parts = [];
    let bytes = parts[0];
    if (parts.length > 1) {
      bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.byteLength; }
    }
    const data = flags & FLAG_BINARY
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : decoder.decode(bytes);
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }
}

export class KScreenEngine extends P2PEngine {
  constructor(options = {}) {
    super(options);
    // "mesh" | "sfu" | null (not in a room): what the server said this room uses.
    this.roomMode = null;
    // { lk, room } while connected (or connecting) to the media server
    this.sfu = null;
    // Bumped on every (re)start/close so stale connection attempts give up.
    this.sfuGen = 0;
    this.sfuSyncing = false;
    this.sfuSyncAgain = false;
    this.sfuRepublish = new Set();
    this.sfuStatsInterval = null;
    // P2P -> SFU handoffs in progress: peer id -> { mesh, peer, got, sentReady, timer }
    this.handoffs = new Map();
    // A room that may need the media server: load its client ahead, so switching costs no download.
    this.netProbe?.then((net) => { if (net && net.nat !== 'cone') this.sfuPreload(); });
  }

  sfuPreload() {
    loadLivekit().catch(() => {});
  }

  isSfu() {
    return this.roomMode === 'sfu';
  }

  // --- ROOM & MODE ---

  joinExtras() {
    // sfu: this client speaks SFU. hybrid: it follows the room between P2P and SFU from the poll
    // (the room starts P2P and moves to the SFU when it grows or someone can't connect).
    // mode/sfuNode: after a server restart the room is recreated by whoever re-joins first, and
    // must come back in the mode (and on the media server) everyone is already using.
    const node = this.sfuKey?.split('@')[0];
    return { sfu: true, hybrid: true, ...(this.roomMode ? { mode: this.roomMode } : {}), ...(node ? { sfuNode: node } : {}) };
  }

  async register() {
    const data = await super.register();
    this.applyRoomMode(data.mode, data.sfu);
    return data;
  }

  // The poll carries the room's mode and, in the SFU, which media server ("node@rev").
  handlePollExtras(data) {
    if (data?.mode) this.applyRoomMode(data.mode, data.sfu);
    // In the SFU, check the network again every 30 s: it may allow P2P now (5G -> Wi-Fi), and
    // not every browser says when the network changes (Safari on iPhone never does).
    if (this.isSfu() && Date.now() - this.netAt > SFU_NET_RECHECK_MS) this.refreshNetwork(true);
  }

  applyRoomMode(rawMode, key) {
    const mode = rawMode === 'sfu' ? 'sfu' : 'mesh';
    const previous = this.roomMode;
    this.roomMode = mode;
    if (previous && previous !== mode && this.activeRoomId) {
      this.switchMode(mode);
      return;
    }
    // Same mode, other media server (moved by the admin, failover, or the node was edited):
    // connect again with a new token. The tracks are published again on the new server.
    if (mode === 'sfu' && key && this.sfuKey && key !== this.sfuKey && this.activeRoomId) {
      this.log('A sala foi movida para outro servidor de mídia. Reconectando...', 'warn');
      this.sfuKey = key;
      this.sfuStart();
    }
  }

  // Mesh recovery and failure reports mean nothing in the SFU.
  checkStuckPeers() {
    if (!this.isSfu()) super.checkStuckPeers();
  }

  failReport() {
    return this.isSfu() ? [] : super.failReport();
  }

  // kbps sent/received through the media server, for the admin panel's traffic per node.
  pollQuery() {
    let query = super.pollQuery();
    if (this.isSfu() && this.sfuTraffic) query += `&sfu=${this.sfuTraffic.up}.${this.sfuTraffic.down}`;
    return query;
  }

  async joinRoom(...args) {
    // Any room can move to the media server; with its client loaded already, that costs no download.
    this.sfuPreload();
    const roomId = await super.joinRoom(...args);
    if (this.isSfu() && this.activeRoomId) {
      this.log('Esta sala usa o servidor de mídia (SFU).');
      this.sfuStart();
    }
    return roomId;
  }

  // Only after a server restart with a different configuration: drop everything and use the
  // room's new mode.
  switchMode(mode) {
    this.log(`A sala mudou para ${mode === 'sfu' ? 'o servidor de mídia (SFU)' : 'P2P direto'}. Reconectando...`, 'warn');
    this.sfuEndAllHandoffs();
    for (const [id, peer] of [...this.peers]) {
      // To the SFU: working P2P connections stay until the media server shows the same person
      // (sfuAddPeer takes them over), so streams and voice never stop. The rest goes now.
      if (mode === 'sfu' && !peer.virtual && peer.pc?.connectionState === 'connected') {
        peer.handoffPending = true;
        clearTimeout(peer.timers.handoff);
        peer.timers.handoff = setTimeout(() => {
          if (this.peers.get(id) === peer) this.removePeer(id, { keepStream: true });
        }, HANDOFF_MAX_MS);
        continue;
      }
      this.removePeer(id, { keepStream: true });
    }
    for (const f of this.linkFails.values()) clearTimeout(f.timer);
    this.linkFails.clear();
    this.sfuTraffic = null;
    if (mode === 'sfu') {
      this.sfuStart();
    } else {
      this.sfuClose();
      this.sfuKey = null;
    }
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  disconnect(options) {
    this.sfuEndAllHandoffs();
    super.disconnect(options);
    this.sfuClose();
    this.roomMode = null;
    this.sfuKey = null;
    this.sfuTraffic = null;
  }

  // --- MESH HOOKS (no-ops, or SFU versions, in an SFU room) ---

  connectTo(info) {
    if (!this.isSfu()) return super.connectTo(info);
    const participant = this.sfu?.room?.remoteParticipants.get(info.id);
    if (participant) this.sfuAddPeer(participant);
    return null;
  }

  syncRoster(list, initial) {
    super.syncRoster(list, initial);
    // The mesh only dials from the smaller id; here anyone in both the roster and the media
    // room is a peer (e.g. back after a moment missing from the roster).
    if (!this.isSfu() || !this.sfu?.room) return;
    for (const participant of this.sfu.room.remoteParticipants.values()) {
      if (this.roster.has(participant.identity) && !this.peers.get(participant.identity)?.virtual) this.sfuAddPeer(participant);
    }
  }

  async handleIncomingSignal(msg) {
    if (this.isSfu()) return;
    return super.handleIncomingSignal(msg);
  }

  attachLocalTracks(peer) {
    if (this.isSfu()) this.sfuSync();
    else super.attachLocalTracks(peer);
  }

  async applyVideoEncoding(peer) {
    if (!this.isSfu()) return super.applyVideoEncoding(peer);
  }

  async applyAudioEncoding(peer) {
    if (!this.isSfu()) return super.applyAudioEncoding(peer);
  }

  async applyCameraEncoding(peer) {
    if (!this.isSfu()) return super.applyCameraEncoding(peer);
  }

  // The server forwards one upload to every viewer: each viewer gets the full bitrate.
  bitrateViewers() {
    return this.isSfu() ? 1 : super.bitrateViewers();
  }

  async setShareSettings(settings) {
    const next = await super.setShareSettings(settings);
    if (this.isSfu() && this.localStream) {
      // Bitrate and audio quality are publish options: publish the stream again with them.
      this.sfuRepublish.add('screen_share');
      this.sfuRepublish.add('screen_share_audio');
      this.sfuSync();
    }
    return next;
  }

  goLive(stream) {
    super.goLive(stream);
    if (this.isSfu()) this.sfuSync();
  }

  stopScreenShare() {
    super.stopScreenShare();
    if (this.isSfu()) this.sfuSync();
  }

  async toggleMute() {
    const muted = await super.toggleMute();
    if (this.isSfu()) this.sfuSync();
    return muted;
  }

  async openMicMuted() {
    const stream = await super.openMicMuted();
    if (this.isSfu()) this.sfuSync();
    return stream;
  }

  releaseMutedMic() {
    const closed = super.releaseMutedMic();
    if (closed && this.isSfu()) this.sfuSync();
    return closed;
  }

  useCameraStream(stream) {
    super.useCameraStream(stream);
    if (this.isSfu()) this.sfuSync();
  }

  stopCamera() {
    super.stopCamera();
    if (this.isSfu()) this.sfuSync();
  }

  setWatching(peerId, on) {
    super.setWatching(peerId, on);
    const peer = this.peers.get(peerId);
    if (this.isSfu() && peer?.participant) this.sfuUpdateSubscriptions(peer);
  }

  // Black screen (see checkVideoHealth): subscribe again, which makes the server ask the sender
  // for a keyframe. From the second try on, take the lighter layer (half size), which is what
  // switching to 480p did by hand.
  healVideo(peer, tries = 1) {
    if (!this.isSfu()) return super.healVideo(peer, tries);
    const lk = this.sfu?.lk;
    const publication = lk && peer.participant?.getTrackPublication(lk.Track.Source.ScreenShare);
    if (!publication) return;
    // 2nd try: 720p (within H.264 level 3.1); 3rd on: 360p.
    if (tries >= 2) {
      const low = tries >= 3;
      publication.setVideoQuality(low ? lk.VideoQuality.LOW : lk.VideoQuality.MEDIUM);
      this.log(`Recebendo a transmissão de "${peer.name}" em ${low ? '360p' : '720p'}.`, 'warn');
    }
    publication.setSubscribed(false);
    setTimeout(() => {
      if (this.peers.get(peer.id) === peer && this.watching.has(peer.id)) publication.setSubscribed(true);
    }, 500);
  }

  restartIce() {
    if (!this.isSfu()) return super.restartIce();
    this.log('Reconectando ao servidor de mídia...');
    this.sfuStart();
  }

  removePeer(peerId, options = {}) {
    const peer = this.peers.get(peerId);
    if (!peer?.virtual) return super.removePeer(peerId, options);
    this.peers.delete(peerId);
    for (const timer of Object.values(peer.timers)) clearTimeout(timer);
    peer.dc?.close();
    peer.fileDc?.close();
    if (!options.keepStream) {
      this.watching.delete(peerId);
      this.onPeerStreamEnded(peerId, 'all');
    }
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  routeReport() {
    if (!this.isSfu()) return super.routeReport();
    return [...this.peers.values()].filter(p => p.virtual && p.status === 'connected').map(p => `${p.id}.s`).join(',');
  }

  startStatsMonitoring() {
    super.startStatsMonitoring();
    clearInterval(this.sfuStatsInterval);
    this.sfuStatsInterval = setInterval(() => this.sfuCollectStats(), 2000);
  }

  stopStatsMonitoring() {
    super.stopStatsMonitoring();
    clearInterval(this.sfuStatsInterval);
    this.sfuStatsInterval = null;
  }

  // --- MEDIA SERVER CONNECTION ---

  // Connects (again) to the media server, retrying with backoff until it works or we leave.
  async sfuStart() {
    this.sfuClose();
    // People of the previous media connection hold its participants and tracks: drop them (the
    // cards stay, as ghosts) so the new connection subscribes to everything again.
    for (const peer of [...this.peers.values()]) if (peer.virtual) this.removePeer(peer.id, { keepStream: true });
    const gen = ++this.sfuGen;
    const session = this.session;
    const alive = () => gen === this.sfuGen && this.session === session && this.isSfu() && !!this.activeRoomId;
    for (let attempt = 0; alive(); attempt++) {
      try {
        await this.sfuConnectOnce(alive);
        return;
      } catch (err) {
        if (!alive()) return;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
        this.log(`Servidor de mídia indisponível (${err.message}). Tentando de novo em ${Math.round(delay / 1000)} s...`, 'warn');
        this.setStatus('connecting');
        await sleep(delay);
      }
    }
  }

  async sfuConnectOnce(alive) {
    const lk = await loadLivekit();
    const res = await fetch('/api/sfu/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: this.activeRoomId, peerId: this.myPeerId })
    });
    if (!res.ok) throw new Error(`token HTTP ${res.status}`);
    const { url, token, key, node } = await res.json();
    if (!alive()) return;
    this.sfuKey = key || null;

    const room = new lk.Room({
      // Our own <video> elements are not attached through LiveKit, so it can't measure them.
      adaptiveStream: false,
      // Layers nobody subscribes to are paused at the sender: no upload when nobody watches.
      dynacast: true,
      // Media is published by sfuSync with explicit options.
      publishDefaults: { stopMicTrackOnMute: false },
      // The tracks are ours (screen capture, mic, camera): leaving a media server (migration,
      // reconnect) must never stop them, or the stream dies while the app thinks it is live.
      stopLocalTrackOnUnpublish: false
    });
    this.sfu = { lk, room };
    this.sfuWire(lk, room);
    try {
      await room.connect(url, token, { autoSubscribe: false });
    } catch (err) {
      if (this.sfu?.room === room) this.sfu = null;
      room.removeAllListeners();
      throw err;
    }
    if (!alive() || this.sfu?.room !== room) {
      room.removeAllListeners();
      room.disconnect(false).catch(() => {});
      return;
    }
    this.log(`Conectado ao servidor de mídia${node ? ` (${node})` : ''}.`, 'success');
    for (const participant of room.remoteParticipants.values()) this.sfuAddPeer(participant);
    this.sfuRepublish.clear();
    this.sfuSync();
    this.refreshStatus();
    this.notifyPeersUpdate();
  }

  sfuWire(lk, room) {
    const E = lk.RoomEvent;
    const mine = () => this.sfu?.room === room;
    room
      .on(E.ParticipantConnected, (participant) => { if (mine()) this.sfuAddPeer(participant); })
      .on(E.ParticipantDisconnected, (participant) => {
        // Still in the room roster = the media server dropped them (restart, network) and they
        // come back: keep what we were watching.
        const id = participant.identity;
        if (mine() && this.peers.get(id)?.virtual) this.removePeer(id, { keepStream: this.roster.has(id) });
      })
      .on(E.TrackPublished, (publication, participant) => {
        const peer = mine() && this.sfuPeerOf(participant);
        if (peer) this.sfuUpdateSubscriptions(peer);
      })
      .on(E.TrackSubscribed, (track, publication, participant) => {
        if (mine()) this.sfuTrackSubscribed(track, publication, participant);
      })
      .on(E.TrackUnsubscribed, (track, publication, participant) => {
        if (mine()) this.sfuTrackUnsubscribed(track, publication, participant);
      })
      .on(E.DataReceived, (payload, participant, kind, topic) => {
        if (!mine() || !participant) return;
        const peer = this.sfuPeerOf(participant);
        const channel = topic === TOPIC_FILES ? peer?.fileDc : topic === TOPIC_CONTROL ? peer?.dc : null;
        channel?.receive(payload);
      })
      .on(E.TrackStreamStateChanged, (publication, state, participant) => {
        // The server pauses a video when not even its lightest version fits our connection.
        const peer = mine() && this.sfuVirtual(participant.identity);
        if (!peer || publication.source !== lk.Track.Source.ScreenShare || !this.watching.has(peer.id)) return;
        if (state === lk.Track.StreamState.Paused) {
          this.log(`O servidor pausou a transmissão de "${peer.name}" para você: sua conexão não está comportando nem a versão mais leve agora.`, 'warn');
        } else if (state === lk.Track.StreamState.Active) {
          this.log(`Transmissão de "${peer.name}" retomada.`);
        }
      })
      .on(E.Reconnecting, () => {
        if (!mine()) return;
        this.log('Conexão com o servidor de mídia instável. Reconectando...', 'warn');
        for (const peer of this.peers.values()) if (peer.virtual) peer.status = 'reconnecting';
        this.refreshStatus();
        this.notifyPeersUpdate();
      })
      .on(E.Reconnected, () => {
        if (!mine()) return;
        this.log('Reconectado ao servidor de mídia.', 'success');
        for (const peer of this.peers.values()) if (peer.virtual) peer.status = 'connected';
        this.sfuSync();
        this.refreshStatus();
        this.notifyPeersUpdate();
      })
      .on(E.Disconnected, () => {
        if (!mine()) return;
        // LiveKit gave up on its own reconnection: start over with a new token.
        this.sfu = null;
        room.removeAllListeners();
        for (const peer of [...this.peers.values()]) if (peer.virtual) this.removePeer(peer.id, { keepStream: true });
        if (this.isSfu() && this.activeRoomId) {
          this.log('Desconectado do servidor de mídia. Reconectando...', 'warn');
          this.sfuStart();
        }
      });
  }

  sfuClose() {
    this.sfuGen++;
    const room = this.sfu?.room;
    this.sfu = null;
    this.sfuRepublish.clear();
    if (!room) return;
    room.removeAllListeners();
    room.disconnect(false).catch(() => {});
  }

  sfuPublishData(peerId, topic, frame) {
    const room = this.sfu?.room;
    if (!room || room.state !== 'connected') return Promise.reject(new Error('offline'));
    return room.localParticipant.publishData(frame, { reliable: true, destinationIdentities: [peerId], topic });
  }

  // --- PEERS ---

  sfuAddPeer(participant) {
    const id = participant?.identity;
    if (!id || id === this.myPeerId || this.departed.has(id)) return null;
    const existing = this.peers.get(id);
    // Still on its P2P connection (the room just moved to the SFU): take it over below.
    const mesh = existing && !existing.virtual ? existing : null;
    if (existing && !mesh) {
      if (existing.participant !== participant) {
        existing.participant = participant;
        this.sfuUpdateSubscriptions(existing);
      }
      return existing;
    }
    const info = this.roster.get(id) || {};
    const peer = {
      id,
      virtual: true,
      participant,
      name: info.name || participant.name || `Usuário-${id.slice(-4)}`,
      avatarUrl: info.avatarUrl || '/avatar.png',
      device: info.device,
      connId: 'sfu',
      initiator: false,
      polite: true,
      pc: null,
      dc: null,
      fileDc: null,
      directFileDc: null,
      transceivers: null,
      remoteStream: new MediaStream(),
      // Replaced by a new stream object on every (un)subscribe so <video> elements notice.
      screenStream: new MediaStream(),
      cameraStream: new MediaStream(),
      screenAudioTrack: null,
      micTrack: null,
      isStreaming: false,
      remoteHasAudio: false,
      micMuted: true,
      deafened: false,
      speaking: false,
      cameraOn: false,
      watching: new Set(),
      preview: null,
      status: 'connected',
      missing: 0,
      createdAt: Date.now(),
      timers: {},
      stats: {
        pingMs: 0, rttMs: 0, isIpv6: false, isRelay: false, routeKnown: true,
        connectionShort: 'Servidor', connectionName: 'Via servidor de mídia (SFU)', protocol: 'UDP'
      }
    };
    if (mesh) this.sfuAdoptMesh(peer, mesh);
    this.peers.set(id, peer);
    peer.dc = new PeerChannel(this, id, TOPIC_CONTROL);
    this.setupDataChannel(peer, peer.dc);
    peer.fileDc = new PeerChannel(this, id, TOPIC_FILES);
    peer.directFileDc = peer.fileDc;
    this.onFileChannel(peer, peer.fileDc);
    peer.dc.open();
    peer.fileDc.open();
    this.log(`"${peer.name}" conectado pelo servidor de mídia.`, 'success');
    if (mesh) this.sfuSeedHandoff(peer);
    this.sfuUpdateSubscriptions(peer);
    this.refreshStatus();
    this.notifyPeersUpdate();
    return peer;
  }

  // Voice and camera always; a stream (screen + its sound) only while we watch it.
  sfuUpdateSubscriptions(peer) {
    const lk = this.sfu?.lk;
    if (!lk || !peer.participant) return;
    const S = lk.Track.Source;
    for (const publication of peer.participant.trackPublications.values()) {
      const isStream = publication.source === S.ScreenShare || publication.source === S.ScreenShareAudio;
      const want = isStream ? this.watching.has(peer.id) : true;
      if (publication.isDesired !== want) publication.setSubscribed(want);
    }
  }

  sfuTrackSubscribed(track, publication, participant) {
    const peer = this.sfuPeerOf(participant);
    if (!peer) return;
    const S = this.sfu.lk.Track.Source;
    const mst = track.mediaStreamTrack;
    if (!mst) return;
    // Handoff: the P2P video keeps playing until this one has a picture.
    const video = publication.source === S.ScreenShare || publication.source === S.Camera;
    if (video && this.handoffs.get(peer.id)?.peer === peer) {
      this.sfuWhenDecoding(track).then(() => {
        if (this.peers.get(peer.id) !== peer || publication.track !== track || !publication.isSubscribed) return;
        this.sfuApplyTrack(peer, publication.source, mst);
      });
      return;
    }
    this.sfuApplyTrack(peer, publication.source, mst);
  }

  sfuApplyTrack(peer, source, mst) {
    const S = this.sfu?.lk.Track.Source;
    if (!S) return;
    switch (source) {
      case S.ScreenShare:
        peer.screenStream = new MediaStream([mst]);
        if (!peer.statusFromChannel) peer.isStreaming = true;
        break;
      case S.Camera:
        peer.cameraStream = new MediaStream([mst]);
        break;
      case S.ScreenShareAudio:
        this.sfuSetAudio(peer, 'screenAudioTrack', mst);
        break;
      case S.Microphone:
        this.sfuSetAudio(peer, 'micTrack', mst);
        peer.remoteHasAudio = true;
        break;
      default:
        return;
    }
    const h = this.handoffs.get(peer.id);
    if (h?.peer === peer) h.got.add(source);
    this.onPeerStream(peer.id, peer.remoteStream, mst, peer);
    this.notifyPeersUpdate();
    if (h?.peer === peer) this.sfuHandoffCheck(peer.id);
  }

  sfuTrackUnsubscribed(track, publication, participant) {
    const peer = this.sfuVirtual(participant.identity);
    if (!peer || !this.sfu) return;
    const S = this.sfu.lk.Track.Source;
    const mst = track.mediaStreamTrack;
    switch (publication.source) {
      case S.ScreenShare:
        if (peer.screenStream.getTracks().includes(mst)) peer.screenStream = new MediaStream();
        break;
      case S.Camera:
        if (peer.cameraStream.getTracks().includes(mst)) peer.cameraStream = new MediaStream();
        break;
      case S.ScreenShareAudio:
        if (peer.screenAudioTrack === mst) this.sfuSetAudio(peer, 'screenAudioTrack', null);
        break;
      case S.Microphone:
        if (peer.micTrack === mst) this.sfuSetAudio(peer, 'micTrack', null);
        break;
      default:
        return;
    }
    this.onPeerStream(peer.id, peer.remoteStream, mst, peer);
    this.notifyPeersUpdate();
  }

  sfuSetAudio(peer, key, track) {
    const old = peer[key];
    if (old && old !== track) {
      try { peer.remoteStream.removeTrack(old); } catch { /* already gone */ }
    }
    peer[key] = track;
    if (track && !peer.remoteStream.getTracks().includes(track)) peer.remoteStream.addTrack(track);
  }

  // --- P2P -> SFU HANDOFF ---
  // When a P2P room moves to the media server, each working P2P connection is kept until both
  // sides get, through the server, everything it was carrying (the stream being watched, camera,
  // voice). Meanwhile the person on screen is already the media-server peer, playing the P2P
  // tracks; each one is swapped for the server's as soon as it has a picture or sound. Then this
  // side says so (`handoff_ready`, only to pages that announce `handoff` in caps), and the P2P
  // connection closes once the other side said the same, or after HANDOFF_MAX_MS.

  // The media-server peer for this id (never a P2P one waiting to be taken over).
  sfuVirtual(id) {
    const peer = this.peers.get(id);
    return peer?.virtual ? peer : null;
  }

  sfuPeerOf(participant) {
    return this.sfuVirtual(participant?.identity) || this.sfuAddPeer(participant);
  }

  // The new peer starts with what the P2P one knew and played.
  sfuAdoptMesh(peer, mesh) {
    for (const key of ['isStreaming', 'statusFromChannel', 'remoteHasAudio', 'micMuted', 'deafened', 'speaking', 'cameraOn', 'preview']) peer[key] = mesh[key];
    peer.watching = new Set(mesh.watching);
    const t = mesh.transceivers;
    const seeded = {
      screen: mesh.screenStream || null,
      camera: mesh.cameraStream || null,
      micTrack: t?.mic?.receiver.track || null,
      screenAudioTrack: t?.screenAudio?.receiver.track || null
    };
    if (seeded.screen) peer.screenStream = seeded.screen;
    if (seeded.camera) peer.cameraStream = seeded.camera;
    // Out of the room's peers, but still connected: no rebuilds, no reports, no new signals.
    for (const timer of Object.values(mesh.timers)) clearTimeout(timer);
    mesh.timers = {};
    mesh.handoffTo = peer;
    const pc = mesh.pc;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.sfuEndHandoff(peer.id);
    };
    const h = { mesh, peer, seeded, got: new Set(), sentReady: false, timer: null };
    h.timer = setTimeout(() => this.sfuEndHandoff(peer.id), HANDOFF_MAX_MS);
    this.handoffs.set(peer.id, h);
  }

  // Audio goes in after the channels exist (sfuSetAudio fills remoteStream).
  sfuSeedHandoff(peer) {
    const h = this.handoffs.get(peer.id);
    if (!h) return;
    for (const key of ['micTrack', 'screenAudioTrack']) {
      if (h.seeded[key]?.readyState === 'live') this.sfuSetAudio(peer, key, h.seeded[key]);
    }
    for (const track of peer.remoteStream.getTracks()) this.onPeerStream(peer.id, peer.remoteStream, track, peer);
    this.sfuHandoffCheck(peer.id);
  }

  // Ready when everything we use from them comes through the server now.
  sfuHandoffCheck(id) {
    const h = this.handoffs.get(id);
    const S = this.sfu?.lk.Track.Source;
    if (!h || !S || this.peers.get(id) !== h.peer) return;
    const { peer, mesh } = h;
    const need = [];
    if (peer.isStreaming && this.watching.has(id)) need.push(S.ScreenShare);
    if (peer.cameraOn) need.push(S.Camera);
    if (!peer.micMuted) need.push(S.Microphone);
    if (need.some(source => !h.got.has(source))) return;
    if (!h.sentReady) {
      h.sentReady = true;
      if (mesh.canHandoff) this.sendTo(mesh, { type: 'handoff_ready' });
    }
    // Pages without the handoff don't wait for us (they closed already, or will).
    if (!mesh.canHandoff || mesh.handoffPeerReady) this.sfuEndHandoff(id);
  }

  meshHandoffReady(mesh) {
    const h = this.handoffs.get(mesh.id);
    if (h?.mesh === mesh) this.sfuHandoffCheck(mesh.id);
  }

  sfuEndHandoff(id) {
    const h = this.handoffs.get(id);
    if (!h) return;
    this.handoffs.delete(id);
    clearTimeout(h.timer);
    const { mesh, peer, seeded } = h;
    mesh.pc.onconnectionstatechange = null;
    // A moment later, so a `handoff_ready` just sent on it still reaches the other side.
    setTimeout(() => {
      mesh.handoffTo = null;
      try { mesh.dc?.close(); } catch { /* already closed */ }
      try { mesh.fileDc?.close(); } catch { /* already closed */ }
      try { mesh.pc.close(); } catch { /* already closed */ }
    }, 1000);
    if (this.peers.get(id) !== peer) return;
    // Whatever still plays from the P2P connection ends with it.
    let changed = false;
    if (seeded.screen && peer.screenStream === seeded.screen) { peer.screenStream = new MediaStream(); changed = true; }
    if (seeded.camera && peer.cameraStream === seeded.camera) { peer.cameraStream = new MediaStream(); changed = true; }
    for (const key of ['micTrack', 'screenAudioTrack']) {
      if (seeded[key] && peer[key] === seeded[key]) { this.sfuSetAudio(peer, key, null); changed = true; }
    }
    if (changed) this.notifyPeersUpdate();
  }

  sfuEndAllHandoffs() {
    for (const id of [...this.handoffs.keys()]) this.sfuEndHandoff(id);
  }

  // Resolves once this received video track has decoded a frame (or after a while, anyway).
  async sfuWhenDecoding(track) {
    const end = Date.now() + HANDOFF_FRAME_WAIT_MS;
    while (Date.now() < end) {
      try {
        let decoded = false;
        (await track.getRTCStatsReport?.())?.forEach((item) => {
          if (item.type === 'inbound-rtp' && item.framesDecoded > 0) decoded = true;
        });
        if (decoded) return;
      } catch { /* not receiving yet */ }
      await sleep(150);
    }
  }

  // --- PUBLISHING ---

  // Makes what we publish match what we capture. Serialized: calls during a run trigger one
  // more run at the end.
  async sfuSync() {
    if (this.sfuSyncing) {
      this.sfuSyncAgain = true;
      return;
    }
    this.sfuSyncing = true;
    try {
      do {
        this.sfuSyncAgain = false;
        await this.sfuSyncOnce();
      } while (this.sfuSyncAgain);
    } catch (err) {
      this.log(`Falha ao publicar no servidor de mídia: ${err.message}`, 'warn');
    } finally {
      this.sfuSyncing = false;
    }
  }

  async sfuSyncOnce() {
    const room = this.sfu?.room;
    if (!room || room.state !== 'connected' || !this.activeRoomId) return;
    const S = this.sfu.lk.Track.Source;
    const local = room.localParticipant;
    const wanted = [
      [S.Microphone, this.micStream?.getAudioTracks()[0] || null],
      [S.Camera, this.cameraStream?.getVideoTracks()[0] || null],
      [S.ScreenShare, this.localStream?.getVideoTracks()[0] || null],
      [S.ScreenShareAudio, this.localStream?.getAudioTracks()[0] || null]
    ];
    for (const [source, track] of wanted) {
      if (this.sfu?.room !== room) return;
      const publication = local.getTrackPublication(source);
      const current = publication?.track?.mediaStreamTrack || null;
      const stale = !!publication && (current !== track || this.sfuRepublish.has(source));
      if (stale) await local.unpublishTrack(publication.track, false);
      this.sfuRepublish.delete(source);
      if (track && track.readyState === 'live' && (!publication || stale)) {
        await local.publishTrack(track, this.sfuPublishOptions(source, track));
      }
    }
  }

  sfuPublishOptions(source, track) {
    const { Track, VideoPreset } = this.sfu.lk;
    const S = Track.Source;
    if (source === S.ScreenShare) {
      const fps = this.shareSettings.fps;
      const { width = 1920, height = 1080 } = track.getSettings();
      // The server forwards one copy: 1080p60 looks fine at 8 Mbps. Bigger bursts only make the
      // keyframes huge, and a lost keyframe is a black screen until the next one arrives.
      const bitrate = Math.min(this.getTargetBitrate(), height > 1100 ? 12_000_000 : 8_000_000);
      const short = Math.min(width, height);
      const scaled = (lines) => {
        const k = lines / short;
        return [Math.round(width * k / 2) * 2, Math.round(height * k / 2) * 2];
      };
      // Simulcast ladder, so every viewer always has a version that fits:
      // 360p at ~0.5 Mbps (always), 720p (when the source is bigger) and the original on top.
      // Both lower layers stay within H.264 level 3.1 (up to 720p), what browsers announce and
      // some hardware decoders enforce: above it they show nothing.
      const layers = [];
      if (short > 400) layers.push(new VideoPreset(...scaled(360), fps > 30 ? 700_000 : 500_000, Math.min(fps, 30)));
      if (short > 800) layers.push(new VideoPreset(...scaled(720), fps > 30 ? 2_500_000 : 1_500_000, fps));
      return {
        source,
        name: 'screen',
        // Hardware encoders: H.264 is the one almost every GPU has (same choice as the mesh).
        videoCodec: 'h264',
        simulcast: layers.length > 0,
        screenShareEncoding: { maxBitrate: bitrate, maxFramerate: fps, priority: 'high' },
        ...(layers.length ? { screenShareSimulcastLayers: layers } : {}),
        degradationPreference: 'maintain-framerate'
      };
    }
    if (source === S.ScreenShareAudio) {
      const quality = SHARE_AUDIO_QUALITIES[this.shareSettings.audioQuality] || SHARE_AUDIO_QUALITIES.max;
      return { source, name: 'screen-audio', dtx: false, red: false, forceStereo: true, audioPreset: { maxBitrate: quality.bitrate, priority: 'high' } };
    }
    if (source === S.Camera) {
      return { source, name: 'camera', simulcast: true, videoEncoding: { maxBitrate: CAMERA_BITRATE, maxFramerate: 30 } };
    }
    return { source, name: 'mic', dtx: true, red: true, audioPreset: { maxBitrate: MIC_BITRATE, priority: 'high' } };
  }

  // --- STATS ---

  // Bytes through the media server (all our published tracks out, all subscribed tracks in),
  // turned into kbps for the poll every few seconds.
  async sfuMeasureTraffic(room) {
    const now = Date.now();
    if (now - (this.sfuTrafficAt || 0) < 5000) return;
    let sent = 0;
    let received = 0;
    const add = async (track, type) => {
      if (!track?.getRTCStatsReport) return;
      try {
        const report = await track.getRTCStatsReport();
        report?.forEach(item => {
          if (item.type === type) {
            if (type === 'outbound-rtp') sent += item.bytesSent || 0;
            else received += item.bytesReceived || 0;
          }
        });
      } catch { /* (un)publishing */ }
    };
    for (const publication of room.localParticipant.trackPublications.values()) await add(publication.track, 'outbound-rtp');
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) if (publication.isSubscribed) await add(publication.track, 'inbound-rtp');
    }
    const last = this.sfuBytes;
    this.sfuBytes = { sent, received, at: now };
    this.sfuTrafficAt = now;
    if (!last || now <= last.at) return;
    const kbps = (a, b) => Math.max(0, Math.round((a - b) * 8 / (now - last.at)));
    // A track that went away makes the sum drop: count it as zero, not negative.
    this.sfuTraffic = { up: kbps(sent, last.sent), down: kbps(received, last.received) };
  }

  async sfuCollectStats() {
    const room = this.sfu?.room;
    if (!this.isSfu() || !room || room.state !== 'connected') return;
    await this.sfuMeasureTraffic(room);
    const S = this.sfu.lk.Track.Source;
    let sending = null;
    const screen = room.localParticipant.getTrackPublication(S.ScreenShare)?.track;
    if (screen && this.localStream) {
      try { sending = this.videoFlow(await screen.getRTCStatsReport(), 'outbound-rtp', this.sfuSending); } catch { /* republishing */ }
      this.sfuSending = sending;
    }
    for (const peer of this.peers.values()) {
      if (!peer.virtual) continue;
      let receiving = null;
      const remote = peer.participant?.getTrackPublication(S.ScreenShare)?.track;
      if (remote && peer.isStreaming) {
        try { receiving = this.videoFlow(await remote.getRTCStatsReport(), 'inbound-rtp', peer.stats.receiving); } catch { /* unsubscribed */ }
      }
      peer.stats = { ...peer.stats, sending, receiving };
      this.checkVideoHealth(peer);
    }
    this.notifyPeersUpdate();
  }
}
