import { io } from "socket.io-client";

// Configuration
const SERVER_URL =
  process.env.TEST_SERVER_URL || "https://knowusbetterapp-backend.onrender.com";
const CONCURRENT_CONNECTIONS = parseInt(
  process.env.TEST_CONNECTIONS || "100",
  10
);
const TEST_DURATION = parseInt(process.env.TEST_DURATION || "60000", 10); // 60 seconds
const ROOMS_TO_CREATE = parseInt(process.env.TEST_ROOMS || "20", 10); // Create 20 rooms
const PLAYERS_PER_ROOM = 2; // 2 players per room

// Statistics
const stats = {
  connected: 0,
  disconnected: 0,
  errors: 0,
  messages: 0,
  roomsCreated: 0,
  roomsJoined: 0,
  messagesSent: 0,
  startTime: Date.now(),
};

// Store rooms and sockets
const rooms = [];
const sockets = [];
const socketRooms = new Map(); // socket.id -> roomCode

// Categories for testing
const categories = ["just-friends", "we_just_met", "long_term"];
const avatars = [
  "boy_avatar_1",
  "boy_avatar_2",
  "girl_avatar_1",
  "girl_avatar_2",
];

// Random helper functions
function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomName() {
  const names = [
    "Alice",
    "Bob",
    "Charlie",
    "Diana",
    "Eve",
    "Frank",
    "Grace",
    "Henry",
    "Ivy",
    "Jack",
  ];
  return `${randomItem(names)}${Math.floor(Math.random() * 1000)}`;
}

console.log(`🚀 Starting comprehensive load test...`);
console.log(`📡 Server: ${SERVER_URL}`);
console.log(`👥 Target connections: ${CONCURRENT_CONNECTIONS}`);
console.log(`🏠 Rooms to create: ${ROOMS_TO_CREATE}`);
console.log(`⏱️  Duration: ${TEST_DURATION / 1000} seconds\n`);

// Create socket connections and assign roles
let socketIndex = 0;
let roomIndex = 0;

// Phase 1: Create rooms (hosts)
for (
  let i = 0;
  i < ROOMS_TO_CREATE && socketIndex < CONCURRENT_CONNECTIONS;
  i++
) {
  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: true,
    timeout: 10000,
  });

  const socketId = socketIndex;
  socketIndex++;

  socket.on("connect", () => {
    stats.connected++;
    if (stats.connected % 10 === 0) {
      console.log(`✅ Connected: ${stats.connected}/${CONCURRENT_CONNECTIONS}`);
    }

    // Register user
    socket.emit("register-user", `test-user-${socketId}`);

    // Create room after a short delay
    setTimeout(() => {
      const category = randomItem(categories);
      const playerName = randomName();
      const avatar = randomItem(avatars);

      socket.emit("create-room", {
        playerName,
        avatar,
        category,
      });
    }, Math.random() * 1000); // Random delay 0-1s
  });

  socket.on("room-created", (data) => {
    stats.roomsCreated++;
    const roomCode = data.roomCode;
    rooms.push({ roomCode, hostSocket: socket });
    socketRooms.set(socket.id, roomCode);
    console.log(
      `🏠 Room created: ${roomCode} (${stats.roomsCreated}/${ROOMS_TO_CREATE})`
    );
  });

  socket.on("room-error", (error) => {
    stats.errors++;
    console.error(`❌ Room error [${socketId}]:`, error.message);
  });

  socket.on("disconnect", () => {
    stats.disconnected++;
  });

  socket.on("connect_error", (error) => {
    stats.errors++;
    console.error(`❌ Connection error [${socketId}]:`, error.message);
  });

  socket.onAny((event, ...args) => {
    stats.messages++;
  });

  sockets.push(socket);
}

