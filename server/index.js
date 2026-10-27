// Free-tier friendly PeerJS signaling server. It only helps two browsers find each other;
// all gameplay data flows directly between players.
const { PeerServer } = require('peer');

const port = +process.env.PORT || 9000;
const server = PeerServer({
  port,
  path: '/',
  proxied: true,              // behind Render / Fly / Railway style proxies
  allow_discovery: false,     // room codes can't be listed
  concurrent_limit: 500,
  alive_timeout: 60000,
  corsOptions: { origin: true },
});

server.on('connection', (c) => console.log('peer connected', c.getId()));
server.on('disconnect', (c) => console.log('peer left', c.getId()));
console.log(`PeerJS signaling server listening on :${port}`);
