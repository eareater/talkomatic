// server.js
// Jumble Clanker — Node.js Talkomatic bot with Express wrapper for easy hosting

const express = require('express');
const http = require('http');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3000;

// --- Minimal web server so Glitch/Render keep the app alive ---
const app = express();
app.get('/', (_req, res) => {
  res.type('text/plain').send('Jumble Clanker is running.\nSet ROOM_ID and check logs.\n');
});
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`[http] listening on :${PORT}`);
});

// --- Config ---
const ROOM_ID = process.env.ROOM_ID || '734117';
const USERNAME = process.env.USERNAME || 'Jumble Clanker';
const LOCATION = process.env.LOCATION || 'Clanker Jungle, Clanker';

// Try Classic first; if it rejects, fall back to dev
const HOSTS = [
  'https://classic.talkomatic.co',
  'https://dev.talkomatic.co',
];

// Persistent guestId so the server recognizes this bot between restarts
const GUEST_FILE = process.env.GUEST_FILE || '.guest_id';
function loadGuestId() {
  try {
    if (fs.existsSync(GUEST_FILE)) {
      const v = fs.readFileSync(GUEST_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch {}
  const v = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
  try { fs.writeFileSync(GUEST_FILE, v); } catch {}
  return v;
}
const GUEST_ID = process.env.GUEST_ID || loadGuestId();

// --- Bot state ---
let socket = null;
const users = new Map();  // id -> { name, text }
const recent = [];
const MAX_RECENT = 200;
let busy = false;

// Utils
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function jumbleFromRecent(maxWords = 24) {
  const all = recent.join(' ').split(/\s+/).filter(Boolean);
  if (!all.length) return '...';
  const sampled = Array.from({ length: maxWords }, () => all[(Math.random() * all.length) | 0]);
  const scrambled = sampled.map(w => {
    if (w.length <= 3 || Math.random() < 0.5) return w;
    const first = w[0], last = w[w.length - 1];
    const mid = w.slice(1, -1).split('');
    shuffle(mid);
    return first + mid.join('') + last;
  });
  return shuffle(scrambled).join(' ');
}
function sendTyping(text) {
  socket.emit('chat update', { diff: { type: 'full-replace', text } });
}
async function typeOut(text, baseMs = 28) {
  let buf = '';
  for (const ch of text) {
    buf += ch;
    sendTyping(buf);
    await new Promise(r => setTimeout(r, baseMs + ((Math.random() * 40) | 0)));
  }
}
async function maybeReply() {
  if (busy || recent.length === 0) return;
  if (Math.random() < 0.6) {
    busy = true;
    try {
      await typeOut(jumbleFromRecent(24), 28);
    } finally {
      busy = false;
    }
  }
}

// Join payload variants to satisfy differing implementations
const JOIN_TRIES = [
  ['join room', { roomId: ROOM_ID }],
  ['join room', { roomId: /^\d+$/.test(ROOM_ID) ? Number(ROOM_ID) : ROOM_ID }],
  ['join room', ROOM_ID],
  ['join room', { roomCode: ROOM_ID }],
  ['join room code', { code: ROOM_ID }],
];

function connectTo(hosts) {
  if (!hosts.length) {
    console.error('[connect] exhausted hosts');
    return;
  }
  const host = hosts[0];
  console.log('[connect] trying', host);

  socket = io(host, {
    transports: ['polling', 'websocket'],
    path: '/socket.io/',
    auth: { guestId: GUEST_ID, fingerprint: GUEST_ID },
    extraHeaders: { 'X-Guest-Id': GUEST_ID, 'User-Agent': 'JumbleClanker/1.0' },
    reconnection: true,
  });

  let joined = false;

  socket.on('connect', () => {
    console.log('[connect] connected; joining lobby');
    socket.emit('join lobby', { username: USERNAME, location: LOCATION, guestId: GUEST_ID });

    // attempt join formats until room joined event arrives
    let idx = 0;
    const tryJoin = () => {
      if (joined || idx >= JOIN_TRIES.length) return;
      const [eventName, payload] = JOIN_TRIES[idx++];
      console.log('[join] trying', eventName, '->', payload);
      socket.emit(eventName, payload);
      setTimeout(() => {
        if (!joined) tryJoin();
      }, 1500);
    };
    tryJoin();
  });

  socket.on('connect_error', (err) => {
    console.error('[connect] error', err && err.message || err);
    socket.close();
    connectTo(hosts.slice(1));
  });

  socket.on('error', (msg) => console.log('[server error]', msg));
  socket.on('notice', (msg) => console.log('[notice]', msg));

  socket.on('room joined', (data) => {
    if (joined) return;
    joined = true;
    console.log('[join] room joined!');
    users.clear();
    const current = data.currentMessages || {};
    (data.users || []).forEach(u => {
      const id = u.id;
      const name = u.username || 'Anonymous';
      const txt = current[id] || '';
      users.set(id, { name, text: txt });
    });
    typeOut('Hello from Jumble Clanker!');
  });

  socket.on('user joined', (user) => {
    const id = user.id;
    const name = user.username || 'Anonymous';
    users.set(id, { name, text: '' });
  });

  socket.on('user left', (id) => {
    users.delete(id);
  });

  socket.on('chat update', (data) => {
    const id = data.userId;
    if (!id) return;
    if (!users.has(id)) users.set(id, { name: `User-${String(id).slice(0,4)}`, text: '' });
    const info = users.get(id);

    if (data.diff) {
      const t = data.diff.type;
      if (t === 'full-replace') {
        info.text = data.diff.text || '';
      } else {
        const cur = info.text || '';
        if (t === 'add') {
          const idx = data.diff.index ?? cur.length;
          const txt = data.diff.text || '';
          info.text = cur.slice(0, idx) + txt + cur.slice(idx);
        } else if (t === 'delete') {
          const idx = data.diff.index ?? 0;
          const cnt = data.diff.count ?? 0;
          info.text = cur.slice(0, idx) + cur.slice(idx + cnt);
        } else if (t === 'replace') {
          const idx = data.diff.index ?? 0;
          const txt = data.diff.text || '';
          info.text = cur.slice(0, idx) + txt + cur.slice(idx + txt.length + 1);
        }
      }
    } else if (typeof data.message === 'string') {
      info.text = data.message;
      if (data.message.trim()) {
        recent.push(data.message.trim());
        if (recent.length > MAX_RECENT) recent.shift();
        maybeReply();
      }
    }
  });

  process.on('SIGINT', () => { try { socket.emit('chat update', { diff: { type: 'full-replace', text: '' } }); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { try { socket.emit('chat update', { diff: { type: 'full-replace', text: '' } }); } catch {} process.exit(0); });
}

// Kick off
connectTo(HOSTS);
console.log(`[boot] ROOM_ID=${ROOM_ID}, USERNAME=${USERNAME}, LOCATION=${LOCATION}, guestId=${GUEST_ID}`);
