import logger from '../../utils/Logger';
import Board from '../models/Board';
import PlayerEntity from '../models/PlayerEntity';
import SpectatorEntity from '../models/SpectatorEntity';

// The player-facing round by which the laser must have destroyed every empty
// tile, leaving only tiles that hold living players. Tunable after playtesting.
// This maps directly to the engine's `roundNumber` (perceived "Round N" is
// resolved when `roundNumber === N`).
//
// Each round before this one destroys a share of the *remaining* empty tiles
// so the count reaches exactly zero on the full-clear round:
//   ceil(emptyTiles / (FULL_CLEAR_ROUND - roundNumber + 1))
// This deplete-to-zero schedule is deliberate: a flat percentage per round
// (e.g. "destroy 20%") never reaches zero, so it could not guarantee a full
// clear by a fixed round.
const FULL_CLEAR_ROUND = 5;

export type LogActionType =
    | 'BOMB_EXPLODED'
    | 'PLAYER_ELIMINATED'
    | 'PLAYER_DISCONNECTED'
    | 'PLAYER_LEFT'
    | 'ORBITAL_LASER_FIRED';

export interface OrbitalLaserData {
    coordinates: { x: number; y: number }[];
}

// The Data Payloads for history log
export interface BombExplodedData {
    bomberId: string;
    bomberName: string;
    x: number;
    y: number;
}

// The Data Payloads for history log
export interface PlayerEliminatedData {
    bomberName: string;
    bomberId: string;
    victimName: string;
    victimId: string;
}

// The Data Payloads for history log
export interface PlayerDisconnectedData {
    playerId: string;
    playerName: string;
}

// A player who gave up their seat mid-game. Same shape as a disconnect, but a
// very different thing to read in the log: they are off the board for good.
export interface PlayerLeftData {
    playerId: string;
    playerName: string;
}

// The Master Log Wrapper
export interface ActionLog<T = any> {
    id: string;
    type: LogActionType;
    timestamp: number;
    data: T;
}

export interface PlayerModel {
    id: string;
    name: string;
    isAlive: boolean;
    hasPositioned: boolean;
    isDisconnected: boolean;
    throwOrder: number | null;
}

// The public shape of a spectator. Deliberately minimal, and deliberately
// without `secret`.
export interface SpectatorModel {
    id: string;
    name: string;
}

export interface RankingModel {
    rank: number;
    id: string;
    name: string;
    isAlive: boolean;
    isDisconnected: boolean;
}

export interface ExplosionResult {
    bomberId: string;
    victimId?: string;
    isHit: boolean;
    x: number;
    y: number;
}

export type GameState = 'lobby' | 'position' | 'attack' | 'process' | 'end';
export type EngineEventType = 'PLAYER_READY' | 'PHASE_CHANGED_TO_ATTACK';

export type SetPositionErrorType = 'PLAYER_NOT_FOUND' | 'POSITION_ALREADY_SET' | 'INVALID_COORDINATES' | 'WRONG_PHASE';
export type SetBombErrorType = 'PLAYER_NOT_FOUND' | 'DEAD_PLAYER' | 'INVALID_COORDINATES' | 'WRONG_PHASE' | 'TILE_ALREADY_DESTROYED' | 'BOMB_ALREADY_THROWN';

export interface EngineResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError;
}

export interface EngineEventData {
    event: EngineEventType;
    throwOrder?: number | null;
}

class SimpleModeEngine {
    state: GameState = 'lobby';
    board: Board;
    players: PlayerEntity[];
    spectators: SpectatorEntity[];
    maxPlayers: number;
    maxSpectators: number;
    currentThrowOrder: number = 0;
    deathCounter: number = 0;
    roundLogs: ActionLog[] = [];
    private logIdCounter: number = 0;
    roundNumber: number = 0;
    destroyedTiles: { x: number; y: number }[] = [];

    constructor() {
        this.board = new Board(8, 8);
        this.players = [];
        this.spectators = [];
        this.maxPlayers = 64;
        this.maxSpectators = 64;
    }

    addPlayer(player: PlayerEntity): boolean {
        if (this.players.length >= this.maxPlayers) {
            return false;
        }
        this.players.push(player);
        return true;
    }

    addSpectator(spectator: SpectatorEntity): boolean {
        if (this.spectators.length >= this.maxSpectators) {
            return false;
        }
        this.spectators.push(spectator);
        return true;
    }

    removeSpectator(spectatorId: string): boolean {
        const index = this.spectators.findIndex(s => s.id === spectatorId);
        if (index === -1) return false;
        this.spectators.splice(index, 1);
        return true;
    }

    // Everyone who sat out this game joins the next one. Called on the
    // end -> lobby reset, after disconnected players have been pruned.
    promoteSpectatorsToPlayers(): void {
        for (const spectator of this.spectators) {
            this.addPlayer(new PlayerEntity(spectator.id, spectator.name, spectator.secret));
        }
        this.spectators = [];
    }

