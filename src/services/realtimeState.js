
/**
 * In-memory real-time state.
 *
 * WARNING:
 * This state exists only inside this Node.js process.
 * Restarting the server clears everything.
 */

class RealtimeState {
  constructor() {
    // userId -> Set of active socket IDs
    this.userSockets = new Map();

    // socketId -> userId
    this.socketUsers = new Map();

    // roomSlug -> Map(userId -> Set(socketId))
    this.typingUsers = new Map();
  }

  /**
   * Register a connected socket.
   *
   * Supports multiple devices/tabs for one user.
   */
  registerSocket(userId, socketId) {
    let sockets = this.userSockets.get(userId);

    if (!sockets) {
      sockets = new Set();
      this.userSockets.set(userId, sockets);
    }

    const wasOffline = sockets.size === 0;

    sockets.add(socketId);
    this.socketUsers.set(socketId, userId);

    return {
      isNewOnlineUser: wasOffline,
      onlineUsers: this.userSockets.size
    };
  }

  /**
   * Remove a disconnected socket.
   */
  unregisterSocket(socketId) {
    const userId = this.socketUsers.get(socketId);

    if (!userId) {
      return null;
    }

    this.socketUsers.delete(socketId);

    const sockets = this.userSockets.get(userId);

    if (sockets) {
      sockets.delete(socketId);
    }

    const isOfflineUser =
      !sockets || sockets.size === 0;

    if (isOfflineUser) {
      this.userSockets.delete(userId);
    }

    // Remove this socket from all typing states.
    const stoppedTyping = [];

    for (const [roomSlug, users] of this.typingUsers) {
      const typingSockets = users.get(userId);

      if (!typingSockets) {
        continue;
      }

      typingSockets.delete(socketId);

      if (typingSockets.size === 0) {
        users.delete(userId);

        stoppedTyping.push({
          roomSlug,
          userId
        });
      }

      if (users.size === 0) {
        this.typingUsers.delete(roomSlug);
      }
    }

    return {
      userId,
      isOfflineUser,
      onlineUsers: this.userSockets.size,
      stoppedTyping
    };
  }

  /**
   * Check whether a user is online.
   */
  isUserOnline(userId) {
    return this.userSockets.has(userId);
  }

  /**
   * Number of unique online users.
   */
  getOnlineUserCount() {
    return this.userSockets.size;
  }

  /**
   * Socket IDs for a user.
   */
  getUserSockets(userId) {
    return [
      ...(this.userSockets.get(userId) ?? [])
    ];
  }

  /**
   * Start or stop typing.
   *
   * Multiple tabs are aggregated into one typing status.
   */
  setTyping(roomSlug, userId, socketId, isTyping) {
    let users = this.typingUsers.get(roomSlug);

    if (!users) {
      users = new Map();
      this.typingUsers.set(roomSlug, users);
    }

    let sockets = users.get(userId);

    if (!sockets) {
      sockets = new Set();
      users.set(userId, sockets);
    }

    const wasTyping = sockets.size > 0;

    if (isTyping) {
      sockets.add(socketId);
    } else {
      sockets.delete(socketId);
    }

    const nowTyping = sockets.size > 0;

    if (!nowTyping) {
      users.delete(userId);
    }

    if (users.size === 0) {
      this.typingUsers.delete(roomSlug);
    }

    // Notify only when the user's aggregate state changes.
    return {
      changed: wasTyping !== nowTyping,
      isTyping: nowTyping
    };
  }

  /**
   * Current typing users in a room.
   */
  getTypingUsers(roomSlug) {
    const users = this.typingUsers.get(roomSlug);

    if (!users) {
      return [];
    }

    return [...users.keys()];
  }
}

// One shared instance for this Node.js process.
export const realtimeState = new RealtimeState();