// Phase 2: Join rooms (guests)
for (
  let i = 0;
  i < ROOMS_TO_CREATE && socketIndex < CONCURRENT_CONNECTIONS;
  i++
) {
  const socket = io(SERVER_URL, {
    transports: ["websocket"],
    reconnection: true,
    timeout: 10000,
  });

  const socketId = socketIndex;
  socketIndex++;

  socket.on("connect", () => {
    stats.connected++;
    if (stats.connected % 10 === 0) {
      console.log(`✅ Connected: ${stats.connected}/${CONCURRENT_CONNECTIONS}`);
    }

    // Register user
    socket.emit("register-user", `test-user-${socketId}`);

    // Wait for rooms to be created, then join
    setTimeout(() => {
      if (rooms.length > 0) {
        const room = randomItem(rooms);
        const playerName = randomName();
        const avatar = randomItem(avatars);

        socket.emit("join-room", {
          roomCode: room.roomCode,
          playerName,
          avatar,
        });
      }
    }, 2000 + Math.random() * 2000); // Wait 2-4 seconds for rooms to be created
  });

  socket.on("room-joined", (data) => {
    stats.roomsJoined++;
    socketRooms.set(socket.id, data.roomCode);
    console.log(
      `👥 Joined room: ${data.roomCode} (${stats.roomsJoined}/${ROOMS_TO_CREATE})`
    );
  });

  socket.on("room-error", (error) => {
    stats.errors++;
    console.error(`❌ Room error [${socketId}]:`, error.message);
  });

  socket.on("disconnect", () => {
    stats.disconnected++;
  });

  socket.on("connect_error", (error) => {
    stats.errors++;
    console.error(`❌ Connection error [${socketId}]:`, error.message);
  });

  socket.onAny((event, ...args) => {
    stats.messages++;
  });

  sockets.push(socket);
}

// Phase 3: Send chat messages periodically
setInterval(() => {
  // Randomly select some sockets to send messages
  const activeSockets = sockets.filter(
    (s) => s.connected && socketRooms.has(s.id)
  );
  const messagesToSend = Math.min(5, Math.floor(activeSockets.length * 0.1)); // 10% of active sockets

  for (let i = 0; i < messagesToSend; i++) {
    const socket = randomItem(activeSockets);
    const roomCode = socketRooms.get(socket.id);
    if (roomCode) {
      const messages = [
        "Hello!",
        "How are you?",
        "Let's play!",
        "Good luck!",
        "Nice!",
      ];
      socket.emit("send-message", {
        roomCode,
        message: randomItem(messages),
      });
      stats.messagesSent++;
    }
  }
}, 5000); // Every 5 seconds

// Phase 4: Some hosts start games
setTimeout(() => {
  console.log(`\n🎮 Starting games in some rooms...`);
  rooms.forEach((room, index) => {
    if (index % 3 === 0 && room.hostSocket && room.hostSocket.connected) {
      // Start game in every 3rd room
      setTimeout(() => {
        room.hostSocket.emit("start-game", { roomCode: room.roomCode });
      }, Math.random() * 3000);
    }
  });
}, 10000); // After 10 seconds

// Print statistics every 5 seconds
const statsInterval = setInterval(() => {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const activeConnections = stats.connected - stats.disconnected;
  console.log(`\n📊 Stats (${elapsed.toFixed(1)}s):`);
  console.log(`   Connected: ${stats.connected}`);
  console.log(`   Disconnected: ${stats.disconnected}`);
  console.log(`   Active: ${activeConnections}`);
  console.log(`   Errors: ${stats.errors}`);
  console.log(`   Rooms created: ${stats.roomsCreated}`);
  console.log(`   Rooms joined: ${stats.roomsJoined}`);
  console.log(`   Messages sent: ${stats.messagesSent}`);
  console.log(`   Messages received: ${stats.messages}`);
  console.log(`   Active rooms: ${rooms.length}\n`);
}, 5000);

// Stop test after duration
setTimeout(() => {
  console.log(`\n🛑 Stopping test...`);
  clearInterval(statsInterval);

  // Disconnect all sockets
  sockets.forEach((socket) => {
    socket.disconnect();
  });

  // Final statistics
  console.log(`\n📈 Final Statistics:`);
  console.log(`   Total connected: ${stats.connected}`);
  console.log(`   Total disconnected: ${stats.disconnected}`);
  console.log(`   Total errors: ${stats.errors}`);
  console.log(`   Rooms created: ${stats.roomsCreated}`);
  console.log(`   Rooms joined: ${stats.roomsJoined}`);
  console.log(`   Messages sent: ${stats.messagesSent}`);
  console.log(`   Messages received: ${stats.messages}`);
  console.log(
    `   Connection success rate: ${(
      (stats.connected / CONCURRENT_CONNECTIONS) *
      100
    ).toFixed(2)}%`
  );
  console.log(
    `   Room creation success rate: ${(
      (stats.roomsCreated / ROOMS_TO_CREATE) *
      100
    ).toFixed(2)}%`
  );

  process.exit(0);
}, TEST_DURATION);

// Handle process termination
process.on("SIGINT", () => {
  console.log(`\n🛑 Interrupted by user...`);
  clearInterval(statsInterval);
  sockets.forEach((socket) => {
    socket.disconnect();
  });
  process.exit(0);
});
