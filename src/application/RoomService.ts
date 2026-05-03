import PlayerEntity from '../domain/models/PlayerEntity';
import SimpleModeEngine, { ActionLog, PlayerModel } from '../domain/modes/SimpleModeEngine';
import { GameMode, Room, activeRooms, socketTracker } from './RoomStore';

export type JoinRoomErrorType = 'ROOM_NOT_FOUND' | 'GAME_ALREADY_STARTED' | 'ROOM_IS_FULL';
export type CreateRoomErrorType = 'SERVER_CAPACITY_REACHED' | 'INVALID_MODE';
export type DisconnectErrorType = 'PLAYER_IS_NOT_IN_A_ROOM' | 'ROOM_NOT_FOUND' | 'PLAYER_NOT_FOUND';
export type UnknownErrorType = 'UNKNOWN_ERROR';

export interface RoomResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError | UnknownErrorType;
}

export interface CreateRoomResultData {
    roomCode?: string;
    players?: PlayerModel[];
    gameMode?: GameMode;
    hostId?: string;
}

export interface JoinRoomResultData {
    roomCode?: string;
    players?: PlayerModel[];
    gameMode?: GameMode;
    hostId?: string;
}

export interface DisconnectResultData {
    action: 'DELETE_ROOM' | 'PLAYER_LEFT' | 'REMOVE_PLAYER_MIDGAME';
    roomCode?: string;
    room?: Room;
    newLog?: ActionLog;
    playerId?: string;
}

class RoomService {

    static createRoom(hostId: string, playerName: string, gameMode: string = 'simple'): RoomResult<CreateRoomResultData, CreateRoomErrorType> {
        try {
            if (gameMode != 'simple') {
                return { success: false, error: 'INVALID_MODE' };
            }

            let roomCode = '';
            do {
                roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            } while (activeRooms[roomCode] !== undefined);

            const gameInstance = new SimpleModeEngine();

            const hostPlayer = new PlayerEntity(hostId, playerName);
            gameInstance.addPlayer(hostPlayer);

            activeRooms[roomCode] = {
                code: roomCode,
                hostId: hostId,
                game: gameInstance,
                gameMode: gameMode,
                state: 'lobby',
                phaseTimer: null,
                processTimer: null
            };

            socketTracker[hostId] = roomCode;

            return { success: true, data: { roomCode, players: gameInstance.getPlayersList(), gameMode, hostId } };
        } catch (error) {
            if (error instanceof Error) {
                console.error(`createRoom error: ${error.message}`);
            } else {
                console.error('An unknown entity was thrown from createRoom:', error);
            }

            return { success: false, error: 'UNKNOWN_ERROR' };
        }
    }

    static joinRoom(roomCode: string, playerId: string, playerName: string): RoomResult<JoinRoomResultData, JoinRoomErrorType> {
        try {
            const room = activeRooms[roomCode];
            if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };
            if (room.state !== 'lobby') return { success: false, error: 'GAME_ALREADY_STARTED' };

            const newPlayer = new PlayerEntity(playerId, playerName);
            if (!room.game.addPlayer(newPlayer)) return { success: false, error: 'ROOM_IS_FULL' };

            socketTracker[playerId] = roomCode;

            return { success: true, data: { roomCode, players: room.game.getPlayersList(), gameMode: room.gameMode, hostId: room.hostId } };
        } catch (error) {
            if (error instanceof Error) {
                console.error(`joinRoom error: ${error.message}`);
            } else {
                console.error('An unknown entity was thrown from joinRoom:', error);
            }
            return { success: false, error: 'UNKNOWN_ERROR' };
        }
    }

    static handleDisconnect(socketId: string): RoomResult<DisconnectResultData, DisconnectErrorType> {
        const roomCode = socketTracker[socketId];
        if (!roomCode) return { success: false, error: 'PLAYER_IS_NOT_IN_A_ROOM' };

        const room = activeRooms[roomCode];
        if (!room) {
            delete socketTracker[socketId];
            return { success: false, error: 'ROOM_NOT_FOUND' };
        }

        delete socketTracker[socketId];

        const playerIndex = room.game.players.findIndex(p => p.id === socketId);
        if (playerIndex === -1) return { success: false, error: 'PLAYER_NOT_FOUND' };

        let resultAction: DisconnectResultData['action'];

        if (room.state === 'lobby') {
            room.game.players.splice(playerIndex, 1);

            if (room.game.players.length === 0) {
                if (room.phaseTimer) clearTimeout(room.phaseTimer);
                if (room.processTimer) clearTimeout(room.processTimer);
                delete activeRooms[roomCode];
                return { success: true, data: { action: 'DELETE_ROOM' } };
            }

            if (room.hostId === socketId) {
                room.hostId = room.game.players[0].id;
            }
            resultAction = 'PLAYER_LEFT';

        } else {
            const player = room.game.players[playerIndex];
            player.eliminate(++room.game.deathCounter, true);

            if (room.hostId === socketId) {
                // Find the first player who is NOT disconnected
                const newHost = room.game.players.find(p => !p.isDisconnected && p.id !== socketId);
                if (newHost) {
                    room.hostId = newHost.id;
                }
            }

            resultAction = 'REMOVE_PLAYER_MIDGAME';

            const disconnectLog = room.game.addLog('PLAYER_DISCONNECTED', { playerName: player.name });

            return { success: true, data: { action: resultAction, roomCode, room, newLog: disconnectLog, playerId: socketId } };
        }

        return { success: true, data: { action: resultAction, roomCode, room, playerId: socketId } };
    }

    // Returns either a Room object, or 'undefined' if it doesn't exist
    static getRoom(roomCode: string): Room | undefined {
        return activeRooms[roomCode];
    }
}

export default RoomService;