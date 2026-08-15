import { SetPositionErrorType, SetBombErrorType, EngineEventData } from '../domain/modes/SimpleModeEngine';
import logger from '../utils/Logger';
import ResponseUtil from '../utils/ResponseUtil';
import { activeRooms } from './RoomStore';
import { Server } from 'socket.io';

export type GameActionErrorType = 'ROOM_NOT_FOUND' | SetPositionErrorType | SetBombErrorType;
export type ResetGameErrorType = 'ROOM_NOT_FOUND' | 'WRONG_PHASE';

export interface GameResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError | 'UNKNOWN_ERROR';
}

class GameService {
    private static io: Server;

    static init(ioServer: Server) {
        this.io = ioServer;
    }

    // ==========================================
    // SERVER-INITIATED ACTIONS (The Timers)
    // ==========================================

    static startPositionPhase(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'position';

        // Start the 30-second Clock
        room.phaseTimer = setTimeout(() => {
            room.game.players.forEach(p => {
                if (!p.hasPositioned && p.isAlive) {
                    room.game.forceRandomPosition(p.id);

                    // Send a direct, private message to ONLY this player
                    this.io.to(p.id).emit('forcedPosition', ResponseUtil.success({
                        data: {
                            x: p.x,
                            y: p.y
                        }
                    }));
                }
            });

            // Time is up, force the game to the next phase
            this.startAttackPhase(roomCode);
        }, 30000);
    }

    static startAttackPhase(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'attack';

        // 📢 MEGAPHONE: The server is changing the phase on its own
        this.io.to(roomCode).emit('phaseChanged', ResponseUtil.success({
            data: { phase: 'attack', timeLimit: 30 },
        }));

        room.phaseTimer = setTimeout(() => {
            this.processRound(roomCode);
        }, 30000);
    }

    static processRound(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        room.game.state = 'process';

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

        // Look at the results to see if the game ended
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

    static checkGameProgression(roomCode: string) {
        const room = activeRooms[roomCode];
        if (!room) return;

        // Did that player leaving end the game?
        const livingPlayers = room.game.players.filter(p => p.isAlive);
        if (livingPlayers.length <= 1 && room.game.state !== 'end' && room.game.state !== 'lobby') {
            if (room.phaseTimer) clearTimeout(room.phaseTimer);
            if (room.processTimer) clearTimeout(room.processTimer);

            room.game.state = 'end';

            this.io.to(roomCode).emit('gameOver', ResponseUtil.success({
                data: { ranking: room.game.getRanking(), winnerPosition: room.game.getWinnerPosition() }
            }));
            return;
        }

        // Did that player leaving mean everyone else is ready to attack?
        if (room.game.state === 'position' && room.game.haveAllPlayersPositioned()) {
            if (room.phaseTimer) clearTimeout(room.phaseTimer);
            this.startAttackPhase(roomCode);
        }

        // Did that player leaving mean everyone else has thrown their bombs?
        else if (room.game.state === 'attack' && room.game.haveAllLivingPlayersThrown()) {
            if (room.phaseTimer) clearTimeout(room.phaseTimer);
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
            if (room.phaseTimer) clearTimeout(room.phaseTimer);
            this.startAttackPhase(roomCode);
        }

        return { success: true, data: result.data };
    }

    static handleThrowBomb(roomCode: string, playerId: string, x: number, y: number): GameResult<EngineEventData, GameActionErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerBomb(playerId, x, y);

        if (!result.success) return { success: false, error: result.error as GameActionErrorType };

        if (room.game.haveAllLivingPlayersThrown()) {
            if (room.phaseTimer) clearTimeout(room.phaseTimer);
            this.processRound(roomCode); // Transition to the next phase!
        }

        return { success: true, data: result.data };
    }

    static handleResetGame(roomCode: string): GameResult<EngineEventData, ResetGameErrorType> {
        const room = activeRooms[roomCode];
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        if (room.game.state !== 'end') return { success: false, error: 'WRONG_PHASE' };

        // Reset the Server Room state
        room.game.state = 'lobby';

        // Clear any lingering timers as a safety precaution
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        if (room.processTimer) clearTimeout(room.processTimer);

        room.game.players = room.game.players.filter(p => !p.isDisconnected);

        // Reset the Engine Domain
        room.game.resetGame();

        return { success: true };
    }
}

export default GameService;