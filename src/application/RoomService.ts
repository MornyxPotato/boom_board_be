import PlayerEntity from '../domain/models/PlayerEntity';
import SpectatorEntity from '../domain/models/SpectatorEntity';
import SimpleModeEngine, { ActionLog, PlayerDisconnectedData, PlayerModel, SpectatorModel } from '../domain/modes/SimpleModeEngine';
import { generatePlayerId, generateSecret } from '../utils/Identity';
import { GameMode, Room, activeRooms, playerSocketTracker, socketTracker } from './RoomStore';

export type JoinRoomErrorType = 'ROOM_NOT_FOUND' | 'ROOM_IS_FULL' | 'ROOM_IS_FULL_OF_SPECTATORS' | 'INVALID_PLAYER_NAME' | 'SECRET_MISMATCH';
export type CreateRoomErrorType = 'SERVER_CAPACITY_REACHED' | 'INVALID_MODE' | 'INVALID_PLAYER_NAME';
export type DisconnectErrorType = 'PLAYER_IS_NOT_IN_A_ROOM' | 'ROOM_NOT_FOUND' | 'PLAYER_NOT_FOUND';
export type UnknownErrorType = 'UNKNOWN_ERROR';

export interface RoomResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError | UnknownErrorType;
}

export interface CreateRoomResultData {
    roomCode: string;
    players: PlayerModel[];
    gameMode: GameMode;
    hostId: string;
    playerId: string;
    secret: string;
}

// One `joinRoom` covers three very different entries. The gateway branches on
// `outcome` to decide what to broadcast and whether to send a snapshot.
export type JoinOutcome = 'RECONNECT' | 'NEW_PLAYER' | 'NEW_SPECTATOR';

export interface JoinRoomResultData {
    outcome: JoinOutcome;
    roomCode: string;
    players: PlayerModel[];
    spectators: SpectatorModel[];
    gameMode: GameMode;
    hostId: string;
    playerId: string;
    playerName: string;
    secret: string;
    isSpectator: boolean;
    // Set on RECONNECT when the returning client typed a different display
    // name, so the gateway knows to broadcast `playerRenamed`.
    nameChanged: boolean;
    // Set when this identity still had a live socket bound. Newest wins: the
    // gateway force-disconnects it.
    previousSocketId?: string;
}

export interface DisconnectResultData {
    action: 'DELETE_ROOM' | 'PLAYER_LEFT' | 'PLAYER_DISCONNECTED' | 'SPECTATOR_LEFT';
    roomCode?: string;
    room?: Room;
    newLog?: ActionLog;
    playerId?: string;
    spectators?: SpectatorModel[];
}

const textSegmenter = new Intl.Segmenter('th-TH', { granularity: 'grapheme' });

// Helper function to get true visual length
const getVisualLength = (text: string): number => {
    return [...textSegmenter.segment(text)].length;
};

const isValidName = (playerName: string): boolean => {
    const trimmedName = playerName ? playerName.trim() : '';
    return trimmedName.length > 0 && getVisualLength(trimmedName) <= 20;
};

class RoomService {

    // Points a socket at an identity, replacing whatever it was bound to. The
    // previous socket's binding is dropped here (not on its `disconnect`) so
    // that the eviction we are about to trigger can't race back in and mark the
    // player disconnected after the new socket has already taken over.
    private static bindSocket(socketId: string, playerId: string, roomCode: string): string | undefined {
        const previousSocketId = playerSocketTracker[playerId];
        if (previousSocketId && previousSocketId !== socketId) {
            delete socketTracker[previousSocketId];
        }

        socketTracker[socketId] = { roomCode, playerId };
        playerSocketTracker[playerId] = socketId;

        return previousSocketId && previousSocketId !== socketId ? previousSocketId : undefined;
    }

    static createRoom(socketId: string, playerName: string, gameMode: string = 'simple'): RoomResult<CreateRoomResultData, CreateRoomErrorType> {
        try {
            if (!isValidName(playerName)) {
                return { success: false, error: 'INVALID_PLAYER_NAME' };
            }

            if (gameMode != 'simple') {
                return { success: false, error: 'INVALID_MODE' };
            }

            let roomCode = '';
            do {
                roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            } while (activeRooms[roomCode] !== undefined);

            const gameInstance = new SimpleModeEngine();

            const playerId = generatePlayerId();
            const secret = generateSecret();

            const hostPlayer = new PlayerEntity(playerId, playerName, secret);
            gameInstance.addPlayer(hostPlayer);

            activeRooms[roomCode] = {
                code: roomCode,
                hostId: playerId,
                game: gameInstance,
                gameMode: gameMode,
                phaseTimer: null,
                processTimer: null,
                phaseEndsAt: null
            };

            this.bindSocket(socketId, playerId, roomCode);

            return {
                success: true,
                data: {
                    roomCode,
                    players: gameInstance.getPlayersList(),
                    gameMode,
                    hostId: playerId,
                    playerId,
                    secret
                }
            };
        } catch (error) {
            if (error instanceof Error) {
                console.error(`createRoom error: ${error.message}`);
            } else {
                console.error('An unknown entity was thrown from createRoom:', error);
            }

            return { success: false, error: 'UNKNOWN_ERROR' };
        }
    }

