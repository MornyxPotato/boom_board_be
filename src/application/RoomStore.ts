import SimpleModeEngine from '../domain/modes/SimpleModeEngine';

export type RoomState = 'lobby' | 'position' | 'attack' | 'process' | 'end';
export type GameMode = 'simple';

export interface Room {
    code: string;
    hostId: string;
    game: SimpleModeEngine;
    gameMode: GameMode;
    phaseTimer: NodeJS.Timeout | null;
    processTimer: NodeJS.Timeout | null;
    // Wall-clock deadline of the currently running phase timer, or null when no
    // timed phase is active. Only used to tell a (re)joining client how much of
    // the phase is left, since it arrives mid-countdown.
    phaseEndsAt: number | null;
}

// What a live socket is currently bound to. Kept keyed by socket id because
// that is all the `disconnect` handler gets, but it resolves to the stable
// `playerId` that everything else in the system keys on.
export interface SocketBinding {
    roomCode: string;
    playerId: string;
}

// 🏆 THE SINGLE SOURCE OF TRUTH
export const activeRooms: Record<string, Room> = {};
export const socketTracker: Record<string, SocketBinding> = {};
// Reverse lookup, playerId -> socket id. Used to evict the previous socket when
// the same identity reconnects (newest wins).
export const playerSocketTracker: Record<string, string> = {};
