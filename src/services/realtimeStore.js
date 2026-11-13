
import { getRedisClient } from '../config/redis.js';

const PREFIX = 'devchat:';
const key = (...parts) => PREFIX + parts.join(':');

const REGISTER_SOCKET = `
  local added = redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2])
  local count = redis.call('SCARD', KEYS[1])
  local first = 0
  if added == 1 and count == 1 then
    redis.call('SADD', KEYS[3], ARGV[2])
    first = 1
  end
  return { first, redis.call('SCARD', KEYS[3]) }
`;


const JOIN_ROOM = `
  local added = redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('SADD', KEYS[2], ARGV[2])

  local socketCount = redis.call('SCARD', KEYS[1])

  if added == 1 and socketCount == 1 then
    return 1
  end

  return 0
`;


const LEAVE_ROOM = `
  local removed = redis.call('SREM', KEYS[1], ARGV[1])
  redis.call('SREM', KEYS[2], ARGV[2])
  local remaining = redis.call('SCARD', KEYS[1])
  if remaining == 0 then redis.call('DEL', KEYS[1]) end
  if removed == 1 and remaining == 0 then return 1 end
  return 0
`;

const SET_TYPING = `
  local before = redis.call('SCARD', KEYS[1])
  if ARGV[3] == '1' then
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('SADD', KEYS[2], ARGV[2])
  else
    redis.call('SREM', KEYS[1], ARGV[1])
    redis.call('SREM', KEYS[2], ARGV[2])
  end
  local after = redis.call('SCARD', KEYS[1])
  if after == 0 then
    redis.call('DEL', KEYS[1])
    redis.call('SREM', KEYS[3], ARGV[4])
  else
    redis.call('SADD', KEYS[3], ARGV[4])
  end
  if before == 0 and after > 0 then return {1, 1} end
  if before > 0 and after == 0 then return {1, 0} end
  return {0, after > 0 and 1 or 0}
`;

const UNREGISTER_SOCKET = `
  local userId = redis.call('GET', KEYS[1])
  if not userId then return nil end
  redis.call('DEL', KEYS[1])
  local userSocketsKey = ARGV[2] .. 'presence:user:' .. userId .. ':sockets'
  redis.call('SREM', userSocketsKey, ARGV[1])
  local userSockets = redis.call('SCARD', userSocketsKey)
  local offline = 0
  if userSockets == 0 then
    redis.call('DEL', userSocketsKey)
    redis.call('SREM', KEYS[2], userId)
    offline = 1
  end
  local onlineCount = redis.call('SCARD', KEYS[2])
  local rooms = redis.call('SMEMBERS', KEYS[3])
  local leftRooms = {}
  for _, room in ipairs(rooms) do
    local roomUserKey = ARGV[2] .. 'room:' .. room .. ':user:' .. userId .. ':sockets'
    redis.call('SREM', roomUserKey, ARGV[1])
    local remaining = redis.call('SCARD', roomUserKey)
    if remaining == 0 then
      redis.call('DEL', roomUserKey)
      table.insert(leftRooms, room)
    end
  end
  redis.call('DEL', KEYS[3])
  local typingIndexes = redis.call('SMEMBERS', KEYS[4])
  local stoppedTyping = {}
  for _, item in ipairs(typingIndexes) do
    local separator = string.find(item, '|', 1, true)
    if separator then
      local room = string.sub(item, 1, separator - 1)
      local typingKey = ARGV[2] .. 'typing:' .. room .. ':user:' .. userId .. ':sockets'
      redis.call('SREM', typingKey, ARGV[1])
      local remaining = redis.call('SCARD', typingKey)
      if remaining == 0 then
        redis.call('DEL', typingKey)
        redis.call('SREM', ARGV[2] .. 'typing:' .. room .. ':users', userId)
        table.insert(stoppedTyping, room)
      end
    end
  end
  redis.call('DEL', KEYS[4])
  return { userId, offline, onlineCount, table.concat(leftRooms, ','), table.concat(stoppedTyping, ',') }
`;

export function createRealtimeStore(getClient = getRedisClient) {
  return Object.freeze({
  async registerSocket(userId, socketId) {
    const result = await getClient().eval(REGISTER_SOCKET, {
      keys: [key('presence', 'user', userId, 'sockets'), key('socket', socketId, 'user'), key('presence', 'online-users')],
      arguments: [socketId, userId],
    });
    return { isNewOnlineUser: Number(result[0]) === 1, onlineUsers: Number(result[1]) };
  },

  async joinRoom(roomSlug, userId, socketId) {
    const added = await getClient().eval(JOIN_ROOM, {
      keys: [key('room', roomSlug, 'user', userId, 'sockets'), key('socket', socketId, 'rooms')],
      arguments: [socketId, roomSlug],
    });
    return { isFirstSocket: Number(added) === 1 };
  },

  async leaveRoom(roomSlug, userId, socketId) {
    const last = await getClient().eval(LEAVE_ROOM, {
      keys: [key('room', roomSlug, 'user', userId, 'sockets'), key('socket', socketId, 'rooms')],
      arguments: [socketId, roomSlug],
    });
    return { isLastSocket: Number(last) === 1 };
  },

  async setTyping(roomSlug, userId, socketId, isTyping) {
    const composite = `${roomSlug}|${userId}`;
    const result = await getClient().eval(SET_TYPING, {
      keys: [key('typing', roomSlug, 'user', userId, 'sockets'), key('socket', socketId, 'typing'), key('typing', roomSlug, 'users')],
      arguments: [socketId, composite, isTyping ? '1' : '0', userId],
    });
    return { changed: Number(result[0]) === 1, isTyping: Number(result[1]) === 1 };
  },

  async getTypingUsers(roomSlug) {
    return getClient().sMembers(key('typing', roomSlug, 'users'));
  },

  async isUserOnline(userId) {
    return Boolean(await getClient().sIsMember(key('presence', 'online-users'), userId));
  },

  async getOnlineUserCount() {
    return getClient().sCard(key('presence', 'online-users'));
  },

  async unregisterSocket(socketId) {
    const result = await getClient().eval(UNREGISTER_SOCKET, {
      keys: [key('socket', socketId, 'user'), key('presence', 'online-users'), key('socket', socketId, 'rooms'), key('socket', socketId, 'typing')],
      arguments: [socketId, PREFIX],
    });
    if (!result) return null;

    return {
      userId: result[0],
      isOfflineUser: Number(result[1]) === 1,
      onlineUsers: Number(result[2]),
      leftRooms: result[3] ? String(result[3]).split(',') : [],
      stoppedTyping: result[4] ? String(result[4]).split(',').map((roomSlug) => ({ roomSlug, userId: result[0] })) : [],
    };
  },
  });
}

export const realtimeStore = createRealtimeStore();