    getPlayersList(): PlayerModel[] {
        return this.players.map(p => ({
            id: p.id,
            name: p.name,
            isAlive: p.isAlive,
            hasPositioned: p.hasPositioned,
            isDisconnected: p.isDisconnected,
            throwOrder: p.throwOrder,
        }));
    }

    getSpectatorsList(): SpectatorModel[] {
        return this.spectators.map(s => ({ id: s.id, name: s.name }));
    }

    // Players who are both on the board and currently holding a client. These
    // are the only ones a phase can wait for -- a disconnected player will
    // never act, so counting them would strand the phase on its full timer.
    connectedLivingPlayers(): PlayerEntity[] {
        return this.players.filter(p => p.isAlive && !p.isDisconnected);
    }

    // Both gates are a guarded early-exit: the phase ends ahead of its timer
    // only when there is someone left to wait for AND they have all acted.
    // With nobody connected the gate stays false and the 30s timer alone drives
    // the game, which is what lets a fully-abandoned room keep ticking until
    // someone reconnects.
    haveAllLivingPlayersThrown(): boolean {
        const waitingOn = this.connectedLivingPlayers();
        if (waitingOn.length === 0) return false;
        return waitingOn.every(p => p.bombTarget !== null);
    }

    haveAllPlayersPositioned(): boolean {
        const waitingOn = this.connectedLivingPlayers();
        if (waitingOn.length === 0) return false;
        return waitingOn.every(p => p.hasPositioned);
    }

    forceRandomPosition(playerId: string): void {
        const player = this.players.find(p => p.id === playerId);

        // If they don't exist, are dead, or already hid themselves, do nothing.
        if (!player || !player.isAlive || player.hasPositioned) return;

        let randomX: number;
        let randomY: number;
        let isOccupied: boolean;
        let attempts = 0;

        // Keep rolling the dice until we find an empty tile
        do {
            randomX = Math.floor(Math.random() * this.board.width);
            randomY = Math.floor(Math.random() * this.board.height);

            // Check if ANY player is already sitting on this exact X and Y
            isOccupied = this.players.some(p => p.hasPositioned && p.x === randomX && p.y === randomY);

            attempts++;
            // Failsafe: If the board is extremely full, just give up and let them overlap
            // after 100 tries so the server doesn't get stuck in an infinite loop.
            if (attempts > 100) isOccupied = false;

        } while (isOccupied);

        // Force the player into this spot
        player.setPosition(randomX, randomY);
    }

    resolveRound(): { explosions: ExplosionResult[], newDestroyedTiles: { x: number, y: number }[], roundNumber: number } {
        const roundResults: ExplosionResult[] = [];

        this.roundLogs = [];
        this.roundNumber++;

        // Grab all players who threw a bomb, and sort them by who locked in first
        const bombers = this.players
            .filter(p => p.bombTarget !== null && p.throwOrder !== null)
            .sort((a, b) => a.throwOrder! - b.throwOrder!);

        for (const bomber of bombers) {

            // Check Sudden Death: If only 1 person is alive, stop setting off bombs!
            const livingPlayers = this.players.filter(p => p.isAlive);
            if (livingPlayers.length <= 1) {
                break;
            }

            // If this bomber was killed by an earlier bomb in this same round, their bomb is a dud
            if (!bomber.isAlive || !bomber.bombTarget) continue;

            const target = bomber.bombTarget;

            this.addLog('BOMB_EXPLODED', {
                bomberId: bomber.id,
                bomberName: bomber.name,
                x: target.x,
                y: target.y
            } as BombExplodedData);

            let didHit = false;

            this.players.forEach(victim => {
                if (bomber.id !== victim.id && victim.isAlive && victim.hasPositioned && victim.x !== null && victim.y !== null) {
                    if (this.board.isDirectHit(target.x, target.y, victim.x, victim.y)) {
                        didHit = true;

                        victim.eliminate(++this.deathCounter);

                        this.addLog('PLAYER_ELIMINATED', {
                            bomberName: bomber.name,
                            bomberId: bomber.id,
                            victimName: victim.name,
                            victimId: victim.id,
                        } as PlayerEliminatedData);

                        roundResults.push({
                            bomberId: bomber.id,
                            victimId: victim.id,
                            isHit: true,
                            x: target.x,
                            y: target.y
                        });
                    }
                }
            });

            if (!didHit) {
                roundResults.push({
                    bomberId: bomber.id,
                    x: target.x,
                    y: target.y,
                    isHit: false
                });
            }
        }

        const livingPlayers = this.players.filter(p => p.isAlive);
        const laserHits: { x: number; y: number }[] = [];

        // The laser fires every round from round 1 (no gating condition).

        // GATHER ALL EMPTY TILES (not destroyed, no living player on them)
        const emptyTiles: { x: number; y: number }[] = [];

        for (let x = 0; x < this.board.width; x++) {
            for (let y = 0; y < this.board.height; y++) {

                const isDestroyed = this.destroyedTiles.some(t => t.x === x && t.y === y);
                const isOccupied = livingPlayers.some(p => p.hasPositioned && p.x === x && p.y === y);

                // Only add tiles that aren't on fire, and don't have a living player on them
                if (!isDestroyed && !isOccupied) {
                    emptyTiles.push({ x, y });
                }
            }
        }

        // Destroy a share of the remaining empty tiles that ramps up to a full
        // clear on the full-clear round. On/after that round, destroy them all
        // so any tile freed by a death is lasered the same round.
        const roundsUntilFullClear = FULL_CLEAR_ROUND - this.roundNumber + 1;
        const tilesToDestroy = roundsUntilFullClear <= 1
            ? emptyTiles.length
            : Math.ceil(emptyTiles.length / roundsUntilFullClear);

        for (let i = 0; i < tilesToDestroy; i++) {
            const randomIndex = Math.floor(Math.random() * emptyTiles.length);
            laserHits.push(emptyTiles[randomIndex]);
            emptyTiles.splice(randomIndex, 1); // Remove it so we don't pick it twice
        }

        // FIRE THE LASER!
        if (laserHits.length > 0) {
            this.destroyedTiles.push(...laserHits);
            this.addLog('ORBITAL_LASER_FIRED', { coordinates: laserHits } as OrbitalLaserData);
        }

        // Clean up for the next round
        this.players.forEach(p => p.resetRound());
        this.currentThrowOrder = 0; // Reset the counter!

        return {
            explosions: roundResults,
            newDestroyedTiles: laserHits,
            roundNumber: this.roundNumber,
        }
    }