    // A single entry point with three outcomes (see the plan's §3):
    //   creds match a member here -> RECONNECT
    //   no creds / creds unknown here, room in lobby -> NEW_PLAYER
    //   no creds / creds unknown here, game running -> NEW_SPECTATOR
    // A client-supplied `playerId` is never trusted on its own; without the
    // matching secret it is either rejected (if it names a member) or ignored.
    static joinRoom(
        roomCode: string,
        socketId: string,
        playerName: string,
        playerId?: string,
        secret?: string
    ): RoomResult<JoinRoomResultData, JoinRoomErrorType> {
        try {
            if (!isValidName(playerName)) {
                return { success: false, error: 'INVALID_PLAYER_NAME' };
            }

            const room = activeRooms[roomCode];
            if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

            const trimmedName = playerName.trim();

            if (playerId) {
                const existingPlayer = room.game.players.find(p => p.id === playerId);
                const existingSpectator = room.game.spectators.find(s => s.id === playerId);
                const member = existingPlayer ?? existingSpectator;

                if (member) {
                    // Player ids are broadcast to the whole room, so the id alone
                    // proves nothing -- only the secret does.
                    if (!secret || member.secret !== secret) {
                        return { success: false, error: 'SECRET_MISMATCH' };
                    }

                    const nameChanged = member.name !== trimmedName;
                    if (nameChanged) member.setName(trimmedName);

                    // Life status is untouched: a dead player comes back dead
                    // (and spectates in place), an alive one comes back alive.
                    if (existingPlayer) existingPlayer.setDisconnected(false);

                    const previousSocketId = this.bindSocket(socketId, playerId, roomCode);

                    return {
                        success: true,
                        data: {
                            outcome: 'RECONNECT',
                            roomCode,
                            players: room.game.getPlayersList(),
                            spectators: room.game.getSpectatorsList(),
                            gameMode: room.gameMode,
                            hostId: room.hostId,
                            playerId,
                            playerName: trimmedName,
                            secret: member.secret,
                            isSpectator: !existingPlayer,
                            nameChanged,
                            previousSocketId
                        }
                    };
                }
            }

            // Anything we can't validate becomes a brand-new identity.
            const newPlayerId = generatePlayerId();
            const newSecret = generateSecret();
            const joinsAsSpectator = room.game.state !== 'lobby';

            if (joinsAsSpectator) {
                if (!room.game.addSpectator(new SpectatorEntity(newPlayerId, trimmedName, newSecret))) {
                    return { success: false, error: 'ROOM_IS_FULL_OF_SPECTATORS' };
                }
            } else {
                if (!room.game.addPlayer(new PlayerEntity(newPlayerId, trimmedName, newSecret))) {
                    return { success: false, error: 'ROOM_IS_FULL' };
                }
            }

            this.bindSocket(socketId, newPlayerId, roomCode);

            return {
                success: true,
                data: {
                    outcome: joinsAsSpectator ? 'NEW_SPECTATOR' : 'NEW_PLAYER',
                    roomCode,
                    players: room.game.getPlayersList(),
                    spectators: room.game.getSpectatorsList(),
                    gameMode: room.gameMode,
                    hostId: room.hostId,
                    playerId: newPlayerId,
                    playerName: trimmedName,
                    secret: newSecret,
                    isSpectator: joinsAsSpectator,
                    nameChanged: false
                }
            };
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
        const binding = socketTracker[socketId];
        if (!binding) return { success: false, error: 'PLAYER_IS_NOT_IN_A_ROOM' };

        const { roomCode, playerId } = binding;

        delete socketTracker[socketId];
        // Only clear the reverse lookup if this socket is still the current one.
        // A socket evicted by a newer one for the same identity must not unbind
        // its replacement.
        if (playerSocketTracker[playerId] === socketId) delete playerSocketTracker[playerId];

        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        // A spectator has no board state worth preserving -- drop them. If they
        // come back they simply re-enter as a fresh spectator.
        if (room.game.removeSpectator(playerId)) {
            return {
                success: true,
                data: {
                    action: 'SPECTATOR_LEFT',
                    roomCode,
                    room,
                    playerId,
                    spectators: room.game.getSpectatorsList()
                }
            };
        }

        const playerIndex = room.game.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return { success: false, error: 'PLAYER_NOT_FOUND' };

        if (room.game.state === 'lobby') {
            room.game.players.splice(playerIndex, 1);

            if (room.game.players.length === 0) {
                if (room.phaseTimer) clearTimeout(room.phaseTimer);
                if (room.processTimer) clearTimeout(room.processTimer);
                delete activeRooms[roomCode];
                return { success: true, data: { action: 'DELETE_ROOM' } };
            }

            if (room.hostId === playerId) {
                room.hostId = room.game.players[0].id;
            }

            return { success: true, data: { action: 'PLAYER_LEFT', roomCode, room, playerId } };
        }

        // Mid-game: the player stays alive and on the board, just offline. The
        // server keeps auto-positioning them and they simply don't throw.
        const player = room.game.players[playerIndex];
        player.setDisconnected(true);

        if (room.hostId === playerId) {
            // Find the first player who is NOT disconnected
            const newHost = room.game.players.find(p => !p.isDisconnected && p.id !== playerId);
            if (newHost) {
                room.hostId = newHost.id;
            }
        }

        const disconnectLog = room.game.addLog('PLAYER_DISCONNECTED', { playerName: player.name, playerId: player.id } as PlayerDisconnectedData);

        return { success: true, data: { action: 'PLAYER_DISCONNECTED', roomCode, room, newLog: disconnectLog, playerId } };
    }

    // Returns either a Room object, or 'undefined' if it doesn't exist
    static getRoom(roomCode: string): Room | undefined {
        return activeRooms[roomCode];
    }
}

export default RoomService;
