// Multiplayer server settings.
// BROKER: your own PeerJS signaling server (see server/ and render.yaml). Leave null to use the free public
// PeerJS cloud only. When set, it is tried first and the public cloud is the fallback.
// Example after deploying to Render: { host: 'tlcr-peer.onrender.com', port: 443, path: '/', secure: true }
export const BROKER = null;

// ICE servers: STUN finds your public address, TURN relays traffic when a direct connection is
// impossible (strict NATs, mobile data). These are the free public Open Relay servers; replace
// with your own TURN credentials for heavy use.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