    addLog(type: LogActionType, data: any): ActionLog {
        const now = Date.now();
        const newLog: ActionLog = {
            id: `log-${now}-${this.logIdCounter++}`,
            type: type,
            timestamp: now,
            data: data
        };

        this.roundLogs.push(newLog);
        return newLog;
    }

    // Function for service.
    setPlayerPosition(playerId: string, startX: number, startY: number): EngineResult<EngineEventData, SetPositionErrorType> {
        if (this.state !== 'position') return { success: false, error: 'WRONG_PHASE' };

        const player = this.players.find(p => p.id === playerId);

        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (player.hasPositioned) return { success: false, error: 'POSITION_ALREADY_SET' };
        if (!this.board.isValidPosition(startX, startY)) return { success: false, error: 'INVALID_COORDINATES' };

        player.setPosition(startX, startY);
        // The engine only reports that the gate opened. GameService owns the
        // actual transition, because moving to attack first has to force-position
        // the disconnected-alive players (and tell them about it).
        if (this.haveAllPlayersPositioned()) {
            return { success: true, data: { event: 'PHASE_CHANGED_TO_ATTACK' } };
        }

        return { success: true, data: { event: 'PLAYER_READY' } };
    }

    setPlayerBomb(playerId: string, targetX: number, targetY: number): EngineResult<EngineEventData, SetBombErrorType> {
        if (this.state !== 'attack') return { success: false, error: 'WRONG_PHASE' };
        const player = this.players.find(p => p.id === playerId);

        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (!player.isAlive) return { success: false, error: 'DEAD_PLAYER' };
        if (player.bombTarget !== null) return { success: false, error: 'BOMB_ALREADY_THROWN' };
        if (!this.board.isValidPosition(targetX, targetY)) return { success: false, error: 'INVALID_COORDINATES' };
        const isScorched = this.destroyedTiles.some(t => t.x === targetX && t.y === targetY);
        if (isScorched) return { success: false, error: 'TILE_ALREADY_DESTROYED' };

        player.setBombTarget(targetX, targetY, this.currentThrowOrder++);
        return { success: true, data: { event: 'PLAYER_READY', throwOrder: player.throwOrder } };
    }

    resetGame(): EngineResult {
        this.state = 'lobby';
        this.players.forEach(p => p.fullReset());
        this.currentThrowOrder = 0;
        this.deathCounter = 0;
        this.roundLogs = [];
        this.logIdCounter = 0;
        this.roundNumber = 0;
        this.destroyedTiles = [];
        return { success: true };
    }

    getRanking(): RankingModel[] {
        // Sort rules: 
        // 1. Alive players at the top
        // 2. Dead players sorted by highest deathOrder (died last) to lowest (died first)
        const sortedPlayers = [...this.players].sort((a, b) => {
            if (a.isAlive && !b.isAlive) return -1;
            if (!a.isAlive && b.isAlive) return 1;
            if (!a.isAlive && !b.isAlive) return (b.deathOrder || 0) - (a.deathOrder || 0);
            return 0;
        });

        return sortedPlayers.map((p, index) => ({
            rank: index + 1,
            id: p.id,
            name: p.name,
            isAlive: p.isAlive,
            isDisconnected: p.isDisconnected,
        }));
    }

    getWinnerPosition() {
        // Only a living, positioned player has a real board position. When the
        // game ends via disconnect there may be no living winner, or the sole
        // survivor may not have positioned yet (position phase). Return null in
        // those cases so the client can tolerate the absence instead of
        // receiving {} or {x:null,y:null} and throwing while parsing.
        const winnerPlayer = this.players.find(p => p.isAlive && p.hasPositioned);
        if (!winnerPlayer) return null;
        return { x: winnerPlayer.x, y: winnerPlayer.y };
    }
}

export default SimpleModeEngine;