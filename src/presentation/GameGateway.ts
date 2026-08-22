import { Server, Socket } from 'socket.io';
import RoomService from '../application/RoomService';
import GameService, { PHASE_TIME_LIMIT_SECONDS } from '../application/GameService';
import ResponseUtil, { ApiResponse } from '../utils/ResponseUtil';


export default (io: Server, socket: Socket) => {

    // Every game action is attributed to the stable playerId bound at join
    // time, never to socket.id -- the socket id rotates on every reconnect.
    const currentPlayerId = (): string | undefined => socket.data.playerId;

    // ---------------------------------------------------
    // Action: Host starts the game
    // ---------------------------------------------------
    socket.on('startGame', (data: { roomCode?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const room = RoomService.getRoom(roomCode);

        if (!room) {
            if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
            return;
        }

        if (!currentPlayerId() || room.hostId !== currentPlayerId()) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PERMISSION_DENIED', data: 'Only a host can start game' }));
            return;
        }

        if (room.game.players.length < 2) {
            if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'NOT_ENOUGH_PLAYERS', data: 'Need at least 2 players to start the game' }));
            return;
        }

        GameService.startPositionPhase(roomCode);

        if (callback) callback(ResponseUtil.success());

        io.to(roomCode).emit('gameStarted', ResponseUtil.success({
            data: {
                boardSize: { width: room.game.board.width, height: room.game.board.height },
                state: room.game.state,
                destroyedTiles: room.game.destroyedTiles,
                timeLimit: PHASE_TIME_LIMIT_SECONDS
            }
        }));
    });

    // ---------------------------------------------------
    // Action: Player hides on a tile
    // ---------------------------------------------------
    socket.on('setPosition', (data: { roomCode?: string; x?: number; y?: number }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode || data.x === undefined || data.y === undefined) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or x, y position' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = GameService.handleSetPosition(roomCode, playerId, data.x, data.y);

        if (!result.success) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Not in positioning phase' }));
                    break;
                case 'POSITION_ALREADY_SET':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'POSITION_ALREADY_SET' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success());

        if (result.data?.event === 'PLAYER_READY') {
            socket.to(roomCode).emit('playerReady', ResponseUtil.success({ data: { playerId } }));
        }
    });

    socket.on('throwBomb', (data: { roomCode?: string; x?: number; y?: number }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode || data.x === undefined || data.y === undefined) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or x, y position' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();

        const result = GameService.handleThrowBomb(roomCode, playerId, data.x, data.y);

        if (!result.success) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Not in attack phase' }));
                    break;
                case 'DEAD_PLAYER':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'DEAD_PLAYER', data: 'Eliminated players cannot bomb' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                case 'BOMB_ALREADY_THROWN':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'BOMB_ALREADY_THROWN', data: 'You have already locked in your bomb for this round' }));
                    break;
                case 'TILE_ALREADY_DESTROYED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_ALREADY_DESTROYED', data: 'Cannot bomb a destroyed tile' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success({ data: { throwOrder: result.data?.throwOrder } }));

        if (result.data?.event === 'PLAYER_READY') {
            socket.to(roomCode).emit('playerReady', ResponseUtil.success({ data: { playerId, throwOrder: result.data?.throwOrder } }));
        }
    });

    // ---------------------------------------------------
    // Action: Host resets the game back to lobby
    // ---------------------------------------------------
    socket.on('resetGame', (data: { roomCode?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();

        const room = RoomService.getRoom(roomCode);
        if (!room) {
            if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
            return;
        }

        if (!currentPlayerId() || room.hostId !== currentPlayerId()) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PERMISSION_DENIED', data: 'Only the host can reset the game' }));
            return;
        }

        const result = GameService.handleResetGame(roomCode);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.error({ code: 404, errorType: result.error }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: result.error }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
                    break;
            }

            return;
        }

        if (callback) callback(ResponseUtil.success());

        io.to(roomCode).emit('gameReset', ResponseUtil.success({
            data: {
                // Fresh, fully alive roster: still-disconnected players pruned,
                // last game's spectators promoted in.
                players: result.data.players,
                spectators: result.data.spectators,
                newHostId: result.data.hostId
            }
        }));
    });
};
