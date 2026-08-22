import PlayerEntity from '../domain/models/PlayerEntity';
import SpectatorEntity from '../domain/models/SpectatorEntity';
import SimpleModeEngine, { ActionLog, PlayerDisconnectedData, PlayerLeftData, PlayerModel, PlayerReconnectedData, SpectatorModel } from '../domain/modes/SimpleModeEngine';
import { generatePlayerId, generateSecret } from '../utils/Identity';
import { GameMode, Room, SocketBinding, activeRooms, playerSocketTracker, socketTracker } from './RoomStore';

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
    // Set when this socket was seated somewhere else and that seat was given up
    // to come here. The gateway broadcasts it to the room that lost the player.
    releasedSeat?: DisconnectResultData;
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
    // Set when this socket was seated somewhere else and that seat was given up
    // to come here. Never set on a RECONNECT -- reclaiming the seat you already
    // hold is not a move.
    releasedSeat?: DisconnectResultData;
    // Set on RECONNECT when the seat was actually being held for an offline
    // player, so the room's log can close the disconnect it opened. A client
    // that never went offline (a second tab, a rejoin over a live socket) has
    // nothing to announce.
    newLog?: ActionLog;
}

// Why a seat was given up. The two are not interchangeable: a DROP is a client
// that may well come back, so the seat is held; a LEAVE is a player who said
// they are done, so the seat is taken off the board.
export type SeatReleaseIntent = 'LEAVE' | 'DROP';

export interface DisconnectResultData {
    action: 'DELETE_ROOM' | 'PLAYER_LEFT' | 'PLAYER_DISCONNECTED' | 'SPECTATOR_LEFT';
    roomCode?: string;
    room?: Room;
    newLog?: ActionLog;
    playerId?: string;
    spectators?: SpectatorModel[];
    // PLAYER_LEFT only: true when the roster shrank while a game was running,
    // so the caller knows the alive count really moved and the round may now be
    // over (or won). A lobby departure changes nothing that needs re-checking.
    wasMidGame?: boolean;
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

        // The seat this socket held a moment ago, if it is not the one being
        // bound now. Callers are expected to have released it already -- this is
        // only here so the reverse lookup can't be left pointing at a socket
        // that has moved on, which would leave the abandoned identity looking
        // permanently connected and its room waiting on a player who is gone.
        const staleBinding = socketTracker[socketId];
        if (staleBinding && staleBinding.playerId !== playerId && playerSocketTracker[staleBinding.playerId] === socketId) {
            delete playerSocketTracker[staleBinding.playerId];
        }

        socketTracker[socketId] = { roomCode, playerId };
        playerSocketTracker[playerId] = socketId;

