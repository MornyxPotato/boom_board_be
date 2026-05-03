import Board from '../models/Board';
import PlayerEntity from '../models/PlayerEntity';

export type LogActionType =
    | 'BOMB_EXPLODED'
    | 'PLAYER_ELIMINATED'
    | 'PLAYER_DISCONNECTED'
    | 'ORBITAL_LASER_FIRED';

export interface OrbitalLaserData {
    coordinates: { x: number; y: number }[];
}

// The Data Payloads for history log
export interface BombExplodedData {
    bomberName: string;
    x: number;
    y: number;
}

// The Data Payloads for history log
export interface PlayerEliminatedData {
    killerName: string;
    victimName: string;
}

// The Data Payloads for history log
export interface PlayerDisconnectedData {
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
}

export interface ExplosionResult {
    bomberName: string;
    victimName?: string;
    isHit: boolean;
    x: number;
    y: number;
}

export type GameState = 'lobby' | 'position' | 'attack' | 'process' | 'end';
export type EngineEventType = 'PLAYER_READY' | 'PHASE_CHANGED_TO_ATTACK';

export type SetPositionErrorType = 'PLAYER_NOT_FOUND' | 'POSITION_ALREADY_SET' | 'INVALID_COORDINATES' | 'WRONG_PHASE';
export type SetBombErrorType = 'PLAYER_NOT_FOUND' | 'DEAD_PLAYER' | 'INVALID_COORDINATES' | 'WRONG_PHASE' | 'TILE_ALREADY_DESTROYED';

export interface EngineResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError;
}

export interface EngineEventData {
    event: EngineEventType;
}

class SimpleModeEngine {
    state: GameState = 'lobby';
    board: Board;
    players: PlayerEntity[];
    maxPlayers: number;
    currentThrowOrder: number = 0;
    deathCounter: number = 0;
    roundLogs: ActionLog[] = [];
    private logIdCounter: number = 0;
    roundNumber: number = 0;
    destroyedTiles: { x: number; y: number }[] = [];

    constructor() {
        this.board = new Board(8, 8);
        this.players = [];
        this.maxPlayers = 25;
    }

    addPlayer(player: PlayerEntity): boolean {
        if (this.players.length >= this.maxPlayers) {
            return false;
        }
        this.players.push(player);
        return true;
    }

    getPlayersList(): PlayerModel[] {
        return this.players.map(p => ({
            id: p.id,
            name: p.name,
            isAlive: p.isAlive,
            hasPositioned: p.hasPositioned,
            isDisconnected: p.isDisconnected
        }));
    }

    haveAllLivingPlayersThrown(): boolean {
        const livingPlayers = this.players.filter(p => p.isAlive);
        if (livingPlayers.length === 0) return false;
        return livingPlayers.every(p => p.bombTarget !== null);
    }

    haveAllPlayersPositioned(): boolean {
        if (this.players.length === 0) return false;
        return this.players.every(p => p.hasPositioned);
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

    resolveRound(): ExplosionResult[] {
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
                            killerName: bomber.name,
                            victimName: victim.name
                        } as PlayerEliminatedData);

                        roundResults.push({
                            bomberName: bomber.name,
                            victimName: victim.name,
                            isHit: true,
                            x: target.x,
                            y: target.y
                        });
                    }
                }
            });

            if (!didHit) {
                roundResults.push({
                    bomberName: bomber.name,
                    x: target.x,
                    y: target.y,
                    isHit: false
                });
            }
        }

        const livingPlayers = this.players.filter(p => p.isAlive);
        if (this.roundNumber >= 4 || livingPlayers.length <= 3) {

            // GATHER ALL SAFE TILES
            const safeTiles: { x: number; y: number }[] = [];

            for (let x = 0; x < this.board.width; x++) {
                for (let y = 0; y < this.board.height; y++) {

                    const isDestroyed = this.destroyedTiles.some(t => t.x === x && t.y === y);
                    const isOccupied = livingPlayers.some(p => p.hasPositioned && p.x === x && p.y === y);

                    // Only add tiles that aren't on fire, and don't have a living player on them
                    if (!isDestroyed && !isOccupied) {
                        safeTiles.push({ x, y });
                    }
                }
            }

            // PICK 5 RANDOM TILES (Or fewer, if we are running out of space!)
            const laserHits: { x: number; y: number }[] = [];
            const tilesToDestroy = Math.min(5, safeTiles.length);

            for (let i = 0; i < tilesToDestroy; i++) {
                const randomIndex = Math.floor(Math.random() * safeTiles.length);
                laserHits.push(safeTiles[randomIndex]);
                safeTiles.splice(randomIndex, 1); // Remove it so we don't pick it twice
            }

            // FIRE THE LASER!
            if (laserHits.length > 0) {
                this.destroyedTiles.push(...laserHits);
                this.addLog('ORBITAL_LASER_FIRED', { coordinates: laserHits } as OrbitalLaserData);
            }
        }

        // Clean up for the next round
        this.players.forEach(p => p.resetRound());
        this.currentThrowOrder = 0; // Reset the counter!

        return roundResults;
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
        if (this.haveAllPlayersPositioned()) {
            this.state = 'attack';
            return { success: true, data: { event: 'PHASE_CHANGED_TO_ATTACK' } };
        }

        return { success: true, data: { event: 'PLAYER_READY' } };
    }

    setPlayerBomb(playerId: string, targetX: number, targetY: number): EngineResult<EngineEventData, SetBombErrorType> {
        if (this.state !== 'attack') return { success: false, error: 'WRONG_PHASE' };
        const player = this.players.find(p => p.id === playerId);

        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (!player.isAlive) return { success: false, error: 'DEAD_PLAYER' };
        if (!this.board.isValidPosition(targetX, targetY)) return { success: false, error: 'INVALID_COORDINATES' };
        const isScorched = this.destroyedTiles.some(t => t.x === targetX && t.y === targetY);
        if (isScorched) return { success: false, error: 'TILE_ALREADY_DESTROYED' };

        player.setBombTarget(targetX, targetY, this.currentThrowOrder++);
        return { success: true, data: { event: 'PLAYER_READY' } };
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

    getRanking() {
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
            name: p.name,
            isAlive: p.isAlive
        }));
    }
}

export default SimpleModeEngine;