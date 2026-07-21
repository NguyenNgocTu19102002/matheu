const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── Load quiz data ──────────────────────────────────────────────────────────
const ALL_QUESTIONS = JSON.parse(fs.readFileSync('./quiz_data.json', 'utf-8'));
console.log(`✅ Loaded ${ALL_QUESTIONS.length} questions`);

// ── Room storage ────────────────────────────────────────────────────────────
// rooms: Map<roomCode, RoomState>
const rooms = new Map();

// ── Utilities ───────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

/** Prepare questions: shuffle pool + shuffle each option list */
function prepareQuestions(numQ) {
  return shuffle(ALL_QUESTIONS).slice(0, Math.min(numQ, ALL_QUESTIONS.length))
    .map(q => {
      const opts = shuffle([...q.opts]);
      return {
        id: q.id,
        q: q.q,
        opts: opts.map(o => o.text),         // text only
        correctIndex: opts.findIndex(o => o.correct)
      };
    });
}

/** Get sorted leaderboard from room */
function getLeaderboard(room) {
  return [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, nickname: p.nickname, score: p.score }));
}

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  // ── HOST: create room ───────────────────────────────────────────────────
  socket.on('host:create', ({ numQ = 20, timePerQ = 20, maxPlayers = 50 }) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      players: [],          // { id, nickname, score }
      maxPlayers,
      questions: prepareQuestions(numQ),
      currentQ: -1,
      status: 'waiting',    // waiting | question | reveal | finished
      timePerQ,
      answers: {},          // socketId → { index, timeMs, correct, points }
      timer: null
    };
    rooms.set(code, room);
    socket.data = { roomCode: code, role: 'host' };
    socket.join(`host-${code}`);

    socket.emit('host:created', { code, totalQ: room.questions.length });
    console.log(`[${code}] Room created — ${room.questions.length} questions, ${timePerQ}s/câu`);
  });

  // ── PLAYER: join room ───────────────────────────────────────────────────
  socket.on('player:join', ({ code, nickname }) => {
    const room = rooms.get(code.toUpperCase().trim());
    if (!room) return socket.emit('player:error', { msg: 'Mã phòng không tồn tại!' });
    if (room.status !== 'waiting') return socket.emit('player:error', { msg: 'Cuộc thi đã bắt đầu!' });
    if (room.maxPlayers > 0 && room.players.length >= room.maxPlayers) return socket.emit('player:error', { msg: 'Phòng thi đã đầy!' });

    const nick = nickname.trim().slice(0, 20);
    if (!nick) return socket.emit('player:error', { msg: 'Nhập nickname đi bạn!' });
    if (room.players.find(p => p.nickname.toLowerCase() === nick.toLowerCase()))
      return socket.emit('player:error', { msg: 'Nickname đã có người dùng!' });

    const player = { id: socket.id, nickname: nick, score: 0 };
    room.players.push(player);
    socket.data = { roomCode: room.code, role: 'player', nickname: nick };
    socket.join(room.code);

    socket.emit('player:joined', { nickname: nick });
    io.to(`host-${room.code}`).emit('host:lobby', {
      players: room.players.map(p => ({ nickname: p.nickname, score: p.score }))
    });
    console.log(`[${room.code}] ${nick} joined (${room.players.length} total)`);
  });

  // ── HOST: start game ────────────────────────────────────────────────────
  socket.on('host:start', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length === 0) return socket.emit('host:error', { msg: 'Chưa có người chơi nào!' });

    room.status = 'playing';
    io.to(room.code).emit('game:start', { totalQ: room.questions.length });
    io.to(`host-${room.code}`).emit('game:start', { totalQ: room.questions.length });
    sendQuestion(room.code);
  });

  // ── HOST: next question / end ───────────────────────────────────────────
  socket.on('host:next', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.hostId !== socket.id || room.status !== 'reveal') return;
    if (room.currentQ + 1 >= room.questions.length) {
      endGame(room.code);
    } else {
      sendQuestion(room.code);
    }
  });

  // ── HOST: end game manually ─────────────────────────────────────────────
  socket.on('host:end', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.hostId !== socket.id) return;
    endGame(room.code);
  });

  // ── PLAYER: submit answer ───────────────────────────────────────────────
  socket.on('player:answer', ({ index, timeMs }) => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.status !== 'question') return;
    if (room.answers[socket.id]) return; // duplicate

    const q = room.questions[room.currentQ];
    const correct = q.correctIndex === index;
    const timeRatio = Math.max(0, 1 - timeMs / (room.timePerQ * 1000));
    const points = correct ? Math.round(500 + 500 * timeRatio) : 0;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.score += points;

    room.answers[socket.id] = { index, timeMs, correct, points };
    socket.emit('player:ack', { correct, points });

    // Update host live counter
    emitAnswerUpdate(room);

    // Auto reveal when all answered
    if (Object.keys(room.answers).length >= room.players.length) {
      clearTimeout(room.timer);
      reveal(room.code);
    }
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomCode, role, nickname } = socket.data || {};
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === 'host') {
      clearTimeout(room.timer);
      io.to(roomCode).emit('game:host-left', { msg: 'Host đã rời phòng. Cuộc thi kết thúc.' });
      rooms.delete(roomCode);
      console.log(`[${roomCode}] Host disconnected — room deleted`);
    } else {
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(`host-${roomCode}`).emit('host:lobby', {
        players: room.players.map(p => ({ nickname: p.nickname, score: p.score }))
      });
      console.log(`[${roomCode}] ${nickname} left (${room.players.length} remaining)`);
    }
  });
});

