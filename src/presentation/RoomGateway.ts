import { Server, Socket } from 'socket.io';
import RoomService, { DisconnectResultData } from '../application/RoomService';
import ResponseUtil, { ApiResponse } from '../utils/ResponseUtil';
import GameService from '../application/GameService';
import logger from '../utils/Logger';

export default (io: Server, socket: Socket) => {

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
        else if (action === 'REMOVE_PLAYER_MIDGAME') {
            io.to(roomCode).emit('playerDropped', ResponseUtil.success({
                data: {
                    droppedPlayerId: playerId,
                    players: room.game.getPlayersList(),
                    newHostId: room.hostId,
                    newLogs: result.newLog ? [result.newLog] : null
                },
            }));

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

        if (result.success && result.data && result.data.roomCode && result.data.players) {
            socket.join(result.data.roomCode);

            if (callback) {
                callback(ResponseUtil.success({
                    data: {
                        roomCode: result.data.roomCode,
                        gameMode: result.data.gameMode,
                        players: result.data.players,
                        hostId: result.data.hostId,
                    }
                }));
            }
        } else {
            if (callback) callback(ResponseUtil.error({
                code: 500,
                errorType: result.error || 'UNKNOWN_ERROR',
                data: 'Failed to create room'
            }));
        }
    });

    // ---------------------------------------------------
    // Action: Join an existing room
    // ---------------------------------------------------
    socket.on('joinRoom', (data: { roomCode?: string; playerName?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode || !data.playerName) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or player name' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = RoomService.joinRoom(roomCode, socket.id, data.playerName);

        if (result.success && result.data && result.data.players) {
            socket.join(roomCode);

            if (callback) {
                callback(ResponseUtil.success({
                    data: {
                        roomCode: roomCode,
                        gameMode: result.data.gameMode,
                        hostId: result.data.hostId,
                        players: result.data.players
                    }
                }));
            }

            socket.to(roomCode).emit('playerJoined', ResponseUtil.success({
                data: {
                    id: socket.id,
                    name: data.playerName,
                    hostId: result.data.hostId,
                    players: result.data.players
                }
            }));

        } else {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND', message: 'Room does not exist' }));
                    break;
                case 'GAME_ALREADY_STARTED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'GAME_ALREADY_STARTED', data: 'Game is already in progress' }));
                    break;
                case 'ROOM_IS_FULL':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'ROOM_IS_FULL', data: 'Room has reached max capacity' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR', data: 'Cannot join room' }));
            }
        }
    });

    // ---------------------------------------------------
    // Action: User intentionally clicks "Leave Room"
    // ---------------------------------------------------
    socket.on('leaveRoom', (callback?: (res: ApiResponse) => void) => {
        const result = RoomService.handleDisconnect(socket.id);

        if (!result.success) {
            switch (result.error) {
                case 'PLAYER_IS_NOT_IN_A_ROOM':
                    if (callback) callback(ResponseUtil.badRequest({ message: 'PLAYER_IS_NOT_IN_A_ROOM' }));
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

        if (result.data && result.data.roomCode) {
            socket.leave(result.data.roomCode);

            if (callback) callback(ResponseUtil.success());

            broadcastPlayerRemoval(result.data);
        }
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