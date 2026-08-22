import { Server, Socket } from 'socket.io';
import RoomService, { DisconnectResultData, JoinRoomResultData } from '../application/RoomService';
import ResponseUtil, { ApiResponse } from '../utils/ResponseUtil';
import GameService from '../application/GameService';
import logger from '../utils/Logger';

export default (io: Server, socket: Socket) => {

    // Binds this socket to an identity. `socket.join(playerId)` is what makes
    // private messages survive reconnects: Socket.IO drops a dead socket from
    // its rooms automatically and the replacement re-joins the same
    // playerId-named room, so `io.to(playerId)` always reaches the live client.
    const bindSocketToRoom = (playerId: string, roomCode: string) => {
        socket.join(roomCode);
        socket.join(playerId);
        socket.data.playerId = playerId;
        socket.data.roomCode = roomCode;
    };

    const sendRoomSnapshot = (roomCode: string, playerId: string, isSpectator: boolean) => {
        const snapshot = GameService.buildRoomSnapshot(roomCode, playerId, isSpectator);
        if (!snapshot) return;
        socket.emit('roomSnapshot', ResponseUtil.success({ data: snapshot }));
    };

    // --- HELPER FUNCTION: Broadcasts the result of someone leaving/disconnecting ---
    const broadcastPlayerRemoval = (result: DisconnectResultData) => {
        if (!result || result.action === 'DELETE_ROOM' || !result.roomCode || !result.room) return;

        const { roomCode, room, action, playerId } = result;

        if (action === 'PLAYER_LEFT') {
            io.to(roomCode).emit('playerLeft', ResponseUtil.success({
                data: {
                    leftPlayerId: playerId,
                    players: room.game.getPlayersList(),
                    newHostId: room.hostId
                },
            }));
        }
        else if (action === 'SPECTATOR_LEFT') {
            io.to(roomCode).emit('spectatorLeft', ResponseUtil.success({
                data: {
                    spectatorId: playerId,
                    spectators: result.spectators ?? []
                },
            }));
        }
        else if (action === 'PLAYER_DISCONNECTED') {
            io.to(roomCode).emit('playerDisconnected', ResponseUtil.success({
                data: {
                    disconnectedPlayerId: playerId,
                    players: room.game.getPlayersList(),
                    newHostId: room.hostId,
                    newLogs: result.newLog ? [result.newLog] : null
                },
            }));

            // Losing a player can complete "all connected-living have acted".
            // It can never end the game -- they're still alive on the board.
            GameService.checkGameProgression(roomCode);
        }
    };

    // ---------------------------------------------------
    // Action: Host a new room
    // ---------------------------------------------------
    socket.on('createRoom', (data: { playerName?: string; mode?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.playerName) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing player name' }));
            return;
        }

        const mode = data.mode || 'simple';
        const result = RoomService.createRoom(socket.id, data.playerName, mode);

        if (result.success && result.data) {
            bindSocketToRoom(result.data.playerId, result.data.roomCode);

            if (callback) {
                callback(ResponseUtil.success({
                    data: {
                        roomCode: result.data.roomCode,
                        gameMode: result.data.gameMode,
                        players: result.data.players,
                        spectators: [],
                        hostId: result.data.hostId,
                        // The only time these leave the server, and only to the
                        // socket that owns them.
                        playerId: result.data.playerId,
                        secret: result.data.secret,
                        isSpectator: false,
                    }
                }));
            }
        } else {
            if (result.error === 'INVALID_PLAYER_NAME') {
                if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_PLAYER_NAME', data: 'Name must be 1-20 characters' }));
            } else {
                if (callback) callback(ResponseUtil.error({
                    code: 500,
                    errorType: result.error || 'UNKNOWN_ERROR',
                    data: 'Failed to create room'
                }));
            }
        }
    });

    // ---------------------------------------------------
    // Action: Enter a room -- as a returning player, a new player, or a spectator
    // ---------------------------------------------------
    socket.on('joinRoom', (data: { roomCode?: string; playerName?: string; playerId?: string; secret?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode || !data.playerName) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or player name' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = RoomService.joinRoom(roomCode, socket.id, data.playerName, data.playerId, data.secret);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND', message: 'Room does not exist' }));
                    break;
                case 'SECRET_MISMATCH':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'SECRET_MISMATCH', data: 'These credentials do not belong to that player' }));
                    break;
                case 'ROOM_IS_FULL':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'ROOM_IS_FULL', data: 'Room has reached max capacity' }));
                    break;
                case 'ROOM_IS_FULL_OF_SPECTATORS':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'ROOM_IS_FULL_OF_SPECTATORS', data: 'Room has reached max spectator capacity' }));
                    break;
                case 'INVALID_PLAYER_NAME':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_PLAYER_NAME', data: 'Name must be 1-20 characters' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR', data: 'Cannot join room' }));
            }
            return;
        }

        const entry: JoinRoomResultData = result.data;

        // Newest wins. RoomService already unbound the old socket, so the
        // `disconnect` this triggers finds nothing and won't undo the takeover.
        if (entry.previousSocketId) {
            io.sockets.sockets.get(entry.previousSocketId)?.disconnect(true);
        }

        bindSocketToRoom(entry.playerId, roomCode);

        if (callback) {
            callback(ResponseUtil.success({
                data: {
                    roomCode: roomCode,
                    gameMode: entry.gameMode,
                    hostId: entry.hostId,
                    players: entry.players,
                    spectators: entry.spectators,
                    playerId: entry.playerId,
                    secret: entry.secret,
                    isSpectator: entry.isSpectator,
                }
            }));
        }

        switch (entry.outcome) {
            case 'NEW_PLAYER':
                socket.to(roomCode).emit('playerJoined', ResponseUtil.success({
                    data: {
                        id: entry.playerId,
                        name: entry.playerName,
                        hostId: entry.hostId,
                        players: entry.players
                    }
                }));
                break;

            case 'NEW_SPECTATOR':
                socket.to(roomCode).emit('spectatorJoined', ResponseUtil.success({
                    data: {
                        spectator: { id: entry.playerId, name: entry.playerName },
                        spectators: entry.spectators
                    }
                }));
                sendRoomSnapshot(roomCode, entry.playerId, true);
                break;

            case 'RECONNECT':
                sendRoomSnapshot(roomCode, entry.playerId, entry.isSpectator);

                if (!entry.isSpectator) {
                    socket.to(roomCode).emit('playerReconnected', ResponseUtil.success({
                        data: {
                            playerId: entry.playerId,
                            players: entry.players
                        }
                    }));
                }

                if (entry.nameChanged) {
                    socket.to(roomCode).emit('playerRenamed', ResponseUtil.success({
                        data: { playerId: entry.playerId, name: entry.playerName }
                    }));
                }

                // Their return can just as easily *undo* an early exit as
                // complete one, so re-evaluate rather than assume.
                GameService.checkGameProgression(roomCode);
                break;
        }
    });

    // ---------------------------------------------------
    // Action: Re-read the room without rejoining it
    // ---------------------------------------------------
    // A client whose socket survived -- a phone backgrounded for a few seconds,
    // a laptop lid closed and reopened -- has no rejoin to hang a snapshot off,
    // but its phase clock has kept draining and its board may have moved on
    // several rounds. This lets it re-read the authoritative view on its own,
    // without the `playerReconnected` broadcast and progression re-check that
    // a full joinRoom would fire at everyone else.
    socket.on('requestSnapshot', (callback?: (res: ApiResponse) => void) => {
        const playerId: string | undefined = socket.data.playerId;
        const roomCode: string | undefined = socket.data.roomCode;

        if (!playerId || !roomCode) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_IS_NOT_IN_A_ROOM', data: 'You are not in a room' }));
            return;
        }

        const room = RoomService.getRoom(roomCode);
        if (!room) {
            if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
            return;
        }

        // Being bound to the room code is not the same as being in the room.
        // Only a seat -- on the board or in the stand -- earns the snapshot,
        // which is private and would otherwise degrade into a full room view
        // with an unexplained missing `you` block.
        const isSpectator = room.game.spectators.some(s => s.id === playerId);
        const isPlayer = room.game.players.some(p => p.id === playerId);

        if (!isPlayer && !isSpectator) {
            if (callback) callback(ResponseUtil.notFound({ errorType: 'PLAYER_NOT_FOUND' }));
            return;
        }

        sendRoomSnapshot(roomCode, playerId, isSpectator);

        if (callback) callback(ResponseUtil.success());
    });

    // ---------------------------------------------------
    // Action: User intentionally clicks "Leave Room"
    // ---------------------------------------------------
    socket.on('leaveRoom', (callback?: (res: ApiResponse) => void) => {
        const result = RoomService.handleDisconnect(socket.id);

        if (!result.success) {
            switch (result.error) {
                case 'PLAYER_IS_NOT_IN_A_ROOM':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_IS_NOT_IN_A_ROOM', data: 'You are not in a room' }));
                    break;
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'PLAYER_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'PLAYER_NOT_FOUND' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
                    break;
            }
            return;
        }

        // Unbind unconditionally, off our own binding rather than off the
        // result. DELETE_ROOM comes back with no room code -- the room is gone
        // -- so hanging the cleanup on that field left the last player out of a
        // room still carrying its binding. That binding is now what every game
        // action is attributed to, and room codes are four random characters
        // that get reused, so a stale one also keeps handing a socket that left
        // the broadcasts of whichever room later takes the code.
        if (socket.data.roomCode) socket.leave(socket.data.roomCode);
        if (socket.data.playerId) socket.leave(socket.data.playerId);
        socket.data.playerId = undefined;
        socket.data.roomCode = undefined;

        if (callback) callback(ResponseUtil.success());

        // A no-op for DELETE_ROOM, which has nobody left to tell.
        if (result.data) broadcastPlayerRemoval(result.data);
    });

    // ---------------------------------------------------
    // Action: User disconnects unexpectedly (Closes app)
    // ---------------------------------------------------
    socket.on('disconnect', () => {
        logger.debug(`Player disconnected: ${socket.id}`);

        const result = RoomService.handleDisconnect(socket.id);

        if (result.success && result.data) {
            broadcastPlayerRemoval(result.data);
        }
    });
};
