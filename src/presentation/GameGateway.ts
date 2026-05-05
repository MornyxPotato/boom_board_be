import { Server, Socket } from 'socket.io';
import RoomService from '../application/RoomService';
import GameService from '../application/GameService';
import ResponseUtil, { ApiResponse } from '../utils/ResponseUtil';


export default (io: Server, socket: Socket) => {

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

        if (room.hostId !== socket.id) {
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
                timeLimit: 30
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

        const roomCode = data.roomCode.toUpperCase();
        const result = GameService.handleSetPosition(roomCode, socket.id, data.x, data.y);

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
            socket.to(roomCode).emit('playerReady', ResponseUtil.success({ data: { playerId: socket.id } }));
        }
    });

    socket.on('throwBomb', (data: { roomCode?: string; x?: number; y?: number }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode || data.x === undefined || data.y === undefined) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or x, y position' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();

        const result = GameService.handleThrowBomb(roomCode, socket.id, data.x, data.y);

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
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success({ data: { throwOrder: result.data?.throwOrder } }));

        if (result.data?.event === 'PLAYER_READY') {
            socket.to(roomCode).emit('playerReady', ResponseUtil.success({ data: { playerId: socket.id, throwOrder: result.data?.throwOrder } }));
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

        if (room.hostId !== socket.id) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PERMISSION_DENIED', data: 'Only the host can reset the game' }));
            return;
        }

        const result = GameService.handleResetGame(roomCode);

        if (!result.success) {
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
                players: room.game.getPlayersList() // Send the fresh, fully alive player list
            }
        }));
    });
};