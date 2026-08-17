import { SetPositionErrorType, SetBombErrorType, EngineEventData, ActionLog, PlayerModel, SpectatorModel, GameState, RankingModel } from '../domain/modes/SimpleModeEngine';
import logger from '../utils/Logger';
import ResponseUtil from '../utils/ResponseUtil';
import { Room, activeRooms } from './RoomStore';
import { Server } from 'socket.io';

export type GameActionErrorType = 'ROOM_NOT_FOUND' | SetPositionErrorType | SetBombErrorType;
export type ResetGameErrorType = 'ROOM_NOT_FOUND' | 'WRONG_PHASE';

export const PHASE_TIME_LIMIT_SECONDS = 30;
const PHASE_TIME_LIMIT_MS = PHASE_TIME_LIMIT_SECONDS * 1000;

export interface GameResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError | 'UNKNOWN_ERROR';
}

export interface ResetGameResultData {
    players: PlayerModel[];
    spectators: SpectatorModel[];
    hostId: string;
}

// Everything a client needs to render the room it just walked into, whether it
// is resuming a seat it already had or watching as a spectator. Role is carried
// by `isSpectator` + `isAlive` rather than by different events, because the
// client already has every render path -- the snapshot only seeds them.
export interface RoomSnapshot {
    state: GameState;
    roundNumber: number;
    boardSize: { width: number; height: number };
    destroyedTiles: { x: number; y: number }[];
    timeLimit: number;
    remainingMs: number;
    players: PlayerModel[];
    spectators: SpectatorModel[];
    logs: ActionLog[];
    isSpectator: boolean;
    hostId: string;
    you?: {
        x: number | null;
        y: number | null;
        hasPositioned: boolean;
        bombTarget: { x: number; y: number } | null;
        throwOrder: number | null;
        isAlive: boolean;
        isDisconnected: boolean;
    };
    ranking?: RankingModel[];
    winnerPosition?: { x: number | null; y: number | null } | null;
}

class GameService {
    private static io: Server;

    static init(ioServer: Server) {
        this.io = ioServer;
    }

    // ==========================================
    // SERVER-INITIATED ACTIONS (The Timers)
    // ==========================================

    // The phase timer is always running and is the sole driver when nobody is
    // connected -- there is no paused state to resume from, so a reconnecting
    // client just picks up mid-countdown via `remainingMs`.
    private static startPhaseTimer(room: Room, onExpiry: () => void) {
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        room.phaseEndsAt = Date.now() + PHASE_TIME_LIMIT_MS;
        room.phaseTimer = setTimeout(onExpiry, PHASE_TIME_LIMIT_MS);
    }

    private static clearPhaseTimer(room: Room) {
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        room.phaseTimer = null;
        room.phaseEndsAt = null;
    }

    static startPositionPhase(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'position';

        // Start the 30-second Clock
        this.startPhaseTimer(room, () => this.advanceToAttackPhase(roomCode));
    }

    // The one way into the attack phase. Anyone still alive without a tile gets
    // one first -- on the timeout path that's whoever didn't pick in time, and
    // on the early-exit path it's exactly the disconnected-alive players, since
    // the gate already required every connected one to have positioned.
    static advanceToAttackPhase(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.players.forEach(p => {
            if (!p.hasPositioned && p.isAlive) {
                room.game.forceRandomPosition(p.id);

                // Send a direct, private message to ONLY this player. Addressed
                // by playerId (every socket joins a room of that name), so it
                // survives a socket swap instead of dying with the old id.
                this.io.to(p.id).emit('forcedPosition', ResponseUtil.success({
                    data: {
                        x: p.x,
                        y: p.y
                    }
                }));
            }
        });

        this.startAttackPhase(roomCode);
    }

    static startAttackPhase(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'attack';

        // 📢 MEGAPHONE: The server is changing the phase on its own
        this.io.to(roomCode).emit('phaseChanged', ResponseUtil.success({
            data: { phase: 'attack', timeLimit: PHASE_TIME_LIMIT_SECONDS },
        }));

        this.startPhaseTimer(room, () => this.processRound(roomCode));
    }

    static processRound(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'process';
        this.clearPhaseTimer(room);

        // Math happens instantly
        const { explosions: explosionResults, newDestroyedTiles, roundNumber } = room.game.resolveRound();
        const newLogs = room.game.roundLogs;

        // Broadcast EVERYTHING to Flutter
        this.io.to(roomCode).emit('roundResolved', ResponseUtil.success({
            data: {
                explosions: explosionResults,
                newDestroyedTiles: newDestroyedTiles,
                remainingPlayers: room.game.getPlayersList(),
                destroyedTiles: room.game.destroyedTiles,
                newLogs: newLogs,
                roundNumber: roundNumber + 1,
            }
        }));

        const didLaserFire = newDestroyedTiles.length > 0;

        const baseBufferMs = 300;
        const animationMs = explosionResults.length * 1500;
        // Add extra second if the orbital laser fired so Flutter can animate it!
        const laserAnimationMs = didLaserFire ? 1000 : 0;
        const totalDelayMs = baseBufferMs + animationMs + laserAnimationMs;

        // Look at the results to see if the game ended. Only real deaths shrink
        // this count now -- a disconnect leaves the player alive on the board.
        const livingPlayers = room.game.players.filter(p => p.isAlive);

        if (livingPlayers.length <= 1) {
            // SCENARIO A: GAME OVER
            // We use the same delay so the final explosion plays out before the Victory screen pops up!

            room.processTimer = setTimeout(() => {
                room.game.state = 'end';
                this.io.to(roomCode).emit('gameOver', ResponseUtil.success({
                    data: { ranking: room.game.getRanking(), winnerPosition: room.game.getWinnerPosition() }
                }));
            }, totalDelayMs);

        } else {
            // SCENARIO B: NEXT ROUND
            // Everyone survived, start the next attack phase
            room.processTimer = setTimeout(() => {
                this.startAttackPhase(roomCode);
            }, totalDelayMs);
        }
    }