        return previousSocketId && previousSocketId !== socketId ? previousSocketId : undefined;
    }

    // Drops a socket's binding in both directions and hands back what it was.
    private static unbindSocket(socketId: string): SocketBinding | undefined {
        const binding = socketTracker[socketId];
        if (!binding) return undefined;

        delete socketTracker[socketId];
        // Only clear the reverse lookup if this socket is still the current one.
        // A socket evicted by a newer one for the same identity must not unbind
        // its replacement.
        if (playerSocketTracker[binding.playerId] === socketId) delete playerSocketTracker[binding.playerId];

        return binding;
    }

    // Frees a room and everything still scheduled against it. Every path that
    // removes the last player has to go through here: a room left in
    // `activeRooms` keeps firing phase timers at nobody, forever.
    static deleteRoom(roomCode: string): void {
        const room = activeRooms[roomCode];
        if (!room) return;

        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        if (room.processTimer) clearTimeout(room.processTimer);
        delete activeRooms[roomCode];
    }

    static createRoom(socketId: string, playerName: string, gameMode: string = 'simple'): RoomResult<CreateRoomResultData, CreateRoomErrorType> {
        try {
            if (!isValidName(playerName)) {
                return { success: false, error: 'INVALID_PLAYER_NAME' };
            }

            if (gameMode != 'simple') {
                return { success: false, error: 'INVALID_MODE' };
            }

            // Read before `bindSocket` overwrites it with the new seat.
            const previousSeat = socketTracker[socketId];

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
                phaseEndsAt: null,
                abandonedSince: null
            };

            this.bindSocket(socketId, playerId, roomCode);
            const releasedSeat = this.releaseSeatIfMoved(previousSeat, playerId);

            return {
                success: true,
                data: {
                    roomCode,
                    players: gameInstance.getPlayersList(),
                    gameMode,
                    hostId: playerId,
                    playerId,
                    secret,
                    releasedSeat
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

            // Read before `bindSocket` overwrites it with the new seat. Captured
            // here rather than released here: a refused entry (room full, secret
            // rejected) has to leave the player exactly where they were.
            const previousSeat = socketTracker[socketId];

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
                    const wasOffline = existingPlayer?.isDisconnected ?? false;
                    if (existingPlayer) existingPlayer.setDisconnected(false);

                    // Pairs 1:1 with the PLAYER_DISCONNECTED entry `vacateSeat`
                    // wrote when the seat was held, so the log never leaves a
                    // player offline for the rest of the game.
                    const reconnectLog = wasOffline
                        ? room.game.addLog('PLAYER_RECONNECTED', { playerName: trimmedName, playerId } as PlayerReconnectedData)
                        : undefined;

                    const previousSocketId = this.bindSocket(socketId, playerId, roomCode);
                    const releasedSeat = this.releaseSeatIfMoved(previousSeat, playerId);

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
                            previousSocketId,
                            releasedSeat,
                            newLog: reconnectLog
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
            const releasedSeat = this.releaseSeatIfMoved(previousSeat, newPlayerId);

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
                    nameChanged: false,
                    releasedSeat
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

    // The player pressed "leave". Their seat goes off the board whatever phase
    // the room is in -- see `releaseSeat`.
    static handleLeave(socketId: string): RoomResult<DisconnectResultData, DisconnectErrorType> {
        return this.releaseSeat(socketId, 'LEAVE');
    }

    // The socket died on us. Mid-game this holds the seat rather than freeing
    // it, because the client may well be back in a few seconds.
    static handleDisconnect(socketId: string): RoomResult<DisconnectResultData, DisconnectErrorType> {
        return this.releaseSeat(socketId, 'DROP');
    }

    // Unbinds a socket and settles what happens to the seat it held.
    //
    // The two intents used to share one code path, which is what made leaving
    // mid-game indistinguishable from a dropped connection: the player was kept
    // alive on the board, kept being auto-positioned, and came back in every
    // roster payload the room sent afterwards. They are separate now:
    //
    //   LEAVE -> the player is removed from the board. Not a kill: no death
    //            order, no place in the ranking, and their tile is freed. The
    //            room is deleted once the last player leaves.
    //   DROP  -> mid-game the seat is held (alive, offline, auto-positioned);
    //            in the lobby there is no board state to hold, so it removes.
    private static releaseSeat(socketId: string, intent: SeatReleaseIntent): RoomResult<DisconnectResultData, DisconnectErrorType> {
        const binding = this.unbindSocket(socketId);
        if (!binding) return { success: false, error: 'PLAYER_IS_NOT_IN_A_ROOM' };

        return this.vacateSeat(binding.roomCode, binding.playerId, intent);
    }

    // Hands back the seat this socket held before it took the one it holds now.
    //
    // Called from inside `createRoom`/`joinRoom`, immediately after `bindSocket`,
    // so entering a room is a single operation that cannot be half-done: there
    // is no window in which a socket is seated twice, and no ordering for a
    // caller to get wrong.
    //
    // Player ids are minted per seat, so a matching id means this is the seat we
    // already had -- an ordinary reconnect, and releasing it would delete the
    // very seat the reconnect just reclaimed.
    private static releaseSeatIfMoved(previous: SocketBinding | undefined, newPlayerId: string): DisconnectResultData | undefined {
        if (!previous || previous.playerId === newPlayerId) return undefined;

        // A deliberate leave, not a drop: a client that has just been seated
        // somewhere else is not coming back to this one.
        const result = this.vacateSeat(previous.roomCode, previous.playerId, 'LEAVE');
        return result.success ? result.data : undefined;
    }

    private static vacateSeat(roomCode: string, playerId: string, intent: SeatReleaseIntent): RoomResult<DisconnectResultData, DisconnectErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        // A spectator has no board state worth preserving -- drop them. If they
        // come back they simply re-enter as a fresh spectator.
        if (room.game.removeSpectator(playerId)) {
            // A room can outlive its players only while somebody is still in it.
            if (room.game.players.length === 0) {
                this.deleteRoom(roomCode);
                return { success: true, data: { action: 'DELETE_ROOM' } };
            }

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

        const player = room.game.players[playerIndex];
        const wasMidGame = room.game.state !== 'lobby';

        if (intent === 'LEAVE' || !wasMidGame) {
            room.game.players.splice(playerIndex, 1);

            if (room.game.players.length === 0) {
                this.deleteRoom(roomCode);
                return { success: true, data: { action: 'DELETE_ROOM' } };
            }

            if (room.hostId === playerId) {
                // Prefer someone who is actually holding a client -- handing the
                // room to an offline player leaves a start/reset button nobody
                // can press. Falling back to the first seat still beats leaving
                // `hostId` naming a player who is no longer in the room.
                room.hostId = (room.game.players.find(p => !p.isDisconnected) ?? room.game.players[0]).id;
            }

            // Mid-game a name vanishing from the roster needs explaining; in the
            // lobby the roster speaks for itself, and at the end screen the
            // ranking is already fixed.
            const shouldLog = wasMidGame && room.game.state !== 'end';
            const leftLog = shouldLog
                ? room.game.addLog('PLAYER_LEFT', { playerName: player.name, playerId: player.id } as PlayerLeftData)
                : undefined;

            return { success: true, data: { action: 'PLAYER_LEFT', roomCode, room, playerId, newLog: leftLog, wasMidGame } };
        }

        // Mid-game drop: the player stays alive and on the board, just offline.
        // The server keeps auto-positioning them and they simply don't throw.
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

    // The seat this socket is sitting in, or undefined if it holds none. The one
    // record of that fact -- every caller reads it from here rather than keeping
    // a copy, which is what let a socket's seat and its broadcasts drift apart.
    static getBinding(socketId: string): SocketBinding | undefined {
        return socketTracker[socketId];
    }

    // Returns either a Room object, or 'undefined' if it doesn't exist
    static getRoom(roomCode: string): Room | undefined {
        return activeRooms[roomCode];
    }
}

export default RoomService;