// ── Game helpers ──────────────────────────────────────────────────────────────
function sendQuestion(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.currentQ++;
  room.status = 'question';
  room.answers = {};

  const q = room.questions[room.currentQ];
  const payload = {
    index: room.currentQ,
    total: room.questions.length,
    text: q.q,
    opts: q.opts,
    timePerQ: room.timePerQ
  };

  // Players get question without correctIndex
  io.to(roomCode).emit('player:question', payload);

  // Host gets full question including correct answer marker
  io.to(`host-${roomCode}`).emit('host:question', {
    ...payload,
    correctIndex: q.correctIndex
  });

  emitAnswerUpdate(room);

  room.timer = setTimeout(() => reveal(roomCode), room.timePerQ * 1000);
  console.log(`[${roomCode}] Q${room.currentQ + 1}/${room.questions.length}`);
}

function emitAnswerUpdate(room) {
  const answered = Object.keys(room.answers).length;
  const total = room.players.length;
  const dist = Array(4).fill(0);
  Object.values(room.answers).forEach(a => { if (a.index >= 0 && a.index < dist.length) dist[a.index]++; });
  io.to(`host-${room.code}`).emit('host:answer-update', { answered, total, dist });
}

function reveal(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'question') return;
  room.status = 'reveal';
  clearTimeout(room.timer);

  const q = room.questions[room.currentQ];
  const lb = getLeaderboard(room);

  // Each player gets personalised result
  room.players.forEach(p => {
    const ans = room.answers[p.id];
    io.to(p.id).emit('player:reveal', {
      correctIndex: q.correctIndex,
      yourIndex: ans ? ans.index : -1,
      correct: ans ? ans.correct : false,
      points: ans ? ans.points : 0,
      totalScore: p.score,
      leaderboard: lb.slice(0, 5),
      hasNext: room.currentQ + 1 < room.questions.length
    });
  });

  const dist = Array(4).fill(0);
  Object.values(room.answers).forEach(a => { if (a.index >= 0 && a.index < dist.length) dist[a.index]++; });

  io.to(`host-${roomCode}`).emit('host:reveal', {
    correctIndex: q.correctIndex,
    leaderboard: lb,
    dist,
    hasNext: room.currentQ + 1 < room.questions.length,
    answered: Object.keys(room.answers).length,
    total: room.players.length
  });
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.status = 'finished';
  clearTimeout(room.timer);
  const lb = getLeaderboard(room);
  io.to(roomCode).emit('game:over', { leaderboard: lb });
  io.to(`host-${roomCode}`).emit('game:over', { leaderboard: lb });
  console.log(`[${roomCode}] Game over`);
  setTimeout(() => rooms.delete(roomCode), 3_600_000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LOCAL_IP = getLocalIP();

server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('🎮  QUIZ MATTHEU — Multiplayer Server');
  console.log('========================================');
  console.log(`🖥️  Host panel : http://localhost:${PORT}/host`);
  console.log(`📱  Người chơi: http://${LOCAL_IP}:${PORT}`);
  console.log('----------------------------------------');
  console.log('🌐  Để chơi qua Internet, chạy ngrok:');
  console.log('    ngrok http 3000');
  console.log('========================================\n');
});