    // Re-evaluates the early-exit gates after the set of connected-living
    // players changed (someone dropped, or came back). Deliberately does NOT
    // end the game: a disconnect is not a death, so it can never be what
    // brings the alive count down to a winner.
    static checkGameProgression(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        if (room.game.state === 'position' && room.game.haveAllPlayersPositioned()) {
            this.clearPhaseTimer(room);
            this.advanceToAttackPhase(roomCode);
        }

        else if (room.game.state === 'attack' && room.game.haveAllLivingPlayersThrown()) {
            this.clearPhaseTimer(room);
            this.processRound(roomCode);
        }
    }

    // ==========================================
    // USER-INITIATED ACTIONS (From the Gateway)
    // ==========================================
    static handleSetPosition(roomCode: string, playerId: string, x: number, y: number): GameResult<EngineEventData, GameActionErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerPosition(playerId, x, y);

        if (!result.success) return { success: false, error: result.error as GameActionErrorType };

        if (result.data?.event === 'PHASE_CHANGED_TO_ATTACK') {
            this.clearPhaseTimer(room);
            this.advanceToAttackPhase(roomCode);
        }

        return { success: true, data: result.data };
    }

    static handleThrowBomb(roomCode: string, playerId: string, x: number, y: number): GameResult<EngineEventData, GameActionErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerBomb(playerId, x, y);

        if (!result.success) return { success: false, error: result.error as GameActionErrorType };

        if (room.game.haveAllLivingPlayersThrown()) {
            this.clearPhaseTimer(room);
            this.processRound(roomCode); // Transition to the next phase!
        }

        return { success: true, data: result.data };
    }

    static handleResetGame(roomCode: string): GameResult<ResetGameResultData, ResetGameErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        if (room.game.state !== 'end') return { success: false, error: 'WRONG_PHASE' };

        // Reset the Server Room state
        room.game.state = 'lobby';

        // Clear any lingering timers as a safety precaution
        this.clearPhaseTimer(room);
        if (room.processTimer) clearTimeout(room.processTimer);
        room.processTimer = null;

        // Anyone still offline when the game wraps up is dropped from the room;
        // everyone who sat this one out on the bench joins the next game.
        room.game.players = room.game.players.filter(p => !p.isDisconnected);
        room.game.promoteSpectatorsToPlayers();

        // The pruning above can take the host with it (they may have dropped
        // while they were the only player left, so the mid-game reassignment
        // had nobody to hand off to). Without this the room would sit in lobby
        // with a start button nobody owns.
        if (!room.game.players.some(p => p.id === room.hostId) && room.game.players.length > 0) {
            room.hostId = room.game.players[0].id;
        }

        // Reset the Engine Domain
        room.game.resetGame();

        return {
            success: true,
            data: {
                players: room.game.getPlayersList(),
                spectators: room.game.getSpectatorsList(),
                hostId: room.hostId
            }
        };
    }

    // ==========================================
    // SNAPSHOT (private, to a (re)entering socket)
    // ==========================================
    static buildRoomSnapshot(roomCode: string, playerId: string, isSpectator: boolean): RoomSnapshot | null {
        const room = activeRooms[roomCode];
        if (!room) return null;

        const remainingMs = room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - Date.now()) : 0;

        const snapshot: RoomSnapshot = {
            state: room.game.state,
            roundNumber: room.game.roundNumber + 1,
            boardSize: { width: room.game.board.width, height: room.game.board.height },
            destroyedTiles: room.game.destroyedTiles,
            timeLimit: PHASE_TIME_LIMIT_SECONDS,
            remainingMs,
            players: room.game.getPlayersList(),
            spectators: room.game.getSpectatorsList(),
            logs: room.game.roundLogs,
            isSpectator,
            hostId: room.hostId,
        };

        if (!isSpectator) {
            const player = room.game.players.find(p => p.id === playerId);
            if (player) {
                snapshot.you = {
                    x: player.x,
                    y: player.y,
                    hasPositioned: player.hasPositioned,
                    bombTarget: player.bombTarget,
                    throwOrder: player.throwOrder,
                    isAlive: player.isAlive,
                    isDisconnected: player.isDisconnected,
                };
            }
        }

        if (room.game.state === 'end') {
            snapshot.ranking = room.game.getRanking();
            snapshot.winnerPosition = room.game.getWinnerPosition();
        }

        return snapshot;
    }
}

export default GameService;
